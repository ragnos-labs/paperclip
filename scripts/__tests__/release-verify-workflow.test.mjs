import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import "../smoke/work-projection-canary.test.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

function readWorkflow(name) {
  return readFileSync(path.join(repoRoot, ".github/workflows", name), "utf8");
}

function readRepoFile(name) {
  return readFileSync(path.join(repoRoot, name), "utf8");
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

test("RAGnos alpha publication is manual, exact-source, protected, and npm-free", () => {
  const alphaWorkflow = readWorkflow("ragnos-alpha-release.yml");

  assert.match(alphaWorkflow, /on:\n\s+workflow_dispatch:/);
  assert.doesNotMatch(alphaWorkflow, /\n\s+(?:push|pull_request|schedule):\s*(?:\n|$)/);
  for (const input of ["source_sha", "version", "confirmation"]) {
    assert.match(alphaWorkflow, new RegExp(`\\n\\s{6}${input}:`));
  }

  assert.match(
    alphaWorkflow,
    /verify_source:\n\s+uses: \.\/\.github\/workflows\/release-verify\.yml\n\s+with:\n\s+ref: \$\{\{ inputs\.source_sha \}\}/,
  );
  assert.match(alphaWorkflow, /environment:\n\s+name: paperclip-alpha-release/);
  assert.match(alphaWorkflow, /contents: write/);
  assert.match(alphaWorkflow, /packages: write/);
  assert.match(alphaWorkflow, /git ls-remote origin refs\/heads\/master/);
  assert.match(alphaWorkflow, /git rev-parse HEAD/);
  assert.match(alphaWorkflow, /\^\[0-9a-f\]\{40\}\$/);
  assert.match(alphaWorkflow, /PUBLISH PAPERCLIP RAGNOS ALPHA/);

  assert.match(alphaWorkflow, /ghcr\.io\/\$\{\{ github\.repository \}\}/);
  assert.match(alphaWorkflow, /image_tag="ragnos-\$\{INPUT_VERSION\}"/);
  assert.match(alphaWorkflow, /release_tag="ragnos\/v\$\{INPUT_VERSION\}"/);
  assert.match(alphaWorkflow, /target: production/);
  assert.match(alphaWorkflow, /platforms: linux\/amd64,linux\/arm64/);
  assert.match(alphaWorkflow, /push: true/);
  assert.match(alphaWorkflow, /sbom: true/);
  assert.match(alphaWorkflow, /provenance: mode=max/);
  assert.match(alphaWorkflow, /scripts\/smoke\/work-projection-canary\.sh/);
  assert.match(alphaWorkflow, /paperclip\.company-work-projection-canary\/v1/);
  assert.match(alphaWorkflow, /verified_get_only_no_persistent_state/);
  assert.match(alphaWorkflow, /containersRemaining: 0/);
  assert.match(alphaWorkflow, /networksRemaining: 0/);

  assert.match(alphaWorkflow, /release-receipt\.json/);
  assert.match(alphaWorkflow, /SHA256SUMS/);
  assert.match(alphaWorkflow, /migration_manifest_digest/);
  assert.match(alphaWorkflow, /docker buildx imagetools inspect/);
  assert.match(alphaWorkflow, /gh release create/);
  assert.match(alphaWorkflow, /gh release view/);
  assert.doesNotMatch(alphaWorkflow, /npm publish|pnpm publish|dist-tag/);
});

test("RAGnos alpha publication fails closed and proves every published identity", () => {
  const workflow = readWorkflow("ragnos-alpha-release.yml");

  assert.match(workflow, /require_registry_reference_absent/);
  assert.match(workflow, /registry-reference-guard\.mjs/);
  assert.match(workflow, /VERSION_IMAGE_TAG/);
  assert.match(workflow, /SOURCE_IMAGE_TAG/);
  assert.doesNotMatch(workflow, /grep -Eqi/);
  assert.match(workflow, /source_image:/);
  assert.match(workflow, /source_image_digest:/);
  assert.match(workflow, /linux\/amd64/);
  assert.match(workflow, /linux\/arm64/);
  assert.match(workflow, /\.SBOM/);
  assert.match(workflow, /\.Provenance/);
  assert.match(workflow, /isImmutable/);
  assert.match(workflow, /sha256sum -c SHA256SUMS/);
  assert.match(workflow, /work-projection-canary-receipt\.json/);

  const tagCreation = workflow.indexOf("Create exact source tag");
  const imagePush = workflow.indexOf("Build and publish release image");
  assert.ok(tagCreation > 0, "source tag creation step is required");
  assert.ok(imagePush > tagCreation, "the exact source tag must be created before the image push");
  assert.match(workflow, /--verify-tag/);
  assert.match(workflow, /packages\/db\/src\/migrations\/meta\/_journal\.json/);
});

test("release verify workflow covers the same split test surface as stable PR verification", () => {
  const verifyWorkflow = readWorkflow("release-verify.yml");

  assert.match(verifyWorkflow, /workflow_call:/);
  assert.match(verifyWorkflow, /node \.\/scripts\/release-package-map\.mjs check/);
  assert.match(verifyWorkflow, /pnpm -r typecheck/);
  assert.match(verifyWorkflow, /pnpm build/);
  assert.match(verifyWorkflow, /server\/dist\/canary\/work-projection-server\.js/);

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
  assert.doesNotMatch(verifyWorkflow, /pnpm install --no-frozen-lockfile/);
  assert.match(verifyWorkflow, /pnpm install --frozen-lockfile/);
  assert.match(verifyWorkflow, /ragnos-fork-security-gate\.test\.mjs/);
  assert.match(verifyWorkflow, /registry-reference-guard\.test\.mjs/);
  assert.match(verifyWorkflow, /ragnos-fork-security-gate\.mjs --audit-only/);
  assert.match(verifyWorkflow, /release-verify-workflow\.test\.mjs/);
  assert.match(verifyWorkflow, /pnpm run test:e2e/);
});

test("the alpha publication path uses immutable third-party action revisions", () => {
  for (const name of ["release-verify.yml", "ragnos-alpha-release.yml"]) {
    const workflow = readWorkflow(name);
    const uses = [...workflow.matchAll(/^\s*uses:\s+([^\s#]+)/gm)].map((match) => match[1]);
    assert.ok(uses.length > 0, `${name} must use at least one action or reusable workflow`);
    for (const action of uses) {
      if (action.startsWith("./")) continue;
      assert.match(action, /^[^@\s]+@[0-9a-f]{40}$/, `${name} has a mutable action reference: ${action}`);
    }
  }
});

test("the RAGnos alpha runbook separates publication, deployment, and recovery", () => {
  const runbook = readRepoFile("doc/RAGNOS-ALPHA-RELEASE.md");

  assert.match(runbook, /\.github\/workflows\/ragnos-alpha-release\.yml/);
  assert.match(runbook, /paperclip-alpha-release/);
  assert.match(runbook, /ragnos\/v0\.1\.0-alpha\.1/);
  assert.match(runbook, /ghcr\.io\/ragnos-labs\/paperclip:ragnos-0\.1\.0-alpha\.1/);
  assert.match(runbook, /does not publish npm packages/i);
  assert.match(runbook, /does not deploy or\s+activate/i);
  assert.match(runbook, /do not delete or replace/i);
  assert.match(runbook, /fix forward/i);
  assert.match(runbook, /immutable releases/i);
  assert.match(runbook, /workflow artifact.*non-authoritative/i);
});
