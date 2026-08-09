import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { once } from "node:events";
import { createServer } from "node:http";
import { after, before, test } from "node:test";
import { createFakeFleetBroker } from "../../../fake-fleet-broker/src/server.js";
import { execute } from "../src/adapter.js";

const key = randomBytes(32);
const keyId = "ragnos-paperclip-local-v1";
const broker = createFakeFleetBroker({
  keys: new Map([[keyId, key]]),
  tenants: new Map([[keyId, "tenant-ragnos"]]),
  pollAfterMs: 10,
});
let baseUrl;
let paperclipApiUrl;
const cancelledRuns = new Set();
const issueStates = new Map();
const issuePatches = [];
const paperclipServer = createServer(async (request, response) => {
  const url = new URL(request.url, "http://paperclip.local");
  const runMatch = request.method === "GET" && /^\/api\/heartbeat-runs\/([^/]+)$/.exec(url.pathname);
  const issueMatch = /^\/api\/issues\/([^/]+)$/.exec(url.pathname);
  response.setHeader("Content-Type", "application/json");
  if (runMatch) {
    response.end(JSON.stringify({ status: cancelledRuns.has(runMatch[1]) ? "cancelled" : "running" }));
    return;
  }
  if (issueMatch && request.method === "GET") {
    response.end(JSON.stringify({
      createdByUserId: "local-human-reviewer",
      id: issueMatch[1],
      responsibleUserId: "local-human-reviewer",
      status: issueStates.get(issueMatch[1]) ?? "in_progress",
    }));
    return;
  }
  if (issueMatch && request.method === "PATCH") {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    issueStates.set(issueMatch[1], body.status);
    issuePatches.push({ issueId: issueMatch[1], ...body });
    response.end(JSON.stringify({ id: issueMatch[1], status: body.status }));
    return;
  }
  response.writeHead(404);
  response.end(JSON.stringify({ error: "not_found" }));
});

before(async () => {
  broker.server.listen(0, "127.0.0.1");
  await once(broker.server, "listening");
  const address = broker.server.address();
  baseUrl = `http://127.0.0.1:${address.port}`;
  paperclipServer.listen(0, "127.0.0.1");
  await once(paperclipServer, "listening");
  const paperclipAddress = paperclipServer.address();
  paperclipApiUrl = `http://127.0.0.1:${paperclipAddress.port}`;
});

after(async () => {
  broker.server.close();
  paperclipServer.close();
  await once(broker.server, "close");
  await once(paperclipServer, "close");
});

function adapterContext({
  operation = "propose",
  scenario = "succeeded",
  runId = "run-1",
  authToken = "local-test-token",
} = {}) {
  const events = [];
  const issueId = "issue-1";
  const markdown = operation === "apply"
    ? [
        "# Apply approved proposal",
        "",
        "```ragnos-fleet",
        '{"proposal_id":"proposal_1234567890abcdef"}',
        "```",
      ].join("\n")
    : `# Synthetic proposal\n\n[fleet-scenario:${scenario}]`;
  return {
    agent: { companyId: "company-ragnos", id: `employee-${operation}` },
    authToken,
    config: {
      allowPrivateHttp: true,
      gatewayBaseUrl: baseUrl,
      hmacKeyB64: key.toString("base64"),
      keyId,
      operation,
      paperclipApiUrl,
      pollAfterMs: 10,
      requestTimeoutMs: 1_000,
      timeoutMs: scenario === "timeout" ? 500 : 2_000,
    },
    context: {
      approvalId: operation === "apply" ? "approval-1" : null,
      approvalStatus: operation === "apply" ? "approved" : null,
      attempt: 1,
      issueId,
      paperclipTaskMarkdown: markdown,
    },
    events,
    onEvent: async (event) => events.push(event),
    runId,
  };
}

test("executes propose polling and exact duplicate replay end to end", async () => {
  issueStates.delete("issue-1");
  issuePatches.length = 0;
  const firstContext = adapterContext({ runId: "run-propose-duplicate" });
  const first = await execute(firstContext);
  const replay = await execute(adapterContext({ runId: "run-propose-duplicate" }));

  assert.equal(first.exitCode, 0);
  assert.equal(first.resultJson.status, "succeeded");
  assert.match(first.resultJson.job_id, /^job_/);
  assert.match(first.resultJson.pipeline_run_id, /^paperclip-fleet-/);
  assert.equal(first.resultJson.trace_id.length, 32);
  assert.match(first.resultJson.proposal_id, /^proposal_/);
  assert.match(first.resultJson.cleanup_receipt_id, /^cleanup_/);
  assert.deepEqual(first.resultJson.result.changed_files, ["fixtures/proposal.txt"]);
  assert.match(first.resultJson.result.diff_sha256, /^[a-f0-9]{64}$/);
  assert.match(first.resultJson.result.diff_preview, /synthetic governed proposal/);
  assert.equal(replay.resultJson.job_id, first.resultJson.job_id);
  assert.equal(firstContext.events[0]?.eventType, "fleet.lifecycle");
  assert.equal(issuePatches.length, 1);
  assert.equal(issuePatches[0].status, "in_review");
  assert.equal(issuePatches[0].assigneeAgentId, null);
  assert.equal(issuePatches[0].assigneeUserId, "local-human-reviewer");
  assert.match(issuePatches[0].comment, /proposal_/);
  assert.match(issuePatches[0].comment, /run-propose-duplicate/);
  assert.match(issuePatches[0].comment, /fixtures\/proposal\.txt/);
  assert.match(issuePatches[0].comment, /synthetic governed proposal/);
});

test("executes an approval-gated apply with a structured proposal id", async () => {
  issueStates.delete("issue-1");
  issuePatches.length = 0;
  const result = await execute(adapterContext({ operation: "apply", runId: "run-apply" }));
  assert.equal(result.exitCode, 0);
  assert.equal(result.resultJson.operation, "apply");
  assert.equal(result.resultJson.proposal_id, "proposal_1234567890abcdef");
  assert.match(result.resultJson.result.receipt_id, /^receipt_/);
  assert.equal(issuePatches[0].status, "done");
  assert.doesNotMatch(issuePatches[0].comment, /credential|private|logs/i);
});

test("cancels upstream when Paperclip reports cancellation", async () => {
  cancelledRuns.add("run-paperclip-cancel");
  try {
    const result = await execute(adapterContext({
      runId: "run-paperclip-cancel",
      scenario: "running",
    }));
    assert.equal(result.errorCode, "fleet_cancelled");
    assert.equal(result.resultJson.status, "cancelled");
    assert.equal(result.resultJson.cancel_requested, true);
  } finally {
    cancelledRuns.delete("run-paperclip-cancel");
  }
});

test("times out bounded work and cancels the upstream job", async () => {
  const result = await execute(adapterContext({ runId: "run-timeout", scenario: "timeout" }));
  assert.equal(result.errorCode, "fleet_timeout");
  assert.equal(result.timedOut, true);
  assert.equal(result.resultJson.status, "cancelled");
  assert.equal(result.resultJson.cancel_requested, true);
});

test("recovers after a deterministic unavailable response", async () => {
  const unavailable = adapterContext({ runId: "run-outage", scenario: "unavailable" });
  await assert.rejects(execute(unavailable), /fleet_gateway_http_503/);

  const recovered = await execute(adapterContext({ runId: "run-outage", scenario: "succeeded" }));
  assert.equal(recovered.exitCode, 0);
  assert.equal(recovered.resultJson.status, "succeeded");
});

test("keeps polling after bounded gateway quota responses", async () => {
  const context = adapterContext({ runId: "run-rate-limited", scenario: "rate_limited" });
  const result = await execute(context);

  assert.equal(result.exitCode, 0);
  assert.equal(result.resultJson.status, "succeeded");
  assert.ok(context.events.some((event) => event.message === "Fleet polling rate limited; retrying."));
  assert.ok(context.events.some((event) => event.message === "Fleet polling recovered."));
});
