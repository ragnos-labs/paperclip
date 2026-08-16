import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

function readWorkflow(name) {
  return readFileSync(path.join(repoRoot, ".github/workflows", name), "utf8");
}

test("release workflow delegates manual stable verification to the reusable workflow", () => {
  const releaseWorkflow = readWorkflow("release.yml");

  assert.match(
    releaseWorkflow,
    /verify_stable:\n\s+uses: \.\/\.github\/workflows\/release-verify\.yml\n\s+with:\n\s+ref: \$\{\{ inputs\.source_ref \}\}/,
  );
  assert.doesNotMatch(releaseWorkflow, /verify_(?:canary|stable):[\s\S]*?pnpm test:run(?:\n|$)/);
});

test("source merges cannot publish images, packages, tags, or releases", () => {
  const dockerWorkflow = readWorkflow("docker.yml");
  const releaseWorkflow = readWorkflow("release.yml");

  for (const workflow of [dockerWorkflow, releaseWorkflow]) {
    assert.match(workflow, /on:\n\s+workflow_dispatch:/);
    assert.doesNotMatch(workflow, /\n\s+push:\s*(?:\n|$)/);
    assert.doesNotMatch(workflow, /packages:\s*write/);
    assert.doesNotMatch(workflow, /id-token:\s*write/);
    assert.doesNotMatch(workflow, /contents:\s*write/);
    assert.doesNotMatch(workflow, /git push/);
  }

  assert.doesNotMatch(dockerWorkflow, /docker\/login-action/);
  assert.doesNotMatch(dockerWorkflow, /push:\s*true/);
  assert.doesNotMatch(dockerWorkflow, /cache-to:\s*type=registry/);
  assert.match(dockerWorkflow, /push:\s*false/g);

  assert.match(releaseWorkflow, /--dry-run/);
  assert.doesNotMatch(releaseWorkflow, /publish_(?:canary|stable):/);
  assert.doesNotMatch(releaseWorkflow, /npm publish/);
  assert.doesNotMatch(releaseWorkflow, /Create GitHub Release/);
});

test("release verify workflow covers the same split test surface as stable PR verification", () => {
  const verifyWorkflow = readWorkflow("release-verify.yml");

  assert.match(verifyWorkflow, /workflow_call:/);
  assert.match(verifyWorkflow, /node \.\/scripts\/release-package-map\.mjs check/);
  assert.match(verifyWorkflow, /pnpm -r typecheck/);
  assert.match(verifyWorkflow, /pnpm build/);

  for (const group of ["general-server", "general-workspaces-a", "general-workspaces-b"]) {
    assert.match(verifyWorkflow, new RegExp(`group: ${group}`));
  }

  for (const shardIndex of [0, 1, 2]) {
    assert.match(
      verifyWorkflow,
      new RegExp(`group: general-server[\\s\\S]*?shard_index: ${shardIndex}[\\s\\S]*?shard_count: 3`),
    );
  }

  for (const shardIndex of [0, 1, 2, 3, 4]) {
    assert.match(verifyWorkflow, new RegExp(`shard_index: ${shardIndex}[\\s\\S]*?shard_count: 5`));
  }

  assert.match(verifyWorkflow, /pnpm test:run:general -- --group/);
  assert.match(verifyWorkflow, /pnpm test:run:serialized -- --shard-index/);
});
