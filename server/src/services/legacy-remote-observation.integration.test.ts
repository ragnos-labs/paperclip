import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { agents, companies, createDb, heartbeatRuns, issues, agentTaskSessions, agentRuntimeState, costEvents } from "@paperclipai/db";
import { startEmbeddedPostgresTestDatabase } from "../__tests__/helpers/embedded-postgres.js";
import { claimLegacyRemoteRunObservation, legacyControllerClaim, legacyControllerBootId,
  persistLegacyRemoteRunBinding, readLegacyRemoteRunBinding, withLegacyObserverOwnership } from "./legacy-controller-lease.js";

const { adapterExecute, storeFactory } = vi.hoisted(() => ({ adapterExecute: vi.fn(), storeFactory: vi.fn() }));
vi.mock("../adapters/index.js", async importOriginal => {
  const actual = await importOriginal<typeof import("../adapters/index.js")>();
  return { ...actual, getServerAdapter: (type: string) => type === "hermes_gateway"
    ? { ...actual.getServerAdapter(type), execute: adapterExecute } : actual.getServerAdapter(type) };
});
vi.mock("./run-log-store.js", async importOriginal => {
  const actual = await importOriginal<typeof import("./run-log-store.js")>();
  return { ...actual, getRunLogStore: storeFactory };
});
import { heartbeatService } from "./heartbeat.js";
import { createDurableRunLogStore } from "./run-log-store.js";

// This suite is required. An unavailable database is a failure, never a skip.
describe("accepted Hermes observation ownership", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  let logDir: string;
  const binding = { adapterType: "hermes_gateway", providerRunId: "run_synthetic",
    transportFingerprint: "a".repeat(64), deadlineAt: "2026-10-05T10:00:00.000Z" };
  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("remote-observation-");
    db = createDb(database.connectionString);
    logDir = await fs.mkdtemp(path.join(os.tmpdir(), "accepted-run-logs-"));
    storeFactory.mockReturnValue(createDurableRunLogStore({ basePath: logDir }));
  }, 30000);
  afterAll(async () => { await database?.cleanup(); if (logDir) await fs.rm(logDir, { recursive: true, force: true }); });
  afterEach(async () => {
    await db.update(heartbeatRuns).set({ status: "succeeded" }).where(eq(heartbeatRuns.status, "running"));
    adapterExecute.mockReset();
  });
  async function seed() {
    const companyId = randomUUID(), agentId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Synthetic observation", issuePrefix: `R${companyId.slice(0, 7)}` });
    await db.insert(agents).values({ id: agentId, companyId, name: "Observer", role: "general", adapterType: "hermes_gateway", status: "idle" });
    const [run] = await db.insert(heartbeatRuns).values({ companyId, agentId, status: "running", runtimeMode: "legacy",
      runnerProfileJson: { adapterDispatch: { adapterType: "hermes_gateway" } }, ...legacyControllerClaim("legacy") }).returning();
    return run;
  }
  async function saved(id: string) {
    const [run] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, id));
    return run;
  }
  async function expire(run: Awaited<ReturnType<typeof seed>>) {
    await db.update(heartbeatRuns).set({ controllerBootId: randomUUID(),
      controllerLeaseExpiresAt: sql`clock_timestamp() - interval '1 second'` }).where(eq(heartbeatRuns.id, run.id));
    return saved(run.id);
  }
  it.each([
    { ...binding, providerRunId: "" }, { ...binding, transportFingerprint: "bad" },
    { ...binding, deadlineAt: "invalid" }, { ...binding, adapterType: "other" },
    { ...binding, deadlineAt: undefined },
  ])("rejects malformed bindings before any write: %j", async invalid => {
    const run = await seed();
    await expect(persistLegacyRemoteRunBinding(db, run, invalid as typeof binding)).rejects.toThrow();
    expect(await saved(run.id)).toEqual(run);
  });
  it("rejects foreign company binding persistence without state changes", async () => {
    const run = await seed();
    await expect(persistLegacyRemoteRunBinding(db, { ...run, companyId: randomUUID() }, binding)).rejects.toThrow();
    expect(await saved(run.id)).toEqual(run);
  });
  it("retries identical callbacks idempotently but rejects identity conflicts", async () => {
    const run = await seed();
    const first = await persistLegacyRemoteRunBinding(db, run, binding);
    const retry = await persistLegacyRemoteRunBinding(db, run, binding);
    expect(readLegacyRemoteRunBinding(retry)).toEqual(binding);
    expect(retry.externalRunId).toBe(first.externalRunId);
    for (const changed of [{ ...binding, providerRunId: "run_other" },
      { ...binding, transportFingerprint: "b".repeat(64) }, { ...binding, deadlineAt: null }]) {
      const before = await saved(run.id);
      await expect(persistLegacyRemoteRunBinding(db, run, changed)).rejects.toThrow();
      expect(await saved(run.id)).toEqual(before);
    }
  });
  it("retains accepted identities and original deadline under competing takeover", async () => {
    const run = await persistLegacyRemoteRunBinding(db, await seed(), binding);
    expect(await claimLegacyRemoteRunObservation(db, run)).toBeNull();
    const expired = await expire(run);
    expect(await claimLegacyRemoteRunObservation(db, { ...expired, companyId: randomUUID() })).toBeNull();
    const claims = await Promise.all([claimLegacyRemoteRunObservation(db, expired), claimLegacyRemoteRunObservation(db, expired)]);
    const winner = claims.find(Boolean)!;
    expect(claims.filter(Boolean)).toHaveLength(1);
    expect(winner).toMatchObject({ id: run.id, externalRunId: binding.providerRunId,
      controllerBootId: legacyControllerBootId, executionStage: "observing_remote" });
    expect(readLegacyRemoteRunBinding(winner)).toEqual(binding);
  });
  it("fences dependent effects after ownership loss", async () => {
    const run = await persistLegacyRemoteRunBinding(db, await seed(), binding);
    await expire(run);
    let effects = 0;
    await expect(withLegacyObserverOwnership(db, run, async tx => {
      effects++;
      await tx.update(heartbeatRuns).set({ contextSnapshot: { corrupt: true } }).where(eq(heartbeatRuns.id, run.id));
    })).rejects.toThrow("no longer owns");
    expect(effects).toBe(0);
    expect((await saved(run.id)).contextSnapshot).toEqual(run.contextSnapshot);
  });
  it("serializes log effects against takeover using the durable row lock", async () => {
    const run = await persistLegacyRemoteRunBinding(db, await seed(), binding);
    let entered!: () => void, release!: () => void;
    const ready = new Promise<void>(resolve => { entered = resolve; });
    const barrier = new Promise<void>(resolve => { release = resolve; });
    const owned = withLegacyObserverOwnership(db, run, async tx => {
      entered(); await barrier;
      await tx.update(heartbeatRuns).set({ logBytes: 17 }).where(eq(heartbeatRuns.id, run.id));
    });
    await ready;
    let takeoverFinished = false;
    const takeover = expire(run).then(value => { takeoverFinished = true; return value; });
    await new Promise(resolve => setTimeout(resolve, 25));
    expect(takeoverFinished).toBe(false);
    release(); await owned;
    const expired = await takeover;
    expect(expired.logBytes).toBe(17);
    expect(await claimLegacyRemoteRunObservation(db, expired)).not.toBeNull();
  });
  it("never adopts unbound uncertain creates or terminal work", async () => {
    const run = await expire(await seed());
    expect(await claimLegacyRemoteRunObservation(db, run)).toBeNull();
    const accepted = await persistLegacyRemoteRunBinding(db, await seed(), binding);
    await db.update(heartbeatRuns).set({ status: "succeeded" }).where(eq(heartbeatRuns.id, accepted.id));
    expect(await claimLegacyRemoteRunObservation(db, await saved(accepted.id))).toBeNull();
  });
  async function acceptedWithLog(status = "idle") {
    const run = await persistLegacyRemoteRunBinding(db, await seed(), binding);
    const issueId = randomUUID();
    await db.insert(issues).values({ id: issueId, companyId: run.companyId, title: "Checkpoint task",
      status: "in_progress", assigneeAgentId: run.agentId, executionRunId: run.id, checkoutRunId: run.id });
    const store = storeFactory();
    const handle = await store.begin({ companyId: run.companyId, agentId: run.agentId, runId: run.id });
    await store.append(handle, { stream: "stdout", chunk: "original checkpoint", ts: new Date().toISOString(), seq: 4 });
    const prefix = (await store.read(handle)).content;
    await db.update(agents).set({ status, adapterConfig: { apiBaseUrl: "http://127.0.0.1:9", apiKey: "synthetic" } })
      .where(eq(agents.id, run.agentId));
    await db.update(heartbeatRuns).set({ logStore: handle.store, logRef: handle.logRef,
      lastOutputBytes: Buffer.byteLength(prefix), contextSnapshot: { issueId } }).where(eq(heartbeatRuns.id, run.id));
    return { run: await expire(await saved(run.id)), issueId, store, handle, prefix };
  }
  it("startup observes the same accepted job despite fresh-dispatch suppression and projects once", async () => {
    const fixture = await acceptedWithLog();
    adapterExecute.mockImplementation(async context => {
      expect(context.runId).toBe(fixture.run.id);
      expect(context.remoteRunRecovery).toEqual(binding);
      expect(context.observerDetachSignal).toBeDefined();
      await context.onCancellationReady();
      await context.onLog("stdout", "same job completion");
      return { exitCode: 0, signal: null, timedOut: false, provider: "hermes_gateway",
        sessionId: "retained-session", sessionDisplayId: "retained-session", sessionParams: { hermesRunId: binding.providerRunId },
        usage: { inputTokens: 3, outputTokens: 5 }, costUsd: 0.01,
        resultJson: { run_id: binding.providerRunId, status: "completed" } };
    });
    const service = heartbeatService(db, { runtimeEnv: { PAPERCLIP_WORKTREE_RUNTIME: "true" } });
    await service.reapOrphanedRuns({ staleThresholdMs: 0 });
    await service.drainActiveRunExecutions();
    const terminal = await saved(fixture.run.id);
    expect(terminal).toMatchObject({ status: "succeeded", externalRunId: binding.providerRunId, sessionIdAfter: "retained-session" });
    expect(readLegacyRemoteRunBinding(terminal)).toEqual(binding);
    expect((await fixture.store.read(fixture.handle)).content.startsWith(fixture.prefix)).toBe(true);
    const [task] = await db.select().from(issues).where(eq(issues.id, fixture.issueId));
    expect(task.executionRunId).toBeNull(); expect(task.checkoutRunId).toBeNull();
    const [session] = await db.select().from(agentTaskSessions).where(eq(agentTaskSessions.agentId, fixture.run.agentId));
    expect(session).toMatchObject({ lastRunId: fixture.run.id, sessionDisplayId: "retained-session" });
    const [runtime] = await db.select().from(agentRuntimeState).where(eq(agentRuntimeState.agentId, fixture.run.agentId));
    expect(runtime).toMatchObject({ sessionId: "retained-session", totalInputTokens: 3, totalOutputTokens: 5 });
    expect(await db.select().from(costEvents).where(eq(costEvents.heartbeatRunId, fixture.run.id))).toHaveLength(1);
    await service.reapOrphanedRuns({ staleThresholdMs: 0 }); await service.drainActiveRunExecutions();
    expect(adapterExecute).toHaveBeenCalledTimes(1);
    expect(await db.select().from(costEvents).where(eq(costEvents.heartbeatRunId, fixture.run.id))).toHaveLength(1);
  });
  it.each(["paused", "terminated"])("holds accepted work for unavailable agent %s", async status => {
    const fixture = await acceptedWithLog(status);
    const service = heartbeatService(db);
    await service.reapOrphanedRuns({ staleThresholdMs: 0 }); await service.drainActiveRunExecutions();
    const held = await saved(fixture.run.id);
    expect(held).toMatchObject({ status: "running", externalRunId: binding.providerRunId, errorCode: "hermes_gateway_observation_held" });
    expect(adapterExecute).not.toHaveBeenCalled();
    const [task] = await db.select().from(issues).where(eq(issues.id, fixture.issueId));
    expect(task.executionRunId).toBe(fixture.run.id);
    expect((await fixture.store.read(fixture.handle)).content).toBe(fixture.prefix);
  });
  it("holds transport drift without requeue, lock release or changed accepted identity", async () => {
    const fixture = await acceptedWithLog();
    adapterExecute.mockResolvedValue({ exitCode: 1, signal: null, timedOut: false, errorCode: "hermes_gateway_recovery_binding_invalid" });
    const service = heartbeatService(db);
    await service.reapOrphanedRuns({ staleThresholdMs: 0 }); await service.drainActiveRunExecutions();
    expect(await saved(fixture.run.id)).toMatchObject({ status: "running", externalRunId: binding.providerRunId, errorCode: "hermes_gateway_observation_held" });
    const [task] = await db.select().from(issues).where(eq(issues.id, fixture.issueId));
    expect(task.executionRunId).toBe(fixture.run.id);
    expect(readLegacyRemoteRunBinding(await saved(fixture.run.id))).toEqual(binding);
  });

  it("holds a lost accepted binding without a replay or an observer claim", async () => {
    const run = await seed();
    await db.update(heartbeatRuns).set({ executionStage: "dispatching", errorCode: "hermes_gateway_observation_held" }).where(eq(heartbeatRuns.id, run.id));
    const expired = await expire(await saved(run.id));
    const service = heartbeatService(db);
    await service.reapOrphanedRuns({ staleThresholdMs: 0 }); await service.drainActiveRunExecutions();
    expect(await saved(run.id)).toEqual(expired);
    expect(adapterExecute).not.toHaveBeenCalled();
  });
  it("ownership loss prevents log and terminal effects against a successor", async () => {
    const fixture = await acceptedWithLog();
    const successor = randomUUID();
    adapterExecute.mockImplementation(async context => {
      await db.update(heartbeatRuns).set({ controllerBootId: successor,
        controllerLeaseExpiresAt: sql`clock_timestamp() + interval '60 seconds'` }).where(eq(heartbeatRuns.id, fixture.run.id));
      await expect(context.onLog("stdout", "stale output")).rejects.toThrow("no longer owns");
      return { exitCode: 0, signal: null, timedOut: false, resultJson: { status: "completed" } };
    });
    const service = heartbeatService(db);
    await service.reapOrphanedRuns({ staleThresholdMs: 0 }); await service.drainActiveRunExecutions();
    expect(await saved(fixture.run.id)).toMatchObject({ status: "running", controllerBootId: successor });
    expect((await fixture.store.read(fixture.handle)).content).toBe(fixture.prefix);
    expect(await db.select().from(agentTaskSessions).where(eq(agentTaskSessions.agentId, fixture.run.agentId))).toHaveLength(0);
  });
  it("graceful shutdown detaches the observer without cancelling the accepted worker", async () => {
    const fixture = await acceptedWithLog();
    let ready!: () => void;
    const registered = new Promise<void>(resolve => { ready = resolve; });
    let cancelled = false;
    adapterExecute.mockImplementation(async context => {
      await context.onCancellationReady();
      context.signal.addEventListener("abort", () => { cancelled = true; });
      ready();
      await new Promise<void>(resolve => context.observerDetachSignal.addEventListener("abort", () => resolve(), { once: true }));
      return { exitCode: null, signal: null, timedOut: false, remoteRunDetached: true };
    });
    const service = heartbeatService(db);
    await service.reapOrphanedRuns({ staleThresholdMs: 0 }); await registered;
    const drained = await service.drainRunningRunsForShutdown("SIGTERM", new Date(), [fixture.run.id]);
    await service.drainActiveRunExecutions();
    expect(drained.interruptedRunIds).toEqual([]);
    expect(cancelled).toBe(false);
    expect(await saved(fixture.run.id)).toMatchObject({ status: "running", externalRunId: binding.providerRunId });
    const [task] = await db.select().from(issues).where(eq(issues.id, fixture.issueId));
    expect(task.executionRunId).toBe(fixture.run.id);
    expect((await fixture.store.read(fixture.handle)).content).toBe(fixture.prefix);
  });

  it("operator Stop holds an accepted job without a registered observer or native proof", async () => {
    const fixture = await acceptedWithLog("paused");
    const before = await saved(fixture.run.id);
    await expect(heartbeatService(db).cancelRun(fixture.run.id)).rejects.toThrow("termination is unverified");
    expect(await saved(fixture.run.id)).toEqual(before);
    const [task] = await db.select().from(issues).where(eq(issues.id, fixture.issueId));
    expect(task.executionRunId).toBe(fixture.run.id);
    expect((await fixture.store.read(fixture.handle)).content).toBe(fixture.prefix);
    await db.update(agents).set({ status: "idle" }).where(eq(agents.id, fixture.run.agentId));
    adapterExecute.mockImplementation(async context => {
      await context.onCancellationReady();
      return { exitCode: 0, signal: null, timedOut: false, resultJson: { status: "completed" } };
    });
    const successor = heartbeatService(db);
    await successor.reapOrphanedRuns({ staleThresholdMs: 0 });
    await successor.drainActiveRunExecutions();
    expect(await saved(fixture.run.id)).toMatchObject({ status: "succeeded", externalRunId: binding.providerRunId });
  });
  it("operator Stop holds an observed job whose provider stop remains unconfirmed", async () => {
    const fixture = await acceptedWithLog();
    let ready!: () => void;
    const registered = new Promise<void>(resolve => { ready = resolve; });
    adapterExecute.mockImplementation(async context => {
      await context.onCancellationReady(); ready();
      await new Promise<void>(resolve => context.signal.addEventListener("abort", () => resolve(), { once: true }));
      return { exitCode: 1, signal: "SIGTERM", timedOut: false, resultJson: { status: "running" } };
    });
    const service = heartbeatService(db);
    await service.reapOrphanedRuns({ staleThresholdMs: 0 }); await registered;
    await expect(service.cancelRun(fixture.run.id)).rejects.toThrow("termination is unverified");
    await service.drainActiveRunExecutions();
    expect(await saved(fixture.run.id)).toMatchObject({ status: "running", externalRunId: binding.providerRunId });
    expect(readLegacyRemoteRunBinding(await saved(fixture.run.id))).toEqual(binding);
    const [task] = await db.select().from(issues).where(eq(issues.id, fixture.issueId));
    expect(task.executionRunId).toBe(fixture.run.id);
  });

});
