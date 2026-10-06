import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

const workflow = readFileSync(new URL("../../workflows/ragnos-alpha-release.yml", import.meta.url), "utf8");
function workflowCommand(name) {
  const step = workflow.split(`      - name: ${name}\n`)[1]?.split("\n      - name: ")[0];
  const command = step?.split("        run: |\n")[1];
  assert.ok(command, `missing workflow command: ${name}`);
  return command.replace(/^ {10}/gm, "");
}

// Run the actual workflow shell and jq guards; every provider command is synthetic.
function runWorkflow(name, { trustedHead = source, run = {}, receipt = {} } = {}) {
  const root = mkdtempSync(join(tmpdir(), "paperclip-release-test-"));
  try {
    const bin = join(root, "bin");
    mkdirSync(bin);
    const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, GH_TOKEN: "synthetic",
      GITHUB_REPOSITORY: "ragnos-labs/paperclip", GITHUB_RUN_ID: "1",
      SOURCE_SHA: source, INPUT_SOURCE_SHA: source, INPUT_VERSION: "0.1.1", VERSION: "0.1.1",
      TRUSTED_HEAD: trustedHead, CALLS: join(root, "calls"), FIXTURES: root,
      GITHUB_OUTPUT: join(root, "output"), GITHUB_STEP_SUMMARY: join(root, "summary"),
      IMAGE_DIGEST: `sha256:${"c".repeat(64)}`, IMAGE_TAG: "ragnos-0.1.1",
      RELEASE_TAG: "ragnos/v0.1.1", CREATED_AT: "2026-01-01T00:00:00Z",
      LAST_MIGRATION: "0001_synthetic.sql", MIGRATION_COUNT: "1",
      MIGRATION_MANIFEST_DIGEST: "d".repeat(64) };
    const shell = command => spawnSync("bash", ["-c", command], {
      cwd: root, env, encoding: "utf8", timeout: 10_000,
    });
    // Exercise the existing producer contract rather than handcrafting its receipt.
    const produced = shell(workflowCommand("Write release receipt"));
    assert.equal(produced.status, 0, produced.stderr);
    const receiptPath = join(root, "release-receipt.json");
    const producedReceipt = JSON.parse(readFileSync(receiptPath, "utf8"));
    renameSync(receiptPath, join(root, "receipt.json"));
    writeFileSync(join(root, "receipt.json"), JSON.stringify({ ...producedReceipt, ...receipt }));
    writeFileSync(join(root, "run.json"), JSON.stringify({
      head_sha: source, head_branch: "codex/paperclip-stable", event: "workflow_dispatch",
      conclusion: "success", path: ".github/workflows/ragnos-alpha-release.yml", ...run,
    }));
    writeFileSync(join(bin, "gh"), `#!/bin/bash
set -eu
printf '%s\\n' "$*" >> "$CALLS"
case "$*" in
  "api repos/ragnos-labs/paperclip/git/ref/heads/codex/paperclip-stable --jq .object.sha") printf '%s\\n' "$TRUSTED_HEAD" ;;
  "api --paginate repos/ragnos-labs/paperclip/actions/artifacts?name=paperclip-ragnos-0.1.1-release-receipt&per_page=100 --jq "*) printf '1\\n' ;;
  "api repos/ragnos-labs/paperclip/actions/runs/1") cat "$FIXTURES/run.json" ;;
  "run download 1 --repo ragnos-labs/paperclip --name paperclip-ragnos-0.1.1-release-receipt") cp "$FIXTURES/receipt.json" release-receipt.json ;;
  *) exit 90 ;;
esac
`, { mode: 0o700 });
    writeFileSync(join(bin, "node"), '#!/bin/bash\nprintf "helper\\n" >> "$CALLS"\n', { mode: 0o700 });
    writeFileSync(join(bin, "git"), '#!/bin/bash\nprintf "git %s\\n" "$*" >> "$CALLS"\n', { mode: 0o700 });
    const result = shell(`${workflowCommand(name)}\nprintf 'effect\\n' >> "$CALLS"`);
    return { ...result,
      calls: readFileSync(env.CALLS, "utf8"),
      output: (() => { try { return readFileSync(env.GITHUB_OUTPUT, "utf8"); } catch { return ""; } })(),
    };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test("trusted workflow head guard blocks a no-op source helper before invocation", () => {
  const rejected = runWorkflow("Validate source and version", { trustedHead: "b".repeat(40) });
  assert.notEqual(rejected.status, 0);
  assert.match(rejected.stderr, /current trusted maintenance head/);
  assert.doesNotMatch(rejected.calls, /helper|^git |effect/m);
  assert.equal(rejected.output, "");
  const admitted = runWorkflow("Validate source and version");
  assert.equal(admitted.status, 0, admitted.stderr);
  assert.match(admitted.calls, /helper\ngit ls-remote origin refs\/tags\/ragnos\/v0\.1\.1\neffect/);
});

test("export consumes the successful publication's existing Actions receipt by digest", () => {
  assert.match(workflow.split("  publish_image:")[0], /actions: read/);
  const result = runWorkflow("Resolve published release");
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.calls, /run download 1 --repo ragnos-labs\/paperclip --name paperclip-ragnos-0\.1\.1-release-receipt/);
  assert.doesNotMatch(result.calls, /release download/);
  assert.equal(result.output, `image=ghcr.io/ragnos-labs/paperclip@sha256:${"c".repeat(64)}\n`);
  assert.match(result.calls, /effect\n$/);
});

test("export rejects unsuccessful or mismatched publication runs before download or effects", () => {
  for (const run of [{ conclusion: "failure" }, { conclusion: null }, { head_sha: "b".repeat(40) },
    { head_branch: "other" }, { event: "push" }, { path: ".github/workflows/other.yml" }]) {
    const result = runWorkflow("Resolve published release", { run });
    assert.notEqual(result.status, 0, JSON.stringify(run));
    assert.doesNotMatch(result.calls, /run download|effect/);
    assert.equal(result.output, "");
  }
});

test("export rejects a receipt with mismatched run, source, version, repository or digest before effects", () => {
  for (const receipt of [{ workflow_run: "https://github.com/ragnos-labs/paperclip/actions/runs/2" },
    { source_sha: "b".repeat(40) }, { version: "0.1.2" }, { repository: "other/paperclip" },
    { image_digest: "latest" }]) {
    const result = runWorkflow("Resolve published release", { receipt });
    assert.notEqual(result.status, 0, JSON.stringify(receipt));
    assert.match(result.calls, /run download/);
    assert.doesNotMatch(result.calls, /effect/);
    assert.equal(result.output, "");
  }
});
