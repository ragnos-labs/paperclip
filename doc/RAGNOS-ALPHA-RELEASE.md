# RAGnos Alpha Release

This runbook publishes a bounded Paperclip backend prerelease for RAGnos. It
publishes one multi-platform OCI image and one GitHub prerelease from the exact
current `master` commit. It does not publish npm packages. It does not deploy or
activate Paperclip.

The upstream Paperclip calendar-version and npm release process remains
separate. A RAGnos release uses its own version, tag, image tag, receipt, and
approval boundary.

## Release identities

The first release uses these names:

- version: `0.1.0-alpha.1`;
- Git tag and GitHub prerelease: `ragnos/v0.1.0-alpha.1`;
- image tag: `ghcr.io/ragnos-labs/paperclip:ragnos-0.1.0-alpha.1`; and
- exact-source image tag:
  `ghcr.io/ragnos-labs/paperclip:sha-<exact-source-commit>`; and
- immutable image identity: the registry digest recorded by the workflow.

Later alpha releases increment the final number. Never reuse a version, Git
tag, or image tag.

## Required controls

Before publication:

1. Merge the intended source through a reviewed pull request whose normal fork
   security source scan passed. The release verifier reruns the production
   dependency audit, but it does not replace the pull-request source scan.
2. Confirm the source is the exact current `master` commit.
3. Enable GitHub immutable releases for the repository.
4. Configure the `paperclip-alpha-release` environment.
5. Disable administrator bypass for that environment.
6. Allow only the `master` deployment branch.
7. Require the available RAGnos release reviewer. If only the initiating
   service identity is available, record that limitation and the separate
   human approval evidence. Do not claim independent GitHub review.
8. Confirm the target Git tag, GitHub release, and image tag do not exist.

The release workflow is
`.github/workflows/ragnos-alpha-release.yml`. All third-party actions on its
publication path use full commit revisions. The workflow gives write authority
only to the environment-gated publication job.

Treat this workflow as the only writer for the `ragnos-*` and `sha-*` tags in
`ghcr.io/ragnos-labs/paperclip`. Its fail-closed preflight prevents known tags
from being reused, but a container registry cannot atomically reserve a tag
between preflight and push. Do not run another writer for these tag namespaces.

## Publish

Resolve the exact current source and dispatch the workflow:

```sh
SOURCE_SHA="$(git ls-remote https://github.com/ragnos-labs/paperclip.git refs/heads/master | awk '{print $1}')"

gh workflow run ragnos-alpha-release.yml \
  --repo ragnos-labs/paperclip \
  --ref master \
  -f source_sha="$SOURCE_SHA" \
  -f version=0.1.0-alpha.1 \
  -f confirmation='PUBLISH PAPERCLIP RAGNOS ALPHA'
```

The reusable release verifier runs first. The environment approval occurs only
after verification succeeds. The publication job checks `master` again and
creates the exact source tag as its first effect. The tag captures the source
that was current at the release decision boundary before the image build starts.

## Required readback

Do not describe the release as published until all of these are true:

```sh
gh release view ragnos/v0.1.0-alpha.1 \
  --repo ragnos-labs/paperclip \
  --json tagName,isPrerelease,targetCommitish,url

docker buildx imagetools inspect \
  ghcr.io/ragnos-labs/paperclip:ragnos-0.1.0-alpha.1
```

Download `release-receipt.json` and `SHA256SUMS` from the GitHub release. Verify
that the release tag resolves to the recorded source commit and that the image
tag resolves to the recorded digest. Confirm the release page identifies the
release as immutable.

The workflow also verifies both image tags, `linux/amd64` and `linux/arm64`, and
the registry-attached SBOM and provenance for each platform. It runs the
non-production company work projection artifact canary against the immutable
image digest before it creates the GitHub prerelease. The canary uses only GET
requests on an internal container network. It runs as non-root with no host
mounts and no database connection. See
[`company-work-projection-canary.md`](company-work-projection-canary.md).

The GitHub release assets are authoritative. They include the canary contract
and canary receipt. The extra workflow artifact is non-authoritative and its
upload is best-effort only.

Publication evidence does not prove deployment or activation. A later owning
distribution must pin the image by digest and record deployment, activation,
and acceptance as separate operations.

## Failure and recovery

The workflow fails closed. Use these rules:

- Before the source tag is created, correct the source or configuration and
  dispatch the same version again.
- If the source tag exists but no image tag exists, hold that partial version.
  Do not delete or replace the tag. Preserve the workflow evidence and fix
  forward with the next alpha version.
- If an image tag exists but the GitHub release was not created, hold that
  partial version. Do not delete or replace the image tag. Audit the digest,
  preserve the workflow evidence, fix forward with the next alpha version, and
  record the partial version as not released.
- If the GitHub release exists but final readback fails, do not delete or
  replace the release or tag. Verify the immutable assets independently. If
  they are correct, add a separate recovery receipt. If they are not correct,
  hold the version and fix forward with the next alpha version.
- Never republish the same version after any registry or GitHub release effect.
- Do not deploy a held or ambiguous release.

Rollback is a distribution operation, not a publication mutation. A runtime
rolls back by pinning the last accepted image digest and applying its documented
database recovery contract. Immutable releases remain historical evidence.
