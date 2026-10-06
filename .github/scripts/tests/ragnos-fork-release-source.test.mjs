import { test } from "node:test";
import assert from "node:assert/strict";
import { forkCiRunId, validateReleaseSource } from "../ragnos-fork-release-source.mjs";
import { blockingFlags } from "../ragnos-fork-security-gate.mjs";
const source = "a".repeat(40);
const checks = [{ name: "RAGnos Fork CI", head_sha: source, status: "completed", conclusion: "success",
  app: { slug: "github-actions" }, details_url: "https://github.com/ragnos-labs/paperclip/actions/runs/1/job/1" }];
const workflowRun = { head_sha: source, conclusion: "success", path: ".github/workflows/ragnos-fork-ci.yml",
  repository: { full_name: "ragnos-labs/paperclip" } };
const valid = { source, branch: source, checks, workflowRun };
test("requires the current maintenance head and green fork CI on that exact commit", () => {
  assert.doesNotThrow(() => validateReleaseSource(valid));
  for (const changed of [{ branch: "b".repeat(40) }, { source: "master" }, { checks: [] },
    { checks: [{ ...checks[0], conclusion: "failure" }] },
    { checks: [{ ...checks[0], status: "in_progress", conclusion: null }] },
    { checks: [{ ...checks[0], head_sha: "b".repeat(40) }] },
    { checks: [{ ...checks[0], app: { slug: "other-app" } }] },
    { workflowRun: null },
    { workflowRun: { ...workflowRun, path: ".github/workflows/other.yml" } },
    { workflowRun: { ...workflowRun, head_sha: "b".repeat(40) } },
    { workflowRun: { ...workflowRun, repository: { full_name: "other/paperclip" } } }]) {
    assert.throws(() => validateReleaseSource({ ...valid, ...changed }));
  }
});
test("selects the green fork CI run when another run for the same commit is unfinished", () => {
  const pending = { ...checks[0], status: "in_progress", conclusion: null,
    details_url: "https://github.com/ragnos-labs/paperclip/actions/runs/2/job/2" };
  assert.equal(forkCiRunId([pending, checks[0]], source), "1");
  assert.equal(forkCiRunId([pending], source), null);
});
test("workflow and process-spawning test findings are reported without blocking; every other finding blocks", () => {
  const flags = [{ check: "ci-tampering", file: ".github/workflows/ragnos-fork-ci.yml" },
    { check: "suspicious-test", file: "scripts/fixture.test.js" },
    { check: "secret-scan", file: "server/test.ts" }, { check: "supply-chain", file: "package.json" }];
  assert.deepEqual(blockingFlags(flags), [flags[2], flags[3]]);
  assert.deepEqual(blockingFlags(flags.slice(0, 2)), []);
});
