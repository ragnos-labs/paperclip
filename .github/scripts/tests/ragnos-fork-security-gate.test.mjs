import assert from "node:assert/strict";
import test from "node:test";
import { compareAuditToBaseline, validateAuditCommandResult } from "../ragnos-fork-security-gate.mjs";
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
