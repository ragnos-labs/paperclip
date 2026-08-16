# Company Work Projection Artifact Canary

Contract: `paperclip.company-work-projection-canary/v1`

This canary proves a bounded part of the company work projection contract from
the built Paperclip artifact. It does not start the normal Paperclip server.
It does not connect to a database. It does not create or revoke a credential.

## Security boundary

The artifact contains a separate entrypoint at:

```text
server/dist/canary/work-projection-server.js
```

The normal production entrypoint does not import this file. The canary starts
only when an operator selects this file as the process entrypoint and supplies
all of these values:

- `PAPERCLIP_WORK_PROJECTION_CANARY_ACK=NON_PRODUCTION_GET_ONLY`
- `PAPERCLIP_WORK_PROJECTION_CANARY_COMPANY_ID=<synthetic UUID>`
- `PAPERCLIP_WORK_PROJECTION_CANARY_FIXTURE=empty|synthetic`
- `PAPERCLIP_WORK_PROJECTION_CANARY_TOKEN=<derived synthetic token>`

The token must match the deterministic token for the synthetic company and
fixture. The canary rejects any other token at startup. This prevents an
operator from supplying a production work projection credential.

The canary process mounts only:

- `GET /api/health`
- `GET /api/v1/companies/:companyId/work-projection`
- `GET /api/v2/companies/:companyId/work-projection`

The v1 route is present only so the real credential guard can prove that the
synthetic v2 credential is version-bound. The canary has no credential
management, mutation, action, live-event, scheduler, or background-worker
routes. It rejects every non-GET method before routing.

## What it proves

The canary uses the production dependency-owned implementations for:

- the Express work projection read route
- the projection credential guard
- the v2 query validator
- v2 source normalization and evidence digests
- cursor signing, decoding, and company binding
- canonical response hashing and the strict v2 response schema
- response headers and work projection error codes

The `empty` fixture proves an authenticated, complete-empty response. The
`synthetic` fixture proves deterministic two-page cursor reads, stable snapshot
timestamps, stable source receipt timestamps, and byte-equivalent replay.
Both fixtures prove that missing and invalid credentials return
`401 WORK_PROJECTION_UNAUTHORIZED`. The synthetic credential is company-bound
and v2-bound.

## What it does not prove

This is an artifact-only harness. It does not prove a live provider database,
PostgreSQL read-only transaction enforcement, advisory-lock admission, source
witness continuity, migration state, recovery verification, or production
credential lookup. Those properties remain covered by the database and route
integration tests and need a separate deployment canary when deployment is
authorized.

It also does not prove RAGnos Controller behavior. Controller can use this
contract as the dependency half of a future unified canary.

## Operator command

Use an immutable image digest. The helper creates an internal Docker network.
It runs as UID/GID `65532:65532`, uses a read-only root filesystem, mounts no
host path, and sends only GET requests. Each invocation generates a
non-overridable, collision-resistant run ID, rejects pre-existing target names,
and labels every Docker resource with that ID. Cleanup uses Docker-returned
resource IDs and removes a resource only after its run label is revalidated.

```sh
bash scripts/smoke/work-projection-canary.sh \
  ghcr.io/ragnos-labs/paperclip@sha256:<immutable-index-digest>
```

The command returns one JSON receipt. A pass has these required facts:

```json
{
  "status": "passed",
  "contract": "paperclip.company-work-projection-canary/v1",
  "fixtures": ["empty", "synthetic"],
  "transport": "internal-container-network-only",
  "user": "65532:65532",
  "hostMounts": 0,
  "requestMethods": ["GET"],
  "databaseConnections": 0,
  "databaseTables": 0,
  "databaseWrites": 0,
  "persistentFileWrites": 0,
  "providerMutations": 0,
  "schedulerTasks": 0,
  "cleanup": {
    "status": "verified",
    "containersRemaining": 0,
    "networksRemaining": 0
  }
}
```

The helper also compares the canary state digest and database/file counters
before and after the reads. It requires an empty `docker diff`. It emits a pass
receipt only after explicit cleanup and verification that no resource bearing
the run label remains. A cleanup failure or signal exits without a pass receipt.
The release workflow runs this helper against the exact published digest before
it creates the immutable GitHub prerelease.
