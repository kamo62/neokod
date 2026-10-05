# Handoff

Updated: 2026-10-05 on MacBookPro

## State

- Branch: `docs/phase1-lock-and-audit-round-2` (cut from `main` at `a712441fb`, PR #147 merged, release 3.6.1 published).
- The canonical plan is `plan.md` (revision 8). Implementation specs are 82 cards in `docs/plan-cards/` (seven files). **Phase 1 is locked in `plan.md` section 14**: 55 cards in five waves (1A guards, 1B Symphony runner, 1C access and exposure, 1D data loss, 1E providers and recovery). Phase 2 is carded and deferred (section 14.3).
- No application code from the cards has been written yet. The only code changes so far are the seven commits merged in PR #147 (Symphony handler execution, settings form and Run now, clone destination fixes).
- Dev data: `~/.neokod/dev` was archived to `~/.neokod/dev.archived-2026-10-04` after a verified backup at `~/.neokod-backups/dev-2026-10-04`. A fresh `dev` is created on next run. Migration identity drift is the cause (card 0.5 guards it).
- The owner's server (`kamo@192.168.0.100`, `wv-htpc`, Tailscale 100.81.180.76) runs neokod 3.6.0 on Node 22, behind Cloudflare, Traefik and Authelia, with no Neokod token. Nothing there was changed. `neokod upgrade` would take 3.6.1.
- Dirty: nothing is left uncommitted by this session. Scratch work (test servers, Playwright scripts, a Node 24 copy) is under `/var/folders/b6/87d2msqd6fdbtcddcw5k8gbw0000gn/T/opencode` and is not preserved.

## Done

- Review of Neokod against 17 competitors and T3 nightlies, then two audit rounds (UI, Symphony, providers, file and project APIs, terminal, git). Evidence in `docs/research/`.
- Typecheck, lint, check and all tests pass on `main` on Node 24.21.0 (server 2,112, web 1,542, desktop 285 tests).
- `AGENTS.md` amended: user-controlled direct connections (Tailscale, LAN, saved servers with a token) are in scope. Hosted relay, cloud, hosted pairing and multi-user tenancy stay excluded.

## Verified vs unverified

- Verified (RUN): the Symphony runner at HEAD never executed its handlers (`Stream.map` into `runDrain`, fixed in PR #147); the default transport accepts cross-origin commands (probe in `plan.md` 1.4); file write follows symlinks and truncates; FIFO read freezes the server; thread delete removes a dirty worktree; commit during a merge conflict commits markers; `git checkout -f` via ref `-f`; Claude usage limit shows as Completed; killing the Copilot child or the server leaves threads running; `opencode serve` children survive `kill -9`; Markdown loads remote images.
- Unverified: every card's new tests and code snippets were never compiled or run. Several runner findings (N3, N4, N5, H2) are inferred from reading. Authelia's handling of a bearer header, the CSP against the real build, and card X-14 on Linux were not tested.

## Resume

1. Read `plan.md` sections 0, 14.
2. Start wave 1A. Branch from `main`, one card per commit, write the failing test first (section 0.2). Card 0.5 and H0 first.
3. Run the gates in section 0.3 after every card.
4. After 1A, run 1B and 1C in parallel.

## Investigate later (not in Phase 1, not carded)

Ordered by how soon they are worth a look. IDs refer to `docs/research/audit2-*.md` and `plan.md` section 14.4.

Security and data safety

- FA-02 / CP-07: file RPC `cwd` is any directory, not a registered project. Reads and writes of anything the server user can reach once reachable. Fix by checking `cwd` against registered projects (Orca does this).
- FA-08: a file write alone becomes code execution through `.git/config` `core.fsmonitor` and a provider `binaryPath`. The token (1C) limits who can do it. A real fix needs git config hardening (`-c core.fsmonitor=false` on server-run git) and validating `binaryPath`.
- FA-07: `shell.openInEditor` passes `cwd` as a CLI argument (option injection).
- PV-07: Claude and Copilot children get the full server environment, and Claude gets the MCP bearer token on its command line. Card X-6 only fixes OpenCode.
- FA-10: file modes (only `secrets/` is 0700), `posthogApiKey` and the OTLP URL echoed to clients, validation errors that echo input, providers that can be registered at `/` or `~`.
- TG-18: git children inherit `GIT_DIR`, `GIT_INDEX_FILE`, `GIT_WORK_TREE`.

Correctness and recovery

- CP-13: add `GIT_OPTIONAL_LOCKS=0` to read-only git calls and serialise mutating ones (status polling can take `index.lock`).
- TG-05 / CP-14: roll back a worktree and branch when bootstrap fails after creation.
- TG-14 / CP-15: checkpoint revert can fail halfway. Card 2.2 adds a recovery ref and refusal. Port T3's three guards for empty checkpoints.
- TG-15: a diff over 10 MB fails the whole turn diff. Truncate instead.
- TG-17: push and pull have a fixed 30 s timeout. Make it progress-based.
- TG-20: stale `SHELL` gives a terminal that exits silently. Add a fallback shell chain.
- TG-08: branch toolbar goes stale after git runs in the terminal. Refresh on terminal activity.
- CP-21: "auto-accept-edits" acts as approval-required for OpenCode, Copilot, Cursor and Grok. Add per-provider supported modes.
- PV-14: Copilot model list silently falls back to "Auto". PV-15: stale "Pending Approval" in the sidebar after a stop.
- Threads shown "Working" while their machine is unreachable (T3 #4852). Needs its own card with the saved-machines work.
- Symphony: project `paused` does not refuse a manual Run now. Request-changes reject reason is dropped. `draft` has no writer. `symphony_retry_queue` is unused. Timeouts on `initialize`, `thread/start`, `turn/start`. A leader that loses the lock should stop its runs. See Open questions at the end of each card file.

Product and performance

- F05 streaming Markdown: 74 ms per delta at about 15 KB (measured). Needs block-level memoisation, M to L.
- Terminal memory and CPU for very long lines (TG-02). Re-measure after card 2.6c.
- Board stream resends 296 KB every 2 s at 1,000 cards (S-22).
- Snapshot throughput on the server is 168 requests per second at 50 concurrent (one thread).
- Usage, model and cost dashboard (`plan.md` section 12, `docs/research/feature-verdicts-2026-10-04.md`).
- OpenCode 2: Neokod's adapter does not work with it. Guard first (version probe), then an `opencode acp` spike. Details in `plan.md` W3. DeepSeek and Muse tests did not cover v2.
- Dependency updates (`plan.md` W3, D1 to D8). Electron 41.5.0 is out of support, `pnpm audit` shows 2 critical and 74 high (mostly dev or build). Effect 4.0.0 clears the cooldown 2026-10-05 01:48Z and is a large migration.
- Node 26 becomes LTS on 2026-10-28. Move the server from Node 22.23.2 to Node 24.21.0 now.
- Tailscale HTTPS certificates (needed only for `tailscale serve`; not for a direct tailnet bind).
- Tauri 2 and GPUI or GPUIX native client: parked (`plan.md` sections 2 and 7).
- Orphaned Symphony views: deleted only after B-6 and B-7 (card B-10, Phase 2).

Not tested at all

- Windows and Linux desktop, WSL, the Electron preview and updater.
- Cursor, Grok, Kiro. Codex on the test Mac (its launcher shim fails). Claude beyond the usage-limit turn. OpenCode 2.
- A real GitHub pull request flow, and any real tracker end to end.
- Drag and drop attachments, rewind dialog wording, thread archive and search, keybinding edits, themes, full keyboard and accessibility pass, hidden-tab behaviour, memory after 50 thread switches.
- Observability, the MCP server, settings migrations, diagnostics screens.
