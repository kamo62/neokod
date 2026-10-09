# Handoff

Updated: 2026-10-09 on Kamogelos-MBP

## State

- Branch: `release/phase1-waves-1a-1c` (cut from Muse's `wave-1c-access-exposure`, which contains waves 1A, 1B and 1C: 32 commits over the previous `main`). Merged to `main` by the pull request that carries this file.
- Plan: `plan.md` revision 8. Implementation specs are 82 cards in `docs/plan-cards/` (seven files). Phase 1 is locked in `plan.md` section 14 (55 cards, five waves). Phase 2 is carded and deferred.
- Implemented by Muse (free model), reviewed and run by Claude:
  - 1A guards and small fixes: 0.5 migration identity guard, 1.13, 1.15, 2.4, 2.5, 2.6a, 2.6b-i, 2.6b-ii, 2.6c, H0 fake Codex harness.
  - 1B Symphony runner: 1.1 to 1.12 and 1.14 (approval ids and wire values, turn pinning and EOF bound, cancel ends `cancelled`, exhaustion ends `failed`, no relaunch, lock gating, pid and base branch, scrubbed child environment).
  - 1C access and exposure: A1 stable access token, A1b project CLI bearer, A1c docs, A2 web token prompt, B1 `--host` with token-gated non-loopback bind, B4 docs (Tailscale helper not revived), X-8 trace route limit, X-12 no automatic remote images, X-13 app-shell CSP and asset headers.
- Not yet done: waves 1D and 1E (see Next). No Phase 2 card has been started.
- The owner's server (`kamo@192.168.0.100`, `wv-htpc`, Tailscale 100.81.180.76) still runs neokod 3.6.0 on Node 22 behind Cloudflare, Traefik and Authelia. Nothing there has been changed.
- Dev data: `~/.neokod/dev` was archived to `~/.neokod/dev.archived-2026-10-04` (verified backup at `~/.neokod-backups/dev-2026-10-04`). Do not open the archive for writing.
- Dirty: nothing. Scratch work (test servers, Playwright scripts, a Node 24 copy at `/var/folders/b6/87d2msqd6fdbtcddcw5k8gbw0000gn/T/opencode`) is not preserved.

## Read this before upgrading the server

This release changes the default of `neokod serve`. In web mode the server now always requires an access token.

1. After `neokod upgrade`, the first start generates a token at `<base-dir>/access-token` (mode 0600). On the server that is `~/.neokod/access-token`. Read it with `cat`. Set `NEOKOD_ACCESS_TOKEN` (at least 32 characters) or `--access-token-file` to choose your own.
2. Open `https://neokod.mashdev.xyz` (or the Tailscale address). The page asks for the token once and remembers it. Authelia still sits in front. The token is a second factor, not a replacement.
3. `neokod project ...` sends the token to a running server automatically.
4. A non-loopback bind needs `--host` (or `NEOKOD_HOST`) and refuses to start without a token. A foreign web page can no longer read the snapshot or dispatch commands (checked: 401 without the token on the snapshot, the dispatch route, the trace route and the WebSocket).
5. Startup now refuses to run if the recorded migration names do not match the build (card 0.5). Released 3.x databases pass. A database from another branch (like the archived dev one) is refused with repair instructions.
6. The Node 22 runtime on the server is below the repo's supported range (`^24.13.1`). Move it to Node 24 before or with the upgrade.

## Verified vs unverified

- Verified (RUN) on the merged tree, Node 24.21.0: `vp check`, `vp lint`, `pnpm run typecheck`, server tests (2,268), web unit tests (1,568), shared (254), codex package (24). Every security card fails its new tests at the parent commit.
- Verified (RUN, browser): token prompt, wrong token message, right token loads the app, reload stays signed in, `#access-token=` removed from the URL, no CSP violations in the console, no request to Google favicon services.
- Verified (RUN, HTTP): 401 without a token on snapshot, dispatch (valid body), trace POST and WebSocket; token file mode 0600.
- Unverified: the Symphony runner against a real Codex and a real GitHub issue (only the fake Codex harness has run it); Authelia passing an `Authorization` header unchanged; Tailscale paths (`--host` on a tailnet address, `tailscale serve`) on the real server; card 2.2 and 2.3 and everything in 1D and 1E.
- The consumer-leak test for card 1.4 does not fail on the old code (recorded in `plan.md` 0.7).

## Known issues in this release (decide, then fix)

1. HTML preview regression. Card X-13 serves `.html` and `.htm` assets with `Content-Disposition: attachment`, so the desktop preview downloads them instead of rendering. Recommended fix: keep the no-script `sandbox` CSP and nosniff, drop `attachment` for html (keep it for svg), add a test, record in `plan.md` 0.6. One line in `apps/server/src/http.ts` `assetResponseHeaders`.
2. Two lint warnings: unused `const orchestrator` at `apps/server/src/symphony/Orchestrator/Layers/SymphonyOrchestratorLive.test.ts:1310`; inline `img` handler in `apps/web/src/components/ChatMarkdown.tsx` (~:1372) adds an eighth `no-unstable-nested-components`.
3. `accessToken.ts` uses `Effect.option` around the exclusive create, so the cause of a permission failure is lost. Use `Effect.exit` and pass it as `cause`.
4. `--public-host` is not split on commas (the env value is). `normalizePublicHost` silently drops an explicit default port. Warn when `--access-token-file` is group or world readable. Restore the trailing newline in `formatHeadlessServeOutput`. The A1 dispatch-bearer test passes at base: point it at the dispatch route.
5. No limit on bad bearer attempts and no entropy check beyond 32 characters. Fine for a generated token, weak for a short user-chosen one on a tailnet listener.
6. `--mode desktop` without a bootstrap token still runs unauthenticated (non-loopback is refused, loopback is not).
7. A test or dev run wrote `~/.neokod/access-token` on the Mac (8 Oct 18:06). Harmless, mode 0600. Find which test used the default base dir and make tests use `fs.makeTempDirectory`. Tests that use fixed temp names (`neokod-cli-loopback-env`, `neokod-cli-flags`) leave token files behind.

## Next

Work in this order. One card per commit, failing test first, gates after every card (`plan.md` 0.2, 0.3, 0.8). Muse implements, Claude reviews each branch (fail-first proof for security cards, run in a worktree, browser check for UI).

1. Fix the Known issues above (items 1 to 4 and 7 first).
2. Wave 1D data loss, in this order: X-1 FIFO read, X-2 file write containment (with U-01, U-02, U-02b), U-03 diff root, U-04 sensitive env var, S-01 and S-02 Symphony settings form, U-06, U-07, U-11, X-9 worktree deletion, X-10 merge conflict commit, X-11 git option injection.
3. Wave 1E providers and recovery: X-3 Claude usage limit, X-4 Copilot child death, X-5 OpenCode Stop, X-6 opencode serve password and orphan ledger, 2.2 rewind safety, 2.3 and X-7 crash recovery, X-14 terminal process groups.
4. Phase 1 exit criteria (`plan.md` 14.2): repeat the cross-origin probe (done once on the 1C branch), repeat FA-01 and FA-03 after X-1 and X-2, PV-06, PV-10 and PV-12 after 1E, then one Symphony task on a throwaway GitHub repository to a pull request, and the server upgrade above.
5. Phase 2 starts after that: board and UI cards (B-1 to B-10), chat to Symphony handoff (H-0 to H-6b), saved machines (B2, B2b, B3, B3b), X-15 and X-16.

### Cards still to write (from the T3 nightly review of 8 October)

Report: `t3-nightly-2026-10-08.md` (not in the repo; regenerate from T3 `main` if needed). T3 stable v0.0.46 has not shipped. V2 is the only orchestrator on T3 `main`.

New cards: `DrainableWorker` failure handling (one failed item kills the worker and `drain` hangs; our `packages/shared/src/DrainableWorker.ts` is the pre-fix code, T3 #16223); `BEGIN IMMEDIATE` and error-code classification in `NodeSqliteClient.ts` (T3 #15488); `GIT_OPTIONAL_LOCKS=0` and `diff-index` for read-only git (T3 #14718, our CP-13); snapshot decode outside the transaction (`ProjectionSnapshotQuery.ts` ~:945, T3 #17141); Claude model catalogue update (Claude 5.5 line, 1M context on 5-series); `neokod` branch-name collision for worktree threads (T3 #16167).

Changes to existing cards:

- X-3: copy T3's Claude usage-limit decision rule (`ClaudeAdapterV2.ts` ~:5733 to 5790 and ~:6642 to 6666), including the overage exception and reset time only when known.
- X-6: record process group, pid, start time, command and owner identity in the ledger (T3 `OpenCodeServerLedger.ts`).
- X-9: do not trust `git status` before removing a worktree (T3 #15834: `git worktree remove` deletes files when `status.showUntrackedFiles=no`).
- 2.2: gate new turns while a revert runs, and commit the rollback under the thread lock (T3 #17079).
- H-4 and 2.6a: delivery commands must never be rejected for transient state. Our `OrchestrationEngine.ts` ~:164 to 169 has the same trap T3 fixed (#15892, #16783). Completion notices queue behind the active run and are never delivered as a steer.
- W6 and H-6a: Stop cascades to delegates with ids derived from the Stop (T3 #16002). A held queued wake is not owed work (T3 #17028).
- B1, B2, B4: a machine has an ordered list of routes. Detect Tailscale by network interface, not by the 100.64.0.0/10 range alone (T3 #17158).
- B-9: do not ship a 30 second per-item pull request sweep. Use a host-level rate-limit pause and a one-point fingerprint check (T3 #16208, #16270). Keep Neokod PR #145 and add the pause.
- OpenCode 2 (`plan.md` W3): keep the version guard first, use T3's two-step probe (CLI version, then JSON-only `/api/info`), warn that OpenCode 2 rewrites the shared database on first run. T3's transport needs patched `@opencode/*` 2.0.23 packages on stable Effect 4.0.1, so decide after the `opencode acp` spike.
- Usage dashboard (`plan.md` section 12): start with a transcript scan with a per-file cache keyed by size and mtime, before U-1 to U-4. Use an offline price snapshot.

New design card to add after saved machines: send work to another machine. T3 has the picker for new threads. The agent-initiated version is open PR #16719 (`delegate_task` with `target.environmentId`, project matched by repository identity, retry key, remote task recorded on the parent, follower with backoff, re-follow at startup, access capped by the link). Relay is only a transport and is excluded. Reuse the chat to Symphony request and result link.

T3 pitfalls to avoid: persisting every provider chunk (a 17.8 GB database), synchronous SQLite stalls, a scope change that broke old clients, fetching a model manifest from T3's own `main` at runtime, T3's own file write follows symlinks (not a reference for X-2).

## Investigate later (not in Phase 1, not carded)

Ordered by how soon they are worth a look. IDs refer to `docs/research/audit2-*.md` and `plan.md` section 14.4.

Security and data safety

- FA-02 / CP-07: file RPC `cwd` is any directory, not a registered project. Fix by checking `cwd` against registered projects (Orca does this).
- FA-08: a file write alone becomes code execution through `.git/config` `core.fsmonitor` and a provider `binaryPath`. The token limits who can do it. A real fix needs `-c core.fsmonitor=false` on server-run git and validating `binaryPath`.
- FA-07: `shell.openInEditor` passes `cwd` as a CLI argument (option injection).
- PV-07: Claude and Copilot children get the full server environment, and Claude gets the MCP bearer token on its command line. Card X-6 only fixes OpenCode.
- FA-10: file modes (only `secrets/` is 0700), `posthogApiKey` and the OTLP URL echoed to clients, validation errors that echo input, projects registrable at `/` or `~`.
- TG-18: git children inherit `GIT_DIR`, `GIT_INDEX_FILE`, `GIT_WORK_TREE`.

Correctness and recovery

- TG-05 / CP-14: roll back a worktree and branch when bootstrap fails after creation.
- TG-14 / CP-15: checkpoint revert can fail halfway. Card 2.2 adds a recovery ref and refusal. Port T3's guards for empty checkpoints.
- TG-15: a diff over 10 MB fails the whole turn diff. Truncate instead.
- TG-17: push and pull have a fixed 30 s timeout. Make it progress-based.
- TG-20: stale `SHELL` gives a terminal that exits silently. Add a fallback shell chain.
- TG-08: branch toolbar goes stale after git runs in the terminal.
- CP-21: "auto-accept-edits" acts as approval-required for OpenCode, Copilot, Cursor and Grok.
- PV-14: Copilot model list silently falls back to "Auto". PV-15: stale "Pending Approval" in the sidebar after a stop.
- Threads shown "Working" while their machine is unreachable (T3 #4852).
- Symphony: project `paused` does not refuse a manual Run now. The reject reason is dropped. `draft` has no writer. `symphony_retry_queue` is unused. No timeouts on `initialize`, `thread/start`, `turn/start`. A leader that loses the lock should stop its runs. A user-input wait that times out answers with an empty string and should decline. Legacy `owner_pid` values from older builds could be signalled after pid reuse. Reconciler and Recovery still release terminal-attempt items to `queued`.

Product and performance

- F05 streaming Markdown: 74 ms per delta at about 15 KB (measured). Needs block-level memoisation.
- Terminal memory and CPU for very long lines (TG-02): re-measure after card 2.6c.
- Board stream resends 296 KB every 2 s at 1,000 cards (S-22). Snapshot throughput is 168 requests per second at 50 concurrent.
- Usage, model and cost dashboard (`plan.md` section 12).
- Dependency updates (`plan.md` W3). Electron 41.5.0 is out of support. `pnpm audit` shows 2 critical and 74 high (mostly dev or build). Effect 4.0.0 is a large migration.
- Node 26 becomes LTS on 2026-10-28. Move the server from Node 22.23.2 to Node 24.21.0.
- Tailscale HTTPS certificates are needed only for `tailscale serve`, not for a direct tailnet bind.
- Tauri 2 and GPUI or GPUIX native client: parked.
- Orphaned Symphony views are deleted only after B-6 and B-7 (card B-10, Phase 2).

Not tested at all

- Windows and Linux desktop, WSL, the Electron preview and updater.
- Cursor, Grok, Kiro. Codex on the test Mac (launcher shim fails). Claude beyond the usage-limit turn. OpenCode 2.
- A real GitHub pull request flow, and any real tracker end to end.
- Drag and drop attachments, rewind dialog wording, thread archive and search, keybinding edits, themes, full keyboard and accessibility pass, hidden-tab behaviour, memory after 50 thread switches.
- Observability, the MCP server, settings migrations, diagnostics screens.
