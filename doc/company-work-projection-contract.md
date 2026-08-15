# Company Work Projection v1

Status: Accepted implementation contract

API version: `paperclip.company-work-projection/v1`

Schema version: `1`

## Purpose and authority

Paperclip remains authoritative for work identity, ownership, project, priority,
and planning lifecycle. This contract gives a machine client a bounded,
company-scoped projection of that authority. It does not add an orchestration
service, executor, recovery mechanism, UI, or write path.

The only route is:

`GET /api/v1/companies/:companyId/work-projection`

`HEAD` has the same authorization boundary and headers. The route requires an
agent API key whose immutable scope is exactly
`company_work_projection_read`. A session, board key, standard agent key,
task-bridge key, skill-test key, or agent JWT is rejected. The key is bound to
the company recorded at creation. Later membership, role, or permission changes
do not expand it. Global middleware rejects this credential on every other
path and on every non-GET/HEAD method.

Authenticating or reading through this scope does not update
`agent_api_keys.last_used_at`, insert activity or denial records, repair
recovery state, initialize schema, or persist any other observation. The read
service also starts its database transaction with PostgreSQL
`READ ONLY`, so an accidental write fails at the database boundary.

## Bounded response

Every `200` body is runtime-validated by the strict shared Zod schema
`companyWorkProjectionResponseSchema`; the same schema feeds TypeScript and the
generated OpenAPI document. Objects reject unknown properties.

An item contains only:

- issue UUID and bounded identifier;
- a closed owner union: `agent`, `user`, or `unassigned`;
- nullable project UUID;
- one of four priorities and one of the seven Paperclip planning states;
- timezone-aware created, updated, started, completed, and cancelled instants;
- the item revision and a SHA-256 digest of the safe fields.

It never contains titles, descriptions, prompts, comments, adapter or execution
configuration, credentials, workspaces or local paths, recovery internals, raw
payloads, or private metadata. An issue with an ambiguous owner, unknown state,
unknown priority, oversized identifier, or malformed timestamp makes the
snapshot incompatible; the server fails closed instead of dropping or guessing
the value.

## Snapshot and pagination semantics

Migration `0184_company_work_projection` adds a per-company monotonic revision
and append-only safe-field history. An issue trigger records each visible,
non-harness insert, update, hide, unhide, company move, and delete in the same
database transaction as the source mutation. Deletions and removals from the
projection are tombstones. Revisions are contiguous within a company.

The first page fixes a high-water revision. Each later page selects the latest
version of every issue at or below that high-water mark, orders by item revision
then issue UUID, and advances with a signed opaque keyset cursor. The cursor
binds company, API/schema version, high-water revision, position, page size,
issue time, and expiry. It is HMAC-signed with an instance- and company-derived
key. No process-local cursor state is required, so replay and restart are
deterministic until expiry.

Snapshots expire after five minutes. Replaying a cursor returns the same page;
clients may safely deduplicate by item ID and revision. A concurrent issue
mutation advances the live collection but cannot alter an existing snapshot.
A fresh first page observes the new revision. If the server detects an expired
cursor, a high-water revision ahead of current storage, a revision gap, a
tampered cursor, or an incompatible version, it returns an explicit error and
never marks the result complete.

Page size defaults to 100 and is capped at 500. `hasMore=true` always pairs with
`completeness="partial"` and a cursor. A terminal page, including an empty
collection, uses `hasMore=false`, `nextCursor=null`, and
`completeness="complete"`.

Every page has a strong `ETag`. `If-None-Match` returns `304`. The response also
sets API version, schema version, and snapshot revision headers.

## Result states

| HTTP | Meaning | Stable code |
|---:|---|---|
| 200 | Valid partial or complete page | body completeness |
| 304 | Matching page ETag | no body |
| 400 | Malformed query, cursor, signature, or position | `WORK_PROJECTION_MALFORMED` |
| 401 | Missing authentication | `WORK_PROJECTION_UNAUTHORIZED` |
| 403 | Wrong scope, credential type, route, method, or company | `WORK_PROJECTION_FORBIDDEN` |
| 409 | Unknown version/source value or damaged revision sequence | `WORK_PROJECTION_INCOMPATIBLE` |
| 410 | Expired or storage-stale snapshot | `WORK_PROJECTION_SNAPSHOT_EXPIRED` or `WORK_PROJECTION_SNAPSHOT_STALE` |
| 429 | Per-credential concurrent-read limit reached | `WORK_PROJECTION_RATE_LIMITED` |
| 503 | Database or signing key unavailable | `WORK_PROJECTION_UNAVAILABLE` |

There is no “healthy zero” fallback. Empty-complete, partial, incompatible,
expired, rate-limited, and unavailable remain distinct machine states.

## Upgrade, recovery, and rollback

The migration backfills one deterministic safe version per currently visible
non-harness issue, then installs the trigger. Existing issue APIs and rows are
unchanged. Deployments must apply the migration before enabling clients.

If revision integrity fails, stop serving the projection and restore the
projection tables from a database backup or rebuild them during a controlled
maintenance window from authoritative issues. Never reset a counter while
clients may hold cursors. A rollback must disable the route before dropping the
trigger, functions, and two projection tables; outstanding cursors then become
unavailable rather than silently changing meaning.

The append-only table has no automatic pruning in v1. A later retention policy
must preserve every unexpired high-water snapshot and requires a separate
reviewed storage decision.
