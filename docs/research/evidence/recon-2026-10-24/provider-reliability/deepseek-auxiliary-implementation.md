I'll start by reading the scope document and required context files.Now I have enough context. Let me implement the server admission seam first.Implemented and committed the bounded auxiliary text-generation correction.

## Commit

`43d538e14 fix: gate auxiliary text generation on provider catalogue evidence`

Only the seven owned paths are in the commit (verified via `git show --stat`).

## What changed

**`TextGeneration.ts`**

- Added one admission gate before every registry-dispatched auxiliary operation (`commit`, `PR`, `review`, `branch`, `thread title`).
- Resolves only the exact selected instance; distinguishes missing instance, disabled instance, unavailable instance, snapshot/evidence failure, empty catalogue, and model not advertised.
- Validates the selected slug against that instance's own snapshot catalogue (alias-normalised), including configured custom models; never infers from another instance and never treats `capabilities: null` as unsupported.
- Preserves the caller's original instance/model/options on success.
- Performs at most one exact-instance `refresh` when the slug is absent/initial catalogue is empty; refresh failure or empty refreshed evidence yields typed "could not be verified" errors, not "unsupported".
- Contains `refresh`/`getSnapshot` defects as typed `TextGenerationError`s; never runs generation for refused selections.

**`ProviderCommandReactor.ts`**

- First-turn title/branch failures now append one durable `provider.auxiliary.text-generation.failed` activity through the existing activity command, using server-owned ids/time.
- Activity detail contains only auxiliary operation, configured instance/model, and Settings recovery guidance; raw cause, stderr, prompts, attachments, paths are not persisted.
- Interrupt-only causes remain silent.
- Primary chat flow, seeded/custom-title checks, and authoritative turn outcome/readiness are untouched.

**`modelSelection.ts` + `SettingsPanels.tsx`**

- Added `resolveAuxiliaryTextGenerationSelection`: returns the persisted selection verbatim with `listed` / `not-listed` / `unverified` status and an explicit actionable reason.
- Settings now displays the persisted slug (no silent fallback presentation) and an explicit reason in the existing row `status`.
- Saved unavailable slug is injected as a display-only picker option so the trigger shows it; its row is disabled with the reason. Replacement remains the existing explicit `updateSettings` mutation.
- Row description now includes thread titles and branch names.
- Catalogue evidence is computed independently of picker hide/order preferences; custom-instance custom models remain valid.

## Checks run (all green)

- `vp test apps/server/src/textGeneration/TextGeneration.test.ts apps/server/src/orchestration/Layers/ProviderCommandReactor.test.ts apps/server/src/serverSettings.test.ts apps/web/src/modelSelection.test.ts` → **4 files / 99 tests passed** (rerun after commit: same).
- `vp check` → exit 0, **0 errors** (54 pre-existing repo warnings unrelated to these files).
- `vp run typecheck` (recursive, noEmit) → exit 0.
- No builds, installs, packaging, deployment, Playwright, provider turns, restarts, or signals.

## Remaining proof requirements (not performed here)

1. **Live runtime acceptance**: on the owned disposable runtime, with recorded source/auxiliary setting, verify an actually advertised model generates a title and the primary chat reply succeeds; then use an unavailable selection and verify bounded refusal/actionable presentation while the reply still succeeds, with facts retained after reload; restore original settings.
2. **UI render proof**: Settings display/injection is covered by pure resolver/options tests plus typecheck, not a React/Playwright render test. The trigger and disabled-row presentation require runtime UI verification.
3. Provider entitlement remains unknown by design; catalogue membership is discovery evidence only, never a live capability PASS.

OpenCode 2.x adapter refusal and W6/W5/provider-neutral gates were left untouched, as required.Implemented the reconciled review fixes and committed them.

## Commit

`72f8bba4f fix: align auxiliary catalogue evidence and settings persistence`

10 files changed (the previous seven plus the four newly owned paths; `ProviderCommandReactor.ts` itself needed no further change, only its test gained the cancellation regression):

- `packages/shared/src/model.ts` / `model.test.ts`
- `apps/server/src/textGeneration/TextGeneration.ts` / `.test.ts`
- `apps/server/src/serverSettings.ts` / `.test.ts`
- `apps/server/src/orchestration/Layers/ProviderCommandReactor.test.ts`
- `apps/web/src/modelSelection.ts` / `.test.ts`
- `apps/web/src/components/settings/SettingsPanels.tsx`

## What changed

**Shared evidence projection (`packages/shared/src/model.ts`)**

- Added one pure `evaluateModelCatalogueEvidence` used by both server admission and Settings.
- Exact, case-sensitive slug membership only — no alias normalization or display-name matching.
- Invalid evidence is `unverified` before membership: `enabled: false`, `availability: "unavailable"`, `installed: false`, `status` error/disabled, or auth explicitly `unauthenticated`. `warning` with `installed: true` remains valid; `unknown` auth is not unauthenticated.
- Valid evidence + exact configured/custom slug → `listed`, including custom-only catalogues and null capabilities.
- Absent slug with empty/custom-only catalogue → `unverified`; `not-listed` requires at least one discovered non-custom model.

**Server admission (`TextGeneration.ts`)**

- Uses the shared projection identically for initial and refreshed evidence.
- Disabled, unavailable, and other invalid evidence never probes; absent/insufficient valid evidence gets at most one exact-instance refresh.
- `getSnapshot`/`refresh` interruption-only causes are re-raised intact; actual failures/defects become typed `TextGenerationError`s.
- Original instance/model/options still forwarded unchanged; no cross-instance inference.

**Settings boundary (`serverSettings.ts`)**

- Removed `resolveTextGenerationProvider`/`fallbackTextGenerationProvider` and their call sites; persisted auxiliary instance/model/options now survive reads, updates, streams, and mutation acknowledgements even when disabled or missing.
- Secret materialization/redaction/revision machinery unchanged; dead imports/functions removed.

**Settings UI**

- Displays the persisted selection and shared-projection status/reason (invalid evidence is now explicit rather than “not advertised”).
- Explicit model pick persists the exact picked pair; traits-only edits preserve the exact saved instance/model even when hidden or unlisted. Both use `createAuxiliaryTextGenerationSelection`, not the generic fallback resolver; acknowledgement/revision flow unchanged.
- Provider panel clearing logic now keys off the persisted auxiliary instance.

**Activity**

- Existing safe durable activity retained; no raw cause/stderr/paths persisted. Added regression coverage for interrupt-only cancellation producing no activity and leaving the main turn/title intact.

## Checks (all green)

- Focused suites: `packages/shared/src/model.test.ts`, `TextGeneration.test.ts`, `serverSettings.test.ts`, `modelSelection.test.ts`, `ProviderCommandReactor.test.ts` → **5 files / 124 tests passed** (rerun post-commit: same).
- `vp check` → exit 0, **0 errors** (54 pre-existing repo warnings).
- `vp run typecheck` (recursive, noEmit) → exit 0.
- No builds, installs, packaging, deployment, Playwright, provider turns, signals, restarts, or external messages.

## Remaining proof requirements

- Live acceptance remains separate. The Real43d evidence is mixed and is not relabeled here: unlisted auxiliary refusal with primary success does not prove listed-model auxiliary execution; Copilot’s invalid structured output remains a provider-result fact, not a catalogue result. Parser/prompt/default changes were not made.
- Settings picker/traits UI interaction is covered by pure helper tests and typecheck, not a React render test; runtime UI confirmation is still required.
- Repeated snapshot reads are not claimed as restart/replay coverage.

OpenCode 2 guards, W6/W5, Symphony role gates, contracts, and migrations were left unchanged.Implemented both final P2 corrections plus the authoritative-precedence refinement.

## Commit

`fe55c42a7 fix: preserve auxiliary selection on provider disable and share exact custom evidence`

10 files changed in this commit (cumulative 13 owned files across `43d538e14`, `72f8bba4f`, `fe55c42a7`). Working tree clean; not pushed.

## Changes

**1. Provider-disable no longer overwrites the saved auxiliary choice**

- Removed the implicit auxiliary reset from the provider card `onUpdate`.
- Removed the `textGenerationModelSelection` option seam from `updateProviderInstance` and `buildProviderInstanceUpdatePatch`; a provider patch can no longer mutate the auxiliary setting at all.
- Removed the now-unused auxiliary-instance lookup in `ProviderSettingsPanel`.
- Added regressions:
  - `SettingsPanels.logic.test.ts`: a disable patch for the selected provider has no `textGenerationModelSelection` key and still writes `enabled: false`.
  - `serverSettings.test.ts`: disabling the selected custom instance preserves the exact selection through update, read, and mutation acknowledgement.

**2. Identical exact-instance custom-model evidence on both surfaces**

- Added shared `readConfiguredCustomModels` and `mergeConfiguredCustomModelEvidence` in `packages/shared/src/model.ts`.
  - Explicit `providerInstances[id]` config is authoritative; an explicit default-slot instance without `config.customModels` does **not** inherit stale legacy `providers[kind].customModels`.
  - Legacy fallback only for an absent default-slot instance.
  - Raw configured slugs are trimmed only and merged unnormalized beside the snapshot’s alias-normalized entries.
- Server admission (`TextGeneration.ts`) now reads persisted settings once after the enabled check, merges exact-instance configured custom models into both initial and refreshed evidence, and never canonicalizes the execution selection. Settings read failure becomes typed evidence-unavailable; interrupt-only causes remain preserved.
- Settings (`modelSelection.ts`) uses the same extraction/merge helpers.
- Added regressions:
  - Shared extraction precedence and raw-merge cases.
  - Server admits a configured `"sonnet-4.6"` even when the real `providerModelsFromSettings` snapshot exposes only `"claude-sonnet-4-6"`, with zero refresh and the original selection forwarded.
  - Invalid refreshed snapshot (`status: error`, custom-only) is unverified evidence, not “not advertised”.
  - Settings reports the same configured alias as listed, and does not inherit stale legacy custom models for an explicit default instance.

## Checks

- Focused suites: shared `model.test.ts`, `TextGeneration.test.ts`, `serverSettings.test.ts`, `modelSelection.test.ts`, `SettingsPanels.logic.test.ts`, `ProviderCommandReactor.test.ts` → **6 files / 139 tests passed** (rerun post-commit: same).
- `vp check` → exit 0, **0 errors** (54 pre-existing warnings).
- `vp run typecheck` (recursive, noEmit) → exit 0.
- No builds, installs, packaging, deployment, Playwright, provider turns, process actions, or external messages.

## Remaining proof limits

- Live runtime/UI acceptance still required; this commit adds source-level regressions only.
- Repeated in-memory snapshot reads are not restart/event-replay coverage.
- Catalogue/config membership remains discovery evidence, not entitlement or successful structured generation.
- Copilot parser/defaults, OpenCode 2 guards, and W6/W5/Symphony role gates were untouched.
