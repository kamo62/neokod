I’ll review the exact diff, its callers, and relevant tests against the stated scope. I won’t run tests, builds, providers, or modify files.The diff stays within the seven scoped files, and the dispatcher preserves the original generation inputs. I found two gaps to trace through callers: admission ignores snapshot readiness/authentication, and Settings receives a server-resolved fallback that may already hide the persisted auxiliary selection.# FIX

Reviewed `43d538e14` against `032a7ceab`, including the seven-file diff, requested scope documents, and relevant callers/tests. No edits, tests, builds, installs, provider requests, or process-control actions were performed. Claimed validation results remain reported evidence—not runtime acceptance.

## Findings

### P1 — Failed/pending snapshots can authorize execution or manufacture negative catalogue evidence

**References:** `apps/server/src/textGeneration/TextGeneration.ts:246–286`; `apps/web/src/modelSelection.ts:347–370`.

Admission checks build availability but ignores snapshot `status`, `installed`, and authentication evidence. These are not equivalent: `availability` describes whether the driver exists.

**Reproduction:** Configure a Codex custom model, then make its provider probe fail. `apps/server/src/provider/Layers/CodexProvider.ts:587–609` returns `status: "error"`, unknown auth, and the configured custom-model entries. Selecting that custom model immediately invokes generation. Selecting an omitted model refreshes once, then reports “not advertised” because the failed snapshot remains nonempty. Settings likewise reports listed/not-listed without explaining the provider error.

Evaluate evidence validity before membership, both initially and after refresh. Failed/incomplete evidence must remain unverified; preserve legitimate custom models and driver-specific authentication semantics.

### P2 — Production Settings still conceals disabled/missing persisted selections

**References:** `apps/web/src/modelSelection.ts:324–344`; `apps/server/src/serverSettings.ts:310–343,1082–1109`; `apps/server/src/ws.ts:2239–2255`.

The new helper preserves its input, but production settings have already passed through `resolveTextGenerationProvider`, which replaces disabled/missing selections with another provider’s default.

**Reproduction:** Save an auxiliary selection on `codex_personal` with model/options, leave another default provider enabled, then disable or remove `codex_personal`. Settings receives and displays the fallback—not the persisted choice or its disabled/missing explanation. Reactor auxiliary calls also receive that fallback, bypassing the selected-instance refusal.

This pre-existing transformation leaves the requested end-to-end correction incomplete. Preserve the persisted preference through the settings boundary; do not introduce a settings→registry dependency.

### P2 — Changing traits can silently replace the displayed auxiliary model

**Reference:** `apps/web/src/components/settings/SettingsPanels.tsx:1179–1191`.

The display now preserves a hidden-but-advertised saved model, but the traits handler still calls the fallback-producing generic resolver.

**Reproduction:** Save an advertised model with reasoning controls; hide it through `providerModelPreferences`; retain another visible model. Settings correctly displays the saved model. Change reasoning effort. `resolveAppModelSelectionState` resolves against preference-filtered options and persists the other model instead.

An options-only edit must preserve the exact instance/model pair. Model replacement should require the explicit model-selection action.

### P2 — Server and Settings disagree about alias membership

**References:** `apps/server/src/textGeneration/TextGeneration.ts:175–190`; `apps/web/src/modelSelection.ts:355–358`; `packages/shared/src/model.ts:255–285`.

The server normalizes both selected and advertised slugs; Settings uses `resolveSelectableModel`, which normalizes only the selection and also accepts display names.

**Reproduction:** For a ready Codex instance advertising `gpt-5-codex`, persist `gpt-5.4`. Server admission accepts the alias equivalence, while Settings reports not-listed and disables the saved option.

Use one small shared catalogue-membership predicate with consistent alias/custom-model semantics—not a new picker framework or duplicated policy.

### P2 — Interrupt-only probe exits lose cancellation identity

**Reference:** `apps/server/src/textGeneration/TextGeneration.ts:246–251,267–272`.

Every failed `Exit` becomes `TextGenerationError`, including interruption-only causes.

**Reproduction:** Supply an otherwise valid instance whose missing-model refresh returns `Effect.interrupt`. The dispatcher converts cancellation into “could not be refreshed”; the reactor’s interrupt-only suppression at `ProviderCommandReactor.ts:299–300` can no longer recognize it and records an auxiliary failure.

Preserve interruption-only causes while containing actual defects as typed generation errors. This is distinct from ordinary external fiber interruption.

## Coverage and retained behavior

Tests cover exact routing, original model/options forwarding across five operations, custom models with null capabilities, bounded refresh, empty/defective probes, and safe auxiliary activities. They do **not** cover the findings above. The “reloaded” assertion at `ProviderCommandReactor.test.ts:1086–1094` performs another query against the same runtime; it does not exercise restart or event replay. Custom-title coverage does not test a rename while generation is pending.

The source retains nonblocking auxiliary forks, title replacement guards, safe server-authored activities, and separation from main-turn/session-error mutation. No main-turn or UI lifecycle contamination was identified in the inspected activity path. Listed-provider execution failures remain typed; listing is not entitlement or execution proof.

OpenCode 2 refusal, W6/W5, and Symphony role gates remain unchanged. Matching-source network/Chrome acceptance remains separate.**AGREE — this is consistent with the bounded auxiliary correction and reconciles both reviews.** This is scope reconciliation, not implementation authorization or acceptance.

The proposed evidence ordering is correct:

1. **Invalid provider evidence → unverified**, before considering membership. Disabled, unavailable, not-installed, non-ready, or explicitly unauthenticated snapshots cannot establish either positive or negative admission. Unknown auth alone must not imply unauthenticated.
2. **Valid evidence plus an exact selected slug → listed**, including a configured custom model with null capabilities or a custom-only catalogue.
3. **Absent slug plus empty/custom-only evidence → unverified.** A valid catalogue containing discovered noncustom entries may establish not-listed.

Exact matching resolves both reviewers’ matching concerns while preserving the original execution input. Apply it to raw, exact-instance catalogue/configuration evidence—not picker-filtered options, display names, or alias-normalized slugs. Leave generic chat selection and existing global alias behavior unchanged.

Removing the read-time auxiliary fallback is a necessary, tightly related extension: otherwise neither production admission nor Settings sees the persisted disabled/missing selection. Preserve that selection and its options consistently through reads, updates, streams, and acknowledgements, without introducing registry dependencies.

Traits-only changes must preserve instance/model. Explicit model picks must likewise persist the chosen pair without subsequently routing through a fallback resolver. Preserve the existing **at-most-one exact-instance refresh** bound, evaluating refreshed evidence with the same helper. Interrupt-only probe exits retain their cause; actual defects become typed errors.

The eleven-file boundary is appropriate. No new framework, contracts, migrations, provider guards, or role-gate changes are needed.

Focused regressions should cover the evidence matrix, alias/display-name rejection, production settings acknowledgements, hidden-model traits edits, and probe cancellation. Repeated snapshot reads must not be described as restart/replay coverage.

The reported live results support auxiliary-failure isolation for those observed cases. They do **not** establish successful listed-model auxiliary execution: the Copilot title request failed structured output. Catalogue discovery, source validation, and matching-source runtime acceptance remain separate.**AGREE.** My earlier “status not ready” criterion was too broad; I withdraw it.

`warning` does not itself invalidate catalogue evidence. Codex’s successful discovery with a version advisory and Claude’s usage-limit warning demonstrate why discovery and execution availability must remain distinct.

The shared helper should return **unverified** for disabled, unavailable, not-installed, `error`/`disabled` status, or explicitly unauthenticated evidence. An otherwise valid `warning` snapshot remains eligible for membership evaluation. Unknown auth stays unknown.

On valid evidence:

- Exact configured custom membership may be **listed**, including custom-only catalogues.
- Absence from empty/custom-only evidence stays **unverified**.
- Absence with discovered noncustom entries may be **not-listed**.

Use that identical policy on both surfaces, initially and after refresh. Preserve legacy/default enabled-state checks when removing the fallback.

This agrees with the corrected policy—not implementation acceptance. “Listed” establishes advertised/configured membership, never entitlement, available quota, or successful structured generation.I’ll verify the full HEAD hash, then review the cumulative diff, callers, and tests against the reconciled policy. I won’t run validation or runtime probes, control processes, or modify files.The shared projection now follows the reconciled warning, unknown-auth, and custom-only rules, and probe cancellation is preserved. One Settings caller still appears inconsistent: disabling the selected provider writes the default auxiliary selection, discarding the saved choice despite the server fallback removal. I’m also checking that both surfaces pass equivalent custom-model evidence to the shared helper.# FIX

Verified exact HEAD: **`72f8bba4fb2448b3c80f1ebefafd1a5470042bae`**, with a clean working tree. Reviewed the cumulative eleven-file diff against `032a7ceab78f918e8982f49e9e28f3ad6424a534`, required context, and relevant callers/tests. No prohibited actions were performed.

Two P2 issues remain.

## P2 — Disabling the selected provider still overwrites the persisted auxiliary choice

**References:** `apps/web/src/components/settings/SettingsPanels.tsx:1255–1256,1681–1692`.

The server-side read-time fallback is removed correctly, but the provider-card update handler still resets `textGenerationModelSelection` to the default when disabling its selected instance.

**Reproduction:**

1. Save an auxiliary selection on an enabled custom instance, including nondefault model/options.
2. Disable that instance through Settings → Providers.
3. The handler persists the default Codex auxiliary selection alongside the provider update. Re-enabling the instance does not restore the original choice.

This defeats the reconciled end-to-end preservation rule: a provider toggle is not an explicit auxiliary model replacement. If default Codex is available, subsequent auxiliary work can run there instead of visibly refusing the disabled saved instance.

**Correction:** Remove this implicit auxiliary reset. Preserve instance/model/options when disabling; let the existing unverified/disabled explanation and typed admission failure handle it. Add a regression covering the provider-disable mutation, not merely a hand-constructed disabled resolver input.

## P2 — The shared projection still receives different custom-model evidence on each surface

**References:**

- `apps/web/src/modelSelection.ts:322–339,384–395`
- `apps/server/src/textGeneration/TextGeneration.ts:170–180,267–291`
- Existing caller: `apps/server/src/provider/providerSnapshot.ts:205–229`
- Existing Claude caller: `apps/server/src/provider/Layers/ClaudeProvider.ts:979–984`

Settings augments snapshot models with raw configured custom slugs. Server admission uses only snapshot models. Some existing snapshot constructors normalize custom aliases before exposing them, so sharing the predicate does not ensure consistent results.

**Reproduction:** Persist a valid enabled Claude instance with `config.customModels: ["sonnet-4.6"]` and auxiliary model `"sonnet-4.6"`. The existing snapshot constructor normalizes that configured entry to `"claude-sonnet-4-6"`. With an otherwise valid snapshot:

- Settings reinserts raw `"sonnet-4.6"` and reports **listed**, without an explanation.
- Server admission cannot find that exact slug, refreshes once, and refuses it.

No provider execution is required to demonstrate this source-level mismatch.

**Correction:** Make both adapters evaluate equivalent exact-instance catalogue/configuration evidence. Preserve the original requested slug; do not restore alias-based admission or silently canonicalize execution. Add a regression using the existing snapshot-construction behavior and compare both surfaces.

## Reconciled fixes verified in source

- `packages/shared/src/model.ts:324–350` correctly evaluates invalid evidence before membership, accepts installed warning evidence, preserves unknown auth, accepts exact custom-only membership, and keeps empty/custom-only negative evidence unverified.
- Server initial and refreshed admission use that same projection, with at most one exact-instance refresh and unchanged generation inputs.
- `TextGeneration.ts:187–198` preserves interrupt-only probe causes while containing defects as typed errors.
- `serverSettings.ts:991–1070` now preserves auxiliary selections through update, read, change-stream, and acknowledgement paths without a registry dependency.
- Explicit picks and traits-only edits preserve their supplied instance/model pair.
- Auxiliary failures remain safely constructed, server-authored durable activities with `turnId: null`; they do not invoke main-turn/session-error handling. Nonblocking forks and custom-title guards remain intact.
- Copilot parsing/defaults, OpenCode 2 guards, and W6/W5/Symphony gates are unchanged.

## Remaining proof limits

The focused tests meaningfully cover projection rules, forwarding, refresh bounds, cancellation, persistence, and safe activities, but miss both caller-level failures above. Settings stream preservation and invalid **refreshed** snapshots lack direct focused assertions. Reactor tests mock generation; their repeated read-model query is not restart/event-replay coverage, and they do not establish authoritative primary-turn completion or a custom rename during pending generation.

The claimed **124 tests, zero check errors/54 warnings, and recursive noEmit pass** were not independently executed here. Earlier `43d` runtime observations do not establish acceptance of this final snapshot. Catalogue membership remains discovery/configuration evidence—not entitlement or successful structured generation.
