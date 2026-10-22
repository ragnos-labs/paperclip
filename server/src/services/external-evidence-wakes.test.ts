import { randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { heartbeatService } from "./heartbeat.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq, sql } from "drizzle-orm";
import { createDb, companies, agents, issues, companyMemberships, issueComments, issueCreateIdempotencyKeys,
  agentWakeupRequests, heartbeatRuns, issueRecoveryActions, issueRelations, issueThreadInteractions, issueApprovals, approvals, environmentLeases, authUsers, type Db } from "@paperclipai/db";
import { prepareConversationTurn } from "./agent-conversations.js";
import { getExecutionBlocker } from "./execution-blocker.js";
import { issueService } from "./issues.js";
import { instanceSettingsService } from "./instance-settings.js";
import { externalEvidenceEventSchema } from "@paperclipai/shared";
import { startEmbeddedPostgresTestDatabase } from "../__tests__/helpers/embedded-postgres.js";
import { queueExternalEvidenceSignal, externalEvidenceWakeGate, classifyEvidenceHold,
  existingNativeIntentDispatch, nativeEvidenceDispatchActor, retryUnadmittedEvidenceIntent, EXTERNAL_EVIDENCE_WAKE } from "./external-evidence-wakes.js";

// Public native creation namespace, not a credential.
const OWNER_REQUEST_PREFIX = "companyos-owner-request:";

// Mandatory native PostgreSQL; a loader/bind/migration failure is a test failure, never a skip.
describe("external evidence event admission and durable native wake intent", () => {
  let native: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: Db;
  beforeAll(async () => { native = await startEmbeddedPostgresTestDatabase("paperclip-evidence-wakes-"); db = createDb(native.connectionString);
    await instanceSettingsService(db).updateExperimental({ enableAgentChat: true });
  }, 90000);
  afterAll(async () => { if (native) await native.cleanup(); }, 30000);
  async function fixture() {
    const company = randomUUID(), chief = randomUUID(), parent = randomUUID(), source = randomUUID(), user = randomUUID();
    await db.insert(companies).values({ id: company, name: "Synthetic evidence", issuePrefix: "T" + company.slice(0, 8) });
    await db.insert(agents).values({ id: chief, companyId: company, name: "Chief", role: "ceo", adapterType: "process", status: "paused" });
    await db.insert(authUsers).values({ id: user, name: "Synthetic owner", email: user + "@example.invalid", createdAt: new Date(), updatedAt: new Date() });
    await db.insert(companyMemberships).values({ companyId: company, principalType: "user", principalId: user, status: "active" });
    await db.insert(issues).values({ id: parent, companyId: company, title: "Synthetic parent", status: "blocked", assigneeAgentId: chief,
      blockedTransitionAt: new Date(Date.now() - 10000), unblockDescriptor: { owner: { agentId: chief }, action: "Await exact external evidence" } });
    await db.insert(issues).values({ id: source, companyId: company, title: "Synthetic owner request", parentId: parent,
      status: "blocked", createdByAgentId: chief, unblockDescriptor: { owner: "board", action: "Supply exact evidence" } });
    await db.insert(issueCreateIdempotencyKeys).values({ companyId: company, issueId: source, idempotencyKey: OWNER_REQUEST_PREFIX + source });
    const comment = randomUUID();
    await db.insert(issueComments).values({ id: comment, companyId: company, issueId: source, authorUserId: user,
      authorType: "user", body: "Timestamped synthetic health receipt; cause remains unknown." });
    return { company, chief, parent, source, user, comment };
  }
  async function queue(f: Awaited<ReturnType<typeof fixture>>, overrides = {}) {
    return db.transaction(tx => queueExternalEvidenceSignal(tx as unknown as Db, { companyId: f.company, sourceIssueId: f.source,
      actorUserId: f.user, eventId: f.comment, kind: "evidence_supplied", commentId: f.comment, ...overrides }));
  }
  async function conversationDelivery(body = "/new") {
    const f = await fixture(), commentId = randomUUID(), runId = randomUUID(), receiptId = randomUUID();
    await db.update(issues).set({ status: "done" }).where(eq(issues.id, f.source));
    await db.update(issues).set({ status: "in_progress", unblockDescriptor: null,
      conversationAgentId: f.chief, conversationUserId: f.user, conversationState: "active" })
      .where(eq(issues.id, f.parent));
    const [recovery] = await db.insert(issueRecoveryActions).values({ companyId: f.company, sourceIssueId: f.parent,
      kind: "active_run_watchdog", ownerType: "board", returnOwnerAgentId: f.chief,
      cause: "legacy_execution_requires_reconciliation", status: "active", evidence: {},
      fingerprint: randomUUID(), nextAction: "Reconcile exact old execution",
      createdAt: new Date(Date.now() - 10000) }).returning();
    await db.insert(issueComments).values({ id: commentId, companyId: f.company, issueId: f.parent,
      authorType: "user", authorUserId: f.user, body });
    await db.insert(agentWakeupRequests).values({ id: receiptId, companyId: f.company, agentId: f.chief,
      source: "on_demand", triggerDetail: "manual", reason: "issue_commented", status: "queued",
      requestedByActorType: "user", requestedByActorId: f.user, idempotencyKey: `conversation-comment:${commentId}`,
      runId, payload: { issueId: f.parent, commentId, _paperclipWakeContext: { issueId: f.parent, commentId, wakeCommentId: commentId, wakeCommentIds: [commentId] } } });
    const [run] = await db.insert(heartbeatRuns).values({ id: runId, companyId: f.company, agentId: f.chief,
      invocationSource: "on_demand", status: "queued", wakeupRequestId: receiptId,
      contextSnapshot: { issueId: f.parent, commentId, wakeCommentId: commentId, wakeCommentIds: [commentId], source: "issue.comment" } }).returning();
    const input = { companyId: f.company, issueId: f.parent, agentId: f.chief, runId, receiptId };
    return { ...f, commentId, runId, receiptId, recovery, run, input };
  }
  async function committedBoundary(f: Awaited<ReturnType<typeof conversationDelivery>>, store: Db = db) {
    const id = randomUUID();
    await store.insert(issueComments).values({ id, companyId: f.company, issueId: f.parent,
      authorType: "user", authorUserId: f.user, body: "/new", createdAt: new Date(Date.now() + 10) });
    const [reset] = await store.insert(heartbeatRuns).values({ companyId: f.company, agentId: f.chief,
      status: "running", contextSnapshot: { issueId: f.parent, wakeCommentId: id, commentId: id } }).returning();
    await prepareConversationTurn(store, reset);
    await store.update(heartbeatRuns).set({ status: "succeeded" }).where(eq(heartbeatRuns.id, reset.id));
    return id;
  }
  it.each(["ordinary", "older_reset"] as const)(
    "rejects superseded authentic queued %s with missing generation across restart and actual start", async kind => {
      const f = await conversationDelivery(kind === "ordinary" ? "Old topic before reset" : "/new");
      const boundaryId = await committedBoundary(f);
      // This reproduces the review finding: genuine A, no generation field,
      // later committed B; old recovery predates B and must not authorize A.
      expect(f.run.contextSnapshot).not.toHaveProperty("conversationSessionGeneration");
      const beforeComments = await db.select().from(issueComments).where(eq(issueComments.issueId, f.parent));
      const marker = join(tmpdir(), "fleet-stale-provider-" + f.runId);
      await db.update(agents).set({ status: "idle", adapterType: "process",
        adapterConfig: { command: process.execPath, args: ["-e", `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'PROVIDER DISPATCHED')`] },
        runtimeConfig: { heartbeat: { enabled: false, wakeOnDemand: true } } }).where(eq(agents.id, f.chief));
      try {
        const restarted = createDb(native.connectionString);
        expect(await externalEvidenceWakeGate(restarted, f.input)).toMatchObject({ held: true, reason: "superseded_conversation_delivery" });
        // Exercise public restart scheduling through real queued claim/start;
        // no fake provider, lease, queue or ownership guard is mocked.
        await heartbeatService(restarted).resumeQueuedRuns();
        const [run] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, f.runId));
        expect(run.status).toBe("cancelled");
        expect(run.startedAt).toBeNull(); expect(run.processPid).toBeNull();
        expect(existsSync(marker)).toBe(false);
        expect(await db.select().from(environmentLeases).where(eq(environmentLeases.heartbeatRunId, f.runId))).toHaveLength(0);
        const [wake] = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, f.receiptId));
        expect(wake.claimedAt).toBeNull();
        const [parent] = await db.select().from(issues).where(eq(issues.id, f.parent));
        expect(parent.conversationBoundaryCommentId).toBe(boundaryId);
        expect(parent.conversationSessionGeneration).toBe(1);
        expect(await db.select().from(issueComments).where(eq(issueComments.issueId, f.parent))).toEqual(beforeComments);
      } finally { await db.update(agents).set({ status: "paused" }).where(eq(agents.id, f.chief)); }
    },
  );
  it.each(["equal_time_old_id", "stale_generation", "stale_coalesced_comment", "unknown_boundary"] as const)(
    "fences %s while keeping the current boundary identity", async fault => {
      const f = await conversationDelivery(); const boundaryId = await committedBoundary(f);
      const [boundary] = await db.select().from(issueComments).where(eq(issueComments.id, boundaryId));
      if (fault === "equal_time_old_id") {
        // Set UUIDs deterministically to exercise the tie rule, not random order.
        const older = "00000000-0000-0000-0000-000000000000";
        await db.insert(issueComments).values({ id: older, companyId: f.company, issueId: f.parent,
          authorType: "user", authorUserId: f.user, body: "/new", createdAt: boundary.createdAt });
        await db.update(agentWakeupRequests).set({ idempotencyKey: `conversation-comment:${older}`, payload: { issueId: f.parent, commentId: older, _paperclipWakeContext: { issueId: f.parent, commentId: older, wakeCommentId: older, wakeCommentIds: [older] } } }).where(eq(agentWakeupRequests.id, f.receiptId));
        await db.update(heartbeatRuns).set({ contextSnapshot: { issueId: f.parent, commentId: older, wakeCommentId: older, wakeCommentIds: [older], source: "issue.comment" } }).where(eq(heartbeatRuns.id, f.runId));
      } else {
        // Turn A into a genuinely fresh post-boundary delivery, then vary one
        // bound field. The unknown-boundary control preserves history rows.
        await db.update(issueComments).set({ createdAt: new Date(boundary.createdAt.getTime() + 1) }).where(eq(issueComments.id, f.commentId));
        if (fault === "stale_generation") await db.update(heartbeatRuns).set({ contextSnapshot: { ...f.run.contextSnapshot, conversationSessionGeneration: 0 } }).where(eq(heartbeatRuns.id, f.runId));
        if (fault === "stale_coalesced_comment") {
          const oldId = randomUUID();
          await db.insert(issueComments).values({ id: oldId, companyId: f.company, issueId: f.parent,
            authorType: "user", authorUserId: f.user, body: "Old coalesced input", createdAt: new Date(boundary.createdAt.getTime() - 1) });
          await db.update(heartbeatRuns).set({ contextSnapshot: { ...f.run.contextSnapshot, wakeCommentIds: [oldId, f.commentId] } }).where(eq(heartbeatRuns.id, f.runId));
          await db.update(agentWakeupRequests).set({ payload: { issueId: f.parent, commentId: f.commentId, _paperclipWakeContext: { issueId: f.parent, commentId: f.commentId, wakeCommentId: f.commentId, wakeCommentIds: [oldId, f.commentId] } } }).where(eq(agentWakeupRequests.id, f.receiptId));
        }
        if (fault === "unknown_boundary") await db.update(issues).set({ conversationBoundaryCommentId: randomUUID() }).where(eq(issues.id, f.parent));
      }
      expect((await externalEvidenceWakeGate(db, f.input)).held).toBe(true);
    },
  );
  it("preserves PostgreSQL microsecond boundary order and admits fresh missing-generation input", async () => {
    const f = await conversationDelivery("Old ordinary topic"); const boundaryId = await committedBoundary(f);
    const id = "ffffffff-ffff-ffff-ffff-ffffffffffff";
    await db.update(issueComments).set({ createdAt: sql`'2026-10-22T13:00:00.000900Z'::timestamptz` }).where(eq(issueComments.id, boundaryId));
    await db.update(issueRecoveryActions).set({ createdAt: sql`'2026-10-22T13:00:00.000001Z'::timestamptz` }).where(eq(issueRecoveryActions.id, f.recovery.id));
    await db.insert(issueComments).values({ id, companyId: f.company, issueId: f.parent,
      authorType: "user", authorUserId: f.user, body: "Ordinary input",
      createdAt: sql`'2026-10-22T13:00:00.000100Z'::timestamptz` });
    await db.update(agentWakeupRequests).set({ idempotencyKey: `conversation-comment:${id}`, payload: { issueId: f.parent, commentId: id, _paperclipWakeContext: { issueId: f.parent, commentId: id, wakeCommentId: id, wakeCommentIds: [id] } } }).where(eq(agentWakeupRequests.id, f.receiptId));
    await db.update(heartbeatRuns).set({ contextSnapshot: { issueId: f.parent, commentId: id, wakeCommentId: id, wakeCommentIds: [id], source: "issue.comment" } }).where(eq(heartbeatRuns.id, f.runId));
    expect(await externalEvidenceWakeGate(db, f.input)).toMatchObject({ held: true, reason: "superseded_conversation_delivery" });
    await db.update(issueComments).set({ createdAt: sql`'2026-10-22T13:00:00.001000Z'::timestamptz` }).where(eq(issueComments.id, id));
    expect((await externalEvidenceWakeGate(db, f.input)).held).toBe(false);
    // The native action ordering needs the same precision: a newer hold in
    // this same millisecond must still block the genuinely fresh comment.
    await db.update(issueRecoveryActions).set({ createdAt: sql`'2026-10-22T13:00:00.000950Z'::timestamptz` }).where(eq(issueRecoveryActions.id, f.recovery.id));
    expect((await externalEvidenceWakeGate(db, f.input)).held).toBe(true);
  });
  it.each(["equal", "missing", "foreign"] as const)("native boundary cutoff preserves strict ordering for %s boundary", async kind => {
    const f = await conversationDelivery(); const boundaryId = await committedBoundary(f);
    if (kind === "equal") {
      await db.update(issueRecoveryActions).set({ createdAt: sql`(select ${issueComments.createdAt} from ${issueComments} where ${issueComments.id} = ${boundaryId})` }).where(eq(issueRecoveryActions.id, f.recovery.id));
      expect(await getExecutionBlocker(db, f.company, f.parent)).toBeNull();
    } else {
      const captured = kind === "missing" ? randomUUID() : await committedBoundary(await conversationDelivery());
      await db.update(issues).set({ conversationBoundaryCommentId: captured }).where(eq(issues.id, f.parent));
      expect(await getExecutionBlocker(db, f.company, f.parent)).toMatchObject({ recoveryActionId: f.recovery.id });
    }
  });
  it("retains the native hold when its captured boundary disappears before comparison", async () => {
    const f = await conversationDelivery(); const boundaryId = await committedBoundary(f);
    let deleted = false;
    // Timing seam only: every SELECT is real PostgreSQL and no hold predicate
    // or result is mocked. Delete after the captured-ID query resolves, before
    // getExecutionBlocker receives it and issues its actual comparison query.
    const pauseAfterSelect = (statement: object): object => {
      let proxy: object;
      proxy = new Proxy(statement, { get(target, key) {
        if (key === "then") return (resolve: (rows: unknown) => unknown, reject: (error: unknown) => unknown) => {
          const selected = Reflect.apply(Reflect.get(target, "then", target), target, [(rows: unknown) => rows]) as Promise<unknown>;
          return selected.then(async rows => {
            if (!deleted) { await db.delete(issueComments).where(eq(issueComments.id, boundaryId)); deleted = true; }
            return rows;
          }).then(resolve, reject);
        };
        const value = Reflect.get(target, key, target);
        return typeof value === "function" ? (...args: unknown[]) => {
          const result = Reflect.apply(value, target, args);
          return result === target ? proxy : result;
        } : value;
      } });
      return proxy;
    };
    const racingDb = new Proxy(db, { get(target, key, receiver) {
      if (key !== "select") return Reflect.get(target, key, receiver);
      return (...args: unknown[]) => {
        const fields = args[0] as Record<string, unknown> | undefined;
        const builder = Reflect.apply(target.select, target, args);
        const from = builder.from.bind(builder);
        builder.from = (table: unknown) => {
          const statement = from(table);
          return table === issueComments && fields?.id === issueComments.id ? pauseAfterSelect(statement) : statement;
        };
        return builder;
      };
    } });
    expect(await getExecutionBlocker(racingDb, f.company, f.parent)).toMatchObject({ recoveryActionId: f.recovery.id });
    expect(deleted).toBe(true);
  });
  async function dispatchFixture(f: Awaited<ReturnType<typeof conversationDelivery>>) {
    const cwd = mkdtempSync(join(tmpdir(), "fleet-boundary-provider-")); const marker = join(cwd, "provider.txt");
    await db.update(agents).set({ status: "idle", adapterType: "process",
      adapterConfig: { command: process.execPath, cwd,
        args: ["-e", `require('node:fs').appendFileSync(${JSON.stringify(marker)}, process.env.PAPERCLIP_RUN_ID+'\\n')`] },
      runtimeConfig: { heartbeat: { enabled: false, wakeOnDemand: true } } }).where(eq(agents.id, f.chief));
    return marker;
  }
  async function assertNoProviderClaim(f: Awaited<ReturnType<typeof conversationDelivery>>, marker: string) {
    const [run] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, f.runId));
    expect(run.status).toBe("cancelled"); expect(run.startedAt).toBeNull(); expect(run.processPid).toBeNull();
    expect(existsSync(marker)).toBe(false);
    const [wake] = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, f.receiptId));
    expect(wake.claimedAt).toBeNull();
    expect(await db.select().from(environmentLeases).where(eq(environmentLeases.heartbeatRunId, f.runId))).toHaveLength(0);
  }
  it("rejects cached fresh [F] versus authoritative [pre-reset A,F] through actual start", async () => {
    const f = await conversationDelivery("Fresh F"); const boundaryId = await committedBoundary(f);
    const [boundary] = await db.select().from(issueComments).where(eq(issueComments.id, boundaryId)); const oldId = randomUUID();
    await db.update(issueComments).set({ createdAt: new Date(boundary.createdAt.getTime() + 1) }).where(eq(issueComments.id, f.commentId));
    await db.insert(issueComments).values({ id: oldId, companyId: f.company, issueId: f.parent,
      authorType: "user", authorUserId: f.user, body: "Old A", createdAt: new Date(boundary.createdAt.getTime() - 1) });
    await db.update(agentWakeupRequests).set({ payload: { issueId: f.parent, commentId: f.commentId,
      _paperclipWakeContext: { issueId: f.parent, commentId: f.commentId, wakeCommentId: f.commentId, wakeCommentIds: [oldId, f.commentId] } } }).where(eq(agentWakeupRequests.id, f.receiptId));
    const before = await db.select().from(issueComments).where(eq(issueComments.issueId, f.parent)); const marker = await dispatchFixture(f);
    try {
      const restarted = createDb(native.connectionString); await heartbeatService(restarted).resumeQueuedRuns();
      await assertNoProviderClaim(f, marker);
      expect(await db.select().from(issueComments).where(eq(issueComments.issueId, f.parent))).toEqual(before);
      const [parent] = await db.select().from(issues).where(eq(issues.id, f.parent));
      expect(parent.conversationSessionGeneration).toBe(1); expect(parent.conversationBoundaryCommentId).toBe(boundaryId);
    } finally { await db.update(agents).set({ status: "paused" }).where(eq(agents.id, f.chief)); }
  });
  it.each(["run", "wake"] as const)("missing %s list cannot enter the exception or ordinary claim path", async missing => {
    const f = await conversationDelivery();
    if (missing === "run") await db.update(heartbeatRuns).set({ contextSnapshot: { issueId: f.parent,
      commentId: f.commentId, wakeCommentId: f.commentId, source: "issue.comment" } }).where(eq(heartbeatRuns.id, f.runId));
    if (missing === "wake") await db.update(agentWakeupRequests).set({ payload: { issueId: f.parent, commentId: f.commentId } }).where(eq(agentWakeupRequests.id, f.receiptId));
    const marker = await dispatchFixture(f);
    try {
      expect(await externalEvidenceWakeGate(db, f.input)).toMatchObject({ held: true, reason: "superseded_conversation_delivery" });
      await heartbeatService(createDb(native.connectionString)).resumeQueuedRuns(); await assertNoProviderClaim(f, marker);
      const [parent] = await db.select().from(issues).where(eq(issues.id, f.parent)); expect(parent.conversationSessionGeneration).toBe(0);
    } finally { await db.update(agents).set({ status: "paused" }).where(eq(agents.id, f.chief)); }
  });
  it("rechecks a newer reset committed after initial admission at an actual PostgreSQL claim barrier", async () => {
    const f = await conversationDelivery(); const marker = await dispatchFixture(f);
    let start: Promise<void> | undefined; let boundaryId: string | undefined;
    const scheduler = heartbeatService(createDb(native.connectionString));
    try {
      await db.transaction(async tx => {
        await tx.select({ id: issues.id }).from(issues).where(eq(issues.id, f.parent)).for("update");
        start = scheduler.resumeQueuedRuns();
        let reached = false;
        for (let i = 0; i < 200; i++) {
          const rows = await db.execute(sql`select exists(select 1 from pg_stat_activity where pid <> pg_backend_pid()
            and datname = current_database() and wait_event_type = 'Lock' and query like '%issues%for update%') as waiting`);
          if (rows[0]?.waiting) { reached = true; break; }
          await new Promise(resolve => setTimeout(resolve, 10));
        }
        expect(reached).toBe(true); // Initial gate passed; actual issue claim is blocked.
        boundaryId = await committedBoundary(f, tx as unknown as Db);
      });
      await start;
      await assertNoProviderClaim(f, marker);
      const [parent] = await db.select().from(issues).where(eq(issues.id, f.parent));
      expect(parent.conversationSessionGeneration).toBe(1); expect(parent.conversationBoundaryCommentId).toBe(boundaryId);
      expect((await db.select().from(issueComments).where(eq(issueComments.issueId, f.parent))).map(c => c.body)).toEqual(["/new", "/new"]);
    } finally {
      await db.update(agents).set({ status: "paused" }).where(eq(agents.id, f.chief));
      await start;
    }
  }, 15000);
  it("starts one genuine fresh matching-list turn after the committed boundary", async () => {
    const f = await conversationDelivery("Genuine fresh request"); const boundaryId = await committedBoundary(f);
    const [boundary] = await db.select().from(issueComments).where(eq(issueComments.id, boundaryId));
    await db.update(issueComments).set({ createdAt: new Date(boundary.createdAt.getTime() + 1) }).where(eq(issueComments.id, f.commentId));
    const marker = await dispatchFixture(f);
    try {
      expect((await externalEvidenceWakeGate(db, f.input)).held).toBe(false);
      await heartbeatService(createDb(native.connectionString)).resumeQueuedRuns();
      let run: typeof heartbeatRuns.$inferSelect | undefined;
      for (let i = 0; i < 200; i++) {
        [run] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, f.runId));
        if (run.status !== "queued" && run.status !== "running") break;
        await new Promise(resolve => setTimeout(resolve, 20));
      }
      expect(run?.status).toBe("succeeded"); expect(readFileSync(marker, "utf8")).toBe(f.runId + "\n");
      const started = await db.select().from(heartbeatRuns).where(and(eq(heartbeatRuns.companyId, f.company), sql`${heartbeatRuns.startedAt} is not null`, sql`${heartbeatRuns.id} <> ${f.runId}::uuid`));
      // The previously committed reset fixture has its own bookkeeping row;
      // it never had a provider process or startedAt.
      expect(started).toHaveLength(0);
    } finally { await db.update(agents).set({ status: "paused" }).where(eq(agents.id, f.chief)); }
  }, 15000);
  it("hands a durable user /new back to native reset semantics across reread without resolving history", async () => {
    const f = await conversationDelivery();
    expect((await externalEvidenceWakeGate(db, f.input)).held).toBe(false);
    const restarted = createDb(native.connectionString);
    expect((await externalEvidenceWakeGate(restarted, f.input)).held).toBe(false);
    const [action] = await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.id, f.recovery.id));
    expect(action).toEqual(f.recovery);
    expect(await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.companyId, f.company))).toHaveLength(1);
    expect(await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.companyId, f.company))).toHaveLength(1);
  });
  it.each(["ordinary_comment", "automation", "foreign_receipt", "wrong_actor", "deleted_comment", "agent_comment",
    "derived_comment", "wrong_key", "wrong_owner", "stale_run", "missing_receipt", "revoked_member"] as const)(
    "does not hand off an unproved %s conversation delivery", async fault => {
      const f = await conversationDelivery();
      if (fault === "ordinary_comment") await db.update(issueComments).set({ body: "Retry previous work" }).where(eq(issueComments.id, f.commentId));
      if (fault === "automation") await db.update(agentWakeupRequests).set({ source: "automation", requestedByActorType: "system" }).where(eq(agentWakeupRequests.id, f.receiptId));
      if (fault === "foreign_receipt") f.input.receiptId = (await conversationDelivery()).receiptId;
      if (fault === "wrong_actor") await db.update(agentWakeupRequests).set({ requestedByActorId: "another-user" }).where(eq(agentWakeupRequests.id, f.receiptId));
      if (fault === "deleted_comment") await db.update(issueComments).set({ deletedAt: new Date() }).where(eq(issueComments.id, f.commentId));
      if (fault === "agent_comment") await db.update(issueComments).set({ authorAgentId: f.chief }).where(eq(issueComments.id, f.commentId));
      if (fault === "derived_comment") await db.update(issueComments).set({ derivedCreatedByRunId: f.runId }).where(eq(issueComments.id, f.commentId));
      if (fault === "wrong_key") await db.update(agentWakeupRequests).set({ idempotencyKey: "unknown:" + f.commentId }).where(eq(agentWakeupRequests.id, f.receiptId));
      if (fault === "wrong_owner") await db.update(issues).set({ conversationUserId: "another-user" }).where(eq(issues.id, f.parent));
      if (fault === "stale_run") await db.update(heartbeatRuns).set({ status: "cancelled" }).where(eq(heartbeatRuns.id, f.runId));
      if (fault === "missing_receipt") f.input.receiptId = randomUUID();
      if (fault === "revoked_member") await db.update(companyMemberships).set({ status: "inactive" }).where(eq(companyMemberships.companyId, f.company));
      expect((await externalEvidenceWakeGate(db, f.input)).held).toBe(true);
    },
  );
  it.each(["external", "human", "unknown_descriptor", "unknown_recovery", "cancelled_request"] as const)(
    "a proven reset preserves a coexisting %s hold", async hold => {
      const f = await conversationDelivery();
      if (hold === "external") await db.update(issues).set({ unblockDescriptor: { owner: { agentId: f.chief }, action: "Await actual external evidence" } }).where(eq(issues.id, f.parent));
      if (hold === "human") await db.update(issues).set({ unblockDescriptor: { owner: "board", action: "Keep human decision" } }).where(eq(issues.id, f.parent));
      if (hold === "unknown_descriptor") await db.update(issues).set({ unblockDescriptor: sql`${JSON.stringify({ futureHold: true })}::jsonb` }).where(eq(issues.id, f.parent));
      // Preserve migration0084's one-active-recovery-per-source invariant.
      if (hold === "unknown_recovery") await db.update(issueRecoveryActions).set({ cause: "unknown_future_cause" }).where(eq(issueRecoveryActions.id, f.recovery.id));
      if (hold === "cancelled_request") await db.update(issues).set({ status: "cancelled" }).where(eq(issues.id, f.source));
      expect((await externalEvidenceWakeGate(db, f.input)).held).toBe(true);
    },
  );
  it("a proven reset waits for a live old provider process without signalling it", async () => {
    const f = await conversationDelivery();
    await db.insert(heartbeatRuns).values({ companyId: f.company, agentId: f.chief,
      status: "cancelled", runtimeMode: "legacy", processPid: process.pid,
      contextSnapshot: { issueId: f.parent }, runnerProfileJson: { adapterDispatch: { adapterType: "hermes_local" } } });
    expect((await externalEvidenceWakeGate(db, f.input)).held).toBe(true);
  });
  it.each(["interaction", "approval"] as const)("a proven reset preserves pending human %s", async hold => {
    const f = await conversationDelivery();
    if (hold === "interaction") await db.insert(issueThreadInteractions).values({ companyId: f.company,
      issueId: f.parent, kind: "request_confirmation", status: "pending", effectiveResolverPolicy: "human_only",
      payload: { version: 1, prompt: "Keep this decision pending" } });
    if (hold === "approval") {
      const [approval] = await db.insert(approvals).values({ companyId: f.company, type: "synthetic", status: "pending", payload: {} }).returning();
      await db.insert(issueApprovals).values({ companyId: f.company, issueId: f.parent, approvalId: approval.id });
    }
    expect((await externalEvidenceWakeGate(db, f.input)).held).toBe(true);
  });
  it("uses the committed reset boundary for fresh turns but retains a newer native hold", async () => {
    const f = await conversationDelivery();
    expect((await prepareConversationTurn(db, f.run)).reset).toBe(true);
    expect((await prepareConversationTurn(db, f.run)).reset).toBe(true);
    const [parent] = await db.select().from(issues).where(eq(issues.id, f.parent));
    expect(parent.conversationSessionGeneration).toBe(1);
    const commentId = randomUUID();
    await db.insert(issueComments).values({ id: commentId, companyId: f.company, issueId: f.parent,
      authorType: "user", authorUserId: f.user, body: "Fresh conversation after context reset" });
    await db.update(agentWakeupRequests).set({ idempotencyKey: `conversation-comment:${commentId}`,
      payload: { issueId: f.parent, commentId, _paperclipWakeContext: { issueId: f.parent, commentId, wakeCommentId: commentId, wakeCommentIds: [commentId] } } }).where(eq(agentWakeupRequests.id, f.receiptId));
    await db.update(heartbeatRuns).set({ contextSnapshot: { issueId: f.parent, commentId, wakeCommentId: commentId, wakeCommentIds: [commentId], source: "issue.comment" } }).where(eq(heartbeatRuns.id, f.runId));
    expect((await externalEvidenceWakeGate(db, f.input)).held).toBe(false);
    await db.update(issueRecoveryActions).set({ createdAt: new Date(Date.now() + 1000) }).where(eq(issueRecoveryActions.id, f.recovery.id));
    expect((await externalEvidenceWakeGate(db, f.input)).held).toBe(true);
  });
  it("delegates only recognized native execution waits while queued dispatch and unknown holds stay protected", async () => {
    const f = await fixture(); const target = randomUUID();
    await db.insert(issues).values({ id: target, companyId: f.company, title: "Synthetic execution-only target",
      status: "blocked", assigneeAgentId: f.chief, unblockDescriptor: null });
    await db.insert(issueRecoveryActions).values({ companyId: f.company, sourceIssueId: target,
      kind: "active_run_watchdog", ownerType: "board", returnOwnerAgentId: f.chief,
      cause: "legacy_execution_requires_reconciliation", status: "active", evidence: {},
      fingerprint: randomUUID(), nextAction: "Reconcile this exact stopped execution." });
    const input = { companyId: f.company, issueId: target, agentId: f.chief };
    expect((await externalEvidenceWakeGate(db, input)).held).toBe(true);
    expect((await externalEvidenceWakeGate(db, { ...input, deferNativeExecutionHolds: true })).held).toBe(false);
    // Migration0084 permits only one active recovery per source. Give the
    // unknown-hold control its own source rather than violating that index.
    const unknownTarget = randomUUID();
    await db.insert(issues).values({ id: unknownTarget, companyId: f.company, title: "Synthetic unknown-held target",
      status: "blocked", assigneeAgentId: f.chief, unblockDescriptor: null });
    await db.insert(issueRecoveryActions).values({ companyId: f.company, sourceIssueId: unknownTarget,
      kind: "active_run_watchdog", ownerType: "board", returnOwnerAgentId: f.chief,
      cause: "unknown_synthetic_recovery_hold", status: "active", evidence: {},
      fingerprint: randomUUID(), nextAction: "Keep this unknown hold." });
    expect((await externalEvidenceWakeGate(db, { ...input, issueId: unknownTarget, deferNativeExecutionHolds: true })).held).toBe(true);
  });
  it.each(["external", "human", "unknown", "cancelled_request"] as const)(
    "does not delegate a coexisting %s hold to execution recovery", async (hold) => {
      const f = await fixture();
      await db.insert(issueRecoveryActions).values({ companyId: f.company, sourceIssueId: f.parent,
        kind: "active_run_watchdog", ownerType: "board", returnOwnerAgentId: f.chief,
        cause: "legacy_execution_requires_reconciliation", status: "active", evidence: {},
        fingerprint: randomUUID(), nextAction: "Reconcile this exact stopped execution." });
      if (hold === "human") await db.update(issues).set({ unblockDescriptor: { owner: "board", action: "Human approval remains required" } }).where(eq(issues.id, f.parent));
      if (hold === "unknown") await db.update(issues).set({ unblockDescriptor: sql`${JSON.stringify({ kind: "unknown_synthetic_hold", action: "Preserve unsupported hold" })}::jsonb` }).where(eq(issues.id, f.parent));
      if (hold === "cancelled_request") {
        await db.update(issues).set({ unblockDescriptor: null }).where(eq(issues.id, f.parent));
        await db.update(issues).set({ status: "cancelled" }).where(eq(issues.id, f.source));
      }
      const input = { companyId: f.company, issueId: f.parent, agentId: f.chief };
      expect((await externalEvidenceWakeGate(db, { ...input, deferNativeExecutionHolds: true })).held).toBe(true);
      if (hold === "external") {
        const intent = await queue(f); expect(intent).not.toBeNull();
        // Fresh evidence cannot override the installed execution hold at queued dispatch.
        expect((await externalEvidenceWakeGate(db, { ...input, intentId: intent!.id })).held).toBe(true);
      }
    },
  );
  it.each(["external", "human", "unknown", "cancelled_request"] as const)(
    "dependency backstop preserves a coexisting %s hold without enqueueing work", async (hold) => {
      const f = await fixture(), blocker = randomUUID();
      await db.insert(issues).values({ id: blocker, companyId: f.company,
        title: "Synthetic completed production dependency", status: "done" });
      await db.insert(issueRelations).values({ companyId: f.company, type: "blocks",
        issueId: blocker, relatedIssueId: f.parent });
      await db.insert(issueRecoveryActions).values({ companyId: f.company, sourceIssueId: f.parent,
        kind: "active_run_watchdog", ownerType: "board", returnOwnerAgentId: f.chief,
        cause: "legacy_execution_requires_reconciliation", status: "active", evidence: {},
        fingerprint: randomUUID(), nextAction: "Reconcile this exact stopped execution." });
      if (hold === "human") await db.update(issues).set({ unblockDescriptor: { owner: "board", action: "Human approval remains required" } }).where(eq(issues.id, f.parent));
      if (hold === "unknown") await db.update(issues).set({ unblockDescriptor: sql`${JSON.stringify({ kind: "unknown_synthetic_hold", action: "Preserve unsupported hold" })}::jsonb` }).where(eq(issues.id, f.parent));
      if (hold === "cancelled_request") {
        await db.update(issues).set({ unblockDescriptor: null }).where(eq(issues.id, f.parent));
        await db.update(issues).set({ status: "cancelled" }).where(eq(issues.id, f.source));
      }
      let enqueueAttempts = 0;
      const { recoveryService } = await import("./recovery/service.js");
      const result = await recoveryService(db, { enqueueWakeup: async () => {
        enqueueAttempts += 1; return null;
      } }).reconcileResolvedDependencyWakeBackstop({ companyId: f.company });
      expect(result).toMatchObject({ checked: 1, interactionSkipped: 1, healed: 0 });
      expect(enqueueAttempts).toBe(0);
      expect(await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.companyId, f.company))).toHaveLength(0);
      const [parent] = await db.select().from(issues).where(eq(issues.id, f.parent));
      expect(parent.status).toBe("blocked");
    },
  );
  it("holds telemetry and production completion, while fresh exact evidence admits reconsideration without health certification", async () => {
    const f = await fixture();
    expect((await externalEvidenceWakeGate(db, { companyId: f.company, issueId: f.parent })).held).toBe(true);
    const intent = await queue(f); expect(intent).not.toBeNull();
    expect(intent!.payload?.evidenceVerified).toBe(false);
    expect((await externalEvidenceWakeGate(db, { companyId: f.company, issueId: f.parent, agentId: f.chief, intentId: intent!.id })).held).toBe(false);
    const [parent] = await db.select().from(issues).where(eq(issues.id, f.parent));
    expect(parent.status).toBe("blocked"); expect(parent.unblockDescriptor?.action).toBe("Await exact external evidence");
  });
  it("serializes concurrent duplicates and retains the same intent across restart and changed caller correlation ids", async () => {
    const f = await fixture();
    const [one, two] = await Promise.all([queue(f), queue(f, { eventId: randomUUID() })]);
    expect(one!.id).toBe(two!.id);
    const restarted = createDb(native.connectionString);
    const replay = await restarted.transaction(tx => queueExternalEvidenceSignal(tx as unknown as Db, { companyId: f.company,
      sourceIssueId: f.source, actorUserId: f.user, eventId: randomUUID(), kind: "evidence_supplied", commentId: f.comment }));
    expect(replay!.id).toBe(one!.id);
    const rows = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.companyId, f.company));
    expect(rows).toHaveLength(1);
  });
  it("rolls back both source event and intent at the crash boundary; retry commits one of each", async () => {
    const f = await fixture(), commentId = randomUUID();
    await expect(db.transaction(async tx => {
      await tx.insert(issueComments).values({ id: commentId, companyId: f.company, issueId: f.source, authorUserId: f.user, body: "Fresh evidence" });
      await queueExternalEvidenceSignal(tx as unknown as Db, { companyId: f.company, sourceIssueId: f.source,
        actorUserId: f.user, eventId: commentId, kind: "evidence_supplied", commentId });
      throw new Error("crash before transaction commit");
    })).rejects.toThrow("crash before");
    expect(await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.companyId, f.company))).toHaveLength(0);
    expect(await db.select().from(issueComments).where(eq(issueComments.id, commentId))).toHaveLength(0);
    const intent = await queue(f); expect(intent).not.toBeNull();
  });
  it("distinguishes owner resolution, cancellation and replacement without treating any as verified health", async () => {
    for (const kind of ["resolved", "cancelled", "replaced"] as const) {
      const f = await fixture(); const replacement = randomUUID();
      if (kind === "replaced") {
        await db.insert(issues).values({ id: replacement, companyId: f.company, parentId: f.parent, createdByAgentId: f.chief,
          title: "Replacement evidence request", status: "blocked", unblockDescriptor: { owner: "board", action: "Provide new evidence" } });
        await db.insert(issueCreateIdempotencyKeys).values({ companyId: f.company, issueId: replacement, idempotencyKey: OWNER_REQUEST_PREFIX + replacement });
      }
      await db.update(issues).set({ status: kind === "resolved" ? "done" : "cancelled", unblockDescriptor: null }).where(eq(issues.id, f.source));
      const intent = await queue(f, { kind, ...(kind === "replaced" ? { replacementIssueId: replacement } : {}) });
      expect(intent!.payload?.evidenceVerified).toBe(false);
      expect((intent!.payload?.evidenceSignal as { kind: string }).kind).toBe(kind);
      expect((await externalEvidenceWakeGate(db, { companyId: f.company, issueId: f.parent, intentId: intent!.id })).held).toBe(false);
      // Cancellation/replacement alone never release ordinary production admission.
      if (kind !== "resolved") expect((await externalEvidenceWakeGate(db, { companyId: f.company, issueId: f.parent })).held).toBe(true);
    }
  });
  it("keeps cancelled requests held until an explicit exact replacement is itself resolved", async () => {
    const f = await fixture(), replacement = randomUUID();
    await db.update(issues).set({ unblockDescriptor: null }).where(eq(issues.id, f.parent));
    await db.update(issues).set({ status: "cancelled", unblockDescriptor: null }).where(eq(issues.id, f.source));
    expect((await externalEvidenceWakeGate(db, { companyId: f.company, issueId: f.parent })).held).toBe(true);
    await db.insert(issues).values({ id: replacement, companyId: f.company, parentId: f.parent, createdByAgentId: f.chief,
      title: "Exact replacement", status: "blocked", unblockDescriptor: { owner: "board", action: "Supply new evidence" } });
    await db.insert(issueCreateIdempotencyKeys).values({ companyId: f.company, issueId: replacement, idempotencyKey: OWNER_REQUEST_PREFIX + replacement });
    await queue(f, { kind: "replaced", replacementIssueId: replacement });
    expect((await externalEvidenceWakeGate(db, { companyId: f.company, issueId: f.parent })).held).toBe(true);
    await db.update(issues).set({ status: "done", unblockDescriptor: null }).where(eq(issues.id, replacement));
    expect((await externalEvidenceWakeGate(db, { companyId: f.company, issueId: f.parent })).held).toBe(false);
    const [old] = await db.select().from(issues).where(eq(issues.id, f.source));
    expect(old.status).toBe("cancelled"); // No history or source disposition is rewritten.
  });

  it("a changed evidence revision creates a new signal and invalidates the older one", async () => {
    const f = await fixture(), old = await queue(f);
    await db.update(issueComments).set({ body: "Changed timestamped evidence", updatedAt: new Date(Date.now() + 1) }).where(eq(issueComments.id, f.comment));
    expect((await externalEvidenceWakeGate(db, { companyId: f.company, issueId: f.parent, intentId: old!.id })).held).toBe(true);
    const fresh = await queue(f);
    expect(fresh!.id).not.toBe(old!.id);
    expect((await externalEvidenceWakeGate(db, { companyId: f.company, issueId: f.parent, intentId: fresh!.id })).held).toBe(false);
  });

  it("rejects stale generation, edited/deleted evidence, out-of-order disposition and unproved source provenance", async () => {
    const f = await fixture(), intent = await queue(f);
    await db.update(issues).set({ unblockDescriptor: { owner: { agentId: f.chief }, action: "A different exact hold" } }).where(eq(issues.id, f.parent));
    expect((await externalEvidenceWakeGate(db, { companyId: f.company, issueId: f.parent, intentId: intent!.id })).held).toBe(true);
    const g = await fixture();
    await db.update(issueComments).set({ deletedAt: new Date() }).where(eq(issueComments.id, g.comment));
    expect(await queue(g)).toBeNull();
    const h = await fixture();
    expect(await queue(h, { kind: "resolved" })).toBeNull();
    await db.delete(issueCreateIdempotencyKeys).where(eq(issueCreateIdempotencyKeys.issueId, h.source));
    expect(await queue(h)).toBeNull();
  });
  it("never accepts agent-on-behalf, cross-company, revoked member or stale old comments as evidence", async () => {
    const f = await fixture();
    await db.update(issueComments).set({ authorAgentId: f.chief }).where(eq(issueComments.id, f.comment));
    expect(await queue(f)).toBeNull();
    const g = await fixture(); await db.update(companyMemberships).set({ status: "inactive" }).where(eq(companyMemberships.companyId, g.company));
    expect(await queue(g)).toBeNull();
    const h = await fixture(); expect(await queue(h, { companyId: f.company })).toBeNull();
    await db.update(issueComments).set({ createdAt: new Date(0) }).where(eq(issueComments.id, h.comment)); expect(await queue(h)).toBeNull();
  });
  it("preserves unknown and human descriptors even for an authenticated source event", async () => {
    for (const owner of ["board", { userId: "synthetic-user" }, { agentId: randomUUID() }]) {
      const f = await fixture(), intent = await queue(f);
      await db.update(issues).set({ unblockDescriptor: { owner, action: "Protected decision" } as never }).where(eq(issues.id, f.parent));
      expect((await externalEvidenceWakeGate(db, { companyId: f.company, issueId: f.parent, intentId: intent!.id })).held).toBe(true);
    }
    expect(classifyEvidenceHold({ assigneeAgentId: "x", unblockDescriptor: { owner: "unknown", action: "Future" } as never, executionState: null })).toBe("protected");
  });
  it("actual source comment and terminal mutation transactions record native signals", async () => {
    const f = await fixture();
    const comment = await issueService(db).addComment(f.source, "Fresh native human source evidence", { userId: f.user });
    let intents = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.companyId, f.company));
    expect(intents).toHaveLength(1);
    expect((intents[0].payload?.evidenceSignal as { commentId: string }).commentId).toBe(comment.id);
    await issueService(db).update(f.source, { status: "done", actorUserId: f.user });
    intents = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.companyId, f.company));
    expect(intents).toHaveLength(2);
    expect(intents.some(i => (i.payload?.evidenceSignal as { kind: string }).kind === "resolved")).toBe(true);
    expect(intents.every(i => i.payload?.evidenceVerified === false)).toBe(true);
  });

  it("preserves the installed agent review path while protecting human, unknown and coexisting evidence holds", async () => {
    const f = await fixture();
    const executionState = { status: "pending" as const, currentStageId: randomUUID(), currentStageIndex: 0,
      currentStageType: "review" as const, currentParticipant: { type: "agent" as const, agentId: f.chief, userId: null },
      returnAssignee: null, completedStageIds: [], lastDecisionId: null, lastDecisionOutcome: null };
    await db.update(issues).set({ status: "in_review", unblockDescriptor: null, executionState }).where(eq(issues.id, f.parent));
    // Coexisting unresolved owner evidence remains protected even for the reviewer.
    expect((await externalEvidenceWakeGate(db, { companyId: f.company, issueId: f.parent, agentId: f.chief })).held).toBe(true);
    await db.update(issues).set({ status: "done", unblockDescriptor: null }).where(eq(issues.id, f.source));
    expect((await externalEvidenceWakeGate(db, { companyId: f.company, issueId: f.parent, agentId: f.chief })).held).toBe(false);
    expect((await externalEvidenceWakeGate(db, { companyId: f.company, issueId: f.parent, agentId: randomUUID() })).held).toBe(true);
    await db.update(issues).set({ executionState: { ...executionState,
      currentParticipant: { type: "user", userId: f.user, agentId: null } } }).where(eq(issues.id, f.parent));
    expect((await externalEvidenceWakeGate(db, { companyId: f.company, issueId: f.parent })).held).toBe(true);
    await db.update(issues).set({ executionState: { unknown: "future native hold" } as never }).where(eq(issues.id, f.parent));
    expect((await externalEvidenceWakeGate(db, { companyId: f.company, issueId: f.parent })).held).toBe(true);
  });

  it("preserves review recovery analysis when the source worker differs from its explicit reviewer", async () => {
    const f = await fixture(), reviewer = randomUUID();
    await db.insert(agents).values({ id: reviewer, companyId: f.company, name: "Reviewer", role: "qa", adapterType: "process", status: "paused" });
    await db.update(issues).set({ status: "in_review", unblockDescriptor: null, executionState: {
      status: "pending", currentStageId: randomUUID(), currentStageIndex: 0, currentStageType: "review",
      currentParticipant: { type: "agent", agentId: reviewer, userId: null },
      returnAssignee: { type: "agent", agentId: f.chief, userId: null }, completedStageIds: [], lastDecisionId: null, lastDecisionOutcome: null,
    } }).where(eq(issues.id, f.parent));
    const input = { companyId: f.company, issueId: f.parent };
    expect((await externalEvidenceWakeGate(db, input)).held).toBe(true); // Separate owner evidence still blocks.
    await db.update(issues).set({ status: "done" }).where(eq(issues.id, f.source));
    expect((await externalEvidenceWakeGate(db, input)).held).toBe(false); // Analysis may reach the native recovery owner.
    expect((await externalEvidenceWakeGate(db, { ...input, agentId: reviewer })).held).toBe(false);
    expect((await externalEvidenceWakeGate(db, { ...input, agentId: f.chief })).held).toBe(true);
    const [parent] = await db.select().from(issues).where(eq(issues.id, f.parent));
    expect(parent.assigneeAgentId).toBe(f.chief); // Gate grants no checkout/reassignment or provider admission.
  });

  it("admits only the current explicit agent approval stage while retaining unresolved owner evidence", async () => {
    const f = await fixture();
    const executionState = { status: "pending" as const, currentStageId: randomUUID(), currentStageIndex: 0,
      currentStageType: "approval" as const, currentParticipant: { type: "agent" as const, agentId: f.chief, userId: null },
      returnAssignee: null, completedStageIds: [], lastDecisionId: null, lastDecisionOutcome: null };
    await db.update(issues).set({ status: "in_review", unblockDescriptor: null, executionState }).where(eq(issues.id, f.parent));
    const gate = (agentId = f.chief) => externalEvidenceWakeGate(db, { companyId: f.company, issueId: f.parent, agentId });
    expect((await gate()).held).toBe(true); // The independent owner request is still unresolved.
    await db.update(issues).set({ status: "done" }).where(eq(issues.id, f.source));
    expect((await gate()).held).toBe(false);
    expect((await gate(randomUUID())).held).toBe(true);
    await db.update(issues).set({ assigneeAgentId: null }).where(eq(issues.id, f.parent));
    expect((await gate()).held).toBe(true); // Unknown/mismatched current owner is not a stage grant.
    await db.update(issues).set({ assigneeAgentId: f.chief, executionState: { ...executionState,
      currentParticipant: { type: "user", userId: f.user, agentId: null } } }).where(eq(issues.id, f.parent));
    expect((await gate()).held).toBe(true); // Human approval never becomes an agent stage.
    await db.update(issues).set({ executionState: sql`${JSON.stringify({ unknown: "future native hold" })}::jsonb` }).where(eq(issues.id, f.parent));
    expect((await gate()).held).toBe(true);
  });
  it.each(["external_descriptor", "human_interaction", "pending_approval", "cancelled_request", "unknown_recovery", "unknown_descriptor"] as const)(
    "agent approval stage preserves a coexisting %s hold", async hold => {
      const f = await fixture();
      const executionState = { status: "pending" as const, currentStageId: randomUUID(), currentStageIndex: 0,
        currentStageType: "approval" as const, currentParticipant: { type: "agent" as const, agentId: f.chief, userId: null },
        returnAssignee: null, completedStageIds: [], lastDecisionId: null, lastDecisionOutcome: null };
      await db.update(issues).set({ status: "done" }).where(eq(issues.id, f.source));
      await db.update(issues).set({ status: "in_review", unblockDescriptor: null, executionState }).where(eq(issues.id, f.parent));
      const gate = () => externalEvidenceWakeGate(db, { companyId: f.company, issueId: f.parent, agentId: f.chief });
      expect((await gate()).held).toBe(false);
      if (hold === "external_descriptor") await db.update(issues).set({ unblockDescriptor: { owner: { agentId: f.chief }, action: "Await actual external evidence" } }).where(eq(issues.id, f.parent));
      if (hold === "human_interaction") await db.insert(issueThreadInteractions).values({ companyId: f.company,
        issueId: f.parent, kind: "request_confirmation", status: "pending", effectiveResolverPolicy: "human_only",
        payload: { version: 1, prompt: "Keep human decision pending" } });
      if (hold === "pending_approval") {
        const [approval] = await db.insert(approvals).values({ companyId: f.company, type: "synthetic", status: "pending", payload: {} }).returning();
        await db.insert(issueApprovals).values({ companyId: f.company, issueId: f.parent, approvalId: approval.id });
      }
      if (hold === "cancelled_request") await db.update(issues).set({ status: "cancelled" }).where(eq(issues.id, f.source));
      if (hold === "unknown_recovery") await db.insert(issueRecoveryActions).values({ companyId: f.company,
        sourceIssueId: f.parent, kind: "active_run_watchdog", cause: "unknown_future_cause", status: "active", ownerType: "board",
        evidence: {}, fingerprint: randomUUID(), nextAction: "Do not infer resolution" });
      if (hold === "unknown_descriptor") await db.update(issues).set({ unblockDescriptor: sql`${JSON.stringify({ futureHold: true })}::jsonb` }).where(eq(issues.id, f.parent));
      expect((await gate()).held).toBe(true);
    },
  );

  it("rejects incomplete, mixed and arbitrary API event bodies", () => {
    expect(externalEvidenceEventSchema.safeParse({ eventId: randomUUID(), kind: "resolved" }).success).toBe(true);
    for (const body of [{ eventId: randomUUID(), kind: "evidence_supplied" },
      { eventId: randomUUID(), kind: "resolved", commentId: randomUUID() },
      { eventId: randomUUID(), kind: "replaced" },
      { eventId: randomUUID(), kind: "resolved", evidenceVerified: true }]) {
      expect(externalEvidenceEventSchema.safeParse(body).success).toBe(false);
    }
  });

  it("fences retry attempts only after durable confirmation that no run was admitted", async () => {
    const f = await fixture(), intent = await queue(f), actor = nativeEvidenceDispatchActor(intent!)!;
    await db.insert(agentWakeupRequests).values({ companyId: f.company, agentId: f.chief, source: "automation",
      status: "skipped", reason: "agent.not_invokable", requestedByActorType: "system", requestedByActorId: actor,
      payload: { issueId: f.parent } });
    const advanced = await Promise.all([retryUnadmittedEvidenceIntent(db, intent!.id, actor), retryUnadmittedEvidenceIntent(db, intent!.id, actor)]);
    expect(advanced.filter(Boolean)).toHaveLength(1);
    const [current] = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, intent!.id));
    expect(current.payload?.evidenceDispatchAttempt).toBe(1);
    expect(nativeEvidenceDispatchActor(current)).toBe(actor + ":1");
    expect((await externalEvidenceWakeGate(db, { companyId: f.company, issueId: f.parent, intentId: current.id,
      dispatchActorId: actor })).held).toBe(true);
    expect((await externalEvidenceWakeGate(db, { companyId: f.company, issueId: f.parent, intentId: current.id,
      dispatchActorId: nativeEvidenceDispatchActor(current) })).held).toBe(false);
  });

  it("fences the outbox dispatch replay by exact actor, parent lock and retained receipt", async () => {
    const f = await fixture(), intent = await queue(f), actor = `native-status-wake-dispatch:${intent!.id}`;
    const admit = () => db.transaction(async tx => {
      await tx.execute(sql`select id from ${issues} where id = ${f.parent} for update`);
      const prior = await existingNativeIntentDispatch(tx as unknown as Db, { companyId: f.company, issueId: f.parent,
        agentId: f.chief, intentId: intent!.id, actorId: actor });
      if (prior) return prior.id;
      const [receipt] = await tx.insert(agentWakeupRequests).values({ companyId: f.company, agentId: f.chief,
        source: "automation", reason: EXTERNAL_EVIDENCE_WAKE, requestedByActorType: "system", requestedByActorId: actor,
        payload: { issueId: f.parent } }).returning();
      return receipt.id;
    });
    const [one, two] = await Promise.all([admit(), admit()]); expect(one).toBe(two);
    expect(await admit()).toBe(one); // Restart after dispatch commit but before original intent linkage.
    expect(await existingNativeIntentDispatch(db, { companyId: f.company, issueId: f.parent, agentId: f.chief,
      intentId: intent!.id, actorId: "untrusted-caller" })).toBeNull();
    expect((await externalEvidenceWakeGate(db, { companyId: f.company, issueId: f.parent, intentId: intent!.id, receiptId: randomUUID() })).held).toBe(true);
  });
});
