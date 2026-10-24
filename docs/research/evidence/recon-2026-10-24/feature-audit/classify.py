"""Rule-based first-pass classifier for every PR in the census.

Inputs (all read-only): census all-closed-prs.json, pr-graphql-meta.json,
pr-files-first100.json, nightly ancestry files.
Output: pass1.json (one record per PR). Manual overrides are applied later by
build_ledger.py from overrides/*.json so rules and human judgement stay separate.
"""
import json, os, re, sys, collections

census, work, out = sys.argv[1], sys.argv[2], sys.argv[3]
rows = json.load(open(os.path.join(census, 'all-closed-prs.json')))
meta = json.load(open(os.path.join(work, 'pr-graphql-meta.json')))
files = json.load(open(os.path.join(work, 'pr-files-first100.json')))
latest = json.load(open(os.path.join(work, 'nightly-latest-ancestry.json')))
prev = json.load(open(os.path.join(work, 'nightly-prev-ancestry.json')))
in_latest = {o for o, _ in latest['commits']}
in_prev = {o for o, _ in prev['commits']}

BACKEND_BUCKETS = ('server', 'contracts', 'shared', 'client-runtime', 'provider-pkg', 'source-control-pkg', 'ssh-tailscale')
BACKEND_SCOPES = {
    'server', 'shared', 'contracts', 'client-runtime', 'client', 'clients', 'orchestration', 'orchestration-v2', 'provider', 'providers',
    'provider-core', 'vcs', 'git', 'ssh', 'terminal', 'mcp', 'usage', 'claude', 'codex', 'cursor', 'grok', 'opencode', 'acp', 'acp-registry',
    'settings', 'source-control', 'tailscale', 'cli', 'observability', 'storage', 'scheduler', 'pi', 'muse', 'antigravity', 'kiro', 'copilot',
    'github', 'gitlab', 'bitbucket', 'forgejo', 'azure-devops', 'gitcafe', 'checkpoint', 'auth', 'security', 'models', 'review', 'pull-requests',
    'pull-request', 'pr', 'prs', 'devices', 'device', 'preview', 'queue', 'threads', 'service', 'shell', 'mcp-apps', 'agents', 'projects', 'sqlite',
    'telemetry', 'analytics', 'search', 'files', 'codex-app-server', 'effect-acp', 'provider-opencode', 'provider-cursor', 'provider-grok',
    'provider-acp', 'provider-pi', 'provider-muse', 'provider-antigravity', 'composer-chat', 'import', 'migration', 'sync',
}
UI_SCOPES = {'web', 'ui', 'sidebar', 'composer', 'chat', 'markdown', 'keybindings', 'a11y', 'accessibility', 'i18n', 'theme', 'themes',
             'marketing', 'brand', 'branding', 'design', 'voice', 'dictation', 'otter', 'compadre'}
TITLE_RE = re.compile(r'^(?P<type>[a-zA-Z]+)(?:\((?P<scope>[^)]*)\))?!?:\s*(?P<rest>.*)$')
TEST_RE = re.compile(r'(\.test\.|\.spec\.|\.browser\.|/__tests__/|/testing/|/testkit/|fixtures?/|replay|\.snap$|/test/|vitest|playwright)', re.I)


def bucket(path):
    p = path
    if p.startswith('apps/mobile') or p.startswith('apps/swift-ios'):
        return 'mobile'
    if p.startswith('apps/web'):
        return 'web'
    if p.startswith('apps/desktop'):
        return 'desktop'
    if p.startswith('apps/server'):
        return 'server'
    if p.startswith('apps/marketing'):
        return 'marketing'
    if p.startswith('apps/machine-map'):
        return 'machine-map'
    if p.startswith('infra') or p.startswith('apps/relay') or 'relay' in p.split('/')[1:2]:
        return 'cloud-infra'
    if p.startswith('packages/contracts'):
        return 'contracts'
    if p.startswith('packages/client-runtime'):
        return 'client-runtime'
    if p.startswith('packages/shared'):
        return 'shared'
    if p.startswith('packages/provider-') or p.startswith('packages/effect-'):
        return 'provider-pkg'
    if p.startswith('packages/source-control'):
        return 'source-control-pkg'
    if p.startswith('packages/ssh') or p.startswith('packages/tailscale'):
        return 'ssh-tailscale'
    if p.startswith('docs') or p.endswith('.md') or p.startswith('.agents'):
        return 'docs'
    if p.startswith('.github') or p.startswith('scripts') or p.startswith('oxlint') or p.startswith('patches') \
            or p in ('pnpm-lock.yaml', 'pnpm-workspace.yaml', 'package.json', 'vite.config.ts', '.gitignore') or p.startswith('.repos'):
        return 'ci-tooling'
    if p.startswith('factory'):
        return 'factory'
    if p.startswith('native/'):
        return 'server'
    if p.startswith('packages'):
        return 'other-package'
    return 'other'


def rec_for(r):
    n = r['number']
    m = meta[str(n)]
    f = files[str(n)]
    t = ' '.join(r['title'].split())
    tl = t.lower()
    mm = TITLE_RE.match(t)
    ptype = (mm.group('type').lower() if mm else 'none')
    scope = (mm.group('scope') or '').lower() if mm else ''
    body = (r.get('body') or '')
    bl = body.lower()
    labels = [l['name'] for l in r['labels']]
    flist = f.get('files', [])
    paths = [x[0] for x in flist]
    nontest = [x for x in flist if not TEST_RE.search(x[0])]
    bc = collections.Counter(bucket(x[0]) for x in nontest)
    bc_all = collections.Counter(bucket(x[0]) for x in flist)
    test_only = bool(flist) and not nontest
    total_nt = sum(bc.values()) or 1
    product = collections.Counter({k: v for k, v in bc.items() if k not in ('docs', 'ci-tooling', 'other')})
    if product:
        top_bucket = product.most_common(1)[0][0]
    elif bc:
        top_bucket = bc.most_common(1)[0][0]
    else:
        top_bucket = 'tests-only' if test_only else 'none'
    files_unavailable = (m['changedFiles'] > 0 and not flist) or m['changedFiles'] == 0
    merged = bool(m['merged'])
    base = m['baseRefName']
    status = 'closed-unmerged' if not merged else ('merged-main' if base == 'main' else 'merged-stacked-branch')
    oid = (m.get('mergeCommit') or {}).get('oid')
    incl_latest = incl_prev = None
    if merged and base == 'main' and oid:
        incl_latest = oid in in_latest
        incl_prev = oid in in_prev
    return dict(number=n, title=t, tl=tl, ptype=ptype, scope=scope, body=body, bl=bl, labels=labels,
                author=r['user']['login'], author_type=r['user']['type'], assoc=r['author_association'],
                url=r['html_url'], created=r['created_at'], closed=r['closed_at'],
                merged_at=r['pull_request'].get('merged_at'), merged=merged, status=status, base=base,
                head=m['headRefName'], merge_oid=oid, cross_repo=m['isCrossRepository'],
                changed_files=m['changedFiles'], additions=m['additions'], deletions=m['deletions'],
                commits=m['commits']['totalCount'], draft=bool(r.get('draft')),
                bc=dict(bc), bc_all=dict(bc_all), top_bucket=top_bucket, test_only=test_only,
                paths=paths, truncated=f.get('truncated', False),
                nightly_latest=incl_latest, nightly_prev=incl_prev, files_unavailable=files_unavailable,
                is_takeover=(m['headRefName'].startswith('takeover') or any(l.lower().startswith('takeover') for l in labels) or tl.startswith('takeover/')))


recs = [rec_for(r) for r in rows]

# ---- keyword/cluster rules -------------------------------------------------
def has(t, *words):
    return any(re.search(w, t) for w in words)

SUPPORTED = ['codex', 'claude', 'copilot', 'cursor', 'grok', 'opencode', 'kiro']
UNSUPPORTED_PROVIDERS = [r'antigravity', r'\bpi\b', r'\bmuse\b', r'kimi', r'kilo', r'\bdsh\b', r'chatgpt web', r'prime agent',
                         r'fx provider', r'acp[- ]registry', r'droid', r'cline', r'mythos']


def cluster_of(x):
    t, s, tl = x['title'], x['scope'], x['tl']
    paths = ' '.join(x['paths']).lower()
    # usage family
    if has(tl, r'\busage\b', r'usage[- ]limit', r'\blimits?\b.*\b(bar|pace|pool|account|reset)', r'reset credit', r'banked reset', r'quota', r'pricing|price|\bcost\b'):
        if has(tl, r'usage[- ]limit', r'out of tokens', r'reset(s)? (time|credit)', r'banked reset', r'auto[- ]resume', r'snoozed limited', r'limited threads', r'usage-limit wake', r'usage limit recovery', r'429 retry', r'usage-limit sweep', r'stopped usage-limit') \
                and not has(tl, r'^(fix|feat)\(usage\)'):
            return 'usage-limit-handling'
        return 'usage-limits-dashboard'
    if 'usage' in s or 'apps/server/src/usage' in paths or 'usagepage' in paths.replace('/', '').replace('_', '') \
            or 'apps/web/src/components/usage' in paths:
        return 'usage-limits-dashboard'
    if has(tl, r'context (meter|window|usage|occupancy)', r'compact', r'token count', r'context handoff', r'prompt cache'):
        return 'context-compaction-handoff'
    if has(tl, r'\bsubagent', r'delegat', r'lineage', r'native child', r'\bworkflow (member|thread)', r'background (work|agent|wake|task)', r'\bwakes?\b', r'orchestrat'):
        return 'subagents-delegation-background'
    if has(tl, r'\bsettle|snooze|auto-settle|\bwatch(es)?\b.*(pull request|pr)|pull request watch|pr watch'):
        return 'thread-settle-snooze-pr-watch'
    if has(tl, r'queue|follow-up|steer'):
        return 'queue-followup-steer'
    if has(tl, r'terminal|pty|shell history|osc|dcs|scrollback'):
        return 'terminal'
    if has(tl, r'\bgit\b|worktree|checkpoint|\bbranch|\bfetch\b|\bclone\b|upstream|\bpull\b|\brebase|stack'):
        return 'git-vcs-worktree'
    if has(tl, r'pull request|\bpr\b|merge request|gitlab|bitbucket|forgejo|azure|gitcafe|github|source control|source-control|review guide'):
        return 'source-control-pr'
    if has(tl, r'\bssh\b', r'tailscale', r'\blan\b', r'direct connection', r'endpoint', r'pairing', r'saved (connection|server)', r'\bwsl\b'):
        return 'remote-direct-connection'
    if has(tl, r'connect|relay|clerk|cloudflare|tunnel|live activit|webhook'):
        return 'cloud-connect-relay-webhook'
    if has(tl, r'sqlite|wal\b|database|\bdb\b|migration|projection|shell snapshot|snapshot read'):
        return 'persistence-sqlite-projection'
    if has(tl, r'telemetry|otel|otlp|observab|trace|span|metrics|heap|diagnostic'):
        return 'observability-telemetry'
    if has(tl, r'\bmcp\b', r't3_thread', r'thread tools'):
        return 'mcp-t3-tools'
    if has(tl, r'preview|browser|device|simulator|screenshot|snapshot|annotat|html render|visual repl'):
        return 'preview-browser-devices'
    if has(tl, r'schedul|automation'):
        return 'scheduled-tasks-automations'
    if has(tl, r'react compiler|use memo|compiles'):
        return 'web-react-compiler-sweep'
    if has(tl, r'provider (update|detect|status)|model (catalog|picker|discover)|\bmodels?\b.*(catalog|discover)|health|cli update|version'):
        return 'provider-detection-models-updates'
    return ''


def provider_of(x):
    tl = x['tl']
    found = [p for p in SUPPORTED if re.search(r'\b' + p, tl)]
    unsup = [p for p in UNSUPPORTED_PROVIDERS if re.search(p, tl)]
    return found, unsup


def categorize(x):
    t, tl, ptype, scope = x['title'], x['tl'], x['ptype'], x['scope']
    tb = x['top_bucket']
    bc = x['bc']
    labels = x['labels']
    reasons = []
    # 0 non-product noise
    if x['author_type'] == 'Bot' and ('dependabot' in x['author'].lower() or ptype in ('chore',) and 'bump' in tl):
        return 'bot-dependency-bump', 'Dependabot or bot dependency bump; no product behaviour.'
    if 'vouched list' in tl or 'triage exemptions' in tl:
        return 'repo-governance', 'Contributor vouch/triage list maintenance.'
    if tl.startswith('revert') or ptype == 'revert' or tl.startswith('revert:'):
        return 'revert', 'Revert PR; see revert links for the reverted change.'
    if re.search(r'please ignore|^sync to remote$|^daily sync|^sync upstream|^m$|^bye npm$', tl):
        return 'noise-or-fork-sync', 'Fork sync, accidental or non-feature PR.'
    if 'backport' in tl:
        return 'backport', 'Backport to a release branch.'
    # excluded surfaces: title scope and backend file weight decide before raw file counts
    backend_w = sum(bc.get(b, 0) for b in BACKEND_BUCKETS)
    backend_scope = scope in BACKEND_SCOPES
    mobile_scope = bool(re.match(r'^(mobile|android|ios|swift-ios|duo|ipad|expo)$', scope))
    if mobile_scope or (not backend_scope and tb == 'mobile' and backend_w == 0) or \
            (not backend_scope and scope == '' and re.search(r'\bmobile\b|\bandroid\b|\bios\b|\bipad\b|\bduo\b|live activit|dynamic island|expo', tl) and backend_w == 0):
        return 'mobile-excluded', 'Mobile app/native surface; Neokod has no mobile app (AGENTS.md exclusion).'
    cloud_hit = re.search(r't3 connect|\bconnect\b|relay|clerk|cloudflared|hosted agent|oauth.*mcp|webhook', tl)
    if tb in ('cloud-infra',) or (cloud_hit and tb in ('server', 'cloud-infra', 'web', 'client-runtime', 'shared', 'desktop', 'docs')):
        if not re.search(r'tailscale|\bssh\b|\blan\b', tl):
            return 'cloud-connect-relay-excluded', 'Depends on T3 Connect/relay/Clerk/webhook-relay infrastructure carved out of Neokod.'
    if tb == 'marketing' or scope == 'marketing' or re.search(r'branding|brand|social card', tl):
        return 'marketing-brand-excluded', 'Marketing/brand surface; Neokod owns its identity.'
    if tb == 'factory' or x['author'] == 'rawphp' and 'factory' in ' '.join(x['paths']).lower():
        return 'third-party-fork-feature', 'Contributor fork feature (factory/t3fac); not upstream product direction.'
    if x['test_only'] or ptype == 'test':
        return 'test-maintenance', 'Test-only or test-infrastructure change.'
    if tb == 'docs' and ptype in ('docs',) or ptype == 'docs':
        return 'docs-only', 'Documentation change.'
    if ptype in ('ci', 'build') or tb == 'ci-tooling' or (ptype == 'chore' and tb in ('ci-tooling', 'none', 'other', 'other-package')) or scope in ('deps', 'deps-dev', 'ci', 'release', 'scripts', 'typecheck', 'lint', 'dev', 'build'):
        return 'ci-release-build-tooling', 'CI/release/build/dependency tooling; no direct product behaviour.'
    if ptype == 'chore' and re.search(r'bump|upgrade|update (deps|expo)|effect', tl):
        return 'ci-release-build-tooling', 'Dependency/tooling maintenance.'
    if ptype == 'refactor' or scope == 'refactor':
        # keep provider-core / source-control package extractions visible as architecture references
        return 'internal-refactor', 'Internal refactor/extraction; architecture reference only.'
    ui_scope = scope in UI_SCOPES
    if ui_scope or ptype in ('style',) or (tb == 'web' and backend_w == 0) or (tb == 'web' and not backend_scope and backend_w <= 1 and scope in ('', 'client', 'clients')):
        return 'ui-excluded', 'Web UI surface; Neokod owns its own UI (AGENTS.md exclusion).'
    if tb == 'desktop' or scope == 'desktop':
        return 'desktop-shell', 'Electron desktop shell behaviour; port only if Neokod desktop has the same defect.'
    if tb in ('machine-map',):
        return 'ui-excluded', 'Machine-map app surface.'
    if tb in ('server', 'contracts', 'shared', 'client-runtime', 'provider-pkg', 'source-control-pkg', 'ssh-tailscale'):
        return 'backend-candidate', 'Backend/runtime/shared change; assess for Neokod equivalence.'
    if backend_w >= 1 and (backend_scope or scope == ''):
        return 'backend-candidate', 'Cross-layer change with backend files; backend intent is assessed, UI/mobile parts are excluded.'
    if tb in ('web', 'mobile'):
        return ('ui-excluded', 'UI-dominant change with no backend files.') if tb == 'web' else ('mobile-excluded', 'Mobile-dominant change with no backend files.')
    return 'unclassified-needs-review', 'No rule matched; manual read required.'


for x in recs:
    x['cluster'] = cluster_of(x)
    x['supported_providers'], x['unsupported_providers'] = provider_of(x)
    x['category'], x['category_reason'] = categorize(x)

json.dump([{k: v for k, v in x.items() if k not in ('tl', 'bl')} for x in recs], open(out, 'w'))
c = collections.Counter(x['category'] for x in recs)
print(len(recs), dict(c.most_common()))
cc = collections.Counter(x['cluster'] for x in recs if x['category'] == 'backend-candidate')
print('backend clusters', dict(cc.most_common()))
print('status', dict(collections.Counter(x['status'] for x in recs)))
