import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { agents, companies, connectionGrants, createDb, heartbeatRuns, issues,
  toolApplications, toolCatalogEntries, toolConnections, toolInvocations, toolProfiles } from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "../../__tests__/helpers/embedded-postgres.js";
import { hashToolValue, namedGatewayToolResult, summarizeToolValue } from "../tool-content-guards.js";
import { readStoppedNativeMcpReceipts } from "./native-session-executor.js";

const support = await getEmbeddedPostgresTestSupport();
if (!support.supported) throw new Error("Native read receipts require embedded PostgreSQL; this check cannot be skipped");

describe("durable stopped native MCP read receipts", () => {
  let temporary: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  let run: typeof heartbeatRuns.$inferSelect;
  let invocation: typeof toolInvocations.$inferSelect;
  let entry: typeof toolCatalogEntries.$inferSelect;
  let connection: typeof toolConnections.$inferSelect;
  let target: Record<string, unknown>;
  const result = { content: "current record", data: { content: [], isError: false, transport: "mcp_http", spawnedLocalProcess: false } };
  beforeAll(async () => {
    temporary = await startEmbeddedPostgresTestDatabase("native-read-receipts-");
    db = createDb(temporary.connectionString);
  }, 60_000);
  afterAll(async () => { await db?.$client.end({ timeout: 0 }); await temporary?.cleanup(); });
  beforeEach(async () => {
    const companyId = randomUUID(), agentId = randomUUID(), issueId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Read evidence", issuePrefix: `R${companyId.slice(0, 7).toUpperCase()}` });
    await db.insert(agents).values({ id: agentId, companyId, name: "Reader", role: "engineer", adapterType: "process" });
    await db.insert(issues).values({ id: issueId, companyId, title: "Read current record", assigneeAgentId: agentId });
    const [application] = await db.insert(toolApplications).values({ companyId, name: "Remote archive", type: "mcp_http" }).returning();
    [connection] = await db.insert(toolConnections).values({ companyId, applicationId: application!.id,
      name: "Archive", uid: randomUUID(), enabled: true, transport: "mcp_remote", status: "active", config: {}, transportConfig: {} }).returning();
    const [grant] = await db.insert(connectionGrants).values({ companyId, connectionId: connection.id,
      kind: "organization", status: "active", credentialSecretRefs: [] }).returning();
    [entry] = await db.insert(toolCatalogEntries).values({ companyId, applicationId: application!.id, connectionId: connection.id,
      name: "read", toolName: "read", riskLevel: "read", isReadOnly: true, versionHash: "a".repeat(64), schemaHash: "b".repeat(64) }).returning();
    const startedAt = new Date(Date.now() - 1000), finishedAt = new Date();
    [run] = await db.insert(heartbeatRuns).values({ companyId, agentId, status: "failed", invocationSource: "on_demand",
      runtimeMode: "native", nativeIssueId: issueId, nativeSessionId: randomUUID(), runnerInstanceId: randomUUID(),
      runnerProfileJson: { nativeExecutionInput: { synthetic: true } }, startedAt, finishedAt }).returning();
    target = { schema: "paperclip.native_mcp_read_target.v1", companyId, runId: run.id, agentId, issueId,
      nativeSessionId: run.nativeSessionId, runnerInstanceId: run.runnerInstanceId,
      executionInputHash: hashToolValue(run.runnerProfileJson!.nativeExecutionInput),
      gatewayId: null, gatewayTokenId: null, connectionId: connection.id,
      connectionConfigHash: hashToolValue({}), connectionTransportConfigHash: hashToolValue({}),
      credentialRefsHash: hashToolValue([]), credentialSecretRefsHash: hashToolValue([]),
      endpointHash: "c".repeat(64), credentialGrantId: grant!.id, grantCredentialRefsHash: hashToolValue([]),
      catalogEntryId: entry.id, catalogVersionHash: entry.versionHash, catalogSchemaHash: entry.schemaHash,
      upstreamToolName: entry.toolName, gatewayToolName: "archive:read", riskLevel: "read", transport: "mcp_http" };
    // Real foreign-key gateway/token records are created below, rather than
    // granting authority from synthetic identifier strings alone.
    const { createToolGatewayService } = await import("../tool-gateway.js");
    const gateway = createToolGatewayService(db);
    const [profile] = await db.insert(toolProfiles).values({ companyId, profileKey: `read-${randomUUID()}`, name: "Read profile", defaultAction: "deny" }).returning();
    const named = await gateway.createNamedGateway({ companyId, body: { name: "Read gateway", profileId: profile!.id } });
    const token = await gateway.createNamedGatewayToken({ companyId, gatewayId: named.id,
      body: { name: "Read run", clientLabel: "Receipt fixture", ownerNote: "Synthetic read proof", subjectType: "heartbeat_run", subjectId: run.id } });
    target.gatewayId = named.id; target.gatewayTokenId = token.id;
    [invocation] = await db.insert(toolInvocations).values({ companyId, agentId, issueId, runId: run.id,
      gatewayId: named.id, gatewayTokenId: token.id, connectionId: connection.id, catalogEntryId: entry.id,
      catalogVersionHash: entry.versionHash, catalogSchemaHash: entry.schemaHash, providerType: "mcp_remote_http",
      upstreamToolName: "read", toolName: "archive:read", riskLevel: "read", policyDecision: "allow",
      status: "succeeded", argumentsHash: hashToolValue({}), argumentsSummary: summarizeToolValue({}),
      resultHash: summarizeToolValue(result).sha256, resultSummary: summarizeToolValue(result),
      headerPolicySummary: { nativeReadEvidence: target }, startedAt: new Date(startedAt.getTime() + 100), completedAt: finishedAt }).returning();
  });
  it("reconstructs the exact gateway result and rechecks it under database locks", async () => {
    const receipts = await readStoppedNativeMcpReceipts(db, run);
    expect(receipts).toHaveLength(1);
    expect(receipts![0]!.result).toEqual(namedGatewayToolResult({ invocationId: invocation.id, result }));
    expect(await db.transaction(tx => readStoppedNativeMcpReceipts(tx as unknown as typeof db, run, true))).toEqual(receipts);
  });
  it("fences an admitted request that waits behind predecessor retirement", async () => {
    await db.update(heartbeatRuns).set({ status: "running" }).where(eq(heartbeatRuns.id, run.id));
    let release!: () => void, locked!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    const entered = new Promise<void>(resolve => { locked = resolve; });
    const retirement = db.transaction(async tx => {
      await tx.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, run.id)).for("update");
      locked();
      await held;
      await tx.update(heartbeatRuns).set({ status: "failed" }).where(eq(heartbeatRuns.id, run.id));
    });
    await entered;
    const { withNativeToolInvocationAdmission } = await import("../tool-access-policy.js");
    const admissionDb = createDb(temporary.connectionString, { maxConnections: 1, applicationName: "native-admission-test" });
    const observerDb = createDb(temporary.connectionString, { maxConnections: 1 });
    const persist = vi.fn(async () => "unexpected invocation");
    const admission = withNativeToolInvocationAdmission(admissionDb, { companyId: run.companyId, agentId: run.agentId,
      runId: run.id, issueId: run.nativeIssueId }, persist);
    const rejected = expect(admission).rejects.toThrow("no longer accepts tool invocations");
    try {
      await expect.poll(async () => {
        const rows = await observerDb.execute(sql`select count(*) as count from pg_stat_activity
          where datname = current_database() and application_name = 'native-admission-test'
          and wait_event_type = 'Lock'`);
        return Number(rows[0]?.count ?? 0);
      }, { timeout: 10_000 }).toBeGreaterThan(0);
    } finally {
      release();
      await retirement;
      await rejected;
      await admissionDb.$client.end({ timeout: 0 });
      await observerDb.$client.end({ timeout: 0 });
    }
    expect(persist).not.toHaveBeenCalled();
  });
  it.each(["write", "pending", "denied", "approval", "missing target", "wrong session", "wrong catalog", "changed target",
    "contradictory read", "upstream error", "local process", "truncated", "redacted", "wrong hash", "extra invocation"])("holds %s", async (failure) => {
    const patch: Partial<typeof invocation> = {};
    switch (failure) {
      case "write": patch.riskLevel = "write"; break;
      case "pending": patch.status = "executing"; break;
      case "denied": patch.policyDecision = "deny"; break;
      case "approval": patch.approvalState = "pending"; break;
      case "missing target": patch.headerPolicySummary = {}; break;
      case "wrong session": patch.headerPolicySummary = { nativeReadEvidence: { ...target, nativeSessionId: "other" } }; break;
      case "wrong catalog": patch.catalogVersionHash = "other"; break;
      case "changed target": await db.update(toolConnections).set({ config: { changed: true } }).where(eq(toolConnections.id, connection.id)); break;
      case "contradictory read": await db.update(toolCatalogEntries).set({ isWrite: true }).where(eq(toolCatalogEntries.id, entry.id)); break;
      case "upstream error": patch.resultSummary = summarizeToolValue({ ...result, error: "failed", data: { ...result.data, isError: true } }); patch.resultHash = patch.resultSummary.sha256; break;
      case "local process": patch.resultSummary = summarizeToolValue({ ...result, data: { ...result.data, spawnedLocalProcess: true } }); patch.resultHash = patch.resultSummary.sha256; break;
      case "truncated": patch.resultSummary = summarizeToolValue({ ...result, content: "x".repeat(5000) }); patch.resultHash = patch.resultSummary.sha256; break;
      case "redacted": patch.resultSummary = { ...summarizeToolValue(result), redactedFields: ["sensitive_value"] }; break;
      case "wrong hash": patch.resultHash = "wrong"; break;
      case "extra invocation": await db.insert(toolInvocations).values({ companyId: run.companyId, agentId: run.agentId,
        issueId: run.nativeIssueId, runId: run.id, toolName: "unsettled", status: "pending" }); break;
    }
    if (Object.keys(patch).length) await db.update(toolInvocations).set(patch).where(eq(toolInvocations.id, invocation.id));
    expect(await readStoppedNativeMcpReceipts(db, run)).toBeNull();
  });
});
