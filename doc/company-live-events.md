# Company operator event streams

`GET /api/companies/:companyId/events/sse` accepts the existing authenticated
board session and verifies company membership. It exposes the existing company
event publisher as server-sent invalidations for private operator clients.
Agent keys and users outside the company cannot subscribe. Native credentials
must stay server side when another operator surface relays this endpoint.

Each message carries native event ID, company, type, timestamp, and bounded
issue/entity/agent/approval/run identifiers. Log, event and progress payloads
are omitted; comments, credentials and tool payloads are never relayed.
The event stream changes no task state and creates no separate event store.

Event IDs are process-local, not replay cursors. Read the current native
snapshot on connection and reconnect. Four streams are allowed per company
and board identity. Keepalives are sent every15seconds; streams close after
60seconds to revalidate membership. Slow consumers are disconnected rather
than retaining an unbounded buffer. Responses are private, uncached and
uncompressed. The existing WebSocket API remains unchanged.
