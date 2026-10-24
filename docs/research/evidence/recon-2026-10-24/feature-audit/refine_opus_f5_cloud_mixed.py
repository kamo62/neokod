#!/usr/bin/env python3
"""Apply the bounded Sol correction to F5's hosted-only exception predicate."""
import collections
import csv
import hashlib
import json
import re
from pathlib import Path

BASE = Path('/tmp/neokod-feature-audit-2026-10-24')
WORK = BASE / 'sonnet'
LEDGER = WORK / 'all-pr-dispositions.json'
CSV = WORK / 'all-pr-dispositions.csv'
REPORT = WORK / 't3-feature-gap-report.md'
RECEIPT = WORK / 'evidence/audit-correction-receipt-2026-10-24.json'
VALIDATION = WORK / 'evidence/opus-extension-validation-2026-10-24.json'
LABELS = WORK / 'cluster-labels.json'
RAW = BASE / 'all-closed-prs.json'

# Twelve previous F5 cloud rows already moved to mixed in the first F5 refinement.
PREVIOUS_CLOUD_MIXED = {
    5463, 13774, 14413, 15002, 15085, 15088, 17599, 17602,
    18820, 19160, 20447, 21156, 22194, 22234, 23454,
}
REASSESS = {
    13774: (
        ['T3 Connect awareness relay'],
        'T3 Connect awareness-relay retry behavior remains excluded; provider-session reaping, stopped-row filtering and idle-loop work are separate local server behavior and remain unassessed.',
    ),
    14413: (
        ['hosted relay tracing'],
        'Hosted relay tracing remains excluded; shared telemetry opt-out and desktop/server configuration semantics are retained for backend triage, not promoted.',
    ),
    15085: (
        ['upstream webhook automation UI', 'hosted T3 Connect URL variant'],
        'Upstream webhook automation UI and the hosted T3 Connect URL variant remain excluded; the server webhook endpoint/schedule/verification behavior also supports a direct environment address and remains unassessed.',
    ),
    15088: (
        ['upstream webhook editor/delivery UI', 'hosted URL presentation'],
        'Upstream webhook editor/delivery UI and hosted URL presentation remain excluded; client-runtime environment-address/webhook state is retained as unassessed.',
    ),
    17599: (
        ['T3 Connect remote transport context'],
        'T3 Connect remote transport is an observed context, not the only use of the shared signed HTTP loaders; direct owner-server request URL correctness remains unassessed.',
    ),
    17602: (
        ['relay request-authentication slice'],
        'Relay request authentication is an excluded slice; shared signed-URL construction for direct owner-server endpoints remains unassessed.',
    ),
    18820: (
        ['hosted webhook delivery'],
        'Hosted webhook delivery is excluded; server-side claim release on failed acceptance is retained as unassessed local dispatch correctness.',
    ),
    19160: (
        ['webhook automation feature surface'],
        'Webhook automation remains an excluded feature slice; the synchronous server prompt parser behavior also applies to direct delivery and remains unassessed.',
    ),
    20447: (
        ['webhook task admission/UI'],
        'Webhook task admission/UI is excluded; server-side framing of untrusted request values is retained as unassessed security behavior.',
    ),
    21156: (
        ['T3 Connect hosted transport', 'upstream device UI'],
        'T3 Connect hosted transport and upstream device UI remain excluded; the DeviceHubProxy change also applies to Tailscale Serve/direct owner-host access and remains unassessed.',
    ),
    22194: (
        ['hosted webhook URL/relay delivery'],
        'Hosted webhook URL/relay delivery is excluded; server-side event-filter semantics for direct environment endpoints remain unassessed.',
    ),
    22234: (
        ['hosted webhook URL/relay delivery'],
        'Hosted webhook URL/relay delivery is excluded; server-side replay dedupe/coalescing for direct environment endpoints remains unassessed.',
    ),
    23282: (
        [],
        'The body gives a GitHub webhook filter example and mentions filtering noise at a relay, but the complete backend path list contains only local server filter/template/MCP/contract code. No hosted T3 Connect, Clerk, Cloudflare, managed-tunnel or relay-infrastructure dependency is established; backend intent stays unassessed.',
    ),
}

TEXT_SIGNALS = {
    'explicit T3 Connect': re.compile(r'\bt3\s*connect\b', re.I),
    'Clerk identity/authentication': re.compile(r'\bclerk\b', re.I),
    'Cloudflare/cloudflared managed transport': re.compile(r'cloudflare|cloudflared', re.I),
    'managed tunnel/endpoint': re.compile(r'managed tunnel|managed endpoint|tunnel-linked|tunnel link|tunnel allocation', re.I),
    'hosted agent/client': re.compile(r'hosted (?:agent|bot|app|client)', re.I),
    'explicit relay service operation': re.compile(
        r'relay client|relay worker|relay-signed|relay\.t3\.codes|relay endpoint|relay allocation|'
        r'relay api|relay credentials|relay authorization|relay tracing|relay inbox|managed relay|cloudlink',
        re.I,
    ),
}
PATH_SIGNALS = {
    'relay deployment/contract path': re.compile(
        r'^(?:infra/relay/|apps/relay/)|^packages/(?:contracts/src/relay|shared/src/relay(?:Client|Jwt|Signing|Tracing)|client-runtime/src/relay/)',
        re.I,
    ),
    'server hosted-link/endpoint path': re.compile(
        r'^apps/server/src/cloud/(?:CloudLink|CloudPreferences|ManagedEndpoint|managedTunnel|CliTokenManager|traceRelayRequest|CliState|relayResponse|ConnectReachability)',
        re.I,
    ),
    'server relay-specific path': re.compile(
        r'^apps/server/src/relay/(?:AgentAwarenessRelay|HeldHooksWaker|RelayDeliveryProof|relayEnvironmentClient)',
        re.I,
    ),
}


def load(path):
    return json.loads(path.read_text())


def append_note(existing, note):
    existing = (existing or '').strip()
    return existing if note in existing else f'{existing} {note}'.strip()


def hosted_signals(title, body, paths):
    text = f'{title}\n{body or ""}'
    signals = [name for name, pattern in TEXT_SIGNALS.items() if pattern.search(text)]
    for name, pattern in PATH_SIGNALS.items():
        matching = [path for path in paths if pattern.search(path)]
        if matching:
            signals.append(f'{name}: {", ".join(matching)}')
    return signals


def render_table(rows, labels):
    clusters = collections.defaultdict(list)
    for row in rows:
        clusters[row['featureCluster']].append(row)
    lines = [
        '| Cluster | PRs | Merged main | Merged stacked | Closed unmerged | Port intent | Gap proposal | Backlog unassessed | Other |',
        '| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- |',
    ]
    for cluster in sorted(clusters, key=lambda key: (-len(clusters[key]), key)):
        members = clusters[cluster]
        counts = collections.Counter(member['disposition'] for member in members)
        other_counts = {
            key: value for key, value in counts.items()
            if key not in ('candidate-port-intent', 'feature-gap-proposal', 'backend-backlog-unassessed')
        }
        other = ', '.join(f'{key} {value}' for key, value in sorted(other_counts.items())) or 'none'
        lines.append(
            f"| {labels.get(cluster, cluster)} (`{cluster}`) | {len(members)} | "
            f"{sum(member['mergedStatus'] == 'merged-main' for member in members)} | "
            f"{sum(member['mergedStatus'] == 'merged-stacked-branch' for member in members)} | "
            f"{sum(member['mergedStatus'] == 'closed-unmerged' for member in members)} | "
            f"{counts.get('candidate-port-intent', 0)} | {counts.get('feature-gap-proposal', 0)} | "
            f"{counts.get('backend-backlog-unassessed', 0)} | {other} |"
        )
    return '\n'.join(lines)


rows = load(LEDGER)
by_number = {row['number']: row for row in rows}
raw_by_number = {row['number']: row for row in load(RAW)}
receipt = load(RECEIPT)
validation = load(VALIDATION)
report = REPORT.read_text()
f5 = receipt['opusExtensions']['F5_mixed_complete_listings']
items = {item['number']: item for item in f5['items']}

# Preserve the exact prior exception cohort even on repeated runs.
prior_audit = f5.get('hostedOnlyPredicateAudit')
if prior_audit:
    prior_hosted_ids = prior_audit['reviewedPriorHostedOnlyRows']
else:
    prior_hosted_ids = sorted(
        item['number'] for item in f5['items']
        if item['assessment'] == 'explicit-hosted-only-exclusion'
    )
assert len(prior_hosted_ids) == 44 and 23282 in prior_hosted_ids

for number, (excluded_slices, basis) in REASSESS.items():
    row = by_number[number]
    review = row['f5MixedListingAssessment']
    assert review['before']['category'] == 'cloud-connect-relay-excluded'
    assert review['assessment'] in ('explicit-hosted-only-exclusion', 'mixed-excluded-backend-unassessed')
    old_note = (
        'F5 complete-list review retained the row-level exclusion because the captured paths/body '
        'support the hosted only exclusion slice; backend paths are support for that excluded slice, '
        'not an independently assessed Neokod port.'
    )
    row['auditNote'] = (row.get('auditNote') or '').replace(old_note, '').strip()
    row['category'] = 'mixed-excluded-backend-unassessed'
    if number == 23282:
        row['categoryReason'] = (
            'Complete changed-file list shows backend webhook filter/template, MCP-tool and contract paths, '
            'but the captured title/body/path evidence does not establish a hosted-only dependency. '
            'Backend intent remains unassessed; this is not a line-by-line diff review.'
        )
        row['reason'] = (
            'A GitHub webhook example and a generic relay reference do not establish hosted-only dependency. '
            'Backend webhook filter/template/MCP contract paths remain unassessed; no candidate-port or '
            'feature-gap conclusion is inferred.'
        )
        row['neokodStatusBasis'] = (
            'No hosted T3 Connect, Clerk, Cloudflare/cloudflared, managed-tunnel or specific relay-infrastructure '
            'dependency is established by the retained evidence; backend parity is unassessed.'
        )
        row['auditNote'] = append_note(
            row.get('auditNote'),
            'F5 hosted-only predicate correction: a GitHub issue_comment webhook example and generic relay '
            'reference do not establish hosted dependency. Backend filter/template/MCP/contract paths remain '
            'unassessed; no candidate/gap promotion.',
        )
    else:
        row['categoryReason'] = (
            'Complete changed-file list contains both an excluded hosted/UI slice and backend product paths. '
            'Keep the excluded slice out of scope; assess the backend slice separately. This is not a line-by-line diff review.'
        )
        prefix = ''
        if row['mergedStatus'] == 'closed-unmerged':
            prefix = (
                f"UNMERGED (this PR was not merged; closure class: {row.get('closureClass', 'unknown')}). "
                'Equivalent intent may exist elsewhere and was not inferred from this status. '
            )
        row['reason'] = prefix + (
            f"Mixed listing: excluded slice(s) {', '.join(excluded_slices)} remain excluded by policy; "
            f"{len(review['backendProductPaths'])} sampled backend product path(s) remain unassessed in the owner-triage backlog. "
            'No candidate-port or feature-gap conclusion is inferred.'
        )
        row['neokodStatusBasis'] = (
            'Backend product paths were not individually compared against Neokod; the excluded hosted/UI surface '
            'does not establish backend exclusion or parity.'
        )
        row['auditNote'] = append_note(
            row.get('auditNote'),
            f"F5 mixed complete listing: excludedSlices={'; '.join(excluded_slices)}; "
            f"{len(review['backendProductPaths'])} backend product path(s) retained as unassessed. "
            'Original complete path list and source-layer sample fields are preserved; no candidate/gap promotion.',
        )
    row['disposition'] = 'backend-backlog-unassessed'
    row['neokodStatus'] = 'not-assessed'
    review['assessment'] = 'mixed-excluded-backend-unassessed'
    review['excludedSlices'] = excluded_slices
    review['decisionBasis'] = basis
    review['candidatePromotion'] = False
    review['after'] = {key: row[key] for key in (
        'category', 'categoryReason', 'featureCluster', 'disposition', 'reason', 'neokodStatus', 'neokodStatusBasis'
    )}
    item = items[number]
    item['assessment'] = review['assessment']
    item['excludedSlices'] = excluded_slices
    item['decisionBasis'] = basis
    item['after'] = review['after']

# Verify each row in the previous 44-row hosted-only exception cohort. Only #23282
# has no independent hosted signal; its body contains examples, not a hosted dependency.
predicate_rows = []
for number in prior_hosted_ids:
    item = items[number]
    row = by_number[number]
    body = raw_by_number[number].get('body') or ''
    signals = hosted_signals(row['title'], body, item['backendProductPaths'])
    if number == 23282:
        assert not signals
        decision = 'reclassified-mixed-backend-unassessed'
        generic_examples = ['GitHub issue_comment/webhook request example', 'generic relay reference in example text']
        assert item['assessment'] == 'mixed-excluded-backend-unassessed'
    else:
        assert signals, f'Hosted-only exception lacks explicit evidence: #{number}'
        decision = 'retained-hosted-only'
        generic_examples = []
        assert item['assessment'] == 'explicit-hosted-only-exclusion'
    review = {
        'predicateVersion': 'hosted-only-explicit-evidence-v2',
        'decision': decision,
        'strongHostedEvidenceSignals': signals,
        'insufficientExamples': generic_examples,
    }
    row['f5MixedListingAssessment']['hostedOnlyPredicateReview'] = review
    item['hostedOnlyPredicateReview'] = review
    predicate_rows.append({
        'number': number,
        'title': row['title'],
        'decision': decision,
        'strongHostedEvidenceSignals': signals,
        'insufficientExamples': generic_examples,
        'backendProductPaths': item['backendProductPaths'],
    })

counts = collections.Counter(row['disposition'] for row in rows)
assessment_counts = collections.Counter(item['assessment'] for item in f5['items'])
assert assessment_counts == {
    'mixed-excluded-backend-unassessed': 245,
    'explicit-mobile-only-exclusion': 16,
    'explicit-hosted-only-exclusion': 43,
}, assessment_counts
f5['mixedExcludedBackendUnassessedRows'] = 245
f5['definitiveHostedOnlyExcludedRows'] = 43
f5['countsByAssessment'] = dict(assessment_counts)
f5['additionalMixedHostedCategoryRows'] = sorted(set(REASSESS) | set(f5.get('additionalMixedHostedCategoryRows', [])))
f5['noCandidateAutopromotion'] = all(
    by_number[item['number']]['disposition'] == 'backend-backlog-unassessed'
    for item in f5['items'] if item['assessment'] == 'mixed-excluded-backend-unassessed'
)
f5['hostedOnlyPredicateAudit'] = {
    'reviewedPriorHostedOnlyRows': prior_hosted_ids,
    'reviewedCount': 44,
    'retainedWithExplicitHostedEvidence': 43,
    'reclassifiedBecauseOnlyGenericWebhookOrRelayExamplesWereAvailable': [23282],
    'predicate': 'Require explicit T3 Connect, Clerk, Cloudflare/cloudflared, managed-tunnel/endpoint, hosted-agent/client evidence, or a specific relay implementation path whose hosted role is established. Generic webhook/relay examples alone are insufficient.',
    'rows': predicate_rows,
}
assert counts['backend-backlog-unassessed'] == 593

old_f5 = (
    'Of the 304 complete-list rows, **244** are now explicitly `mixed-excluded-backend-unassessed` / `backend-backlog-unassessed`: '
    'mobile 29, UI 161, desktop shell 39, and cloud 15. **60** remain row-level exclusions because their captured paths and feature scope '
    'support an explicit mobile-only (16) or hosted-only (44) slice.'
)
new_f5 = (
    'Of the 304 complete-list rows, **245** are now explicitly `mixed-excluded-backend-unassessed` / `backend-backlog-unassessed`: '
    'mobile 29, UI 161, desktop shell 39, and cloud 16. **59** remain row-level exclusions because their captured paths and feature scope '
    'support an explicit mobile-only (16) or hosted-only (43) slice.'
)
if old_f5 in report:
    report = report.replace(old_f5, new_f5, 1)
else:
    assert report.count(new_f5) == 1
old_cloud_detail = (
    'Comma-separated title scopes are split before interpretation; for example, #21473\'s `server,mobile` scope is represented as both scopes and its actual server paths are retained. '
    'A bare `connect` token is not treated as T3 Connect evidence. Generic connection/compatibility rows #15002 and #23454 are mixed and unassessed; #14290 is a truncated mixed account/usage row with OpenAI OAuth, remote credential transfer, PostHog and UI/mobile slices excluded, not a T3 Connect claim. '
    'UI/compiler-only #7903, #19400, #20491, #20622 and #20639 are labelled by their UI/tooling evidence, not by the word “connect”. Additional cloud-category mixed rows include #13774 provider-session reaping, #14413 telemetry opt-out, #15085/#15088 direct webhook paths, #17599/#17602 shared signed-HTTP loaders, #18820/#19160/#20447 webhook dispatch/parser/security behavior, #21156 Tailscale-capable device proxy, and #22194/#22234 webhook filter/dedupe semantics. Hosted/relay/UI slices remain excluded; all these backend paths remain unassessed, with no candidate or gap promotion.'
)
new_cloud_detail = (
    'Comma-separated title scopes are split before interpretation; for example, #21473\'s `server,mobile` scope is represented as both scopes and its actual server paths are retained. '
    'A bare `connect` token is not treated as T3 Connect evidence. Generic connection/compatibility rows #15002 and #23454 are mixed and unassessed; #14290 is a truncated mixed account/usage row with OpenAI OAuth, remote credential transfer, PostHog and UI/mobile slices excluded, not a T3 Connect claim. '
    'UI/compiler-only #7903, #19400, #20491, #20622 and #20639 are labelled by their UI/tooling evidence, not by the word “connect”. The 44 prior hosted-only exceptions were rechecked against explicit evidence: 43 retain independent T3 Connect, Clerk, Cloudflare/cloudflared, managed-tunnel/hosted-agent, or specific relay-infrastructure evidence. #23282 is mixed because its GitHub webhook and relay examples do not establish a hosted dependency; its backend filters/templates/MCP contract paths remain unassessed. Other mixed backend rows include #13774, #14413, #15085/#15088, #17599/#17602, #18820/#19160/#20447, #21156 and #22194/#22234. No mixed row is promoted to a candidate or gap.'
)
if old_cloud_detail in report:
    report = report.replace(old_cloud_detail, new_cloud_detail, 1)
else:
    assert report.count(new_cloud_detail) == 1
report = report.replace('592 backend items retained as unassessed backlog', '593 backend items retained as unassessed backlog')
report = report.replace('2415 other policy/reference/noise dispositions', '2414 other policy/reference/noise dispositions')

labels = load(LABELS)
cluster_table = render_table(rows, labels)
cluster_start = report.index('| Cluster | PRs |')
cluster_end = report.index('\n\n## Companion competitor evidence and limits', cluster_start)
report = report[:cluster_start] + cluster_table + report[cluster_end:]

validation['checks']['F5MixedBackendUnassessedCount'] = 245
validation['checks']['F5DefinitiveExclusionCount'] = 59
validation['checks']['F5HostedPredicateRowsAudited'] = 44
validation['checks']['F5HostedOnlyExplicitEvidenceRows'] = 43
validation['checks']['F5HostedOnlyUnsupportedRowsReclassified'] = [23282]
validation['checks']['F5NoCandidateOrGapPromotion'] = True
validation['finalCounts']['dispositions'] = dict(counts)
validation['checks']['F5CompleteCandidateCount'] = 304
validation['checks']['F5SourceSampleFieldsPreserved'] = True
receipt['opusExtensions']['validationSummary'].update({
    'F5MixedUnassessedRows': 245,
    'F5DefinitiveExclusionRows': 59,
    'F5HostedPredicateRowsAudited': 44,
    'F5HostedOnlyExplicitEvidenceRows': 43,
    'F5HostedOnlyUnsupportedRowsReclassified': [23282],
    'finalBackendBacklogRows': counts['backend-backlog-unassessed'],
})

# Persist Sonnet-owned artifacts and hashes.
LEDGER.write_text(json.dumps(rows, ensure_ascii=False, indent=2) + '\n')
fields = list(rows[0].keys())
with CSV.open('w', newline='') as handle:
    writer = csv.DictWriter(handle, fieldnames=fields)
    writer.writeheader()
    for row in rows:
        writer.writerow({key: json.dumps(value, ensure_ascii=False, separators=(',', ':')) if isinstance(value, (dict, list)) else value for key, value in row.items()})
REPORT.write_text(report)
RECEIPT.write_text(json.dumps(receipt, ensure_ascii=False, indent=2) + '\n')
validation['sha256'] = {
    'all-pr-dispositions.json': hashlib.sha256(LEDGER.read_bytes()).hexdigest(),
    'all-pr-dispositions.csv': hashlib.sha256(CSV.read_bytes()).hexdigest(),
    't3-feature-gap-report.md': hashlib.sha256(REPORT.read_bytes()).hexdigest(),
    'audit-correction-receipt-2026-10-24.json': hashlib.sha256(RECEIPT.read_bytes()).hexdigest(),
    'scripts/apply_opus_extensions.py': hashlib.sha256((WORK / 'scripts/apply_opus_extensions.py').read_bytes()).hexdigest(),
    'scripts/refine_opus_f5_cloud_mixed.py': hashlib.sha256((WORK / 'scripts/refine_opus_f5_cloud_mixed.py').read_bytes()).hexdigest(),
}
VALIDATION.write_text(json.dumps(validation, ensure_ascii=False, indent=2) + '\n')

# Re-read the final artifacts.
final_rows = load(LEDGER)
with CSV.open(newline='') as handle:
    csv_rows = list(csv.DictReader(handle))
assert len(final_rows) == len(csv_rows) == 3927
assert [int(row['number']) for row in csv_rows] == [row['number'] for row in final_rows]
assert collections.Counter(row['disposition'] for row in final_rows)['backend-backlog-unassessed'] == 593
assert len(f5['items']) == 304
assert assessment_counts == {'mixed-excluded-backend-unassessed':245,'explicit-mobile-only-exclusion':16,'explicit-hosted-only-exclusion':43}
print(json.dumps({'auditedPriorHostedOnlyRows':44,'retainedWithExplicitEvidence':43,'reclassifiedMixed':[23282],'F5CompleteMixed':245,'F5ExcludedOnly':59,'backendBacklog':593,'validation':str(VALIDATION)},indent=2))
