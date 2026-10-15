import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  agents,
  approvals,
  companies,
  completionContracts,
  createDb,
  heartbeatRuns,
  issueApprovals,
  issues,
  issueThreadInteractions,
  nativeRunResults,
  statusDecisions,
  workAssessments,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "../../__tests__/helpers/embedded-postgres.js";
import { approvalService } from "../approvals.js";
import { issueThreadInteractionService } from "../issue-thread-interactions.js";
import {
  INTERNAL_BUILD_REVIEWER_ENV,
  INTERNAL_BUILD_REVIEW_LABEL,
  INTERNAL_BUILD_SIGNOFF_KIND,
  createInternalBuildSignoffApproval,
  reopenTasksForRejectedSignoff,
  isInternalBuildReviewInteraction,
  readInternalBuildReviewerAgentId,
  resolveInternalBuildReviewerAgentId,
} from "./internal-build-review.js";

const completionReviewTarget = "native_completion_review";

describe("internal build reviewer configuration", () => {
  it("reads only a UUID agent id", () => {
    const id = randomUUID();
    expect(readInternalBuildReviewerAgentId({ [INTERNAL_BUILD_REVIEWER_ENV]: ` ${id} ` })).toBe(id);
    expect(readInternalBuildReviewerAgentId({ [INTERNAL_BUILD_REVIEWER_ENV]: "reviewer" })).toBeNull();
    expect(readInternalBuildReviewerAgentId({})).toBeNull();
  });

  it("recognizes only labeled cards addressed to the configured reviewer", () => {
    const id = randomUUID();
    const env = { [INTERNAL_BUILD_REVIEWER_ENV]: id };
    const payload = { target: { label: INTERNAL_BUILD_REVIEW_LABEL } };
    expect(isInternalBuildReviewInteraction({ addresseeAgentId: id, payload }, env)).toBe(true);
    expect(isInternalBuildReviewInteraction({ addresseeAgentId: randomUUID(), payload }, env)).toBe(false);
    expect(isInternalBuildReviewInteraction(
      { addresseeAgentId: id, payload: { target: { label: "Completion decision" } } }, env,
    )).toBe(false);
  });
});

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

describeEmbeddedPostgres("internal build review sign-off", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  const previousEnv = process.env[INTERNAL_BUILD_REVIEWER_ENV];

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("internal-build-review-");
    db = createDb(tempDb.connectionString);
  }, 30_000);

  afterEach(() => {
    if (previousEnv === undefined) delete process.env[INTERNAL_BUILD_REVIEWER_ENV];
    else process.env[INTERNAL_BUILD_REVIEWER_ENV] = previousEnv;
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedInternalReview(options: { responsibleUserId?: string | null } = {}) {
    const companyId = randomUUID();
    const workerId = randomUUID();
    const reviewerId = randomUUID();
    const issueId = randomUUID();
    const sourceRunId = randomUUID();
    const reviewRunId = randomUUID();
    const decisionId = randomUUID();
    const interactionId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Internal build review",
      issuePrefix: `I${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
    });
    await db.insert(agents).values([
      { id: workerId, companyId, name: "Chief of Staff", adapterType: "codex_local", status: "idle" },
      { id: reviewerId, companyId, name: "Internal Build Reviewer", adapterType: "codex_local", status: "running" },
    ]);
    await db.insert(heartbeatRuns).values([
      { id: sourceRunId, companyId, agentId: workerId, status: "succeeded", runtimeMode: "native", nativeIssueId: issueId },
      {
        id: reviewRunId, companyId, agentId: reviewerId, status: "running", runtimeMode: "native",
        nativeIssueId: issueId,
        contextSnapshot: { issueId, nativeReviewInteractionId: interactionId, nativeReviewDecisionId: decisionId },
      },
    ]);
    await db.insert(issues).values({
      id: issueId, companyId, title: "Summarize the source", status: "in_review", statusVersion: 1,
      lastStatusDecisionId: decisionId, assigneeAgentId: workerId, executionRunId: reviewRunId,
      responsibleUserId: options.responsibleUserId === undefined ? "hunter" : options.responsibleUserId,
    });
    const contractId = randomUUID();
    const resultId = randomUUID();
    const assessmentId = randomUUID();
    await db.insert(completionContracts).values({ id: contractId, companyId, issueId, revision: 1, schemaVersion: "1", policyVersion: "test", risk: "low", completionAuthority: "agent_claim_policy", incompleteCriteriaPolicy: "block", contractJson: {}, canonicalSha256: randomUUID(), createdByActorType: "agent", createdByActorId: workerId });
    await db.update(heartbeatRuns).set({ completionContractId: contractId }).where(eq(heartbeatRuns.id, sourceRunId));
    await db.insert(nativeRunResults).values({ id: resultId, companyId, issueId, runId: sourceRunId, completionContractId: contractId, serverFingerprint: randomUUID(), schemaStatus: "valid", resultJson: {}, canonicalSha256: randomUUID() });
    await db.insert(workAssessments).values({ id: assessmentId, companyId, issueId, runId: sourceRunId, contractId, resultId, triggerKind: "test", triggerActorCompanyId: companyId, priorIssueStatus: "in_progress", priorStatusVersion: 0, policyVersion: "test", assessmentJson: {}, inputDigest: randomUUID() });
    await db.insert(statusDecisions).values({
      id: decisionId, companyId, issueId, runId: sourceRunId, assessmentId, decisionVersion: 1,
      policyVersion: "test", fromStatus: "in_progress", toStatus: "in_review", reasonCode: "actionable_attention_pending",
      decisionJson: { projectedStatusVersion: 1 }, decisionDigest: randomUUID(), applicationState: "applied",
    });
    await db.insert(issueThreadInteractions).values({
      id: interactionId, companyId, issueId, kind: "request_confirmation", status: "pending",
      continuationPolicy: "wake_assignee", requestedResolverPolicy: "anyone", effectiveResolverPolicy: "anyone",
      resolverPolicyProvenance: "inherited", sourceRunId, addresseeAgentId: reviewerId,
      payload: {
        version: 1,
        prompt: "Internal build verification, not human acceptance. Accept results",
        target: { type: "custom", key: completionReviewTarget, revisionId: decisionId, label: INTERNAL_BUILD_REVIEW_LABEL },
      },
    });
    return { companyId, workerId, reviewerId, issueId, reviewRunId, interactionId };
  }

  it("completes the task and opens one human sign-off approval when the internal reviewer accepts", async () => {
    const seed = await seedInternalReview();
    process.env[INTERNAL_BUILD_REVIEWER_ENV] = seed.reviewerId;
    expect(await resolveInternalBuildReviewerAgentId(db, seed.companyId)).toBe(seed.reviewerId);

    const [issue] = await db.select().from(issues).where(eq(issues.id, seed.issueId));
    await issueThreadInteractionService(db).acceptInteraction(
      { id: issue.id, companyId: issue.companyId, projectId: issue.projectId, goalId: issue.goalId, status: issue.status },
      seed.interactionId,
      {},
      { agentId: seed.reviewerId, runId: seed.reviewRunId },
    );

    const [completed] = await db.select().from(issues).where(eq(issues.id, seed.issueId));
    expect(completed.status).toBe("done");
    const links = await db.select().from(issueApprovals).where(eq(issueApprovals.issueId, seed.issueId));
    expect(links).toHaveLength(1);
    const [approval] = await db.select().from(approvals).where(eq(approvals.id, links[0].approvalId));
    expect(approval).toMatchObject({
      type: "request_board_approval",
      status: "pending",
      requestedByAgentId: null,
      payload: expect.objectContaining({
        kind: INTERNAL_BUILD_SIGNOFF_KIND,
        signoffUserId: "hunter",
        reviewInteractionId: seed.interactionId,
      }),
    });

    // Replays reuse the same approval.
    const again = await createInternalBuildSignoffApproval(db, {
      companyId: seed.companyId, issueId: seed.issueId,
      reviewInteractionId: seed.interactionId, reviewerAgentId: seed.reviewerId,
    });
    expect(again).toBe(approval.id);
  });

  it("opens no sign-off when the reviewer is not configured", async () => {
    const seed = await seedInternalReview();
    delete process.env[INTERNAL_BUILD_REVIEWER_ENV];
    expect(await resolveInternalBuildReviewerAgentId(db, seed.companyId)).toBeNull();
    const [issue] = await db.select().from(issues).where(eq(issues.id, seed.issueId));
    await issueThreadInteractionService(db).acceptInteraction(
      { id: issue.id, companyId: issue.companyId, projectId: issue.projectId, goalId: issue.goalId, status: issue.status },
      seed.interactionId,
      {},
      { agentId: seed.reviewerId, runId: seed.reviewRunId },
    );
    const links = await db.select().from(issueApprovals).where(eq(issueApprovals.issueId, seed.issueId));
    expect(links).toHaveLength(0);
  });

  it("skips the sign-off when the task has no human review owner", async () => {
    const seed = await seedInternalReview({ responsibleUserId: null });
    const created = await createInternalBuildSignoffApproval(db, {
      companyId: seed.companyId, issueId: seed.issueId,
      reviewInteractionId: seed.interactionId, reviewerAgentId: seed.reviewerId,
    });
    expect(created).toBeNull();
  });

  it("ignores a configured reviewer from another company", async () => {
    const seed = await seedInternalReview();
    const other = await seedInternalReview();
    process.env[INTERNAL_BUILD_REVIEWER_ENV] = other.reviewerId;
    expect(await resolveInternalBuildReviewerAgentId(db, seed.companyId)).toBeNull();
  });
  it("reopens the task when the human rejects the sign-off", async () => {
    const seed = await seedInternalReview();
    const approvalId = await createInternalBuildSignoffApproval(db, {
      companyId: seed.companyId, issueId: seed.issueId,
      reviewInteractionId: seed.interactionId, reviewerAgentId: seed.reviewerId,
    });
    await db.update(issues).set({ status: "done" }).where(eq(issues.id, seed.issueId));
    const wakes: Array<[string, Record<string, unknown>]> = [];
    const reopened = await reopenTasksForRejectedSignoff(db, {
      approvalId: approvalId!, companyId: seed.companyId,
      decisionNote: "Missing the Q3 numbers", rejectedByUserId: "hunter",
    }, async (agentId, context) => { wakes.push([agentId, context]); });
    expect(reopened).toEqual([seed.issueId]);
    const [issue] = await db.select().from(issues).where(eq(issues.id, seed.issueId));
    expect(issue.status).toBe("todo");
    expect(wakes).toEqual([[seed.workerId, expect.objectContaining({
      issueId: seed.issueId, decisionNote: "Missing the Q3 numbers", wakeReason: "internal_build_signoff_rejected",
    })]]);
  });

  it("rejecting a sign-off through the approval service reopens the task; other approvals do not", async () => {
    const seed = await seedInternalReview();
    const approvalId = await createInternalBuildSignoffApproval(db, {
      companyId: seed.companyId, issueId: seed.issueId,
      reviewInteractionId: seed.interactionId, reviewerAgentId: seed.reviewerId,
    });
    await db.update(issues).set({ status: "done", assigneeAgentId: null }).where(eq(issues.id, seed.issueId));
    const { applied } = await approvalService(db).reject(approvalId!, "hunter", "Redo it");
    expect(applied).toBe(true);
    const [reopened] = await db.select().from(issues).where(eq(issues.id, seed.issueId));
    expect(reopened.status).toBe("todo");

    const other = await seedInternalReview();
    const [ordinary] = await db.insert(approvals).values({
      companyId: other.companyId, type: "request_board_approval", status: "pending",
      payload: { title: "Approve hosting spend" },
    }).returning();
    await db.insert(issueApprovals).values({ companyId: other.companyId, issueId: other.issueId, approvalId: ordinary.id });
    await db.update(issues).set({ status: "done" }).where(eq(issues.id, other.issueId));
    await approvalService(db).reject(ordinary.id, "hunter", "not now");
    const [untouched] = await db.select().from(issues).where(eq(issues.id, other.issueId));
    expect(untouched.status).toBe("done");
  });
});
