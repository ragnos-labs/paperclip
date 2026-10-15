import { and, eq, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { agents, approvals, issueApprovals, issues, issueThreadInteractions } from "@paperclipai/db";
import { evaluateAgentInvokabilityFromDb } from "../agent-invokability.js";

/**
 * Internal build review lets a sprint prove a native task end to end without
 * waiting on the human review owner. When an instance names an Internal Build
 * Reviewer agent, human review and approval requests go to that agent. Its
 * acceptance completes the task as internal build verification, not human
 * acceptance; the human owner then gets one pending sign-off approval linked
 * to the task. Rejecting that approval reopens the task.
 */
export const INTERNAL_BUILD_REVIEWER_ENV = "PAPERCLIP_INTERNAL_BUILD_REVIEWER_AGENT_ID";
export const INTERNAL_BUILD_REVIEW_LABEL = "Internal build verification";
export const INTERNAL_BUILD_REVIEW_PROMPT_PREFIX =
  "Internal build verification, not human acceptance. ";
export const INTERNAL_BUILD_SIGNOFF_KIND = "internal_build_signoff";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function readInternalBuildReviewerAgentId(
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  const value = env[INTERNAL_BUILD_REVIEWER_ENV]?.trim();
  return value && UUID.test(value) ? value.toLowerCase() : null;
}

/** The configured reviewer, only when it is an invokable agent of this company. */
export async function resolveInternalBuildReviewerAgentId(
  db: Db,
  companyId: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<string | null> {
  const agentId = readInternalBuildReviewerAgentId(env);
  if (!agentId) return null;
  const agent = await db
    .select({
      id: agents.id,
      companyId: agents.companyId,
      name: agents.name,
      reportsTo: agents.reportsTo,
      status: agents.status,
    })
    .from(agents)
    .where(and(eq(agents.id, agentId), eq(agents.companyId, companyId)))
    .then((rows) => rows[0] ?? null);
  if (!agent) return null;
  const invokability = await evaluateAgentInvokabilityFromDb(db, agent);
  return invokability.invokable ? agent.id : null;
}

export function isInternalBuildReviewInteraction(
  interaction: { addresseeAgentId: string | null; payload: unknown },
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  const reviewerAgentId = readInternalBuildReviewerAgentId(env);
  if (!reviewerAgentId || interaction.addresseeAgentId !== reviewerAgentId) return false;
  const payload = interaction.payload as { target?: { label?: unknown } } | null;
  return payload?.target?.label === INTERNAL_BUILD_REVIEW_LABEL;
}

/**
 * True for the wake that asks the configured reviewer to decide a pending
 * internal build review on another agent's task. Dispatch otherwise cancels a
 * queued run for an agent that is not the task's assignee.
 */
export async function isPendingInternalBuildReviewWake(
  db: Db,
  input: { companyId: string; issueId: string; agentId: string; contextSnapshot: unknown },
  env: NodeJS.ProcessEnv = process.env,
): Promise<boolean> {
  const context = (input.contextSnapshot ?? {}) as Record<string, unknown>;
  const interactionId = context.interactionId;
  if (context.wakeReason !== "interaction_pending" || typeof interactionId !== "string"
      || !UUID.test(interactionId)) return false;
  if (await resolveInternalBuildReviewerAgentId(db, input.companyId, env) !== input.agentId) return false;
  const row = await db
    .select({
      status: issueThreadInteractions.status,
      addresseeAgentId: issueThreadInteractions.addresseeAgentId,
      createdByAgentId: issueThreadInteractions.createdByAgentId,
      payload: issueThreadInteractions.payload,
    })
    .from(issueThreadInteractions)
    .where(and(
      eq(issueThreadInteractions.id, interactionId),
      eq(issueThreadInteractions.companyId, input.companyId),
      eq(issueThreadInteractions.issueId, input.issueId),
    ))
    .then((rows) => rows[0] ?? null);
  const target = (row?.payload as { target?: { key?: unknown } } | null)?.target;
  return !!row && row.status === "pending" && row.addresseeAgentId === input.agentId
    && !!row.createdByAgentId && row.createdByAgentId !== input.agentId
    && target?.key === "native_completion_review"
    && isInternalBuildReviewInteraction(row, env);
}

export function isInternalBuildSignoffPayload(payload: unknown): boolean {
  return (payload as { kind?: unknown } | null)?.kind === INTERNAL_BUILD_SIGNOFF_KIND;
}

type IssueWake = (agentId: string, context: Record<string, unknown>) => Promise<unknown>;

async function wakeIssueAssignee(db: Db, agentId: string, context: Record<string, unknown>) {
  // Imported on use: the heartbeat service depends on much of the service graph.
  const { heartbeatService } = await import("../heartbeat.js");
  return heartbeatService(db).wakeup(agentId, {
    source: "automation",
    triggerDetail: "system",
    reason: "issue_status_changed",
    payload: context,
    requestedByActorType: "user",
    requestedByActorId: String(context.rejectedByUserId),
    contextSnapshot: { source: "approval.rejected", ...context },
  });
}

/**
 * A rejected internal build sign-off reopens each linked closed task to `todo`
 * and wakes its assignee with the rejection note. Returns the reopened ids.
 */
export async function reopenTasksForRejectedSignoff(
  db: Db,
  input: {
    approvalId: string;
    companyId: string;
    decisionNote: string | null;
    rejectedByUserId: string;
  },
  wake: IssueWake = (agentId, context) => wakeIssueAssignee(db, agentId, context),
): Promise<string[]> {
  const { issueService } = await import("../issues.js");
  const linked = await db
    .select({ id: issues.id, status: issues.status, assigneeAgentId: issues.assigneeAgentId })
    .from(issueApprovals)
    .innerJoin(issues, eq(issueApprovals.issueId, issues.id))
    .where(and(
      eq(issueApprovals.approvalId, input.approvalId),
      eq(issueApprovals.companyId, input.companyId),
    ));
  const reopened: string[] = [];
  for (const issue of linked) {
    if (issue.status !== "done") continue;
    await issueService(db).update(issue.id, {
      status: "todo",
      actorUserId: input.rejectedByUserId,
    });
    reopened.push(issue.id);
    if (!issue.assigneeAgentId) continue;
    const context = {
      approvalId: input.approvalId,
      approvalStatus: "rejected",
      decisionNote: input.decisionNote,
      rejectedByUserId: input.rejectedByUserId,
      issueId: issue.id,
      taskId: issue.id,
      wakeReason: "internal_build_signoff_rejected",
    };
    try {
      await wake(issue.assigneeAgentId, context);
    } catch {
      // The reopened task stays visible to its assignee's next pickup.
    }
  }
  return reopened;
}

/**
 * Creates the human sign-off approval for an internally accepted review, at
 * most once per review interaction. Returns the approval id, or null when the
 * task has no human review owner.
 */
export async function createInternalBuildSignoffApproval(
  tx: Db,
  input: {
    companyId: string;
    issueId: string;
    reviewInteractionId: string;
    reviewerAgentId: string;
  },
): Promise<string | null> {
  const issue = await tx
    .select({
      title: issues.title,
      identifier: issues.identifier,
      responsibleUserId: issues.responsibleUserId,
      createdByUserId: issues.createdByUserId,
    })
    .from(issues)
    .where(and(eq(issues.id, input.issueId), eq(issues.companyId, input.companyId)))
    .then((rows) => rows[0] ?? null);
  const signoffUserId = issue?.responsibleUserId ?? issue?.createdByUserId ?? null;
  if (!issue || !signoffUserId) return null;

  const existing = await tx
    .select({ id: approvals.id })
    .from(approvals)
    .where(and(
      eq(approvals.companyId, input.companyId),
      sql`${approvals.payload}->>'kind' = ${INTERNAL_BUILD_SIGNOFF_KIND}`,
      sql`${approvals.payload}->>'reviewInteractionId' = ${input.reviewInteractionId}`,
    ))
    .limit(1)
    .then((rows) => rows[0] ?? null);
  if (existing) return existing.id;

  const taskName = issue.identifier ? `${issue.identifier}: ${issue.title}` : issue.title;
  const [approval] = await tx
    .insert(approvals)
    .values({
      companyId: input.companyId,
      type: "request_board_approval",
      requestedByAgentId: null,
      requestedByUserId: null,
      status: "pending",
      payload: {
        kind: INTERNAL_BUILD_SIGNOFF_KIND,
        title: `Sign off internal build: ${taskName}`.slice(0, 500),
        summary:
          "The Internal Build Reviewer accepted this result during the sprint. " +
          "That was internal build verification, not human acceptance.",
        recommendedAction:
          "Approve to sign off. Reject with a note to reopen the task for revision.",
        signoffUserId,
        reviewInteractionId: input.reviewInteractionId,
        reviewerAgentId: input.reviewerAgentId,
      },
    })
    .returning({ id: approvals.id });
  await tx.insert(issueApprovals).values({
    companyId: input.companyId,
    issueId: input.issueId,
    approvalId: approval.id,
    linkedByAgentId: input.reviewerAgentId,
  });
  return approval.id;
}
