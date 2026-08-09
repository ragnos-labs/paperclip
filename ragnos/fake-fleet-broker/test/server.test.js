import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { once } from "node:events";
import { after, before, test } from "node:test";
import { createFakeFleetBroker } from "../src/server.js";
import {
  actorHash,
  canonicalJson,
  signRequest,
} from "../../packages/ragnos-fleet/src/protocol.js";

const ragnosKey = randomBytes(32);
const aiblKey = randomBytes(32);
const keyIds = {
  aibl: "aibl-paperclip-local-v1",
  ragnos: "ragnos-paperclip-local-v1",
};
const broker = createFakeFleetBroker({
  keys: new Map([
    [keyIds.ragnos, ragnosKey],
    [keyIds.aibl, aiblKey],
  ]),
  tenants: new Map([
    [keyIds.ragnos, "tenant-ragnos"],
    [keyIds.aibl, "tenant-aibl"],
  ]),
  pollAfterMs: 10,
});
let baseUrl;

before(async () => {
  broker.server.listen(0, "127.0.0.1");
  await once(broker.server, "listening");
  const address = broker.server.address();
  baseUrl = `http://127.0.0.1:${address.port}`;
});

after(async () => {
  broker.server.close();
  await once(broker.server, "close");
});

function payload(scenario, operation = "propose", idempotency = `test-${scenario}-${operation}`) {
  const common = {
    context: {
      pipeline_run_id: `pipeline-${idempotency}`,
      revision: "paperclip:test",
      test_scenario: scenario,
      trace_id: "a".repeat(32),
    },
    idempotency_key: idempotency,
    protocol_version: "2026-07-21",
  };
  return operation === "propose"
    ? { ...common, prompt: `Test [fleet-scenario:${scenario}]` }
    : { ...common, confirmation: "apply", proposal_id: "proposal_1234567890abcdef" };
}

async function signedCall({
  actor = actorHash("company-ragnos", "employee-proposer"),
  body = null,
  idempotency,
  key = ragnosKey,
  keyId = keyIds.ragnos,
  method,
  nonce,
  path,
}) {
  const bytes = body == null ? Buffer.alloc(0) : Buffer.from(canonicalJson(body));
  const headers = signRequest({ actorHash: actor, body: bytes, idempotencyKey: idempotency, key, keyId, method, nonce, path });
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      ...headers,
      Accept: "application/json",
      ...(bytes.length ? { "Content-Type": "application/json" } : {}),
    },
    body: bytes.length ? bytes : undefined,
  });
  return { response, payload: await response.json() };
}

test("health and readiness never require credentials", async () => {
  assert.equal((await fetch(`${baseUrl}/health`)).status, 200);
  assert.equal((await fetch(`${baseUrl}/ready`)).status, 200);
});

test("covers queued, running, succeeded, failed, cancelled, delayed, and unavailable", async () => {
  for (const name of ["queued", "running", "succeeded", "failed", "cancelled", "delayed"]) {
    const request = payload(name);
    const accepted = await signedCall({
      body: request,
      idempotency: request.idempotency_key,
      method: "POST",
      path: "/propose",
    });
    assert.equal(accepted.response.status, 202, name);
    const statuses = [];
    for (let poll = 0; poll < (name === "delayed" ? 3 : 1); poll += 1) {
      const status = await signedCall({
        idempotency: `status-${name}-${poll}`,
        method: "GET",
        path: `/jobs/${accepted.payload.job_id}`,
      });
      assert.equal(status.response.status, 200, name);
      statuses.push(status.payload.status);
    }
    const expected = {
      cancelled: ["cancelled"],
      delayed: ["queued", "running", "succeeded"],
      failed: ["failed"],
      queued: ["queued"],
      running: ["running"],
      succeeded: ["succeeded"],
    };
    assert.deepEqual(statuses, expected[name], name);
  }
  const request = payload("unavailable");
  const unavailable = await signedCall({
    body: request,
    idempotency: request.idempotency_key,
    method: "POST",
    path: "/propose",
  });
  assert.equal(unavailable.response.status, 503);
  assert.equal(unavailable.payload.code, "gateway_unavailable");
});

test("deduplicates exact replays and rejects idempotency collisions", async () => {
  const request = payload("succeeded", "propose", "duplicate-1");
  const first = await signedCall({ body: request, idempotency: request.idempotency_key, method: "POST", path: "/propose" });
  const replay = await signedCall({ body: request, idempotency: request.idempotency_key, method: "POST", path: "/propose" });
  assert.equal(replay.response.status, 202);
  assert.equal(replay.payload.job_id, first.payload.job_id);
  const conflictBody = { ...request, prompt: "Different request" };
  const conflict = await signedCall({ body: conflictBody, idempotency: request.idempotency_key, method: "POST", path: "/propose" });
  assert.equal(conflict.response.status, 409);
  assert.equal(conflict.payload.code, "idempotency_conflict");
});

test("rejects stale timestamps, nonce replay, body mutation, and cross-tenant reads", async () => {
  const request = payload("queued", "propose", "security-1");
  const nonce = "security-fixture-nonce-0001";
  const first = await signedCall({ body: request, idempotency: request.idempotency_key, method: "POST", nonce, path: "/propose" });
  assert.equal(first.response.status, 202);
  const replay = await signedCall({ body: request, idempotency: request.idempotency_key, method: "POST", nonce, path: "/propose" });
  assert.equal(replay.response.status, 409);
  assert.equal(replay.payload.code, "nonce_replayed");

  const otherTenant = await signedCall({
    actor: actorHash("company-aibl", "employee-proposer"),
    idempotency: "aibl-status-1",
    key: aiblKey,
    keyId: keyIds.aibl,
    method: "GET",
    path: `/jobs/${first.payload.job_id}`,
  });
  assert.equal(otherTenant.response.status, 404);
  assert.equal(otherTenant.payload.code, "job_not_found");

  const tamperRequest = payload("queued", "propose", "security-tamper-1");
  const tamperBytes = Buffer.from(canonicalJson(tamperRequest));
  const tamperHeaders = signRequest({
    actorHash: actorHash("company-ragnos", "employee-proposer"),
    body: tamperBytes,
    idempotencyKey: tamperRequest.idempotency_key,
    key: ragnosKey,
    keyId: keyIds.ragnos,
    method: "POST",
    path: "/propose",
  });
  const mutatedBytes = Buffer.from(canonicalJson({ ...tamperRequest, prompt: "mutated after signing" }));
  const mutated = await fetch(`${baseUrl}/propose`, {
    method: "POST",
    headers: tamperHeaders,
    body: mutatedBytes,
  });
  assert.equal(mutated.status, 401);

  const bytes = Buffer.from(canonicalJson(request));
  const staleHeaders = signRequest({
    actorHash: actorHash("company-ragnos", "employee-proposer"),
    body: bytes,
    idempotencyKey: "stale-1",
    key: ragnosKey,
    keyId: keyIds.ragnos,
    method: "POST",
    path: "/propose",
    timestamp: Math.floor(Date.now() / 1000) - 61,
  });
  const stale = await fetch(`${baseUrl}/propose`, { method: "POST", headers: staleHeaders, body: bytes });
  assert.equal(stale.status, 401);
});

test("cancels timeout jobs and exposes bounded public identifiers", async () => {
  const request = payload("timeout", "propose", "timeout-1");
  const accepted = await signedCall({ body: request, idempotency: request.idempotency_key, method: "POST", path: "/propose" });
  const cancelKey = "cancel-timeout-1";
  const cancelled = await signedCall({
    body: { idempotency_key: cancelKey, protocol_version: "2026-07-21" },
    idempotency: cancelKey,
    method: "POST",
    path: `/jobs/${accepted.payload.job_id}/cancel`,
  });
  assert.equal(cancelled.response.status, 200);
  assert.equal(cancelled.payload.status, "cancelled");
  assert.match(cancelled.payload.agent_run_id, /^agent_run_/);
  assert.equal(cancelled.payload.pipeline_run_id, request.context.pipeline_run_id);
  assert.equal(cancelled.payload.trace_id, request.context.trace_id);
  assert.match(cancelled.payload.workspace_id, /^workspace_/);
  assert.equal("credentials" in cancelled.payload, false);
  assert.equal("logs" in cancelled.payload, false);
});

test("successful proposals expose bounded review metadata and complete receipts", async () => {
  const request = payload("succeeded", "propose", "review-fields-1");
  request.context.pipeline_run_id = "pipeline-review-fields-1";
  const accepted = await signedCall({
    body: request,
    idempotency: request.idempotency_key,
    method: "POST",
    path: "/propose",
  });
  const status = await signedCall({
    idempotency: "review-fields-status-1",
    method: "GET",
    path: `/jobs/${accepted.payload.job_id}`,
  });

  assert.equal(status.response.status, 200);
  assert.equal(status.payload.pipeline_run_id, "pipeline-review-fields-1");
  assert.equal(status.payload.trace_id, request.context.trace_id);
  assert.match(status.payload.result.receipt_id, /^receipt_/);
  assert.match(status.payload.cleanup_receipt_id, /^cleanup_/);
  assert.deepEqual(status.payload.result.changed_files, ["fixtures/proposal.txt"]);
  assert.equal(
    status.payload.result.diff_bytes,
    Buffer.byteLength(status.payload.result.diff_preview, "utf8"),
  );
  assert.match(status.payload.result.diff_sha256, /^[a-f0-9]{64}$/);
  assert.equal("proposal_patch" in status.payload.result, false);
});
