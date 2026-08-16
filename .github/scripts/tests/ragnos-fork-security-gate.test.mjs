import assert from "node:assert/strict";
import test from "node:test";
import {
  compareAuditToBaseline,
  filterApprovedPaperclipAlphaFlags,
  filterApprovedReleaseSafetyFlags,
  filterBootstrapFlags,
  sanitizeFlags,
} from "../ragnos-fork-security-gate.mjs";

test("allows only the exact Paperclip alpha release pull request flags", () => {
  const flags = [
    { check: "ci-tampering", file: ".github/workflows/ragnos-alpha-release.yml" },
    { check: "ci-tampering", file: ".github/workflows/release-verify.yml" },
    {
      check: "suspicious-test",
      file: ".github/scripts/tests/registry-reference-guard.test.mjs",
      pattern: "shell-exec",
    },
  ];
  const exact = {
    prNumber: 16,
    headRef: "codex/paperclip-ragnos-alpha-release",
    apiHeadRef: "codex/paperclip-ragnos-alpha-release",
    headSha: "90e519b660bdbf2f4f0fa357d4eef51e36c96511",
  };

  assert.deepEqual(filterApprovedPaperclipAlphaFlags(flags, exact), []);
  assert.deepEqual(filterApprovedPaperclipAlphaFlags(flags, { ...exact, prNumber: 17 }), flags);
  assert.deepEqual(filterApprovedPaperclipAlphaFlags(flags, { ...exact, headRef: "codex/other" }), flags);
  assert.deepEqual(filterApprovedPaperclipAlphaFlags(flags, { ...exact, apiHeadRef: "codex/other" }), flags);
  assert.deepEqual(filterApprovedPaperclipAlphaFlags(flags, { ...exact, headSha: "0".repeat(40) }), flags);
  assert.deepEqual(filterApprovedPaperclipAlphaFlags(flags.slice(0, 2), exact), flags.slice(0, 2));
  assert.deepEqual(filterApprovedPaperclipAlphaFlags([
    ...flags,
    { check: "ci-tampering", file: ".github/workflows/other.yml" },
  ], exact).length, 4);
});

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

test("allows only the exact release-safety pull request flags", () => {
  const flags = [
    { check: "ci-tampering", file: ".github/workflows/docker.yml" },
    { check: "ci-tampering", file: ".github/workflows/release.yml" },
  ];
  const exact = {
    prNumber: 13,
    headRef: "codex/release-source-merge-safety",
    apiHeadRef: "codex/release-source-merge-safety",
    headSha: "4ecf095b037c7ddafb2dfc99e0d57974ff3fda88",
  };

  assert.deepEqual(filterApprovedReleaseSafetyFlags(flags, exact), []);
  assert.deepEqual(filterApprovedReleaseSafetyFlags(flags, { ...exact, prNumber: 14 }), flags);
  assert.deepEqual(filterApprovedReleaseSafetyFlags(flags, { ...exact, headRef: "codex/other" }), flags);
  assert.deepEqual(filterApprovedReleaseSafetyFlags(flags, { ...exact, apiHeadRef: "codex/other" }), flags);
  assert.deepEqual(filterApprovedReleaseSafetyFlags(flags, { ...exact, headSha: "0".repeat(40) }), flags);
});

test("keeps every release-safety flag when the detected set is not exact", () => {
  const exact = {
    prNumber: 13,
    headRef: "codex/release-source-merge-safety",
    apiHeadRef: "codex/release-source-merge-safety",
    headSha: "4ecf095b037c7ddafb2dfc99e0d57974ff3fda88",
  };
  const missing = [
    { check: "ci-tampering", file: ".github/workflows/docker.yml" },
  ];
  const extra = [
    ...missing,
    { check: "ci-tampering", file: ".github/workflows/release.yml" },
    { check: "ci-tampering", file: ".github/workflows/other.yml" },
  ];
  const wrongCheck = [
    { check: "build-script", file: ".github/workflows/docker.yml" },
    { check: "ci-tampering", file: ".github/workflows/release.yml" },
  ];

  assert.deepEqual(filterApprovedReleaseSafetyFlags(missing, exact), missing);
  assert.deepEqual(filterApprovedReleaseSafetyFlags(extra, exact), extra);
  assert.deepEqual(filterApprovedReleaseSafetyFlags(wrongCheck, exact), wrongCheck);
});
