# FORK.md

Conflict map for this fork (branch `org/copilot-claude`) against upstream
[`pingdotgg/t3code`](https://github.com/pingdotgg/t3code). Read this before
resolving a rebase conflict — every upstream file this fork touches is
listed below with the exact nature of the edit and why it exists, so you
can tell "upstream moved this line" apart from "the fork's edit needs to be
reapplied."

`scripts/rebase-upstream.sh` cross-references conflicting files against this
table automatically. Keep it in sync whenever a fork change touches a new
upstream file — a stale manifest is worse than no manifest.

## How to read this

- **Fork-owned** — new files/directories upstream doesn't know about. These
  never conflict on rebase (upstream can't move lines in a file it doesn't
  have); they're listed for completeness, not as a conflict risk.
- **Upstream files touched** — existing upstream files with fork edits.
  Each row states the edit's shape (mechanical/one-line vs. a larger block)
  so a conflict resolution can distinguish "reapply this exact block" from
  "re-verify this whole file still makes sense."

## Fork-owned (new files, zero conflict risk)

All GitHub Copilot driver internals live in one directory:

| Path | What it is |
| --- | --- |
| `apps/server/src/provider/copilot/CopilotDriver.ts` | `ProviderDriver` implementation. Owns the one `CopilotClient` per provider instance: constructs it, calls `client.start()`, registers `client.stop()` as a finalizer, wires the adapter/snapshot/textGeneration closures. |
| `apps/server/src/provider/copilot/CopilotAdapter.ts` | `ProviderAdapterShape` implementation. Per-thread `CopilotSession` lifecycle, event mapping (`assistant.message[_delta]`, `assistant.reasoning[_delta]`, `tool.execution_start/complete`, `session.idle` → `turn.completed`), `onPermissionRequest`/`onUserInputRequest` bridged into the same `Deferred`-based approval flow Claude/Cursor use. |
| `apps/server/src/provider/copilot/CopilotProvider.ts` | Status probing (`client.getStatus()` / `client.getAuthStatus()`) and the built-in model catalog. |
| `apps/server/src/provider/copilot/CopilotTextGeneration.ts` | Commit/PR/branch/title generation via short-lived Copilot sessions. No native structured-output flag in the SDK, so this follows the Grok/Cursor pattern: ask for JSON in the prompt, decode with `extractJsonObject` + `Schema.decodeEffect`. |
| `apps/server/src/provider/copilot/CopilotEnvironment.ts` | `baseDirectory` (`COPILOT_HOME`-equivalent) resolution + continuation-group-key helper. Mirrors `Drivers/ClaudeHome.ts`. |
| `apps/server/src/provider/copilot/*.test.ts` | Unit tests for all of the above. Mock the SDK client (`createSession`/`resumeSession`/`getStatus`/`getAuthStatus`); never spawn the real CLI or hit the network. |
| `scripts/rebase-upstream.sh` | This fork's rebase helper (see file for usage). |
| `FORK.md` | This file. |

## Upstream files touched

| File | Nature of edit | Why |
| --- | --- | --- |
| `apps/server/package.json` | One dependency line added: `"@github/copilot-sdk"`. | Pulls in the official Copilot SDK the driver wraps. |
| `pnpm-lock.yaml` | Lockfile update from the dependency add: one new `@github/copilot-sdk` entry plus its actual transitive graph (the `@github/copilot` platform binaries, `vscode-jsonrpc`). | Mechanical, but regenerate with `pnpm install --lockfile-only`, not a plain `pnpm install` — on this repo's pnpm/Node combination, a full install also re-resolves the `apps/mobile` peer graph and produces hundreds of lines of unrelated churn. After regenerating, confirm with `git diff pnpm-lock.yaml` that the change stays scoped to the Copilot SDK before committing. |
| `apps/server/src/provider/builtInDrivers.ts` | One import + one array entry (`CopilotDriver`) + one union member (`CopilotDriverEnv`). | Registers the new driver the same way every built-in driver is registered — see the file's own docstring for the "1. implement, 2. add to array, 3. satisfy R" recipe this follows. |
| `packages/contracts/src/settings.ts` | (a) New `CopilotSettings` / `CopilotSettingsPatch` schema blocks, structured identically to the existing `ClaudeSettings` block. (b) One line each registering `githubCopilot` in `ServerSettings.providers` and `ServerSettingsPatch.providers`. (c) Two one-word default flips: `GrokSettings.enabled` and `OpenCodeSettings.enabled` decoding default changed from `true` to `false`. | (a)/(b) follow the exact pattern every other provider (Codex/Claude/Cursor/Grok/OpenCode) already uses in this file — there is no lighter-weight way to add a provider's settings schema upstream already established. (c) is the explicit default-visibility requirement: Claude and GitHub Copilot ship enabled out of the box, Cursor (already disabled upstream)/Grok/OpenCode ship disabled. |
| `packages/contracts/src/model.ts` | One `const COPILOT_DRIVER_KIND` + one entry each in `DEFAULT_MODEL_BY_PROVIDER`, `DEFAULT_GIT_TEXT_GENERATION_MODEL_BY_PROVIDER`, `MODEL_SLUG_ALIASES_BY_PROVIDER`, `PROVIDER_DISPLAY_NAMES`. | Same per-provider registration pattern every existing driver kind uses in this file. |
| `apps/web/src/components/settings/providerDriverMeta.ts` | Two import additions (`CopilotSettings`, `GithubCopilotIcon`) + one new entry in `PROVIDER_CLIENT_DEFINITIONS`. | Makes Copilot a normal, live provider option in the settings UI — this array is what drives the whole settings panel generically (see `SettingsPanels.tsx`, which needed no edit at all because it's already generic over `DRIVER_OPTIONS`). |
| `apps/web/src/components/settings/AddProviderInstanceDialog.tsx` | Removed the `githubCopilot` entry from `COMING_SOON_DRIVER_OPTIONS` (and the now-unused `GithubCopilotIcon` import from this file — it moved to `providerDriverMeta.ts`). | Copilot was already scaffolded here as a disabled "Coming Soon" stub before this task; it's now a real option via `DRIVER_OPTIONS`, so the stub entry is redundant and would show Copilot twice. |
| `apps/server/src/provider/Layers/GrokProvider.test.ts` | Updated one pre-existing test ("returns a pending snapshot by default") to assert the new disabled-by-default behavior, and added a sibling test for the explicitly-enabled case. | The old test encoded the exact default this task changed; it wasn't testing something we broke, it was testing the old default value. |
| `apps/server/src/provider/Layers/ProviderRegistry.test.ts` | One array literal updated: inserted `"githubCopilot"` into the expected sorted list of registered provider instance ids. | This test asserts the full set of built-in driver instance ids; adding a driver means the list grows by one, alphabetically. |
| `apps/server/src/serverSettings.test.ts` | One assertion updated: an OpenCode settings-patch test now expects `enabled: false` (was `true`) because the patch under test never sets `enabled`, so the new default now flows through. | Same category as the `GrokProvider.test.ts` change — a test that encoded the old default value. |

## Rebase-resilience notes

- Every genuinely new capability (driver internals) lives in
  `apps/server/src/provider/copilot/` — a directory upstream will never
  create, so it can never conflict.
- Every upstream file touched follows the same "one import + one
  registration entry" shape that upstream itself uses when it adds a new
  built-in provider — a future upstream PR adding, say, a Gemini driver
  will touch the *same* handful of files in the *same* mechanical way,
  which is the best case for a rebase (small, line-level conflicts you can
  resolve by keeping both entries, not a structural one).
- `ProviderService.ts` and orchestration ingestion were deliberately left
  untouched by this task (a governance forwarder lands there separately).
- Run `scripts/rebase-upstream.sh` for the actual rebase; it fetches
  upstream, picks the latest non-nightly release tag (falling back to
  `upstream/main`), rebases, and cross-references any conflicting files
  against the table above.
