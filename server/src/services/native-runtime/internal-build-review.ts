import { and, eq, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { agents, approvals, issueApprovals, issues } from "@paperclipai/db";
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

export function isInternalBuildSignoffPayload(payload: unknown): boolean {
  return (payload as { kind?: unknown } | null)?.kind === INTERNAL_BUILD_SIGNOFF_KIND;
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
