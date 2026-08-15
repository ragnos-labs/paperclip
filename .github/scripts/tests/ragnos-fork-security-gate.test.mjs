import assert from "node:assert/strict";
import test from "node:test";
import {
  compareAuditToBaseline,
  filterBootstrapFlags,
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
    line: "+ credential = 'redacted-value'",
  }]);
  assert.deepEqual(sanitized, [{
    check: "secret-scan",
    file: "example.ts",
    pattern: "High-entropy secret",
    packages: undefined,
    advisoryPath: undefined,
  }]);
  assert.equal(JSON.stringify(sanitized).includes("redacted-value"), false);
});

test("allows only the exact one-time bootstrap workflow flag", () => {
  const flags = [
    { check: "ci-tampering", file: ".github/workflows/ragnos-fork-ci.yml" },
    { check: "ci-tampering", file: ".github/workflows/other.yml" },
  ];
  const exact = {
    prNumber: 11,
    baseSha: "19be4cf9278b70bc151063778a94bf38bfd5c903",
    headRef: "codex/ragnos-fork-ci-bootstrap",
  };
  assert.deepEqual(filterBootstrapFlags(flags, exact), [flags[1]]);
  assert.deepEqual(filterBootstrapFlags(flags, { ...exact, prNumber: 12 }), flags);
});
