import { randomUUID } from "node:crypto";
import { and, eq, gt, lte, sql } from "drizzle-orm";
import { heartbeatRuns, type Db } from "@paperclipai/db";
import type { AdapterRemoteRunBinding } from "@paperclipai/adapter-utils";
import { claimedAdapterType } from "./conversation-continuation.js";

// A boot UUID has meaning across containers; a numeric PID does not.
export const legacyControllerBootId = randomUUID();
export const LEGACY_CONTROLLER_LEASE_MS = 60_000;
export const LEGACY_CONTROLLER_RENEW_MS = 10_000;

type Run = typeof heartbeatRuns.$inferSelect;

export function readLegacyRemoteRunBinding(run: Run): AdapterRemoteRunBinding | null {
  if (run.runtimeMode !== "legacy" || claimedAdapterType(run) !== "hermes_gateway") return null;
  const binding = run.resultJson?.remoteRunBinding;
  if (!binding || typeof binding !== "object" || Array.isArray(binding)) return null;
  const value = binding as Record<string, unknown>;
  if (value.adapterType !== "hermes_gateway" || typeof value.providerRunId !== "string" ||
      !value.providerRunId.trim() || value.providerRunId !== run.externalRunId ||
      typeof value.transportFingerprint !== "string" || !/^[a-f0-9]{64}$/.test(value.transportFingerprint) ||
      (value.deadlineAt !== null && (typeof value.deadlineAt !== "string" || !Number.isFinite(Date.parse(value.deadlineAt))))) return null;
  return {
    adapterType: value.adapterType, providerRunId: value.providerRunId,
    transportFingerprint: value.transportFingerprint, deadlineAt: value.deadlineAt as string | null,
  };
}

/** Use this predicate in the same write as any observer-owned effect. */
export function legacyObserverOwnerCondition(bootId: string) {
  return and(eq(heartbeatRuns.runtimeMode, "legacy"),
    eq(heartbeatRuns.controllerBootId, bootId),
    gt(heartbeatRuns.controllerLeaseExpiresAt, sql`clock_timestamp()`));
}

export async function persistLegacyRemoteRunBinding(db: Db, run: Run, binding: AdapterRemoteRunBinding) {
  const candidate = { ...run, externalRunId: binding?.providerRunId,
    resultJson: { remoteRunBinding: binding } };
  if (!readLegacyRemoteRunBinding(candidate)) {
    throw new Error("Invalid accepted Hermes run binding.");
  }
  // The accepted identity is immutable. A retry of this exact callback may
  // acknowledge the same binding, but may never overwrite another accepted job.
  const [updated] = await db.update(heartbeatRuns).set({
    externalRunId: binding.providerRunId,
    resultJson: sql`coalesce(${heartbeatRuns.resultJson}, '{}'::jsonb) || ${JSON.stringify({ remoteRunBinding: binding })}::jsonb`,
    updatedAt: new Date(),
  }).where(and(eq(heartbeatRuns.id, run.id), eq(heartbeatRuns.companyId, run.companyId),
    eq(heartbeatRuns.status, "running"), legacyObserverOwnerCondition(legacyControllerBootId),
    sql`(${heartbeatRuns.resultJson}->'remoteRunBinding' is null or ${heartbeatRuns.resultJson}->'remoteRunBinding' = ${JSON.stringify(binding)}::jsonb)`,
    sql`(${heartbeatRuns.externalRunId} is null or ${heartbeatRuns.externalRunId} = ${binding.providerRunId})`,
  )).returning();
  if (!updated || !readLegacyRemoteRunBinding(updated)) throw new Error("Remote run binding lost current controller ownership.");
  return updated;
}

/** Expiry transfers observation only. This is never permission to create work. */
export async function claimLegacyRemoteRunObservation(db: Db, run: Run): Promise<Run | null> {
  const binding = readLegacyRemoteRunBinding(run);
  if (!binding || !run.controllerBootId || run.status !== "running") return null;
  const [claimed] = await db.update(heartbeatRuns).set({
    controllerBootId: legacyControllerBootId,
    controllerLeaseExpiresAt: sql`clock_timestamp() + interval '60 seconds'`,
    executionStage: "observing_remote",
    updatedAt: new Date(),
  }).where(and(eq(heartbeatRuns.id, run.id), eq(heartbeatRuns.companyId, run.companyId),
    eq(heartbeatRuns.runtimeMode, "legacy"), eq(heartbeatRuns.status, "running"),
    eq(heartbeatRuns.controllerBootId, run.controllerBootId),
    lte(heartbeatRuns.controllerLeaseExpiresAt, sql`clock_timestamp()`),
    eq(heartbeatRuns.externalRunId, binding.providerRunId),
    sql`${heartbeatRuns.resultJson}->'remoteRunBinding' = ${JSON.stringify(binding)}::jsonb`,
  )).returning();
  return claimed ?? null;
}

/** Call only after this observer settled, leaving the remote job untouched. */
export async function releaseLegacyRemoteRunObservation(db: Db, run: Run) {
  await db.update(heartbeatRuns).set({
    controllerLeaseExpiresAt: sql`clock_timestamp()`, updatedAt: new Date(),
  }).where(and(eq(heartbeatRuns.id, run.id), eq(heartbeatRuns.companyId, run.companyId),
    eq(heartbeatRuns.status, "running"), eq(heartbeatRuns.controllerBootId, legacyControllerBootId),
    eq(heartbeatRuns.runtimeMode, "legacy")));
}

/** Commit these fields in the same UPDATE that claims a queued run. */
export function legacyControllerClaim(runtimeMode: string) {
  if (runtimeMode === "native") return {};
  return {
    controllerBootId: legacyControllerBootId,
    controllerLeaseExpiresAt: sql`clock_timestamp() + interval '60 seconds'`,
    executionStage: "preparing",
  };
}

export async function renewLegacyControllerLease(
  db: Db,
  run: Pick<Run, "id" | "companyId" | "controllerBootId">,
  stage?: "dispatching",
): Promise<boolean> {
  const [renewed] = await db.update(heartbeatRuns).set({
    controllerLeaseExpiresAt: sql`clock_timestamp() + interval '60 seconds'`,
    ...(stage ? { executionStage: stage } : {}),
  }).where(and(
    eq(heartbeatRuns.id, run.id), eq(heartbeatRuns.companyId, run.companyId),
    eq(heartbeatRuns.runtimeMode, "legacy"), eq(heartbeatRuns.status, "running"),
    eq(heartbeatRuns.controllerBootId, legacyControllerBootId),
    gt(heartbeatRuns.controllerLeaseExpiresAt, sql`clock_timestamp()`),
  )).returning({ id: heartbeatRuns.id });
  return Boolean(renewed);
}

export async function hasLiveLegacyController(db: Db, run: Run): Promise<boolean> {
  if (run.runtimeMode === "native" || !run.controllerBootId) return false;
  const [owner] = await db.select({ id: heartbeatRuns.id }).from(heartbeatRuns).where(and(
    eq(heartbeatRuns.id, run.id), eq(heartbeatRuns.companyId, run.companyId),
    eq(heartbeatRuns.status, "running"),
    gt(heartbeatRuns.controllerLeaseExpiresAt, sql`clock_timestamp()`),
  ));
  return Boolean(owner);
}

/** Atomically revoke an expired controller. Renewal and revocation serialize on
 * the run row. Expiry permits cleanup, never dispatch of a replacement agent. */
export async function revokeExpiredLegacyController(db: Db, run: Run): Promise<boolean> {
  if (run.runtimeMode === "native" || !run.controllerBootId) return true;
  const [revoked] = await db.update(heartbeatRuns).set({
    controllerBootId: randomUUID(),
    controllerLeaseExpiresAt: sql`clock_timestamp() + interval '60 seconds'`,
  }).where(and(
    eq(heartbeatRuns.id, run.id), eq(heartbeatRuns.companyId, run.companyId),
    eq(heartbeatRuns.status, "running"),
    eq(heartbeatRuns.controllerBootId, run.controllerBootId),
    lte(heartbeatRuns.controllerLeaseExpiresAt, sql`clock_timestamp()`),
  )).returning({ id: heartbeatRuns.id });
  return Boolean(revoked);
}

/** Abort the adapter if the controller cannot renew. Bound each check by the
 * lease duration even when the database connection never settles. */
export function watchLegacyControllerLease(db: Db, run: Run, controller: AbortController) {
  if (run.runtimeMode === "native" || !run.controllerBootId) {
    return { stop() {}, async assertOwned(_stage?: "dispatching") {} };
  }
  let stopped = false;
  let pending = false;
  const lost = () => { if (!stopped) controller.abort(new Error("Legacy controller lease lost")); };
  let deadline = setTimeout(lost, Math.max(0,
    (run.controllerLeaseExpiresAt?.getTime() ?? 0) - Date.now()));
  deadline.unref();
  const assertOwned = async (stage?: "dispatching") => {
    if (stopped) return;
    controller.signal.throwIfAborted();
    const startedAt = Date.now();
    let onAbort!: () => void;
    const aborted = new Promise<never>((_, reject) => {
      onAbort = () => reject(controller.signal.reason);
      controller.signal.addEventListener("abort", onAbort, { once: true });
    });
    let renewed: boolean;
    try {
      renewed = await Promise.race([renewLegacyControllerLease(db, run, stage), aborted]);
    } finally {
      controller.signal.removeEventListener("abort", onAbort);
    }
    if (stopped) return;
    if (!renewed) {
      lost();
      controller.signal.throwIfAborted();
    }
    controller.signal.throwIfAborted();
    if (!stopped) {
      clearTimeout(deadline);
      deadline = setTimeout(lost, Math.max(0, LEGACY_CONTROLLER_LEASE_MS - (Date.now() - startedAt)));
      deadline.unref();
    }
  };
  const timer = setInterval(() => {
    if (pending || stopped) return;
    pending = true;
    void assertOwned().catch(lost).finally(() => { pending = false; });
  }, LEGACY_CONTROLLER_RENEW_MS);
  timer.unref();
  return { assertOwned, stop() { stopped = true; clearInterval(timer); clearTimeout(deadline); } };
}

/** Row lock serializes filesystem effects with lease takeover. Never use an
 * in-memory ownership check as permission for a durable write. */
export async function withLegacyObserverOwnership<T>(
  db: Db, run: Pick<Run, "id" | "companyId">,
  effect: (tx: Db) => Promise<T>,
): Promise<T> {
  return db.transaction(async tx => {
    const [owned] = await tx.select({ id: heartbeatRuns.id }).from(heartbeatRuns)
      .where(and(eq(heartbeatRuns.id, run.id), eq(heartbeatRuns.companyId, run.companyId),
        eq(heartbeatRuns.status, "running"), legacyObserverOwnerCondition(legacyControllerBootId)))
      .for("update");
    if (!owned) throw new Error("Remote observer no longer owns this run");
    return effect(tx as unknown as Db);
  });
}
