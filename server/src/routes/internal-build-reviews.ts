import { Router, type Request } from "express";
import { and, asc, eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { heartbeatRuns, issueThreadInteractions, issues } from "@paperclipai/db";
import { forbidden, notFound, unprocessable } from "../errors.js";
import { logger } from "../middleware/logger.js";
import { heartbeatService } from "../services/heartbeat.js";
import { issueThreadInteractionService } from "../services/issue-thread-interactions.js";
import {
  isInternalBuildReviewInteraction,
  resolveInternalBuildReviewerAgentId,
} from "../services/native-runtime/internal-build-review.js";
import type { PluginWorkerManager } from "../services/plugin-worker-manager.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * The configured internal build reviewer reads and decides the review cards
 * addressed to it on other agents' tasks. It is not those tasks' assignee, so
 * ordinary task access does not apply; this route admits only that exact
 * reviewer, its pending labeled cards, and an attributed run of its own.
 */
export function internalBuildReviewRoutes(
  db: Db,
  options: { pluginWorkerManager?: PluginWorkerManager } = {},
) {
  const router = Router();
  const heartbeat = heartbeatService(db, { pluginWorkerManager: options.pluginWorkerManager });

  async function reviewer(req: Request) {
    const actor = req.actor as { type?: string; agentId?: string; companyId?: string; runId?: string };
    if (actor?.type !== "agent" || !actor.agentId || !actor.companyId) {
      throw forbidden("Only the internal build reviewer agent may use this route");
    }
    if (await resolveInternalBuildReviewerAgentId(db, actor.companyId) !== actor.agentId) {
      throw forbidden("This agent is not the configured internal build reviewer");
    }
    return { agentId: actor.agentId, companyId: actor.companyId, runId: actor.runId?.trim() || null };
  }

  function addressed(row: typeof issueThreadInteractions.$inferSelect, agentId: string) {
    const target = (row.payload as { target?: { key?: unknown } } | null)?.target;
    return row.kind === "request_confirmation" && row.addresseeAgentId === agentId
      && !!row.createdByAgentId && row.createdByAgentId !== agentId
      && target?.key === "native_completion_review" && isInternalBuildReviewInteraction(row);
  }

  async function card(interactionId: string, actor: { agentId: string; companyId: string }) {
    if (!UUID.test(interactionId)) throw notFound("Internal build review not found");
    const row = await db.select().from(issueThreadInteractions)
      .where(and(eq(issueThreadInteractions.id, interactionId),
        eq(issueThreadInteractions.companyId, actor.companyId)))
      .then((rows) => rows[0] ?? null);
    if (!row || !addressed(row, actor.agentId)) throw notFound("Internal build review not found");
    const issue = await db.select().from(issues)
      .where(and(eq(issues.id, row.issueId), eq(issues.companyId, actor.companyId)))
      .then((rows) => rows[0] ?? null);
    if (!issue) throw notFound("Internal build review not found");
    return { row, issue };
  }

  function view(row: typeof issueThreadInteractions.$inferSelect, issue: typeof issues.$inferSelect) {
    const payload = (row.payload ?? {}) as { prompt?: string; detailsMarkdown?: string | null };
    return {
      interactionId: row.id, status: row.status, issueId: issue.id, identifier: issue.identifier,
      title: issue.title, description: issue.description, issueStatus: issue.status,
      prompt: payload.prompt ?? null, results: payload.detailsMarkdown ?? row.summary ?? null,
    };
  }

  router.get("/internal-build-reviews", async (req, res) => {
    const actor = await reviewer(req);
    const rows = await db.select().from(issueThreadInteractions)
      .where(and(eq(issueThreadInteractions.companyId, actor.companyId),
        eq(issueThreadInteractions.addresseeAgentId, actor.agentId),
        eq(issueThreadInteractions.status, "pending")))
      .orderBy(asc(issueThreadInteractions.createdAt));
    const result = [];
    for (const row of rows.filter((item) => addressed(item, actor.agentId))) {
      const issue = await db.select().from(issues)
        .where(and(eq(issues.id, row.issueId), eq(issues.companyId, actor.companyId)))
        .then((items) => items[0] ?? null);
      if (issue) result.push(view(row, issue));
    }
    res.json(result);
  });

  router.get("/internal-build-reviews/:interactionId", async (req, res) => {
    const actor = await reviewer(req);
    const { row, issue } = await card(req.params.interactionId as string, actor);
    res.json(view(row, issue));
  });

  router.post("/internal-build-reviews/:interactionId/:decision", async (req, res) => {
    const actor = await reviewer(req);
    const decision = req.params.decision;
    if (decision !== "accept" && decision !== "reject") throw notFound("Unknown review decision");
    const reason = typeof req.body?.reason === "string" ? req.body.reason.trim() : "";
    if (decision === "reject" && (!reason || reason.length > 2000)) {
      throw unprocessable("Rejecting requires a bounded reason the worker can act on");
    }
    if (!actor.runId) throw unprocessable("An attributed reviewer run is required");
    const run = await db.select({ id: heartbeatRuns.id }).from(heartbeatRuns)
      .where(and(eq(heartbeatRuns.id, actor.runId), eq(heartbeatRuns.agentId, actor.agentId),
        eq(heartbeatRuns.companyId, actor.companyId)))
      .then((rows) => rows[0] ?? null);
    if (!run) throw unprocessable("An attributed reviewer run is required");
    const { row, issue } = await card(req.params.interactionId as string, actor);
    const service = issueThreadInteractionService(db);
    const ref = { id: issue.id, companyId: issue.companyId, projectId: issue.projectId,
      goalId: issue.goalId, status: issue.status };
    const resolver = { agentId: actor.agentId, runId: actor.runId };
    if (decision === "accept") {
      await service.acceptInteraction(ref, row.id, {}, resolver);
    } else {
      await service.rejectInteraction(ref, row.id, { reason }, resolver);
      if (issue.assigneeAgentId) {
        const context = { issueId: issue.id, taskId: issue.id, interactionId: row.id,
          interactionStatus: "rejected", wakeReason: "internal_build_review_rejected", reviewerReason: reason };
        await heartbeat.wakeup(issue.assigneeAgentId, {
          source: "automation", triggerDetail: "system", reason: "issue_status_changed",
          payload: context, requestedByActorType: "agent", requestedByActorId: actor.agentId,
          contextSnapshot: { source: "internal_build_review.rejected", ...context },
        }).catch((err) => logger.warn({ err, issueId: issue.id, interactionId: row.id },
          "failed to wake assignee after internal build review rejection"));
      }
    }
    const updated = await card(row.id, actor);
    res.json(view(updated.row, updated.issue));
  });

  return router;
}
