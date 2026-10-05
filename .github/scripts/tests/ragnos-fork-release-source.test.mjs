import { test } from "node:test";
import assert from "node:assert/strict";
import { validateReviewedReleaseSource } from "../ragnos-fork-release-source.mjs";
import { requireIndependentInfrastructureReview } from "../ragnos-fork-security-gate.mjs";
const source = "a".repeat(40);
const statuses = ["ragnos/fork-source-review", "ragnos/fork-infrastructure-review"].map(context => ({
  context, state: "success", url: `https://api.github.com/repos/ragnos-labs/paperclip/statuses/${source}`,
  target_url: "https://github.com/ragnos-labs/paperclip/pull/1",
}));
const checks = [{ name: "RAGnos Fork CI", head_sha: source, status: "completed", conclusion: "success" }];
const valid = { source, branch: source, statuses, checks };
test("requires current maintenance head, both exact independent reviews, and green fork CI", () => {
  assert.doesNotThrow(() => validateReviewedReleaseSource(valid));
  for (const changed of [{ branch: "b".repeat(40) }, { source: "master" }, { statuses: [] },
    { checks: [] }, { checks: [{ ...checks[0], conclusion: "failure" }] },
    { statuses: [{ ...statuses[0], state: "pending" }, statuses[1]] },
    { statuses: [{ ...statuses[0], url: `https://api.github.com/repos/ragnos-labs/paperclip/statuses/${"b".repeat(40)}` }, statuses[1]] }]) {
    assert.throws(() => validateReviewedReleaseSource({ ...valid, ...changed }));
  }
});
test("infrastructure review cannot waive other scanner findings or use a historical commit", () => {
  const flags = [{ check: "ci-tampering", file: ".github/workflows/ragnos-fork-ci.yml" }, { check: "secret-scan", file: "server/test.ts" }];
  assert.deepEqual(requireIndependentInfrastructureReview(flags, statuses, source), [flags[1]]);
  assert.deepEqual(requireIndependentInfrastructureReview(flags, statuses, "b".repeat(40)), flags);
  assert.deepEqual(requireIndependentInfrastructureReview(flags, [], source), flags);
});
