import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { compareAuditToBaseline, validateAuditBaseline, validateAuditCommandResult } from "../ragnos-fork-security-gate.mjs";
import { scanSupplyChain } from "../check-pr-security.mjs";
const clean = { advisories: {}, metadata: { vulnerabilities: { info: 0, low: 0, moderate: 0, high: 0, critical: 0 } } };
test("audit fails closed on malformed, interrupted and provider-error results", () => {
  for (const status of [0, 1]) assert.deepEqual(validateAuditCommandResult({ status, stdout: JSON.stringify(clean) }), clean);
  for (const result of [{ status: 2 }, { status: 0, signal: "SIGTERM" }, { status: 0, stdout: "invalid" },
    { status: 1, stdout: JSON.stringify({ error: "unavailable" }) }, { status: 0, stdout: JSON.stringify({ advisories: {} }) }])
    assert.throws(() => validateAuditCommandResult(result));
});
test("dependency baseline admits removals but rejects added or worsened advisories", () => {
  const baseline = { advisories: { "1": "moderate" } };
  assert.deepEqual(compareAuditToBaseline({ advisories: {} }, baseline), []);
  assert.deepEqual(compareAuditToBaseline({ advisories: { "1": { severity: "moderate" } } }, baseline), []);
  assert.equal(compareAuditToBaseline({ advisories: { "1": { severity: "high" }, "2": { severity: "low" } } }, baseline).length, 2);
});
test("upstream baseline provenance remains fixed while repaired locks may remove advisories", () => {
  const baseline = JSON.parse(readFileSync(new URL("../../ragnos-production-audit-baseline.json", import.meta.url), "utf8"));
  assert.doesNotThrow(() => validateAuditBaseline(baseline));
  assert.deepEqual(compareAuditToBaseline(clean, baseline), []);
  for (const replacement of [{ schemaVersion: 2 }, { sourceCommit: "0".repeat(40) },
    { lockfileSha256: "0".repeat(64) }, { advisories: [] }, { advisories: { "1": "unknown" } }])
    assert.throws(() => validateAuditBaseline({ ...baseline, ...replacement }));
});

const baseLockfile = `lockfileVersion: '9.0'
packages:
  content-type@1.0.5:
    resolution: {integrity: synthetic}
  type-is@2.0.1:
    resolution: {integrity: synthetic}
  '@scope/existing@1.0.0':
    resolution: {integrity: synthetic}
snapshots:
  content-type@1.0.5: {}
`;
const lockDiff = patch => [{ filename: "pnpm-lock.yaml", patch }];

test("supply-chain scan admits another version of an existing package without a removal", () => {
  const files = lockDiff("+  content-type@2.1.0:\n+  type-is@2.1.0:\n+  '@scope/existing@2.0.0(peer@1.0.0)':");
  assert.deepEqual(scanSupplyChain(files, baseLockfile), []);
  assert.deepEqual(scanSupplyChain(files), [{ check: "supply-chain", packages: ["content-type", "type-is", "@scope/existing"] }]);
});

test("supply-chain scan still flags truly new package names", () => {
  const files = lockDiff("+  content-type@2.1.0:\n+  '@scope/new-package@1.0.0(peer@1.0.0)':");
  assert.deepEqual(scanSupplyChain(files, baseLockfile), [{ check: "supply-chain", packages: ["@scope/new-package"] }]);
  assert.deepEqual(scanSupplyChain(lockDiff("-  content-type@1.0.5:\n+  content-type@2.1.0:")), []);
});

test("supply-chain scan fails closed on malformed or unavailable supplied base evidence", () => {
  const files = lockDiff("+  content-type@2.1.0:");
  for (const base of [null, "", "not yaml", "lockfileVersion: '9.0'\n", "lockfileVersion: '9.0'\npackages:\n  invalid-entry:\n"]) {
    assert.throws(() => scanSupplyChain(files, base), /base pnpm lockfile|Base pnpm lockfile/);
  }
});
