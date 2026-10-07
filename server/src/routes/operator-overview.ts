import { getHeartbeatRunRuntimeStatus } from "../services/heartbeat-run-runtime-status.js";
import { Router } from "express";
import { agents, approvals, companyMemberships, projects, heartbeatRuns, issueApprovals, issues, type Db } from "@paperclipai/db";
import { and, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import { badRequest, forbidden } from "../errors.js";
import { assertAuthenticated, assertBoard, assertCompanyAccess } from "./authz.js";
import type { OperatorOverview, OperatorRun, OperatorWorkItem } from "@paperclipai/shared";

function integer(value: unknown, fallback: number, max: number) {
  if (value === undefined) return fallback;
  if (typeof value !== "string" || !/^(0|[1-9][0-9]*)$/.test(value)) throw badRequest("Invalid pagination");
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed > max) throw badRequest("Invalid pagination");
  return parsed;
}
const text = (value: string, limit: number) => Array.from(value).slice(0, limit).join("");

export function operatorOverviewRoutes(db: Db) {
  const router = Router();
  router.get("/companies/:companyId/operator-overview", async (req, res) => {
    assertAuthenticated(req);
    assertBoard(req);
    if (req.actor.source !== "session" || !req.actor.userId) throw forbidden("Human session required");
    const companyId = req.params.companyId as string;
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(companyId)) throw badRequest("Invalid company ID");
    assertCompanyAccess(req, companyId);
    const view = req.query.view ?? "work";
    if (view !== "work" && view !== "team") throw badRequest("Invalid overview view");
    const limit = integer(req.query.limit, 50, 100);
    const offset = integer(req.query.offset, 0, 1_000_000);
    if (limit < 1) throw badRequest("Invalid pagination");
    res.setHeader("Cache-Control", "no-store");

    // Direct SELECTs deliberately avoid the issue GET's source-recovery writes.
    const itemRead = view === "work"
      ? db.select({
          companyId: issues.companyId, issueId: issues.id, identifier: issues.identifier, title: issues.title,
          status: issues.status, priority: issues.priority, parentId: sql<string | null>`(select id from ${issues} parent where parent.id = ${issues.parentId} and parent.company_id = ${companyId} and parent.hidden_at is null)`,
          projectId: sql<string | null>`(select id from ${projects} where id = ${issues.projectId} and company_id = ${companyId})`,
          assigneeAgentId: sql<string | null>`(select id from ${agents} where id = ${issues.assigneeAgentId} and company_id = ${companyId})`,
          assigneeUserId: sql<string | null>`(select principal_id from ${companyMemberships} where company_id = ${companyId} and principal_type = 'user' and principal_id = ${issues.assigneeUserId} and status = 'active' limit 1)`, updatedAt: issues.updatedAt,
          executionRunId: sql<string | null>`(select r.id from ${heartbeatRuns} r join ${agents} a on a.id = r.agent_id and a.company_id = ${companyId} where r.id = ${issues.executionRunId} and r.company_id = ${companyId})`,
          checkoutRunId: sql<string | null>`(select r.id from ${heartbeatRuns} r join ${agents} a on a.id = r.agent_id and a.company_id = ${companyId} where r.id = ${issues.checkoutRunId} and r.company_id = ${companyId})`,
          humanHold: sql<boolean>`(${issues.executionState}->>'status' = 'pending' and ${issues.executionState}->'currentParticipant'->>'type' = 'user' and exists (select 1 from ${companyMemberships} where company_id = ${companyId} and principal_type = 'user' and principal_id = ${issues.executionState}->'currentParticipant'->>'userId' and status = 'active')) or exists (select 1 from ${issueApprovals} ia join ${approvals} a on a.id = ia.approval_id and a.company_id = ia.company_id where ia.company_id = ${companyId} and ia.issue_id = ${issues.id} and a.status = 'pending')`,
          executionAgentId: sql<string | null>`(select r.agent_id from ${heartbeatRuns} r join ${agents} a on a.id = r.agent_id and a.company_id = ${companyId} where r.id = ${issues.executionRunId} and r.company_id = ${companyId})`,
        }).from(issues).where(and(eq(issues.companyId, companyId), isNull(issues.hiddenAt)))
          .orderBy(desc(issues.updatedAt), issues.id).limit(limit + 1).offset(offset)
      : db.select({ companyId: agents.companyId, agentId: agents.id, name: agents.name, role: agents.role, status: agents.status })
          .from(agents).where(eq(agents.companyId, companyId)).orderBy(agents.name, agents.id).limit(limit + 1).offset(offset);

    const runColumns = {
      companyId: heartbeatRuns.companyId, runId: heartbeatRuns.id, agentId: heartbeatRuns.agentId,
      status: heartbeatRuns.status, createdAt: heartbeatRuns.createdAt, startedAt: heartbeatRuns.startedAt,
      finishedAt: heartbeatRuns.finishedAt,
      // Only link an accessible, same-company issue. Never join on titles or names.
      issueId: sql<string | null>`(select id from ${issues} where company_id = ${companyId} and hidden_at is null and (execution_run_id = ${heartbeatRuns.id} or checkout_run_id = ${heartbeatRuns.id} or id::text = ${heartbeatRuns.contextSnapshot}->>'issueId') order by (execution_run_id = ${heartbeatRuns.id}) desc nulls last, id limit 1)`,
    };
    const readRuns = (live: boolean) => db.select(runColumns).from(heartbeatRuns)
      .innerJoin(agents, and(eq(agents.id, heartbeatRuns.agentId), eq(agents.companyId, companyId)))
      .where(and(eq(heartbeatRuns.companyId, companyId), live ? inArray(heartbeatRuns.status, ["queued", "running"]) : undefined))
      .orderBy(desc(heartbeatRuns.createdAt), heartbeatRuns.id).limit(live ? 51 : 50);
    const [itemResult, liveResult, recentResult] = await Promise.allSettled([itemRead, readRuns(true), readRuns(false)]);
    const rows = itemResult.status === "fulfilled" ? itemResult.value : [];
    const runsReady = liveResult.status === "fulfilled" && recentResult.status === "fulfilled";
    const projectRuns = (result: typeof liveResult): OperatorRun[] => result.status !== "fulfilled" ? [] : result.value.slice(0, 50).map((row) => {
      const progress = ["queued", "running"].includes(row.status) ? getHeartbeatRunRuntimeStatus(row.runId, {
        companyId, agentId: row.agentId, issueId: row.issueId, pruneExpired: false,
      }) : null;
      const tool = progress?.currentToolName;
      return {
        ...row, createdAt: row.createdAt.toISOString(), startedAt: row.startedAt?.toISOString() ?? null,
        finishedAt: row.finishedAt?.toISOString() ?? null,
        currentToolName: tool && /^[a-zA-Z0-9_.:-]{1,80}$/.test(tool) ? tool : null,
        currentStatusUpdatedAt: progress?.updatedAt.toISOString() ?? null,
        nativeHref: `/agents/${row.agentId}/runs/${row.runId}`,
      };
    });
    const items = rows.slice(0, limit).map((row) => {
      if ("issueId" in row) return { ...row, title: text(row.title, 240), updatedAt: row.updatedAt.toISOString(), humanHold: row.humanHold ? true : null, nativeHref: `/issues/${row.issueId}` } as OperatorWorkItem;
      return { ...row, name: text(row.name, 120), role: text(row.role, 120), nativeHref: `/agents/${row.agentId}` };
    });
    const hasMore = rows.length > limit;
    const result: OperatorOverview = {
      schemaVersion: 1, companyId, view, observedAt: new Date().toISOString(), items, hasMore,
      nextOffset: hasMore ? offset + limit : null, liveRuns: projectRuns(liveResult), recentRuns: projectRuns(recentResult),
      liveRunsTruncated: liveResult.status === "fulfilled" && liveResult.value.length > 50,
      sourceState: { items: itemResult.status === "fulfilled" ? "ready" : "unavailable", runs: runsReady ? "ready" : "unavailable" },
    };
    res.json(result);
  });
  return router;
}
