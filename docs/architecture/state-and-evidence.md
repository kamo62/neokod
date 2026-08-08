# State and Evidence

Neokod renders projections of facts reported by providers, the orchestration server, persistence, and local interaction state. A projection must preserve what is known, what is not known, and which subsystem owns each fact. UI convenience must not manufacture domain truth.

## Principles

1. **Evidence is not a default.** Missing, failed, stale, or not-yet-loaded evidence remains explicit. Do not turn it into zero, success, an empty collection, `false`, or a completed lifecycle.
2. **One semantic projection per concept.** Derive lifecycle, availability, or mutation state once in pure domain logic. Sidebar pills, banners, dashboards, and cards are thin presentation adapters over that result.
3. **The authority that observes closure owns closure.** The server closes runtime items and orders synthetic facts. A browser may render optimistic interaction state, but it does not assert server completion or author server timestamps.
4. **Potentially surviving work is orphaned.** If a parent settles while a detached or externally managed descendant may still run, report tracking loss. Do not relabel it stopped.
5. **Presentation choices do not change semantics.** Density, grouping, labels, icons, and seen/unseen styling may adapt a projection; they may not alter lifecycle or evidence.

## Evidence model

Use a discriminated union when a value can be unavailable or unresolved. Choose names appropriate to the domain, but preserve these distinctions:

```ts
type Evidence<A> =
  | { state: "known"; value: A; observedAt: string }
  | { state: "unknown"; reason: "not-observed" | "incomplete" }
  | { state: "unavailable"; reason: string; retryable: boolean };
```

`known: 0` differs from `unknown`; an empty known list differs from a failed query. If stale data may be shown, retain both the last known value and freshness metadata rather than replacing an error with a fresh-looking default.

At transport boundaries, encode these states in `effect/Schema`. A nullable field is sufficient only when the meaning of `null` is singular and documented. Otherwise use a tagged schema so callers must handle every state.

### Fail-closed decisions

A decision requiring affirmative evidence must reject unknown evidence. Examples include merge gates, unresolved-review checks, authorization, and destructive actions. The error should name the missing evidence and offer a retry path when possible.

## Lifecycle projections

Lifecycle is a semantic union, not a label. Keep source facts as input and resolve precedence in a pure function. For thread lifecycle, the shared precedence is:

1. awaiting approval;
2. awaiting user input;
3. connecting;
4. working, including a running latest turn without a session snapshot;
5. plan ready;
6. terminal failed, stopped, or completed;
7. unknown.

Surfaces consume that union. Seen/unseen completion, compactness, status color, and text are presentation metadata outside it.

For runtime descendants, distinguish:

- **active**: current evidence says work is running;
- **terminal**: an authoritative outcome says completed, failed, or stopped;
- **orphaned**: parent tracking ended but the descendant may still run;
- **unknown**: evidence cannot establish any of the above.

Terminal timestamps freeze elapsed time. Active elapsed time may tick. Orphaned elapsed time ends at the last observation and must be labelled accordingly. Missing terminal timestamps remain unknown.

## Runtime-item closure

Tools, delegated tasks, approvals, user-input requests, and streaming assistant messages share a server-owned closure projection.

Every item declares a scope:

- `turn`: closes when its owning turn reaches authoritative settlement;
- `session`: may survive a turn and closes with the session;
- `detached` or `external`: may survive both and becomes orphaned when tracking is lost unless its provider confirms a terminal outcome.

Closure requirements:

- preserve provider facts and synthetic reconciliation facts separately;
- give provider-confirmed terminal outcomes precedence in the effective projection;
- create deterministic synthetic event and command identifiers so retries are idempotent;
- assign ordering from a server-owned monotonic source;
- reconcile open items at startup rather than relying only on live events;
- project from durable item state, not a capped activity-history fold.

Adapters must not independently invent `tool.completed`, `task.completed`, approval dismissal, message completion, or timestamps. Central closure emits the effective state once.

## Time and ordering

Pure logic accepts `nowMs`, an ISO timestamp, or a clock service as input. `Date.now()` and zero-argument `new Date()` belong at runtime or component boundaries, not in `*.logic.ts` projections. Converting an injected timestamp with `new Date(nowMs)` is deterministic and allowed.

Server-owned events use server-authored timestamps and monotonic ordering. Client-local timestamps must be named and typed as local interaction metadata and must not be sent as authoritative server fields such as event creation, completion, or generation time.

## Mutation acknowledgement

Settings and other persisted mutations use authoritative acknowledgement, not fire-and-forget updates:

1. the client sends a mutation identity and the revision it observed;
2. the UI enters a saving state and awaits the RPC;
3. the server applies or rejects the mutation and returns the authoritative snapshot and revision;
4. the client replaces optimistic state with that response;
5. failure remains visible and retryable; it is not presented as saved.

Out-of-order responses cannot overwrite newer revisions. Reconnect reconciliation reads the authoritative snapshot instead of assuming an earlier request succeeded.

## Surface adapter checklist

Before adding a status resolver or fallback:

- Is there already a semantic projection for this concept?
- Can the source value be unknown, unavailable, stale, or contradictory?
- Which subsystem owns the fact and its timestamp?
- Does parent settlement prove descendant termination, or only tracking loss?
- Is this transformation semantic, or only presentation?
- Does a test cover conflicting evidence and missing evidence?

## Tests and lint guardrails

Prefer table-driven pure tests for precedence, contradictions, unknown states, orphaning, and frozen timing. Add adapter tests only for surface-specific labels or grouping.

The custom lint rules are intentionally narrow:

- ambient clocks are rejected only in pure `*.logic.ts` production modules;
- fabricated contract defaults are rejected for query `.data` fallbacks that use empty/default sentinels or inline object literals;
- client-authored server timestamps are rejected only when ambient time is assigned to server-owned fields in RPC/command payload modules.

Do not ban all status comparisons, all clocks in React components, deterministic `new Date(inputTime)` conversion, or local UI timestamps. Types and schemas carry the broad guarantee; lint catches a small set of high-signal regressions.
