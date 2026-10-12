import { Router } from "express";
import { subscribeCompanyLiveEvents } from "../services/live-events.js";
import { assertBoard, assertCompanyAccess } from "./authz.js";

/** Private operator invalidations over HTTP; clients recover missed events by rereading state. */
export function companyLiveEventsRoutes() {
  const router = Router();
  const connections = new Map<string, number>();
  router.get("/companies/:companyId/events/sse", (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    assertBoard(req);
    const key = JSON.stringify([companyId, req.actor.userId ?? req.actor.source]);
    const count = connections.get(key) ?? 0;
    if (count >= 4) {
      res.setHeader("Retry-After", "5");
      res.status(429).json({ error: "Too many company event streams" });
      return;
    }
    connections.set(key, count + 1);
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "private, no-store, no-transform");
    res.setHeader("X-Accel-Buffering", "no");
    res.flushHeaders();
    let closed = false;
    const write = (value: string) => {
      if (!closed && !res.write(value)) res.destroy();
    };
    const unsubscribe = subscribeCompanyLiveEvents(companyId, (event) => {
      if (["heartbeat.run.log", "heartbeat.run.event", "heartbeat.run.progress"].includes(event.type)) return;
      const payload: Record<string, string> = {};
      for (const field of ["issueId", "entityId", "entityType", "agentId", "approvalId", "runId"]) {
        const value = event.payload[field];
        if (typeof value === "string" && value.length <= 128) payload[field] = value;
      }
      write(`data: ${JSON.stringify({ id: event.id, companyId, type: event.type, createdAt: event.createdAt, payload })}\n\n`);
    });
    const heartbeat = setInterval(() => write(": keepalive\n\n"), 15_000);
    // A short lease revalidates native membership on every reconnect.
    const lease = setTimeout(() => res.end(), 60_000);
    const close = () => {
      if (closed) return;
      closed = true;
      clearInterval(heartbeat);
      clearTimeout(lease);
      unsubscribe();
      const remaining = (connections.get(key) ?? 1) - 1;
      if (remaining) connections.set(key, remaining); else connections.delete(key);
    };
    res.once("close", close);
    res.once("error", close);
    write("retry: 5000\nevent: ready\ndata: {}\n\n");
  });
  return router;
}
