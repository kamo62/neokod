# FINDINGS (prefix TG-)

## TG-01 (P2, RUN, no data loss) Background and detached jobs survive terminal close and thread delete

Repro: scripts t2.mjs. terminal.attach (zsh), run `sleep 7771 &`, `nohup sleep 7772 &`, `(trap "" HUP; sleep 7773) &`, foreground `sleep 7774`, then terminal.close{deleteHistory:true} (what thread delete does).
Expected: processes started by the terminal are stopped, or the user is told. Actual: foreground sleep killed, the three background jobs reparented to PID 1 and kept running (ps shows ppid 1 after close). A `npm run dev &` keeps its port bound forever.
Cause: runKillEscalation sends SIGTERM then SIGKILL to the shell pid only, never to the process group or session. zsh does not HUP jobs when it is itself killed by a signal.
Code: apps/server/src/terminal/Manager.ts:1280-1328 (process.kill on the single pid), NodePtyAdapter.ts:61 (kill(signal) only).

## TG-02 (P2, RUN, no data loss) Terminal output with long lines pins the server CPU and grows memory without bound (extends known U-33/F06)

Repro: t3.mjs, t4.mjs. terminal.attach, then run `head -c 100000000 /dev/zero | tr "\0" a` (one 100 MB line) in zsh.
Expected: bounded memory, output keeps flowing at pipe speed, history bounded by bytes. Actual: server main thread at 100 to 140% CPU for over 10 minutes (the `head | tr` pipeline was still blocked on the pty when I closed the terminal), RSS 0.5 to 1.4 GB, only ~8 MB delivered in 150 s for the second 30 MB run. A 1.5M-line `yes | head` (82 MB) took ~55 s (~1.5 MB/s). Closing the terminal ended the load at once.
Cause: history is capped by line count only (capHistory, 5,000 lines) so one long line is retained whole; every output chunk does `${history}${chunk}` plus split("\n") over the whole history (quadratic), and the full history string is rewritten to disk every 40 ms debounce (20 MB file observed).
Code: apps/server/src/terminal/Manager.ts:855-865 (capHistory), :1655-1667 (drain), :1352-1380 (persist whole history).
Fix direction: cap by bytes as well, keep history as chunks, append-only persistence or rotate.

## TG-03 (P3, RUN) History file is written non-atomically and is observed empty mid-write

Evidence: during TG-02, `ls -la logs/terminals` showed terminal\_\*.log at 0 bytes then 19 to 20 MB alternately (23:06, 23:07). writeFileString truncates in place.
Impact: a server crash or kill during a write leaves an empty history for that terminal (replay after reload lost). No other data.
Code: apps/server/src/terminal/Manager.ts:1366-1375, :1458 (also read-time truncate at :1448 rewrites in place).

## TG-04 (P1 data loss, RUN) Deleting a thread force-removes its worktree with uncommitted and untracked work and never says so

Repro: new thread on project main1 with "New worktree" (u4.mjs), then edit tracked a.txt and add untracked newfile.txt inside base/worktrees/main1/neokod-e33bb2d4. Sidebar right-click > Delete (u5.mjs). Dialog 1: 'Delete thread "hello worktree"?'. Dialog 2 text, verbatim: "This thread is the only one linked to this worktree:\nneokod-e33bb2d4\n\nDelete the worktree too?". Accept.
Expected: dialog states the worktree has uncommitted changes (count) or the removal is refused without force. Actual: `git worktree remove --force` runs; directory gone, both changes lost, no stash, no toast. The dialog shows only the basename, not the full path, and does not mention the branch.
Also: the branch neokod/e33bb2d4 is left behind in the main repo (git branch -a still lists it) every time. Unused neokod/<hex> branches accumulate with each worktree thread.
Code: apps/web/src/hooks/useThreadActions.ts:~265-289 (confirm text), :362-368 (force: true), apps/server/src/vcs/GitVcsDriverCore.ts:2458-2470 (honours force blindly, no dirty check, no branch deletion).
Related: U-05 covers the shared-worktree case, this is the plain single-owner case. A status check (`git status --porcelain` in the worktree) before the confirm would fix it.

## TG-05 (P2, READ) Bootstrap failure after worktree creation leaves the worktree and branch behind

dispatchBootstrapTurnStart creates the worktree (ws.ts:1600) and then runs setup, meta update and the turn start. cleanupCreatedThread (ws.ts:1436-1451) only dispatches thread.delete; it never calls removeWorktree or deletes the new branch. Any failure after createWorktree (meta update, setup, turn dispatch) leaves an orphan neokod/<hex> branch and a directory under worktrees/ with no thread pointing at it. No data loss, but nothing in the UI can find or remove it.

## TG-06 (P2 data loss via RPC, P1 combined with known S06; RUN) switchRef passes the ref name to `git checkout` with no `--`, so refName "-f" discards all local changes

Repro: g1.mjs. Repo repos/inj with modified tracked files and a staged new file. RPC vcs.switchRef {cwd, refName:"-f"} returns Success {refName:"main"}. Afterwards `git status` is clean, a.txt and f.txt edits are gone and the staged wip.txt is deleted.
Cause: when neither refs/heads/-f nor refs/remotes/-f exists the fallback is `["checkout", input.refName]`, and git parses -f as an option. The contract only requires a trimmed non-empty string.
Code: apps/server/src/vcs/GitVcsDriverCore.ts:2677-2684 (all five checkout arg lists lack `--`; use `checkout <ref> --` or reject names starting with "-" via `git check-ref-format --branch`). Same missing validation in createRef (:2702 `["branch", refName]`), createWorktree (:2337-2338) and packages/contracts/src/git.ts:136-143,166-170.
The UI lists existing refs so the branch toolbar cannot send "-f" itself. Any other RPC client can, and the transport has no token (S06).

## TG-07 (P2, RUN) Git failures never carry git's stderr: push, pull, checkout, worktree and commit errors say only "exited with a non-zero status" / "git X failed"

Repro: g2.mjs, g3.mjs. Local bare origin, second clone pushes first, then commit_push from main1 via git.runStackedAction. action_failed.message is verbatim "Git command failed in GitVcsDriver.pushCurrentBranch.pushUpstream (<cwd>): Git command exited with a non-zero status." The rejected / non-fast-forward text (523 bytes of stderr) is dropped; only stderrLength is kept. Same for vcs.createWorktree ("git worktree add failed" for a path collision, an existing branch, a bad base ref, a unicode or dash name: all indistinguishable), vcs.createRef ("git branch create failed" for space, "..", "@{", ".lock", HEAD), vcs.switchRef ("git checkout failed" when local changes would be overwritten).
Expected: the reason (stderr tail) reaches the toast. Actual: user cannot tell non-fast-forward from auth failure from a hook failure (hook stderr does stream separately as hook_output, but only for hooks).
Code: apps/server/src/vcs/GitVcsDriverCore.ts:866-890 (executeGit builds GitCommandError with lengths only), packages/contracts/src/git.ts:323-338 (no stderr field). removeWorktree is the one place that does append stderr (:2484-2487), so the pattern exists.
No data loss.

## TG-08 (P2, RUN) Branch toolbar and git status are stale after git runs in the integrated terminal or outside Neokod

Repro: g6.mjs (RPC) and u7.mjs (browser). Subscribe to subscribeVcsStatus for main1. Edit a file, `git commit -a`, `git checkout -b x` from a shell. No localUpdated event arrives (observed 8 s, then 35 s; only a remoteUpdated at 30 s). In the browser I ran `git checkout -q -b from-term` in the thread's terminal drawer: the prompt shows (from-term) and 47 s later the toolbar still says "main" (screenshot shots/term3.png).
Expected: status follows the working tree (fs watch on .git/HEAD and index, or a refresh when terminal output settles after a command). Actual: refresh only on window focus/visibility (useGitActionsController.ts:357-392), after an agent turn (ProviderCommandReactor.ts:716), and after Neokod's own actions. The 30 s timer only refreshes the remote/upstream half.
Impact: Commit/Push buttons, branch label, ahead/behind and the dirty indicator can describe a different branch than the one that gets committed or pushed. No data loss by itself.
Code: apps/server/src/vcs/VcsStatusBroadcaster.ts:27,380-440 (poll is remote only), apps/web/src/components/gitActions/useGitActionsController.ts:357.

## TG-09 (P2, RUN) Pasting more than 64 KiB into the terminal is dropped and the error text prints the whole paste back into the terminal

Repro: u9.mjs. In the thread terminal run `cat > paste.out`, paste a 998,889 byte text (ClipboardEvent on .xterm-helper-textarea). The server contract caps terminal.write at 65,536 characters (packages/contracts/src/terminal.ts:57) and the client sends the paste as one write, so the RPC fails as a schema defect. paste.out is 0 bytes. The terminal shows "Expected a value with a length of at most 65536, got "pppp...<~1 MB of the pasted text>"" via writeSystemMessage, console shows `environment-data:terminal:write defected`. No toast.
Expected: client splits input into chunks of at most 64 KiB (order is preserved, I sent 3,000 concurrent one-char writes and they arrived in order, t6.mjs) or says "paste too large". Actual: paste silently lost, ~1 MB of scrollback junk.
Code: apps/web/src/components/ThreadTerminalDrawer.tsx:354-359 (writeTerminal sends data unchunked), :620-632 (onData), error text from the schema defect shown at :629. Server side: apps/server/src/ws.ts terminal.write handler uses the schema as defect, not a typed error.

## TG-10 (info, RUN) Terminal escape sequences checked and safe

OSC 52 clipboard write: clipboard unchanged (no clipboard addon). OSC 0 title: document.title unchanged. OSC 8 with javascript: and file: URIs: not linkified (xterm 6 ignores non-http(s) links without allowNonHttpProtocols), clicking did nothing; no dialog, no popup, no window.\_\_xss. NEOKOD\_\_ / T3CODE\_\_ / VITE\_\* / PORT env vars are stripped from the shell environment (NEOKOD_TEST_SECRET set on the server was absent). All other server env vars are inherited, including unrelated secrets that happen to be in the server's environment (CODEX_LB_API_KEY was visible in the shell). That is expected for a user shell.

## TG-11 (P3, RUN) A terminal that exits is closed at once, so its exit code and last output vanish

Repro: u11.mjs. Open a second terminal, run `echo second-terminal; exit 3`. The pane disappears within ~2 s; "Process exited" is written and then handleSessionExited calls onCloseTerminal (setTimeout 0). The server does report exitCode 3 (t1.mjs shows exited {exitCode:7}), but the UI never shows it. A shell or script that fails on startup (bad cwd command, project script that errors) leaves nothing to read. exitSignal also arrives as 0 for a normal exit instead of null (Manager.ts:1678-1680 uses Number.isInteger(0)).
Code: apps/web/src/components/ThreadTerminalDrawer.tsx:716-728 (close on exit), :1363,:1391 (onCloseTerminal), apps/server/src/terminal/Manager.ts:1676-1681.
No data loss beyond terminal scrollback of the exited process.

## TG-12 (info, RUN) Terminal behaviours that worked

Ctrl-C (\x03) interrupts `sleep 100` and the shell stays usable; concurrent single-character writes arrive in order (3,000 writes, t6.mjs); reload restores history (including wide CJK, emoji and combining characters) and live output continues after reload; browser resize storm (40 viewport sizes in 1.2 s) ended with stty size matching the final viewport (16x161); deleted cwd keeps the live shell and restart returns the typed TerminalCwdNotFoundError; multiple terminals per thread and split groups work; env override from a client (`env` on attach) wins over the filter (PORT and NEOKOD_X can be set explicitly, by design).

## TG-13 (P1 wrong result, RUN) The Commit action commits merge-conflict markers and finishes the merge; Neokod has no concept of merge or rebase in progress

Repro: g7.mjs. repos/conf: `git merge side` leaves c.txt unmerged (UU). RPC git.runStackedAction {action:"commit", commitMessage:"resolve"} returns action_finished "Committed 4b4cf38" (toast "Committed 4b4cf38, Push"). `git show 4b4cf38:c.txt` is the file with `<<<<<<< HEAD / ======= / >>>>>>> side` markers; the merge commit has two parents. With commit_push the markers go to the remote too.
Cause: prepareCommitContext runs `git add -A` (no filePaths) which marks conflicted paths resolved, then `git commit`. No check for unmerged entries, MERGE_HEAD, rebase-merge/rebase-apply or CHERRY_PICK_HEAD. Status returns workingTree files with no conflict flag (status of the conflicted repo: file c.txt insertions 4, refName main). During a rebase (repos/rebasing) status says refName null, isDefaultRef false, no "rebase in progress" field, so the toolbar looks like plain detached HEAD.
Expected: refuse (or warn) when the index has unmerged paths, and surface "merge/rebase in progress" in status. Actual: silent commit of markers. Does not lose existing data, but publishes broken code under a "resolve" message with no warning.
Code: apps/server/src/vcs/GitVcsDriverCore.ts:1600-1618 (prepareCommitContext), :1393-1440 (status parse, no unmerged `u` records handling), apps/server/src/git/GitManager.ts commit step.

## TG-14 (P2, READ) Checkpoint revert can fail half way with no visible outcome, and the order leaves files and conversation out of step

CheckpointReactor revert path (apps/server/src/orchestration/Layers/CheckpointReactor.ts:783-830): restoreCheckpoint (git restore, git clean, git reset, three separate commands in apps/server/src/vcs/GitVcsDriver.ts:868-902) runs first, then workspaceEntries.refresh, then providerService.rollbackConversation, then deleteCheckpointRefs, then thread.revert.complete. Only "missing ref / no session / not git" produce appendRevertFailureActivity. Any thrown error (index.lock present, unmerged path makes `git restore --staged` fail, a failed rollbackConversation) goes to processInputSafely which only logs a warning (:924-936). Effects: (a) git restore succeeds but clean or reset fails: workspace is partly restored; (b) files are restored but rollbackConversation fails: files reverted, conversation still contains the later turns, stale refs kept, no revert.complete and no activity for the user. The pre-revert state is not captured anywhere (S05 covers the shared-cwd case; this is the failure path).

## TG-15 (P2, READ) A diff over 10 MB makes the whole turn diff fail instead of truncating

diffCheckpoints calls `git diff` with maxOutputBytes 10,000,000 and no appendTruncationMarker (GitVcsDriver.ts:272,951), so collectOutput fails with "Git output exceeded 10000000 bytes and was truncated." (GitVcsDriverCore.ts:~627-634). One regenerated lockfile or vendored file in a turn removes the diff for every file in that turn. Binary files are fine (`Binary files differ`). Same non-truncating behaviour applies to every default 1 MB git call (status of a repo with very many changed files is the likely hit; I did not reach the limit with 5,000 untracked-by-count small files: status took 150 ms).

## TG-16 (P3, READ) Checkpoint capture hashes every non-ignored file into the object store on every turn

captureCheckpoint runs `git add -A -- .` on a temporary index (GitVcsDriver.ts:774-860) so a 200 MB untracked file or an un-ignored build directory is compressed and written as loose objects at the first capture and again whenever it changes, and the hidden checkpoint commits keep them reachable until the thread's refs are deleted. No size cap, no timeout beyond the 30 s default of execute (a 200 MB add took ~5 s here, committing big/ took 5.8 s). A crash mid-capture leaves .git/neokod-checkpoint-index-<uuid> copies of the index behind (cleanup is only in Effect.ensuring).

## TG-17 (P2, RUN for hooks, READ for network) Push and pull have a fixed 30 s limit regardless of progress

Repro: g9.mjs. repos/pushhook with a pre-push hook that sleeps 62 s. git.runStackedAction {action:"push"} fails after 30,220 ms with "Git command failed in GitVcsDriver.pushCurrentBranch.pushUpstream (...): Git command timed out." The git process, hook and sleep are killed cleanly (ps shows nothing left, no .lock file), so no orphan.
Problem: pushCurrentBranch uses runGit with no timeoutMs (default 30 s, GitVcsDriverCore.ts:40,1700-1795) and pull uses timeoutMs 30_000 (:1831-1834). A first push of a large repo or a slow link will be killed at 30 s while transferring, and the hook runs under the same budget. commit alone has 10 min (GitManager.ts:93). Fix: idle-based timeout (reset on stderr progress) or a long ceiling for push, pull and fetch.
Data: killing a push mid transfer is safe for the remote; local state is unchanged.

## TG-18 (P3, READ) Git child processes inherit the server's full environment including GIT_DIR, GIT_INDEX_FILE, GIT_WORK_TREE

GitVcsDriverCore.ts:~735 spawns `git` with `{...process.env, ...input.env, ...trace2Monitor.env}` and VcsProcess.ts:101-106 spreads hostEnvironment. Nothing removes GIT*DIR, GIT_WORK_TREE, GIT_INDEX_FILE, GIT_OBJECT_DIRECTORY, GIT_COMMON_DIR, GIT_NAMESPACE, GIT_CEILING_DIRECTORIES or GIT_CONFIG*\*. A server started from a git hook, `git rebase --exec`, husky or an npm script run by git would run every status, commit and checkpoint against the wrong repository (and checkpoint capture writes refs there). Not run (would need a second server). A scrub list in one place (executeRaw and VcsProcess) fixes it.

## TG-19 (P3, RUN) PR lookup failures are logged without cause and never reach the UI; non-GitHub remotes warn on every refresh

server.log from this run: 37 identical WARN lines "PR lookup failed; keeping last known PR state." with only operation, branch and errorTag SourceControlProviderError, for repos whose origin is a local bare path (about one per 30 s per subscribed repo plus bursts on every refresh). The cause (gh not authenticated, no provider for the remote, network) is dropped, so a logged-out gh looks the same as "no PR", and the toolbar silently keeps the last known PR badge forever (GitManager.ts:939-958 swallows via Effect.catch and resolveLastKnownPr). Expected: log error message at debug for "no provider for remote", surface auth failures (the Settings > Source control page has the auth state) in the status.
Also seen once: "Unhandled pty write error [Error: EBADF: bad file descriptor, write]" printed by node-pty to stdout when a write raced a shell that had just exited (server.log, around the terminal tests). Not fatal; the write path does not guard on the exited state (Manager.ts write -> process.write).

## TG-20 (P2, RUN) A stale or missing SHELL gives a terminal that exits immediately with no message and no fallback shell

Repro: restart the server with SHELL=/bin/doesnotexist, terminal.attach (t9.mjs). node-pty's posix spawn does not throw for a missing executable, so trySpawn reports success; the attach stream shows snapshot status "running", then 80 ms later `exited {exitCode:1, exitSignal:0}` and no output at all. terminal.restart gives the same. The retry chain in resolveShellCandidates/isRetryableShellSpawnError (Manager.ts:533-611) only triggers when spawn throws, so /bin/zsh or /bin/bash or sh are never tried. With TG-11 the UI then closes the pane, so the user sees a terminal flash and vanish. Expected: check the shell path (fs.access X_OK) before spawn, fall back to the next candidate, and show an error. Also a failing spawn helper (node-pty prebuild missing exec bit) is handled by chmod in NodePtyAdapter.ts:36-46 but errors are swallowed (orElseSucceed).

## TG-01 addendum (RUN)

Graceful server shutdown (SIGTERM to the server pid, t8.mjs) has the same effect: the foreground `sleep 8881` died, the background `sleep 8882 &` was reparented to PID 1 and kept running.

## TG-21 (P3, RUN and READ) Concurrent git actions on one repo are not serialised and fail with the opaque error

g11.mjs: two git.runStackedAction commits on the same repo (one with filePaths) while a pre-commit hook sleeps 3 s. One succeeds, the other fails with "Git command exited with a non-zero status" (git's index.lock). With filePaths the failed run had already executed `git reset` (errors swallowed with Effect.catchTags → Effect.void at GitVcsDriverCore.ts:1604-1608), which drops anything the user had staged, including partial hunks (`git add -p`), before it re-stages only the selected files. No per-repo lock exists in git/, vcs/ or checkpointing/ (only a trace-file mutex at GitVcsDriverCore.ts:522). Staging area is rewritten, working tree is untouched.

## Not tested

- GitActionsControl (Commit/Push/PR buttons) in the browser: the header control did not render for my thread on repos without a remote, so I drove git.runStackedAction by RPC instead. PR create/open flows read only.
- Real provider turns (provider turn start fails in this sandbox), so checkpoint capture, per-turn diffs and revert were READ only.
- Hanging hook cancel from the UI (no cancel RPC exists for git.runStackedAction; client disconnect does kill git), merge/rebase UI state, GIT\_\* env leakage (needs a second server), safe.directory/ownership errors, auth failures against a real remote, submodule checkpointing, CRLF and file mode diffs.
