# Neokod completion plan, 4 October 2026

Status: research and critical review in progress; implementation not started by this workstream. This is the canonical programme checklist requested by the owner. [Plan 20](.plans/20-orchestration-direction.md) retains architectural decisions and historical reviews; it points here for current execution status. Update this file rather than creating another competing roadmap.

Source assessment: [research-10-04.md](research-10-04.md). Existing detail: [competitor report](docs/research/competitor-codebase-review-2026-10-04.md), [validated T3 findings](docs/research/t3-corrected-findings-2026-10-04.md), [seven-adapter intake assessment](docs/research/work-delivery-intake-review-2026-10-04.md), and [state/evidence rules](docs/architecture/state-and-evidence.md).

## Product and architecture decisions

1. Normal chat is the primary interface for discussion, bounded delegation and attributed outcomes. A mode change is not required to ask for orchestration.
2. Symphony remains the optional durable workstream, scheduler, validation and human-review destination. Keep its project board and operational controls. Delivery apps and repository hosting are independent connections.
3. Treat desktop-shell replacement, execution-core replacement, UI changes and T3 provenance removal as separate decisions. Start with a thin Tauri 2 feasibility slice retaining the current server; a full rewrite requires a demonstrated benefit or an explicit provenance objective.
4. Existing Code/Symphony attempt records remain authoritative. A common delegation request links them to chat and results. Do not copy attempt lifecycle into another universal run store.
5. Support delivery apps through explicit scoped capabilities: Jira, Linear, GitHub Issues, GitHub Projects, Azure Boards, GitLab and Asana first; future adapters satisfy the same conformance criteria. Do not advertise every app or write-back from registration/authentication alone.
6. Upstream UI and hosted transports remain excluded. New board/chat UI is independently designed in Neokod. Compare competitor intent and failures; do not import an entire engine or copy restricted source.

## Status carried forward

| Item                                                                    | Evidence / state                                                                                           | Remaining gate                                                                                                                         |
| ----------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| T3 latest stable/nightly/main and all closed/open PR enumeration        | Complete as captured inventory: 4,292 PRs, not a line-by-line audit of every diff                          | Eight incomplete file inventories remain deferred; revisit only if their change is selected                                            |
| Independent Sol validation of previous Luna research                    | Complete: all 100 PR findings and 17 broader claims accounted for and corrected                            | Relevant implementation/runtime gates still apply                                                                                      |
| Claude Sonnet 5.5 critique                                              | Complete, two bounded context-based critiques                                                              | Advice is not independent repository or runtime proof                                                                                  |
| All B-and-above competitors plus Synara                                 | Complete as source/primary-document/issue research: 17 apps, 24,333 open-issue records, 100 selected cases | No competitor runtime reproduction; private-source gaps remain visible                                                                 |
| Synara three-calendar-month PR review                                   | Complete as captured inventory: 965 labelled records and selected comparisons                              | Inventory is not blanket port approval                                                                                                 |
| Wider frontend/desktop/performance research                             | Complete: 49 additional source/document patterns with local matches and finite proposed gates              | Local performance measurements and implementation outstanding                                                                          |
| Tracker-neutral chat intake assessment                                  | Complete for all seven registered adapters                                                                 | Scoped reference intake, durable chat/result linkage, write-back capabilities and live proof outstanding                               |
| Local critical review, Kanban comparison, licence and desktop migration | In progress in this turn                                                                                   | Integrate bounded Sol investigations and review the final research/plan                                                                |
| Existing dirty Symphony work                                            | Pre-existing owner work, preserved                                                                         | Its owner integrates/reviews/tests it separately; this research does not certify it                                                    |
| Application checks                                                      | Previously attempted: `vp check` and `vp run typecheck` exit 127, missing `vp` and dependency binary       | Restore the established pnpm/Vite+ toolchain in an authorised implementation task; do not treat docs validation as an application pass |

## Phase 0: Freeze the baseline and make the decisions executable

Dependencies: none. Owner: main task, Sol investigation/review. Research is complete only when the report and this checklist agree and every requested app has an evidence status.

- [ ] Finalise the critical review and seventeen-app Kanban/delivery matrix, with source hashes, dates, current defects, unrun hypotheses, licence/private-source gaps and primary links.
- [ ] Record the existing dirty-file ownership and exact base revision before any implementation task. Keep the owner's Symphony changes intact; agree an integration baseline rather than resetting them.
- [ ] Reconcile stale README/connection-runtime authentication claims against the current CLI and desktop paths. Choose the intended local transport defaults explicitly before changing them.
- [ ] Freeze supported OS/architecture/release targets and a capability inventory: Code providers, Symphony implementation/review providers, WSL, terminals, embedded preview/automation, headless server and delivery adapters.
- [ ] Resolve the licence objective. If keeping MIT attribution is acceptable, retain inherited code and notices. If zero retained T3-origin implementation is required, select the independent replacement path in Phase 6 and inventory server/contracts/client packages too.
- [ ] Restore the repository's established toolchain only when implementation is authorised, then obtain `vp check` and `vp run typecheck` on that baseline. Record existing failures rather than relaxing checks.

Exit: one agreed baseline, target matrix and rewrite/provenance objective; detailed finite tasks can be assigned without requiring an executor to invent policy.

## Phase 1: Correct evidence, acceptance and containment before expanding autonomy

Dependencies: Phase 0 baseline. Owner: main task/Sol design; Luna 6 Max may execute exact, disjoint plans; Sol reviews substantial implementation.

- [ ] Fix board repository failures, truncation evidence and explicit dispatch acknowledgement/refusal (F01/F02/F04) before treating an empty board as absence or complete inventory. Preserve last-known data and typed unavailability.
- [ ] Resolve current transport-default/documentation mismatch and inherited child-secret exposure (S06/S08). Test desktop, ordinary CLI, strict CLI and WSL separately, including absent/expired tickets and intended reverse-proxy use. Apply capability policy to commands independently of connection authentication.
- [ ] Correct receipt aggregate identity and provider launch/EOF ambiguity (S01/S02/S04), with semantic request identity and durable accepted/launch-unknown/acknowledged outcomes. Never claim exactly-once external execution from a local receipt alone.
- [ ] Scope Symphony notification consumers to one turn and its generation (S04), including success, failure, timeout and cancellation.
- [ ] Make terminal persistence degradation recoverable (S03). Prevent unsafe process signalling (validated T3 process-guard candidate); execute destructive-signal cases only in isolated fixture processes.
- [ ] Validate native SQLite error/busy/read/write semantics and choose transaction/retry behaviour proportionate to the current driver (S10 and the corrected T3 SQLite findings).
- [ ] Rewind intent: separate conversation-only rewind from explicitly requested file rollback, isolate other worktrees' untracked data and preserve stale/missing-checkpoint evidence. Reuse current closure policy; do not infer process death from missing in-memory state.
- [ ] Close selected Claude result ownership/config-directory/auth-truth gaps; assess checkpoint object quarantine, read-only Git locks and file permission/optional metadata against the corrected T3 ledger. Ports are intent-specific, not wholesale diff imports.

Exit: each selected defect has one meaningful regression check and required checks pass; no unknown/failure is converted to success, absence or execution permission. Keep low-impact/source opportunities separate from release-blocking defects.

## Phase 2: Measure and improve the current product

Dependencies: safe baseline; can run beside the desktop feasibility slice. Owner: Sol freezes the workload and evaluates results; exact implementation slices may go to Luna. Do not implement all 49 patterns indiscriminately.

| Finite workload                                                                              | Measurements                                                                               | Likely first seam / completion criterion                                                                          |
| -------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------- |
| Growing Markdown and a growing code fence at fixed delta cadence                             | Main-thread parse/highlight time, commit count, p95 input latency, retained heap           | F05; preserve sanitisation, incomplete fences, Unicode, links/copy and completed output                           |
| High-output terminal, large persisted file, one newline-free multibyte line, hidden sessions | Server read/persist allocation, queued bytes, parser/output latency, renderer/GPU memory   | F06/S06; enforce byte and consumer bounds without corrupting data or parser state                                 |
| 1,001-item board, unchanged board with one/four subscribers and rapid transitions            | SQL/SCM calls, transmitted bytes, card DOM count, p95 transition latency                   | F02/F03; bounded complete/truncated semantics and shared revisioned/change-driven work if measurements justify it |
| Large persisted history, reconnect gap, session switches and idle retained views             | Event/SQL bytes, hydrated data, stream/cache lifetime, input latency                       | Reuse LegendList/structural sharing; bound raw data and replay before adding another virtualiser                  |
| Large command catalogue, multi-file diff, huge single diff, large repository search          | Input/render time, visible rows, worker/cache memory, watcher/index work, search freshness | F08; reuse 2–6 diff workers, native index and existing cache budgets                                              |
| Idle app, Diagnostics opened once/four times, repeated server-config reconnects              | Probe/process count, file read bytes, event-loop lag, whole-tree CPU/RSS                   | F07/F09 and diagnostics/read coalescing; no duplicate scan or timer subsystems                                    |
| Cold/warm packaged startup and agent restart                                                 | Shell/backend/db/listen/UI milestones, whole-process-tree memory, artifact size            | Attribute cost before changing runtime; compare Phase 5 on the same fixture                                       |

- [ ] Freeze fixture sizes, delta cadence, OS/runtime versions, repetition count, machine state and acceptance budgets before collecting results. Record warm/cold separately and use equivalent code/data.
- [ ] Fix S10 typed-only Codex raw-queue retention with an opt-in/bounded raw contract; preserve Symphony's real raw consumer and approvals. Extend existing protocol fixtures before claiming memory improvement.
- [ ] Implement the highest measured contributors first. Reuse settled highlighting, LegendList, structural sharing, native index, existing scoped storage/drafts and notifications.
- [ ] Assess growing-prefix SQL projection versus smaller SQL append before adopting Synara chunk tables. Bound event serialisation, snapshot payload, focused history reads, diagnostics and WAL/retention only where current evidence requires them.
- [ ] Keep a small measurement table here linking raw results and accepted/rejected changes. Reporter benchmarks and framework marketing never become Neokod measurements.

Exit: accepted changes improve their frozen workload and preserve correctness; rejected/no-benefit candidates are closed with evidence. Completion does not require adopting every competitor idea.

## Phase 3: Durable orchestration within chat

Dependencies: Phase 1 acceptance/authority/ownership. This precedes general recursive fleets or extra provider fallbacks.

- [ ] Add a durable queue and manual handoff request with semantic request ID, selected provider/workflow, bounded content and source-chat/message identity. Distinguish queued, admitted, launch-unknown, running, stopped, completed and result-delivered evidence.
- [ ] Route user and agent delegation proposals through a common server-owned admission policy. Persist immutable actor/source/parent/capability/workspace provenance atomically. Inventory raw WS/HTTP/CLI/reactor/startup paths before claiming complete enforcement.
- [ ] Add one bounded parent/child task relation, attributed progress and result link in normal chat. Keep existing Code/Symphony attempts authoritative; cohort completion coalescing and immutable result pins must not create a second run store.
- [ ] Support stop, detach and cancellation as distinct operations. Reserve depth/concurrency/cost/workspace authority before launch; narrow effective provider capabilities rather than a single ordinal runtime-mode rank.
- [ ] Prove restart ordering, result acknowledgement, unknown external launch recovery, cancellation descendants and orphan reconciliation. Durable server delivery must work with the originating chat closed.
- [ ] Retain provider-native subagents as a separately observed/governed capability. Current Kiro supervision restrictions remain intact. Do not imply Symphony multi-provider execution from multiple review providers.
- [ ] Add PR watches, schedules and bounded review rounds after these gates, each with durable intent, authority, cancellation and one recoverable result path.

Exit: from ordinary chat, request a bounded child; receive reviewable, attributed outcome in that chat; stop/restart without an extra writer, duplicate launch claim or lost delivery acknowledgement. No mode switch required.

## Phase 4: Delivery-neutral intake and an honest workstream board

Dependencies: Phase 1 evidence rules and Phase 3 request/result contract. Can start scoped resolver fixtures before chat UI is ready.

- [ ] Add reference resolution in a selected server-owned connection/project. Return native identity, display key, checked scope, state/dependency completeness, revision/freshness and declared read/write capabilities. Never turn failed lookup into a manual duplicate.
- [ ] Close Jira project, GitHub Project membership and Azure TeamProject lookup gaps. Freeze identity to immutable connection scope; decide how configuration changes affect already-persisted work items.
- [ ] Fix candidate pagination/completeness and unsupported/dependency evidence, including GitHub's current fixed 100 result bound, Linear relation truncation, Projects draft/PR exclusions and custom state mappings.
- [ ] Make chat intake, scheduler poll and retry converge on the same work item and exclusive claim. Another chat can subscribe to the existing outcome; it cannot launch another writer silently.
- [ ] Deliver “Send to Symphony” by reference or task URL through the selected configured connection. Link source chat/message → request → canonical task → work item → attempt/worktree → validation/review/PR → acknowledged chat outcome.
- [ ] Retain local lifecycle columns and explicit failure/cancelled outcomes. Add separate external status/freshness/capability badges rather than equating Done with an external resolved status. Preserve native/manual work without requiring a delivery connection.
- [ ] Add drag/drop only for an explicit, supported command. Permission/state/revision checks happen server-side; pending/failure/conflict is visible; acknowledge then reconcile, with keyboard-equivalent controls. A visual move never proves execution or external write-back.
- [ ] Add host-owned tracker comments/status writes only for required adapters, with expected revision where available, retry/correlation and honest unsupported outcomes. GitHub PR capability is not GitHub Projects mutation capability.
- [ ] Run one controlled tracker-to-PR workflow for every adapter advertised as live. Record fixture-only, read-only and live-write capability separately.

| Adapter         | Native identity / principal gate                                                       | Initial state                                                   |
| --------------- | -------------------------------------------------------------------------------------- | --------------------------------------------------------------- |
| Jira            | Numeric issue ID; display key; checked project/JQL scope                               | Registered source adapter; intake/write-back/live proof pending |
| Linear          | Issue UUID; checked project/team; complete relevant dependencies                       | Registered source adapter; intake/write-back/live proof pending |
| GitHub Issues   | Configured host/repository plus issue number; complete candidate enumeration           | Registered source adapter; intake/write-back/live proof pending |
| GitHub Projects | Project item node ID plus checked owning project; supported content/status field       | Registered source adapter; intake/write-back/live proof pending |
| Azure Boards    | Organisation/project plus work-item ID and revision; checked TeamProject/custom states | Registered source adapter; intake/write-back/live proof pending |
| GitLab          | Configured host/project plus IID; supported state/credentials                          | Registered source adapter; intake/write-back/live proof pending |
| Asana           | Project membership plus GID; explicit section/completed/missing-state policy           | Registered source adapter; intake/write-back/live proof pending |

Exit: normal chat plus optional Symphony board works for each advertised capability; cross-scope IDs, poll/dispatch races, rate limits, revocation, unsupported items, retries and result recovery are demonstrated. Future adapters use the same small boundary, without a speculative integration marketplace.

## Phase 5: Tauri 2 feasibility and desktop migration

Dependencies: Phase 0 target/feature matrix; Phase 1 baseline; Phase 2 equivalent workload. Retain Electron until replacement gates pass. A shell migration does not remove inherited server/UI licence provenance.

- [ ] Pin stable Tauri 2 and its plugins, licence/notice set and Rust toolchain. Do not select a Tauri alpha solely because GitHub's latest endpoint returns it.
- [ ] Package the current Node server, server assets, node-pty/native search/native database dependencies and provider runtimes for each advertised target. Avoid assuming one Node SEA or Bun compile solves native modules and extracted resources.
- [ ] Implement the smallest desktop adapter: start/readiness/stop, ephemeral authenticated local topology, window/storage/clipboard/dialog/open/notifications. Reuse the web/client contracts; keep business policy in the server.
- [ ] Prove owned-child shutdown/restart, readiness failures, startup/quit drain, path quoting, shell discovery, persistent data and WSL behaviour. Renderer must not own arbitrary shell spawn authority.
- [ ] Resolve embedded preview first: current Electron guest webview/debugger/Playwright Chromium CDP/screencast semantics need an explicit replacement, not a preload rename. Preserve untrusted-preview privilege separation. Compare a separately owned browser-automation worker if WebKit/WebView2 cannot supply required capability; include its browser cost.
- [ ] Test xterm, Monaco/diffs, worker/assets, CSP/origins, clipboard/IME/accessibility and preview on WKWebView, WebView2 and supported WebKitGTK targets. Browser web mode and standalone `neokod serve` remain supported.
- [ ] Compare signed packaged builds to Electron on the same workload, including server/provider/browser/WebView processes and shared GPU/service costs. Freeze improvement and non-regression budgets before the spike; no automatic faster/smaller claim.
- [ ] Prove signed update/install/rollback and database/schema compatibility on native target hosts. Include macOS notarisation, Windows signing/runtime requirements and Linux dependencies. Electrobun is a bounded fallback if Tauri fails a decisive feature gate, with its own architecture/update/signing limits.

Exit: feature parity, lifecycle/security/data gates and a measured worthwhile gain all pass on advertised targets. Otherwise retain Electron and close the spike with the demonstrated blocker. Choose a shell from evidence, not the framework's empty-app bundle size.

## Phase 6: Conditional independent core or complete rewrite

Start only if Phase 0 chooses removal of retained T3 implementation, or a bounded prototype proves materially simpler and safer shared lifecycle than evolving the existing engine. Passing a Tauri slice does not trigger this automatically.

- [ ] Define the provenance boundary file by file. Record T3-origin components, Neokod-only components, third-party licences/notices/assets/protocols and dependencies. Retained derived code keeps its notices; a Rust language change or new repository is insufficient evidence of independence.
- [ ] Write a behaviour specification independent of upstream implementation: commands/events, accepted/launch/result evidence, attempts/workspace claims, provider capabilities, policy, delivery references, history/import and recovery.
- [ ] Build a narrow independent workbench prototype: Codex plus Claude start/resume, history, approvals, stop, queue, worktree and diff against copied fixtures. Keep the existing server deployment contract or provide an independently implemented compatible server, according to the chosen provenance scope.
- [ ] Compare that prototype against the same Phase 1/2/3 acceptance gates. Use maintainability evidence such as reduced authoritative state/duplicated policy and narrower ownership, not source line counts alone.
- [ ] Rehearse read/import on copies of database/WAL/attachments/workspaces, keep untouched originals and retain legacy access. Preserve IDs/order/closure/tool/approval evidence; quarantine unsupported history with visible reasons. Never open production history with an experimental importer.
- [ ] Reach the published provider/platform/tracker capability matrix before cutover; document any intentionally withdrawn capability explicitly. Prove the complete Phase 4 tracker-to-PR workflow on the replacement.
- [ ] Produce provenance/notice review, migration and rollback instructions, signed native packages, canary results and final independent Sol review. Licence/provenance certainty requiring legal judgment remains a separate decision; no tool can certify it merely from a clean build.

Exit: a justified replacement, recoverable migration and the selected provenance goal are evidenced. If the prototype offers no clear benefit and independent provenance is not required, close this path and continue the evolved engine.

## Phase 7: Release and completion

- [ ] Integrate only task-owned paths; independent Sol review and relevant focused checks pass, including repository-required `vp check` and `vp run typecheck`.
- [ ] Use existing canonical version/changelog conventions for implemented changes. Documentation research alone requires no fabricated application version.
- [ ] Rebuild affected desktop/server artifacts or Docker images only when those are the delivery path; validate Compose if changed. Record build, native execution, live integration, PR, merge and deployment separately.
- [ ] Produce a normal ready-for-review PR only when publishing is authorised; no direct main push. Native smoke, signed-update/rollback, server web mode and controlled advertised delivery flows pass before release readiness.
- [ ] Close every selected implementation item with passed evidence, explicit unsupported/deferred scope or a decision rejecting it. Update this checklist and architecture docs, retire superseded duplicate status and leave a concise operational handoff.

The current request authorises this review and the documentation roadmap. These checkboxes describe future implementation and release work; they are not claims that code was changed, a Tauri app ran, external status was written or a release was deployed.
