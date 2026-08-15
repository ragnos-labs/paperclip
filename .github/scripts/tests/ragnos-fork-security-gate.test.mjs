import assert from "node:assert/strict";
import test from "node:test";
import {
  compareAuditToBaseline,
  sanitizeFlags,
} from "../ragnos-fork-security-gate.mjs";

test("allows existing advisories and removals", () => {
  const baseline = { advisories: { "1": "high", "2": "moderate" } };
  const audit = { advisories: { "1": { severity: "high" } } };
  assert.deepEqual(compareAuditToBaseline(audit, baseline), []);
});

test("blocks new advisories and severity increases", () => {
  const baseline = { advisories: { "1": "moderate" } };
  const audit = {
    advisories: {
      "1": { severity: "high" },
      "2": { severity: "low" },
    },
  };
  assert.deepEqual(compareAuditToBaseline(audit, baseline), [
    "advisory 1 increased from moderate to high",
    "new low advisory 2",
  ]);
});

test("does not emit an added secret line", () => {
  const sanitized = sanitizeFlags([{
    check: "secret-scan",
    file: "example.ts",
    pattern: "High-entropy secret",
    line: "+ token = 'do-not-print-this-value'",
  }]);
  assert.deepEqual(sanitized, [{
    check: "secret-scan",
    file: "example.ts",
    pattern: "High-entropy secret",
    packages: undefined,
    advisoryPath: undefined,
  }]);
  assert.equal(JSON.stringify(sanitized).includes("do-not-print"), false);
});
