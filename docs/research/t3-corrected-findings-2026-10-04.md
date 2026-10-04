# Corrected finding narratives for integration

This appendix supplies replacement wording for all 60 qualified PR findings and seven qualified non-PR findings. It does not repeat original claims or add a new audit. Each paragraph describes source or frozen-record evidence and a finite remaining gate. No local runtime success, incident, benchmark or production maturity is established. Upstream UI and removed cloud, remote, mobile and authentication infrastructure remain excluded. Open proposals remain design references. Exact source anchors and original claim variants are retained in `per-finding-validation.json`; this appendix supplies the corrected narrative only.

## #4759: fix(orchestrator): Close OpenCode tool items when a turn ends under them

Server-owned runtime-item closure and startup reconciliation cover the stale active turn-scoped-item class. Provider-native detached/external work has different truthful closure semantics. Substantial shared coverage is source-confirmed; not proof that every upstream OpenCode adapter edge, child drain or detached descendant is already resolved.

Remaining gate: If a current OpenCode interrupted-item fixture remains, verify turn versus detached scope and authoritative terminal/orphan mapping.

## #5388: fix(orchestration): Preserve Claude subagent attribution after settle

Local Claude stores tasks by `task_id` and one `turnState`, not the V2 persistent tool/native-task alias/buffer contract described by the proposal. Nested token `message_delta` is excluded, but absent turn lineage is documented. Potential missing edge, not proof that current local child text leaks or all task attribution is absent.

Remaining gate: Current SDK trace after root settlement/child continuation; isolate exact attribution gap before porting the large stacked proposal.

## #6567: feat(server): let sibling threads exchange messages

Closed-unmerged sibling messaging proposal has no body. Files identify a new MCP/command surface. Local MCP registers preview tooling only.

Remaining gate: Read final command diff and design sender authority, lineage, cancellation and recipient-turn semantics; reference only.

## #7232: fix(server): a provider probe timeout no longer marks the provider broken

Codex/Claude/Cursor/Grok version/core probes can replace usable snapshots with error on timeout. Manager stores each new probe result and registry persists it. Not every model-discovery timeout currently marks provider broken. Separate core probe errors from fallback model discovery and Claude capabilities timeout, which already returns warning/unknown.

Remaining gate: Timeout-versus-definite-failure typed evidence, first probe and last-good stale fields, enrichment generation/cache persistence and child cleanup for each provider.

## #7691: fix(server): report Claude authentication accurately

Local source contains no active claude auth status command path despite a comment describing a fallback. It overlaps the completed-capability evidence issue.

Remaining gate: Compare CLI auth status and initialization evidence on first-party, API-key, third-party and profile configurations; do not install two conflicting truth sources.

## #8492: feat(handoff): let an agent hand its thread off to a fresh one

Closed-unmerged handoff design seeds a fresh thread from agent-authored recap through Claude plugin/CLI/HTTP. Model/permission carry-over is not a local governance contract.

Remaining gate: Design explicit in-chat intent, workspace ownership, narrowing, seed-failure cleanup and resume identity; no transport/plugin transplant.

## #9000: perf(server): bound snapshot activity payload memory

Detail query selects and decodes every activity payload. Snapshot delegates to that query before returning sequence-consistent state. The memory-risk motivation matches. Upstream PR body explicitly keeps raw `getThreadDetailById` unchanged. Do not propose blanket raw-detail truncation as a #9000 port; optimisation belongs at the client snapshot projection boundary. Upstream synthetic memory figures are not local measurements.

Remaining gate: Trace exact client payload projection and recent/pinned selection; batch bounded payload materialisation without changing domain/raw callers or cursor consistency.

## #9662: perf(server): stop loading message bodies for thread summaries

Shell summary loads six full repositories, scans user messages and approval/runtime items. Latest timestamp/pending-approval SQL reads can remove part of this cost. Only timestamp/approval-count portion matches #9662. It does not remove all shell-summary scans.

Remaining gate: Preserve runtime-item precedence and pending-approval fallback; verify empty/order/thread isolation and other plan/activity/runtime summary semantics.

## #9671: perf(server): batch projector cursor writes

Each of ten local projectors updates its cursor via one upsert. Batching can reduce statement count, but bootstrap needs independent durable cursors. Upstream body describes nine projectors; local code has ten including runtimeItems. Do not copy counts or transaction assumptions.

Remaining gate: Verify outer transaction/rollback and standalone projector bootstrap; preserve per-projector cursor identity. Count queries on local fixture.

## #9726: perf(server): replay only the selected thread

Thread replay reads global sequenced events then filters. It already bounds gap and falls back to a fresh snapshot. This is a bounded optimisation opportunity, not an unbounded local replay correctness defect.

Remaining gate: Measure below-cap unrelated decoding; preserve captured global head, deletion/recreation, sequence catch-up and live-first subscription.

## #9758: perf(server): skip history reads for metadata commands

Metadata handlers use `resolveThread`, which loads complete histories. Approval response, interrupt and session stop handlers need focused shell-query comparison.

Remaining gate: Check each call site for body/title/checkpoint needs and use smallest existing reactor checks; do not globally swap detail for shell.

## #11773: fix(server): keep worktree creation working when git config is locked

Worktree add succeeds before optional gh-merge-base configuration, whose failure propagates. A usable worktree can be left behind an API error. The base-ref fallback is at lines 1184–1235 of the inspected Git implementation; lines 1284–1302 concern unrelated unborn-branch handling.

Remaining gate: Config-lock fixture yields usable worktree/fallback while checkout/cancellation errors remain fatal.

## #11853: feat(server): spike orchestration code mode

Closed native QuickJS draft is a new evaluator/runtime/package/journal spike. Existing in-chat requirement does not demonstrate a need for that layer.

Remaining gate: Reconsider only against a concrete bounded-tool acceptance gap; orchestration tool invocation can stay inside ordinary chat.

## #12306: fix(server): reject file rewind in shared workspaces

Revert resolves live session cwd and calls `restoreCheckpoint` with no isolation or sibling/root ownership proof. Restore executes `git restore` and `git clean -fd`. This is a source-established destructive path in shared workspaces. Current local command has no `restoreFiles` selector and always restores before provider rollback. Conversation-only rewind is an upstream requirement/product addition, not current local behaviour to preserve. No local data-loss incident reproduced.

Remaining gate: Real-Git root/shared/archived/live-session/canonical-path rejection before filesystem mutation; isolated success; determine whether to add a conversation-only contract.

## #12307: fix(server): capture checkpoints when baseline lookup fails

Optional baseline existence lookup is awaited unhandled before capturing the new checkpoint. A typed lookup failure can skip capture. Source match is stronger than mere adjacent-reference status; no local fault test run.

Remaining gate: Fault only baseline lookup; new checkpoint capture succeeds while unavailable baseline produces honest empty summaries. Preserve interruption/capture failures.

## #12308: fix(server): refresh file search outside checkpoint processing

Workspace entry refresh is awaited in the checkpoint worker after capture and after restore. Blocking refresh is a source-established worker dependency; actual local scan cost not measured.

Remaining gate: Deferred-controlled refresh regression across repositories; coalescing/drain/shutdown contract if separate worker adopted.

## #12345: fix(server): keep tool payloads out of completion queues

Upstream completion subscription filtering concerns V2 terminal-run worker. Local unbounded PubSub and serialised command queue can retain events with slow consumers but are a different runtime. Not equivalent to EventSink publish ordering #15048; no local slow-subscriber OOM measured.

Remaining gate: Measure retained payloads of actual local subscriber queues before changing filters; preserve ordered independent consumers.

## #12352: feat(server): preserve budgeted history across provider handoffs

Budgeted provider handoff references V2 context accounting/adapters. Local live continuation rejects cross-driver switching and has no same history-injection contract.

Remaining gate: Specify manual briefing provenance/omissions/ownership and failed-start recovery before automating cross-provider context transfer.

## #12600: perf(shared): scan PATH once per command before spawning, not on every spawn

Windows resolveSpawnCommand invokes injected executable resolution every time without local cache. Existing command availability cache is a separate call path. No Windows timing or runtime validation. A future change should add or reuse a suitable resolution cache after checking its ownership and invalidation contract.

Remaining gate: Positive TTL/env/PATHEXT/resolver identity isolation; explicit paths and misses not stale; profile before priority upgrade.

## #12602: perf(server): answer cheap git metadata from repository files instead of spawning git

Repeated Git metadata subprocesses exist, some behind repository identity cache; the broad 2,474-line metadata parser expands compatibility surface.

Remaining gate: Profile exact hot commands first; inspect Git worktree/symlink/config/version compatibility and fallbacks before any reader adoption.

## #12763: fix(contracts): old message-sent events without turnId no longer stop the server from starting

Persisted message-sent payload requires nullable `turnId` and event store schema-decodes history. Source compatibility risk, not demonstrated local historical corruption.

Remaining gate: Real supported old Neokod fixture missing field; deterministic replay without fabricated turn identity.

## #13295: fix(server): stop a second server from resending Claude turns

Failure reconciliation reloads all events since dispatchStartSequence and republishes them, rather than only current-dispatch additions. One command worker per engine is not cross-process admission. Shared-store deployment or duplicate provider turn has not been demonstrated.

Remaining gate: Two engine/store instances; project all persisted repair events but publish own appended events only; preserve local append/projection-failure repair.

## #13684: fix(server): the SQLite WAL file shrinks back after large writes

Local WAL setup omits `journal_size_limit`. This limits retained reset WAL, not active WAL growth held by readers.

Remaining gate: Real clients reset/checkpoint/long reader behaviour; no hard cap or local gigabyte incident assertion.

## #13748: fix(server): bump node-pty to 1.2.0-beta.15 for linux-arm64 prebuild

Local node-pty remains at `^1.1.0`. New 1.2 beta Linux prebuild support and Windows readiness/early-exit changes are a dependency/packaging bundle.

Remaining gate: Native packaged terminal checks on affected Linux arm64/Windows hosts after deliberate upgrade; version 1.1 alone proves no 1.2 readiness regression.

## #13927: fix(server): restore Windows terminal startup after node-pty upgrade

Local node-pty remains at `^1.1.0`. New 1.2 beta Linux prebuild support and Windows readiness/early-exit changes are a dependency/packaging bundle.

Remaining gate: Native packaged terminal checks on affected Linux arm64/Windows hosts after deliberate upgrade; version 1.1 alone proves no 1.2 readiness regression.

## #14457: fix(server): make SQLite checkpoints durable on macOS

Shared SQLite setup does not apply `checkpoint_fullfsync`. A macOS-specific checkpoint sync policy is a candidate, not measured durability proof.

Remaining gate: Node/Bun pragma support, checkpoint cost and explicit platform policy; querying pragma does not prove power-loss correctness.

## #14615: fix(server): Claude steers no longer fail when only next-turn options differ

V2 next-turn steering state is not local classic Claude live sendTurn state.

Remaining gate: Keep queued-selection/steering semantics as scenarios; establish local state match before implementation.

## #14665: fix(server): a subagent's events are no longer stored twice across runs

V2 multiple-run event ingestion ownership differs from local classic ingestion. Original branch merge is not main/release inclusion proof.

Remaining gate: Use #13295 current local repaired-event path; prove relevant run ownership before V2 classes.

## #14718: fix(server): status polling no longer locks the git index

Local status and numstat run without optional-lock suppression. Existing status polling may refresh/write index. Upstream switches read polling to optional-lock-disabled plumbing. Upstream diff sets `GIT_OPTIONAL_LOCKS` in generic `executeGit`; do not copy blanket helper scope without local caller review. No local lock collision reproduced.

Remaining gate: Real-Git concurrent writer and equivalent staged/unstaged/rename/unborn counts; constrain environment change to intended read paths.

## #14725: fix(server): steers keep the newest next-turn selection

V2 next-turn steering state is not local classic Claude live sendTurn state.

Remaining gate: Keep queued-selection/steering semantics as scenarios; establish local state match before implementation.

## #14896: fix(server): a Claude command you stop shows as interrupted

Upstream interrupted command terminal status is a provider contract consistency improvement. Local central runtime-item closure has separate stopped/failed mapping.

Remaining gate: Current Claude native interrupted tool trace; preserve provider-confirmed terminal precedence before mapping statuses.

## #14897: fix(client-runtime): reconnects back off with jitter and keep healthy sockets

Supervisor retries are fixed 1/2/4/8/16 s with no jitter. Wake already probes session. Adapt jitter/cap locally if desired. Five-minute upstream cap is a product tradeoff; no local fleet-synchronisation measurement.

Remaining gate: Deterministic random/clock bounds, healthy wake/offline/retry/generation/reset; one retry owner.

## #14994: fix(server): Claude subagents show the model their agent file picks

Native child model metadata uses V2 ingestor/projection resolution absent locally. Local Claude emits task started with no model.

Remaining gate: Provider task trace/capability mapping before dedicated backend metadata change; exclude all upstream UI.

## #15004: fix(orchestration): deliver results from subagent follow-ups

Open delegated-result follow-up proposal depends on V2 task delivery generations/authorised parent linkage.

Remaining gate: Read eventual final semantics with #15115; no classic native panel patch or cancellation of unrelated later turns.

## #15021: fix(server): Claude V2 turns start on Windows with the default binary path

Adapter passes configured Claude executable to SDK while direct status probe uses other spawn resolution. npm shim compatibility is a separate SDK launch question.

Remaining gate: Native Windows bare shim/explicit executable repro and unchanged macOS; no installed SDK runtime evidence.

## #15029: fix(server): working timers no longer reset on every background wake

Wake/timer fixes depend on V2 runs/provider control messages. Local classic lifecycle differs.

Remaining gate: Use local authoritative lifecycle/timestamp projection if equivalent wake gap is measured; no status-name translation.

## #15033: perf: cheaper shell refreshes, one copy of Codex streaming text, no MCP wait polling

Mixed open V2 backend/UI proposal is not a local patch bundle.

Remaining gate: Identify concrete eligible backend behaviour and local seam first; UI always excluded.

## #15048: fix(server): runs no longer get stuck

V2 outbox ordering/failed-state-read/cleanup/event publishing fix is real backend hardening. Local command processing already serialises publication, but effect recovery invariants remain useful. Initial .2623 exclusion was historically correct; new .2644 ancestry includes it. No local runtime stuck-run claim.

Remaining gate: Identify actual rollback retry/cleanup/fault-read local seam; preserve errors as evidence, no second redundant publish lock.

## #15055: fix(server): threads stay working while Claude starts a wake turn

Wake/timer fixes depend on V2 runs/provider control messages. Local classic lifecycle differs.

Remaining gate: Use local authoritative lifecycle/timestamp projection if equivalent wake gap is measured; no status-name translation.

## #15057: feat(server): agents can watch a PR and get woken when checks, reviews, or conflicts need them

V2 server PR watch owns cursor/poll/wake; corresponding local watcher tool/background service is absent.

Remaining gate: Build after durable wake policy; atomic observation/wake, duplicate/stop/restart/failure cases; no merge authority from wake; upstream UI excluded.

## #15115: fix(server): keep delegated review rounds on the task API

Shipped MCP instructions require new retry-stable task per review round. Cancellation of terminal task preserves later independent child run/result.

Remaining gate: New local delegation design must pin accepted task result/cancellation scope; ordinary messaging is not automatic task ownership.

## #15149: perf(usage): cut warm usage scans from seconds to milliseconds on large histories

Upstream transcript usage aggregation benchmark refers to its own cached dataset/implementation. Matching local aggregator is not demonstrated.

Remaining gate: Establish a matching local caller and data baseline before using the upstream timing or 800,000-record benchmark to prioritise work.

## #15150: fix(server): free worktrees for terminal thread statuses

Open worktree cleanup proposal uses foreign lifecycle states. Current local chat/Symphony ownership requires explicit own retention model.

Remaining gate: Keep worktrees with pending queues/live requests/background/ownership/uncommitted files; validate Git identity before retention/deletion decisions.

## #15224: fix(server): Claude threads no longer stay stuck in plan mode Claude entered itself

Local explicit plan/default mode calls `setPermissionMode` before `sendTurn`. Omitted interaction mode leaves current SDK mode unchanged. Not blanket already-covered claim; explicit path only is source-confirmed.

Remaining gate: Self-entered plan mode followed by omitted/default explicit next prompt; trace callers before deciding need.

## #15297: fix(server): a large untracked file no longer fills the disk with checkpoint packs

A size cap changes what checkpoint history contains. Existing local add captures all eligible files. Quarantine is the more direct failure-cleanup candidate while preserving contents. Its diff was observed after the declared closed-inventory cutoff; date the later observation rather than retroactively assert an as-of-cutoff proposal.

Remaining gate: Explicit checkpoint-content decision before size limits; large-file capture/restore preservation and failure cleanup.

## #15323: fix(server): restarts keep delegated tasks, queued threads, and stops intact

Shipped restart hardening has explicit held queues/stop intent/delegated continuation/background ownership semantics. Current local event/receipt transactions are a foundation but lack same V2 run tree. 85 + 44 + 43 tests, one Codex SIGTERM flow and single-cell in-memory benchmark are author-reported, not independently run or disk/fsync proof.

Remaining gate: Translate invariants to local source seams, test interrupted child delivery/parent continuation and queue order/stop/restart. Future child mechanics need implementation first.

## #15324: refactor(server): check RPC scopes in group middleware

Upstream authenticated operate middleware gates raw WS commands. MCP `resolveRuntimeMode`/`resolveInteractionMode` restrict child ceiling; raw delegated command validates parent run/node and materialises client modes with no same visible comparison. Mismatch is between authenticated admission surfaces. It does not prove unauthenticated access, managed-child credential possession, or exploit.

Remaining gate: Common accepted-command agent authority model; establish credential availability before any exploit assertion. Scope ordinary trusted-human operation separately.

## #15326: feat: retry a failed workspace preparation

`prepared-run.retry` persists state transition and launch service retries recorded workspace strategy. Local has no V2 `ThreadLaunchService`.

Remaining gate: Idempotent workspace retry against actual local preparation/ownership records; no V2 contract transplant.

## #15355: fix(server): Stop ends a dev server left running before a provider switch

V2 Stop reaches multiple provider threads retaining background work after switch. Local rejects live cross-driver continuation; same multi-provider ownership state not proven.

Remaining gate: Preserve background ownership invariant for future switching; establish equivalent local state first.

## #15361: fix(server): Codex shadow homes share the sqlite maintenance lock

Codex overlay shared-entry rules do not treat sqlite-maintenance lock as a replaceable empty file. Open proposal adds version-specific handling. No actual Codex 0.160 execution evidence; generator pin alone does not establish installed supported runtime version.

Remaining gate: Affected Codex version support and overlay repro; only empty regular lock replacement; retain nonempty/directory/unrelated entries.

## #15374: fix(acp): request ids stay within signed 32-bit so Kotlin agents answer

Both outgoing ACP typed-ID counters start at 2³² and RPC serialisation converts string IDs to numbers. Signed-32-bit peers can reject these valid JSON-RPC numbers. Signed-int32 is a peer compatibility restriction, not JSON-RPC universal ID rule. Lowering starting counter does not itself bound arbitrarily long lifetime IDs.

Remaining gate: Both-direction wire IDs/new initial range, extension separation and bidirectional ID reuse routing; current affected peer repro if claiming actual provider outage.

## #15388: fix(server): merged threads settle even after the agent wakes on its own

Upstream settle-on-merge distinguishes actual human messages from agent notifications. Local does not have same V2 auto-settlement reactor.

Remaining gate: If local watchers/auto-settlement added, use server-derived actor provenance; no blind `role:user` heuristic.

## #15389: fix(codex): resume archived native sessions

Local Codex has native resume and generated unarchive RPC; no archived-resume retry behaviour was found. Shipped V2 handles a specific native archived error.

Remaining gate: Current app-server archived-error fixture and same-ID unarchive/resume, unrelated error propagation; do not assume native continuity from generated method presence.

## #15400: fix(server): failed checkpoints no longer leave temporary packs in the repository

Private checkpoint index does not isolate object writes. Local git add writes shared repository objects; cleanup removes only the index. Quarantine and ordered publication match the cause. The source matches susceptibility, not observed local tmp_pack accumulation. Full rollback of already published objects is not guaranteed: visible pack/index objects may be shared and must not be deleted blindly.

Remaining gate: Interrupt/timeout/ENOSPC during capture; user index/ref preserved; concurrent capture/shared permissions and pack-before-index publication; subsequent capture/fsck.

## #15442: fix(orchestration-v2): recover runs after disk space stalls

Ingestion catches non-interrupt processing errors, logs and returns to drain worker. Failed input is not visibly retried. Storage-full can lose terminal evidence unless recovered elsewhere. Exact beta.78 classifier maps numeric 13 to UnknownError even after errcode normalisation. Recovery cannot assume ConnectionError/LockTimeoutError captures disk exhaustion. No Neokod production event loss reproduced.

Remaining gate: Controlled storage-full/fault injection, bounded persistence retries/attempt fencing and stop fallback; do not replay provider work; ensure full-error cause recognisable.

## #15450: fix(server): a crashed server no longer leaves Claude agents running

Default Claude SDK query path has no explicit spawn hook/durable PID ledger. Normal close shuts owned query; hard-kill recovery and survivor behaviour are unproven locally. No local hard-kill experiment. Do not generalise upstream Linux/macOS author evidence or Windows job object claims into local proof.

Remaining gate: Installed SDK spawn capability, isolated hard-kill/restart, stale state/process exit proof, PID birth identity and spawn-to-ledger/redacted argv gaps.

## #15459: fix(server): a logged-out Claude CLI no longer reports as authenticated

Completed Claude capability probe always returns authenticated, although captured `tokenSource` may be `none` and `apiKeySource` is omitted. Explicit evidence absence can therefore be mislabelled. Do not turn absent account fields into logged-out; explicit `tokenSource: none` still needs first-party and API-key qualification.

Remaining gate: First-party logged-out versus API key/Bedrock/Vertex; account-silent older versions and timeout stay compatible/unknown. Select one authoritative evidence model.

## #15474: fix(server): Stop reaches background work after a run fails before its provider starts

Newer failed pre-provider V2 run cannot identify older background native work without fallback. Local interrupt targets session/thread rather than V2 run/attempt.

Remaining gate: Map real local background/failed-start/stop sequence before adopting fallback; preserve newer-turn fencing.

## #15488: fix(server): sqlite transactions wait for the write lock instead of failing

Node client uses a connection semaphore, not cross-connection serialisation, and `Client.make` has no `beginTransaction` override. Exact Effect beta.78 defaults to `BEGIN` and classifies `code`/`errno` rather than `errcode`. Probe demonstrates ERR_SQLITE_ERROR with errcode 517 (BUSY_SNAPSHOT), 2067 (unique constraint) and 13 (disk full), not Neokod execution. Normalising `errcode` into `errno` maps 517 to LockTimeoutError and 2067 to UniqueViolation, but 13 remains UnknownError. CLI prefers live RPC, with direct DB fallback; concurrent same-DB topology is possible, not demonstrated typical. Immediate begin is writable-client policy, not universal contention recovery.

Remaining gate: Real application clients on two connections/processes; writable immediate/deferred read-only semantics, wait-timeout/retry/nested transaction behaviour and disk-full policy.

## #15495: fix(server): a restart no longer resends imported history to a session that already has it

Imported V1/V2 manual-context handoff resend contract is not local classic history flow. Open-before-cutoff metadata is available, but later updated diff cannot prove proposal content at cutoff.

Remaining gate: No demonstrated local importer equivalent; date later diff observation and retain native-history acceptance identity for any migration.

# Qualified architecture and coverage wording

## coverage-enumeration

Independent distinct-ID arithmetic, set reconciliation and per-file count recomputation confirm every count. Five closed search leaves have 474 / 250 / 782 / 857 / 870 results and contiguous inclusive second boundaries. Open REST pages have ten 100-row pages and 59 final rows; union matches details/ledger. Eight partial inventories are correctly deferred. Open capture spans 05:27:36.763–05:27:56.923 UTC, after closed cutoff 05:27:33 UTC; details complete 05:39:01.798 UTC. Seven open metadata update drifts are dated in manifest.

Remaining gate: Retain frozen capture interval, GitHub index/search completeness boundary and non-atomic metadata observations. This is complete enumeration of captured API results, not guaranteed atomic world-state at one second.

## published-baseline

Saved release list has v3.6.0 non-draft published 2026-08-10T06:42:36Z; listed newer drafts have no publication time. Installed/deployed version was never established.

Remaining gate: Keep the published-release proxy label. A changed-since-install assertion requires the installed build identity, which this review did not obtain.

## v2-primitives-and-loss

Node/task/parent lineage and context transfer result identity exist in source; completion delivery has generations/cohorts. Outbox separates cancellation of provider-start/interrupt/steer/restart/respond on process loss from requeue-safe classes. Release explicitly warns lost provider reasoning/tool/attachment continuity and divergent V1/V2 copy.

Remaining gate: Adapting primitives requires local authority/lifecycle design and copied-data migration/rollback proof. Check idempotency against each effect’s actual acceptance and delivery contract.

## governance-authentication

Current upstream WS middleware requires operate scope and creation provenance is server stamped as user. Delegated raw request checks active parent/run/node but uses command modes. Local headless auth/tickets exist and README qualifies legacy desktop bootstrap. Child credential possession is unproven. A raw operate caller intentionally broad authority is not automatically a vulnerability. The architectural gap is reliance on helper-only restriction for any promised app-owned-agent ceiling.

Remaining gate: Separate trusted-human operate authority from agent-origin capability ceilings; establish actual auth credential reachability before exploit claims. Do not import removed upstream auth infrastructure.

## symphony-policy-evidence

Config parses `maxRunDuration`, `concurrencyProvider`, `approvalsBefore*` and `protectedPaths`; runtime source searches do not establish those keys as enforced safety gates. Dispatcher uses effective Codex approval policy and existing orchestration/merge controls. This finding reads dirty current source as observation only, not review approval of owner implementation. Project `maxConcurrentAgents` maps into `concurrencyGlobal`; do not call all similarly named caps unenforced.

Remaining gate: Current unrelated Symphony work must be validated by its owner; prove controls on actual end-to-end evidence path before increased autonomy.

## symphony-workspace-transfer

takeOver/resume use fenced ownership transfer and thread/workitem binding. delegate creates manual item separately. This is transfer machinery, not native provider continuity. Existing ownership code is not blanket proof every race is safe, especially unrelated changed Symphony files.

Remaining gate: Keep one owner per workspace, require explicit transfer or separate allocation, durable linked receipt/outcome; Codex-only target may need bounded briefing.

## evolution-versus-replacement

Existing command persistence/recovery/provider/UI investment and separate Symphony plane make wholesale replacement a broad contract/history migration. V2 implements valuable primitives, but source cannot quantify comparative integration/maintenance cost. This is a justified design judgement, not empirical proof evolution always cheaper or fresh engine technically inseparable.

Remaining gate: Comparable Codex+Claude chat prototype, fault recovery/history copy/rollback, local latency/memory and later tracker parity before replacement release. Preserve current native credentials and legacy data.
