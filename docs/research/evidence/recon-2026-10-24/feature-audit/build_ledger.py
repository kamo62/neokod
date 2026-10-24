"""Build the per-PR disposition ledger from pass1 + evidence + curated overrides.

Usage: build_ledger.py <census_dir> <work_dir> <overrides_dir> <out_dir>

Every census PR yields exactly one ledger row. Rules decide the default row; the
curated override files (hand-written after reading titles/bodies/files/diffs) can
only add or tighten evidence, never remove a PR.
"""
import csv, json, os, re, sys, collections

census, work, ovr_dir, out_dir = sys.argv[1:5]
pass1 = json.load(open(os.path.join(work, 'pass1.json')))
rawrows = {r['number']: r for r in json.load(open(os.path.join(census, 'all-closed-prs.json')))}
closure = json.load(open(os.path.join(work, 'unmerged-closure-evidence.json')))
latest = json.load(open(os.path.join(work, 'nightly-latest-ancestry.json')))
prev = json.load(open(os.path.join(work, 'nightly-prev-ancestry.json')))
latest_commit_oids = {c[0] for c in latest['commits']}
previous_commit_oids = {c[0] for c in prev['commits']}

overrides = {}
for fn in sorted(os.listdir(ovr_dir)):
    if fn.endswith('.json'):
        for k, v in json.load(open(os.path.join(ovr_dir, fn))).items():
            overrides.setdefault(int(k), {}).update(v)

# ---------------------------------------------------------------- clusters
# (id, label) in priority order; matcher defined in cluster_of().
CLUSTER_LABELS = {
    'usage-history-dashboard': 'Local provider usage history, cost and graphs (Usage page)',
    'usage-limits-accounts': 'Subscription/account limit windows, pooling and hubs',
    'usage-limit-recovery': 'Usage-limit failure handling, resets and auto-resume',
    'token-context-accounting': 'Token and context-window accounting correctness',
    'product-analytics-telemetry': 'T3 product analytics / hosted telemetry (not provider usage)',
    'web-react-compiler-sweep': 'Web React Compiler / memoisation sweep (UI)',
    'provider-detection-health-updates': 'Provider detection, health probes, auth status and CLI updates',
    'provider-session-lifecycle': 'Provider session lifecycle: stop, restart, orphan and process cleanup',
    'provider-claude': 'Claude adapter behaviour',
    'provider-codex': 'Codex adapter behaviour',
    'provider-cursor': 'Cursor adapter behaviour',
    'provider-grok': 'Grok adapter behaviour',
    'provider-opencode': 'OpenCode adapter behaviour',
    'provider-copilot': 'Copilot adapter behaviour',
    'provider-kiro': 'Kiro adapter behaviour',
    'provider-unsupported-in-neokod': 'Providers Neokod does not ship (Antigravity, Pi, Muse, Kimi, Kilo, ...)',
    'acp-runtime-registry': 'Generic ACP runtime and registry agents',
    'subagents-delegation-background': 'Subagents, delegation, lineage and background work',
    'queue-followup-steer': 'Queued messages, follow-ups and steering',
    'thread-settle-snooze-pr-watch': 'Thread settle/snooze and PR watching',
    'context-compaction-handoff': 'Compaction, prompt-cache and provider handoff',
    'terminal-performance-correctness': 'Terminal output, history and PTY behaviour',
    'git-vcs-worktree': 'Git, VCS status, worktrees and checkpoints',
    'sqlite-persistence-startup': 'SQLite, projections, shell snapshots and startup cost',
    'orchestration-event-performance': 'Orchestration/event/thread-list performance',
    'observability-diagnostics': 'Tracing, metrics, diagnostics',
    'source-control-hosts-pr': 'Source-control hosts and pull-request backends',
    'remote-direct-connection': 'SSH, Tailscale, LAN, WSL and direct connections',
    'auth-scopes-pairing': 'Auth scopes, pairing and RPC authorization',
    'mcp-t3-tools': 'T3 MCP tools and outside-agent access',
    'scheduled-tasks-automations': 'Scheduled tasks, automations and webhooks',
    'preview-browser-devices': 'Preview, agent browser, device and annotation surfaces',
    'desktop-shell-lifecycle': 'Desktop shell, updater, backend lifecycle',
    'models-catalog-effort': 'Model catalogue, effort and fast-mode metadata',
    'cloud-connect-relay': 'T3 Connect, relay, Clerk, hosted services',
    'mobile-apps': 'Mobile apps (iOS/Android/Duo)',
    'web-ui-surface': 'Web UI surfaces, themes, markdown and interaction polish',
    'internal-refactor-architecture': 'Internal refactors, package extraction, Effect conventions',
    'v2-orchestrator-rewrite': 'Orchestrator V2 rewrite internals',
    'build-ci-test-docs': 'Build, CI, release, tests, docs, dependencies',
    'repo-governance-noise': 'Governance, bots, reverts, fork syncs, accidental PRs',
    'third-party-fork-feature': 'Third-party fork features (factory/t3fac, civilization, ...)',
    'server-runtime-startup-http': 'Server startup, HTTP/RPC handler robustness and crash resistance',
    'service-install-update-cli': 'Background service install/update and CLI (triage, doctor, version)',
    'client-runtime-connection': 'Client-runtime connection, reconnect and handoff resilience',
    'settings-config-persistence': 'Settings/config persistence correctness',
    'workspace-files-editors': 'Workspace files, editors discovery, path handling and open-in',
    'projects-repository-identity': 'Project/repository identity, forks and grouping',
    'misc-unclustered': 'Unclustered; needs human triage',
}

R = re.compile


def has(s, *pats):
    return any(re.search(p, s) for p in pats)


def cluster_of(x):
    t = x['title'].lower()
    paths = ' '.join(x['paths']).lower()
    cat = x['category']
    # cheap non-product buckets first
    if has(t, r'react compiler', r'"use memo"', r'use memo', r'manual memoization'):
        return 'web-react-compiler-sweep'
    if cat in ('repo-governance', 'noise-or-fork-sync', 'revert', 'backport', 'bot-dependency-bump') and not has(t, r'usage'):
        return 'repo-governance-noise'
    if cat == 'third-party-fork-feature':
        return 'third-party-fork-feature'
    # usage family
    if has(t, r'analytics', r'telemetry', r'opt-out', r'install id', r'count which', r'product usage', r'anonymous usage', r'feature usage', r'usage data'):
        return 'product-analytics-telemetry'
    usage_path = has(paths, r'apps/server/src/usage/', r'components/usage/', r'shared/src/usage', r'contracts/src/usage', r'client-runtime/src/state/usage',
                     r'/usagelimits?', r'usagelimit', r'provider/drivers/\w*usage', r'provider-\w+/src/server/usage')
    if has(t, r'usage[- ]limit', r'out of tokens', r'rate limit', r'reset credit', r'auto[- ]resume', r'banked reset', r'limited threads', r'429 retry', r'budget'):
        if not has(t, r'hub|pooled|bars?\b|pace|popover'):
            return 'usage-limit-recovery'
    if has(t, r'\blimits?\b') and has(t, r'hub', r'pool', r'account', r'window', r'claude', r'codex', r'grok', r'cursor', r'opencode', r'antigravity', r'reset', r'quota', r'pace', r'bar', r'weekly', r'subscription', r'gemini', r'muse'):
        return 'usage-limits-accounts'
    if has(t, r'quota') or has(paths, r'usagelimits?\.ts', r'providerusagelimits', r'usagelimitsources'):
        return 'usage-limits-accounts'
    if has(t, r'\busage\b', r'\bpric(e|ing)\b', r'\bcost\b') and (usage_path or has(t, r'usage', r'pricing')):
        if not has(t, r'usage[- ]limit'):
            return 'usage-history-dashboard'
    if usage_path and x['changed_files'] <= 60 and not has(t, r'react compiler'):
        return 'usage-history-dashboard'
    if has(t, r'context (meter|window|usage|occupancy|strip)', r'token usage', r'undercount', r'thinking-token', r'context handoff budget', r'context chip', r'token count'):
        return 'token-context-accounting'
    # providers not shipped
    if has(t, r'antigravity', r'\bpi\b', r'\bmuse\b', r'kimi', r'\bkilo\b', r'\bdsh\b', r'chatgpt web', r'prime agent', r'fx provider', r'droid', r'cline', r'mythos'):
        return 'provider-unsupported-in-neokod'
    if has(t, r'acp[- ]registry', r'registry agent', r'\bacp\b'):
        return 'acp-runtime-registry'
    # supported providers
    for prov, cid in (('claude', 'provider-claude'), ('codex', 'provider-codex'), ('cursor', 'provider-cursor'), ('grok', 'provider-grok'),
                      ('opencode', 'provider-opencode'), ('copilot', 'provider-copilot'), ('kiro', 'provider-kiro')):
        if re.search(r'\b' + prov, t) and not has(t, r'subagent|delegat') and cat not in ('mobile-excluded', 'ui-excluded'):
            if has(t, r'update|version|detect|health|probe|auth|signed|logged|install|unavailable|timeout|discover|catalog|binary|path'):
                return 'provider-detection-health-updates'
            return cid
    if has(t, r'provider (update|detect|status|health)', r'update (everything|providers)', r'cli update', r'health (check|interval)', r'probe', r'unavailable', r'\bmise\b', r'login shell|shell environment'):
        return 'provider-detection-health-updates'
    if has(t, r'\bstop\b', r'orphan', r'process group|process-group', r'outlive', r'left behind', r'restart', r'shutdown', r'sigterm', r'kill') and cat in ('backend-candidate', 'desktop-shell'):
        return 'provider-session-lifecycle'
    if has(t, r'subagent', r'delegat', r'lineage', r'native child', r'workflow (member|thread)', r'background (work|agent|wake|task|command)', r'\bwakes?\b', r'supervisor'):
        return 'subagents-delegation-background'
    if has(t, r'queue', r'queued', r'follow-up', r'steer'):
        return 'queue-followup-steer'
    if has(t, r'\bsettle', r'snooze', r'pull request watch', r'pr watch', r'watch(es|ing)? (a )?(pr|pull)'):
        return 'thread-settle-snooze-pr-watch'
    if has(t, r'compact', r'prompt cache', r'handoff', r'hand off'):
        return 'context-compaction-handoff'
    if has(t, r'terminal', r'\bpty\b', r'shell history', r'\bosc\b', r'scrollback', r'clipboard sequence'):
        return 'terminal-performance-correctness'
    if has(t, r'sqlite', r'\bwal\b', r'database', r'\bdb\b', r'migration', r'projection', r'shell snapshot', r'checkpoint(s)? (no longer|durable)', r'planner'):
        return 'sqlite-persistence-startup'
    if has(t, r'\bgit\b', r'worktree', r'checkpoint', r'\bbranch', r'\bfetch\b', r'\bclone\b', r'\brebase', r'status (poll|refresh)', r'diff'):
        return 'git-vcs-worktree'
    if has(t, r'pull request', r'\bpr\b', r'prs\b', r'merge request', r'gitlab', r'bitbucket', r'forgejo', r'azure', r'gitcafe', r'github', r'source control', r'source-control', r'review guide'):
        return 'source-control-hosts-pr'
    if has(t, r'\bssh\b', r'tailscale', r'\blan\b', r'direct connection', r'endpoint', r'pairing', r'\bwsl\b', r'saved (connection|server)', r'network interface'):
        return 'remote-direct-connection'
    if has(t, r'\bauth\b', r'scope', r'permission', r'pairing'):
        return 'auth-scopes-pairing'
    if has(t, r'\bmcp\b', r't3_thread', r'thread tools', r'outside agents'):
        return 'mcp-t3-tools'
    if has(t, r'schedul', r'automation', r'webhook'):
        return 'scheduled-tasks-automations'
    if has(t, r'preview', r'browser', r'device', r'simulator', r'screenshot', r'snapshot', r'annotat', r'html render', r'visual repl'):
        return 'preview-browser-devices'
    if has(t, r'telemetry', r'otel', r'otlp', r'observab', r'trace', r'span', r'metrics', r'heap', r'diagnostic'):
        return 'observability-diagnostics'
    if has(t, r'model', r'effort', r'fast mode', r'ultrafast', r'1m context'):
        return 'models-catalog-effort'
    if has(t, r'orchestration', r'event loop', r'shell (read|update|snapshot)', r'thread list'):
        return 'orchestration-event-performance'
    if has(t, r'\bcli\b', r'triage', r'doctor', r'boot service', r'launchd', r'systemd', r'service (install|start|runtime|update)', r'runtime pruning', r'update download', r'server update', r'reject accidental'):
        return 'service-install-update-cli'
    if has(t, r'reconnect', r'connection', r'handoff', r'heartbeat', r'frozen host', r'incompatible host', r'subscription', r'socket', r'route') and x['top_bucket'] in ('client-runtime', 'shared', 'server'):
        return 'client-runtime-connection'
    if has(t, r'settings', r'config', r'writing style', r'settings\.json', r'provider settings'):
        return 'settings-config-persistence'
    if has(t, r'editor', r'file manager', r'reveal', r'workspace (index|path)', r'symlink', r'file link', r'jetbrains', r'vs code', r'file explorer', r'open in', r'static files', r'path'):
        return 'workspace-files-editors'
    if has(t, r'repository', r'repo\b', r'project group', r'\bfork', r'bare ', r'remote', r'project icon', r'project'):
        return 'projects-repository-identity'
    if has(t, r'startup', r'http', r'crash', r'serve', r'\bport\b', r'handler', r'rpc', r'hang'):
        return 'server-runtime-startup-http'
    return ''


def fallback_cluster(x):
    cat = x['category']
    t = x['title'].lower()
    if cat == 'mobile-excluded':
        return 'mobile-apps'
    if cat == 'cloud-connect-relay-excluded':
        return 'cloud-connect-relay'
    if cat == 'marketing-brand-excluded':
        return 'web-ui-surface'
    if cat in ('ui-excluded',):
        return 'web-ui-surface'
    if cat in ('ci-release-build-tooling', 'test-maintenance', 'docs-only'):
        return 'build-ci-test-docs'
    if cat == 'internal-refactor':
        return 'internal-refactor-architecture'
    if cat == 'desktop-shell':
        return 'desktop-shell-lifecycle'
    if x['top_bucket'] == 'server' and has(' '.join(x['paths']).lower(), r'orchestration-v2'):
        return 'v2-orchestrator-rewrite'
    return 'misc-unclustered'


# ---------------------------------------------------------------- link extraction
REF_RE = {
    'closes': R(r'(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\s+(?:https://github\.com/pingdotgg/t3code/(?:issues|pull)/|#)(\d{3,6})', re.I),
    'supersedes': R(r'(?:supersede[sd]?|replace[sd]?|take[s]? over|takeover of|duplicate of|dup of)\s+(?:#|https://github\.com/pingdotgg/t3code/pull/)(\d{3,6})', re.I),
    'reverts': R(r'revert[s]?\s+(?:"[^"]*"\s*)?\(?#(\d{3,6})', re.I),
}
TITLE_REVERT_RE = R(r'#(\d{3,6})')
all_numbers = set(rawrows)


def refs_for(x):
    body = rawrows[x['number']].get('body') or ''
    out = {k: sorted({int(m) for m in rx.findall(body)} - {x['number']}) for k, rx in REF_RE.items()}
    if x['category'] == 'revert':
        out['reverts'] = sorted(set(out['reverts']) | {int(m) for m in TITLE_REVERT_RE.findall(x['title'])} - {x['number']})
    return out


recs = {x['number']: x for x in pass1}
for x in recs.values():
    x['refs'] = refs_for(x)
    c = cluster_of(x)
    x['cluster'] = c or fallback_cluster(x)

# duplicate groups by normalised title (exact), plus explicit supersede refs
norm = collections.defaultdict(list)
for x in recs.values():
    key = re.sub(r'\s+', ' ', re.sub(r'\(#\d+\)|#\d+', '', x['title'].lower())).strip()
    if len(key) > 18:
        norm[key].append(x['number'])
dup_group = {}
for key, nums in norm.items():
    if len(nums) > 1:
        for n in nums:
            dup_group[n] = sorted(m for m in nums if m != n)

reverted_by = collections.defaultdict(list)
for x in recs.values():
    for tgt in x['refs'].get('reverts', []):
        reverted_by[tgt].append(x['number'])

# ---------------------------------------------------------------- closure class
CLOSE_PATTERNS = [
    ('obsolete-orchestrator-v2-rewrite', R(r'orchestrator v2 rewrite|merged the orchestrator', re.I)),
    ('contribution-policy-verification', R(r'closing (for|under) (missing|incomplete|the)|verification policy|prior approval|prior-approval|one-problem|missing (ui )?verification|missing (prior )?approval', re.I)),
    ('stale-cleanup', R(r'we are cleaning|cleaning up|stale', re.I)),
    ('superseded', R(r'superseded by|closing as superseded|replaced by', re.I)),
    ('maintainer-declined', R(r"we're closing this|not a fit|won't merge|out of scope|not planned", re.I)),
]


def closure_class(x):
    ev = closure.get(str(x['number']))
    if ev is None or 'error' in ev:
        return 'unknown', ''
    author = x['author']
    comments = [c for c in ev['lastComments'] if c['a'] != author and c['a'] not in ('coderabbitai', 'macroscopeapp', 'github-actions')]
    for c in reversed(comments):
        for cid, rx in CLOSE_PATTERNS:
            if rx.search(c['x']):
                return cid, c['x'][:160].replace('\n', ' ')
    closed_by = (ev.get('closedBy') or [None])[0]
    if closed_by == author:
        return 'author-closed', ''
    if ev.get('closer'):
        return 'closed-by-reference', json.dumps(ev['closer'][-1])
    if comments:
        return 'maintainer-comment-unclassified', comments[-1]['x'][:160].replace('\n', ' ')
    return 'closed-without-explanation', ''


# ---------------------------------------------------------------- dispositions
EXCLUDE_BY_CATEGORY = {
    'ui-excluded': ('excluded-policy-ui', 'Web UI surface; Neokod owns its own UI.'),
    'mobile-excluded': ('excluded-policy-mobile', 'Mobile surface; Neokod has no mobile app.'),
    'cloud-connect-relay-excluded': ('excluded-policy-cloud-connect', 'T3 Connect/relay/Clerk/webhook-relay dependency; carved out of Neokod.'),
    'marketing-brand-excluded': ('excluded-policy-marketing-brand', 'Marketing/brand surface.'),
    'ci-release-build-tooling': ('excluded-noise-build-ci-deps', 'Build/CI/release/dependency tooling; no product behaviour to port.'),
    'test-maintenance': ('excluded-noise-test-only', 'Test-only change; no product behaviour.'),
    'docs-only': ('excluded-noise-docs', 'Documentation only.'),
    'repo-governance': ('excluded-noise-governance', 'Contributor governance list.'),
    'bot-dependency-bump': ('excluded-noise-bot', 'Bot dependency bump.'),
    'revert': ('excluded-noise-revert', 'Revert; used to mark reverted changes.'),
    'noise-or-fork-sync': ('excluded-noise-sync-accidental', 'Fork sync or accidental PR.'),
    'backport': ('excluded-noise-backport', 'Backport to release branch; the original change is classified separately.'),
    'takeover-campaign': None,  # classified by content
    'third-party-fork-feature': ('excluded-third-party-fork', 'Contributor fork feature, not upstream product direction.'),
}

PORTABLE_CLUSTERS_HIGH = {
    'usage-history-dashboard', 'usage-limits-accounts', 'usage-limit-recovery', 'token-context-accounting',
    'provider-detection-health-updates', 'provider-session-lifecycle', 'terminal-performance-correctness',
    'sqlite-persistence-startup', 'git-vcs-worktree', 'remote-direct-connection',
    'provider-claude', 'provider-codex', 'provider-cursor', 'provider-grok', 'provider-opencode', 'provider-copilot', 'provider-kiro',
    'acp-runtime-registry', 'models-catalog-effort', 'client-runtime-connection', 'server-runtime-startup-http',
}
FEATURE_GAP_CLUSTERS = {'usage-history-dashboard', 'usage-limits-accounts', 'queue-followup-steer', 'thread-settle-snooze-pr-watch',
                        'scheduled-tasks-automations', 'subagents-delegation-background', 'context-compaction-handoff'}
V2_INTERNAL_CLUSTERS = {'subagents-delegation-background', 'queue-followup-steer', 'thread-settle-snooze-pr-watch',
                        'context-compaction-handoff', 'orchestration-event-performance', 'v2-orchestrator-rewrite', 'misc-unclustered'}

# Cluster-level Neokod status, verified against the local tree for this audit
# (see report). Row-level override wins.
CLUSTER_STATUS = {
    'usage-history-dashboard': ('gap', 'No apps/server/src/usage, no Usage route in apps/web; only context meter and Copilot quota snapshot exist.'),
    'usage-limits-accounts': ('partial', 'ServerProviderUsage (Copilot) is produced but unconsumed by web; Claude/Codex account.rate-limits.updated events are produced but not projected.'),
    'usage-limit-recovery': ('partial', 'ClaudeUsageLimit.ts and ServerProviderLimit banner exist; no auto-resume/reset-credit flow.'),
    'token-context-accounting': ('partial', 'Context meter exists; thread.token-usage.updated with usedTokens<=0 is dropped (ProviderRuntimeIngestion.ts:218).'),
    'product-analytics-telemetry': ('excluded', 'Hosted T3 telemetry; Neokod has its own AnalyticsService/settings.'),
    'provider-unsupported-in-neokod': ('not-applicable', 'Neokod ships Claude, Codex, Copilot, Cursor, Grok, Kiro, OpenCode only.'),
    'subagents-delegation-background': ('planned-gated', 'App-managed delegation is W6-C1..C6, gated behind formal core exit (plan.md 16.16-16.18).'),
    'queue-followup-steer': ('gap', 'Follow-ups are drained client-side (plan 16.x); server-owned durable queue not present.'),
    'thread-settle-snooze-pr-watch': ('gap', 'No ordinary-thread settle/snooze/PR-watch; Symphony has its own lifecycle.'),
    'context-compaction-handoff': ('partial', 'No idle compaction; handoff exists only inside Symphony HandoffService.'),
    'scheduled-tasks-automations': ('gap', 'No scheduled-task service in apps/server/src.'),
    'terminal-performance-correctness': ('partial', 'Terminal Manager exists; scan-offset and history batching ports not yet applied.'),
    'git-vcs-worktree': ('partial', 'GitVcsDriverCore exists; specific upstream fixes need per-PR verification.'),
    'sqlite-persistence-startup': ('partial', 'WAL+busy_timeout only (Layers/Sqlite.ts:36-38); upstream hardening not present.'),
    'remote-direct-connection': ('partial', 'Owner exception allows token-gated non-loopback listeners; no SSH package; Tailscale per self-hosting guide.'),
    'mcp-t3-tools': ('partial', 'apps/server/src/mcp has preview-automation toolkit only; thread/project tools are W6.'),
    'source-control-hosts-pr': ('partial', 'apps/server/src/sourceControl exists (CLI based); upstream moved GitHub to API transport.'),
    'auth-scopes-pairing': ('excluded', 'Hosted pairing/scoped-auth control plane is excluded; Neokod uses a single access token.'),
    'cloud-connect-relay': ('excluded', 'T3 Connect/relay excluded by policy.'),
    'server-runtime-startup-http': ('not-assessed', 'Generic server robustness; per-PR equivalence not verified.'),
    'service-install-update-cli': ('partial', 'Neokod ships a `neokod` CLI and serve/start; T3 service/doctor/triage tooling is not mirrored.'),
    'client-runtime-connection': ('partial', 'packages/client-runtime exists; reconnect/backoff behaviour not individually compared.'),
    'settings-config-persistence': ('not-assessed', 'serverSettings.ts exists; per-PR equivalence not verified.'),
    'workspace-files-editors': ('not-assessed', 'Neokod has workspace/project modules; per-PR equivalence not verified.'),
    'projects-repository-identity': ('not-assessed', 'Neokod has project/ and vcs/WorkspaceIdentity.ts; per-PR equivalence not verified.'),
    'mobile-apps': ('excluded', 'No mobile app in Neokod.'),
    'web-ui-surface': ('excluded', 'UI is Neokod-owned.'),
    'web-react-compiler-sweep': ('excluded', 'UI toolchain change; Neokod web build owned separately.'),
    'v2-orchestrator-rewrite': ('not-applicable', 'Neokod retains V1-style orchestration; V2 internals do not map.'),
    'internal-refactor-architecture': ('not-applicable', 'Upstream package extraction; Neokod keeps apps/server layout.'),
}


def disposition_for(x, cluster, closure_cls):
    cat = x['category']
    ex = EXCLUDE_BY_CATEGORY.get(cat, 'x')
    if ex is not None and ex != 'x':
        return ex
    # takeover and backend/desktop candidates by cluster
    if cluster == 'provider-unsupported-in-neokod':
        return ('reference-only-unsupported-provider', 'Provider is not part of Neokod; keep as reference for generic ideas only.')
    if cluster in V2_INTERNAL_CLUSTERS and has(' '.join(x['paths']).lower(), r'orchestration-v2/'):
        return ('reference-only-upstream-v2', 'Touches upstream orchestration-v2 which Neokod does not have; extract the behavioural intent only.')
    if cluster in ('product-analytics-telemetry',):
        return ('excluded-policy-hosted-telemetry', 'Hosted T3 telemetry/analytics; not provider usage.')
    if cluster in ('mobile-apps', 'cloud-connect-relay', 'web-ui-surface', 'web-react-compiler-sweep'):
        return EXCLUDE_BY_CATEGORY.get('ui-excluded')
    if cat == 'internal-refactor':
        return ('reference-only-internal-refactor', 'Internal refactor; no behaviour to port.')
    if cat == 'desktop-shell':
        return ('desktop-shell-review', 'Desktop shell change; port only if Neokod shows the same defect.')
    if cat == 'backend-candidate' and cluster in FEATURE_GAP_CLUSTERS:
        return ('feature-gap-proposal', 'New capability absent from Neokod; needs owner authorisation and a Neokod-owned UI/contract design. Not a bounded port.')
    if cluster in PORTABLE_CLUSTERS_HIGH:
        return ('candidate-port-intent', 'Eligible backend/provider/perf area; re-apply intent against Neokod code after target verification.')
    if cat == 'backend-candidate':
        return ('backend-backlog-unassessed', 'Backend change not individually assessed against Neokod; retained for owner triage.')
    return ('needs-human-triage', 'No rule produced a confident disposition.')


rows = []
for n in sorted(recs):
    x = recs[n]
    ov = overrides.get(n, {})
    cluster = ov.get('cluster', x['cluster'])
    cls, hint = ('n/a', '')
    if not x['merged']:
        cls, hint = closure_class(x)
    category = ov.get('category', x['category'])
    category_reason = ov.get('categoryReason', x.get('category_reason', ''))
    disp, reason = disposition_for({**x, 'category': category}, cluster, cls)
    if 'disposition' in ov:
        disp = ov['disposition']
    if 'reason' in ov:
        reason = ov['reason']
    if disp == 'excluded-policy-ui' and cluster in ('usage-history-dashboard', 'usage-limits-accounts', 'usage-limit-recovery', 'token-context-accounting', 'queue-followup-steer', 'thread-settle-snooze-pr-watch', 'context-compaction-handoff', 'subagents-delegation-background'):
        reason += ' Behavioural intent is recorded in the report cluster section for a Neokod-owned UI.'
    if x['status'] == 'closed-unmerged':
        reason = f'UNMERGED (this PR was not merged; closure class: {cls}). Equivalent intent may exist elsewhere and was not inferred from this status. ' + reason
    rb = reverted_by.get(n, [])
    if rb:
        reason += f' Later reverted by #{", #".join(map(str, rb))}.'
    st, st_note = CLUSTER_STATUS.get(cluster, ('not-assessed', 'Not individually assessed against Neokod.'))
    if disp.startswith('excluded') or disp.startswith('reference-only-internal'):
        st = 'excluded' if disp.startswith('excluded') else 'not-applicable'
    st = ov.get('neokodStatus', st)
    st_note = ov.get('neokodEvidence', st_note)
    # Positive merge-commit reachability is meaningful regardless of base branch.
    # The retained history is date-bounded; a missing commit is not proof of exclusion.
    if x['status'] == 'closed-unmerged':
        nl, npv = 'not-applicable-unmerged', 'not-applicable-unmerged'
    else:
        nl = ('reachable-in-date-bounded-inspected-history' if x['merge_oid'] in latest_commit_oids
              else 'not-observed-in-date-bounded-inspected-history')
        npv = ('reachable-in-date-bounded-inspected-history' if x['merge_oid'] in previous_commit_oids
               else 'not-observed-in-date-bounded-inspected-history')
    if x['files_unavailable']:
        source_layer = 'unknown (file listing unavailable)'
        source_layer_assessment = 'unknown-unavailable'
        source_coverage_note = 'No usable changed-file list or changed-file/addition/deletion metrics were captured for this PR. File counts and patch size are unavailable, not zero; source paths and diff are unavailable. Classification is limited to title/body metadata and any separately recorded evidence.'
        file_evidence = 'files-unavailable'
    elif x['truncated']:
        source_layer = 'mixed/unknown (file list truncated)'
        source_layer_assessment = 'mixed-or-unknown'
        source_coverage_note = f"GitHub supplied only the first {len(x['paths'])} of {x['changed_files']} changed-file paths. The sampled layer is a hint only; overall source mix and omitted file contents are unknown. Classification must not use the sample as a complete-tree majority."
        file_evidence = 'files-first100-truncated'
    else:
        source_layer = x['top_bucket']
        source_layer_assessment = 'complete-file-list'
        source_coverage_note = f"Complete changed-file list captured ({len(x['paths'])} paths). This is path coverage, not a full diff-line review unless patch-read is separately recorded."
        file_evidence = 'files-complete'
    depth = ['title-read', 'metadata', file_evidence, 'body-keyword-scan'] + ov.get('evidenceExtra', [])
    audit_note = ov.get('note', '')
    if x['truncated'] or x['files_unavailable']:
        audit_note = (source_coverage_note + (' ' + audit_note if audit_note else '')).strip()
    row = dict(
        number=n, url=x['url'], title=x['title'], author=x['author'], authorIsBot=x['author_type'] == 'Bot',
        createdAt=x['created'], closedAt=x['closed'], mergedAt=x['merged_at'] or '',
        mergedStatus=x['status'], mergedDirectlyToMain=(x['status'] == 'merged-main'), baseRef=x['base'], headRef=x['head'], mergeCommit=x['merge_oid'] or '',
        changedFiles=None if x['files_unavailable'] else x['changed_files'],
        additions=None if x['files_unavailable'] else x['additions'],
        deletions=None if x['files_unavailable'] else x['deletions'],
        fileMetricsAvailability='unavailable' if x['files_unavailable'] else 'reported', filesTruncated=x['truncated'],
        topSourceLayer=source_layer, sampledTopSourceLayer=x['top_bucket'], sourceLayerAssessment=source_layer_assessment,
        sourceCoverageNote=source_coverage_note, sampledFileCount=len(x['paths']), category=category, categoryReason=category_reason, featureCluster=cluster,
        disposition=disp, reason=reason, neokodStatus=st, neokodStatusBasis=st_note,
        latestNightlyReachability=nl, previousNightlyReachability=npv,
        latestInspectedNightlyTag=latest['tag'], latestInspectedNightlyCommit=latest['commit'],
        previousInspectedNightlyTag=prev['tag'], previousInspectedNightlyCommit=prev['commit'],
        newlyReachableSincePreviousPinnedHistory=bool(x['merge_oid'] and x['merge_oid'] in latest_commit_oids and x['merge_oid'] not in previous_commit_oids),
        closureClass=cls, closureHint=hint,
        duplicateOf=';'.join(map(str, dup_group.get(n, []))),
        reverts=';'.join(map(str, x['refs']['reverts'])), revertedBy=';'.join(map(str, reverted_by.get(n, []))),
        supersedes=';'.join(map(str, x['refs']['supersedes'])), closesIssues=';'.join(map(str, x['refs']['closes'])),
        isDraft=x['draft'], isTakeover=x['is_takeover'], filesUnavailable=x['files_unavailable'],
        evidenceDepth=';'.join(depth), confidence=ov.get('confidence', 'rule-based'),
        auditNote=audit_note, priority=ov.get('priority', ''),
    )
    rows.append(row)

assert len(rows) == len(rawrows) == len({r['number'] for r in rows}), 'ledger/census mismatch'
os.makedirs(out_dir, exist_ok=True)
json.dump(rows, open(os.path.join(out_dir, 'all-pr-dispositions.json'), 'w'), indent=1)
with open(os.path.join(out_dir, 'all-pr-dispositions.csv'), 'w', newline='') as f:
    w = csv.DictWriter(f, fieldnames=list(rows[0].keys()))
    w.writeheader()
    w.writerows(rows)
json.dump(CLUSTER_LABELS, open(os.path.join(work, 'cluster-labels.json'), 'w'), indent=1)
print('ledger rows', len(rows))
print('mergedStatus', dict(collections.Counter(r['mergedStatus'] for r in rows)))
print('disposition', dict(collections.Counter(r['disposition'] for r in rows).most_common()))
print('cluster', dict(collections.Counter(r['featureCluster'] for r in rows).most_common()))
print('closureClass', dict(collections.Counter(r['closureClass'] for r in rows if r['mergedStatus'] == 'closed-unmerged').most_common()))
