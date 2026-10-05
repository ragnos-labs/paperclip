import { test } from "node:test";
import assert from "node:assert/strict";
import { validateReviewedReleaseSource, reviewPermissionApiRoute } from "../ragnos-fork-release-source.mjs";
import { requireIndependentInfrastructureReview } from "../ragnos-fork-security-gate.mjs";
const source = "a".repeat(40);
const statuses = ["ragnos/fork-source-review", "ragnos/fork-infrastructure-review"].map(context => ({
  context, state: "success", url: `https://api.github.com/repos/ragnos-labs/paperclip/statuses/${source}`,
  target_url: "https://github.com/ragnos-labs/paperclip/pull/1#pullrequestreview-2",
}));
const reviews = Object.fromEntries(["source", "infrastructure"].map(scope => [scope, {
  html_url: "https://github.com/ragnos-labs/paperclip/pull/1#pullrequestreview-2", commit_id: source,
  state: "COMMENTED", submitted_at: "2026-10-05T00:00:00Z", author_association: "NONE", user: { id: 42, login: "reviewer" },
  body: "```ragnos-review\n" + JSON.stringify({ schema: "ragnos_fork_independent_review/v1", source_sha: source,
    scope, decision: "pass", independent: true, reviewer: `/root/${scope === "source" ? "recovery_review" : "release_review"}`, blockers: [] }) + "\n```",
}]));
const checks = [{ name: "RAGnos Fork CI", head_sha: source, status: "completed", conclusion: "success",
  app: { slug: "github-actions" }, details_url: "https://github.com/ragnos-labs/paperclip/actions/runs/1/job/1" }];
const workflowRun = { head_sha: source, conclusion: "success", path: ".github/workflows/ragnos-fork-ci.yml",
  repository: { full_name: "ragnos-labs/paperclip" } };
const reviewPermissions = Object.fromEntries(["source", "infrastructure"].map(scope => [scope, { permission: "write", user: { id: 42, login: "reviewer" } }]));
const valid = { source, branch: source, statuses, checks, reviews, reviewPermissions, workflowRun };
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
  assert.deepEqual(requireIndependentInfrastructureReview(flags, statuses, source, reviews.infrastructure, reviews.source, reviewPermissions), [flags[1]]);
  assert.deepEqual(requireIndependentInfrastructureReview(flags, statuses, "b".repeat(40), null, null, reviewPermissions), flags);
  assert.deepEqual(requireIndependentInfrastructureReview(flags, [], source, null, null, reviewPermissions), flags);
});

test("rejects stale, held, unrelated, forged-app and wrong-workflow receipts", () => {
  for (const changed of [ { reviews: {} }, { reviews: { ...reviews, source: { ...reviews.source, commit_id: "b".repeat(40) } } },
    { reviews: { ...reviews, source: { ...reviews.source, state: "PENDING" } } },
    { reviews: { ...reviews, source: { ...reviews.source, body: reviews.source.body.replace('"pass"', '"hold"') } } },
    { checks: [{ ...checks[0], app: { slug: "other-app" } }] },
    { workflowRun: { ...workflowRun, path: ".github/workflows/other.yml" } },
    { workflowRun: { ...workflowRun, head_sha: "b".repeat(40) } } ])
    assert.throws(() => validateReviewedReleaseSource({ ...valid, ...changed }));
});

test("only a current explicit test finding disposition can admit a process-spawning test", () => {
  const flags = [{ check: "suspicious-test", file: "scripts/fixture.test.js" }, { check: "secret-scan", file: "scripts/fixture.test.js" }];
  assert.deepEqual(requireIndependentInfrastructureReview(flags, statuses, source, reviews.infrastructure, reviews.source, reviewPermissions), flags);
  const reviewed = { ...reviews.source, body: reviews.source.body.replace('"blockers":[]', '"blockers":[],"accepted_findings":[{"check":"suspicious-test","file":"scripts/fixture.test.js","reason":"Reviewed repository CLI with synthetic local inputs only"}]') };
  assert.deepEqual(requireIndependentInfrastructureReview(flags, statuses, source, reviews.infrastructure, reviewed, reviewPermissions), [flags[1]]);
  assert.deepEqual(requireIndependentInfrastructureReview(flags, statuses, "b".repeat(40), reviews.infrastructure, reviewed, reviewPermissions), flags);
});

test("author authority is independently read and bound to the submitted identity", () => {
  assert.doesNotThrow(() => validateReviewedReleaseSource(valid));
  assert.equal(reviewPermissionApiRoute(reviews.source), "collaborators/reviewer/permission");
  for (const permission of [null, { permission: "read", user: reviews.source.user },
    { permission: "admin", user: { id: 43, login: "reviewer" } },
    { permission: "admin", user: { id: 42, login: "other" } }])
    assert.throws(() => validateReviewedReleaseSource({ ...valid, reviewPermissions: { ...reviewPermissions, source: permission } }));
  for (const user of [null, { id: 0, login: "reviewer" }, { id: 42, login: "other/permission" }])
    assert.throws(() => reviewPermissionApiRoute({ user }));
});
