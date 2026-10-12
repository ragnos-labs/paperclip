import express from "express";
import { createServer, request, type ClientRequest, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { companyLiveEventsRoutes } from "../routes/company-live-events.js";
import { publishLiveEvent } from "../services/live-events.js";

const clients: ClientRequest[] = [];
const servers: ReturnType<typeof createServer>[] = [];
afterEach(async () => {
  for (const client of clients.splice(0)) client.destroy();
  await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => server.close(() => resolve()))));
});

async function start() {
  const app = express();
  app.use((req, _res, next) => {
    req.actor = { type: req.get("actor") === "agent" ? "agent" : req.get("actor") === "none" ? "none" : "board",
      source: "session", userId: "synthetic-owner", companyIds: ["alpha"], companyId: "alpha" } as typeof req.actor;
    next();
  });
  app.use(companyLiveEventsRoutes());
  app.use((err: { status?: number; message: string }, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    res.status(err.status ?? 500).json({ error: err.message });
  });
  const server = createServer(app); servers.push(server);
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  return (server.address() as AddressInfo).port;
}

async function connect(port: number, company = "alpha", actor = "board") {
  return new Promise<{ response: IncomingMessage; text: () => string; waitFor: (value: string) => Promise<void> }>((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port, path: `/companies/${company}/events/sse`, headers: { actor } }, response => {
      let body = "";
      let pending: { value: string; resolve: () => void; timer: ReturnType<typeof setTimeout> } | null = null;
      response.on("data", chunk => {
        body += String(chunk);
        if (pending && body.includes(pending.value)) { clearTimeout(pending.timer); pending.resolve(); pending = null; }
      });
      resolve({ response, text: () => body, waitFor: value => body.includes(value) ? Promise.resolve() : new Promise<void>((done, fail) => {
        pending = { value, resolve: done, timer: setTimeout(() => { pending = null; fail(new Error("stream value missing")); }, 1000) };
      }) });
    });
    clients.push(req); req.on("error", reject); req.end();
  });
}

describe("company operator SSE", () => {
  it("requires a native board identity with company membership", async () => {
    const port = await start();
    expect((await connect(port, "alpha", "none")).response.statusCode).toBe(401);
    expect((await connect(port, "alpha", "agent")).response.statusCode).toBe(403);
    expect((await connect(port, "other")).response.statusCode).toBe(403);
  });
  it("streams only its company identifiers and omits private payloads and logs", async () => {
    const stream = await connect(await start()); await stream.waitFor("event: ready");
    expect(stream.response.headers["content-type"]).toBe("text/event-stream");
    expect(stream.response.headers["cache-control"]).toContain("no-store");
    publishLiveEvent({ companyId: "other", type: "activity.logged", payload: { issueId: "wrong-issue" } });
    publishLiveEvent({ companyId: "alpha", type: "heartbeat.run.log", payload: { runId: "log-run", body: "private log" } });
    publishLiveEvent({ companyId: "alpha", type: "activity.logged", payload: { issueId: "right-issue", body: "private comment", token: "private token" } });
    await stream.waitFor("right-issue");
    expect(stream.text()).not.toMatch(/wrong-issue|log-run|private/);
  });
  it("bounds streams and releases a slot after disconnect", async () => {
    const port = await start();
    for (let i = 0; i < 4; i++) await (await connect(port)).waitFor("event: ready");
    const rejected = await connect(port); expect(rejected.response.statusCode).toBe(429);
    const first = clients.shift()!; first.destroy();
    await new Promise<void>(resolve => first.once("close", resolve));
    // Observe server-side cleanup before reconnecting, rather than retrying writes.
    await new Promise<void>(resolve => setTimeout(resolve, 20));
    const again = await connect(port); expect(again.response.statusCode).toBe(200);
  });
});
