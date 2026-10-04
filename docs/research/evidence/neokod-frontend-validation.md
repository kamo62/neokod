# Independent validation of frontend findings F01–F09

4 October 2026. Bounded review of `/Users/kamogelo/Code/t3code/docs/research/neokod-frontend-critical-review-2026-10-04.md` against the referenced current local implementations and their matching callers. No application changes, runtime, tests, installs or desktop/licence re-review. The findings are largely supported at their stated source-only proof class. F04 needs a material correction, and F03, F06 and F07 need tighter acceptance wording.

## Concrete corrections for integration

1. F04: shared command failure reporting is console-only on this path, not user-visible. `useAtomCommand` is at `apps/web/src/state/use-atom-command.ts`, not `hooks/use-atom-command.ts`. The BoardTab ignores the settled result. `runAtomCommand` defaults its reporter to `console`; `reportAtomCommandResult` uses warn/error and suppresses interruption. No toast or board error state is provided by that machinery. The settings and project start/pause paths explicitly convert Failure into visible local error text; dispatch does not.
2. F04's proposed claim/pause/permission gate cannot be satisfied solely by checking AtomCommandResult. Several server dispatch refusals and errors are converted to normal void completion, and `ws.ts` maps that completion to `{ ok: true }`. A current global/workflow/repository pause is one concrete no-op case. The client needs a meaningful accepted/refused dispatch result if it is to display those reasons; a client-only branch catches RPC/transport Failures but does not reconstruct swallowed refusal reasons.
3. F03: `ProjectBoard.ts` carries the supplied generatedAt; the orchestrator obtains a new `nowIso` on each query. Describe repeat as each active server subscription rerunning the effect on the fixed two-second schedule after completion. It is not every React consumer: the keyed client Atom family shares the same atom within a registry. There is no semantic deduplication in the shown server/client board path. Do not claim one Git subprocess per board tick; the repository-path cache has a five-second TTL, although it does not show single-flight protection for concurrent cache misses.
4. F07: hidden terminal drawers are intentionally retained under a cap of ten hidden threads. Their full-thread subscription is a performance opportunity, not an unbounded drawer count or proven memory leak. WorkingTimer is in a separate virtualised timeline row; the inspected caller does not establish that a timer remains mounted in a hidden thread. Its one-second DOM update is confirmed. Keep off-screen timer work conditional on a measured mounted case.
5. F06: a byte bound needs to cover live accumulation, persistence and bounded restoration, not only cap a whole string after loading it. UTF-8-safe slicing alone does not guarantee valid terminal control-sequence replay or preservation of prior terminal state. The streaming sanitiser also carries an incomplete control sequence separately; include finite unterminated-control fixtures in the gate.

## Per-finding assessment

### F01: confirmed absence/unavailability conflation; qualify the visible surface

[SymphonyOrchestratorLive.ts](/Users/kamogelo/Code/t3code/apps/server/src/symphony/Orchestrator/Layers/SymphonyOrchestratorLive.ts:1210) catches project repository failure as null and item-list failure as `[]`. [ws.ts](/Users/kamogelo/Code/t3code/apps/server/src/ws.ts:504) turns null into `symphony_project_not_found`. On an initial project-read failure, the client presents a “Project unavailable” surface whose description is the misleading not-found error; it does not label the surface “Project not found”. A work-item-read failure with a valid project produces normal empty columns, with a fresh generatedAt.

[useEnvironmentQuery](/Users/kamogelo/Code/t3code/apps/web/src/state/query.ts:24) derives data from AsyncResult.value and exposes the error separately. [SymphonyProjectView.tsx](/Users/kamogelo/Code/t3code/apps/web/src/components/symphony/SymphonyProjectView.tsx:290) renders boardQuery.error only in the null-board branch. Preserving an old board by itself therefore does not prove freshness/failure visibility while data remains available.

Gate: cover failed project read, failed work-item read, authoritative missing project and authoritative empty item list separately. Exercise first load and a previously successful populated board. Unavailability must remain distinguishable from absence, with visible stale/error evidence when retained data is displayed. The current “one failed repository-read fixture” is underspecified because two catches have different results.

### F02: confirmed 1,000-row completeness gap; qualify counts and ordering

The board query requests all lifecycles with `limit: 1_000`. [WorkItemRepository.ts](/Users/kamogelo/Code/t3code/apps/server/src/symphony/Persistence/Layers/WorkItemRepository.ts:435) orders the entire lifecycle set by effective priority then created_at and applies the SQL LIMIT. It does not prioritise active over completed work. The board projects only returned rows; [contract](/Users/kamogelo/Code/t3code/packages/contracts/src/symphony.ts:980) has project, sourceControl, columns and generatedAt, with no total, cursor or completeness flag. UI badges are `column.cards.length`, so they are counts of the returned slice, not established full-project totals.

Gate: use 1,001 items with an active item beyond the existing ordering cutoff, and terminal items ahead of it. Assert explicit complete/truncated/unknown-total semantics and a bounded way to discover the omitted active item. Any paging design needs a deterministic ID tie-breaker or equivalent stable cursor; current created_at ties alone do not establish repeatable pagination. A signal alone does not make active work discoverable. Do not require a known exact total unless the implementation actually obtains one.

### F03: confirmed repeated query/projection path; savings remain unmeasured

[ws.ts](/Users/kamogelo/Code/t3code/apps/server/src/ws.ts:504) wraps the effect in `Stream.repeat(Schedule.fixed("2 seconds"))`. Successful iterations fetch the project and up to 1,000 items, project/sort cards, obtain nowIso and emit a full board. [ProjectBoard.ts](/Users/kamogelo/Code/t3code/apps/server/src/symphony/Orchestrator/ProjectBoard.ts:91) returns the supplied generatedAt. [client state](/Users/kamogelo/Code/t3code/packages/client-runtime/src/state/symphony.ts:61) maps every event to the board without semantic comparison. This supports recurring work, not measured React commit counts, SQL latency, bytes or CPU.

[subscription construction](/Users/kamogelo/Code/t3code/packages/client-runtime/src/state/runtime.ts:504) is keyed by environment and input and has a five-minute default idle TTL. Count active wire subscriptions and registries rather than assuming each component creates a separate poll. The source-control cache avoids a Git probe on every unchanged tick; concurrent misses can still independently probe because cache publication follows the awaited read.

Gate: compare one and four genuinely separate active clients/registries with a frozen 1,000-card project. Record SQL rows/calls, full and incremental payload bytes, projection CPU and React commits. If change-driven work is implemented, require a bounded idle heartbeat and no repeated card-sized projection/payload on semantically unchanged revisions, while proving lifecycle changes, source-control changes, reconnect catch-up and error recovery. “No work proportional to unchanged cards per client” should be conditional on adopting that optimisation and must not be presented as an already measured requirement failure. Repeat is not by itself a guarantee that a failed stream retries forever.

### F04: confirmed UI failure gap, with an additional server result limitation

[BoardTab](/Users/kamogelo/Code/t3code/apps/web/src/components/symphony/SymphonyProjectView.tsx:86) sets a busy ID, awaits dispatch, always refreshes on settled completion and clears busy state in finally. It does not inspect `_tag`. [shared runtime](/Users/kamogelo/Code/t3code/packages/client-runtime/src/state/runtime.ts:245) returns the settled result; [reporter](/Users/kamogelo/Code/t3code/packages/client-runtime/src/state/runtime.ts:363) logs non-interruption failures/defects. “Reported by shared machinery” must say “logged to the console”. Settings save and project start/pause are existing models for visible local error handling.

[prepareDispatch](/Users/kamogelo/Code/t3code/apps/server/src/symphony/Orchestrator/Layers/SymphonyOrchestratorLive.ts:1350) returns null for follower authority, missing/ineligible/active items, pauses, workflow/config/autonomy exclusions and capacity/refreshed-issue conditions. [executePreparedDispatch](/Users/kamogelo/Code/t3code/apps/server/src/symphony/Orchestrator/Layers/SymphonyOrchestratorLive.ts:1456) logs a dispatcher Failure and returns normally. [dispatchWorkItem](/Users/kamogelo/Code/t3code/apps/server/src/symphony/Orchestrator/Layers/SymphonyOrchestratorLive.ts:1526) converts null into void; [RPC](/Users/kamogelo/Code/t3code/apps/server/src/ws.ts:1048) maps normal completion to `{ ok: true }`. Those refusals are not presently AtomCommandResult Failure. No rejected-work launch or unauthorised execution is established by this finding.

Gate: first inject an actual command Failure/defect/interruption to prove board-local reporting and deliberate retry. Separately exercise a real paused/no-capacity/no-claim dispatch and expose a supported refusal/no-op reason through the server result before expecting the UI to display it. Successful RPC completion must not be labelled proof that a run started. One active busy ID disables all Run now buttons, so any retry state should be card-associated without inventing concurrent dispatch behaviour.

### F05: confirmed processing path; performance opportunity only

[ChatMarkdown.tsx](/Users/kamogelo/Code/t3code/apps/web/src/components/ChatMarkdown.tsx:640) skips the settled highlight cache during streaming. A changed code dependency invokes full `codeToHtml` inside useMemo; the component passes the full text to ReactMarkdown with the existing GFM, raw HTML and sanitisation pipeline. Settled cache bounds remain intact. Source shows recurring full-input operations, not timing, quadratic wall-clock cost or visible input lag.

Gate remains appropriate: freeze total text/fence sizes, chunk sizes/cadence, languages and theme, then compare identical delta traces with main-thread time and input latency. Check final and partial content, sanitisation, links/copy, Unicode and incomplete fences. Incremental parsing is one possible design, not necessary before simpler streaming deferral is measured.

### F06: confirmed line bound without byte bound, including the live caller

[capHistory](/Users/kamogelo/Code/t3code/apps/server/src/terminal/Manager.ts:855) splits the entire string and retains up to 5,000 newline-delimited lines by default. A newline-free string remains unchanged regardless of length. [live output](/Users/kamogelo/Code/t3code/apps/server/src/terminal/Manager.ts:1651) concatenates the retained history and visible text before invoking the cap. [persist worker](/Users/kamogelo/Code/t3code/apps/server/src/terminal/Manager.ts:1352) writes the supplied history string; coalescing bounds pending requests, not bytes in a history. New and legacy restore paths read a complete file before applying the line cap. The 128 retained inactive-session count is a separate bound; active sessions are another population.

The sanitiser retains unfinished escape/CSI/OSC/DCS sequences in pendingHistoryControlSequence. Its inspected paths return an input suffix without a length limit. A huge unterminated sequence can therefore accumulate separately from visible history; a visible-history-only budget does not cover every retained string on this path.

Gate: freeze a byte budget and truncation/replay semantics, then use newline-free, multibyte, split-codepoint and unterminated-control sequences; restore large existing files with bounded reads; measure live retention, pending control state, persistence and renderer separately. Make truncation visible where needed. A safe UTF-8 boundary does not restore earlier colour/cursor/mode state, and a tail cut must not start inside a retained control sequence. Do not claim current measured memory growth, renderer overflow or data loss.

### F07: confirmed retained subscription/timer mechanisms; hidden timer claim unproved

The hidden drawer calls [`useThread(threadRef)`](/Users/kamogelo/Code/t3code/apps/web/src/state/entities.ts:139), which subscribes to both shell and detail atoms and memoises their merged thread, and remains mounted when its project/open/cwd requirements hold; visibility changes the containing div class. Parent retention is deliberately bounded by [MAX_HIDDEN_MOUNTED_TERMINAL_THREADS = 10](/Users/kamogelo/Code/t3code/apps/web/src/components/ChatView.logic.ts:27) and reconciliation. Memo does not independently stop store updates. Source supports measuring whether a narrower terminal-launch summary avoids history-driven work; it does not establish duplication of each whole history or an unlimited drawer leak.

[WorkingTimer](/Users/kamogelo/Code/t3code/apps/web/src/components/chat/MessagesTimeline.tsx:1093) uses a one-second interval to update a text node and cleans up on unmount. Its caller is a working row in the virtualised timeline, not the hidden terminal drawer. No caller evidence here proves hidden-thread ticking. Keep this as a separate mounted/off-screen measurement opportunity.

Gate: measure the bounded retained drawer set while another thread streams, then prove focus, selection, output and resume still work after narrowing subscriptions. Profile timers only in states where the timeline row remains mounted but presentation is hidden. Require cleanup for demonstrated inactive presentation, not zero timers in every non-selected thread without checking mounting.

### F08: supported local-windowing opportunity; no dependency defect proved

CommandPaletteResults maps groups and uses Base UI collections; command wrappers contain no explicit viewport windowing. This is accurately qualified. Dependency internals and actual rendered rows are not established here, and large input does not by itself prove unacceptable latency.

Gate remains appropriate with fixed projects/threads, result/query distributions and keyboard/ARIA checks. Count rendered rows and input/open/navigation costs first. Add windowing or limits only after finding a material local bottleneck, preserving full search/discovery semantics and disabled-item behaviour.

### F09: supported per-operation construction; keep low priority

Decode/encode construct fromJsonString and synchronous encoder/decoder functions per operation. The hook's decoded snapshot is already memoised by the serialized value and schema; do not imply rebuilding on every unchanged React render. No allocation profile attributes material cost to this path.

Gate remains appropriate: repeated bounded get/set operations, stable and changed schema identities, malformed data, storage exceptions and legacy keys. Preserve typed failures and hook logging/fallback behaviour. A local stable codec may be enough if measurable; a new global schema cache is not justified.

## Stopping and evidence

All nine requested findings were accounted for. F01, F02, F04 and F06 have supported source correctness/resource gaps with the corrections above. F03, F05 and F07–F09 remain measured-opportunity candidates, not demonstrated runtime regressions. The inspection ran only source reads/searches. No application tests or runtime checks were performed or claimed. Stop this review after integrating the qualifications; no second general audit is needed.
