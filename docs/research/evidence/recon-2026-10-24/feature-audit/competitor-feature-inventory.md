# Neokod competitor feature gap inventory

**Captured:** 2026-10-24  
**Model:** gpt-6-luna at max, substituted for unavailable Luna 6.1  
**Scope:** Read-only competitor feature gap inventory for the established 20-product roster. Current sources were refreshed using primary official repositories/docs; no product binaries, providers, provider accounts or runtime sessions were run.

## Coverage and evidence boundary

- 20 of 20 roster products are accounted for; 19 have a current-head source or official-doc anchor, while 1 (Paseo) has historical-only implementation evidence because its current target path was unavailable.
- The existing 4 October usage-source capture has 18 product bundles; GOAT and PandaCode were outside that prior manifest and are covered separately here. The 4 Oct usage-dashboard source capture includes 18 product bundles; GOAT and PandaCode are in the confirmed 20-product roster but covered here from separate current product source/docs. Absence from that manifest is not evidence either lacks usage telemetry.
- This is a focused feature-gap inventory, not exhaustive feature parity across products. Every source is primary repository code or official project documentation. No competitor application, binary, provider turn, account or runtime was exercised.
- Source SHAs identify repository heads captured on 24 October 2026, not release versions. Docs/client code are labeled where they do not establish backend/runtime behavior. The separate upstream T3 closed-PR census is outside this report.

## Neokod baseline

- **Current thread context:** apps/web/src/components/chat/ContextWindowMeter.tsx and apps/web/src/lib/contextWindow.ts show current context occupancy; this is not historical processed usage.
- **Provider quota:** packages/contracts/src/server.ts:157-184 has optional usage-window/limit shapes; apps/server/src/provider/copilot/CopilotQuota.ts, CopilotProvider.ts and provider/Layers/ClaudeUsageLimit.ts produce selected provider quota facts; providerSnapshot.ts:283 carries optional usage and providerStatus.ts:60-71 surfaces limit reached.
- **Turn usage:** packages/contracts/src/providerRuntime.ts:428-445 carries ThreadTokenUsageSnapshot; :483-491 allows optional turn usage/modelUsage/totalCostUsd. This is not a normalized durable usage ledger or historical graph.
- **Historical usage:** No production cross-session usage ledger or historical provider graph was found in the inspected paths. Canonical plan section 12 describes U-1 through U-7, with usage dashboard in section 13.2; treat this as planned/held work.
- **Metrics separation:** Keep current context occupancy, observed processed tokens, provider quota/account windows, provider-reported actual charges and API-equivalent estimated cost as distinct fields/views. Missing/unpriced must not become zero; estimated API-equivalent cost is not actual spend or a subscription bill.
- **Ui rule:** Upstream UI is intent-only under repository AGENTS.md. Future UI must be designed with Neokod components; no competitor UI/cherry-pick recommendation is made.
- **Source rule:** Repository head SHAs are source pins captured on 2026-10-24, not release versions. Source/docs do not prove runtime behavior. The Paseo implementation row is historical-only.

## Status meanings

- **complete:** The specific narrow Neokod capability is present in production source. Does not imply adjacent capabilities are complete.
- **partial:** Relevant contracts/producers exist, but requested scope, coverage, persistence, projection or UX is incomplete.
- **missing:** No corresponding production capability was identified in this source pass.
- **planned:** Canonical plan describes future work; not production implementation.
- **excluded:** The competitor capability depends on a different product boundary or is explicitly outside local-first scope.
- **unavailable evidence:** The relevant current/private producer/backend/runtime was not accessible from reviewed public sources; no positive or negative behavior claim is made.

## Product-by-product inventory

### 1. T3 (pingdotgg/t3code)

- **Evidence class/status:** primary repository implementation; source-only; current-head source inspected; OSS implementation. Source pin: 27e0c684c585f955252d65f06206dd11a143bff5; source capture date: 2026-10-24.
- **Competitor feature:** Local usage analytics and provider limit/account-window views: daily/hourly processed-token or API-equivalent cost charts, cache breakdowns, source coverage and local usage history; quota facts are surfaced separately.
- **Evidence:** The pinned page aggregates local provider history into time buckets and visibly distinguishes token/cost/cache coverage; docs warn that API-equivalent estimates are not subscription invoices. OSS source observation, not an executed product result. Source: [T3 source](https://github.com/pingdotgg/t3code/blob/27e0c684c585f955252d65f06206dd11a143bff5/apps/web/src/components/usage/UsagePage.tsx)
  - Additional source 1: https://github.com/pingdotgg/t3code/blob/27e0c684c585f955252d65f06206dd11a143bff5/docs/user/usage.md
- **Neokod status:** partial for current context and selected provider quota facts; missing historical charts/ledger, explicitly planned in plan.md sections 12 and 13.2
- **Actual Neokod paths / status boundary:**
  - packages/contracts/src/server.ts:157-184 (optional provider usage windows and limits)
  - apps/server/src/provider/providerSnapshot.ts:283 (provider usage snapshot)
  - apps/server/src/provider/copilot/CopilotQuota.ts
  - apps/server/src/provider/copilot/CopilotProvider.ts
  - apps/server/src/provider/Layers/ClaudeUsageLimit.ts
  - apps/web/src/components/settings/providerStatus.ts:60-71 (limit status only)
  - apps/web/src/components/chat/ContextWindowMeter.tsx
  - apps/web/src/lib/contextWindow.ts
- **Local-first fit and UI rule:** Strong local-first fit for source semantics and server-owned aggregation; upstream UI is intent-only and excluded by AGENTS.md. Keep context occupancy, processed tokens, quota windows, provider-reported charges and API-equivalent estimates separate.
- **Minimal Neokod design:** Use plan U-1..U-7: normalize evidence facts with source/coverage/freshness; add bounded, cached quota refresh; persist idempotent local usage facts/cursors; build bounded aggregates; expose through Neokod-owned views; make local history import opt-in; add child/machine drill-down only after attribution exists.
- **Dependencies and gates:** Provider-specific source adapters and pricing coverage; local persistence/schema migration; no unknown-to-zero; explicit stale/error/unavailable states; cache and single-flight; no invoice claim. Any UI must be built with Neokod components.
- **Verification when implementation is authorized:** After implementation, test representative Codex/Claude/Copilot history fixtures, partial/unpriced/known-zero cases, duplicate imports and cursor restart; verify charts against source facts and label estimates. Runtime/provider proof remains separate.
- **Limitations / unknowns:** No competitor binary/provider was run. Feature breadth is limited to cited source/docs; local history coverage may be incomplete. API-equivalent estimates are not actual subscription spend.

### 2. Paseo (getpaseo/paseo)

- **Evidence class/status:** primary repository implementation, historical pinned source; historical source only; current target path could not be confirmed at captured head. Source pin: 8216e86ecb92e9b6a39422b12dde8b70a619483e; current head observed b8bb335c563279be45544b1b20a1fa5b3e56d422; source capture date: 2026-10-24.
- **Competitor feature:** Provider usage-source registry with TTL caching and in-flight request coalescing, supporting local quota/usage aggregation.
- **Evidence:** The 4 Oct source capture shows a five-minute cache and coalescing around usage sources. The captured target URL at the 24 Oct head did not resolve, so this is historical design evidence only, not confirmation the implementation remains at that path. Source: [Paseo source](https://github.com/getpaseo/paseo/blob/8216e86ecb92e9b6a39422b1b20a1fa5b3e/packages/server/src/server/plugins/usage-sources/index.ts#L881)
  - Additional source 1: https://github.com/getpaseo/paseo
- **Neokod status:** partial for selected current quota facts; missing/planned for generalized refresh/cache policy and historical usage facts
- **Actual Neokod paths / status boundary:**
  - packages/contracts/src/server.ts:157-184
  - apps/server/src/provider/providerSnapshot.ts:283
  - apps/server/src/provider/copilot/CopilotQuota.ts
  - apps/server/src/provider/Layers/ClaudeUsageLimit.ts
  - plan.md section 12 U-2 and U-3
- **Local-first fit and UI rule:** Local usage-source refresh patterns fit if adapters read only owner-configured local provider state and report freshness/coverage. No hosted, pairing or cloud component is needed.
- **Minimal Neokod design:** Keep provider adapters behind the existing server provider boundary; apply one server-owned cache/single-flight policy, bounded timeouts and explicit result states; persist usage history separately from ephemeral quota refresh.
- **Dependencies and gates:** Reconfirm current upstream implementation before relying on it; provider rate limits and local credential scope; distinguish cache TTL from source freshness; avoid importing Paseo UI or service architecture.
- **Verification when implementation is authorized:** Unit-test coalesced concurrent reads, TTL expiry, stale last-good data, cancellation, adapter errors and zero-vs-unavailable states using deterministic fixtures.
- **Limitations / unknowns:** Only historical commit 8216e86 was inspected for this implementation. Current head b8bb335 was observed, but the corresponding current path was unavailable. No current feature claim.

### 3. Synara (Emanuele-web04/synara)

- **Evidence class/status:** primary repository implementation; UI plus profile stats source; current-head source inspected; OSS implementation. Source pin: 29b11e105200c7bc6e2c71a06a375513d4c8a72d; source capture date: 2026-10-24.
- **Competitor feature:** Profile usage statistics with activity heatmap and model-usage breakdown over local histories.
- **Evidence:** Pinned profile settings code contains usage statistics, heatmap and model-usage display. Historical capture identifies a profile stats source module; current UI evidence alone does not prove every provider/history is fully attributed. Source: [Synara source](https://github.com/Emanuele-web04/synara/blob/29b11e105200c7bc6e2c71a06a375513d4c8a72d/apps/web/src/components/settings/ProfileSettingsPanel.tsx#L1241)
  - Additional source 1: https://github.com/Emanuele-web04/synara/blob/29b11e105200c7bc6e2c71a06a375513d4c8a72d/apps/web/src/components/settings/ProfileSettingsPanel.tsx#L1261
  - Additional source 2: https://github.com/Emanuele-web04/synara/blob/29b11e105200c7bc6e2c71a06a375513d4c8a72d/apps/web/src/components/settings/ProfileSettingsPanel.tsx#L1453
- **Neokod status:** missing/planned for cross-session usage profiles, heatmap and model aggregates; partial current-thread context/quota facts
- **Actual Neokod paths / status boundary:**
  - packages/contracts/src/providerRuntime.ts:428-445 (thread token snapshot)
  - packages/contracts/src/providerRuntime.ts:483-491 (optional turn usage/modelUsage/totalCostUsd)
  - apps/web/src/components/chat/ContextWindowMeter.tsx
  - plan.md section 12 U-4/U-5
- **Local-first fit and UI rule:** Local-first profile aggregation fits after Neokod has normalized durable usage events and explicit provider/session coverage. A heatmap is a Neokod-owned UI decision, not a port target.
- **Minimal Neokod design:** Aggregate persisted usage facts by local date/provider/model with explicit incomplete attribution; retain source timestamps and session inclusion policy; add profile/heatmap presentation only after the shared projection is stable.
- **Dependencies and gates:** Normalize mixed-provider sessions, timezone/day boundaries, attribution confidence and missing-history coverage; avoid presenting a visual activity day as verified provider spend.
- **Verification when implementation is authorized:** Test mixed provider/session fixtures, timezone boundaries, missing model attribution, provider changes and known zero; reconcile aggregate totals to source facts.
- **Limitations / unknowns:** Source proves UI/code presence, not runtime accuracy or complete coverage. Historical mixed-provider undercount concerns are in existing research and should remain a risk to verify.

### 4. MonoCode (hardbeat920/monocode)

- **Evidence class/status:** primary repository implementation; provider account usage UI; current-head source inspected; OSS implementation. Source pin: 26465c620977f3951d0a532a0f7db32c3c179007; source capture date: 2026-10-24.
- **Competitor feature:** Provider account usage windows for 5-hour, daily, weekly and monthly periods, with used percentages, refresh and reset-time presentation.
- **Evidence:** Provider account usage component displays multiple rolling windows, percentage used and reset timing, with refresh. These are quota/account-window facts, not historical token consumption. Source: [MonoCode source](https://github.com/hardbeat920/monocode/blob/26465c620977f3951d0a532a0f7db32c3c179007/src/features/providers/ui/ProviderAccountUsage.tsx#L800)
  - Additional source 1: https://github.com/hardbeat920/monocode/blob/26465c620977f3951d0a532a0f7db32c3c179007/src/features/providers/ui/ProviderAccountUsage.tsx#L767
  - Additional source 2: https://github.com/hardbeat920/monocode/blob/26465c620977f3951d0a532a0f7db32c3c179007/src/features/providers/ui/ProviderAccountUsage.tsx#L946
- **Neokod status:** partial: selected Claude/Copilot quota facts exist and settings status can show limit reached; missing multi-window account usage surface and history
- **Actual Neokod paths / status boundary:**
  - packages/contracts/src/server.ts:173-184 (ServerProviderLimit)
  - apps/server/src/provider/copilot/CopilotQuota.ts
  - apps/server/src/provider/Layers/ClaudeUsageLimit.ts
  - apps/web/src/components/settings/providerStatus.ts:60-71
- **Local-first fit and UI rule:** Local provider quota integration fits; avoid conflating quota percentages with processed tokens, context or spend. Any display remains Neokod-owned.
- **Minimal Neokod design:** Normalize provider limit windows and reset timestamps in the shared provider usage contract; server refresh owns TTL/coalescing and stale/error state; expose through Neokod's own settings/status projections.
- **Dependencies and gates:** Provider-specific auth, rate limits, opaque account identity and reset semantics. Current Neokod schema is optional and narrower; schema evolution needs compatibility handling.
- **Verification when implementation is authorized:** Fixture-test window units, reset absent/known, expired/stale snapshots, provider error recovery and account switching without leaking opaque account identifiers.
- **Limitations / unknowns:** Source inspection only. Quota endpoint availability/runtime correctness were not tested. Quota usage must not be labelled historical spend.

### 5. OpenCodeX (lidge-jun/opencodex)

- **Evidence class/status:** primary repository implementation; gateway-scoped analytics UI; current-head source inspected; OSS implementation. Source pin: 9f0d40a25f8b842c33ab233d466d0bd991d86052; source capture date: 2026-10-24.
- **Competitor feature:** Usage page with gateway request/coverage summaries, total tokens/cache and estimated cost for requests handled by its inference routes.
- **Evidence:** The page summarizes measured gateway requests and token/cache fields and labels cost as estimated. Its accounting scope is requests passing through this gateway, not every provider CLI session or a provider subscription invoice. Source: [OpenCodeX source](https://github.com/lidge-jun/opencodex/blob/9f0d40a25f8b842c33ab233d466d0bd991d86052/gui/src/pages/Usage.tsx#L3057)
  - Additional source 1: https://github.com/lidge-jun/opencodex/blob/9f0d40a25f8b842c33ab233d466d0bd991d86052/gui/src/pages/Usage.tsx#L3095
- **Neokod status:** missing for gateway-request dashboard and durable normalized usage ledger; partial for optional turn usage payload and current context
- **Actual Neokod paths / status boundary:**
  - packages/contracts/src/providerRuntime.ts:483-491 (optional turn usage payload)
  - packages/contracts/src/providerRuntime.ts:428-445
  - apps/web/src/components/chat/ContextWindowMeter.tsx
  - plan.md section 12 U-1/U-3/U-4
- **Local-first fit and UI rule:** Local-first only if Neokod observes a local gateway path or provider events. Gateway-specific population is not interchangeable with Neokod's provider CLI sessions.
- **Minimal Neokod design:** First normalize provider-reported per-turn usage in the server event path and persist idempotently; add route/request dimensions only for a demonstrated Neokod gateway. Compute estimates with versioned pricing and explicit coverage.
- **Dependencies and gates:** No gateway feature is assumed. Need source event coverage, duplicate/replay handling, model-price snapshots and clear estimate labels. Do not add a gateway solely to reproduce this page.
- **Verification when implementation is authorized:** Reconcile captured request fixtures to provider-reported input/output/cache counts; test partial fields, replay duplicates and unpriced models; prove gateway-only scope in any later gateway test.
- **Limitations / unknowns:** OSS source-only. It does not establish usage outside this gateway, nor actual spend.

### 6. Omnigent (omnigent-ai/omnigent)

- **Evidence class/status:** primary repository implementation; usage dashboard source; current-head source inspected; OSS implementation. Source pin: f87fed537627f3278445df86fba6cd14bb809c1f; source capture date: 2026-10-24.
- **Competitor feature:** Daily cost/usage chart and model breakdown for recorded multi-agent work.
- **Evidence:** Pinned usage page renders daily cost data from its recorded task/model usage source. Existing source review documents child-result and recovery patterns, but this row only asserts the visible aggregate backed by the page. Source: [Omnigent source](https://github.com/omnigent-ai/omnigent/blob/f87fed537627f3278445df86fba6cd14bb809c1f/web/src/pages/UsagePage.tsx)
- **Neokod status:** missing/planned for persisted usage aggregates and model/day breakdown; child usage attribution also not complete
- **Actual Neokod paths / status boundary:**
  - packages/contracts/src/providerRuntime.ts:483-491 (optional per-turn payload)
  - plan.md section 12 U-3/U-4/U-7
  - plan.md sections 16.15-19 (child orchestration planned; no completion asserted)
- **Local-first fit and UI rule:** Local-first fit depends on retaining only local child/session usage events with parent/child provenance. No hosted Omnigent components or UI are adopted.
- **Minimal Neokod design:** Extend normalized usage facts with parent/child/run IDs only when authoritative; aggregate daily/model totals with inclusion and coverage flags; keep incomplete child usage explicitly unknown.
- **Dependencies and gates:** W6 child lifecycle and durable attribution; event source completeness; duplicate child callback idempotency; local DB migration; no automatic attribution from display labels.
- **Verification when implementation is authorized:** Test parent/child usage rollup, duplicate callbacks, late child results, unknown child usage and explicit include/exclude filters; reconcile total to underlying events.
- **Limitations / unknowns:** Source only; no competitor run. Daily chart existence does not prove completeness, billed amount or exact treatment of incomplete children.

### 7. Empryo (proxysoul/Empryo)

- **Evidence class/status:** primary public repository implementation; client/dashboard only; current public source inspected; current v3 backend evidence unavailable. Source pin: c27dac116d2ee1637abfc6634bebf08b5c379454; source capture date: 2026-10-24.
- **Competitor feature:** Public v2 status dashboard shows aggregated child/cache/model usage and cost rows.
- **Evidence:** Current public source has a status dashboard with model breakdown and cost rows. Current v3 backend portions are private/unavailable, so do not infer current backend completeness or exact accounting from public UI. Source: [Empryo source](https://github.com/proxysoul/Empryo/blob/c27dac116d2ee1637abfc6634bebf08b5c379454/src/components/modals/StatusDashboard.tsx)
- **Neokod status:** missing/planned for durable child/model attribution; optional raw turn usage is present but not projected as history
- **Actual Neokod paths / status boundary:**
  - packages/contracts/src/providerRuntime.ts:428-445
  - packages/contracts/src/providerRuntime.ts:483-491
  - plan.md section 12 U-1/U-3/U-4/U-7
- **Local-first fit and UI rule:** General semantic idea fits for local child/model attribution. Private service/backend design and UI are unavailable and not assumed.
- **Minimal Neokod design:** Record server-authoritative model/provider/session/parent IDs on normalized usage facts; project a child and model breakdown only for observed facts and display unknown coverage.
- **Dependencies and gates:** W6 managed-child persistence, provider-native vs managed-child classification, source coverage and pricing provenance.
- **Verification when implementation is authorized:** Validate child aggregation only against durable authoritative event IDs; test missing model, missing cost, provider-native child and duplicate completion.
- **Limitations / unknowns:** Only public client source is evidenced. Current v3 backend and runtime accounting behavior are unavailable.

### 8. PandaCode (aicodeking/pandacode)

- **Evidence class/status:** primary repository docs/source; multi-worker local task orchestration; current-head public README and source inspected; OSS implementation. Source pin: 9e47ea045b8bd76e8113d3696175f54636fbb64b; source capture date: 2026-10-24.
- **Competitor feature:** Architect flow can coordinate up to three mixed-harness workers from a local task board; cloud-agent capability is described separately.
- **Evidence:** Public README distinguishes local architect workers/task board from cloud agents. Only local worker concept is in scope; no runtime was launched and cloud-agent infrastructure is excluded. Source: [PandaCode source](https://github.com/aicodeking/pandacode/blob/9e47ea045b8bd76e8113d3696175f54636fbb64b/README.md#L199)
  - Additional source 1: https://github.com/aicodeking/pandacode/blob/9e47ea045b8bd76e8113d3696175f54636fbb64b/src-tauri/src/architect.rs
- **Neokod status:** planned/incomplete: W6 child orchestration is documented in plan.md sections 16.15-19; no completed managed multi-child code path established by this audit
- **Actual Neokod paths / status boundary:**
  - plan.md sections 16.15-19 (planned work, not production code)
  - apps/server/src/symphony/HandoffService.ts (manual Symphony handoff, not ordinary managed children)
  - packages/contracts/src/providerRuntime.ts (provider events; no worker coordinator ledger identified)
- **Local-first fit and UI rule:** Local multi-worker orchestration can fit if it runs on selected owner machine/workspace and is bounded; cloud-agent variant is excluded. Neokod UI must use its own components.
- **Minimal Neokod design:** Continue existing W6 plan: server-owned admission, stable parent/child IDs, provider capability checks, bounded concurrency/depth, isolated worktrees and durable receipts; avoid a second task-board scheduler.
- **Dependencies and gates:** W6 dependencies and acceptance criteria, provider capabilities, worktree ownership, effective permission ceiling, admission limits and restart/late-result handling.
- **Verification when implementation is authorized:** Use plan-specified child fixture and fault/restart cases when implementation is authorized; prove one parent-child local run with correct workspace/provider attribution and no shared-write collision.
- **Limitations / unknowns:** README capability is source/documented, not live verification. Worker limit/details are competitor-specific and not a target requirement. Cloud mode excluded.

### 9. GOAT (goat-si/goat)

- **Evidence class/status:** primary repository implementation; fleet console source; current dev-head source inspected; OSS implementation. Source pin: branch dev at 4a04fa32548e792122bdb5ff954e29b6be905bf8; source capture date: 2026-10-24.
- **Competitor feature:** Fleet console exposes agent/session telemetry across managed coding-agent workers.
- **Evidence:** Pinned FleetConsole contains telemetry-oriented fleet UI. This is fleet/session observability, not proof of provider usage accounting or historical spend. Source: [GOAT source](https://github.com/goat-si/goat/blob/4a04fa32548e792122bdb5ff954e29b6be905bf8/apps/web/src/components/fleet/FleetConsole.tsx#L3328)
- **Neokod status:** missing for fleet-level host telemetry; planned owner-machine/direct-machine scope in plan.md; current per-thread context/quota is separate
- **Actual Neokod paths / status boundary:**
  - apps/server/src/provider/providerSnapshot.ts:283 (per-provider snapshot)
  - apps/web/src/components/chat/ContextWindowMeter.tsx (per-thread context)
  - plan.md section 12 U-6/U-7 (planned opt-in local history and owner-machine summaries; not implemented)
- **Local-first fit and UI rule:** User-controlled direct machine view can fit under the 4 Oct owner exception if target identity is visible/pinned and non-loopback listener requires token. Hosted fleet, relay and shared tenancy remain excluded.
- **Minimal Neokod design:** Keep local usage facts owned by source machine; later add explicit machine IDs and bounded federated projections over authorized owner-direct links; do not treat fleet liveness as usage evidence.
- **Dependencies and gates:** Direct-connection target pinning/token boundary and owner-machine roadmap; per-machine data ownership, transport security and freshness. This inventory does not authorize implementation.
- **Verification when implementation is authorized:** When planned, test machine identity pinning, stale/offline source behavior, duplicate aggregation and source-to-host coverage; ensure fleet tile does not fabricate cost or completeness.
- **Limitations / unknowns:** Source indicates fleet telemetry only, not historical local provider billing. Captured branch is dev, not stable release.

### 10. Orca (stablyai/orca)

- **Evidence class/status:** primary repository implementation; local usage scanner and daily overview; current-head source inspected; OSS implementation. Source pin: d3d429c15614062cc8764a546d85e3d9d9a852d2; source capture date: 2026-10-24.
- **Competitor feature:** Local Codex history scanner with daily usage overview, refresh/last-updated state and partial price coverage.
- **Evidence:** Usage overview builds daily summaries from local provider history, exposes refresh and last-updated context, and treats price coverage as partial. Captured scanner design uses local Codex history rather than provider account invoices. Source: [Orca source](https://github.com/stablyai/orca/blob/d3d429c15614062cc8764a546d85e3d9d9a852d2/src/renderer/src/components/stats/UsageOverviewPane.tsx)
  - Additional source 1: https://github.com/stablyai/orca/blob/d3d429c15614062cc8764a546d85e3d9d9a852d2/src/main/codex-usage/scanner.ts
- **Neokod status:** missing/planned for local-history importer, durable facts, daily graph and coverage state
- **Actual Neokod paths / status boundary:**
  - packages/contracts/src/providerRuntime.ts:483-491 (live turn usage payload only)
  - apps/web/src/components/chat/ContextWindowMeter.tsx (current context)
  - plan.md section 12 U-3/U-4/U-6 and section 13.2
- **Local-first fit and UI rule:** Strong local-first fit for an opt-in local-history adapter. Importing local files must be user-controlled and preserve provenance/coverage.
- **Minimal Neokod design:** Use a source adapter and incremental cursor into normalized ledger; make daily rollup deterministic and pricing versioned/optional; record last scan, source completeness and errors.
- **Dependencies and gates:** Opt-in file access, provider JSONL format/version changes, idempotent cursors, timezone semantics and unpriced models.
- **Verification when implementation is authorized:** Fixture-test source parsing, incremental scans, repeated imports, partial files, malformed entries, absent history and pricing changes; compare aggregates with raw facts.
- **Limitations / unknowns:** OSS source only. Local scanner coverage can be partial and cost is not necessarily actual spend. Runtime permissions were not tested.

### 11. Agent Orchestrator (OrchestratorInc/agent-orchestrator)

- **Evidence class/status:** primary repository domain implementation; accounting provenance; current-head source inspected; OSS implementation. Source pin: 7e1bb8f0b740eff6a2663f36d22f9db064bd9a8a; source capture date: 2026-10-24.
- **Competitor feature:** Usage-cost aggregate preserves event count, priced-event count, observed versus inferred cost, session summaries, model and harness attribution.
- **Evidence:** Domain source distinguishes event counts and priced counts and carries inferred/observed cost distinctions into summaries. Useful accounting provenance pattern; does not establish exact provider invoices. Source: [Agent Orchestrator source](https://github.com/OrchestratorInc/agent-orchestrator/blob/7e1bb8f0b740eff6a2663f36d22f9db064bd9a8a/backend/internal/domain/usage.go#L1709)
  - Additional source 1: https://github.com/OrchestratorInc/agent-orchestrator/blob/7e1bb8f0b740eff6a2663f36d22f9db064bd9a8a/backend/internal/domain/usage.go#L1775
  - Additional source 2: https://github.com/OrchestratorInc/agent-orchestrator/blob/7e1bb8f0b740eff6a2663f36d22f9db064bd9a8a/backend/internal/domain/usage.go#L1814
- **Neokod status:** partial raw optional turn usage/cost fields; missing durable normalized ledger, coverage/provenance projection and cross-session aggregates; planned U-1..U-7
- **Actual Neokod paths / status boundary:**
  - packages/contracts/src/providerRuntime.ts:483-491
  - packages/contracts/src/providerRuntime.ts:428-445
  - packages/contracts/src/server.ts:157-184
  - plan.md section 12 U-1/U-3/U-4
- **Local-first fit and UI rule:** Strong semantic fit for local accounting provenance; adopt field distinctions, not another orchestrator's UI/schema wholesale.
- **Minimal Neokod design:** Define normalized usage facts with source kind, observed/inferred amount, pricing version, coverage and event identity; preserve provider-reported unknowns and aggregate priced/unpriced counts separately.
- **Dependencies and gates:** Schema design, provider/account/session attribution, pricing source/version and durable idempotency. Existing untyped optional runtime fields need contract normalization.
- **Verification when implementation is authorized:** Test observed zero vs missing, reported vs inferred costs, unpriced events, duplicate turns and aggregate priced-count reconciliation.
- **Limitations / unknowns:** Source-level domain semantics only. No live or complete accounting behavior was verified; API-equivalent estimates remain distinct from actual spend.

### 12. Hermes (NousResearch/hermes-agent)

- **Evidence class/status:** primary project documentation; current-head official docs inspected; runtime implementation not verified. Source pin: bac34e9e9946c9c6a9ce7ce64efadd47f8fa375b; source capture date: 2026-10-24.
- **Competitor feature:** Dashboard analytics documentation describes 7/30/90-day session history, token/cache totals, estimated or actual cost, daily chart and daily/model tables.
- **Evidence:** Official docs describe the analytics surface and stated metrics. Documentation is not proof current released/runtime behavior matches every claim. Source: [Hermes source](https://github.com/NousResearch/hermes-agent/blob/bac34e9e9946c9c6a9ce7ce64efadd47f8fa375b/website/docs/user-guide/features/web-dashboard.md#L387)
- **Neokod status:** missing/planned for historical session dashboard and rollups; partial current thread context/optional per-turn payload
- **Actual Neokod paths / status boundary:**
  - apps/web/src/components/chat/ContextWindowMeter.tsx
  - packages/contracts/src/providerRuntime.ts:428-445
  - packages/contracts/src/providerRuntime.ts:483-491
  - plan.md section 12 U-3/U-4/U-5 and section 13.2
- **Local-first fit and UI rule:** Local-first relevance depends on documented dashboard mode and data ownership; only local data patterns are considered, hosted/account-based components are excluded.
- **Minimal Neokod design:** Use local normalized facts and bounded daily/model projections, with timeframe selection only after coverage and timestamps are trustworthy; keep actual provider-reported versus estimated cost explicit.
- **Dependencies and gates:** Confirm local data source and release/runtime path before deeper design; attribution completeness, estimate semantics, retention and privacy.
- **Verification when implementation is authorized:** Inspect data producer/release path and reconcile displayed chart with session records; test incomplete history and actual-vs-estimated labels.
- **Limitations / unknowns:** Docs-only row. Current runtime implementation and whether all data is locally derived were not verified.

### 13. Oh My Pi (can1357/oh-my-pi)

- **Evidence class/status:** primary repository implementation and package documentation; local SQLite rollups; current-head source inspected; OSS implementation. Source pin: 0b5c27ab24719c86a5986b95ee55f4e75bc1aaa0; source capture date: 2026-10-24.
- **Competitor feature:** Local usage package imports JSONL histories, maintains hourly SQLite rollups, supports incremental sync/cursors and serves a dashboard.
- **Evidence:** Package documents local JSONL ingestion, hourly SQLite rollups, incremental sync and atomic cursor handling. Clearest local-history ingestion pattern in roster; source inspection does not prove operational performance. Source: [Oh My Pi source](https://github.com/can1357/oh-my-pi/blob/0b5c27ab24719c86a5986b95ee55f4e75bc1aaa0/packages/stats/README.md#L196)
  - Additional source 1: https://github.com/can1357/oh-my-pi/blob/0b5c27ab24719c86a5986b95ee55f4e75bc1aaa0/packages/stats/README.md#L251
- **Neokod status:** missing/planned for history ingestion, durable ledger, rollups and graph; current optional runtime usage is not a historical dashboard
- **Actual Neokod paths / status boundary:**
  - packages/contracts/src/providerRuntime.ts:483-491
  - plan.md section 12 U-3/U-4/U-6 and section 13.2
- **Local-first fit and UI rule:** Strong local-first fit for opt-in incremental local-history adapter and bounded SQLite summaries. Reuse approach conceptually within Neokod persistence; do not add another stats database without need.
- **Minimal Neokod design:** Build a versioned source adapter feeding Neokod local usage facts; commit imported rows and cursor atomically; calculate hourly/daily aggregates from source facts with coverage metadata.
- **Dependencies and gates:** File-source opt-in, format compatibility, existing DB/migration conventions, transaction atomicity, retention and bounded scan/CPU usage.
- **Verification when implementation is authorized:** Test interruption during import, cursor replay, appended/rewritten source files, source-version changes, large histories and aggregate reproducibility.
- **Limitations / unknowns:** Package docs/source only. A local SQLite analytics path does not establish complete cross-provider coverage or invoice accuracy.

### 14. Pi (earendil-works/pi)

- **Evidence class/status:** primary repository documentation and implementation; session-scoped usage; current-head source inspected; OSS implementation. Source pin: bdb151774ed6bef2b5676bbff4669f20a0c233fe; source capture date: 2026-10-24.
- **Competitor feature:** Session-level usage totals and current context meter, including token/cost information and session-file/message metadata.
- **Evidence:** Docs describe a context/footer meter and session inspection with accumulated usage; implementation totals session cost and tracks provider-reported cost state. Session-level, not cross-session analytics. Source: [Pi source](https://github.com/earendil-works/pi/blob/bdb151774ed6bef2b5676bbff4669f20a0c233fe/packages/coding-agent/docs/usage.md#L199)
  - Additional source 1: https://github.com/earendil-works/pi/blob/bdb151774ed6bef2b5676bbff4669f20a0c233fe/packages/coding-agent/docs/usage.md#L245
  - Additional source 2: https://github.com/earendil-works/pi/blob/bdb151774ed6bef2b5676bbff4669f20a0c233fe/packages/coding-agent/src/core/usage.ts#L469
- **Neokod status:** complete only for narrow current-thread context meter; partial optional turn usage; missing/planned cross-session history/rollups
- **Actual Neokod paths / status boundary:**
  - apps/web/src/components/chat/ContextWindowMeter.tsx
  - apps/web/src/lib/contextWindow.ts
  - packages/contracts/src/providerRuntime.ts:428-445
  - packages/contracts/src/providerRuntime.ts:483-491
- **Local-first fit and UI rule:** Session usage semantics fit Neokod's thread model; cumulative cross-session graphs need durable facts. Do not equate current context occupancy with accumulated tokens.
- **Minimal Neokod design:** Normalize observed turn facts and project a per-session cumulative view; retain existing context meter for occupancy; persist across restart only under U-3 ledger semantics.
- **Dependencies and gates:** Provider-reported usage consistency, current turn completion contract, missing events/reconnects, unknown cost and session retention.
- **Verification when implementation is authorized:** Compare session total to event ledger across provider switch, restart/replay, missing cost and context compaction; ensure occupancy and cumulative usage have distinct labels.
- **Limitations / unknowns:** Source docs/code only; no runtime test. Session totals do not provide full provider account quotas or cross-session graphs.

### 15. bb (get-bb/bb)

- **Evidence class/status:** primary repository documentation/source; account usage windows; current-head source inspected; OSS implementation. Source pin: 5e1acd765039e874643f34c4d35409e58484e408; source capture date: 2026-10-24.
- **Competitor feature:** Provider tabs show machine-local or selected shared account plan, quota window bars/percentages and resets; failures retain last-good values and unavailable usage is not represented as zero.
- **Evidence:** Plugin docs describe provider account quota windows and robust unavailable/last-good semantics, including selected machine scope. This is quota state, not historical processed-token analytics. Source: [bb source](https://github.com/get-bb/bb/blob/5e1acd765039e874643f34c4d35409e58484e408/plugins/README.md#L192)
- **Neokod status:** partial for some current provider quota facts and status; missing account/window presentation breadth and history
- **Actual Neokod paths / status boundary:**
  - packages/contracts/src/server.ts:173-184
  - apps/server/src/provider/copilot/CopilotQuota.ts
  - apps/server/src/provider/Layers/ClaudeUsageLimit.ts
  - apps/web/src/components/settings/providerStatus.ts:60-71
- **Local-first fit and UI rule:** Local provider quota fetch fits; selected machine data is only in scope under owner-controlled direct-connection exception. Do not add shared/cloud account tenancy.
- **Minimal Neokod design:** Represent quota as typed freshness-bearing snapshots with stale/unavailable/error distinctions; reuse server cache/single-flight and expose provider capability scope without exposing secret account keys.
- **Dependencies and gates:** Local credential availability, provider-specific windows/resets, multi-machine authorization/pinning only if direct remote is later implemented.
- **Verification when implementation is authorized:** Test no-data vs 0%, last-good retention, errors, stale timestamps, reset timing, machine source identity and sensitive identifier redaction.
- **Limitations / unknowns:** Documentation/source only; account APIs were not called. Quota windows do not imply historical usage or actual spend.

### 16. Superset (superset-sh/superset)

- **Evidence class/status:** primary repository implementation; history and quota UI sources; current-head source inspected; OSS implementation. Source pin: 86a6414296d3242693ac898bc785b942be58514f; source capture date: 2026-10-24.
- **Competitor feature:** Usage history section alongside current plan/quota and credit-window presentation.
- **Evidence:** Pinned source has a usage-history view and a separate quota/plan/credit view. Earlier 4 Oct review recorded possible misleading cost/coverage behavior at its earlier capture; that warning is not re-verified against current head and is not asserted as a current defect. Source: [Superset source](https://github.com/superset-sh/superset/blob/86a6414296d3242693ac898bc785b942be58514f/apps/desktop/src/components/usage/UsageHistorySection.tsx)
  - Additional source 1: https://github.com/superset-sh/superset/blob/86a6414296d3242693ac898bc785b942be58514f/apps/desktop/src/components/usage/UsageView.tsx#L1803
- **Neokod status:** partial for some quota state; missing/planned historical cross-session usage view
- **Actual Neokod paths / status boundary:**
  - packages/contracts/src/server.ts:157-184
  - apps/web/src/components/settings/providerStatus.ts:60-71
  - apps/web/src/components/chat/ContextWindowMeter.tsx
  - plan.md section 12 and section 13.2
- **Local-first fit and UI rule:** Distinction between history and current quota fits. UI is reference-only; Neokod builds own presentation after source facts are reliable.
- **Minimal Neokod design:** Keep history queries over normalized usage facts separate from live quota refresh. Add plan/credit fields only if provider supplies them and label provider/source.
- **Dependencies and gates:** Confirm current history producer, source coverage and cost semantics before copying any displayed number; respect local-first and no-invoice claims.
- **Verification when implementation is authorized:** Reconcile current quota projection and history independently; test stale snapshots, unpriced history, available plan metadata and zero vs unknown.
- **Limitations / unknowns:** Current source confirms view code, not runtime accuracy. Prior issue observations apply only to 4 Oct reviewed revision unless reverified.

### 17. Traycer (traycerai/traycer)

- **Evidence class/status:** primary public client implementation; private execution path unavailable; current public client source inspected; execution-host/backend source unavailable. Source pin: 08bdf4e09e6365619911b52159fabd40f84fb5a6; source capture date: 2026-10-24.
- **Competitor feature:** Usage analytics UI displays usage/coverage and served-by information, with host split/calendar and export exclusion controls.
- **Evidence:** Public client code demonstrates a usage summary, coverage and host-related controls. Execution Host/private backend and data collection path are not public, so accounting semantics, source ownership and localness are unverified. Source: [Traycer source](https://github.com/traycerai/traycer/blob/08bdf4e09e6365619911b52159fabd40f84fb5a6/clients/gui-app/src/components/usage-analytics/usage-summary-panel.tsx#L2455)
  - Additional source 1: https://github.com/traycerai/traycer/blob/08bdf4e09e6365619911b52159fabd40f84fb5a6/clients/gui-app/src/components/usage-analytics/usage-summary-panel.tsx#L2517
- **Neokod status:** unavailable evidence for backend semantics; missing/planned for Neokod host-scoped usage aggregation; partial raw turn usage only
- **Actual Neokod paths / status boundary:**
  - packages/contracts/src/providerRuntime.ts:483-491
  - plan.md section 12 U-6/U-7 (future owner-machine/local-source scope)
- **Local-first fit and UI rule:** Only public-client semantics are an inspiration. Do not adopt remote-host data paths until proven owner-controlled direct connection; hosted control plane remains excluded.
- **Minimal Neokod design:** Wait for public producer/provenance evidence before designing a compatible schema; Neokod's own future host aggregation should consume explicitly authorized local facts and expose coverage.
- **Dependencies and gates:** Private execution backend unavailable; machine identity, source ownership and export/privacy semantics unresolved.
- **Verification when implementation is authorized:** No behavioral test possible from public client alone. If source becomes available, trace producer to UI and verify host attribution/coverage end-to-end.
- **Limitations / unknowns:** Public client only. No private backend, provider session or runtime inspected; local-first fit remains unproven.

### 18. HarnessRouter (HarnessRouter/harnessrouter)

- **Evidence class/status:** primary repository implementation; gateway platform billing UI; current-head source inspected; OSS implementation. Source pin: 91f12963cc2c92be2f8ce89a384b4222417aadb1; source capture date: 2026-10-24.
- **Competitor feature:** Billing usage page shows platform credits spent over time for requests routed through HarnessRouter.
- **Evidence:** The page accounts for HarnessRouter's own platform credits/usage. It does not represent provider subscription spend or all local CLI activity. Source: [HarnessRouter source](https://github.com/HarnessRouter/harnessrouter/blob/91f12963cc2c92be2f8ce89a384b4222417aadb1/ui/src/app/%28app%29/billing/usage/page.tsx#L604)
  - Additional source 1: https://github.com/HarnessRouter/harnessrouter/blob/91f12963cc2c92be2f8ce89a384b4222417aadb1/ui/src/app/%28app%29/billing/usage/page.tsx#L749
- **Neokod status:** excluded as a Neokod feature gap: Neokod has no router-platform credit account; no such billing surface is planned. General event accounting remains missing/planned separately.
- **Actual Neokod paths / status boundary:**
  - apps/web/src/components/chat/ContextWindowMeter.tsx (context only)
  - packages/contracts/src/providerRuntime.ts:483-491 (optional turn usage only)
  - plan.md section 12 (local usage evidence, not third-party platform billing)
- **Local-first fit and UI rule:** Exclude platform credit billing, gateway account and any account/hosted control plane. A generic observed-usage ledger is independently local-first and already planned.
- **Minimal Neokod design:** Do not implement HarnessRouter credit semantics. Continue with Neokod U-1..U-7 for local provider evidence and estimates only where supported.
- **Dependencies and gates:** No relevant dependency unless Neokod separately adopts a local gateway, which is not current scope.
- **Verification when implementation is authorized:** No implementation verification required for excluded scope. Ensure future comparisons label gateway credits separately from actual provider spend.
- **Limitations / unknowns:** Source confirms platform billing UI only; no provider invoices or local CLI history.

### 19. CodexMonitor (Dimillian/CodexMonitor)

- **Evidence class/status:** primary repository implementation; local Codex usage graph; current-head source inspected; OSS implementation. Source pin: dd61b9abd37de5ded86e82b9fe8a83fd49d46fa5; source capture date: 2026-10-24.
- **Competitor feature:** Local Codex weekly usage snapshot and bar chart with token/time toggle and workspace filtering.
- **Evidence:** Cited home section builds a weekly graph from local Codex usage and supports workspace filtering and tokens/time display modes. Focused single-provider local history reference, not multi-provider quota aggregation. Source: [CodexMonitor source](https://github.com/Dimillian/CodexMonitor/blob/dd61b9abd37de5ded86e82b9fe8a83fd49d46fa5/src/features/home/components/HomeUsageSection.tsx#L992)
  - Additional source 1: https://github.com/Dimillian/CodexMonitor/blob/dd61b9abd37de5ded86e82b9fe8a83fd49d46fa5/src/features/home/components/HomeUsageSection.tsx#L1082
- **Neokod status:** missing/planned for local Codex historical graph and workspace-level rollups; current context meter is complete only for current conversation
- **Actual Neokod paths / status boundary:**
  - apps/web/src/components/chat/ContextWindowMeter.tsx
  - apps/web/src/lib/contextWindow.ts
  - packages/contracts/src/providerRuntime.ts:483-491
  - plan.md section 12 U-3/U-4/U-6 and section 13.2
- **Local-first fit and UI rule:** Strong local-first fit as Codex history-source reference. UI remains Neokod-owned; time/token chart semantics should be selected deliberately and not conflated.
- **Minimal Neokod design:** Add opt-in Codex local-history adapter to normalized ledger, index workspace/session provenance, and create bounded daily/weekly projections; reuse same ledger for other providers.
- **Dependencies and gates:** Codex local file format/permissions, provider event overlap/deduplication, workspace mapping and history retention.
- **Verification when implementation is authorized:** Compare imported workspace/week totals against fixture history; test workspace moves, missing files, duplicate current/live events and token/time modes.
- **Limitations / unknowns:** Codex-only source coverage, source-only inspection. Does not establish other providers or account limits.

### 20. CodexHost (BytePioneer-AI/codex-host)

- **Evidence class/status:** primary repository implementation and release note; machine-local harness metering; current-head source inspected; OSS implementation; release note cross-reference. Source pin: 82e4839808ae692ac5cd0c23339c3db8e7a043c9; source capture date: 2026-10-24.
- **Competitor feature:** Host-side machine-wide usage metering for several local harnesses, including request cost/speed, cache-hit and first-output metrics; pricing can refresh from models.dev and unpriced cost is described as a lower bound.
- **Evidence:** v0.13.0 release note (7 Oct 2026, release commit 803fb98) states host-side metering across multiple harnesses and request-level metrics; current-head source was also inspected. This is machine-local process/request telemetry and estimated pricing, not provider subscription invoice. Source: [CodexHost source](https://github.com/BytePioneer-AI/codex-host/blob/82e4839808ae692ac5cd0c23339c3db8e7a043c9/packages/renderer-extension/src/renderer-usage-control.ts)
  - Additional source 1: https://github.com/BytePioneer-AI/codex-host/releases/tag/v0.13.0
- **Neokod status:** missing/planned for machine-wide cross-harness usage and owner-machine drilldown; partial current thread-level usage payload/context
- **Actual Neokod paths / status boundary:**
  - packages/contracts/src/providerRuntime.ts:483-491
  - packages/contracts/src/providerRuntime.ts:428-445
  - plan.md section 12 U-6/U-7 and section 13.2 (planned owner-machine usage work, held; not implemented)
- **Local-first fit and UI rule:** Local single-machine metering is aligned; multi-machine extension only under explicit owner-controlled direct connection with pinned target and required token for non-loopback listeners. Hosted relay infrastructure is not copied.
- **Minimal Neokod design:** First build per-session usage facts from Neokod providers; later add host-local collector only where Neokod owns process/request instrumentation, with machine-scoped identity and pricing provenance. Keep unknown model prices as lower-bound/unknown, never actual spend.
- **Dependencies and gates:** Provider/host process instrumentation coverage, duplicate request/turn identity, local data ownership, privacy/retention, price source version and owner-direct security for remote hosts.
- **Verification when implementation is authorized:** Test event-to-request attribution, multi-harness overlap, cache metrics, unpriced-model lower bounds, host offline/stale state and no double-counting. Later remote aggregation requires pinned-machine/token boundary tests.
- **Limitations / unknowns:** Source/release evidence only; no host was run. Pricing-derived values are estimates and request coverage may be incomplete. Release notes are not runtime proof.

## Reading the local usage gap

The clearest directly relevant local references are T3 for multi-source charts and limits, Oh My Pi and Orca for local history ingestion/rollups, CodexMonitor for a local Codex weekly graph, and CodexHost for machine-wide cross-harness metering. They measure different populations. T3 and CodexHost include estimated-cost semantics; neither makes estimates equivalent to provider bills. MonoCode and bb primarily demonstrate quota-window presentation, not historical processed-token graphs. OpenCodeX and HarnessRouter measure traffic through their own gateway/platform boundary. Synara, Omnigent and Empryo show profile/model/child aggregation patterns, with coverage/backend limits stated per row.

Neokod currently has a current-thread context meter, optional per-turn usage contract fields and selected current provider quota facts. It does not have the durable cross-session facts, source cursors, bounded historical aggregates or usage graph described in canonical U-1 through U-7. This conclusion is a source-inspection finding, not runtime proof.

## Canonical inputs read

- README.md
- AGENTS.md
- plan.md sections 16.15-16.19
- docs/research/feature-verdicts-2026-10-04.md
- docs/research/competitor-codebase-review-2026-10-04.md
- docs/research/evidence/usage-dashboard-source-capture-2026-10-04.json

## Coverage accounting in machine-readable data

The adjacent JSON contains all product evidence fields and coverage counts. The CSV has one row per product; source lists and Neokod paths are JSON-encoded within CSV cells. The raw normalized data is retained as data.json.
