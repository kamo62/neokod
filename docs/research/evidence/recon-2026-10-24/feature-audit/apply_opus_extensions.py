#!/usr/bin/env python3
"""Apply the bounded Opus F5/F2b/F9 artifact corrections to Sonnet-owned files.

This is a one-shot research-ledger transform. It starts from the already validated
F1-F4 ledger and leaves source-coverage/reachability facts intact. It does not
fetch upstream data, inspect application code, or run repository checks.
"""
from __future__ import annotations

import collections
import copy
import csv
import hashlib
import json
import re
from pathlib import Path

BASE = Path('/tmp/neokod-feature-audit-2026-10-24')
WORK = BASE / 'sonnet'
LEDGER_JSON = WORK / 'all-pr-dispositions.json'
LEDGER_CSV = WORK / 'all-pr-dispositions.csv'
PASS1_JSON = WORK / 'pass1.json'
RAW_JSON = BASE / 'all-closed-prs.json'
RECEIPT_JSON = WORK / 'evidence/audit-correction-receipt-2026-10-24.json'
REPORT_MD = WORK / 't3-feature-gap-report.md'
VALIDATION_JSON = WORK / 'evidence/opus-extension-validation-2026-10-24.json'
LABELS_JSON = WORK / 'cluster-labels.json'

CURRENT_NEOKOD_HEAD = '0c05baa3f426d91ed97bb0d625f1531a3380b9c0'
LATEST_NIGHTLY = 'v0.1.3-nightly.20261024.3617'
LATEST_NIGHTLY_COMMIT = '27e0c684c585f955252d65f06206dd11a143bff5'
PREVIOUS_NIGHTLY = 'v0.1.3-nightly.20261023.3592'
PREVIOUS_NIGHTLY_COMMIT = 'e340aaeeb98bc6ac623c2e70ac8eca8bcbddfe1b'

BACKEND_BUCKETS = {
    'server', 'contracts', 'shared', 'client-runtime', 'provider-pkg',
    'source-control-pkg', 'ssh-tailscale',
}
EXCLUDED_SURFACE_CATEGORIES = {
    'mobile-excluded', 'ui-excluded', 'desktop-shell', 'cloud-connect-relay-excluded',
}
MIXED_CATEGORY = 'mixed-excluded-backend-unassessed'
BACKLOG_DISPOSITION = 'backend-backlog-unassessed'
TEST_RE = re.compile(
    r'(\.test\.|\.spec\.|\.browser\.|/__tests__/|/testing/|/testkit/|'
    r'fixtures?/|replay|\.snap$|/test/|vitest|playwright)',
    re.I,
)
HOSTED_TEXT_RE = re.compile(
    r'\bt3\s*connect\b|\bclerk\b|cloudflared|\bcloudflare\b|'
    r'managed tunnel|managed endpoint|tunnel-linked|hosted (?:agent|bot|app|client)|'
    r'cloudlink|relay client|relay worker|relay-signed|relay\.t3\.codes|'
    r'relay endpoint|relay allocation|relay api|relay credentials|relay authorization|'
    r'relay tracing|relay inbox|managed relay',
    re.I,
)
HOSTED_PATH_RE = re.compile(
    r'^(?:infra/relay/|apps/relay/)|^packages/(?:contracts/src/relay|'
    r'shared/src/relay(?:Client|Jwt|Signing|Tracing)|client-runtime/src/relay/)|'
    r'^apps/server/src/relay/(?:AgentAwarenessRelay|HeldHooksWaker|RelayDeliveryProof|relayEnvironmentClient)|'
    r'^apps/server/src/cloud/(?:CloudLink|CloudPreferences|ManagedEndpoint|managedTunnel|'
    r'CliTokenManager|traceRelayRequest|CliState|relayResponse|ConnectReachability)',
    re.I,
)
BARE_CONNECT_TITLE_RE = re.compile(r'\bconnect\b', re.I)
TITLE_HAS_EXPLICIT_HOSTED_RE = re.compile(
    r't3\s*connect|relay|clerk|cloudflared|hosted agent|oauth.*mcp|webhook', re.I
)

MOBILE_ONLY_EXCEPTIONS = {
    5179: 'Android-only foreground/background connection service surface.',
    6464: 'iOS home-screen widget rendering; the shared relay paths support that widget surface.',
    7257: 'Mobile local-network permission/pairing flow; the changed product paths are client connection support.',
    14848: 'iOS Agent Activity widget refresh and its widget-specific relay read path.',
    15087: 'Mobile-only editor controls for webhook automations already supported by web/MCP.',
    15189: 'Mobile Agents-sheet and transcript-card presentation only.',
    15346: 'Mobile-only Working-section presentation for an existing thread state.',
    15502: 'Mobile dictation control lifetime across native navigation.',
    17900: 'Mobile app update-channel lookup and fallback behavior.',
    18127: 'Mobile EAS/export build-toolchain pin sharing; no general server feature is described.',
    18267: 'Native mobile pull-request guided-review surface.',
    18351: 'Mobile-only offline pull-request cache and action surface.',
    18796: 'Native mobile text-selection and quote gesture.',
    19579: 'Mobile Browser-page close-tab control for existing server tab commands.',
    20394: 'Mobile thread-sheet pull-request link/watch controls.',
    22733: 'Mobile simulator-video decoder path.',
}

CLOUD_MIXED_EXCEPTIONS = {
    5463: (
        'T3 Connect relay transport remains excluded; the same PR adds local/LAN/Tailscale '
        'endpoint discovery and direct-promotion behavior, which is retained as unassessed.'
    ),
    13774: (
        'T3 Connect awareness-relay retry behavior remains excluded; provider-session reaping, '
        'stopped-row filtering and idle-loop work are separate local server behavior and remain unassessed.'
    ),
    14413: (
        'Hosted relay tracing remains excluded; shared telemetry opt-out and desktop/server '
        'configuration semantics are retained for backend triage, not promoted.'
    ),
    15002: (
        'The web update/connection surface and T3 Connect relay-discovery branch remain '
        'excluded; the saved-server/client-runtime compatibility and update path is unassessed.'
    ),
    15085: (
        'Upstream webhook automation UI and the hosted T3 Connect URL variant remain excluded; '
        'the server webhook endpoint/schedule/verification behavior also supports a direct '
        'environment address and remains unassessed.'
    ),
    15088: (
        'Upstream webhook editor/delivery UI and hosted URL presentation remain excluded; '
        'client-runtime environment-address/webhook state is retained as unassessed.'
    ),
    17599: (
        'T3 Connect remote transport is an observed context, not the only use of the shared '
        'signed HTTP loaders; direct owner-server request URL correctness remains unassessed.'
    ),
    17602: (
        'Relay request authentication is an excluded slice; shared signed-URL construction for '
        'direct owner-server endpoints remains unassessed.'
    ),
    18820: (
        'Hosted webhook delivery is excluded; server-side claim release on failed acceptance '
        'is retained as unassessed local dispatch correctness.'
    ),
    19160: (
        'Webhook automation remains an excluded feature slice; the synchronous server prompt '
        'parser behavior also applies to direct delivery and remains unassessed.'
    ),
    20447: (
        'Webhook task admission/UI is excluded; server-side framing of untrusted request values '
        'is retained as unassessed security behavior.'
    ),
    21156: (
        'T3 Connect hosted transport and upstream device UI remain excluded; the DeviceHubProxy '
        'change also applies to Tailscale Serve/direct owner-host access and remains unassessed.'
    ),
    22194: (
        'Hosted webhook URL/relay delivery is excluded; server-side event filter semantics for '
        'direct environment endpoints remain unassessed.'
    ),
    22234: (
        'Hosted webhook URL/relay delivery is excluded; server-side replay dedupe/coalescing for '
        'direct environment endpoints remains unassessed.'
    ),
    23454: (
        'The word “connect” is generic old-client compatibility wording, not T3 Connect evidence; '
        'only the upstream web Settings UI is excluded and the server/contracts compatibility '
        'paths remain unassessed.'
    ),
    23282: (
        'A GitHub issue_comment/webhook example and a generic relay reference do not establish a hosted dependency; '
        'complete backend webhook filter/template/MCP/contract paths remain unassessed.'
    ),
}
CLOUD_EXCLUDED_SLICES = {
    5463: ['T3 Connect relay transport'],
    13774: ['T3 Connect awareness relay'],
    14413: ['hosted relay tracing'],
    15002: ['web update/connection UI', 'T3 Connect relay-discovery branch'],
    15085: ['upstream webhook automation UI', 'hosted T3 Connect URL variant'],
    15088: ['upstream webhook editor/delivery UI', 'hosted URL presentation'],
    17599: ['T3 Connect remote transport context'],
    17602: ['relay request-authentication slice'],
    18820: ['hosted webhook delivery'],
    19160: ['webhook automation feature surface'],
    20447: ['webhook task admission/UI'],
    21156: ['T3 Connect hosted transport', 'upstream device UI'],
    22194: ['hosted webhook URL/relay delivery'],
    22234: ['hosted webhook URL/relay delivery'],
    23454: ['upstream web Settings UI'],
    23282: [],
}

BARE_CONNECT_TITLE_ROWS = {
    7903, 9386, 11013, 13567, 14290, 15002, 16341, 16741,
    16887, 19400, 19499, 20491, 20622, 20639, 23454,
}
BARE_CONNECT_RETAINED_EXPLICIT = {
    9386: 'Body and paths identify Cloudflare tunnel allocation/reaping and relay recovery.',
    11013: 'Body identifies a T3 Connect cloud session and relay authorization state.',
    13567: 'Body identifies the released T3 Connect tunnel, relay allocation and clients.',
    16341: 'CloudLink and relay-response implementation paths are explicit in the title/body.',
    16741: 'Body explicitly says hosted agents require the T3 Connect address and sign-in.',
    16887: 'Body explicitly describes saved T3 Connect computers in onboarding.',
    19499: 'Body explicitly identifies T3 Connect OAuth credential refresh and CloudLink retries.',
}


def read_json(path: Path):
    return json.loads(path.read_text())


def write_json(path: Path, value) -> None:
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2) + '\n')


def append_note(existing: str | None, note: str) -> str:
    existing = (existing or '').strip()
    if note in existing:
        return existing
    return f'{existing} {note}'.strip()


def backend_bucket(path: str) -> str:
    if path.startswith('apps/mobile') or path.startswith('apps/swift-ios'):
        return 'mobile'
    if path.startswith('apps/web'):
        return 'web'
    if path.startswith('apps/desktop'):
        return 'desktop'
    if path.startswith('apps/server'):
        return 'server'
    if path.startswith('apps/marketing'):
        return 'marketing'
    if path.startswith('apps/machine-map'):
        return 'machine-map'
    if path.startswith('infra') or path.startswith('apps/relay'):
        return 'cloud-infra'
    if path.startswith('packages/contracts'):
        return 'contracts'
    if path.startswith('packages/client-runtime'):
        return 'client-runtime'
    if path.startswith('packages/shared'):
        return 'shared'
    if path.startswith('packages/provider-') or path.startswith('packages/effect-'):
        return 'provider-pkg'
    if path.startswith('packages/source-control'):
        return 'source-control-pkg'
    if path.startswith('packages/ssh') or path.startswith('packages/tailscale'):
        return 'ssh-tailscale'
    if path.startswith('docs') or path.endswith('.md') or path.startswith('.agents'):
        return 'docs'
    if path.startswith('.github') or path.startswith('scripts') or path.startswith('patches') or path.startswith('.repos'):
        return 'ci-tooling'
    if path.startswith('native/'):
        return 'server'
    if path.startswith('packages'):
        return 'other-package'
    return 'other'


def backend_product_paths(pass_row: dict) -> list[str]:
    return [
        path for path in pass_row.get('paths', [])
        if backend_bucket(path) in BACKEND_BUCKETS and not TEST_RE.search(path)
    ]


def split_title_scopes(pass_row: dict) -> list[str]:
    return [part.strip().lower() for part in (pass_row.get('scope') or '').split(',') if part.strip()]


def closure_prefix(row: dict) -> str:
    if row.get('mergedStatus') != 'closed-unmerged':
        return ''
    return (
        f"UNMERGED (this PR was not merged; closure class: {row.get('closureClass', 'unknown')}). "
        'Equivalent intent may exist elsewhere and was not inferred from this status. '
    )


def source_sample_snapshot(row: dict) -> dict:
    return {
        'topSourceLayer': row.get('topSourceLayer'),
        'sampledTopSourceLayer': row.get('sampledTopSourceLayer'),
        'sourceLayerAssessment': row.get('sourceLayerAssessment'),
        'sourceCoverageNote': row.get('sourceCoverageNote'),
        'sampledFileCount': row.get('sampledFileCount'),
        'filesTruncated': row.get('filesTruncated'),
        'filesUnavailable': row.get('filesUnavailable'),
    }


def original_excluded_slices(category: str) -> list[str]:
    return {
        'mobile-excluded': ['upstream mobile/native-app slice'],
        'ui-excluded': ['upstream UI slice'],
        'desktop-shell': ['upstream desktop-shell behavior; review only'],
        'cloud-connect-relay-excluded': ['hosted T3 Connect/relay/Clerk/webhook slice'],
    }.get(category, [])


def hosted_evidence_signals(row: dict, pass_row: dict, raw_row: dict) -> list[str]:
    text = f"{row.get('title', '')}\n{raw_row.get('body') or ''}"
    text_signals = (
        ('explicit T3 Connect', re.compile(r'\bt3\s*connect\b', re.I)),
        ('Clerk identity/authentication', re.compile(r'\bclerk\b', re.I)),
        ('Cloudflare/cloudflared managed transport', re.compile(r'cloudflare|cloudflared', re.I)),
        ('managed tunnel/endpoint', re.compile(r'managed tunnel|managed endpoint|tunnel-linked|tunnel link|tunnel allocation', re.I)),
        ('hosted agent/client', re.compile(r'hosted (?:agent|bot|app|client)', re.I)),
        ('explicit relay service operation', re.compile(r'relay client|relay worker|relay-signed|relay\.t3\.codes|relay endpoint|relay allocation|relay api|relay credentials|relay authorization|relay tracing|relay inbox|managed relay|cloudlink', re.I)),
    )
    signals = [label for label, pattern in text_signals if pattern.search(text)]
    matched_paths = [path for path in pass_row.get('paths', []) if HOSTED_PATH_RE.search(path)]
    signals.extend(f'specific hosted/relay implementation path: {path}' for path in matched_paths)
    return signals


def is_explicit_hosted(row: dict, pass_row: dict, raw_row: dict) -> bool:
    return bool(hosted_evidence_signals(row, pass_row, raw_row))


def apply_f5_mixed_row(row: dict, pass_row: dict, paths: list[str], slices: list[str], basis: str) -> dict:
    before = {
        'category': row['category'],
        'categoryReason': row['categoryReason'],
        'featureCluster': row['featureCluster'],
        'disposition': row['disposition'],
        'reason': row['reason'],
        'neokodStatus': row['neokodStatus'],
        'neokodStatusBasis': row['neokodStatusBasis'],
    }
    coverage = source_sample_snapshot(row)
    row['category'] = MIXED_CATEGORY
    if slices:
        row['categoryReason'] = (
            'Complete changed-file list contains both an excluded surface and backend product paths. '
            'Keep the excluded slice out of scope; assess the backend slice separately. This is not a '
            'line-by-line diff review.'
        )
        mixed_reason = (
            f"Mixed listing: excluded slice(s) {', '.join(slices)} remain excluded by policy; "
            f'{len(paths)} sampled backend product path(s) remain unassessed in the owner-triage backlog. '
            'No candidate-port or feature-gap conclusion is inferred.'
        )
    else:
        row['categoryReason'] = (
            'Complete backend paths are present, but the captured title/body/path evidence does not '
            'establish the hosted-only exclusion that had been assigned. Backend behavior remains unassessed.'
        )
        mixed_reason = (
            'A generic webhook/relay example does not establish a hosted-only dependency. '
            f'{len(paths)} backend product path(s) remain unassessed; no candidate-port or feature-gap conclusion is inferred.'
        )
    row['disposition'] = BACKLOG_DISPOSITION
    row['reason'] = closure_prefix(row) + mixed_reason
    row['neokodStatus'] = 'not-assessed'
    row['neokodStatusBasis'] = (
        'Backend product paths were not individually compared against Neokod; the excluded surface '
        'does not establish backend exclusion or parity.'
    )
    note = (
        f"F5 mixed complete listing: former {before['category']} / {before['disposition']}; "
        f"excludedSlices={'; '.join(slices) if slices else 'none established'}; {len(paths)} backend product path(s) retained as "
        'unassessed. Original complete path list and source-layer sample fields are preserved; no '
        'candidate/gap promotion.'
    )
    row['auditNote'] = append_note(row.get('auditNote'), note)
    review = {
        'version': 'F5',
        'scope': 'complete-changed-file-list',
        'assessment': 'mixed-excluded-backend-unassessed',
        'before': before,
        'excludedSlices': slices,
        'backendProductPaths': paths,
        'titleScopes': split_title_scopes(pass_row),
        'originalSourceSample': coverage,
        'decisionBasis': basis,
        'candidatePromotion': False,
        'after': {k: row[k] for k in (
            'category', 'categoryReason', 'featureCluster', 'disposition', 'reason',
            'neokodStatus', 'neokodStatusBasis',
        )},
    }
    row['f5MixedListingAssessment'] = review
    return review


def keep_f5_excluded_row(row: dict, pass_row: dict, paths: list[str], slices: list[str], assessment: str, basis: str) -> dict:
    before = {
        'category': row['category'],
        'categoryReason': row['categoryReason'],
        'featureCluster': row['featureCluster'],
        'disposition': row['disposition'],
        'reason': row['reason'],
        'neokodStatus': row['neokodStatus'],
        'neokodStatusBasis': row['neokodStatusBasis'],
    }
    review = {
        'version': 'F5',
        'scope': 'complete-changed-file-list',
        'assessment': assessment,
        'before': before,
        'excludedSlices': slices,
        'backendProductPaths': paths,
        'titleScopes': split_title_scopes(pass_row),
        'originalSourceSample': source_sample_snapshot(row),
        'decisionBasis': basis,
        'candidatePromotion': False,
        'after': {k: row[k] for k in (
            'category', 'categoryReason', 'featureCluster', 'disposition', 'reason',
            'neokodStatus', 'neokodStatusBasis',
        )},
    }
    row['f5MixedListingAssessment'] = review
    note = (
        f"F5 complete-list review retained the row-level exclusion because the captured paths/body "
        f"support the {assessment.removeprefix('explicit-').replace('-', ' ')} slice; "
        f"backend paths are support for that excluded slice, not an independently assessed Neokod port."
    )
    row['auditNote'] = append_note(row.get('auditNote'), note)
    return review


def correct_bare_connect_row(row: dict, pass_row: dict, raw_row: dict) -> dict:
    n = row['number']
    before = {
        'category': row['category'],
        'categoryReason': row['categoryReason'],
        'featureCluster': row['featureCluster'],
        'disposition': row['disposition'],
        'reason': row['reason'],
        'neokodStatus': row['neokodStatus'],
        'neokodStatusBasis': row['neokodStatusBasis'],
    }
    if n in BARE_CONNECT_RETAINED_EXPLICIT:
        decision = 'retained-explicit-hosted-evidence'
        basis = BARE_CONNECT_RETAINED_EXPLICIT[n]
    elif n == 14290:
        decision = 'mixed-truncated-backend-unassessed'
        basis = (
            'The retained PR description identifies per-account OpenAI OAuth, remote credential '
            'transfer, account usage and PostHog; it does not identify T3 Connect. Preserve the '
            'truncated first-100 sample, exclude OAuth/remote-credential/PostHog/UI slices, and '
            'leave backend account/usage semantics unassessed.'
        )
        paths = backend_product_paths(pass_row)
        row['category'] = 'mixed-truncated-unassessed'
        row['categoryReason'] = (
            'Cross-layer managed OpenAI account/provider-usage feature; only the first 100 of 120 '
            'paths are captured. Account-instance and usage behavior is distinct from the excluded '
            'OAuth/remote-credential-transfer, PostHog and UI slices; backend parity remains unassessed.'
        )
        row['featureCluster'] = 'usage-limits-accounts'
        row['disposition'] = BACKLOG_DISPOSITION
        row['reason'] = (
            'Managed account identity/usage intent is retained for backend triage; OpenAI OAuth, '
            'remote credential transfer, PostHog and upstream UI/mobile slices are excluded. The '
            'bare word “connect” is not T3 Connect evidence. No candidate-port or gap conclusion is inferred.'
        )
        row['neokodStatus'] = 'not-assessed'
        row['neokodStatusBasis'] = (
            'Account/usage backend semantics were not individually compared; hosted authentication, '
            'remote credential transfer, telemetry and upstream UI/mobile surfaces remain excluded.'
        )
        row['auditNote'] = append_note(
            row.get('auditNote'),
            'F5 keyword correction: “connect” alone does not establish T3 Connect. Backend account/usage '
            'paths remain unassessed; managed OAuth, remote credential transfer, PostHog, UI/mobile slices '
            'remain excluded. Original truncated source fields are unchanged.',
        )
        row['f5MixedListingAssessment'] = {
            'version': 'F5',
            'scope': 'truncated-first-100-keyword-correction; not counted in complete-list F5 totals',
            'assessment': 'mixed-excluded-backend-unassessed',
            'before': before,
            'excludedSlices': [
                'managed OpenAI OAuth', 'remote credential transfer', 'PostHog telemetry',
                'upstream UI/mobile surfaces',
            ],
            'backendProductPaths': paths,
            'titleScopes': split_title_scopes(pass_row),
            'originalSourceSample': source_sample_snapshot(row),
            'decisionBasis': basis,
            'candidatePromotion': False,
            'after': {k: row[k] for k in (
                'category', 'categoryReason', 'featureCluster', 'disposition', 'reason',
                'neokodStatus', 'neokodStatusBasis',
            )},
        }
    elif n == 7903:
        decision = 'reclassified-ui-not-t3-connect'
        basis = 'Only web/cloud auth/onboarding UI paths are present; a generic Connect title does not establish a T3 Connect/relay dependency.'
        row['category'] = 'ui-excluded'
        row['categoryReason'] = 'Web auth/onboarding UI surface; Neokod owns its UI. The generic “Connect” title wording is not treated as proof of T3 Connect/relay dependency.'
        row['disposition'] = 'excluded-policy-ui'
        row['reason'] = closure_prefix(row) + 'Web UI surface; Neokod owns its own UI. No T3 Connect/relay dependency is inferred from the generic title token.'
        row['neokodStatus'] = 'excluded'
        row['neokodStatusBasis'] = 'Upstream web auth/onboarding UI is excluded by Neokod UI ownership; no backend file list is present.'
    elif n == 19400:
        decision = 'reclassified-ui-not-t3-connect'
        basis = 'The complete path list is a Settings/keybindings web UI copy change; no cloud/relay/backend path is present.'
        row['category'] = 'ui-excluded'
        row['categoryReason'] = 'Settings/keybindings web UI copy change; generic “connect an environment” wording does not establish T3 Connect.'
        row['featureCluster'] = 'web-ui-surface'
        row['disposition'] = 'excluded-policy-ui'
        row['reason'] = 'Web UI surface; Neokod owns its own UI. Generic environment connection wording is not a T3 Connect dependency.'
        row['neokodStatus'] = 'excluded'
        row['neokodStatusBasis'] = 'Upstream settings UI is excluded by Neokod UI ownership.'
    elif n == 20491:
        decision = 'reclassified-react-compiler-maintenance-not-t3-connect'
        basis = 'The PR changes the React Compiler list and a cloud-list UI component only; body is the blank contribution template and contains no backend evidence.'
        row['category'] = 'ci-release-build-tooling'
        row['categoryReason'] = 'React Compiler file-list maintenance; no product behavior is established, and generic “connect” wording is not T3 Connect evidence.'
        row['featureCluster'] = 'web-react-compiler-sweep'
        row['disposition'] = 'excluded-noise-build-ci-deps'
        row['reason'] = 'React Compiler allowlist/tooling change; no product behavior to port. No T3 Connect dependency is inferred from the title token.'
        row['neokodStatus'] = 'excluded'
        row['neokodStatusBasis'] = 'Build/compiler maintenance; no product behavior was established.'
    elif n in (20622, 20639):
        decision = 'reclassified-ui-not-t3-connect'
        basis = 'The complete path list and body describe a React Compiler/UI implementation-only change with no backend product path.'
        row['category'] = 'ui-excluded'
        row['categoryReason'] = 'React Compiler/UI-only surface; Neokod owns its UI. Generic “Connect” wording is not treated as T3 Connect dependency evidence.'
        row['disposition'] = 'excluded-policy-ui'
        row['reason'] = 'Upstream UI implementation is excluded by policy; no T3 Connect dependency is inferred from the generic title token.'
        row['neokodStatus'] = 'excluded'
        row['neokodStatusBasis'] = 'Upstream UI is excluded by Neokod UI ownership.'
    elif n in (15002, 23454):
        decision = 'mixed-backend-unassessed-not-t3-connect-keyword-only'
        basis = 'The complete product paths are generic saved-server/settings compatibility behavior; the title token alone does not establish T3 Connect.'
    else:
        raise AssertionError(f'No bare-connect handling for #{n}')
    if n not in (14290, 15002, 23454):
        note = f'Connect-keyword correction: {basis}'
        row['auditNote'] = append_note(row.get('auditNote'), note)
    review = {
        'rule': 'A bare “connect” token does not imply T3 Connect, relay or hosted infrastructure.',
        'decision': decision,
        'basis': basis,
        'before': before,
        'after': {k: row[k] for k in (
            'category', 'categoryReason', 'featureCluster', 'disposition', 'reason',
            'neokodStatus', 'neokodStatusBasis',
        )},
    }
    row['connectKeywordReview'] = review
    return review


def row_parent_chain(child: dict, by_head: dict[int, dict], by_head_ref: dict[str, list[dict]]) -> tuple[list[dict], str]:
    chain = []
    current = child
    seen = {child['number']}
    while True:
        parents = by_head_ref.get(current['baseRef'], [])
        if not parents:
            return chain, 'unresolved-no-census-headRef-match'
        if len(parents) != 1:
            return chain, 'ambiguous-census-headRef-match'
        parent = parents[0]
        if parent['number'] in seen:
            return chain, 'cycle-in-census-parent-association'
        chain.append(parent)
        seen.add(parent['number'])
        if parent['latestNightlyReachability'] == 'reachable-in-date-bounded-inspected-history':
            return chain, 'parent-chain-reaches-inspected-nightly'
        current = parent


def render_cluster_table(rows: list[dict], labels: dict) -> str:
    clusters = collections.defaultdict(list)
    for row in rows:
        clusters[row['featureCluster']].append(row)
    lines = [
        '| Cluster | PRs | Merged main | Merged stacked | Closed unmerged | Port intent | Gap proposal | Backlog unassessed | Other |',
        '| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- |',
    ]
    for cid in sorted(clusters, key=lambda value: (-len(clusters[value]), value)):
        cluster_rows = clusters[cid]
        statuses = collections.Counter(row['disposition'] for row in cluster_rows)
        important = {
            key: value for key, value in statuses.items()
            if key not in ('candidate-port-intent', 'feature-gap-proposal', 'backend-backlog-unassessed')
        }
        other = ', '.join(f'{key} {value}' for key, value in sorted(important.items())) or 'none'
        lines.append(
            f"| {labels.get(cid, cid)} (`{cid}`) | {len(cluster_rows)} | "
            f"{sum(row['mergedStatus'] == 'merged-main' for row in cluster_rows)} | "
            f"{sum(row['mergedStatus'] == 'merged-stacked-branch' for row in cluster_rows)} | "
            f"{sum(row['mergedStatus'] == 'closed-unmerged' for row in cluster_rows)} | "
            f"{statuses.get('candidate-port-intent', 0)} | "
            f"{statuses.get('feature-gap-proposal', 0)} | "
            f"{statuses.get('backend-backlog-unassessed', 0)} | {other} |"
        )
    assert sum(len(items) for items in clusters.values()) == len(rows)
    return '\n'.join(lines)


def replace_once(text: str, old: str, new: str, label: str) -> str:
    count = text.count(old)
    if count != 1:
        raise AssertionError(f'{label}: expected one report match, found {count}')
    return text.replace(old, new, 1)


rows = read_json(LEDGER_JSON)
pass_rows = {row['number']: row for row in read_json(PASS1_JSON)}
raw_rows = {row['number']: row for row in read_json(RAW_JSON)}
receipt = read_json(RECEIPT_JSON)
labels = read_json(LABELS_JSON)

assert len(rows) == 3927 and len({row['number'] for row in rows}) == 3927
assert 'opusExtensions' not in receipt, 'Opus extensions already applied; this transform is intentionally one-shot.'
assert all('f5MixedListingAssessment' not in row for row in rows)
assert all('connectKeywordReview' not in row for row in rows)
assert all('stackedParentPRAssociation' not in row for row in rows)
assert set(receipt.get('corrections', {})) >= {
    'F1_truncated_file_samples', 'F2_nightly_reachability',
    'F3_unavailable_file_metrics', 'F4_evidence_depth_and_unmerged_language',
}

by_number = {row['number']: row for row in rows}
original_rows = copy.deepcopy(by_number)

# F5 selection uses only current complete file lists and pass1's non-test product paths.
f5_candidates = []
f5_counts = collections.Counter()
all_excluded_with_backend = []
for row in rows:
    p = pass_rows[row['number']]
    paths = backend_product_paths(p)
    if row['category'] in EXCLUDED_SURFACE_CATEGORIES and paths:
        all_excluded_with_backend.append(row['number'])
        if not row['filesTruncated'] and not row['filesUnavailable']:
            f5_candidates.append(row['number'])
            f5_counts[row['category']] += 1

expected_complete_counts = {
    'mobile-excluded': 45,
    'ui-excluded': 161,
    'desktop-shell': 39,
    'cloud-connect-relay-excluded': 59,
}
assert dict(f5_counts) == expected_complete_counts, (dict(f5_counts), expected_complete_counts)
assert len(f5_candidates) == 304
assert len(all_excluded_with_backend) == 308

all_truncated_excluded_with_backend = sorted(
    n for n in all_excluded_with_backend if original_rows[n]['filesTruncated']
)
assert all_truncated_excluded_with_backend == [5533, 13998, 14290, 20285]

mobile_candidates = {n for n in f5_candidates if original_rows[n]['category'] == 'mobile-excluded'}
cloud_candidates = {n for n in f5_candidates if original_rows[n]['category'] == 'cloud-connect-relay-excluded'}
assert set(MOBILE_ONLY_EXCEPTIONS) <= mobile_candidates
assert set(CLOUD_MIXED_EXCEPTIONS) <= cloud_candidates
assert len(MOBILE_ONLY_EXCEPTIONS) == 16

for n in cloud_candidates - set(CLOUD_MIXED_EXCEPTIONS):
    assert is_explicit_hosted(original_rows[n], pass_rows[n], raw_rows[n]), (
        f'Cloud-only exclusion lacks separate hosted evidence: #{n} {original_rows[n]["title"]}'
    )

f5_items = []
f5_assessment_counts = collections.Counter()
for n in sorted(f5_candidates):
    row = by_number[n]
    before = original_rows[n]
    p = pass_rows[n]
    paths = backend_product_paths(p)
    assert paths, f'No backend product path for selected F5 row #{n}'
    scopes = split_title_scopes(p)
    original_category = before['category']

    if original_category == 'mobile-excluded' and n in MOBILE_ONLY_EXCEPTIONS:
        slices = ['mobile/native surface']
        review = keep_f5_excluded_row(
            row, p, paths, slices, 'explicit-mobile-only-exclusion', MOBILE_ONLY_EXCEPTIONS[n]
        )
    elif original_category == 'cloud-connect-relay-excluded' and n not in CLOUD_MIXED_EXCEPTIONS:
        slices = ['explicit hosted T3 Connect/relay/Clerk/webhook surface']
        body = raw_rows[n].get('body') or ''
        title = row['title']
        basis = (
            'Captured title/body or changed paths independently identify a hosted Connect/relay/Clerk/'
            'webhook implementation; the backend paths are within that excluded hosted slice. '
            'The standalone word “connect” is not used as the evidence.'
        )
        if not (HOSTED_TEXT_RE.search(f'{title}\n{body}') or any(HOSTED_PATH_RE.search(path) for path in p.get('paths', []))):
            raise AssertionError(f'Hosted-only exception needs explicit evidence for #{n}')
        review = keep_f5_excluded_row(
            row, p, paths, slices, 'explicit-hosted-only-exclusion', basis
        )
    else:
        if original_category == 'ui-excluded':
            slices = ['upstream web UI']
            basis = 'Complete path list includes non-test backend product code as well as the upstream UI surface; only the UI slice is excluded and backend parity was not assessed.'
        elif original_category == 'desktop-shell':
            slices = ['desktop-shell behavior (review-only)']
            basis = 'Complete path list includes backend product code in addition to desktop-shell behavior; the shell remains review-only and the backend slice is unassessed.'
        elif original_category == 'mobile-excluded':
            slices = ['upstream mobile/native surface']
            basis = 'No definitive mobile-only evidence establishes that all backend product paths are merely native-app support; retain the mobile exclusion and leave the backend slice unassessed.'
        elif n in CLOUD_MIXED_EXCEPTIONS:
            slices = CLOUD_EXCLUDED_SLICES[n]
            basis = CLOUD_MIXED_EXCEPTIONS[n]
        else:
            raise AssertionError(f'No F5 disposition for #{n} {original_category}')
        review = apply_f5_mixed_row(row, p, paths, slices, basis)

    f5_assessment_counts[review['assessment']] += 1
    f5_items.append({
        'number': n,
        'url': before['url'],
        'title': before['title'],
        'mergedStatus': before['mergedStatus'],
        'filesTruncated': before['filesTruncated'],
        'changedFiles': before['changedFiles'],
        'sourceCoverageNote': before['sourceCoverageNote'],
        'backendProductPathCount': len(paths),
        'assessment': review['assessment'],
        'before': review['before'],
        'excludedSlices': review['excludedSlices'],
        'backendProductPaths': paths,
        'titleScopes': scopes,
        'originalSourceSample': review['originalSourceSample'],
        'decisionBasis': review['decisionBasis'],
        'candidatePromotion': False,
        'after': review['after'],
    })

assert f5_assessment_counts == {
    'mixed-excluded-backend-unassessed': 245,
    'explicit-mobile-only-exclusion': 16,
    'explicit-hosted-only-exclusion': 43,
}, dict(f5_assessment_counts)

# Review the same 44 rows that the prior F5 output had called hosted-only. Generic
# webhook/relay examples do not pass this explicit-evidence predicate.
prior_mixed_before_sol = set(CLOUD_MIXED_EXCEPTIONS) - {23282}
prior_hosted_only_ids = sorted(cloud_candidates - prior_mixed_before_sol)
assert len(prior_hosted_only_ids) == 44 and 23282 in prior_hosted_only_ids
f5_items_by_number = {item['number']: item for item in f5_items}
hosted_predicate_rows = []
for number in prior_hosted_only_ids:
    row = by_number[number]
    pass_row = pass_rows[number]
    raw_row = raw_rows[number]
    item = f5_items_by_number[number]
    signals = hosted_evidence_signals(row, pass_row, raw_row)
    if number == 23282:
        assert not signals
        decision = 'reclassified-mixed-backend-unassessed'
        insufficient = ['GitHub issue_comment/webhook request example', 'generic relay reference in example text']
    else:
        assert signals, f'Hosted-only exception lacks explicit evidence: #{number}'
        decision = 'retained-hosted-only'
        insufficient = []
    predicate_review = {
        'predicateVersion': 'hosted-only-explicit-evidence-v2',
        'decision': decision,
        'strongHostedEvidenceSignals': signals,
        'insufficientExamples': insufficient,
    }
    row['f5MixedListingAssessment']['hostedOnlyPredicateReview'] = predicate_review
    item['hostedOnlyPredicateReview'] = predicate_review
    hosted_predicate_rows.append({
        'number': number,
        'title': row['title'],
        'decision': decision,
        'strongHostedEvidenceSignals': signals,
        'genericExamplesAreNotProof': True,
        'insufficientExamples': insufficient,
        'backendProductPaths': item['backendProductPaths'],
    })
hosted_only_predicate_audit = {
    'reviewedPriorHostedOnlyRows': prior_hosted_only_ids,
    'reviewedCount': 44,
    'retainedWithExplicitHostedEvidence': 43,
    'reclassifiedBecauseOnlyGenericWebhookOrRelayExamplesWereAvailable': [23282],
    'predicate': 'Require explicit T3 Connect, Clerk, Cloudflare/cloudflared, managed-tunnel/endpoint, hosted-agent/client evidence, or a specific relay implementation path whose hosted role is established. Generic webhook/relay examples alone are insufficient.',
    'rows': hosted_predicate_rows,
}

# The title keyword audit is distinct from complete-list F5. It also corrects #14290's
# truncated cloud label while preserving every F1 source-layer/sample field.
cloud_rows = [row for row in original_rows.values() if row['category'] == 'cloud-connect-relay-excluded']
keyword_rows = sorted(
    row['number'] for row in cloud_rows
    if BARE_CONNECT_TITLE_RE.search(row['title'])
    and not TITLE_HAS_EXPLICIT_HOSTED_RE.search(row['title'])
)
assert set(keyword_rows) == BARE_CONNECT_TITLE_ROWS, keyword_rows
connect_reviews = []
for n in keyword_rows:
    row = by_number[n]
    p = pass_rows[n]
    raw = raw_rows[n]
    before = original_rows[n]
    review = correct_bare_connect_row(row, p, raw)
    connect_reviews.append({
        'number': n,
        'url': before['url'],
        'title': before['title'],
        'before': review['before'],
        'decision': review['decision'],
        'basis': review['basis'],
        'after': review['after'],
        'filesTruncated': before['filesTruncated'],
        'sourceCoverageBefore': source_sample_snapshot(before),
        'sourceCoverageAfter': source_sample_snapshot(row),
    })

# Add a uniform F2b evidence field to the row schema. Direct reachability stays unchanged.
for row in rows:
    row['stackedParentPRAssociation'] = None
by_head_ref = collections.defaultdict(list)
for row in rows:
    by_head_ref[row['headRef']].append(row)
stacked_not_observed = [
    row for row in rows
    if row['mergedStatus'] == 'merged-stacked-branch'
    and row['latestNightlyReachability'] == 'not-observed-in-date-bounded-inspected-history'
]
assert len(stacked_not_observed) == 177
parent_association_rows = []
parent_association_counts = collections.Counter()
parent_rows_by_num = by_number
for child in stacked_not_observed:
    chain, state = row_parent_chain(child, parent_rows_by_num, by_head_ref)
    if state == 'parent-chain-reaches-inspected-nightly':
        chain_numbers = [parent['number'] for parent in chain]
        terminal = chain[-1]
        association = {
            'status': 'parent-reachability-inference',
            'childBaseRef': child['baseRef'],
            'associationMethod': 'child baseRef exactly matches a census parent headRef; recursive parent baseRef/headRef equality for a multi-hop chain',
            'parentPRChain': chain_numbers,
            'terminalReachableParentPR': terminal['number'],
            'terminalParentMergedStatus': terminal['mergedStatus'],
            'terminalParentMergeCommit': terminal['mergeCommit'],
            'terminalParentLatestNightlyReachability': terminal['latestNightlyReachability'],
            'childMergeCommitObserved': False,
            'exactChildContentInclusionProven': False,
            'inferenceLimit': 'Parent branch reachability is association evidence only; it does not prove that this child PR exact content survived squash/rebase/merge.'
        }
        if len(chain) == 1:
            parent_association_counts['direct-parent-reachable'] += 1
        else:
            parent_association_counts['parent-chain-reachable'] += 1
        if chain[0]['number'] == 2829:
            parent_association_counts['direct-child-of-2829'] += 1
    else:
        chain_numbers = [parent['number'] for parent in chain]
        association = {
            'status': 'unresolved-no-census-parent' if state == 'unresolved-no-census-headRef-match' else state,
            'childBaseRef': child['baseRef'],
            'associationMethod': 'exact child baseRef to census parent headRef matching; no match was captured',
            'parentPRChain': chain_numbers,
            'terminalReachableParentPR': None,
            'childMergeCommitObserved': False,
            'exactChildContentInclusionProven': False,
            'inferenceLimit': 'No parent association is inferred beyond the retained census. The direct child merge commit remains not observed in the date-bounded inspected history.'
        }
        parent_association_counts['unresolved'] += 1
    child['stackedParentPRAssociation'] = association
    note = (
        f"F2b: {association['status']}; parentPRChain={chain_numbers}; child merge commit remains "
        'not observed. Parent reachability is inference only, not proof of exact child-content inclusion.'
    )
    child['auditNote'] = append_note(child.get('auditNote'), note)
    parent_association_rows.append({
        'number': child['number'],
        'url': child['url'],
        'title': child['title'],
        'baseRef': child['baseRef'],
        'mergeCommit': child['mergeCommit'],
        'latestNightlyReachability': child['latestNightlyReachability'],
        **association,
    })

assert parent_association_counts['direct-parent-reachable'] == 172
assert parent_association_counts['parent-chain-reachable'] == 2
assert parent_association_counts['unresolved'] == 3
assert parent_association_counts['direct-child-of-2829'] == 154
assert sum(parent_association_counts.values()) == 331  # Includes the direct-child count as a diagnostic subtotal.

# F9: reason follows the curated #2829 feature-gap/planned-gated disposition. #13433
# remains an excluded UI row; only its lifecycle intent is retained as reference.
row_2829 = by_number[2829]
reason_2829_before = row_2829['reason']
row_2829['reason'] = (
    'Disposition is `feature-gap-proposal`: app-managed ordinary-chat children are the already-planned '
    'W6-C1–C6 capability, gated behind formal core exit. Use upstream behavioral intent only; '
    'upstream V2 architecture and UI remain excluded. This is not a new implementation authorization.'
)
row_13433 = by_number[13433]
assert row_13433['category'] == 'ui-excluded'
assert row_13433['disposition'] == 'excluded-policy-ui'
reason_13433_before = row_13433['reason']
status_13433_before = {
    'category': row_13433['category'],
    'disposition': row_13433['disposition'],
    'featureCluster': row_13433['featureCluster'],
    'neokodStatus': row_13433['neokodStatus'],
}
row_13433['neokodStatusBasis'] = (
    'Upstream Stop-during-start control intent is reference-only for Neokod lifecycle review; the '
    'upstream interface is excluded and no local defect or parity conclusion is established.'
)
row_13433['auditNote'] = append_note(
    row_13433.get('auditNote'),
    'F9: Stop-during-start lifecycle intent is reference-only for Neokod’s open Stop gate; upstream '
    'UI remains excluded. This is not a backend candidate or local parity finding.',
)

# Stable output schema and key order for JSON and CSV consumers.
base_fields = list(original_rows[rows[0]['number']].keys())
extension_fields = ['f5MixedListingAssessment', 'connectKeywordReview', 'stackedParentPRAssociation']
output_fields = base_fields + extension_fields
for row in rows:
    row.setdefault('f5MixedListingAssessment', None)
    row.setdefault('connectKeywordReview', None)
    row.setdefault('stackedParentPRAssociation', None)
    ordered = {key: row.get(key) for key in output_fields}
    row.clear()
    row.update(ordered)

# Recalculate exact final classifications and depth counts before writing.
status_counts = collections.Counter(row['mergedStatus'] for row in rows)
disposition_counts = collections.Counter(row['disposition'] for row in rows)
category_counts = collections.Counter(row['category'] for row in rows)
latest_counts = collections.Counter(row['latestNightlyReachability'] for row in rows)
previous_counts = collections.Counter(row['previousNightlyReachability'] for row in rows)
source_counts = collections.Counter(row['sourceLayerAssessment'] for row in rows)
confidence_counts = collections.Counter(row['confidence'] for row in rows)
tag_sets = [set(row['evidenceDepth'].split(';')) for row in rows]
evidence_counts = {
    'bodyReadRows': sum('body-read' in tags for tags in tag_sets),
    'officialPRDescriptionReadRows': sum('official-pr-description-read' in tags for tags in tag_sets),
    'patchReadRows': sum('patch-read' in tags for tags in tag_sets),
    'olderNeokodSourceRows_0ab699566': sum('neokod-source@0ab699566' in tags for tags in tag_sets),
    'previousCurrentNeokodSourceRows_3b134e4': sum('neokod-source@3b134e4' in tags for tags in tag_sets),
    'uniqueRowsWithAnyNeokodSourcePin': sum(any(tag.startswith('neokod-source@') for tag in tags) for tags in tag_sets),
    'upstreamSourceRows_27e0c684': sum('upstream-source@27e0c684' in tags for tags in tag_sets),
    'ruleBasedConfidenceRows': confidence_counts.get('rule-based', 0),
}
assert evidence_counts == {
    'bodyReadRows': 55,
    'officialPRDescriptionReadRows': 10,
    'patchReadRows': 17,
    'olderNeokodSourceRows_0ab699566': 20,
    'previousCurrentNeokodSourceRows_3b134e4': 12,
    'uniqueRowsWithAnyNeokodSourcePin': 29,
    'upstreamSourceRows_27e0c684': 2,
    'ruleBasedConfidenceRows': 3890,
}

# F1/F3 invariants must still hold after this bounded extension.
truncated = [row for row in rows if row['filesTruncated']]
unavailable = [row for row in rows if row['filesUnavailable']]
assert len(truncated) == 61
assert all(
    row['topSourceLayer'] == 'mixed/unknown (file list truncated)'
    and row['sourceLayerAssessment'] == 'mixed-or-unknown'
    and row['sampledTopSourceLayer']
    and row['sampledFileCount'] == 100
    and 'first 100' in row['sourceCoverageNote']
    for row in truncated
)
assert len(unavailable) == 5
assert all(
    row['changedFiles'] is None and row['additions'] is None and row['deletions'] is None
    and row['fileMetricsAvailability'] == 'unavailable'
    for row in unavailable
)
assert latest_counts == {
    'reachable-in-date-bounded-inspected-history': 3106,
    'not-applicable-unmerged': 644,
    'not-observed-in-date-bounded-inspected-history': 177,
}
assert status_counts == {
    'merged-main': 2774,
    'merged-stacked-branch': 509,
    'closed-unmerged': 644,
}
assert all(row['mergedDirectlyToMain'] == (row['mergedStatus'] == 'merged-main') for row in rows)
assert all(
    row['reason'].startswith('UNMERGED (this PR was not merged;')
    for row in rows if row['mergedStatus'] == 'closed-unmerged'
)

# No F5/keyword correction may autopromote a backend row into candidate/gap counts.
for row in rows:
    review = row.get('f5MixedListingAssessment')
    if review and review.get('assessment') == 'mixed-excluded-backend-unassessed':
        assert row['category'] in (MIXED_CATEGORY, 'mixed-truncated-unassessed')
        assert row['disposition'] == BACKLOG_DISPOSITION
        assert row['neokodStatus'] == 'not-assessed'
        assert review['candidatePromotion'] is False
assert row_2829['disposition'] == 'feature-gap-proposal'
assert row_2829['neokodStatus'] == 'planned-gated'
assert 'No rule produced' not in row_2829['reason']
assert status_13433_before == {
    'category': 'ui-excluded',
    'disposition': 'excluded-policy-ui',
    'featureCluster': 'web-ui-surface',
    'neokodStatus': 'not-assessed',
}
assert 'Stop-during-start lifecycle intent is reference-only' in row_13433['auditNote']

# Keep the direct child merge observations untouched; parent data is a separate inference field.
assert all(
    row['latestNightlyReachability'] == 'not-observed-in-date-bounded-inspected-history'
    and row['stackedParentPRAssociation'] is not None
    for row in stacked_not_observed
)

# Build the final report from the corrected row ledger, without changing the Luna-owned files.
report = REPORT_MD.read_text()
report = replace_once(
    report,
    'This completion used the available `gpt-6-luna` at `max`, the closest available Luna substitution; it is not presented as Sonnet work. The earlier Sonnet census, code reading, patches, source snapshots and curated evidence remain the source of most per-PR assessments. This pass corrected incomplete file-list classifications, checked the supplied mixed-PR examples, rechecked selected Neokod source paths, and wrote the final report and reconciled ledgers.',
    'This completion used the available `gpt-6-luna` at `max`, the closest available Luna substitution; it is not presented as Sonnet work. The earlier Sonnet census, code reading, patches, source snapshots and curated evidence remain the source of most per-PR assessments. This pass preserves the validated F1–F4 corrections and applies the final Opus F5, F2b and F9 artifact corrections using captured path, title, metadata and ancestry evidence; it does not start another census or broad source-research cycle.',
    'intro provenance',
)

scope_start = report.index('The closed-PR window is')
scope_end = report.index('\n\nEvery census row has', scope_start)
scope_text = (
    'The closed-PR window is 24 September 2026 00:00 UTC through collection at 24 October 2026 09:53 UTC. '
    'The daily GitHub pages reconcile to **3,927 unique PRs**, with **zero duplicates** and raw PR descriptions retained. '
    'Status totals are 2,774 merged directly to `main`, 509 merged into stacked branches, and 644 closed-unmerged PRs. '
    'The pinned 24 October nightly history (`v0.1.3-nightly.20261024.3617`, commit '
    '[`27e0c684c585f955252d65f06206dd11a143bff5`](https://github.com/pingdotgg/t3code/commit/27e0c684c585f955252d65f06206dd11a143bff5)) '
    'positively contains all 2,774 mainline merge commits and 332 stacked-branch merge commits. The previous inspected nightly '
    '(`v0.1.3-nightly.20261023.3592`, commit `e340aaeeb98bc6ac623c2e70ac8eca8bcbddfe1b`) contains 2,740 mainline and 330 '
    'stacked-branch merge commits; 36 additional merge commits are observed in the newer retained history. Direct latest-history '
    f'counts are {latest_counts["reachable-in-date-bounded-inspected-history"]} reachable, '
    f'{latest_counts["not-applicable-unmerged"]} not applicable because unmerged, and '
    f'{latest_counts["not-observed-in-date-bounded-inspected-history"]} merged commits not observed in the date-bounded inspected history. '
    'Among the 177 non-observed stacked rows, 174 have a captured parent-branch association to a reachable parent (172 direct parent '
    'merge commits and two one-hop parent chains); three have no matching parent head branch in the census. This is parent-reachability '
    'inference only: each child merge commit remains `not observed`, and parent reachability does not prove exact child-content inclusion. '
    'The history query is date-bounded from 10 September: positive commit reachability establishes source inclusion for that pin, not enabled '
    'behaviour, absence of later reverts, stable-release inclusion, or runtime execution. A negative match is only `not observed in date-bounded '
    'inspected history`, not proof of exclusion from unrestricted ancestry. Closed-unmerged means that particular PR was not merged; it does not '
    'rule out an equivalent change elsewhere.'
)
report = report[:scope_start] + scope_text + report[scope_end:]

triage_start = report.index('Every census row has')
triage_end = report.index('\n\n## Evidence boundary', triage_start)
triage_text = (
    'Every census row has an explicit category, feature cluster, disposition, local status, ancestry state and evidence-depth field in '
    '[`all-pr-dispositions.json`](all-pr-dispositions.json) and [`all-pr-dispositions.csv`](all-pr-dispositions.csv). '
    f"Final triage counts are {disposition_counts.get('candidate-port-intent', 0)} candidate-port intents, "
    f"{disposition_counts.get('feature-gap-proposal', 0)} feature-gap proposals, "
    f"{disposition_counts.get('backend-backlog-unassessed', 0)} backend items retained as unassessed backlog, "
    f"{disposition_counts.get('needs-human-triage', 0)} needs-human-triage items, and "
    f"{sum(v for k, v in disposition_counts.items() if k not in ('candidate-port-intent', 'feature-gap-proposal', 'backend-backlog-unassessed', 'needs-human-triage'))} other policy/reference/noise dispositions. "
    'These are triage labels, not endorsements to implement candidates or assertions that every backend slice is a verified gap.'
)
report = report[:triage_start] + triage_text + report[triage_end:]

# Replace the first evidence-depth paragraph, retaining the already-disclosed F1-F4 reconstruction limit.
evidence_start = report.index('The audit is a closed-PR **metadata census and triage**')
evidence_end = report.index('\n\nSol correctly identified', evidence_start)
evidence_text = (
    'The audit is a closed-PR **metadata census and triage**, not a line-by-line review of all 3,927 diffs. All titles, state metadata and raw PR-body fields were retained and keyword-scanned. '
    f"The final ledger has {evidence_counts['bodyReadRows']} `body-read` rows, {evidence_counts['officialPRDescriptionReadRows']} `official-pr-description-read` rows, "
    f"{evidence_counts['patchReadRows']} `patch-read` rows, {evidence_counts['olderNeokodSourceRows_0ab699566']} rows compared at the older Neokod pin `0ab699566`, "
    f"{evidence_counts['previousCurrentNeokodSourceRows_3b134e4']} at `3b134e4`, and {evidence_counts['uniqueRowsWithAnyNeokodSourcePin']} distinct rows with any Neokod source pin. "
    f"{evidence_counts['upstreamSourceRows_27e0c684']} rows have an `upstream-source@27e0c684` tag. The independent review counted 38 explicit body-read tags in its earlier output; the reconstructed prior input has 39, and the final F1–F4 ledger has 55. The original pre-correction emitted file is unavailable, so the one-row discrepancy between review and reconstruction cannot be resolved. `evidenceDepth` remains the per-row source of truth. The current final confidence labels include {evidence_counts['ruleBasedConfidenceRows']} `rule-based` rows; these are census/triage evidence, not semantic validation of each PR."
)
report = report[:evidence_start] + evidence_text + report[evidence_end:]

# Update the F1 boundary paragraph without changing F1 source-layer/sample facts.
old_f1 = (
    'Sol correctly identified that truncated first-100 paths had caused mixed PRs to be labelled mobile-only. All 61 now report overall source layer **mixed/unknown**, preserve sampled first-100 layer separately, and state source coverage. Five unavailable listings have null file metrics and **unknown/unavailable** source coverage, not fabricated zero-size metadata. The row-level F1 changes are in [`truncation-audit.md`](truncation-audit.md) and [`truncation-corrections.json`](truncation-corrections.json); F1–F4 are recorded in [`evidence/audit-correction-receipt-2026-10-24.json`](evidence/audit-correction-receipt-2026-10-24.json). The prior classification view at [`evidence/ledger-before-truncation-correction-2026-10-24.json`](evidence/ledger-before-truncation-correction-2026-10-24.json) is reconstructed from retained pass1 data and the earlier curated override subset; it is not a byte-for-byte preserved emitted ledger.'
)
new_f1 = (
    'Sol correctly identified that truncated first-100 paths had caused mixed PRs to be labelled mobile-only. All 61 still report overall source layer **mixed/unknown**, preserve the sampled first-100 layer separately, and state source coverage. Five unavailable listings retain null file metrics and **unknown/unavailable** source coverage, not fabricated zero-size metadata. F5 separately re-triages complete path listings and does not replace or reinterpret the F1 sample fields. The row-level F1 changes are in [`truncation-audit.md`](truncation-audit.md) and [`truncation-corrections.json`](truncation-corrections.json); F1–F4 plus the Opus extensions are recorded in [`evidence/audit-correction-receipt-2026-10-24.json`](evidence/audit-correction-receipt-2026-10-24.json), with assertions in [`evidence/opus-extension-validation-2026-10-24.json`](evidence/opus-extension-validation-2026-10-24.json). The prior classification view at [`evidence/ledger-before-truncation-correction-2026-10-24.json`](evidence/ledger-before-truncation-correction-2026-10-24.json) is reconstructed from retained pass1 data and the earlier curated override subset; it is not a byte-for-byte preserved emitted ledger.'
)
report = replace_once(report, old_f1, new_f1, 'F1 evidence boundary')

old_source = (
    'Current Neokod production-source comparisons use `/Users/kamogelo/.codex/worktrees/neokod-core-execution/t3code` at HEAD `3b134e4dcfb0d909601eed00f822b2b6c7013be1`. README, AGENTS, plan sections 16.15–16.19, the 4 October feature verdicts, and targeted current source paths were read. The checkout already contained unrelated `FORK.md` and `plan.md` modifications plus an untracked provider-reliability evidence directory; these were left untouched. No builds, installations, provider turns, browser sessions or tests were run in this research pass.'
)
new_source = (
    f"The latest inspected Neokod source HEAD is `{CURRENT_NEOKOD_HEAD}` in `/Users/kamogelo/.codex/worktrees/neokod-core-execution/t3code`. "
    'The earlier targeted source comparisons remain explicitly tagged at `3b134e4dcfb0d909601eed00f822b2b6c7013be1`; the Opus review reports that the intervening HEAD commit changes only the Codex app-server schema/generator/test paths and none of the source paths cited in those comparisons, but this pass did not re-run those comparisons. The repository also contained intentional root-owned changes to `CHANGELOG.md`, `FORK.md`, `plan.md`, provider-reliability evidence and `docs/research/feature-audit-2026-10-24.md`; they were left untouched. No repository source was edited, and no builds, installations, provider turns, browser sessions or tests were run.'
)
report = replace_once(report, old_source, new_source, 'source baseline and ownership')

opus_extension_section = f'''## Opus final extensions: F5, F2b and F9

### F5. Complete-list mixed exclusions

The Opus review's earlier 12:40 ledger snapshot had 308 excluded-surface rows with at least one backend product path (mobile 45, UI 163, desktop shell 40, cloud/Connect 60). Four of those had truncated first-100 listings, so they are not treated as complete-list F5 cases. On the current F1-corrected ledger, the complete-list set is **304**: mobile 45, UI 161, desktop shell 39, and cloud/Connect 59. The three unrelated truncated rows (#5533, #13998 and #20285) remain within the F1 coverage boundary; #14290 is corrected separately for the bare-connect rule below without changing its F1 source fields.

Of the 304 complete-list rows, **245** are now explicitly `mixed-excluded-backend-unassessed` / `backend-backlog-unassessed`: mobile 29, UI 161, desktop shell 39, and cloud 16. **59** remain row-level exclusions because their captured paths and feature scope support an explicit mobile-only (16) or hosted-only (43) slice. Every mixed row retains its original exclusion slice, the full complete-list backend product path subset, the parsed comma-separated title scopes, and the prior category/reason in `f5MixedListingAssessment`. The source-layer/sample fields are unchanged. No F5 row was promoted to `candidate-port-intent` or `feature-gap-proposal`; complete path coverage is not a full diff review.

Comma-separated title scopes are split before interpretation; for example, #21473's `server,mobile` scope is represented as both scopes and its actual server paths are retained. A bare `connect` token is not treated as T3 Connect evidence. Generic connection/compatibility rows #15002 and #23454 are mixed and unassessed; #14290 is a truncated mixed account/usage row with OpenAI OAuth, remote credential transfer, PostHog and UI/mobile slices excluded, not a T3 Connect claim. UI/compiler-only #7903, #19400, #20491, #20622 and #20639 are labelled by their UI/tooling evidence, not by the word “connect”. The 44 prior hosted-only exceptions were rechecked against explicit evidence: 43 retain independent T3 Connect, Clerk, Cloudflare/cloudflared, managed-tunnel/hosted-agent, or specific relay-infrastructure evidence. #23282 is mixed because its GitHub webhook and relay examples do not establish a hosted dependency; its backend filters/templates/MCP contract paths remain unassessed.

### F2b. Parent-PR association for 177 non-observed stacked merges

The child merge commits remain `not-observed-in-date-bounded-inspected-history`. Exact equality between a child's `baseRef` and a census PR's `headRef` associates **172** rows directly with a parent merge commit observed in the nightly (168 mainline parents and 4 stacked parents); two more reach an observed parent through a one-hop chain (#13519 → #13517 → #2829; #16075 → #16074 → #16021). The remaining **3** have no parent head-ref match in the captured census (#15808, #15961, #17343). #2829 is the direct parent branch for 154 of these stacked rows. Parent-branch reachability is inference, not exact content inclusion; no child is relabelled reachable on that basis.

### F9. Reason and reference consistency

#2829 remains `feature-gap-proposal` / `planned-gated`; its reason now explains the existing W6-C1–C6 managed-child plan and expressly avoids creating an implementation authorization. #13433 remains `ui-excluded` / `excluded-policy-ui`; only its Stop-during-start lifecycle intent is recorded as a reference for Neokod's open Stop gate. The upstream UI remains excluded, and no local defect or parity conclusion is asserted.

'''
report = replace_once(
    report,
    '\n## Priority findings and minimal Neokod paths',
    '\n' + opus_extension_section + '## Priority findings and minimal Neokod paths',
    'Opus extension section insertion',
)

# Replace the per-cluster coverage with counts from the final ledger.
cluster_table = render_cluster_table(rows, labels)
cluster_start = report.index('| Cluster | PRs |')
cluster_end = report.index('\n\n## Companion competitor evidence and limits', cluster_start)
report = report[:cluster_start] + cluster_table + report[cluster_end:]

old_gate = (
    'No code or plan change is proposed by this report. Prioritisation remains: complete already-planned correctness and performance slices through their existing gates; sequence Usage data before its graphs; preserve W5 and W6 gates; and require evidence of an actual Neokod gap before opening any additional feature work.'
)
new_gate = (
    'No code or plan change is proposed by this report. Formal core exit remains OPEN under plan §16.19; W6-C1–C3 remain CLOSED until that exit, then C4–C6 retain their specified stop/restart and supported-runtime proof gates. W5 owner-machine continuity remains separately gated by token authentication, visible target/repository pinning and no-fallback rules. Section 13.2 continues to hold the Usage/cost dashboard and other features outside tracks A–C; this F5 backlog is unassessed and is not implementation approval. Upstream UI remains excluded and Neokod-owned UI is required.'
)
report = replace_once(report, old_gate, new_gate, 'final gate statement')

# Keep the 13433 F9 intent as reference in the supplied example paragraph.
report = replace_once(
    report,
    'The same correction separates the web Stop-control intent in [#13433](https://github.com/pingdotgg/t3code/pull/13433), branch synchronization in',
    'The same correction keeps [#13433](https://github.com/pingdotgg/t3code/pull/13433) as UI-excluded while recording Stop-during-start only as lifecycle reference intent; branch synchronization in',
    '13433 narrative status',
)

# Recompute the opening disposition counts after all corrections.
final_disposition_counts = dict(disposition_counts)
assert final_disposition_counts.get('candidate-port-intent', 0) == 773
assert final_disposition_counts.get('feature-gap-proposal', 0) == 142
assert final_disposition_counts.get('backend-backlog-unassessed', 0) == 593
assert final_disposition_counts.get('needs-human-triage', 0) == 5

# Capture row-level F9 before/after states and F2b/F5 summaries in the existing receipt.
current_row_by_num = {row['number']: row for row in rows}
f5_mixed_rows = [n for n in f5_candidates if current_row_by_num[n]['disposition'] == BACKLOG_DISPOSITION]
f5_exception_rows = [n for n in f5_candidates if current_row_by_num[n]['disposition'] != BACKLOG_DISPOSITION]
assert len(f5_mixed_rows) == 245 and len(f5_exception_rows) == 59

f9_receipt = {
    '2829': {
        'beforeReason': reason_2829_before,
        'afterReason': row_2829['reason'],
        'disposition': row_2829['disposition'],
        'neokodStatus': row_2829['neokodStatus'],
        'reasonConsistentWithDisposition': 'feature-gap-proposal' in row_2829['reason'] and 'No rule produced' not in row_2829['reason'],
        'authorizationChanged': False,
    },
    '13433': {
        'beforeReason': reason_13433_before,
        'afterReason': row_13433['reason'],
        'category': row_13433['category'],
        'disposition': row_13433['disposition'],
        'featureCluster': row_13433['featureCluster'],
        'neokodStatus': row_13433['neokodStatus'],
        'stopDuringStartLifecycleIntent': 'reference-only',
        'upstreamUI': 'excluded-policy-ui',
        'localDefectOrParityAsserted': False,
    },
}

source_ids_preserved = all(
    source_sample_snapshot(current_row_by_num[n]) == source_sample_snapshot(original_rows[n])
    for n in f5_candidates
)
assert source_ids_preserved
assert source_sample_snapshot(current_row_by_num[14290]) == source_sample_snapshot(original_rows[14290])

receipt['opusExtensions'] = {
    'scope': 'bounded F5 complete-list re-triage plus F2b parent-branch inference and F9 wording/reference consistency; no recensus or full-diff audit',
    'currentNeokodSourceHead': CURRENT_NEOKOD_HEAD,
    'sourceCommitNote': 'The latest HEAD was read from the repository; the captured Opus review states the intervening commit changes Codex app-server schema/generator/test paths not cited by the existing 3b134e4 source comparisons. Those per-row comparisons were not re-run.',
    'F5_mixed_complete_listings': {
        'opusReviewSnapshotCountsIncludingTruncated': {
            'mobile-excluded': 45,
            'ui-excluded': 163,
            'desktop-shell': 40,
            'cloud-connect-relay-excluded': 60,
            'total': 308,
        },
        'currentCompleteListCountsAfterF1': dict(expected_complete_counts),
        'completeRowsReviewed': len(f5_candidates),
        'mixedExcludedBackendUnassessedRows': len(f5_mixed_rows),
        'definitiveMobileOnlyExcludedRows': len(MOBILE_ONLY_EXCEPTIONS),
        'definitiveHostedOnlyExcludedRows': len(cloud_candidates - set(CLOUD_MIXED_EXCEPTIONS)),
        'countsByAssessment': dict(f5_assessment_counts),
        'truncatedRowsWithBackendPathsFromOriginalSnapshot': all_truncated_excluded_with_backend,
        'truncatedRowsStillUnderF1Boundary': [5533, 13998, 20285],
        'truncatedBareConnectCorrectionAppliedSeparately': [14290],
        'sourceSampleAndCoverageFieldsPreserved': source_ids_preserved,
        'completePathsAreNotFullDiffReads': True,
        'commaSeparatedTitleScopesSplit': True,
        'noCandidateAutopromotion': all(
            current_row_by_num[n]['disposition'] == BACKLOG_DISPOSITION
            for n in f5_mixed_rows
        ),
        'hostedOnlyPredicateAudit': hosted_only_predicate_audit,
        'items': f5_items,
    },
    'bare_connect_keyword_review': {
        'rule': 'A bare “connect” title token is not evidence of T3 Connect, relay or hosted infrastructure.',
        'reviewedTitleRows': keyword_rows,
        'reclassifiedRows': [
            {'number': item['number'], 'decision': item['decision']}
            for item in connect_reviews if item['decision'] != 'retained-explicit-hosted-evidence'
        ],
        'retainedWithSeparateHostedEvidence': [
            {'number': item['number'], 'basis': item['basis']}
            for item in connect_reviews if item['decision'] == 'retained-explicit-hosted-evidence'
        ],
        'items': connect_reviews,
    },
    'F2b_stacked_parent_association': {
        'latestPinnedTag': LATEST_NIGHTLY,
        'latestPinnedCommit': LATEST_NIGHTLY_COMMIT,
        'stackedRowsWithChildCommitNotObserved': len(stacked_not_observed),
        'parentAssociatedRows': parent_association_counts['direct-parent-reachable'] + parent_association_counts['parent-chain-reachable'],
        'directParentReachableRows': parent_association_counts['direct-parent-reachable'],
        'oneHopParentChainRows': parent_association_counts['parent-chain-reachable'],
        'unresolvedWithoutCensusParentHeadMatch': parent_association_counts['unresolved'],
        'directChildrenOf2829AmongTheseRows': parent_association_counts['direct-child-of-2829'],
        'associationRule': 'A child baseRef exactly matches a census parent headRef; parent chains are followed until a merge commit is reachable in the retained date-bounded nightly history.',
        'childReachabilityFieldPreservedAsNotObserved': all(
            current_row_by_num[item['number']]['latestNightlyReachability'] == 'not-observed-in-date-bounded-inspected-history'
            for item in parent_association_rows
        ),
        'parentReachabilityIsInferenceNotExactContentInclusion': True,
        'rows': parent_association_rows,
    },
    'F9_reason_and_reference_consistency': f9_receipt,
}

# Update F1's readable row summary only for #14290's later F5 classification overlay;
# all F1 source-layer/sample fields and the historical F1 receipt snapshot stay unchanged.
trunc_audit_path = WORK / 'truncation-audit.md'
trunc_audit = trunc_audit_path.read_text()
old_14290_row = '| [#14290](https://github.com/pingdotgg/t3code/pull/14290) feat(codex): connect ChatGPT accounts with managed authentication | 120 | 100 | web / excluded-policy-cloud-connect | cloud-connect-relay-excluded / excluded-policy-cloud-connect | usage-limits-accounts |'
new_14290_row = '| [#14290](https://github.com/pingdotgg/t3code/pull/14290) feat(codex): connect ChatGPT accounts with managed authentication | 120 | 100 | web / excluded-policy-cloud-connect | mixed-truncated-unassessed / backend-backlog-unassessed (F5 keyword correction; F1 source fields unchanged) | usage-limits-accounts |'
if old_14290_row in trunc_audit:
    trunc_audit = replace_once(trunc_audit, old_14290_row, new_14290_row, 'truncation audit #14290 overlay')
trunc_audit = replace_once(
    trunc_audit,
    'The correction matrix in `truncation-corrections.json` preserves before/after fields and each source-coverage note. Its prior sample layer is reconstructed from the retained `sampledTopSourceLayer`, with earlier categories/dispositions from retained census inputs and the prior curated override subset. It is not a byte-for-byte copy of the earlier emitted ledger. The broader F1–F4 correction receipt is `evidence/audit-correction-receipt-2026-10-24.json`.',
    'The correction matrix in `truncation-corrections.json` preserves the historical F1 before/after fields and each source-coverage note. #14290 later received a separate F5 keyword correction to its category/disposition; its first-100 sample, mixed/unknown overall layer and coverage note were not changed. The prior sample layer is reconstructed from retained `sampledTopSourceLayer`, with earlier categories/dispositions from the prior curated override subset. It is not a byte-for-byte copy of the earlier emitted ledger. The F1–F4 and Opus extension receipt is `evidence/audit-correction-receipt-2026-10-24.json`.',
    'truncation audit final note',
)

# Validate row-to-census identity and CSV schema before writing.
assert {row['number'] for row in rows} == {row['number'] for row in read_json(RAW_JSON)}
fields = list(rows[0].keys())
assert all(list(row.keys()) == fields for row in rows)

# Write final Sonnet-owned artifacts.
write_json(LEDGER_JSON, rows)
with LEDGER_CSV.open('w', newline='') as handle:
    writer = csv.DictWriter(handle, fieldnames=fields)
    writer.writeheader()
    for row in rows:
        writer.writerow({
            key: json.dumps(value, ensure_ascii=False, separators=(',', ':'))
            if isinstance(value, (dict, list)) else value
            for key, value in row.items()
        })
write_json(RECEIPT_JSON, receipt)
REPORT_MD.write_text(report)
trunc_audit_path.write_text(trunc_audit)

# Re-read saved artifacts and write an independent artifact-validation receipt.
final_rows = read_json(LEDGER_JSON)
final_by_number = {row['number']: row for row in final_rows}
with LEDGER_CSV.open(newline='') as handle:
    csv_rows = list(csv.DictReader(handle))
assert len(final_rows) == len(csv_rows) == 3927
assert [int(row['number']) for row in csv_rows] == [row['number'] for row in final_rows]
assert len({row['number'] for row in final_rows}) == 3927
assert len([row for row in final_rows if row['filesTruncated']]) == 61
assert len([row for row in final_rows if row['filesUnavailable']]) == 5
assert collections.Counter(row['latestNightlyReachability'] for row in final_rows) == latest_counts
assert all(
    final_by_number[item['number']]['stackedParentPRAssociation'] is not None
    for item in parent_association_rows
)
assert all(
    source_sample_snapshot(final_by_number[n]) == source_sample_snapshot(original_rows[n])
    for n in f5_candidates + [14290]
)
assert all(final_by_number[n]['disposition'] == BACKLOG_DISPOSITION for n in f5_mixed_rows + [14290])
assert final_by_number[2829]['reason'] == row_2829['reason']
assert final_by_number[13433]['category'] == 'ui-excluded'
assert final_by_number[13433]['disposition'] == 'excluded-policy-ui'

validation = {
    'date': '2026-10-24',
    'scope': 'artifact validation only; no app tests, builds, installs or provider/runtime actions',
    'checks': {
        'ledgerJSONValid': True,
        'ledgerCSVValidAndSameRowIDs': True,
        'all3927CensusIDsPreserved': True,
        'statusCountsPreserved': dict(status_counts),
        'latestNightlyDirectReachabilityCountsPreserved': dict(latest_counts),
        'F1TruncatedRowsRemainMixedUnknownWithSamples': len(truncated) == 61 and all(row['sourceLayerAssessment'] == 'mixed-or-unknown' for row in truncated),
        'F3UnavailableMetricsRemainNull': len(unavailable) == 5 and all(row['changedFiles'] is None and row['additions'] is None and row['deletions'] is None for row in unavailable),
        'F4UnmergedWordingRetained': all(row['reason'].startswith('UNMERGED (this PR was not merged;') for row in rows if row['mergedStatus'] == 'closed-unmerged'),
        'F5CompleteCandidateCount': len(f5_candidates),
        'F5MixedBackendUnassessedCount': len(f5_mixed_rows),
        'F5DefinitiveExclusionCount': len(f5_exception_rows),
        'F5NoCandidateOrGapPromotion': all(final_by_number[n]['disposition'] == BACKLOG_DISPOSITION for n in f5_mixed_rows),
        'F5SourceSampleFieldsPreserved': source_ids_preserved and source_sample_snapshot(final_by_number[14290]) == source_sample_snapshot(original_rows[14290]),
        'F5HostedPredicateRowsAudited': len(prior_hosted_only_ids) == 44,
        'F5HostedOnlyExplicitEvidenceRows': len([row for row in hosted_predicate_rows if row['decision'] == 'retained-hosted-only']) == 43,
        'F5HostedOnlyUnsupportedRowsReclassified': [row['number'] for row in hosted_predicate_rows if row['decision'] == 'reclassified-mixed-backend-unassessed'],
        'F2bParentAssociatedRows': parent_association_counts['direct-parent-reachable'] + parent_association_counts['parent-chain-reachable'],
        'F2bUnresolvedRows': parent_association_counts['unresolved'],
        'F2bChildReachabilityNotOverwritten': all(final_by_number[item['number']]['latestNightlyReachability'] == 'not-observed-in-date-bounded-inspected-history' for item in parent_association_rows),
        'F9_2829ReasonConsistent': 'No rule produced' not in final_by_number[2829]['reason'] and final_by_number[2829]['disposition'] == 'feature-gap-proposal',
        'F9_13433UIStillExcluded': final_by_number[13433]['category'] == 'ui-excluded' and final_by_number[13433]['disposition'] == 'excluded-policy-ui',
        'LunaMatrixFilesNotTouched': True,
        'RepositoryFilesNotTouched': True,
    },
    'finalCounts': {
        'rows': len(final_rows),
        'dispositions': dict(disposition_counts),
        'sourceLayerAssessment': dict(source_counts),
        'evidenceDepth': evidence_counts,
        'bareConnectTitleRowsReviewed': len(keyword_rows),
    },
    'sha256': {
        'all-pr-dispositions.json': hashlib.sha256(LEDGER_JSON.read_bytes()).hexdigest(),
        'all-pr-dispositions.csv': hashlib.sha256(LEDGER_CSV.read_bytes()).hexdigest(),
        't3-feature-gap-report.md': hashlib.sha256(REPORT_MD.read_bytes()).hexdigest(),
        'audit-correction-receipt-2026-10-24.json': hashlib.sha256(RECEIPT_JSON.read_bytes()).hexdigest(),
        'scripts/apply_opus_extensions.py': hashlib.sha256((WORK / 'scripts/apply_opus_extensions.py').read_bytes()).hexdigest(),
        'scripts/refine_opus_f5_cloud_mixed.py': hashlib.sha256((WORK / 'scripts/refine_opus_f5_cloud_mixed.py').read_bytes()).hexdigest(),
    },
}
assert all(value is not False for value in validation['checks'].values())
receipt['opusExtensions']['validationSummary'] = {
    'allChecksPassed': True,
    'rowCount': 3927,
    'F5CompleteRows': len(f5_candidates),
    'F5MixedUnassessedRows': len(f5_mixed_rows),
    'F5HostedPredicateRowsAudited': len(prior_hosted_only_ids),
    'F5HostedOnlyExplicitEvidenceRows': len([row for row in hosted_predicate_rows if row['decision'] == 'retained-hosted-only']),
    'F5HostedOnlyUnsupportedRowsReclassified': [row['number'] for row in hosted_predicate_rows if row['decision'] == 'reclassified-mixed-backend-unassessed'],
    'F2bParentAssociated': parent_association_counts['direct-parent-reachable'] + parent_association_counts['parent-chain-reachable'],
    'F2bUnresolved': parent_association_counts['unresolved'],
}
write_json(RECEIPT_JSON, receipt)
validation['sha256']['audit-correction-receipt-2026-10-24.json'] = hashlib.sha256(RECEIPT_JSON.read_bytes()).hexdigest()
write_json(VALIDATION_JSON, validation)

print(json.dumps({
    'F5CompleteRows': len(f5_candidates),
    'F5Assessments': dict(f5_assessment_counts),
    'F2bParentAssociation': dict(parent_association_counts),
    'bareConnectRows': len(keyword_rows),
    'finalDispositionCounts': dict(disposition_counts),
    'evidenceDepth': evidence_counts,
    'validation': str(VALIDATION_JSON),
}, ensure_ascii=False, indent=2))
