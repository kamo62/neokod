# FINDINGS rt-c (providers, prefix PV-)

Setup: isolated server on 14791, base dir rt-c/base, throwaway repo rt-c/repo (1 commit). Providers enabled in Settings > Providers. Scripts p\*.mjs, shots in shots/.

## PV-01 P2 (RUN) Pressing Stop on an OpenCode turn marks the thread Failed with a red "Aborted" toast and "Runtime error"

Repro: OpenCode, model opencode/muse-spark-1.3-contributor-free, send "Write a very long, detailed 1500 word essay about the history of tea. Do not use tools.", wait 20 s, click "Stop generation".
Expected: turn shown as Interrupted/Stopped (neutral), thread back to idle, no error.
Actual: header pill "Failed", sidebar row "Failed" with red dot, thread placed in "NEEDS YOU", red toast "Aborted", inline red "Runtime error" row. DB: projection_turns.state='error', activity runtime.error message "Aborted", provider_session.status was 'error'. The composer recovers and the next turn ("Reply with exactly: after-stop") works and completes (Completed 2s), so only the display and status are wrong.
Cause: after session.abort OpenCode emits session.error {MessageAbortedError "Aborted"}; the adapter treats every session.error as terminal failure (settleSessionFailure) including the abort the user just requested.
Code: apps/server/src/provider/Layers/OpenCodeAdapter.ts:1065 (session.error case) -> :684 settleSessionFailure sets status "error" and emits turn.completed state failed + runtime.error (:749-:770). interruptTurn (:1407) also emits turn.aborted separately, so the turn is double-settled.
Evidence: p9.mjs, shots/p9-b.png, sqlite projection_turns/projection_thread_activities for thread 07f51c90-bb11-4cc7-b5de-fedd95391fca.

## PV-02 P3 (RUN) New-thread default model is Codex gpt-5.4 even though Codex is Unavailable; picker opens on Codex with "No models found"

Repro: with Codex enabled but broken (its shim throws "Missing optional dependency @openai/codex-darwin-arm64"), open a new thread in a project. Composer shows "gpt-5.4" with a red "Codex provider status: Codex app-server provider probe failed: Codex App Server process exited with code 1." banner. Opening the model picker lands on the Codex tab with "No models found".
Expected: default to the first ready provider (or tell the user to fix Codex). Actual: default stays on the broken provider; user must find the right tab among 5 icon-only tabs (no labels or tooltip text checked).
Also: Settings card text "process exited with code 1" hides the actual cause (already noted in RA-03; stderr not surfaced). Real cause confirmed by running `codex --version`: "Missing optional dependency @openai/codex-darwin-arm64. Reinstall Codex".
Evidence: shots/p4-project.png, p5-picker.png.

## PV-03 P3 (RUN) Assistant text only appears at the end of the turn by default; the "Working" row gives no activity

Settings > General > "Assistant output: Show token-by-token output while a response is in progress" defaults to OFF (packages/contracts/src/settings.ts:661, ProviderRuntimeIngestion.ts:1753 "buffered"). With it off, Copilot and OpenCode show only "Working for Ns" for 20 s+ and the whole answer lands in one thread.message-sent event when the turn ends or is stopped (sqlite: one 4 KB streaming message at the interrupt). With it on, Copilot streams (len 374 -> 1362 -> 2264 -> 3099 -> 4174 over 12 s). OpenCode with this free model stays at 410 chars for 12 s even with it on (the model returns one lump; `opencode run --format json` also emits text only after ~24 s), so OpenCode streaming is NOT TESTABLE here. Polish: the default makes long turns look hung; no reasoning/step row.

## PV-04 P3 (RUN) OpenCode approval prompt: wording and row state

Repro: OpenCode, runtime mode Supervised, ask to create hello.txt with `hi`. Prompt shows "PENDING APPROVAL Command approval requested printf 'hi' > hello.txt" with Cancel turn / Decline / Always allow this session / Approve once. Works: command text correct, file absent while pending (verified), prompt survives closing and reopening the tab (37 s later still pending, Approve once then worked), Approve once -> hello.txt contains exactly "hi" (od -c), turn Completed with "CHANGED FILES (1) hello.txt +1 -0". Decline (separate turn, reject.txt) -> file not created, turn Completed, no assistant message at all (collapsed "Worked for 16s" row only; the user is not told the command was refused).
Defects: (a) while the approval is pending the work log row already reads "Ran command" with a check mark for a command that has not run (shots/p10-b.png). (b) after Decline the header says "1 file changed +0 -0" although no file changed and the projection row has files=[] (shots/p12-b.png; hello.txt from an earlier turn is untracked in the same checkout, suspect the diff summary counts it). (c) activity approval.resolved stores requestType "unknown" for both approve and decline (sqlite projection_thread_activities) though the request kind is known when requested. (d) the approval card shows no cwd or target file, only the shell string.

## PV-05 P3 (RUN) "N file changed +0 -0" header on turns that change nothing

Repro: in rt-c/repo hello.txt is untracked (left by an earlier approved turn). Any later OpenCode turn that writes nothing (declined command, plan-mode turn) shows "Completed . 1 file changed +0 -0" in the thread header; projection_turns.files is []. Expected "no changes". Probably checkpoint/diff summary counting the untracked file. Evidence shots/p12-b.png, p15-a.png.

Plan mode (OpenCode): works. Provider options menu (model picker footer) has Variant (Minimal..Xhigh) and Agent (Build, Governance Lead, Plan). With agent Plan and runtime mode Full access, asking to create a file via shell: model refused ("Plan mode is active"), file not created, no approval prompt. There is NO Build/Plan toggle in the composer for OpenCode (it exists for Codex), so plan mode is reachable only through the picker footer; the plan is plain text, not a proposed-plan card. Agent list exposes the owner's custom agent "Governance Lead".

## PV-06 P1 (RUN) Claude usage limit shows as a green "Completed" turn with NO assistant message and NO error

Repro: Claude enabled (card "Authenticated as ... Claude Pro Subscription"), account out of session usage. New thread, Claude Haiku 4.5, send "Reply with exactly: ok".
Expected: a visible error such as "You've hit your session limit, resets 10:30pm" and a failed/errored turn.
Actual: after 36 s the thread header says green "Completed . 2 files changed +0 -0", the sidebar row has a check, the conversation shows only the user bubble, nothing else (shots/p24-a.png). DB: projection_thread_messages has only the user row, projection_turns.state=completed, no error activity, session ready/no last_error. The only trace is a context-window.updated of 26489 tokens (all Claude Code overhead, 0 input/output).
What Claude actually sent (provider log base/userdata/logs/provider/f6c270f5-...log): claude/rate_limit_event {status:"rejected", rateLimitType:"five_hour", overageDisabledReason:"out_of_credits", five_hour utilization 1, seven_day 0.95}, then an assistant message with model "<synthetic>", error:"rate_limit", is_api_error_message:true, text "You've hit your session limit · resets 10:30pm (Africa/Johannesburg)", then result {subtype:"success", is_error:true, api_error_status:429, terminal_reason:"api_error"}.
Root causes (READ+RUN):
(1) ClaudeAdapter.ts:2591 handleAssistantMessage returns early when message.error !== undefined, so every API-error assistant message (rate_limit, billing_error, authentication_failed, invalid_request) is dropped and its text never reaches the thread.
(2) ClaudeAdapter.ts:1076 turnStatusFromResult returns "completed" for subtype "success" and ignores is_error / api_error_status, and :2694 only builds errorMessage for non-success subtypes, so the 429 result is closed as completed.
(3) rate_limit_event is converted to account.rate-limits.updated (:3019) but nothing in apps/web or the Settings card consumes it (grep rateLimits in apps/web: none), so the Settings > Providers card still says Authenticated with no quota state.
The same applies to the user's fix hint: with an unusable account the user waits 36 s and sees nothing, then types again and burns time. Claude's own 5h window was already at utilization 1.
Also slow: 28 s between the rate_limit_event and system init in the log.

## PV-07 P2 (RUN) Claude child is started with the MCP bearer token on its command line; Claude and Copilot children inherit the whole server environment

Evidence: `ps -o command -p <claude pid>` shows `claude ... --mcp-config {"mcpServers":{"neokod":{"type":"http","url":"http://127.0.0.1:14791/mcp","headers":{"Authorization":"Bearer QM-qb54V0RQ...GM"}}}} --permission-mode bypassPermissions --allow-dangerously-skip-permissions ...`. Any local user can read it with ps. The token is per thread session (McpSessionRegistry.ts:133) but is valid for the Neokod /mcp endpoint. Also `ps eww` on the copilot and claude children lists 82 and 83 environment variables, including CODEX_LB_API_KEY, SSH_AUTH_SOCK and CMUX_CUA_AUTH_TOKEN_FILE from the server's environment (same set as the server process).
Code: apps/server/src/provider/Layers/ClaudeAdapter.ts:3668-3700 (mcpServers passed as SDK option which becomes --mcp-config argv). Safer: pass via a temp file with 0600 or env var, and give the child a scrubbed environment.
Note: the Claude flags include --permission-mode bypassPermissions even in runtime mode Full access (expected); check supervised below.

## PV-08 P3 (RUN) One `opencode serve` child (~100 MB RSS) per thread stays alive after the turn ends

After 8 OpenCode threads (all idle, turns finished) there were 8 `opencode serve --hostname=127.0.0.1 --port=<n>` children of the Neokod server, 823 MB RSS in total, plus one claude process (74 MB) per Claude thread. The reaper only frees them after 30 min inactivity (ProviderSessionReaper.ts:16). Heavy on a laptop with many threads, and each is a separate OpenCode server (no sharing).

## PV-09 P3 (RUN) OpenCode child killed with kill -9 mid-turn: message says "(0)"

Repro: start a long OpenCode turn, `kill -9` the new `opencode serve` child of the Neokod server. UI after 3 s: thread header Failed, inline "OpenCode server exited unexpectedly (0)." and the composer is usable again; resending ("Reply with exactly: recovered") spawns a new server and works. Good recovery, but the code shown is "0" for a SIGKILL (no signal name, no stderr). Code: OpenCodeAdapter.ts:1135 prints the exitCode; the signal is lost. Also the header says "2 files changed +0 -0" again (PV-05).

## PV-10 P1 (RUN) S02 CONFIRMED for OpenCode: after `kill -9` of the Neokod server mid-turn and restart, threads stay "running" forever and cannot be stopped, approved or cancelled

Repro: 3 threads: A OpenCode long turn running, B Copilot long turn running, C OpenCode with a pending command approval (Supervised). `kill -9 <neokod pid>`, restart with the same --base-dir, wait 30 s, open each thread.
Actual (30 s and again 6 min later):

- A (OpenCode, running): header "Working", Stop button shown, timer keeps counting (2m50s, 5m40s). Pressing Stop: nothing visible except a small collapsed work-log row "Provider turn interrupt failed"; DB activity provider.turn.interrupt.failed detail "ProviderValidationError: Provider validation failed in ProviderService.interruptTurn: Cannot recover thread '66caf873-...' because no provider resume state is persisted." (note it also leaks "at toValidationError (file:///Users/kamogelo/Code/t3code/apps/server/dist/bin.mjs:40875:9)" stack frames and absolute paths in the stored detail). projection_thread_sessions.status stays 'running', provider_session_runtime.status 'running'. A new message typed into the composer is shown as a queued item "Send now into the running turn"; only clicking that sends it and the thread then moves to ready (so a hidden recovery path exists, nothing tells the user).
- C (pending approval): approval card still shown with Decline/Always allow/Approve once/Cancel turn. Approve once -> work-log row "Provider approval response failed", approval stays pending, file not written (crash.txt absent). Cancel turn -> no effect. Still "Working for 5m 40s".
- B (Copilot): shows Working but Stop works (thread becomes ready), because Copilot persists resume state.
  Expected: on startup reconcile bindings whose session no longer exists: mark the active turn interrupted/failed ("Neokod restarted") and set the thread to ready; stale approvals resolved as cancelled.
  Code: ProviderSessionReconciler.ts skips running bindings (plan.md S02), ProviderService.interruptTurn "Cannot recover thread ... no provider resume state is persisted" (OpenCodeAdapter never persists a resume cursor).
  Evidence: p28.mjs/p29.mjs/p30.mjs, shots/p28-_.png p29-_.png p30-\*.png, sqlite projection_thread_sessions.

## PV-11 P2 (RUN) Hard-killing the Neokod server leaves every `opencode serve` child running, unauthenticated, on loopback

After `kill -9 <neokod pid>`: copilot and claude children exited (stdio EOF) but 7 `opencode serve --hostname=127.0.0.1 --port=<n>` processes were reparented to PID 1 and kept running (ps after-kill.txt). `curl http://127.0.0.1:63971/global/health` -> {"healthy":true,...} and `/path` returns home/state/config paths with no password. Anything on the machine (or a web page via DNS rebinding or simple GET) can drive these servers: sessions, shell tool, permission replies. ~100 MB each. Neokod also does not set a server password for the servers it spawns (Settings has "Server password" only for external servers).
Code: apps/server/src/provider/opencodeRuntime.ts (spawn without password, no process-group kill or parent-death watchdog). Normal shutdown is covered by the scope finalizer (OpenCodeAdapter.ts:93-100), kill -9/crash is not.

## PV-12 P1 (RUN) Copilot CLI killed mid-turn: thread stays "Working" forever, Stop does nothing, no error on the thread

Repro: Copilot (Auto), long turn, after 7 s `kill -9` the `copilot --headless --no-auto-update --stdio` child of the Neokod server (not respawned, pgrep shows no child afterwards). Neokod server keeps running.
Actual: for 3+ minutes the header says "Working", timer counts (2m 43s), Stop button visible. A typed follow-up becomes a queued item with "Steer" and never runs. After the first Stop click a banner "GitHub Copilot provider status: Could not reach the GitHub Copilot runtime." appears (provider-level, not tied to the turn) but projection_thread_sessions stays 'running' and Stop is still shown. No runtime.error activity on the thread. Compare OpenCode kill -9 (PV-09) which fails the turn within 3 s and recovers.
Also: after the crash the composer label changed from "Auto" to "GPT-5 · Medium" while the thread header says "auto" (inconsistent model label).
Code: CopilotAdapter.ts has no handler that settles the active turn when the SDK connection/process closes (check CopilotRuntime.ts onClose). Evidence: p38.mjs, p39.mjs, shots/p38-a.png p39-a.png.

PV-10 addendum (RUN): a graceful restart (kill -TERM, then start) marks every running binding stopped and the next start sets those threads to status "interrupted" (no stuck threads). So the stuck state after a hard crash is cleared only by a second, graceful restart; the first start after a crash leaves bindings 'running'.
PV-12 addendum (RUN): after the Copilot child was killed, Settings > Providers kept "GitHub Copilot: Not found - Could not reach the GitHub Copilot runtime." (and the picker tab disabled) for 20 s+ even after the refresh button, i.e. the shared Copilot runtime is not respawned; only a Neokod restart restored it (verified below).

## PV-13 P3 (RUN) Grok card says "installed but failed to run" for a missing binary

Server log: "Grok CLI version probe exited with a non-zero status. { exitCode: 127, stderrLength: 30 }"; `grok --version` in the same environment prints "grok not found in PATH" (the owner's `grok` is a cmux shim that is not on the server's PATH). Card text: "Unavailable - Grok CLI is installed but failed to run." with no stderr and no hint to set the binary path. Exit 127 means not found. Code: apps/server/src/provider/Layers/GrokProvider.ts:242-256. Same pattern as Codex (RA-03): stderr not shown.

## PV-14 P3 (READ+RUN) Copilot model list silently falls back to a single "Auto" entry

Picker and Settings show only "Auto" for GitHub Copilot, so a user cannot choose a model. CopilotProvider.ts:304-316 runs client.listModels() wrapped in Effect.result + timeoutOption and, on any failure or timeout or empty result, silently uses the built-in list; no log line, no card warning. I could not prove listModels fails here (live catalog may be empty for this account), but a failure would be invisible. Also no Plan/Build option is offered for Copilot in the picker or composer, although CopilotAdapter.ts:1641 supports interactionMode plan (agentMode "plan"), so Copilot plan mode is unreachable from the UI (NOT TESTED).

## PV-15 P3 (RUN) Stale "Pending Approval" in the sidebar for a thread whose provider session was stopped

After a graceful restart, thread 9a4d87be (OpenCode, approval pending for crash.txt) has session status 'interrupted' and binding 'stopped', yet the sidebar still lists it under NEEDS YOU / "Pending Approval" (27 min later, shots/p42-a.png) because projection_pending_approvals is never resolved. The Approve button fails ("Provider approval response failed", PV-10). Code: provider session reconciler/ingestion should emit request.resolved cancel for open requests when a binding is stopped.

## PV-16 P3 (RUN) Provider trace log volume

logs/server.trace.ndjson rotates at ~10 MB roughly every 6 minutes under a few chat turns (5 files, 50 MB kept); logs/provider/<thread>.log hold the full native events (1.6 MB for one OpenCode essay turn, includes cwd and tool lists). Heavy for a laptop; no setting seen to turn it down.

## PV-S (static, READ) summary

- PV-S01 OpenCodeAdapter.ts:1065 session.error treats MessageAbortedError after a user abort as fatal (see PV-01). interruptTurn (:1407) emits turn.aborted separately; double settlement.
- PV-S02 ClaudeAdapter.ts:2591 drops assistant messages that carry `error` (rate_limit, billing_error, auth); :1076/:2694 ignore result.is_error / api_error_status (see PV-06).
- PV-S03 CopilotAdapter.ts:1693 interruptTurn does `Effect.tryPromise(() => ctx.copilotSession.abort()).pipe(Effect.ignore)`: abort failures are swallowed, so after the CLI died (PV-12) Stop reports success and the thread stays running. No handler anywhere in CopilotAdapter.ts for the SDK client/process closing (only session.error at :1102 and session.shutdown at :1060 which only records metadata, :1060-1084, and does not settle the turn).
- PV-S04 opencodeRuntime.ts:255-278 and CopilotAdapter.ts:83-93 map runtime mode "auto-accept-edits" to the same "ask everything" rules as approval-required (OpenCode edit: "ask"), while the UI promises "Auto-approve edits, ask before other actions". Claude maps it correctly to acceptEdits (ClaudeAdapter.ts:3659). Not run (needs one more turn) but the code is unambiguous.
- PV-S05 opencodeRuntime.ts:337,405 `extendEnv: true` and spawn `detached: true` (:394): full env inherited and the child is outside the server's process group, so SIGKILL of the server orphans it (PV-11). No password is generated for the spawned local server.
- PV-S06 OpenCodeAdapter.ts:940 permission.replied emits request.resolved with a hardcoded requestType "unknown" although the pending request was just deleted one line above (:930) and carried its kind (PV-04c).
- PV-S07 CopilotProvider.ts:304-316 swallows listModels errors (PV-14). Claude/Copilot env: ClaudeHome.ts:21 baseEnv ?? process.env (PV-07).
- Codex adapter not exercised (binary broken); no static defects noted beyond the already known N0b/N2 for Symphony.
