# RAGnos Paperclip maintenance fork

The maintenance line starts at upstream `v2026.1001.0`, commit
`8f8a0ab7effbd6a0584107d8038736c134ee5047`. Changes outside the bounded
Hermes cancellation, positive connection-refusal retry and accepted-job
observation patch set remain on their existing fork branches.

The operator surface also uses the bounded [company SSE invalidation feed](company-live-events.md).
It reuses native company access and the existing event publisher without
changing the WebSocket API, task records or database schema.

## Patch sources

Fork PR [23](https://github.com/ragnos-labs/paperclip/pull/23) supplies cancellation
and positive `ECONNREFUSED` bootstrap retry. PR
[24](https://github.com/ragnos-labs/paperclip/pull/24) supplies immutable accepted
job binding and detach contracts. Cherry-pick trailers preserve original commits:

| Original commit | Maintenance commit | Purpose |
| --- | --- | --- |
| `96931d18bb8102a0c530c598a4098437b8b0da0b` | `6132cb484` | Yi cancellation implementation |
| `016b45f4` | `a98d6ff68` | Yi attribution |
| `4f1b6fa9` | `1c5064cd6` | Native stop and terminal proof |
| `9bd60bee` | `63631fad0` | Diagnostics cannot prevent stop |
| `8f2e7d8e` | `ad7260c14` | Positive connection-refusal retry |
| `6713375d181fe82bb20b6e46fcc103d776164126` | `2aecce9c5` | Remote binding and detach adapter contracts |
| `91f3e7b68ebccd9e415e1a342ca3b0e40a5edbb4` | `92655ed75` | Initial observer host integration |

The source attribution supplied by the original authors stays in the adapter.
The finished-registration race guard follows upstream Paperclip
[PR 14523](https://github.com/paperclipai/paperclip/pull/14523), head
`07065c1477ac652c35790ffb631cb4e31b7c10a8`.
Upstream-only workflow guards follow the repository-identity approach proposed
in [PR 9337](https://github.com/paperclipai/paperclip/pull/9337).
No optional Hermes endpoint or unsupported reservation-stop protocol is admitted.

## Recovery contract

Accepted work resumes observation of the same run UUID, native job, company,
transport fingerprint, task lock and original deadline. Recovery is GET-only.
Dispatch suppression is checked after accepted observation admission. Paused or
terminated agents, changed credentials/configuration, unavailable logs and
uncertain dispatch evidence hold the accepted run; they do not authorize replay.

Observer leases fence mutable run, runtime, session, wakeup and issue projections
inside database transactions. Log appends and finalization hold the same run row
lock as takeover. Recovery validates the existing JSONL prefix, byte length,
sequence and hash without truncation. Shutdown and ownership loss detach; board
cancellation requires native stop and terminal proof. Duplicate accepted-binding
callbacks preserve the original identity and deadline.

A held run ends without a database edit when Hermes reports `run_not_found` for
both its stop and status requests, for example after a gateway restart. The run
finishes failed with `hermes_gateway_provider_run_missing` and the agent is
released. While Hermes still knows the run and has not confirmed termination,
the run stays held.

## Validation and release

Use the supported Node engine and `pnpm install --frozen-lockfile`. Embedded
PostgreSQL integration tests are mandatory and never skip a native-loader error.
When local dependency lifecycle scripts are disabled, run the installed native
package's reviewed `scripts/hydrate-symlinks.js` before integration tests; do not
change the global package-script policy.

The default operator release path runs validation and builds on the existing
AMD64 VPS. GitHub Actions stays disabled; a local release does not require a
GitHub check status. The optional `RAGnos Fork CI` workflow runs the same
typecheck, tests, build, browser validation and fork security script checks when
explicitly used. Secret, supply-chain, build-script and sensitive-path
findings block. Workflow changes and process-spawning tests are printed for the
change author and do not block. The production dependency audit checks the
current lockfile against the unchanged advisory baseline from the original
upstream lockfile. The baseline retains that upstream source and lockfile hash;
compatible repairs may remove advisories, while added advisories or severity
increases fail. The baseline does not certify inherited dependencies secure.

Pending human-only confirmation interactions suppress issue wakes at admission,
queued dispatch, and dependency recovery regardless of their continuation policy.
Resolve them through the authenticated interaction API before requesting more
work. A manual or comment wake does not resolve a confirmation.

The inherited dependency chains are repaired with supported parent updates and
scoped overrides: Cursor SDK 1.0.36 removes old Undici/Busboy; Svix 1.99.1 removes
UUID 10; Mermaid uses KaTeX 0.18.2; Typography uses selector-parser 7.1.6;
body-parser uses 2.3.0; MCP SDK uses its patched 1.31.0 release. Drizzle's unused
legacy loader dependency is removed through pnpm's scoped removal override.
The actual TypeScript configuration and migration generation paths are tested.

The production audit reports no critical, high or moderate findings. Its one low
`cli@0.3.1` report has no dependency paths and refers to the unrelated npm `cli`
package. This workspace directory is named `cli`, but its package is `paperclipai`;
no registry `cli` package is installed. Keep this report visible, with the
existing audit checks and advisory baseline unchanged. Do not suppress it by
renaming the workspace or expanding the baseline.

### Default self-hosted release

Use a clean isolated checkout of the exact merged `codex/paperclip-stable` head,
with Node 24, pnpm 9.15.4, the package-owned Rust toolchain, Chrome, `jq`, `lsof`
and OpenSSH. Port-owner tests require `lsof`; Railway key tests require
`/usr/bin/ssh-keygen`. Run as an
unprivileged build user: embedded PostgreSQL cannot start as root. Keep production
credentials, database URLs and the live Paperclip home out of the validation
environment. The browser suite creates its own throwaway instance and port.
Do not interpret a native PostgreSQL startup/loader failure as a passing test.

From that checkout, run the existing checks without altering their selection:

```sh
test -z "$(git status --porcelain)"
test "$(git rev-parse HEAD)" = "$(git rev-parse origin/codex/paperclip-stable)"
test "$(node -p 'process.versions.node.split(".")[0]')" = 24
test "$(pnpm --version)" = 9.15.4
pnpm install --frozen-lockfile
node --test .github/scripts/tests/ragnos-fork-security-gate.test.mjs .github/scripts/tests/ragnos-fork-release-source.test.mjs .github/scripts/tests/registry-reference-guard.test.mjs
GITHUB_EVENT_NAME=push GITHUB_REPOSITORY=ragnos-labs/paperclip GITHUB_SHA="$(git rev-parse HEAD)" node .github/scripts/ragnos-fork-security-gate.mjs
pnpm -r typecheck
pnpm test:run
pnpm build
pnpm --filter @paperclipai/paperclip-runner build:binary
PAPERCLIP_E2E_SKIP_LLM=true PAPERCLIP_PLAYWRIGHT_CHANNEL=chrome pnpm test:e2e
git diff --check
```

The security command's existing push mode scans the exact source against the
original upstream baseline and runs the unchanged production advisory check.
It needs no GitHub API token. Audit unavailability, new advisories, increased
severity or blocking source findings fail the release. Retain bounded check logs
in existing private operator custody; repair failures before building the release.

Build only `linux/amd64` from the same merged source. The existing Dockerfile's
`production` target remains the standard option. Set `PAPERCLIP_BUILD_COMMIT` to that full source SHA and
`PAPERCLIP_BUILD_VERSION` to the next operator release, for example
`ragnos/v0.1.4`; do not change upstream package version `0.3.1`. A local tag is
only a convenient name. Select the resulting image by its immutable digest (the
local Docker image ID for a loaded image, or the manifest digest for an OCI or
registry delivery), and retain the previous image for rollback.

For the next local release, the existing build command is:

```sh
docker buildx build --platform linux/amd64 --target production --load \
  --build-arg PAPERCLIP_BUILD_COMMIT="$(git rev-parse HEAD)" \
  --build-arg PAPERCLIP_BUILD_VERSION=ragnos/v0.1.4 \
  --label org.opencontainers.image.revision="$(git rev-parse HEAD)" \
  --tag paperclip:ragnos-0.1.4 .
docker image inspect paperclip:ragnos-0.1.4 --format '{{.Id}}'
```

To preserve installed global CLI versions, the operator may instead build the
existing Dockerfile's `build` target with the same exact source commit argument,
then use that compiled image and the installed production image as digest-pinned
inputs to a small local assembly recipe. Start the final stage from the installed
production image, remove its old `/app`, and `COPY --chown=node:node` the complete
`/app` from the compiled build stage. The build target already removes Rust target
directories. Set `PAPERCLIP_BUILD_VERSION`, `PAPERCLIP_BUILD_COMMIT` and the image's
revision/version labels to the new release. Preserve the base image's entrypoint,
command, runtime environment and global tools. This avoids rerunning the
production stage's global CLI `@latest` installs.

Use this option while the production runtime and entrypoint contract are
unchanged. Install a demonstrated missing OS dependency from the source
Dockerfile's apt set in the assembly recipe, preserving the installed global
CLI versions. Other runtime changes use the standard production target.
The complete replacement `/app` must come from the new compiled source, not an
overlay that leaves deleted files behind. All native PostgreSQL, typecheck, test,
browser and security/advisory checks above still apply to that source. Runtime
reuse does not authorize reuse of an old application or unvalidated native binary.

The existing Dockerfile caches dependency and native runner layers separately
from ordinary server/UI source. Reuse those layers and the existing Cargo target
cache when their inputs are unchanged. No supported prebuilt-binary bypass exists
in the native build/test path: server preparation and native integration tests
call Cargo's freshness check. Copying only an old binary into a new checkout must
not substitute for that check or drop integration tests. A cold cache may compile
Rust; it is not a reason to bypass validation.

CompanyOS owns the existing backup, digest selection and affected-service swap.
Verify the backup, replace only Paperclip, check health and the authenticated user
path, and roll back to the retained old digest if either fails. This local path
adds no standing runner, daemon, GitHub settings, npm publication or extra gate.

### Optional GitHub release

If explicitly selected instead, dispatch `RAGnos Paperclip Fork Release` with the current
`codex/paperclip-stable` head and a new version. The workflow checks that the
commit is the branch head with green `RAGnos Fork CI`, builds one `linux/amd64`
image with the layer cache, pushes it to `ghcr.io/ragnos-labs/paperclip`, tags
the source `ragnos/v0.x.x` after the push, and uploads a small JSON receipt with
the image digest and migration identity. CompanyOS selects the image by that
digest. The workflow never publishes npm, deploys CompanyOS or activates agents.

This fork serves one operator on one AMD64 host. Do not add any of the following
back to the fork's delivery or release path unless Hunter asks for it by name:
additional image platforms, SBOM or provenance gates, independent-review receipts
or review commit statuses, a typed confirmation phrase, a protected-environment
approval, an immutable GitHub release, or checksum and attestation readback. An
agent that believes one of them is needed proposes it and waits for a yes.

## Upstream integration rehearsal

Use an isolated rehearsal branch to merge a selected newer upstream commit into
the maintenance candidate. Record the selected commit and conflict resolutions,
then run frozen install and the mandatory recovery checks. Do not push rehearsal
results to production or introduce an automated update service. When upstream
provides equivalent accepted-job recovery, remove the matching downstream patch
only after these invariants pass against that exact upstream source.

The standalone bundled-plugin SDK bootstrap fix is the bounded plugin subset of
upstream [PR 13363](https://github.com/paperclipai/paperclip/pull/13363), head
`1e96e1a469181c9691a1d6f42997ab78f2dfb99f`. It repairs the two reproduced HTTP
400 responses with explicit SDK linking when install lifecycle scripts are off.
Document/conversation changes from that proposal are not included.

## Private image delivery

If the host cannot pull the private registry package, dispatch the release
workflow with `export_only: true`, the existing release version and its source
SHA. Download `paperclip-private-image` with `gh run download` and transfer it
to private host custody. Import the OCI archive into Docker's containerd image
store, selecting `linux/amd64`, and verify the selected digest before replacement.
This exports the published bytes; it creates no release and rebuilds no image.
