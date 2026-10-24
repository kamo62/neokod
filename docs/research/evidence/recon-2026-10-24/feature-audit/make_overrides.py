"""Write overrides/curated.json: hand-curated assessments layered over the rule-based ledger.

Evidence tokens used in evidenceExtra:
  body-read                 PR description read by the auditor (data only)
  patch-read                non-test, non-UI patch text read by the auditor
  upstream-source@27e0c684  final-state upstream file read at the latest nightly commit
  neokod-source@0ab699566   Neokod file read at the audited local HEAD (working tree may move)
Nothing here claims a reproduction, a live provider run, or a line-by-line review.
"""
import json, os, sys

out = os.path.join(sys.argv[1], 'curated.json')
B, P, U, N = 'body-read', 'patch-read', 'upstream-source@27e0c684', 'neokod-source@0ab699566'

o = {}


def add(n, **kw):
    o[str(n)] = kw


# ------------------------------------------------------------------ bounded ports (eligible)
add(19848, cluster='usage-limit-recovery', disposition='candidate-port-intent', neokodStatus='gap', priority='P1-correctness',
    neokodEvidence='apps/server/src/provider/Layers/ClaudeUsageLimit.ts failureKind() maps terminal_reason "blocking_limit" to usage_limit unconditionally (lines ~122-144).',
    evidenceExtra=[B, P, N], confidence='medium-high',
    note='Port intent: blocking_limit is a usage limit only with rate-limit evidence (api_error_status 429, rejected rate_limit_event, or assistant error rate_limit); otherwise provider_error naming a full context window with /compact or new-thread guidance. Targets: ClaudeUsageLimit.ts (failureKind + hint type), ClaudeAdapter.ts rate_limit_event plumbing (~L1109, L3104), tests ClaudeUsageLimit.test.ts and ClaudeAdapter.test.ts. Not reproduced live.')
add(17408, cluster='provider-claude', disposition='candidate-port-intent', neokodStatus='gap', priority='P1-security',
    neokodEvidence='apps/server/src/provider/Layers/ClaudeAdapter.ts ~L3799-3811 passes mcpServers.neokod.headers.Authorization = mcpSession.authorizationHeader (the raw bearer) in SDK options.',
    evidenceExtra=[B, P, N], confidence='medium',
    note='Upstream states the bearer was inline in --mcp-config, visible in process arguments. Whether the installed SDK 0.3.226 serialises mcpServers into argv was NOT verified here (no provider run allowed). Verify with a disposable session before changing. Fix variants: env placeholder (this PR) or Query.setMcpServers control request (#17898; present in sdk.d.ts:2627).')
add(17898, cluster='provider-claude', disposition='candidate-port-intent', neokodStatus='gap', priority='P1-security',
    neokodEvidence='Same Neokod site as #17408; SDK Query.setMcpServers exists at node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts:2627.',
    evidenceExtra=[B, P, N], confidence='medium',
    note='Preferred variant of #17408: send MCP servers over the control channel right after query(); also survives CLAUDE_CODE_SUBPROCESS_ENV_SCRUB and avoids env inheritance by child commands. 90 s control-request deadline semantics need a Neokod decision.')
add(15459, cluster='provider-detection-health-updates', disposition='candidate-port-intent', neokodStatus='gap', priority='P1-detection',
    neokodEvidence='apps/server/src/provider/Layers/ClaudeProvider.ts ~L1017-1039 returns status ready / auth authenticated whenever the capabilities probe resolves; no tokenSource "none" check (tokenSource only read at ~L811).',
    evidenceExtra=[B, P, N], confidence='medium',
    note='Matches plan 16.19 priority (provider detection truthfulness). Add apiKeySource to the probe result and a claudeAuthStatus() that disproves auth only for tokenSource "none" with no API key, email or subscription; third-party backends stay authenticated. Tests in ClaudeProvider.test.ts. Not reproduced live.')
add(23819, cluster='terminal-performance-correctness', disposition='candidate-port-intent', neokodStatus='planned', priority='P1-perf-planned',
    neokodEvidence='apps/server/src/terminal/Manager.ts ~L999-1111 concatenates pendingControlSequence + data and calls findStringTerminatorIndex from the OSC/DCS start each chunk (L1045, L1091).',
    evidenceExtra=[B, P, N], confidence='high',
    note='Already planned in plan.md 16.18 (merge 9f660d38...). Upstream patch adds pendingScanStart = max(0, pending.length - 1) and starts terminator scans there. Preserve BEL, C1 ST and split ESC-backslash; claim bounded rescanning only.')
add(23953, cluster='git-vcs-worktree', disposition='candidate-port-intent', neokodStatus='planned', priority='P1-perf-planned',
    neokodEvidence='apps/server/src/vcs/GitVcsDriverCore.ts ~L615-686 always appends decoded chunks to lineBuffer and scans for newlines even when onLine is undefined.',
    evidenceExtra=[B, P, N], confidence='high',
    note='Already planned in plan.md 16.18 (merge 9a638026...). Upstream gates line buffering/flush on onLine; Neokod structure differs (no separate lineDecoder), so port the intent, not the diff.')
add(13684, cluster='sqlite-persistence-startup', disposition='candidate-port-intent', neokodStatus='gap', priority='P2-hardening',
    neokodEvidence='apps/server/src/persistence/Layers/Sqlite.ts L36-38 sets WAL, foreign_keys, busy_timeout only; no journal_size_limit. No Sqlite.test.ts exists in persistence/Layers.',
    evidenceExtra=[B, P, N], confidence='medium-high',
    note='Add PRAGMA journal_size_limit (upstream 32 MiB) so the -wal file shrinks after large writes. Needs a new small test; check Node sqlite behaviour on the supported Node 24 line.')
add(18471, cluster='sqlite-persistence-startup', disposition='candidate-port-intent', neokodStatus='gap', priority='P2-hardening',
    neokodEvidence='Same Neokod file: no PRAGMA optimize at open.',
    evidenceExtra=[B, P, N], confidence='medium',
    note='Upstream runs PRAGMA optimize = 0x10012 after migrations. The 0x10000 flag needs SQLite >= 3.46; verify the SQLite version bundled with the supported Node before adopting or guard it.')
add(16544, cluster='provider-opencode', disposition='candidate-port-intent', neokodStatus='partial', priority='P2-detection',
    neokodEvidence='apps/server/src/provider/openCodeVersion.ts:21 OPENCODE_VERSION_PROBE_TIMEOUT = 5 s; Neokod already raised Claude (15 s) and Codex (25 s) with env overrides.',
    evidenceExtra=[B, N], confidence='high',
    note='Raise or make configurable like the Claude/Codex probes; update OpenCodeDriver.test.ts (~L331). Kiro/Grok version probes are 4 s (KiroProvider.ts:24, GrokProvider.ts:49) and are the same class of risk.')
add(17501, cluster='usage-limit-recovery', disposition='candidate-port-intent', neokodStatus='gap', priority='P2-contract',
    neokodEvidence='Neokod Codex errors are classed provider_error only (CodexAdapter.ts ~L1540-1547); RuntimeErrorClass has no usage_limit (packages/contracts/src/providerRuntime.ts:103-109); no Codex usage-limit detection found in apps/server/src.',
    evidenceExtra=[B, P, N], confidence='medium',
    note='Larger than the title suggests: needs a Codex usage-limit class (usageLimitExceeded, rateLimitExceeded, responseTooManyFailedAttempts with HTTP 429) and a contract/projection decision shared with the Usage plan U-2. Coordinator-owned contract change.')
add(19322, cluster='provider-session-lifecycle', disposition='candidate-port-intent', neokodStatus='gap', priority='P2-lifecycle',
    neokodEvidence='No spawnClaudeCodeProcess/process-group launcher found for Claude in apps/server/src (grep).',
    evidenceExtra=[B, N], confidence='medium',
    note='Upstream starts the Claude CLI as its own process-group leader and kills the group on exit so plugin MCP children do not leak. POSIX only. Relates to plan X-7 (restart/stop ownership). Needs a disposable-process fixture; no live process signalling was done in this audit.')
add(23389, cluster='provider-session-lifecycle', disposition='candidate-port-intent', neokodStatus='gap', priority='P2-lifecycle',
    neokodEvidence='Same absence as #19322; Neokod resumes sessions after restart (ClaudeAdapter resume path) so a surviving CLI could race a resumed one.',
    evidenceExtra=[B, N], confidence='low-medium',
    note='Upstream adds an sh launcher with a pipe-held watcher so the CLI group dies when the server dies; prevents two agents in one checkout after a hard stop. Security/process-management sensitive; gate behind plan 16.16 Phase 1E acceptance.')
add(12513, cluster='provider-session-lifecycle', disposition='candidate-port-intent', neokodStatus='not-assessed', priority='P2-lifecycle',
    neokodEvidence='apps/server/src/processRunner.ts has no forced-kill escalation match (grep forceKillAfter/SIGKILL returned nothing).',
    evidenceExtra=[B, N], confidence='low-medium',
    note='One-second forced-kill escalation for helper processes that ignore SIGTERM; verify against Neokod process helpers (process/ and packages/shared/src/processGroup.ts) before porting.')
add(19314, cluster='token-context-accounting', disposition='candidate-port-intent', neokodStatus='not-assessed', priority='P2-accuracy',
    neokodEvidence='Neokod steers a running turn (ClaudeAdapter.ts ~L3983-4026) and computes processed totals as max(result usage, last known) (~L2015-2023), not a sum of steer segments.',
    evidenceExtra=[B, P, N], confidence='low',
    note='Whether Neokod undercounts steered turns needs a fixture test; the max() rule may mask or mis-state it. Do not claim a bug.')
add(16394, cluster='token-context-accounting', neokodStatus='partial', priority='P3-coupled',
    neokodEvidence='Neokod drops usedTokens<=0 snapshots at ProviderRuntimeIngestion.ts:~215-222, which masks the zero-usage <synthetic> frame defect but also hides genuine resets/compaction.',
    evidenceExtra=[B, P, N], confidence='medium',
    note='If the zero filter is removed to preserve known zero (plan U-1), add the <synthetic> model guard at the same time.')
add(14672, cluster='usage-history-dashboard', neokodStatus='gap', evidenceExtra=[B], note='Claude transcripts record a <synthetic> placeholder model; a usage reader must skip it (also cached rows: usageScanCache.ts).')
add(16358, cluster='usage-limits-accounts', neokodStatus='not-applicable', evidenceExtra=[B, P, N], confidence='high',
    neokodEvidence='Neokod never calls the SDK usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET method (no get_usage call in apps/server/src).',
    note='Conditional lesson: if Neokod adopts the SDK get_usage control request, pass { skipBehaviors: true } (upstream: probe went from 5.4 s to 0.4 s with multi-GB transcripts) and treat the API as experimental.')
add(20537, cluster='provider-detection-health-updates', disposition='candidate-port-intent', neokodStatus='not-assessed', priority='P2-detection', evidenceExtra=[B, P],
    note='Bound Codex discovery by the remaining probe budget and keep a successful auth result when optional discovery times out. Compare with CodexProvider.ts probe budget (25 s, ~L59) before porting.')
add(19320, cluster='provider-detection-health-updates', disposition='candidate-port-intent', neokodStatus='not-assessed', priority='P2-detection', evidenceExtra=[B, P],
    note='Run instance-level Claude probes in the server state dir, not the inherited cwd ($HOME in packaged builds), because some wrappers refuse to run outside a project. Neokod ClaudeProvider.ts has an optional cwd parameter (~L762); the caller value was not traced.')
add(20360, cluster='provider-detection-health-updates', neokodStatus='not-assessed', priority='P3-detection', evidenceExtra=[B], note='Idea only: this PR was closed unmerged. Fall back to codex --version so an outdated CLI shows the compatibility advisory instead of a bare probe failure.')
add(7232, cluster='provider-detection-health-updates', neokodStatus='not-assessed', evidenceExtra=[B],
    note='Idea only (closed unmerged): a probe timeout should not be persisted as authoritative status. Neokod providerStatusCache.ts hydrates cached status/auth at boot; whether a timeout warning survives a restart was not traced.')

# ------------------------------------------------------------------ already equivalent in Neokod (verified by presence)
add(14461, neokodStatus='equivalent', neokodEvidence='packages/shared/src/processGroup.ts refuses pid <= 1 (lines ~616, ~1013).', evidenceExtra=[B, N], confidence='medium-high',
    note='Neokod already guards process-group signals for pid 0/1; equivalence judged from presence of the guard, not from the upstream diff.')
add(13879, neokodStatus='equivalent', neokodEvidence='apps/server/src/provider/OpenCodeServerLedger.ts exists (and its test).', evidenceExtra=[B, N], confidence='medium',
    note='Ledger-based reaping of orphaned opencode servers appears already present; not diffed against upstream.')
add(18819, neokodStatus='equivalent', neokodEvidence='apps/server/src/workspace/realPathContainment.ts and WorkspaceFileSystem.ts resolve realpath of the deepest existing ancestor.', evidenceExtra=[B, N], confidence='medium',
    note='PR text itself says upstream #20449 supplied the containment behaviour; Neokod has comparable real-path containment.')
add(20446, neokodStatus='partial', neokodEvidence='Secret-setting machinery appears in packages/contracts/src/settings.ts and apps/server/src/serverSettings.ts; OpenCode serverPassword handling not traced.', evidenceExtra=[B, P, N], confidence='low',
    note='Verify OpenCode serverPassword is secret-annotated and redacted in settings reads/logs.')

# ------------------------------------------------------------------ usage family: specific judgement beyond the group default
add(13118, disposition='reference-only-credential-endpoint', neokodStatus='excluded', evidenceExtra=[B],
    note='Reads the Claude OAuth token from <config>/.credentials.json and calls an undocumented usage endpoint. Not proposed for Neokod without an explicit owner decision on credential handling.')
add(10409, neokodStatus='gap', evidenceExtra=[B], note='Adds OpenCode SQLite/legacy JSON, Antigravity and Cursor account history. Cursor part reads CLI login (Keychain on macOS only after explicit opt-in per the PR text). Neokod supports Cursor and OpenCode but not Antigravity.')
add(15149, neokodStatus='gap', evidenceExtra=[B, P, U], confidence='high', note='Design reference for warm-scan cost: window-skip of cached files, quarter-hour day-format memo, bucket memo, cache writer memoised per entry, bounded stat concurrency. Patch read in full (non-test files).')
add(15101, neokodStatus='gap', evidenceExtra=[B], note='Codex service tier (default/priority/ultrafast) from thread_settings_applied; Ultrafast 6x / Fast 2x pricing; 30-day Codex total moved $1,408 -> $3,364 on the author machine (author-reported).')
add(13599, neokodStatus='gap', evidenceExtra=[B], note='Claude fast mode priced via LiteLLM provider_specific_entry.fast multiplier (2x for listed Opus models).')
add(21863, neokodStatus='gap', evidenceExtra=[B], note='Codex per-request counters must be reconciled against cumulative counters; naive request dedupe gave 265 instead of 240 in the PR fixture.')
add(22558, neokodStatus='gap', evidenceExtra=[B, P], note='Codex zero-component token_count after compaction is a context-size marker, not a request; a resumed process restarts cumulative counters (cumulative == last).')
add(23729, neokodStatus='gap', evidenceExtra=[B], note='Fork/subagent rollouts start with inherited cumulative totals; the first real request must not be dropped or double counted.')
add(17711, neokodStatus='gap', evidenceExtra=[B], note='Account identity must include workspace/org (Codex accountId; Claude organizationUuid); one email in two workspaces is two accounts.')
add(18723, neokodStatus='gap', evidenceExtra=[B], note='Never let an older probe overwrite a newer live reading; keep reset-credit metadata.')
add(15116, neokodStatus='gap', evidenceExtra=[B], note='A sparse streamed window must not clear a failed-probe marker.')
add(21055, neokodStatus='gap', evidenceExtra=[B, U], note='Price table is fetched from LiteLLM raw.githubusercontent.com with a GitHub API fallback, 24 h TTL and disk cache. In a local-first product this is outbound network access: needs an explicit opt-in, a bundled table, or user-entered prices.')
add(19446, neokodStatus='gap', evidenceExtra=[B], note='Cold scans of Antigravity/OpenCode SQLite on the main thread stalled the event loop and made clients show reconnecting; move to paged reads off the main thread.')
add(8730, note='Branch is contaminated (1,117 files, +399k/-125k); the title (MCP environment usage summary) is the only meaningful signal. Not shipped.')

json.dump(o, open(out, 'w'), indent=1)
print('overrides', len(o))
