import assert from "node:assert/strict";
import test from "node:test";
import {
  compareAuditToBaseline,
  filterApprovedPaperclipAuthorityReleaseFlags,
  filterApprovedReleaseSafetyFlags,
  filterBootstrapFlags,
  sanitizeFlags,
  validateAuditCommandResult,
} from "../ragnos-fork-security-gate.mjs";

const validAudit = {
  advisories: {},
  metadata: { vulnerabilities: { info: 0, low: 0, moderate: 0, high: 0, critical: 0 } },
};

test("accepts valid pnpm audit results with clean or advisory exit status", () => {
  for (const status of [0, 1]) {
    assert.deepEqual(validateAuditCommandResult({
      status,
      signal: null,
      stdout: JSON.stringify(validAudit),
      stderr: "",
    }), validAudit);
  }
});

test("rejects failed, malformed, and error-shaped pnpm audit results", () => {
  const cases = [
    { status: 2, signal: null, stdout: JSON.stringify(validAudit), stderr: "registry unavailable" },
    { status: 0, signal: "SIGTERM", stdout: JSON.stringify(validAudit), stderr: "" },
    { status: 0, signal: null, stdout: "not-json", stderr: "" },
    { status: 1, signal: null, stdout: JSON.stringify({ error: { summary: "registry error" } }), stderr: "" },
    { status: 0, signal: null, stdout: JSON.stringify({ advisories: {} }), stderr: "" },
    { status: 0, signal: null, stdout: JSON.stringify({ metadata: validAudit.metadata }), stderr: "" },
  ];

  for (const result of cases) {
    assert.throws(() => validateAuditCommandResult(result));
  }
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

test("allows only the exact Paperclip alpha release pull request flags", async () => {
  const { filterApprovedPaperclipAlphaFlags } = await import("../ragnos-fork-security-gate.mjs");
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

test("allows only the exact Paperclip work projection canary pull request flags", async () => {
  const { filterApprovedPaperclipWorkProjectionCanaryFlags } = await import("../ragnos-fork-security-gate.mjs");
  const flags = [
    {
      check: "secret-scan",
      file: "scripts/smoke/work-projection-canary.sh",
      pattern: "High-entropy secret",
    },
    { check: "ci-tampering", file: ".github/workflows/ragnos-alpha-release.yml" },
    { check: "ci-tampering", file: ".github/workflows/release-verify.yml" },
  ];
  const exact = {
    prNumber: 18,
    headRef: "feat/nonmutating-work-projection-canary",
    apiHeadRef: "feat/nonmutating-work-projection-canary",
    headSha: "95f277d77b9f3a4e555aac581e8aff3c953f330d",
  };

  assert.deepEqual(filterApprovedPaperclipWorkProjectionCanaryFlags(flags, exact), []);

  const negativeCases = [
    { flags, context: { ...exact, prNumber: 19 } },
    { flags, context: { ...exact, headRef: "feat/other" } },
    { flags, context: { ...exact, apiHeadRef: "feat/other" } },
    { flags, context: { ...exact, headSha: "0".repeat(40) } },
    { flags: flags.filter((_, index) => index !== 0), context: exact },
    { flags: flags.filter((_, index) => index !== 1), context: exact },
    { flags: flags.filter((_, index) => index !== 2), context: exact },
    {
      flags: [...flags, { check: "ci-tampering", file: ".github/workflows/other.yml" }],
      context: exact,
    },
    {
      flags: flags.map((flag, index) => index === 0
        ? { ...flag, check: "suspicious-test" }
        : flag),
      context: exact,
    },
    {
      flags: flags.map((flag, index) => index === 0
        ? { ...flag, file: "scripts/smoke/other.sh" }
        : flag),
      context: exact,
    },
    {
      flags: flags.map((flag, index) => index === 0
        ? { ...flag, pattern: "Generic secret pattern" }
        : flag),
      context: exact,
    },
  ];

  for (const candidate of negativeCases) {
    assert.deepEqual(
      filterApprovedPaperclipWorkProjectionCanaryFlags(candidate.flags, candidate.context),
      candidate.flags,
    );
  }
});

test("allows only the exact Paperclip authority release pull request flag", () => {
  const flags = [
    { check: "ci-tampering", file: ".github/workflows/ragnos-alpha-release.yml" },
  ];
  const exact = {
    prNumber: 21,
    headRef: "codex/paperclip-alpha3-authority-release",
    apiHeadRef: "codex/paperclip-alpha3-authority-release",
    headSha: "346c89a62a89885dc7f9f30989028bcedef59853",
  };

  assert.deepEqual(filterApprovedPaperclipAuthorityReleaseFlags(flags, exact), []);

  const negativeCases = [
    { flags, context: { ...exact, prNumber: 22 } },
    { flags, context: { ...exact, headRef: "codex/other" } },
    { flags, context: { ...exact, apiHeadRef: "codex/other" } },
    { flags, context: { ...exact, headSha: "0".repeat(40) } },
    { flags: [], context: exact },
    {
      flags: [...flags, { check: "ci-tampering", file: ".github/workflows/other.yml" }],
      context: exact,
    },
    {
      flags: flags.map((flag) => ({ ...flag, check: "secret-scan" })),
      context: exact,
    },
  ];

  for (const candidate of negativeCases) {
    assert.deepEqual(
      filterApprovedPaperclipAuthorityReleaseFlags(candidate.flags, candidate.context),
      candidate.flags,
    );
  }
});
