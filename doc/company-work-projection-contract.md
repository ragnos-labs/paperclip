# Company Work Projection v1

Status: Accepted implementation contract

API version: `paperclip.company-work-projection/v1`

Schema version: `1`

## Purpose and authority

Paperclip remains authoritative for work identity, ownership, project, priority,
and planning lifecycle. This contract gives a machine client a bounded,
company-scoped projection of that authority. It does not add an orchestration
service, executor, recovery mechanism, UI, or write path.

The only machine read route is:

`GET /api/v1/companies/:companyId/work-projection`

`HEAD` is not part of the contract and is denied. The route requires a
dedicated `pcwp_v1_` credential stored only in
`company_work_projection_credentials`. It is not an agent API key or JWT scope,
has no agent identity, and is bound to the company recorded at creation. Later
membership, role, or permission changes cannot expand it. Global middleware
rejects this credential on every other path and on every non-GET method.

Board operators can create, list, and revoke these credentials through the
company-scoped `/api/v1/companies/:companyId/work-projection-credentials`
routes. Plaintext is returned once at creation. Older Paperclip binaries query
only `agent_api_keys`, so they cannot discover or reinterpret these hashes. The
amended unreleased migration also revokes any residue from the earlier
agent-scope candidate. Malformed and unknown token versions stay inside the
reserved `pcwp_` family and fail closed without falling through to another auth
mechanism.

Authenticating or reading through this scope does not update
credential metadata, insert activity or denial records, repair recovery state,
initialize schema, or persist any other observation. Projection credentials
are rejected before the live-events WebSocket performs any key-table update,
upgrade, subscription, or event delivery. The read service also starts its
database transaction with PostgreSQL
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

Digests are SHA-256 over the UTF-8 bytes of RFC 8785 JSON Canonicalization
Scheme output. Object keys are lexicographically sorted, arrays preserve order,
and only JSON strings, finite numbers, booleans, null, arrays, and objects are
accepted. This makes evidence and ETag values reproducible across languages.

It never contains titles, descriptions, prompts, comments, adapter or execution
configuration, credentials, workspaces or local paths, recovery internals, raw
payloads, or private metadata. An issue with an ambiguous owner, unknown state,
unknown priority, oversized identifier, or malformed timestamp makes the
snapshot incompatible; the server fails closed instead of dropping or guessing
the value. A project, agent owner, or user owner that does not belong to the
issue company also fails closed rather than leaking the foreign identifier.

## Snapshot and pagination semantics

Migration `0184_company_work_projection` takes `SHARE ROW EXCLUSIVE` locks on
`public.companies` and `public.issues` for its full transaction. This blocks
company and issue writes while counter rows are seeded, triggers are installed,
and existing work is backfilled, eliminating the pre-trigger gap. The lock is
held for the duration of the schema work plus an O(visible issue count)
backfill; operators should use a maintenance window for large tables.

Every existing company receives an explicit revision-zero row and an
`AFTER INSERT` company trigger creates one for future companies. The issue
trigger records each visible insert, update, hide, unhide, harness toggle,
plugin-visibility toggle, company move, and delete in the same transaction as
the source mutation. Normal work-list semantics apply: hidden, harness, and
plugin-operation issues are excluded. Deletions and removals are tombstones.
Revisions are contiguous within a company.

The first page fixes a high-water revision. Each later page selects the latest
version of every issue at or below that high-water mark, orders by item revision
then issue UUID, and advances with a signed opaque keyset cursor. The cursor
binds company, API/schema version, high-water revision, position, page size,
issue time, and expiry. It is HMAC-signed with an instance- and company-derived
key. No process-local cursor state is required, so replay and restart are
deterministic until expiry.

Reads require the company counter row and validate full history count, minimum,
and maximum against the current counter before serving any snapshot. Missing,
behind, ahead, gapped, or partially restored state is incompatible; it is never
interpreted as empty or complete.

Snapshots expire after five minutes. Replaying a cursor returns the same page;
clients may safely deduplicate by item ID and revision. A concurrent issue
mutation advances the live collection but cannot alter an existing snapshot.
A fresh first page observes the new revision. If the server detects an expired
cursor, a high-water revision ahead of current storage, a revision gap, a
tampered cursor, or an incompatible version, it returns an explicit error and
never marks the result complete.

A cursor presented to a different company is reported as malformed. The
endpoint does not provide an authorization oracle about whether that cursor is
valid for another company.

Page size defaults to 100 and is capped at 500. `hasMore=true` always pairs with
`completeness="partial"` and a cursor. A terminal page, including an empty
collection, uses `hasMore=false`, `nextCursor=null`, and
`completeness="complete"`.

Cursor signing is an endpoint-readiness requirement: missing signing material
returns `503` even for empty or one-page collections. Every page has a strong
`ETag`. `If-None-Match` follows HTTP weak comparison for GET, including tag
lists, weak tags, and `*`; a match returns `304`. The response also sets API
version, schema version, and snapshot revision headers.

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
normal-list issue while writes are locked and capture triggers are already
installed. Existing issue APIs and rows are unchanged. Deployments must apply
the migration before enabling clients.

If revision integrity fails, stop serving the projection and restore the
projection tables from a database backup or rebuild them during a controlled
maintenance window from authoritative issues. Never reset a counter while
clients may hold cursors. A rollback must disable the route before dropping the
trigger, functions, and two projection tables; outstanding cursors then become
unavailable rather than silently changing meaning.

Rolling the application binary back leaves dedicated projection hashes in a
table older versions do not query, so those credentials become unusable rather
than becoming standard agents. The append-only table has no automatic pruning
in v1. A later retention policy
must preserve every unexpired high-water snapshot and requires a separate
reviewed storage decision.
