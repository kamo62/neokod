# Plan 21: Observability and Telemetry Expansion

Status: Draft. Companion to plan 20 (orchestration direction). Not yet reviewed.
Related: plan 20 (governance is opt-in and visibility-first, and the telemetry here is its substrate), plan 19 (capability graph).

## 1. Purpose

Neokod already emits telemetry, but narrowly. PostHog carries rough usage stats, and a Copilot-specific evidence path can forward to AI-Orch, OTLP, or PostHog. The goal is to broaden and unify this into one instrumentation layer that serves three consumers from the same emission points: product analytics (what to build next), operational telemetry (is it healthy and fast), and opt-in governance (what did the agents do). All of it opt-in, all of it PII-safe by default, all of it something a developer or organization turns on rather than something that ships enabled.

This plan does not add governance enforcement. It provides the visibility that plan 20's cooperative, opt-in governance is built on, and the operational telemetry the platform needs regardless of governance.

## 2. What exists today

Grounded in the tree so the expansion builds on it rather than replacing it.

- **`apps/server/src/telemetry/AnalyticsService.ts`**: the PostHog analytics service. Buffers events, batches sends, and backs off failed flushes with bounded retries. This is the product-analytics path and it is healthy.
- **`apps/server/src/provider/copilot/EvidenceSink.ts`** plus `AiOrchSink.ts`, `OtlpSink.ts`, `PostHogSink.ts`: an evidence-sink abstraction with three implementations. `OtlpSink` posts hand-rolled OTLP/HTTP JSON logs (no `@opentelemetry` dependency) with correct AnyValue shapes and nanosecond string timestamps. All three strip PII the same way. This is the governance-evidence path, currently scoped to Copilot managed-client evidence.
- **`apps/server/src/observability/Layers/Observability.ts`**, `packages/shared/src/observability.ts`, `httpObservability.ts`, and `TraceDiagnostics`: the observability layer and OTLP trace ingestion neokod already decodes.
- **Settings**: `analytics` (PostHog) and `observability` (OTLP URLs) blocks exist in the settings schema, with the analytics default-on plus first-run disclosure decision recorded, and the governance `credential`/`governanceUrl` fields for AI-Orch.

The point: the sink abstraction, the batching-and-backoff analytics pipeline, the OTLP wire format, and the settings surface are already here. This plan generalizes them past the Copilot-evidence special case.

## 3. Three streams, one instrumentation layer

The same emission points feed three streams, routed to different sinks. Keeping them one taxonomy at the source avoids three parallel instrumentation efforts.

- **Product analytics.** Feature usage and adoption: which modes, which providers, which commands, which UI surfaces. Emitted from the client and the command boundary. Sink: PostHog. Purpose: build the right things.
- **Operational telemetry.** Errors, latency, resource pressure, provider health, throughput and queue depth. Emitted from the server, the provider adapters, and the client. Sinks: PostHog for aggregate error rates, and OTLP for traces and metrics an organization can pull into its own stack. Purpose: keep it healthy and fast.
- **Governance and audit.** Governed-action events: an agent dispatched, a subagent granted with its ceiling and provenance, a provider routed, a turn completed, evidence produced, a fail-closed block hit. Emitted from the command boundary (plan 20). Sinks: a local durable audit log, optional AI-Orch forwarding, and OTLP for organizations that centralize audit. Purpose: opt-in visibility of what the agents did.

An event is authored once with a type and stable attributes, and the routing layer decides which streams and sinks it belongs to. A single agent-dispatch event, for example, is a product-analytics signal (a Symphony run started), an operational signal (latency to first token), and a governance signal (which agent, which ceiling, which parent), without being emitted three times.

## 4. Expanding PostHog

Today PostHog gets rough stats. Broaden it in three directions, each opt-in and PII-stripped.

- **Structured error logging.** Capture server and client errors as structured events with a stable error taxonomy (category, provider, operation, recoverable), not free-text. Enough to answer "which providers fail most, at which operation, how often" without shipping prompts, diffs, or secrets. This is the concrete near-term ask.
- **Feature usage.** Instrument the surfaces that inform the roadmap: mode switches (Code and Symphony), provider and model selection, subagent and delegation use as it lands, `/throw`, the composer commands, the Environment and Subagents panels. Adoption and retention of the features, not the content of the work.
- **Governed-action events, in analytics form.** The same governance events from stream three, projected into aggregate analytics (how much delegation, how often a fallback fired, how many approvals), so product and governance read the same underlying events. PostHog is the analytics view of these; it is not the audit ledger.

Privacy stays as the existing sinks already enforce: strip PII, never emit prompts, diffs, source, or secrets, and honor the analytics opt-out and first-run disclosure already in place.

## 5. OpenTelemetry adapters

The `OtlpSink` proves neokod can speak OTLP without a heavy dependency. Generalize it from the Copilot-evidence special case into a first-class export path so an organization can point neokod at its own OpenTelemetry collector and pull operational telemetry and, if it opts in, governance audit.

- **Logs.** Structured error and governed-action events as OTLP logs, reusing the `OtlpSink` AnyValue and nanosecond-timestamp handling already written.
- **Traces.** A turn, a dispatch, a subagent tree as OTLP spans, so an organization sees agent activity in its existing tracing stack. Neokod already decodes OTLP traces via `TraceDiagnostics`; this is the export direction.
- **Metrics.** Provider health, latency percentiles, queue depth, quota state as OTLP metrics for dashboards and alerting.

Decision to make: keep the hand-rolled OTLP JSON (zero dependency, full control, more maintenance) or adopt the `@opentelemetry` SDK (standard, less code, a dependency and its weight). The hand-rolled path is working and dependency-free, which suits the local-first constraint, so the default is to extend it and adopt the SDK only if the export surface grows past what is comfortable to maintain by hand.

Configuration: OTLP endpoints already have a settings block. Extend it to per-signal endpoints (logs, traces, metrics) and per-stream opt-in, so an organization can export operational telemetry without governance audit, or both, or neither.

## 6. Emission points

- **The command boundary** (plan 20): governed-action events. This is the single instrumentation point for agent activity, and it is why plan 20 insists the boundary be real and unified. Until the interactive engine and the Symphony runner are on one boundary or both instrumented, governance telemetry has a gap, which is a dependency this plan shares with plan 20.
- **The provider adapters**: errors, latency, provider health, quota signals.
- **The client**: feature usage, UI surfaces, client-side errors and reconnect events.

## 7. Opt-in and privacy

Every stream and every sink is opt-in, consistent with plan 20's opt-in governance and the local-first default. A developer running solo can keep all of it off. A developer can turn on product analytics without governance forwarding. An organization can turn on OTLP export and AI-Orch audit. The three streams and their sinks are independent toggles, not one switch.

PII stripping is enforced at the sink, as the existing sinks do, and the rule is absolute: telemetry carries structure and metadata, never prompts, diffs, source, or secrets. The first-run disclosure and analytics opt-out already shipped set the precedent; extend them to cover the new streams.

## 8. Sequencing

- Near-term, independent: structured error logging into PostHog, and the feature-usage events for the shipped surfaces. Both are additive and need no orchestration changes.
- Then: the unified event taxonomy so an event is authored once and routed to streams, replacing the Copilot-evidence special case with a general sink router.
- Then: generalize OTLP export to logs, traces, and metrics with per-signal endpoints and per-stream opt-in.
- Gated on plan 20: governed-action events depend on the command boundary being real and unified across the interactive engine and Symphony.

## 9. Open questions

- Hand-rolled OTLP versus the `@opentelemetry` SDK, decided against the maintenance cost as the export surface grows.
- Where the durable audit ledger lives (local SQLite table, forwarded stream, or both) and its retention, given PostHog is analytics and not the ledger.
- Whether operational telemetry should default on (with disclosure) like analytics, or default off, given the local-first, opt-in stance.
- The event taxonomy itself: the stable set of event types and attributes that serves all three streams without leaking content, which is the schema that makes or breaks this.
