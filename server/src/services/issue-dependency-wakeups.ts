import { and, eq, gt, gte, inArray, lte, sql } from "drizzle-orm";
import { createHash } from "node:crypto";
import type { Db } from "@paperclipai/db";
import { activityLog, agentWakeupRequests, heartbeatRuns, issues, workspaceOperations } from "@paperclipai/db";

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
// stamps `blockedTransitionAt`. Its `created_at` can be a few milliseconds before
// the stamp (a transaction-scoped `now()` default taken before the application
// clock) or later than it (the route logs after the update commits). Take the
// row nearest to the stamp inside this window.
const BLOCKED_CYCLE_ACTIVITY_BEFORE_MS = 5_000;
const BLOCKED_CYCLE_ACTIVITY_AFTER_MS = 30_000;

type BlockedCycleActivityRow = {
  id: string;
  agentId: string | null;
  runId: string | null;
  createdAt: Date;
};

async function isActivityAuthoredByAssignee(
  db: Db,
  input: { companyId: string; assigneeAgentId: string },
  row: Pick<BlockedCycleActivityRow, "agentId" | "runId">,
): Promise<boolean> {
  if (row.agentId === input.assigneeAgentId) return true;
  if (!row.runId) return false;
  const [run] = await db
    .select({ agentId: heartbeatRuns.agentId })
    .from(heartbeatRuns)
    .where(and(eq(heartbeatRuns.companyId, input.companyId), eq(heartbeatRuns.id, row.runId)))
    .limit(1);
  return run?.agentId === input.assigneeAgentId;
}

/**
 * Latest time at which each blocker became ready for its dependents: the later
 * of its completion and, for a blocker with an execution workspace, the latest
 * successful `workspace_finalize` of that workspace (readiness also waits for
 * that barrier). A missing completion time falls back to `updatedAt`, which can
 * only make a blocker look more recent and so keeps the old wake behaviour.
 */
async function listBlockerReadyAt(
  db: Db,
  companyId: string,
  blockerIssueIds: string[],
): Promise<Map<string, Date> | null> {
  const blockers = await db
    .select({
      id: issues.id,
      executionWorkspaceId: issues.executionWorkspaceId,
      resolvedAt: sql<Date | string | null>`coalesce(${issues.completedAt}, ${issues.updatedAt})`,
    })
    .from(issues)
    .where(and(eq(issues.companyId, companyId), inArray(issues.id, blockerIssueIds)));
  if (blockers.length !== blockerIssueIds.length) return null;

  const readyAt = new Map<string, Date>();
  for (const blocker of blockers) {
    const resolvedAt = blocker.resolvedAt == null ? null : new Date(blocker.resolvedAt);
    if (!resolvedAt || Number.isNaN(resolvedAt.getTime())) return null;
    readyAt.set(blocker.id, resolvedAt);
  }

  const executionWorkspaceIds = [
    ...new Set(blockers.map((blocker) => blocker.executionWorkspaceId).filter((id): id is string => Boolean(id))),
  ];
  if (executionWorkspaceIds.length > 0) {
    const finalizes = await db
      .select({
        executionWorkspaceId: workspaceOperations.executionWorkspaceId,
        finishedAt: workspaceOperations.finishedAt,
        startedAt: workspaceOperations.startedAt,
      })
      .from(workspaceOperations)
      .where(
        and(
          eq(workspaceOperations.companyId, companyId),
          inArray(workspaceOperations.executionWorkspaceId, executionWorkspaceIds),
          eq(workspaceOperations.phase, "workspace_finalize"),
          eq(workspaceOperations.status, "succeeded"),
        ),
      );
    for (const blocker of blockers) {
      for (const finalize of finalizes) {
        if (finalize.executionWorkspaceId !== blocker.executionWorkspaceId) continue;
        const finalizedAt = new Date(finalize.finishedAt ?? finalize.startedAt);
        if (finalizedAt.getTime() > readyAt.get(blocker.id)!.getTime()) readyAt.set(blocker.id, finalizedAt);
      }
    }
  }
  return readyAt;
}

/**
 * True when the dependent's current blocked cycle began with every blocker
 * already ready and the assignee agent itself (or its own run) put the issue
 * back into `blocked`.
 *
 * That transition is not a blockers-resolved event: nothing resolved after the
 * cycle began, and the agent that would be woken is the one that just declared
 * the hold. Each such re-block stamps a new `blockedTransitionAt`, so the
 * cycle-aware state key changes every time and, without this check, a wake for
 * the new key re-activates the agent, which re-blocks again (incident
 * 2026-10-22: 261 runs on one issue). Not matched: a blocker that became ready
 * after the cycle began, a blocker edge change by someone other than the
 * assignee after the cycle began, and a cycle begun by a board user or another
 * agent.
 *
 * Missing evidence returns false so the existing wake behaviour applies, with
 * one exception: a cycle younger than the activity window with no transition
 * row yet is treated as self-authored, because the route logs that row after
 * the update commits and the next backstop pass sees the settled state.
 */
export async function isReadyBlockedCycleSelfAuthored(
  db: Db,
  input: {
    companyId: string;
    dependentIssueId: string;
    assigneeAgentId: string;
    blockerIssueIds: string[];
    blockedTransitionAt?: IssueBlockersResolvedWakeCycleInput;
    now?: Date;
  },
): Promise<boolean> {
  const cycleStart = parseWakeCycleDate(input.blockedTransitionAt);
  const blockerIssueIds = uniqueSortedBlockerIssueIds(input.blockerIssueIds);
  if (!cycleStart || blockerIssueIds.length === 0) return false;

  const readyAt = await listBlockerReadyAt(db, input.companyId, blockerIssueIds);
  if (!readyAt) return false;
  for (const at of readyAt.values()) {
    if (at.getTime() > cycleStart.getTime()) return false;
  }

  const candidates: BlockedCycleActivityRow[] = await db
    .select({
      id: activityLog.id,
      agentId: activityLog.agentId,
      runId: activityLog.runId,
      createdAt: activityLog.createdAt,
    })
    .from(activityLog)
    .where(
      and(
        eq(activityLog.companyId, input.companyId),
        eq(activityLog.entityType, "issue"),
        eq(activityLog.entityId, input.dependentIssueId),
        eq(activityLog.action, "issue.updated"),
        gte(activityLog.createdAt, new Date(cycleStart.getTime() - BLOCKED_CYCLE_ACTIVITY_BEFORE_MS)),
        lte(activityLog.createdAt, new Date(cycleStart.getTime() + BLOCKED_CYCLE_ACTIVITY_AFTER_MS)),
        // Route updates record `changes.status.to`; the native status committer
        // records `toStatus`.
        sql`(${activityLog.details} -> 'changes' -> 'status' ->> 'to' = 'blocked' OR ${activityLog.details} ->> 'toStatus' = 'blocked')`,
      ),
    );
  const transition = candidates
    .map((row) => ({ row, distance: Math.abs(new Date(row.createdAt).getTime() - cycleStart.getTime()) }))
    .sort((a, b) => a.distance - b.distance)[0]?.row;
  if (!transition) {
    const now = input.now ?? new Date();
    return now.getTime() - cycleStart.getTime() < BLOCKED_CYCLE_ACTIVITY_AFTER_MS;
  }
  if (!(await isActivityAuthoredByAssignee(db, input, transition))) return false;

  // A blocker edge change by someone else after the cycle began can make the
  // current blocker set ready without any completion after the cycle start.
  const laterEdgeChanges = await db
    .select({ id: activityLog.id, agentId: activityLog.agentId, runId: activityLog.runId })
    .from(activityLog)
    .where(
      and(
        eq(activityLog.companyId, input.companyId),
        eq(activityLog.entityType, "issue"),
        eq(activityLog.entityId, input.dependentIssueId),
        eq(activityLog.action, "issue.blockers_updated"),
        gt(activityLog.createdAt, new Date(transition.createdAt)),
      ),
    );
  for (const change of laterEdgeChanges) {
    if (!(await isActivityAuthoredByAssignee(db, input, change))) return false;
  }
  return true;
}
