# Connection Runtime

The connection runtime owns local topology, retry policy, transport lifetime,
cached environment data, and environment-scoped operations. It supports exactly
two in-memory target forms:

- `PrimaryConnectionTarget`: the direct loopback desktop or `t3 serve` backend;
- `WslConnectionTarget`: a desktop-proven WSL endpoint with an in-memory bearer.

There are no saved remote targets, profiles, credentials, registrations, or
DPoP tokens. The schema-v2 catalog is intentionally empty; its v1 decoder exists
only to discard legacy connection data during the 2.0.0 migration.

## Ownership

- `EnvironmentRegistry` reconciles the current platform topology and owns one
  scoped supervisor per environment.
- `EnvironmentSupervisor` owns desired state, retries, and the current lease.
- `ConnectionResolver` prepares a direct loopback socket or obtains a WSL
  WebSocket ticket.
- `RpcSessionFactory` performs one socket attempt and initial config probe.
- Shell and thread services own HTTP snapshots, live subscriptions, and caches.

The supervisor is the sole retry owner. Transient failures retry with bounded
backoff; configuration or WSL bearer failures remain blocked until topology
changes. Cached projections never establish connection health and never
overwrite newer live state.

## Access matrix

| Target                      | Discovery                                       | HTTP                                | WebSocket                                                         | Persistence                                  |
| --------------------------- | ----------------------------------------------- | ----------------------------------- | ----------------------------------------------------------------- | -------------------------------------------- |
| Native primary / `t3 serve` | Loopback URL                                    | Direct, unauthenticated             | Direct `/ws`                                                      | Cache only                                   |
| Desktop WSL                 | Current `getLocalEnvironmentBootstraps()` entry | `Authorization: Bearer <wsl token>` | Bearer-protected ticket request, then one fresh single-use ticket | Cache only; token and target are memory-only |

The desktop generates a 192-bit WSL token for each WSL backend start. The WSL
server binds `0.0.0.0`, compares bearer values in constant time, and protects
sensitive environment/orchestration HTTP. `POST
/api/wsl-auth/websocket-ticket` issues an opaque ticket with a 30-second
lifetime; `/ws` deletes it on first validation, including failed expiry checks.
The long-lived bearer is never placed in a WebSocket URL.

Native primary and standalone server bootstraps carry no secret. Their HTTP and
WebSocket paths are direct because their bind is fixed to `127.0.0.1`. A
wildcard listener without the private WSL discriminator and token is rejected at
startup.

## Platform and data boundary

The web platform reads the primary plus desktop WSL topology, keeps those
registrations in memory, and provides network/lifecycle wakeups. Finite HTTP
snapshots, durable WebSocket subscriptions, and commands remain separate APIs.
Only shell and thread snapshots are persisted in IndexedDB or desktop storage.

Both toast providers, the slow-RPC coordinator, activity notification
coordinator, tracing bootstrap, event router, and provider-update notification
mount unconditionally in the normal root shell. Local activity notifications
therefore do not depend on an auth/session state.

## Verification

Required coverage includes direct loopback preparation, rejection of missing or
incorrect WSL bearers, expired/reused WebSocket tickets, legacy-catalog purge,
retry behavior, cache hydration, and durable subscriptions switching sessions.
