# CompanyOS Work and Team observation

The company-relative `companyos/work` and `companyos/team` routes use the existing human session. Agent keys, local implicit access, and board keys cannot access the overview API. Native task and agent pages remain available.

`GET /api/companies/:companyId/operator-overview?view=work|team&limit=50&offset=0` uses pure, company-scoped SELECTs and safe fields. It never calls issue recovery, assignment, checkout, wake, or approval writes. Limits are 1..100 with one lookahead row. Offset pagination can shift as tasks change; all loaded pages refetch together and duplicate identities display once. Only queued/running rows appear under Active runs; recent history is separately bounded to 50. Source failure differs from a healthy empty result.

Work displays native task state and explicit human holds from a pending human execution participant or linked pending approval. Assignment and execution remain separate. Native Done and successful runs do not establish CompanyOS human acceptance.

The existing company WebSocket invalidates the overview on activity, agent status, and run lifecycle/progress events. Opening/reopening the socket refetches loaded pages. Visible-tab polling runs every 30 seconds. Last-known rows are marked stale after 60 seconds or a failed read; tool labels expire after 90 seconds. Company/session changes cancel reads and remove overview caches. HTTP 401/403 displays no private rows. Reads time out after 15 seconds, retry transport/5xx failures twice, and respect Retry-After for 429.

No schema, credentials, provider calls, proposals, or acceptance writes are added. Authentication and deployment outcome require separate runtime verification.
