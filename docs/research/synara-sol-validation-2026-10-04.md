# Independent Synara validation

Frozen source: [5f2ee77ae9fc60993db47e81419c1171a99a5c32](https://github.com/Emanuele-web04/synara/commit/5f2ee77ae9fc60993db47e81419c1171a99a5c32). Read Synara README, coordinator plan/implementation ledger, selected source, all 12 selected PR bodies/file lists, and full bodies/comments for issues 282/393/618/974/1264/1250. Validated all 25 frozen Git blob hashes. Three additional caller/constant files fetched anonymously at the same SHA are retained in this lane. This is source and captured-tracker evidence, with no application execution.

## Coverage

The declared PR window starts 4 July 2026 UTC. All-PR updated-desc pages stop after a page whose oldest update is23 June; the separate current-open query exhausts191 records. Retained965records are unique and match965 details:649merged,125closed unmerged,163open ready,28open draft. All965 file lists have complete=true and exact changedFiles counts; all12 selected records match the full details.939 records were created/closed/merged in-window,25 are older currently open, and1 is older but updated in-window. This avoids the search1000-result ceiling. The capture interval is non-atomic. It is complete for declared body/filename metadata scope, not a complete PR discussion/review/check-run/diff audit.

## Source conclusions and gates

### Shared GitHub read gate

confirmed with scope limit. Single service-instance semaphore has six slots and common rate-limit pause; checks pause again after slot admission. All execute errors can extend pause, but only withRead callers are queued. Cached lists/details remain usable; listOpenPullRequests/direct execute/create/merge/comment/checkout are deliberately ungated.60s pause is a fallback, not authoritative reset time; not account-global across other apps/server instances. [Source](https://github.com/Emanuele-web04/synara/blob/5f2ee77ae9fc60993db47e81419c1171a99a5c32/apps/server/src/git/githubReadGate.ts#L30), [caller/boundary](https://github.com/Emanuele-web04/synara/blob/5f2ee77ae9fc60993db47e81419c1171a99a5c32/apps/server/src/git/Layers/GitHubCli.ts#L2716).

Acceptance gate: Burst12 cold local worktrees: designated reads peak≤6, queued work does not launch after rate-limit detection, cached reads remain available, mutation prerequisite reads obtain fresh head facts. No promise of protection from all account consumers or remote calls.

### Beta-only Hub work and human provenance

confirmed, not Jira identity. Gateway/service gate Groups Beta, require coordinator and enabled/unpaused config. Server resolves1–16 unique message IDs or durable turn pending-message identity from coordinator detail; requires role=user and dispatchOrigin=user/unset. Frozen source messages retain text/attachments/IDs/timestamps; model brief is separate and does not grant permissions. Source hash+task index determines work identity; transaction stores request ID/fingerprint and rejects conflicting replay. Dedup is human-source-plan scope, not canonical tracker issue identity. [Source](https://github.com/Emanuele-web04/synara/blob/5f2ee77ae9fc60993db47e81419c1171a99a5c32/apps/server/src/agentGateway/hubWorkSource.ts#L13), [caller/boundary](https://github.com/Emanuele-web04/synara/blob/5f2ee77ae9fc60993db47e81419c1171a99a5c32/apps/server/src/projectAgent/hubWorkService.ts#L196).

Acceptance gate: Reject forged/cross-thread/agent/automation/duplicate context references before provider side effects; repeated request and alternate request ID with same frozen plan return same item; conflicting plan refused. Stable(saved Beta state) launches nothing. Jira/poll/chat race must use Neokod canonical tracker connection+immutable issueID instead.

### Message-chunk replay safety

confirmed mechanism, not simple SQL append. Every mutation is in caller projection/event transaction. Per-message text_event_sequence watermark rejects applied/older event; chunk PK includes event sequence. Imported/resumed body becomes one prefix chunk(-1), segment boundaries separate visible segments from full body, settle removes chunks after materialization. Ordered readers assemble JSON-preserved UTF16/NUL-safe text. Bare concatenation or INSERT without watermark/rollback/reader updates would duplicate or corrupt replay. [Source](https://github.com/Emanuele-web04/synara/blob/5f2ee77ae9fc60993db47e81419c1171a99a5c32/apps/server/src/persistence/messageTextChunks.ts#L44), [caller/boundary](https://github.com/Emanuele-web04/synara/blob/5f2ee77ae9fc60993db47e81419c1171a99a5c32/apps/server/src/persistence/Layers/ProjectionThreadMessages.ts#L130).

Acceptance gate: Repeat event, crash before commit, replay after completion, imported prefix, segment replacement, rollback/purge, split surrogate and embedded NUL produce identical durable message across all readers. Benchmark actual engine/WAL; PR1097 still documented flat per-delta overhead.

### Startup replay before reconciliation

confirmed ordering, blocked replay requires gate. OrchestrationReactor awaits provider ingestion start. Extra pinned source confirms pruneSettledOpenTurns→rebuildAcceptedOpenTurnState→drainRuntimeJournal before startup replay Deferred resolves. Only then restart reconciliation and settled-open cleanup, then background reactors. [A blocked journal page](https://github.com/Emanuele-web04/synara/blob/5f2ee77ae9fc60993db47e81419c1171a99a5c32/apps/server/src/orchestration/Layers/ProviderRuntimeIngestion.ts#L3541) can yield before the full fence and retry later, so ordering is not unconditional proof every persisted terminal event was consumed. Restart reconciler assumes provider runtime dies with server, which must be checked for each Neokod surviving native child. [Source](https://github.com/Emanuele-web04/synara/blob/5f2ee77ae9fc60993db47e81419c1171a99a5c32/apps/server/src/effectServer.ts#L138), [caller/boundary](https://github.com/Emanuele-web04/synara/blob/5f2ee77ae9fc60993db47e81419c1171a99a5c32/apps/server/src/orchestration/startupTurnReconciliation.ts#L1).

Acceptance gate: Crash after terminal event journaled/before projection: normal completed result including buffered text survives. Also block earlier journal page/ack failure and verify a later durable terminal is not incorrectly interrupted. Absent/uncertain inventory remains unknown/orphaned in Neokod; no blind all-children-dead assumption.

### Process incarnation guards

confirmed narrow protection; universal claim rejected. Reject pid≤1/malformed/out-of-range/self root; POSIX batched probes force C locale and capture command+second-resolution lstart. Delayed SIGKILL verifies captured descendant identity unless already verified. SIGTERM and root signalling rely on caller ownership; no universal spawn registry or atomically held root incarnation. Optional missing startedAt falls back to command equality. Windows root uses treeKill. Closed-unmerged1267 proposed broader guarantees; merged1270 is deliberately scoped. [Source](https://github.com/Emanuele-web04/synara/blob/5f2ee77ae9fc60993db47e81419c1171a99a5c32/apps/server/src/platform/processTreeController.ts#L187), [caller/boundary](https://github.com/Emanuele-web04/synara/blob/5f2ee77ae9fc60993db47e81419c1171a99a5c32/apps/server/src/platform/processTreeController.ts#L313).

Acceptance gate: Invalid/broadcast targets never signal; reused same-command PID with new captured start rejected; probe failure preserves unknown; caller fences live root owner/generation. Exercise native Windows/POSIX actual child cancellation. Retain probe→kill race and timestamp resolution as limits.

### Same-visible-thread handoff

confirmed fresh target; bootstrap status overstates delivery. Same thread/project/workspace/history stay. Refuses busy/approval/question/same-provider switch; reactor also guards background native tasks, clears source native cursor/stops source, starts fresh target, restores source selection on failure. Source writes handoff.bootstrapStatus=completed when target session is up; actual bounded prior transcript travels in next turn and provider acceptance varies. This is neither native continuity across providers nor proof target consumed full displayed transcript.1494 claims live Codex↔Claude only; other pairs mocked; slash commands do not run pre-send handoff. [Source](https://github.com/Emanuele-web04/synara/blob/5f2ee77ae9fc60993db47e81419c1171a99a5c32/apps/server/src/orchestration/decider.ts#L152), [caller/boundary](https://github.com/Emanuele-web04/synara/blob/5f2ee77ae9fc60993db47e81419c1171a99a5c32/apps/server/src/orchestration/Layers/ProviderCommandReactor.ts#L6383).

Acceptance gate: Preserve thread/worktree/provenance; source ownership ends before target writer; rejected/live-background handoff has no launch. Distinguish selected/session-ready/context-pending/context-accepted; first turn failure/restart retains replay-safe pending context; different account and other provider pairs require native qualification. Never call recap full native memory transfer.

## Selected PR validation

| PR                                                                                                                                              | Captured state / merge date  | File count   | Evidence boundary                                                                                                                                                                                                    |
| ----------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------- | ------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [580: Scope orchestration replay and avoid duplicate runtime event persistence](https://github.com/Emanuele-web04/synara/pull/580)              | MERGED; 2026-08-08T00:08:32Z | 25 complete  | Body Testing says not run; durable replay/fan-out file coverage is not local execution.                                                                                                                              |
| [613: Make queued-turn promotion replay-safe](https://github.com/Emanuele-web04/synara/pull/613)                                                | MERGED; 2026-08-09T21:04:45Z | 3 complete   | Claims focused queue/promotion/reconciliation tests; no local run by validator.                                                                                                                                      |
| [764: Reduce desktop CPU and process-tree memory](https://github.com/Emanuele-web04/synara/pull/764)                                            | MERGED; 2026-08-20T20:20:38Z | 2 complete   | Actual changedFiles=2(codex manager+test); broad27-file audit and before/after figures in body describe cumulative branch context. Do not attribute all renderer changes/measurements to this two-file PR or Neokod. |
| [1097: Store streamed assistant text as chunks; tighten provider memory and cleanup](https://github.com/Emanuele-web04/synara/pull/1097)        | MERGED; 2026-09-10T13:29:57Z | 54 complete  | Merged chunk and cleanup mechanism; body excludes flat per-delta floor/process orphan ledger. Measurements belong to contributor environment.                                                                        |
| [1115: Harden orchestration replay and provider startup against stalls](https://github.com/Emanuele-web04/synara/pull/1115)                     | MERGED; 2026-09-10T20:16:52Z | 11 complete  | Body Testing says not run; generated summary test coverage is not a run.                                                                                                                                             |
| [1270: fix(process): guard invalid signals and captured process identities](https://github.com/Emanuele-web04/synara/pull/1270)                 | MERGED; 2026-09-19T17:33:37Z | 10 complete  | Scoped invalid target/captured descendant guard; no global kill replacement, spawn registry or universal root identity. Native tests are contributor claims.                                                         |
| [1307: Settle restart-orphaned turns before background reactors start](https://github.com/Emanuele-web04/synara/pull/1307)                      | MERGED; 2026-09-24T19:03:44Z | 3 complete   | Ordering fix confirmed source; not proof shutdown quarantine974 fixed.                                                                                                                                               |
| [1332: feat(server): persist provider model catalogs across restarts](https://github.com/Emanuele-web04/synara/pull/1332)                       | MERGED; 2026-09-25T16:02:54Z | 11 complete  | Persistent successful model catalog keyed paths/endpoint/cwd; same-path account/CLI change not immediately invalidated. OMP bypass, pending/degraded distinct; live account/performance not verified.                |
| [1378: Groups in Synara Beta: coordinator workers, Library, and clear thread state](https://github.com/Emanuele-web04/synara/pull/1378)         | MERGED; 2026-09-30T14:55:33Z | 327 complete | Groups Beta gates both server and UI; local SQLite/provider-recorded tests and browser rendering do not prove live coordinator or signed release.                                                                    |
| [1484: Share one GitHub read queue and rate-limit pause across gh reads](https://github.com/Emanuele-web04/synara/pull/1484)                    | MERGED; 2026-10-02T19:37:38Z | 18 complete  | Background subset gate confirmed; stub-gh performance only, no live secondary-limit reproduction.                                                                                                                    |
| [1490: Add durable Hub work orchestration and task tracking](https://github.com/Emanuele-web04/synara/pull/1490)                                | MERGED; 2026-10-02T19:53:37Z | 60 complete  | Body Testing explicitly not run; test file presence and automated review summary do not establish passing tests.                                                                                                     |
| [1494: feat(handoff): continue provider handoffs in the same thread, from the model picker](https://github.com/Emanuele-web04/synara/pull/1494) | MERGED; 2026-10-03T17:03:33Z | 27 complete  | Source-ready status precedes next-turn bootstrap; fresh target, no native return session, Codex↔Claude live claim only, other pairs mocked, slash-command gap.                                                       |

## Current selected issues

### [282: Conversations list appears empty after 0.3.6 → 0.3.7 upgrade, but data is intact in SQLite](https://github.com/Emanuele-web04/synara/issues/282)

Captured state open, updated 2026-09-25T15:07:45Z; 9 comments, complete. Environment: macOS 15.6 arm64; upgrade0.3.6→0.3.7, persists0.3.8. Classification: User report later corrected by durable SQL/event evidence.

Initial hydration theory is superseded for this installation: reporter later finds four soft-deleted rows, all projectors at635, and client-origin thread.deleted events285–288 within46ms. It does not prove what caused that burst. Maintainer discussion explains a separate hydration gap without independently reproducing this incident.

Fix boundary: PR324 is closed unmerged as of2026-09-04; historical comments called it draft. It targets hydration, not reversal of persisted deletes.

Acceptance gate: Seed upgrade history with active, archived and soft-deleted threads. Preserve deletion provenance, verify zero unrequested delete commands, and sequence-fence shell recovery so older snapshots cannot erase newer detail.

### [393: [Bug]: Windows upgrade loops on SQLite backup fsync and blocks Codex recovery](https://github.com/Emanuele-web04/synara/issues/393)

Captured state open, updated 2026-09-25T14:49:41Z; 2 comments, complete. Environment: Windows x64; published v0.5.5→main ef16dee9; Bun 1.3.12, Codex 0.144.5. Classification: Detailed user/contributor report with claimed native Windows and Codex acceptance evidence.

Read-only fsync handle EPERM, per-file SQLite-family overlay ownership and initialize deadline are separate failure stages. Contributor reports live acceptance for a local patch; we did not run it. COLLABORATOR related-links comment is explicitly automated Synara triage · Devin.

Fix boundary: PR396 is open ready, not shipped. Merged1062 fixes SQLite-family linking using one source SQLite home, a different policy from396 process-owned overlay. Related issue406 asks for immutable released-database fixture and interruption cleanup; it is not a fix PR.

Acceptance gate: Native Windows upgrade from immutable released DB fixture: correct backup/marker integrity; failure leaves only owned recoverable artifacts; one canonical DB/WAL/SHM home; initialize→initialized→resume→harmless turn with versioned timeout. Do not infer packaged success from reconstructed migrations.

### [618: Deleted or archived projects leave worktrees and database records behind, causing disk growth and projection-repair lockups](https://github.com/Emanuele-web04/synara/issues/618)

Captured state open, updated 2026-09-25T14:48:27Z; 1 comments, complete. Environment: macOS;0.7.1 and0.7.0. Classification: User report with measured retained state/logs; contributor implementation claim only.

Reporter distinguishes retained state/repair thrash from project data loss:35GB worktrees,4.1GB backups,1.1GB DB; healthy server still maintenance-locks commands.0.7.1 avoids the specific0.7.0 false60s readiness timeout, not all repair/cleanup problems.

Fix boundary: Merged724 coalesces repair and adds2min successful-rebuild cooldown; merged747 reclaims safe managed worktrees, skips dirty paths and retains active owners. Both explicitly partial; dirty confirmation/storage browser/complete progress qualification remain outside those PRs.

Acceptance gate: Concurrent repair converges once; command latency remains bounded through large-state maintenance; clean deleted/orphan worktree safely removed only after ownership/data checks, dirty/unknown preserved; finalized backups bounded without destroying recovery evidence.

### [974: [Bug]: Quit with a running turn can leave the thread durably quarantined (interrupt failure reported after command admission stopped)](https://github.com/Emanuele-web04/synara/issues/974)

Captured state open, updated 2026-09-25T14:09:17Z; 1 comments, complete. Environment: Official0.8.1 LinuxAppImage; ArchLinux/Hyprland/Wayland; Codex; source 562c5fea77cf. Classification: User report with precise quit/restart timing and durable delivery rows.

Detached quit interrupt attempts failure activity after command admission stops, and the diagnostic dispatch rejection becomes uncertain durable quarantine. Later restart continuation and manual messages are skipped. Automated COLLABORATOR triage only links985; it is not human reproduction.

Fix boundary: 985 is an open feature/PRD issue, not a merged fix.1307 changes restart ordering and cannot be credited as resolution of974 shutdown admission/quarantine.

Acceptance gate: Deterministically stop command admission during quit interrupt failure logging; diagnostic refusal must not poison provider delivery. Preserve actual ambiguous provider side effects; restart/resume-on and resume-off paths accept next intended request exactly once.

### [1264: [Bug]: OpenCode 2.x unsupported — server readiness prefix changed and V1 HTTP API routes removed](https://github.com/Emanuele-web04/synara/issues/1264)

Captured state open, updated 2026-09-25T12:57:18Z; 0 comments, complete. Environment: Synara0.8.4 macOS; OpenCode2.0.7; bundledSDK 1.15.13. Classification: Unconfirmed user report with bundled-source/output/API route probes.

Two independent boundaries: readiness prefix changed and old SDK v2 entrypoint still issues unprefixed routes returning HTML. Supplying server URL only bypasses readiness; it does not restore API compatibility. No comments captured.

Fix boundary: No linked/current verified fix for OpenCode2 compatibility. This version-specific report does not establish all current OpenCode builds fail or that frozen main has the same adapter.

Acceptance gate: Test actual installed CLI/SDK pair: both supported readiness banners, correct API routes/content schema, model/session/start/stream/cancel behavior. Unsupported contracts fail explicitly before claiming provider readiness.

### [1250: [Bug]: Profile undercounts Claude and Antigravity usage in mixed-provider histories](https://github.com/Emanuele-web04/synara/issues/1250)

Captured state open, updated 2026-09-25T12:58:57Z; 1 comments, complete. Environment: Local0.8.4 macOS mixed-provider history; inspected9f91d59f; modified prototype build. Classification: Source/database/log investigation and local prototype, not stock current runtime verification.

Accounting gaps include independently billed children, missing completed-turn usage and cross-session LAG baselines; context occupancy is not processed tokens. Prototype native-request recovery is supporting evidence, not requirement for normal query-time log scanning. Automated COLLABORATOR triage links1251 only.

Fix boundary: Merged1024 explicitly defers complete lifetime summaries/historical Claude migration and Antigravity normalization.1251 is an open RFC related to existing1025 implementation, not fix1250. No evidence these lifetime/history gaps are all shipped fixed.

Acceptance gate: Count normalized inclusive input1000+output100 as1100, not1900 with cache subset800. Separate provider/native-session cumulative baselines(1000+1500=2500), replay/import idempotence, independent child once vs native mirror excluded, deletion archives totals, unavailable historic usage stays unknown.

## Delivery limits

No application/runtime/native/packaged-release proof was generated. Existing contributor tests and measurements are attributed claims; automated triage and Cursor summary blocks are not human runtime reproduction. Main merges do not establish a shipped release. Neokod should adapt backend intent against its canonical lifecycle/tracker/workspace rules, preserve unknown evidence, and build its own ordinary-chat surfaces. Beta mode requirements and competitor UI/hosted mechanisms are not prerequisites for Neokod orchestration.
