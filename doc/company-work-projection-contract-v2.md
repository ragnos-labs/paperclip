# Company Work Projection v2

Status: proposed additive contract

## Purpose

The v2 company work projection lets an authorized Controller consume Paperclip's work identity, ownership, planning state, export-approved objective, provider-neutral intent, and delegation evidence. Paperclip remains authoritative for those facts. The consumer remains responsible for action policy, risk, idempotency, trace context, validation, stop conditions, execution, and terminal receipts.

V2 is additive. It does not change the v1 route, response bytes, cursor signing domain, token format, or credential lifecycle.

## Read boundary

`GET /api/v2/companies/{companyId}/work-projection` requires a dedicated `pcwp_v2_` credential for the same company. A v1 credential cannot access v2, and a v2 credential cannot access v1 or any other route. Board and agent credentials are not projection credentials.

The v2 envelope keeps every v1 envelope and item field and adds a required `packetContext` to each item. Pagination remains snapshot-bound and deterministic. Unknown versions, fields, intent kinds, or contradictory source facts fail with `WORK_PROJECTION_INCOMPATIBLE`; authentication and source failures never appear as an empty projection.

The built-artifact, non-production verification surface is specified in
[company-work-projection-canary.md](./company-work-projection-canary.md). It
exercises the dependency-owned read route, guard, cursor, normalization, and
schema without creating a provider credential or connecting to provider state.

## Issue source context

An issue may carry an explicit `workProjectionContext` through the existing governed issue create/update boundary:

```json
{
  "objective": "Deliver the approved artifact to the release registry.",
  "objectiveExportApproved": true,
  "intent": {
    "type": "artifact_delivery",
    "artifactReference": "artifact:release-candidate",
    "destinationReference": "registry:approved-releases"
  },
  "delegation": null
}
```

The object is closed and validated before storage. Only a human board actor may set or replace it through the existing issue create/update boundary; an agent cannot self-approve export. Paperclip never infers an exportable objective from an issue title, description, comment, or private execution data.

Supported intents are `repository_change`, `program_transition`, `tracker_update`, `runtime_operation`, and `artifact_delivery`. Their target-specific fields are closed. Paperclip references stay provider-neutral and native; canonical Controller IDs are not stored here.

## Packet context

An unassigned item is `unavailable: unassigned`. Missing explicit context is `unavailable: restricted_objective`. An approved context without a supported intent is `unavailable: unsupported_target`. An agent-owned item without delegation is `unavailable: missing_delegation`.

A ready human-owned item carries a human actor and `delegation: null`. A ready agent-owned item carries the assigned agent actor and a delegation containing the human authorizer, grant reference, SHA-256 grant digest, and grant time. The authorizer must still be an active member of the same company in the captured snapshot.

Ready items also contain an immutable Paperclip source receipt:

- `contractVersion`: `paperclip.company-work-projection/v2`
- `reference`: company, issue, and revision-qualified Paperclip reference
- `revision`: exactly the item revision
- `digest`: SHA-256 over the canonical v2 source facts
- `issuedAt`: the immutable history capture time

The receipt proves Paperclip's source projection only. It is not an executor receipt and must not be presented as one.

## Compatibility and fail-closed rules

- V1 output remains byte-compatible even when an issue has v2 context.
- Owner and actor must agree.
- Human ownership forbids delegation; agent ownership requires it.
- Company, owner, authorizer, revision, snapshot, receipt reference, and receipt digest disagreements are incompatible.
- A malformed stored context is incompatible, not unavailable.
- Unknown intent types or extra fields are incompatible.
- Source/reference failures never become zero, healthy, or complete evidence.
