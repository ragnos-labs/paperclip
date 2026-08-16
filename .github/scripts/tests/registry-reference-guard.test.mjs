import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { classifyRegistryInspect } from "../registry-reference-guard.mjs";

const reference = "ghcr.io/ragnos-labs/paperclip:ragnos-0.1.0-alpha.1";

test("accepts only target-specific manifest absence responses", () => {
  assert.equal(classifyRegistryInspect({
    reference,
    status: 1,
    output: `ERROR: ${reference}: not found`,
  }), "absent");
  assert.equal(classifyRegistryInspect({
    reference,
    status: 1,
    output: `ERROR: failed to resolve source metadata for ${reference}: manifest unknown`,
  }), "absent");
  assert.equal(classifyRegistryInspect({
    reference,
    status: 1,
    output: JSON.stringify({ errors: [{ code: "MANIFEST_UNKNOWN", message: "manifest unknown" }] }),
  }), "absent");
});

test("rejects an existing registry reference", () => {
  assert.throws(() => classifyRegistryInspect({ reference, status: 0, output: "Name: existing" }), /already exists/);
});

test("rejects auth, credential, transport, and ambiguous not-found failures", () => {
  const failures = [
    "docker-credential-helper: executable file not found in PATH",
    "failed to authorize: server returned 404 for token endpoint",
    "unauthorized: authentication required",
    "dial tcp: network is unreachable",
    "TLS handshake timeout",
    "unexpected 404 Not Found",
    "manifest unknown",
    `ERROR: ghcr.io/ragnos-labs/other:latest: not found`,
  ];

  for (const output of failures) {
    assert.throws(() => classifyRegistryInspect({ reference, status: 1, output }), output);
  }
});

test("rejects invalid command status", () => {
  assert.throws(() => classifyRegistryInspect({ reference, status: 2, output: `ERROR: ${reference}: not found` }));
});

test("command-line guard accepts absence and rejects authorization failures", () => {
  const script = fileURLToPath(new URL("../registry-reference-guard.mjs", import.meta.url));
  const run = (input) => spawnSync(process.execPath, [
    script,
    "--reference", reference,
    "--status", "1",
  ], { encoding: "utf8", input });

  assert.equal(run(`ERROR: ${reference}: not found`).status, 0);
  const authFailure = run("failed to authorize: server returned 404 for token endpoint");
  assert.equal(authFailure.status, 1);
  assert.match(authFailure.stderr, /operational or authorization failure/);
});
