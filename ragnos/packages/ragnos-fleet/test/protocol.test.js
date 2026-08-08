import assert from "node:assert/strict";
import { test } from "node:test";
import {
  actorHash,
  canonicalJson,
  decodeHmacKey,
  idempotencyKey,
  signRequest,
  verifyRequest,
} from "../src/protocol.js";

const fixtureKey = Buffer.from("FAKE-ONLY-codex-app-signing-vector-key-v1", "utf8");
const fixture = {
  actorHash: "ef388cdb2ea9cae5d6cbbb82f7b90bcab47ca7fa2e985aab6589e4532d65b74c",
  body: Buffer.from(
    "{\"context\":{\"deck_id\":\"ccc5\",\"deck_revision\":\"rev-17\"},\"idempotency_key\":\"fixture-propose-001\",\"prompt\":\"Make slide 4 clearer.\",\"protocol_version\":\"2026-07-21\"}",
  ),
  idempotencyKey: "fixture-propose-001", // gitleaks:allow - deterministic test fixture
  key: fixtureKey,
  keyId: "fixture-aibl-backend-v1",
  method: "POST",
  nonce: "fixture-create-nonce-0001",
  path: "/propose",
  timestamp: 1700000000,
};

test("matches the canonical RAGnos propose signing vector", () => {
  const headers = signRequest(fixture);
  assert.equal(headers["X-Keez-Body-SHA256"], "99721a558ebf950497cb45c64be4540df0cbd92f407d528df27f896813afb68d");
  assert.equal(headers["X-Keez-Signature"], "A0Y89aNzHhQVSlGoewkpV1LS2-Z1AnpaaTS357aj3tc");
  assert.deepEqual(
    verifyRequest({
      body: fixture.body,
      headers,
      keys: new Map([[fixture.keyId, fixtureKey]]),
      method: fixture.method,
      now: fixture.timestamp,
      path: fixture.path,
    }),
    {
      actorHash: fixture.actorHash,
      idempotencyKey: fixture.idempotencyKey,
      keyId: fixture.keyId,
      nonce: fixture.nonce,
      timestamp: fixture.timestamp,
    },
  );
});

test("rejects signature, timestamp, body, and actor tampering", () => {
  const headers = signRequest(fixture);
  const keys = new Map([[fixture.keyId, fixtureKey]]);
  const cases = [
    { headers: { ...headers, "X-Keez-Signature": "x".repeat(43) }, now: fixture.timestamp },
    { headers, now: fixture.timestamp + 61 },
    { headers: { ...headers, "X-Codex-Actor-Hash": "0".repeat(64) }, now: fixture.timestamp },
    { headers, now: fixture.timestamp, body: Buffer.from("{}") },
  ];
  for (const candidate of cases) {
    assert.throws(() => verifyRequest({
      body: candidate.body ?? fixture.body,
      headers: candidate.headers,
      keys,
      method: fixture.method,
      now: candidate.now,
      path: fixture.path,
    }));
  }
});

test("derives tenant-bound actor and operation-bound idempotency", () => {
  const first = actorHash("company-ragnos", "employee-proposer");
  const second = actorHash("company-aibl", "employee-proposer");
  assert.notEqual(first, second);
  const base = {
    attempt: 1,
    companyId: "company-ragnos",
    issueId: "issue-1",
    operation: "propose",
    runId: "run-1",
  };
  assert.equal(idempotencyKey(base), idempotencyKey(base));
  assert.notEqual(idempotencyKey(base), idempotencyKey({ ...base, operation: "apply" }));
  assert.notEqual(idempotencyKey(base), idempotencyKey({ ...base, attempt: 2 }));
});

test("canonical JSON recursively sorts keys and key decoding rejects weak material", () => {
  assert.equal(canonicalJson({ z: 1, a: { y: 2, b: 3 } }), '{"a":{"b":3,"y":2},"z":1}');
  assert.throws(() => decodeHmacKey(Buffer.from("short").toString("base64url")));
});
