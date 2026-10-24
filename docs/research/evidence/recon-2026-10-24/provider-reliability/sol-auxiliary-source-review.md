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

OpenCode 2 refusal, W6/W5, and Symphony role gates remain unchanged. Matching-source network/Chrome acceptance remains separate.
