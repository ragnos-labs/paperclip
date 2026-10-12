# RAGnos local image delivery

RAGnos runs this fork internally. The hosted alpha-release and export workflows
are retired. Existing published tags, images, receipts and release assets stay
available for older installations and recovery; do not delete or replace them.

## Build and publish

Use an isolated clean checkout of the exact merged source. Run `pnpm check`
once before landing; repeat only for changed inputs or unresolved failures.
The existing Dockerfile owns the container build and runtime checks. Build one
image for the deployment target's architecture, with an unused source tag:

```sh
SOURCE_SHA="$(git rev-parse HEAD)"
IMAGE="ghcr.io/ragnos-labs/paperclip:sha-$SOURCE_SHA"
PLATFORM=linux/amd64
docker buildx build --platform "$PLATFORM" --target production \
  --label "org.opencontainers.image.revision=$SOURCE_SHA" \
  --tag "$IMAGE" --load .
```

Set `PLATFORM` to the actual target when it differs. Keep registry credentials
in the existing approved client store. For an authorized publication, use the
ordinary `docker push "$IMAGE"` command and read the resulting digest with
`docker buildx imagetools inspect "$IMAGE"`. Deploy that digest, not a mutable
tag. This path does not publish npm packages or require a GitHub prerelease,
platform matrix, SBOM/provenance, typed confirmation or protected environment.

## Deploy and recover

Use the owning runtime's existing deployment procedure: verify the backup,
update only the affected service, check health and a representative user path,
and keep rollback to the previous compatible digest. Source merge or image
publication does not deploy, activate an authority writer or migrate data.
Reconcile any uncertain push before retrying. If a release fails after a remote
write, preserve its image and local evidence and fix forward with a fresh
source identity. Existing [database recovery](DATABASE.md) and
[Docker custody](DOCKER.md) remain unchanged.
