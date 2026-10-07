import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { createDb, agents, heartbeatRuns, issues } from "@paperclipai/db";
import { eq } from "drizzle-orm";
import { afterAll, describe, expect, it, vi } from "vitest";
import { operatorOverviewRoutes } from "../routes/operator-overview.js";
import { errorHandler } from "../middleware/index.js";
import { getHeartbeatRunRuntimeStatus, setHeartbeatRunRuntimeStatus } from "../services/heartbeat-run-runtime-status.js";
import { describeEmbeddedPostgres, routeApp, seedCompanyWithBoardAccess, useEmbeddedPostgres } from "./helpers/route-test-harness.js";

const externalUrl = process.env.PAPERCLIP_OVERVIEW_TEST_DATABASE_URL;
(externalUrl ? describe : describeEmbeddedPostgres)("operator overview pure reads", () => {
  const context = externalUrl ? { db: createDb(externalUrl) } : useEmbeddedPostgres("operator-overview");
  if (externalUrl) afterAll(() => context.db.$client.end());
  it("keeps tenant rows private, separates assignment/execution, bounds pages, and never pads live runs with history", async () => {
    const { db } = context;
    const own = await seedCompanyWithBoardAccess(db, "overview");
    const foreign = await seedCompanyWithBoardAccess(db, "foreign");
    const [assigned] = await db.insert(agents).values({ companyId: own.companyId, name: "Assigned", role: "engineer", adapterConfig: { secret: "private-config" } }).returning();
    const [executor] = await db.insert(agents).values({ companyId: own.companyId, name: "Executor", role: "engineer" }).returning();
    const [outside] = await db.insert(issues).values({ companyId: foreign.companyId, title: "foreign-private-title" }).returning();
    const [task] = await db.insert(issues).values({ companyId: own.companyId, title: "<script>unsafe</script>" + "😀".repeat(300), status: "in_review", assigneeAgentId: assigned.id, description: "private-prompt", executionState: { status: "pending", currentParticipant: { type: "user", userId: own.userId } } }).returning();
    await db.insert(issues).values({ companyId: own.companyId, title: "second", status: "blocked" });
    await db.insert(issues).values({ companyId: own.companyId, title: "hidden-private-title", hiddenAt: new Date() });
    const [run] = await db.insert(heartbeatRuns).values({ companyId: own.companyId, agentId: executor.id, status: "running", contextSnapshot: { issueId: task.id, prompt: "private-run-prompt" } }).returning();
    await db.insert(heartbeatRuns).values({ companyId: own.companyId, agentId: executor.id, status: "succeeded", contextSnapshot: { issueId: outside.id } });
    await db.update(issues).set({ executionRunId: run.id }).where(eq(issues.id, task.id));
    const before = await db.select().from(issues).where(eq(issues.companyId, own.companyId));
    const app = routeApp(db, own.actor, operatorOverviewRoutes);
    const response = await request(app).get(`/api/companies/${own.companyId}/operator-overview?view=work&limit=1`);
    expect(response.status).toBe(200);
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(response.body.hasMore).toBe(true);
    expect(response.body.nextOffset).toBe(1);
    const all = await request(app).get(`/api/companies/${own.companyId}/operator-overview`);
    const observed = all.body.items.find((item: { issueId: string }) => item.issueId === task.id);
    expect(Array.from(observed.title)).toHaveLength(240);
    expect(observed.humanHold).toBe(true);
    expect(observed.status).toBe("in_review");
    expect(observed.assigneeAgentId).toBe(assigned.id);
    expect(observed.executionAgentId).toBe(executor.id);
    expect(all.body.liveRuns).toHaveLength(1);
    expect(all.body.liveRuns[0].issueId).toBe(task.id);
    expect(all.body.recentRuns.find((row: { status: string }) => row.status === "succeeded").issueId).toBe(null);
    expect(JSON.stringify(all.body)).not.toMatch(/private-|contextSnapshot|description|adapterConfig|sessionId/);
    expect(await db.select().from(issues).where(eq(issues.companyId, own.companyId))).toEqual(before);
    await db.update(heartbeatRuns).set({ status: "succeeded" }).where(eq(heartbeatRuns.id, run.id));
    const empty = await request(app).get(`/api/companies/${own.companyId}/operator-overview?view=team`);
    expect(empty.body.liveRuns).toEqual([]);
    expect(empty.body.recentRuns).toHaveLength(2);
    expect(empty.body.items).toHaveLength(2);
    expect(Object.keys(empty.body.items[0]).sort()).toEqual(["agentId", "companyId", "name", "nativeHref", "role", "status"]);
    const deny = await request(app).get(`/api/companies/${foreign.companyId}/operator-overview`);
    expect(deny.status).toBe(403);
    expect(JSON.stringify(deny.body)).not.toContain("foreign-private-title");
  });
});

it("denies absent, agent, board key, and local implicit actors before reading", async () => {
  const select = vi.fn();
  for (const actor of [{ type: "none" }, { type: "agent", companyId: randomUUID() }, { type: "board", source: "board_key", userId: "u" }, { type: "board", source: "local_implicit", userId: "u" }]) {
    const app = express();
    app.use((req, _res, next) => { req.actor = actor as never; next(); });
    app.use(operatorOverviewRoutes({ select } as never)); app.use(errorHandler);
    const response = await request(app).get(`/companies/${randomUUID()}/operator-overview`);
    expect([401, 403]).toContain(response.status);
  }
  expect(select).not.toHaveBeenCalled();
});

it("validates pagination and reports independent source failure without fabricating empty success", async () => {
  const companyId = randomUUID();
  const select = vi.fn(() => {
    const chain = { from: vi.fn().mockReturnThis(), where: vi.fn().mockReturnThis(), innerJoin: vi.fn().mockReturnThis(), orderBy: vi.fn().mockReturnThis(), limit: vi.fn().mockReturnThis(), offset: vi.fn().mockReturnThis(), then: (_resolve: unknown, reject: (error: Error) => void) => reject(new Error("source unavailable")) };
    return chain;
  });
  const app = express();
  app.use((req, _res, next) => { req.actor = { type: "board", source: "session", userId: "u", companyIds: [companyId] } as never; next(); });
  app.use(operatorOverviewRoutes({ select } as never)); app.use(errorHandler);
  for (const suffix of ["limit=0", "limit=101", "offset=-1", "offset=1.2", "view=all", "limit=1&limit=2"]) {
    expect((await request(app).get(`/companies/${companyId}/operator-overview?${suffix}`)).status).toBe(400);
  }
  expect(select).not.toHaveBeenCalled();
  const response = await request(app).get(`/companies/${companyId}/operator-overview`);
  expect(response.body.sourceState).toEqual({ items: "unavailable", runs: "unavailable" });
  expect(response.body.items).toEqual([]);
});

it("reads expired runtime status without pruning observation state", () => {
  const runId = randomUUID();
  const updatedAt = new Date(Date.now() - 100_000);
  setHeartbeatRunRuntimeStatus({ companyId: "company", agentId: "agent", issueId: null, runId, phase: "run_activity", message: "Working", updatedAt });
  expect(getHeartbeatRunRuntimeStatus(runId, { pruneExpired: false })).toBe(null);
  expect(getHeartbeatRunRuntimeStatus(runId, { now: updatedAt })).not.toBe(null);
});
