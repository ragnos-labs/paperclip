# RAGnos Paperclip maintenance fork

The maintenance line starts at upstream `v2026.1001.0`, commit
`8f8a0ab7effbd6a0584107d8038736c134ee5047`. Changes outside the bounded
Hermes cancellation, positive connection-refusal retry and accepted-job
observation patch set remain on their existing fork branches.

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

## Validation and release

Use the supported Node engine and `pnpm install --frozen-lockfile`. Embedded
PostgreSQL integration tests are mandatory and never skip a native-loader error.
When local dependency lifecycle scripts are disabled, run the installed native
package's reviewed `scripts/hydrate-symlinks.js` before integration tests; do not
change the global package-script policy.

Run `pnpm -r typecheck`, `pnpm test:run`, `pnpm build`, the browser validation and
fork release/security script checks. The release gate requires the exact current
`codex/paperclip-stable` head, successful `RAGnos Fork CI`, and two current commit
statuses: `ragnos/fork-source-review` and `ragnos/fork-infrastructure-review`.
Each status links a fork PR containing the actual independent review receipt.
The status publisher records review evidence; it cannot replace independent review.
Infrastructure review may admit infrastructure scanner findings only. Other
security findings remain blocking. Historical commit exemptions are removed.

The existing protected `paperclip-alpha-release` environment retains its required
human reviewer. Its maintenance-branch admission must be configured without
removing that gate. The image-only workflow publishes `ragnos/v0.x.x`, exact
source-tagged image digest, upstream baseline, migration manifest, checksums,
platform SBOMs and provenance. It never publishes npm, deploys CompanyOS or
activates agents. Release, deployment, activation and qualification are separate.

## Upstream integration rehearsal

Use an isolated rehearsal branch to merge a selected newer upstream commit into
the maintenance candidate. Record the selected commit and conflict resolutions,
then run frozen install and the mandatory recovery checks. Do not push rehearsal
results to production or introduce an automated update service. When upstream
provides equivalent accepted-job recovery, remove the matching downstream patch
only after these invariants pass against that exact upstream source.
