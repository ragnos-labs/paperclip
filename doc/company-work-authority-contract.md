# Company Work Authority v1

Status: RAGnos additive contract

## Purpose

The company work authority API lets one configured service read and apply
human-approved changes to Paperclip work. Paperclip remains the authority for
work identity, project, priority, owner, dates, dependencies, status, next
action, done criteria, evidence references, hierarchy, milestone, and privacy
class.

The API is not a general issue mutation route. It is a narrow dependency
contract for a governed project-management loop. It does not start agent work,
admit a Controller mission, dispatch a fleet, approve its own request, or infer
Done from delivery evidence.

## Credential boundary

The API uses a dedicated `pcwp_v3_` credential. A board owner or administrator
creates and revokes this credential through the credential-management routes.
The token is returned only once. Paperclip stores only its hash.

Mutation actions must use
`paperclip:work-authority-credential:{credentialId}` as `writerRef`. The route
derives the expected value from the authenticated credential and rejects a
claimed writer identity that does not match it.

A v3 credential is company-bound. It can access only these paths for that
company:

- `GET /api/v1/companies/{companyId}/work-authority`
- `POST /api/v1/companies/{companyId}/work-authority/preview`
- `POST /api/v1/companies/{companyId}/work-authority/dispatch`
- `GET /api/v1/companies/{companyId}/work-authority/receipts/{idempotencyKey}`

It cannot access a work projection route, a credential-management route, an
ordinary issue route, another company, or another API version. A malformed,
unknown, revoked, or future `pcwp_` token never falls through to board or agent
authentication.

The writer is disabled by default. The emergency stop is active by default.
The runtime must configure an exact operation allowlist and exact policy digest
allowlist before a preview becomes ready.

## Complete authority read

`GET /work-authority` returns one complete, revisioned snapshot. Version 1
supports at most 1,000 governed work records in one response. It fails closed
instead of returning a partial collection when the limit is exceeded.

Each item contains:

- Paperclip issue ID and stable work reference;
- Paperclip identifier and historical aliases;
- title, project, priority, and one owner;
- start and due times;
- dependency issue IDs;
- status and parent;
- next action and done criteria;
- evidence references and milestone reference;
- privacy class;
- accountable human and human approver; and
- the exact Paperclip projection revision for that item.

The response is produced in a repeatable-read, read-only transaction. It
contains a complete marker and a SHA-256 digest. A missing revision, malformed
context, excess item count, or reference error is a failure. It is never an
empty or healthy result.

## Preview and dispatch

Every action is closed and contains:

- stable work identity and optional Paperclip issue ID;
- expected prior revision;
- exact proposal reference and digest;
- proposal type;
- human approval reference, actor, decision, decision time, and expiry;
- approval-bound proposal hash, authority revision, and policy digest;
- service actor, execution owner, accountable human, and approver;
- operation, policy digest, and idempotency key; and
- only the fields allowed for that operation.

The supported operations are `record_create`, `field_set`, `owner_set`,
`date_set`, `dependency_set`, `status_set_nonterminal`,
`status_set_terminal`, `evidence_link`, and `comment_create`.

Preview is side-effect-free. It binds the complete action, current Paperclip
revision, writer state, emergency-stop state, operation permission, and policy
permission into one preview hash. Dispatch requires that exact hash.

New work requires revision `0`, no issue ID, and a title. Every other operation
requires an issue ID and its exact current revision. An alias that already
belongs to another issue is a conflict. The API never creates a replacement
issue when identity lookup fails.

`status_set_terminal` accepts only `status=done` with an `accept_done`
proposal. A delivery or merge proposal cannot close work. New work cannot
start terminal.

## Intent, effect, and replay

Dispatch persists an immutable action intent and activity entry before it
changes an issue. The intent binds the request digest, preview hash,
idempotency key, expected revision, service actor, accountable human,
approver, approval, and complete action.

After the mutation, Paperclip reads the work back and compares every approved
field. It then stores one terminal receipt with the prior revision, result
revision, deterministic change reference, readback digest, attribution, and
effect time. The change reference derives from the proposal, authenticated
writer, operation, and complete request digest.

An exact replay returns the original receipt with `replayed=true`. Reusing the
idempotency key with changed input is a conflict. Receipt lookup is the only
normal recovery path after an ambiguous transport result. A create recovery
uses the stable work reference and the issue-create idempotency key. It never
blindly creates a second issue.

## Identity and accountability

The execution owner may be one human, one agent, or unassigned planned work.
The action always names one accountable human and one human approver. An owner
change must match the routed execution owner. The human approval actor must
match the action approver. The approval must bind the exact proposal hash,
expected authority revision, policy digest, and expiry. A future or expired
decision is rejected.

The terminal activity entry records the service actor as the technical actor
and the accountable human as the responsible user. The receipt preserves the
execution owner, accountable human, approver, and approval reference.

## Historical aliases and private evidence

Stable aliases are unique within a company. Historical tracker identifiers,
including old ClickUp IDs, remain aliases of the same Paperclip issue. They are
never reused or silently replaced.

The authority context stores evidence references only. Raw transcripts,
messages, attachments, credentials, and provider payloads remain in external
evidence custody. A privacy class describes handling. It is not a substitute
for Paperclip company access controls.

## Runtime configuration

The writer stays held until all required values are explicit:

```text
PAPERCLIP_WORK_AUTHORITY_WRITER_ENABLED=true
PAPERCLIP_WORK_AUTHORITY_EMERGENCY_STOP=false
PAPERCLIP_WORK_AUTHORITY_ALLOWED_OPERATIONS=record_create,field_set
PAPERCLIP_WORK_AUTHORITY_ALLOWED_POLICY_DIGESTS=sha256:<approved-policy-digest>
```

Enable one operation class at a time. Keep terminal status disabled until the
full acceptance path is certified. Configuration, deployment, activation, and
acceptance remain separate states.

## Compatibility

This contract is additive. The v1 and v2 company work projection responses,
credential scopes, cursor domains, and route behavior do not change. Ordinary
issue endpoints do not receive work-authority credential access.
