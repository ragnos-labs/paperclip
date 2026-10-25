import { and, asc, eq, gte, inArray, sql } from "drizzle-orm";
import { createHash } from "node:crypto";
import type { Db } from "@paperclipai/db";
import { activityLog, agentWakeupRequests, heartbeatRuns, issues } from "@paperclipai/db";

export const ISSUE_BLOCKERS_RESOLVED_WAKE_REASON = "issue_blockers_resolved";

// A wake counts as "already delivered or in flight for the current ready state"
// for these statuses. The level-triggered state key uses this full set so that
// one wake for a ready state suppresses further wakes for the SAME state. This
// bounds reconciliation: after one wake, later passes find the completed row.
const IDEMPOTENT_DEPENDENCY_WAKE_STATUSES = [
  "queued",
  "deferred_issue_execution",
  "claimed",
  "completed",
] as const;

// A wake counts as "still in flight" for these statuses. The `completed` status
// is not in this set on purpose. Dependency readiness is level-triggered, so a
// historical completed per-edge wake must never suppress a new wake for the
// current ready state. The dedup uses this set only for the legacy per-edge key
// and for old no-cycle state keys that are still queued after a deploy.
const IN_FLIGHT_DEPENDENCY_WAKE_STATUSES = [
  "queued",
  "deferred_issue_execution",
  "claimed",
] as const;

const IDEMPOTENT_DEPENDENCY_WAKE_STATUS_SET = new Set<string>(IDEMPOTENT_DEPENDENCY_WAKE_STATUSES);
const IN_FLIGHT_DEPENDENCY_WAKE_STATUS_SET = new Set<string>(IN_FLIGHT_DEPENDENCY_WAKE_STATUSES);

export type IssueBlockersResolvedWakeCycleInput = Date | string | null | undefined;

export type IssueBlockersResolvedReadyStateInput = {
  dependentIssueId: string;
  blockerIssueIds: string[];
  blockedTransitionAt?: IssueBlockersResolvedWakeCycleInput;
};

/**
 * Canonical blocked-cycle stamp for the dependency-ready state key.
 * `blockedTransitionAt` is UTC ISO-8601, or `none` when the dependent has no
 * recorded transition into `blocked`.
 */
export function formatIssueBlockersResolvedWakeCycle(
  blockedTransitionAt: IssueBlockersResolvedWakeCycleInput,
): string {
  if (blockedTransitionAt == null || blockedTransitionAt === "") return "none";
  const parsed = blockedTransitionAt instanceof Date
    ? blockedTransitionAt
    : new Date(blockedTransitionAt);
  if (Number.isNaN(parsed.getTime())) return "none";
  return parsed.toISOString();
}

function uniqueSortedBlockerIssueIds(blockerIssueIds: string[]): string[] {
  return [...new Set(blockerIssueIds.filter(Boolean))].sort();
}

function hashBlockerReadyStateDigest(sortedBlockerIssueIds: string[], cycle: string | null): string {
  const payload = cycle == null
    ? sortedBlockerIssueIds.join(",")
    : `${sortedBlockerIssueIds.join(",")}\n${cycle}`;
  return createHash("sha256").update(payload).digest("hex").slice(0, 32);
}

function buildStateKey(dependentIssueId: string, digest: string, blockerCount: number): string {
  return [
    ISSUE_BLOCKERS_RESOLVED_WAKE_REASON,
    "state",
    dependentIssueId,
    String(blockerCount),
    digest,
  ].join(":");
}

/**
 * Legacy per-edge idempotency key. One key encodes a single resolved blocker
 * edge `issue_blockers_resolved:{dependentIssueId}:{resolvedBlockerIssueId}`.
 * The dedup keeps this format only to read wake rows written before the
 * level-triggered state key existed.
 */
export function buildIssueBlockersResolvedWakeIdempotencyKey(input: {
  dependentIssueId: string;
  resolvedBlockerIssueId: string;
}) {
  return [
    ISSUE_BLOCKERS_RESOLVED_WAKE_REASON,
    input.dependentIssueId,
    input.resolvedBlockerIssueId,
  ].join(":");
}

/**
 * Pre-cycle level-triggered key. Rows written before the ready state included
 * `blockedTransitionAt` hashed only the sorted blocker ids. Lookup still reads
 * this format so an in-flight deploy-overlap wake can suppress a duplicate.
 */
export function buildIssueBlockersResolvedWakeStateKeyWithoutCycle(input: {
  dependentIssueId: string;
  blockerIssueIds: string[];
}) {
  const sortedBlockerIssueIds = uniqueSortedBlockerIssueIds(input.blockerIssueIds);
  return buildStateKey(
    input.dependentIssueId,
    hashBlockerReadyStateDigest(sortedBlockerIssueIds, null),
    sortedBlockerIssueIds.length,
  );
}

/**
 * Level-triggered idempotency key. One key encodes the full set of blockers that
 * defines the current dependency-ready state plus the dependent's current
 * blocked cycle (`blockedTransitionAt`, or `none`). Two wakes for the same ready
 * state share the key. A wake from an earlier blocked cycle has a different
 * cycle stamp, so it produces a different key and never suppresses the current
 * wake. All three emit paths (route-time, finalize-time, periodic backstop) use
 * this key so they share one idempotency rule.
 */
export function buildIssueBlockersResolvedWakeStateKey(input: IssueBlockersResolvedReadyStateInput) {
  const sortedBlockerIssueIds = uniqueSortedBlockerIssueIds(input.blockerIssueIds);
  const cycle = formatIssueBlockersResolvedWakeCycle(input.blockedTransitionAt);
  return buildStateKey(
    input.dependentIssueId,
    hashBlockerReadyStateDigest(sortedBlockerIssueIds, cycle),
    sortedBlockerIssueIds.length,
  );
}

function parseWakeCycleDate(blockedTransitionAt: IssueBlockersResolvedWakeCycleInput): Date | null {
  if (blockedTransitionAt == null || blockedTransitionAt === "") return null;
  const parsed = blockedTransitionAt instanceof Date
    ? blockedTransitionAt
    : new Date(blockedTransitionAt);
  if (Number.isNaN(parsed.getTime())) return null;
  return parsed;
}

function wakeCoversIssueBlockersResolvedReadyState(
  wake: {
    status: string;
    idempotencyKey: string | null;
    requestedAt: Date;
  },
  keys: {
    cycleKey: string;
    oldStateKey: string;
    legacyKeys: Set<string>;
    blockedTransitionAt: Date | null;
  },
): boolean {
  const idempotencyKey = wake.idempotencyKey;
  if (!idempotencyKey) return false;

  if (idempotencyKey === keys.cycleKey) {
    return IDEMPOTENT_DEPENDENCY_WAKE_STATUS_SET.has(wake.status);
  }

  if (idempotencyKey === keys.oldStateKey) {
    if (IN_FLIGHT_DEPENDENCY_WAKE_STATUS_SET.has(wake.status)) return true;
    if (wake.status !== "completed") return false;
    if (!keys.blockedTransitionAt) return true;
    return wake.requestedAt.getTime() >= keys.blockedTransitionAt.getTime();
  }

  if (keys.legacyKeys.has(idempotencyKey)) {
    return IN_FLIGHT_DEPENDENCY_WAKE_STATUS_SET.has(wake.status);
  }

  return false;
}

/**
 * Find a wake that already covers the current dependency-ready state of the
 * dependent issue. The check is level-triggered and cycle-aware:
 *
 * - The cycle-aware state key matches a wake in any idempotent status
 *   (including `completed`). This suppresses a duplicate for the SAME ready
 *   state, including the current blocked cycle.
 * - The old no-cycle state key matches in-flight statuses (deploy overlap),
 *   or a `completed` wake whose `requestedAt` is at or after the current
 *   `blockedTransitionAt` (same cycle). A completed old-key wake from a
 *   previous cycle does not suppress.
 * - Each legacy per-edge key matches only a wake that is still in flight.
 *
 * Returns the first matching wake or `null`.
 */
export async function findExistingIssueBlockersResolvedWakeForReadyState(
  db: Db,
  input: {
    companyId: string;
    dependentIssueId: string;
    blockerIssueIds: string[];
    blockedTransitionAt?: IssueBlockersResolvedWakeCycleInput;
  },
) {
  const cycleKey = buildIssueBlockersResolvedWakeStateKey(input);
  const oldStateKey = buildIssueBlockersResolvedWakeStateKeyWithoutCycle(input);
  const legacyKeyList = [
    ...new Set(
      input.blockerIssueIds
        .filter(Boolean)
        .map((resolvedBlockerIssueId) =>
          buildIssueBlockersResolvedWakeIdempotencyKey({
            dependentIssueId: input.dependentIssueId,
            resolvedBlockerIssueId,
          }),
        ),
    ),
  ];
  const lookupKeys = [...new Set([cycleKey, oldStateKey, ...legacyKeyList])];
  const blockedTransitionAt = parseWakeCycleDate(input.blockedTransitionAt);

  const rows = await db
    .select({
      id: agentWakeupRequests.id,
      status: agentWakeupRequests.status,
      idempotencyKey: agentWakeupRequests.idempotencyKey,
      requestedAt: agentWakeupRequests.requestedAt,
    })
    .from(agentWakeupRequests)
    .where(
      and(
        eq(agentWakeupRequests.companyId, input.companyId),
        inArray(agentWakeupRequests.idempotencyKey, lookupKeys),
      ),
    );

  const covering = rows.find((row) =>
    wakeCoversIssueBlockersResolvedReadyState(row, {
      cycleKey,
      oldStateKey,
      legacyKeys: new Set(legacyKeyList),
      blockedTransitionAt,
    }),
  );
  return covering ?? null;
}

// The activity row for a blocked transition is written by the same request that
// stamps `blockedTransitionAt`, so it is at or just after that stamp. A
// transaction-scoped `now()` default can land a few milliseconds before the
// application clock, so allow a small window and take the earliest match.
const BLOCKED_CYCLE_ACTIVITY_CLOCK_SKEW_MS = 5_000;

/**
 * True when the dependent's current blocked cycle began with every blocker
 * already resolved and the assignee agent itself (or its own run) put the issue
 * back into `blocked`.
 *
 * That transition is not a blockers-resolved event: nothing resolved after the
 * cycle began, and the agent that would be woken is the one that just declared
 * the hold. Each such re-block stamps a new `blockedTransitionAt`, so the
 * cycle-aware state key changes every time and, without this check, a wake for
 * the new key re-activates the agent, which re-blocks again (incident
 * 2026-10-22: 261 runs on one issue). A blocker that resolves after the cycle
 * began, or a cycle begun by a board user or another agent, is not matched.
 *
 * Any missing evidence returns false so the existing wake behaviour applies.
 */
export async function isReadyBlockedCycleSelfAuthored(
  db: Db,
  input: {
    companyId: string;
    dependentIssueId: string;
    assigneeAgentId: string;
    blockerIssueIds: string[];
    blockedTransitionAt?: IssueBlockersResolvedWakeCycleInput;
  },
): Promise<boolean> {
  const cycleStart = parseWakeCycleDate(input.blockedTransitionAt);
  const blockerIssueIds = uniqueSortedBlockerIssueIds(input.blockerIssueIds);
  if (!cycleStart || blockerIssueIds.length === 0) return false;

  const blockers = await db
    .select({ id: issues.id, resolvedAt: sql<Date | null>`coalesce(${issues.completedAt}, ${issues.updatedAt})` })
    .from(issues)
    .where(and(eq(issues.companyId, input.companyId), inArray(issues.id, blockerIssueIds)));
  if (blockers.length !== blockerIssueIds.length) return false;
  const resolvedAfterCycleStart = blockers.some((blocker) => {
    const resolvedAt = blocker.resolvedAt == null ? null : new Date(blocker.resolvedAt);
    return !resolvedAt || Number.isNaN(resolvedAt.getTime()) || resolvedAt.getTime() > cycleStart.getTime();
  });
  if (resolvedAfterCycleStart) return false;

  const [transition] = await db
    .select({ agentId: activityLog.agentId, runId: activityLog.runId })
    .from(activityLog)
    .where(
      and(
        eq(activityLog.companyId, input.companyId),
        eq(activityLog.entityType, "issue"),
        eq(activityLog.entityId, input.dependentIssueId),
        eq(activityLog.action, "issue.updated"),
        gte(activityLog.createdAt, new Date(cycleStart.getTime() - BLOCKED_CYCLE_ACTIVITY_CLOCK_SKEW_MS)),
        // Route updates record `changes.status.to`; the native status committer
        // records `toStatus`.
        sql`(${activityLog.details} -> 'changes' -> 'status' ->> 'to' = 'blocked' OR ${activityLog.details} ->> 'toStatus' = 'blocked')`,
      ),
    )
    .orderBy(asc(activityLog.createdAt))
    .limit(1);
  if (!transition) return false;
  if (transition.agentId === input.assigneeAgentId) return true;
  if (!transition.runId) return false;

  const [run] = await db
    .select({ agentId: heartbeatRuns.agentId })
    .from(heartbeatRuns)
    .where(and(eq(heartbeatRuns.companyId, input.companyId), eq(heartbeatRuns.id, transition.runId)))
    .limit(1);
  return run?.agentId === input.assigneeAgentId;
}
