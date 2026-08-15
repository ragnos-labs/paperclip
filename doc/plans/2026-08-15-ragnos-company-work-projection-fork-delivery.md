# RAGnos company work projection fork delivery

Status: source-custody record for review. This record does not authorize a
deployment, release, tag, publication, database change, or runtime enablement.

## Exact source chain

| Layer | Exact source | Custody |
| --- | --- | --- |
| Independent upstream base | `paperclipai/paperclip@b38d6ddb811b3ff3145ff5df60174eb9e7313fe6` | Paperclip maintainers |
| v1 schema and contract | `347c5c2aa` | Submitted to independent upstream in PR #11435 |
| v1 server reads and upstream PR head | `737f64ebe3b32f782ee5ec28c9cb1756a116438b` | Submitted to independent upstream in PR #11435 |
| Fork CI bootstrap PR head | `e0a41ddac7a1b47050c5b12e0537344a69eae204` | RAGnos fork PR #11 |
| Fork CI bootstrap merge on `master` | `b55cb60d2ed5ef2f77d7b0f92dbaa45b327eab6f` | RAGnos fork custody |
| Contract review base with v1 plus fork CI | `a3f53c78ab623a8d8edcfe43de45bebd58f800ea` | RAGnos fork custody |
| Preserved original v2 context commit | `2adce6aaf2e14683bf63f72a58877bced2b0d57c` | Preserved local RAGnos fork evidence |
| Rebased v2 context contract | `70d6dc2708932e135cb9eafd2fe59c8d53577e4b` | RAGnos fork custody |
| Rebased v2 mutation-boundary hardening | `1751a107b87c04e1ec3ab9d148c09c27d35c6dbc` | RAGnos fork custody |

The RAGnos review target is
`ragnos/controller-company-work-projection`. Its exact contract-PR base is
`a3f53c78ab623a8d8edcfe43de45bebd58f800ea`, which merges the exact v1 head
`737f64ebe3b32f782ee5ec28c9cb1756a116438b` with the fork CI bootstrap merge.
The review head is `codex/ragnos-company-work-projection-v2-stabilization`.
This arrangement keeps the fork delivery independent from the divergent
`ragnos/main` overlay while bringing the fork-owned gate onto the review
target.

The independent upstream PR is
[`paperclipai/paperclip#11435`](https://github.com/paperclipai/paperclip/pull/11435).
It remains owned by the independent upstream maintainers. RAGnos must not
merge, close, retarget, or otherwise modify that PR without their authority.

## Contract versions

| Contract | API and schema | Credential domain | Read route |
| --- | --- | --- | --- |
| v1 | `paperclip.company-work-projection/v1`, schema `1` | token version `1`, `pcwp_v1_` | `GET /api/v1/companies/{companyId}/work-projection` |
| v2 | `paperclip.company-work-projection/v2`, schema `2` | token version `2`, `pcwp_v2_` | `GET /api/v2/companies/{companyId}/work-projection` |

The versions fail closed across API, token, cursor, company, and route
boundaries. Projection credentials do not compose with board or agent
credentials. The plaintext projection credential is shown once. Only its hash
is stored.

V2 adds an explicit `workProjectionContext` to a governed issue. Only a board
actor may set or change this context. The mutation check applies to direct
company issue creation, child issue creation, accepted-plan child creation, and
issue updates. Original hardening commit
`37bd0e066ba6a2d0244b640ac5ef71a3174f79ee`, rebased as
`1751a107b87c04e1ec3ab9d148c09c27d35c6dbc`, closes the accepted-plan child
path and adds a regression test.

## Database order

The source chain contains migrations `0218_company_work_projection` and
`0219_quick_captain_britain`. A future authorized deployment must apply them in
that order. Migration `0218` takes bounded maintenance locks and performs the
documented backfill. This delivery did not run either migration against a
runtime database.

## Dependency and security disposition

The complete v1 plus v2 source diff adds no dependency manifest or lockfile
change. It adds no new runtime dependency.

`pnpm audit --prod --json` reports 54 existing production advisories at both the
untouched v2 commit `2adce6aaf2e14683bf63f72a58877bced2b0d57c` and the hardened
mission head. The counts are 1 critical, 24 high, 22 moderate, and 7 low. The
advisory ID sets are identical. This lane did not create or resolve that
repository-wide dependency backlog. The dependency graph and vulnerability
alerts are enabled in the RAGnos fork. Dependabot security updates and secret
scanning remain disabled, and the code-scanning API reports no analysis.
Therefore, dependency review, the package-audit regression baseline,
exact-head CI security jobs, source review, and regression tests are the
available fork-local security evidence.

The independent upstream PR's exact v1 head passed its upstream security and
quality checks, including Socket, Snyk, Superagent, Greptile, typecheck, build,
and test shards. That evidence belongs to v1 at its exact upstream PR head. It
does not substitute for exact-head RAGnos fork CI on v2.

## Verification receipt

| Check | Result | Classification |
| --- | --- | --- |
| `pnpm install --frozen-lockfile` | Pass | Lockfile is current |
| `pnpm -r typecheck` | Pass | 31 workspace packages passed; migration baseline check passed |
| `pnpm build` | Pass | All packages built; warnings were non-fatal asset and bundle diagnostics |
| Projection validator, cursor, route, integration, and mutation-boundary tests | Pass | Focused contract coverage is green |
| Task-bridge timeout rerun with a 15 second limit | Pass in about 10.4 seconds | Local timing noise; unrelated to this diff |
| `pnpm test:run` | Fail: 5 tests in 3 files | Pre-existing macOS path alias mismatch; 2220 passed, 1599 skipped |
| Exact 5-test reproduction at untouched `2adce6aaf` | Same 5 failures | Expected `/var/...`; received `/private/var/...` |
| `pnpm audit --prod --audit-level high` | Fail: 54 advisories | Existing dependency backlog; identical at untouched v2 and mission head |

The three broad-suite files are
`server/src/__tests__/company-skills.test.ts`,
`server/src/__tests__/workspace-instance-cleanup.test.ts`, and
`server/src/__tests__/workspace-runtime.test.ts`. No test was disabled, relaxed,
or changed to obtain this classification.

The RAGnos fork PR must use its exact head as the owning-repository merge gate.
The independent `RAGnos Fork CI` aggregate must pass dependency review,
security regression, typecheck, the complete owning general and serialized
test shards, build, and E2E. The upstream `commitperclip PR Review` workflow is
preserved but cannot authenticate in the fork because the fork does not own
`COMMITPERCLIP_KEY`; it is contribution metadata, not a product-test result.
No review request, open actionable comment, or mission-caused failure may
remain at merge.

## Rollback

Before deployment, rollback is a source operation only:

- Reset the v2 delivery target to
  `a3f53c78ab623a8d8edcfe43de45bebd58f800ea` to retain v1 and the fork CI
  bootstrap while removing v2.
- The contract-only lineage anchors remain
  `737f64ebe3b32f782ee5ec28c9cb1756a116438b` for v1 and
  `b38d6ddb811b3ff3145ff5df60174eb9e7313fe6` for the pre-contract upstream
  base. After bootstrap, do not hard-reset the review target to either anchor,
  because that would also remove the fork CI files. A full contract rollback
  must be a separately reviewed revert that preserves the bootstrap gate.

After a future authorized deployment, use the runtime rollback procedure in
the versioned contract documents. Disable projection reads first. Allow the
five-minute cursor validity window to expire. Retain credential audit data.
Do not apply an ad hoc down migration. Database and runtime rollback remain out
of scope for this delivery.

## Upstream delta and Controller admission

The RAGnos fork delivery consists of v1 plus the fork-only v2 context contract
and its mutation-boundary hardening. It does not claim that v2 is accepted by
independent upstream. The official upstream PR remains open and unchanged.

A merged fork commit is implemented source evidence only. It is not deployed,
released, published, activated, canaried, or runtime-verified. RAGnos Controller
may pin parsers, fixtures, and admission evidence to the exact fork merge
commit. A live adapter must wait for a separately authorized Paperclip release,
deployment, credential setup, canary, edge-rate-limit verification, and live
read receipt.
