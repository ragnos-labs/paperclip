# RAGnos Paperclip Local Overlay

This directory is the isolated local MVP for the Paperclip and Fleet Broker
company cutover. It does not change Paperclip core behavior.

## Security boundary

- Paperclip is available only at `127.0.0.1:3100`.
- PostgreSQL 17 and the fake Fleet Broker have no published host ports.
- The database is attached only to an internal Docker network.
- No Docker socket, host home, RAGnos workspace, `.ssh`, model-provider key, or
  agent credential home is mounted into any container.
- Telemetry is disabled through both Paperclip and standard environment flags.
- The adapter is mounted read-only and loaded through Paperclip's existing
  external adapter store.

## Secret render

The default renderer requires seven dedicated values already rendered from
Infisical into `~/.infisical/ragnos.env`:

- `PAPERCLIP_MVP_SESSION_SECRET`
- `PAPERCLIP_MVP_AGENT_JWT_SECRET`
- `PAPERCLIP_MVP_TOOL_SIGNING_SECRET`
- `PAPERCLIP_MVP_DB_PASSWORD`
- `PAPERCLIP_MVP_BACKUP_PASSPHRASE`
- `PAPERCLIP_MVP_RAGNOS_HMAC_KEY_B64`
- `PAPERCLIP_MVP_AIBL_HMAC_KEY_B64`

Creating those durable credentials is a human hold. The explicit
`--local-fixtures` option generates disposable local-only test material so the
Docker, auth, backup, restore, adapter, and fake-broker behavior can be rehearsed
without copying a production Fleet secret.

```bash
./ragnos/scripts/render-secrets.sh --local-fixtures
./ragnos/scripts/compose.sh config --quiet
./ragnos/scripts/compose.sh up --build -d
./ragnos/scripts/compose.sh ps
```

Claim the authenticated local instance in the browser, then connect the CLI as
a board operator. The approval URL is local and must be approved in that same
authenticated browser session.

```bash
./ragnos/scripts/compose.sh exec paperclip \
  pnpm paperclipai connect \
  --persona board \
  --api-base http://127.0.0.1:3100 \
  --token-name local-cutover-cli \
  --data-dir /paperclip/cli
```

After that one local approval, seed or reconcile the two company boundaries.
The script is idempotent, reads HMAC values only from the container environment,
and prints identifiers but never secret values.

```bash
./ragnos/scripts/seed-companies.sh
```

The resulting local state has separate RAGnos and AIBL companies, owner
memberships, projects, company budgets, proposer and applier budgets, HMAC
secret references, tenant key IDs, and employees. New agents require board
approval. Proposers return bounded identifiers to the responsible human in
`in_review`; appliers require an approved linked Paperclip approval and a
structured `proposal_id` before they can reach `done`.

The adapter and fake broker tests exercise signature, stale timestamp, nonce,
body, actor, idempotency, cross-tenant, polling, cancellation, timeout,
duplicate, outage recovery, proposal, approval, and apply behavior without a
repository checkout or production route.

```bash
node --test \
  ragnos/packages/ragnos-fleet/test/*.test.js \
  ragnos/fake-fleet-broker/test/*.test.js
```

Never point the local employees at the production Fleet gateway. Real
Paperclip traffic remains held until the sprint authority's fusion gate is
satisfied.

Use `./ragnos/scripts/backup.sh` for an encrypted host-side backup. Verify it in
an isolated scratch database with:

```bash
./ragnos/scripts/restore-check.sh \
  ./ragnos/.runtime/backups/<backup-file>.dump.enc
```

The restore checker always targets `paperclip_restore_check`, removes that
scratch database after verification, and never writes into the live database.
