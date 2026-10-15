import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  agents,
  companies,
  createDb,
  heartbeatRuns,
  issueApprovals,
  issues,
  issueThreadInteractions,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

const wakeup = vi.hoisted(() => vi.fn(async () => ({ id: "wake" })));
vi.mock("../services/heartbeat.js", () => ({ heartbeatService: () => ({ wakeup }) }));

const { internalBuildReviewRoutes } = await import("../routes/internal-build-reviews.js");
const { errorHandler } = await import("../middleware/index.js");
const { INTERNAL_BUILD_REVIEWER_ENV, INTERNAL_BUILD_REVIEW_LABEL } = await import(
  "../services/native-runtime/internal-build-review.js"
);

const support = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = support.supported ? describe : describe.skip;
const completionReviewTarget = "native_completion_review";

describeEmbeddedPostgres("internal build review routes", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  const previousEnv = process.env[INTERNAL_BUILD_REVIEWER_ENV];

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("internal-build-review-routes-");
    db = createDb(tempDb.connectionString);
  }, 30_000);

  afterEach(() => {
    wakeup.mockClear();
    if (previousEnv === undefined) delete process.env[INTERNAL_BUILD_REVIEWER_ENV];
    else process.env[INTERNAL_BUILD_REVIEWER_ENV] = previousEnv;
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seed() {
    const companyId = randomUUID();
    const workerId = randomUUID();
    const reviewerId = randomUUID();
    const issueId = randomUUID();
    const workerRunId = randomUUID();
    const reviewRunId = randomUUID();
    const interactionId = randomUUID();
    await db.insert(companies).values({
      id: companyId, name: "Internal review routes",
      issuePrefix: `R${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
    });
    await db.insert(agents).values([
      { id: workerId, companyId, name: "Communications Writer", adapterType: "hermes_gateway", status: "idle" },
      { id: reviewerId, companyId, name: "Quality Reviewer", adapterType: "hermes_gateway", status: "running" },
    ]);
    await db.insert(heartbeatRuns).values([
      { id: workerRunId, companyId, agentId: workerId, status: "succeeded" },
      { id: reviewRunId, companyId, agentId: reviewerId, status: "running" },
    ]);
    await db.insert(issues).values({
      id: issueId, companyId, title: "Write the note", description: "Two sentences.", status: "in_review",
      assigneeAgentId: workerId, responsibleUserId: "hunter",
    });
    await db.insert(issueThreadInteractions).values({
      id: interactionId, companyId, issueId, kind: "request_confirmation", status: "pending",
      continuationPolicy: "none", requestedResolverPolicy: "anyone", effectiveResolverPolicy: "anyone",
      resolverPolicyProvenance: "explicit", sourceRunId: workerRunId, createdByAgentId: workerId,
      addresseeAgentId: reviewerId,
      payload: {
        version: 1, prompt: "Internal build verification, not human acceptance.", detailsMarkdown: "The note.",
        target: { type: "custom", key: completionReviewTarget, revisionId: randomUUID(), label: INTERNAL_BUILD_REVIEW_LABEL },
      },
    });
    process.env[INTERNAL_BUILD_REVIEWER_ENV] = reviewerId;
    return { companyId, workerId, reviewerId, issueId, reviewRunId, interactionId };
  }

  function app(actor: Record<string, unknown>) {
    const server = express();
    server.use(express.json());
    server.use((req, _res, next) => { (req as any).actor = actor; next(); });
    server.use("/api", internalBuildReviewRoutes(db));
    server.use(errorHandler);
    return server;
  }

  it("lists, reads and accepts the reviewer's card, completing the task and opening the sign-off", async () => {
    const s = await seed();
    const reviewer = app({ type: "agent", agentId: s.reviewerId, companyId: s.companyId, runId: s.reviewRunId });
    const list = await request(reviewer).get("/api/internal-build-reviews");
    expect(list.status, JSON.stringify(list.body)).toBe(200);
    expect(list.body).toEqual([expect.objectContaining({ interactionId: s.interactionId, results: "The note." })]);
    const read = await request(reviewer).get(`/api/internal-build-reviews/${s.interactionId}`);
    expect(read.body).toMatchObject({ title: "Write the note", status: "pending" });
    const accepted = await request(reviewer).post(`/api/internal-build-reviews/${s.interactionId}/accept`).send({});
    expect(accepted.status, JSON.stringify(accepted.body)).toBe(200);
    expect(accepted.body.status).toBe("accepted");
    const [issue] = await db.select().from(issues).where(eq(issues.id, s.issueId));
    expect(issue.status).toBe("done");
    expect(await db.select().from(issueApprovals).where(eq(issueApprovals.issueId, s.issueId))).toHaveLength(1);
  });

  it("rejects with a reason, reopens the task and wakes the worker", async () => {
    const s = await seed();
    const reviewer = app({ type: "agent", agentId: s.reviewerId, companyId: s.companyId, runId: s.reviewRunId });
    const missing = await request(reviewer).post(`/api/internal-build-reviews/${s.interactionId}/reject`).send({});
    expect(missing.status).toBe(422);
    const rejected = await request(reviewer).post(`/api/internal-build-reviews/${s.interactionId}/reject`)
      .send({ reason: "Name the Q3 numbers." });
    expect(rejected.status, JSON.stringify(rejected.body)).toBe(200);
    const [issue] = await db.select().from(issues).where(eq(issues.id, s.issueId));
    expect(issue.status).toBe("todo");
    expect(wakeup).toHaveBeenCalledWith(s.workerId, expect.objectContaining({
      payload: expect.objectContaining({ reviewerReason: "Name the Q3 numbers." }),
    }));
  });

  it("refuses other agents, unattributed decisions and unconfigured reviewers", async () => {
    const s = await seed();
    const worker = app({ type: "agent", agentId: s.workerId, companyId: s.companyId, runId: s.reviewRunId });
    expect((await request(worker).get("/api/internal-build-reviews")).status).toBe(403);
    const noRun = app({ type: "agent", agentId: s.reviewerId, companyId: s.companyId });
    expect((await request(noRun).post(`/api/internal-build-reviews/${s.interactionId}/accept`).send({})).status).toBe(422);
    delete process.env[INTERNAL_BUILD_REVIEWER_ENV];
    const reviewer = app({ type: "agent", agentId: s.reviewerId, companyId: s.companyId, runId: s.reviewRunId });
    expect((await request(reviewer).get(`/api/internal-build-reviews/${s.interactionId}`)).status).toBe(403);
    const [issue] = await db.select().from(issues).where(eq(issues.id, s.issueId));
    expect(issue.status).toBe("in_review");
  });
});
