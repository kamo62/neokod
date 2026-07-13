# Neokod remaining-product rebrand plan

Date: 2026-07-13

Repository state investigated: `2.1.0` monorepo, after the `@t3tools/*` to `@neokod/*` package-scope rename

Scope: remaining product-owned `t3`, `T3 Code`, `t3code`, and `T3CODE_*` identities. Vendored `.repos/**`, historical `.plans/**`, and legitimate upstream provenance are not rebranded.

## Outcome and release decision

Complete the rebrand in four compile-safe stages. New names are authoritative. Compatibility is limited to state/config inputs that would otherwise strand user data; do not keep a public `t3` executable alias.

- Release: **`3.0.0` (Major)** from `2.1.0`. This work starts on the private 2.x fork, but removing the published `t3` bin and changing env/config contracts is Major under this repository's SemVer rules. A numeric `2.2.0` would require an explicit exception to `AGENTS.md` and is not recommended.
- Canonical version files: `apps/server/package.json`, `apps/desktop/package.json`, `apps/web/package.json`, and `packages/contracts/package.json`; update all four to `3.0.0` in Stage 1 and keep them in lockstep.
- Changelog: open `CHANGELOG.md` with `## 3.0.0 - <release-date> (Major)` in Stage 1 and append each later stage's user-visible changes to that entry.
- CLI/package: rename package and bin `t3` to `neokod`; published use becomes `npx neokod@latest`, and the standalone command becomes `neokod serve`. Do not ship a `t3` alias. `dist/bin.mjs` is an internal output filename with no brand meaning and stays unchanged.
- Env: rename supported `T3CODE_*` variables to `NEOKOD_*`. For one release, runtime/build readers prefer `NEOKOD_*` and fall back to the corresponding `T3CODE_*`; internal process-to-process writers emit only `NEOKOD_*`. The user-script contract is the exception: project setup scripts emit both new and legacy root/worktree names for `3.0.0`. Delete dead/docs-only variables instead of inventing replacements.
- Home/state: canonical default is `~/.neokod`. When no explicit home is set and `~/.neokod` is absent but `~/.t3` exists, atomically rename the old directory to `~/.neokod`; if the rename fails, use `~/.t3` for that launch and warn. If both exist, use `~/.neokod` and never merge automatically. Explicit `NEOKOD_HOME` wins over legacy `T3CODE_HOME` and is never moved.
- Compatibility sunset: remove legacy env and old-dir fallback in `3.1.0` after `3.0.0` has emitted the documented deprecation for one release. The old `t3` bin is the deliberate exception: it breaks immediately in `3.0.0`.

## Measured footprint (`rg`, current worktree)

All counts exclude `.git/**`, `.repos/**`, `node_modules/**`, historical `.plans/**`, and the unrelated untracked `PLAN-exec-demo.md` unless stated otherwise.

| Surface | Current measured result | Meaning |
| --- | ---: | --- |
| CLI/package patterns (`npx t3`, `t3 serve`, `t3@latest`, package/bin declarations) | 17 matches in 12 files | One match is the unrelated ACP mock payload `{ "name": "t3" }`; all actual CLI/package matches are renamed. |
| `T3CODE_[A-Z0-9_]+` | 311 matches in 51 active files | 52 files if the historical `.plans/PLAN-local-first-carveout.md` is included. |
| Distinct `T3CODE_*` lexical names | 72 | 70 concrete names plus dynamic/doc family prefixes `T3CODE_ENV_` and `T3CODE_OTLP_`. |
| Exact `T3 Code|t3code` | 619 matches in 163 active tracked files | Matches the expected roughly-163-file brand footprint. |
| Exact bare `\bt3\b` | 623 matches in 212 files | Includes Effect service tags, test temp names, CLI filters, CSS identifiers, routes, refs, and legitimate unrelated fixture values. |
| Other `T3_*` identifiers | 46 distinct names in 21 files | Mostly test-only ACP/Claude variables plus runtime MCP, WSL, and web icon identifiers; these are handled in Stage 3, not mistaken for public `T3CODE_*` config. |
| `t3code:` / `t3code.` persisted/browser identifiers | 67 matches in 32 files | Local storage, IndexedDB, events, protocol origins, and tests. |
| `/.well-known/t3/environment` | 9 matches in 6 files | Product-owned local descriptor route. |
| `refs/t3/checkpoints` | 13 matches in 4 files | Product-owned Git refs; existing stored exact refs remain readable. |
| `t3-code` MCP/client identity | 35 matches in 16 files | Rename to `neokod`; no alias is needed because each session injects its current config. |
| Desktop dev arg `--t3code-dev-root` | 4 matches in 3 files | Rename in launcher, process cleanup, and tests together. |
| Preview partition `persist:t3code-*` | 11 matches in 6 files | Rename; it is a rebuildable cache, not source data. |
| Preview CSS vars `--t3-*` | 112 matches in 3 files | Rename source CSS/TS and regenerate the generated CSS file. |
| Preview `data-t3code-*` attributes | 5 matches in 1 file | Internal DOM contract; rename atomically. |

### CLI/package paths

Actual product-owned package/command paths are:

- `apps/server/package.json`
- `apps/server/src/bin.ts`
- `apps/server/src/bin.test.ts`
- `apps/server/src/cli/server.ts`
- `apps/server/src/terminal/BunPtyAdapter.ts`
- `apps/server/src/terminal/BunPtyAdapter.test.ts`
- `apps/server/scripts/cli.ts`
- `package.json`
- `apps/desktop/vite.config.ts`
- `scripts/dev-runner.ts`
- `scripts/dev-runner.test.ts`
- `README.md`
- `docs/getting-started/quick-start.md`
- `docs/architecture/connection-runtime.md`
- `docs/architecture/overview.md`
- `docs/operations/observability.md`
- `docs/reference/encyclopedia.md`
- `CHANGELOG.md`, `FORK.md`, and `HANDOFF.md` where current behavior is described

`apps/server/scripts/acp-mock-agent.ts` has an ACP fixture payload named `t3`; it is not the CLI, but Stage 3 renames the private fixture for a clean product-owned grep result.

## KEEP manifest: upstream/provenance strings that must survive

The final grep is an allowlist audit, not an indiscriminate zero-match check. Keep only the following `T3`/`t3code` occurrences, because they identify the upstream project, legal provenance, or an external upstream OAuth registration:

1. Git configuration: the `upstream` remote must remain `https://github.com/pingdotgg/t3code.git` with push disabled. Do not edit `.git/config`. The current `origin`/`neokod` remote arrangement is external repository administration and not changed by this plan.
2. `scripts/rebase-upstream.sh`: keep the filename, `UPSTREAM_REMOTE="upstream"`, upstream terminology, and its `T3 Code` description.
3. `README.md`: keep the sentence that Neokod began as a fork of T3 Code and the upstream setup URL/command.
4. `FORK.md`: keep the opening `pingdotgg/t3code` link, the explicitly labelled upstream/T3 Code baseline, comparisons that distinguish Neokod from T3 Code installs, and upstream issue/source links. Rewrite only statements that call the current fork itself `t3code` or claim `T3CODE_*` is intentionally permanent.
5. `HANDOFF.md`: keep the fork provenance heading/link; refresh stale current-product and remaining-work statements to Neokod.
6. `LICENSE`: keep `Copyright (c) 2026 T3 Tools Inc.`; this is legal attribution, not display branding.
7. Upstream URL fixtures and comments that intentionally exercise `pingdotgg/t3code` parsing in `apps/server/src/git/GitManager.test.ts`, `apps/server/src/provider/Layers/ClaudeAdapter.ts`, the source-control provider tests, `apps/server/src/vcs/VcsStatusBroadcaster.test.ts`, `apps/web/src/lib/openPullRequestLink.test.ts`, and `apps/web/src/pullRequestReference.test.ts`. Replace `octocat/t3code`, `T3Tools/t3code`, and other arbitrary fixture slugs with neutral/Neokod values; only real `pingdotgg/t3code` references are allowed.
8. `apps/server/src/provider/acp/GrokAcpSupport.ts`: keep the external `GROK_OAUTH2_REFERRER="t3code"` value until xAI registers a Neokod referrer. Rename the local constant/test wording to make the compatibility exception explicit. Changing this literal without provider confirmation risks breaking Grok cached-token OAuth.
9. Historical `.plans/**` and vendored `.repos/**`: do not edit or include in shipping grep gates. They are evidence/reference material, not active product identity.
10. `CHANGELOG.md`: historical/upstream lines may name T3 Code or the removed legacy `t3` CLI only when the wording explicitly says `upstream`, `former`, or `legacy`. Current commands and release headings must say Neokod.

Everything else product-owned is RENAME or DELETE.

## Environment inventory and policy

The replacement is mechanical: replace the `T3CODE_` prefix with `NEOKOD_` unless the row says delete. New values win when both are present. Defaults stay identical except branded defaults (`~/.t3` and `t3-server`) become `~/.neokod` and `neokod-server`.

| Current distinct names | Reader/writer and default | Documentation/action |
| --- | --- | --- |
| `T3CODE_LOG_LEVEL`, `T3CODE_TRACE_MIN_LEVEL`, `T3CODE_TRACE_TIMING_ENABLED`, `T3CODE_TRACE_FILE`, `T3CODE_TRACE_MAX_BYTES`, `T3CODE_TRACE_MAX_FILES`, `T3CODE_TRACE_BATCH_WINDOW_MS` | `apps/server/src/cli/config.ts`; defaults `Info`, `Info`, `true`, derived trace path, `10485760`, `10`, `200`. | Rename and document in `docs/operations/observability.md`; test precedence/defaults in `apps/server/src/cli/config.test.ts`. |
| `T3CODE_OTLP_TRACES_URL`, `T3CODE_OTLP_METRICS_URL`, `T3CODE_OTLP_EXPORT_INTERVAL_MS`, `T3CODE_OTLP_SERVICE_NAME` | Server CLI plus desktop config/launcher for traces and interval; defaults unset, unset, `10000`, `t3-server`. | Rename; branded service default becomes `neokod-server`; update observability code/tests/docs. |
| `T3CODE_MODE`, `T3CODE_PORT`, `T3CODE_HOME`, `T3CODE_NO_BROWSER`, `T3CODE_BOOTSTRAP_FD`, `T3CODE_AUTO_BOOTSTRAP_PROJECT_FROM_CWD`, `T3CODE_LOG_WS_EVENTS` | Server CLI readers; desktop/dev runner writers. Defaults resolve to web mode, available port (`3773` standalone; dev runner base `13773`), `~/.t3`, browser open outside desktop, unset FD, web-mode true, and `Boolean(devUrl)`. | Rename; `HOME` receives old-var/old-dir fallback and migration. Other public vars receive one-release old-name read fallback. |
| `T3CODE_BITBUCKET_ACCESS_TOKEN`, `T3CODE_BITBUCKET_API_BASE_URL`, `T3CODE_BITBUCKET_API_TOKEN`, `T3CODE_BITBUCKET_EMAIL` | `apps/server/src/sourceControl/BitbucketApi.ts` and provider; defaults unset except API URL `https://api.bitbucket.org/2.0`. | Rename errors/install hints/tests/docs in the Bitbucket source-control files and `docs/integrations/source-control-providers.md`. |
| `T3CODE_POSTHOG_KEY`, `T3CODE_POSTHOG_HOST`, `T3CODE_TELEMETRY_ENABLED`, `T3CODE_TELEMETRY_FLUSH_BATCH_SIZE`, `T3CODE_TELEMETRY_MAX_BUFFERED_EVENTS` | `apps/server/src/telemetry/AnalyticsService.ts`; existing key, `https://us.i.posthog.com`, `true`, `20`, `1000`. | Rename with fallback and tests. Do not change telemetry behavior in this rebrand. |
| `T3CODE_STRICT_PROVIDER_LIFECYCLE_GUARD` | Direct reader in `ProviderRuntimeIngestion.ts`; enabled unless exactly `0`. | Rename with one-release fallback; update its test fixtures if present. |
| `T3CODE_PROJECT_ROOT`, `T3CODE_WORKTREE_PATH` | Written by `packages/shared/src/projectScripts.ts`, consumed by user project scripts; root required, worktree optional. | Emit both `NEOKOD_*` and legacy `T3CODE_*` for `3.0.0`, with identical values, so existing user scripts keep working; remove legacy emission in `3.1.0`. Update shared/contracts/web/server tests/docs. |
| `T3CODE_COMMIT_HASH`, `T3CODE_DESKTOP_APP_USER_MODEL_ID`, `T3CODE_DISABLE_AUTO_UPDATE`, `T3CODE_DESKTOP_MOCK_UPDATES`, `T3CODE_DESKTOP_MOCK_UPDATE_SERVER_PORT` | `DesktopConfig.ts`; defaults unset, Neokod bundle ID, `false`, `false`, `3000`. Launcher/dev/build scripts write/read subsets. | Rename with fallback. Rename embedded `t3codeCommitHash` to `neokodCommitHash` and read the old field for one release. |
| `T3CODE_DESKTOP_REMOTE_DEBUGGING_PORT` | `apps/desktop/scripts/dev-electron.mjs`; optional/unset. | Rename with fallback; update dev script tests where applicable. |
| `T3CODE_DESKTOP_PLATFORM`, `T3CODE_DESKTOP_TARGET`, `T3CODE_DESKTOP_ARCH`, `T3CODE_DESKTOP_VERSION`, `T3CODE_DESKTOP_OUTPUT_DIR` | `scripts/build-desktop-artifact.ts`; defaults host platform, platform target, host/default arch, package version, `release`/`release-mock`. | Rename build inputs with one-release fallback and tests. |
| `T3CODE_DESKTOP_SKIP_BUILD`, `T3CODE_DESKTOP_KEEP_STAGE`, `T3CODE_DESKTOP_SIGNED`, `T3CODE_DESKTOP_VERBOSE`, `T3CODE_DESKTOP_WSL_PREBUILD`, `T3CODE_DESKTOP_UPDATE_REPOSITORY` | Artifact builder; defaults `false`, `false`, `false`, `false`, unset, then `GITHUB_REPOSITORY`. | Rename with fallback; update build help/tests/docs. |
| `T3CODE_DESKTOP_MOCK_UPDATE_SERVER_ROOT` | `scripts/mock-update-server.ts`; default `../release-mock`. | Rename with fallback together with mock port. |
| `T3CODE_DEV_INSTANCE`, `T3CODE_PORT_OFFSET` | `scripts/dev-runner.ts`; defaults unset/offset `0`; named instances hash to `1..3000`. | Rename errors/logs/tests/docs; new names win. |
| `T3CODE_BUNDLED_DEV`, `T3CODE_WEB_SOURCEMAP` | `apps/web/vite.config.ts`; defaults disabled and source maps enabled. | Rename direct process reads with fallback; update inline comment. |
| `T3CODE_DESKTOP_DEV` | `apps/desktop/vite.config.ts` both writes and reads; default disabled. | Rename cleanly; it is an internal same-process build flag and needs no legacy emission. |
| `T3CODE_ENV_`, `T3CODE_ENV_CUSTOM_VAR_START__`, `T3CODE_ENV_CUSTOM_VAR_END__`, `T3CODE_ENV_FNM_DIR_START__`, `T3CODE_ENV_FNM_DIR_END__`, `T3CODE_ENV_PATH_START__`, `T3CODE_ENV_PATH_END__`, `T3CODE_ENV_SSH_AUTH_SOCK_START__`, `T3CODE_ENV_SSH_AUTH_SOCK_END__`, `T3CODE_PATH_START__`, `T3CODE_PATH_END__` | Internal shell-capture marker families in `packages/shared/src/shell.ts`, `apps/desktop/src/shell/DesktopShellEnvironment.ts`, and tests; no configurable default. | Rename markers to `NEOKOD_*` atomically; no compatibility because producer and parser ship together. `T3CODE_ENV_` is a generated prefix, not a standalone variable. |
| `T3CODE_FAKE_CODEX_OUTPUT__` | Here-doc delimiter in `CodexTextGeneration.test.ts`, not an env variable. | Rename the test sentinel only. |
| `T3CODE_CURSOR_ENABLED` | Dead test-only write in `ProviderRegistry.test.ts`; no production reader. | Delete; do not create `NEOKOD_CURSOR_ENABLED`. |
| `T3CODE_DESKTOP_PROTOCOL_REGISTRATION_MANAGED`, `T3CODE_DESKTOP_WS_URL` | First is written but never read; second is only deleted/scrubbed. | Delete dead handling; do not create replacements. |
| `T3CODE_APPLE_TEAM_ID`, `T3CODE_MACOS_PROVISIONING_PROFILE`, `T3CODE_STATE_DIR` | Docs-only stale names; no code readers. | Remove/correct docs. Signing uses Electron Builder/Apple variables; state is derived from `NEOKOD_HOME`. |
| `T3CODE_OTLP_` | Documentation wildcard only. | Change to `NEOKOD_OTLP_*`; not a standalone variable. |

### Active `T3CODE_*` file inventory (51 files)

This is the exact Stage 1 rename/test surface found by `rg`:

- `.cursor/rules/cursor-cloud.mdc`
- `apps/desktop/scripts/dev-electron.mjs`
- `apps/desktop/scripts/electron-launcher.mjs`
- `apps/desktop/scripts/electron-launcher.test.mjs`
- `apps/desktop/src/app/DesktopApp.ts`
- `apps/desktop/src/app/DesktopAppErrors.test.ts`
- `apps/desktop/src/app/DesktopAppIdentity.test.ts`
- `apps/desktop/src/app/DesktopConfig.ts`
- `apps/desktop/src/app/DesktopConnectionCatalogStore.test.ts`
- `apps/desktop/src/app/DesktopEnvironment.test.ts`
- `apps/desktop/src/app/DesktopObservability.test.ts`
- `apps/desktop/src/backend/DesktopBackendConfiguration.test.ts`
- `apps/desktop/src/backend/DesktopBackendConfiguration.ts`
- `apps/desktop/src/backend/DesktopBackendManager.ts`
- `apps/desktop/src/settings/DesktopAppSettings.test.ts`
- `apps/desktop/src/settings/DesktopClientSettings.diagnostics.test.ts`
- `apps/desktop/src/settings/DesktopClientSettings.test.ts`
- `apps/desktop/src/shell/DesktopShellEnvironment.test.ts`
- `apps/desktop/src/shell/DesktopShellEnvironment.ts`
- `apps/desktop/src/updates/DesktopUpdates.test.ts`
- `apps/desktop/src/updates/DesktopUpdates.ts`
- `apps/desktop/src/window/DesktopWindow.test.ts`
- `apps/desktop/vite.config.ts`
- `apps/server/src/cli/config.test.ts`
- `apps/server/src/cli/config.ts`
- `apps/server/src/orchestration/Layers/ProviderRuntimeIngestion.ts`
- `apps/server/src/project/ProjectSetupScriptRunner.test.ts`
- `apps/server/src/provider/Layers/ProviderRegistry.test.ts`
- `apps/server/src/sourceControl/BitbucketApi.test.ts`
- `apps/server/src/sourceControl/BitbucketApi.ts`
- `apps/server/src/sourceControl/BitbucketSourceControlProvider.ts`
- `apps/server/src/sourceControl/SourceControlDiscovery.test.ts`
- `apps/server/src/telemetry/AnalyticsService.test.ts`
- `apps/server/src/telemetry/AnalyticsService.ts`
- `apps/server/src/terminal/Manager.test.ts`
- `apps/server/src/textGeneration/CodexTextGeneration.test.ts`
- `apps/web/src/projectScripts.test.ts`
- `apps/web/vite.config.ts`
- `docs/getting-started/quick-start.md`
- `docs/integrations/source-control-providers.md`
- `docs/operations/observability.md`
- `docs/reference/scripts.md`
- `packages/contracts/src/terminal.test.ts`
- `packages/shared/src/projectScripts.ts`
- `packages/shared/src/shell.test.ts`
- `packages/shared/src/shell.ts`
- `scripts/build-desktop-artifact.test.ts`
- `scripts/build-desktop-artifact.ts`
- `scripts/dev-runner.test.ts`
- `scripts/dev-runner.ts`
- `scripts/mock-update-server.ts`

## Stage 1 — env vars, home/state, and project config migration

### Exact files

- All 51 files in the env inventory above.
- `apps/server/src/os-jank.ts` for canonical/default home selection and migration.
- `packages/contracts/src/desktopBootstrap.ts` and all `t3Home` callers in `apps/desktop/src/backend/DesktopBackendConfiguration.ts`, `apps/desktop/src/backend/DesktopBackendConfiguration.test.ts`, `apps/desktop/src/backend/DesktopBackendManager.test.ts`, `apps/server/src/cli/config.ts`, and `scripts/dev-runner.ts`; rename the internal field to `neokodHome`.
- `apps/desktop/src/app/DesktopEnvironment.ts`, `apps/desktop/src/app/DesktopEnvironment.test.ts`, `apps/desktop/src/app/DesktopAppIdentity.ts`, and `apps/desktop/src/app/DesktopAppIdentity.test.ts` for aligned desktop/default data paths. (`DesktopEnvironment.ts` already defaults to `~/.neokod`; preserve that.)
- `apps/server/src/vcs/VcsProjectConfig.ts` and `apps/server/src/vcs/VcsProjectConfig.test.ts` for `.neokod/vcs.json` with `.t3code/vcs.json` fallback.
- `apps/server/src/telemetry/Identify.ts`, `.gitignore`, `docs/user/keybindings.md`, `docs/reference/scripts.md`, `docs/operations/observability.md`, and `.cursor/rules/cursor-cloud.mdc` for real paths/docs.
- Version/changelog: `apps/server/package.json`, `apps/desktop/package.json`, `apps/web/package.json`, `packages/contracts/package.json`, `CHANGELOG.md`, and `pnpm-lock.yaml` if the package manager rewrites importer metadata.

### Change

1. Add new-name-first/old-name-second reads at each real config boundary. Keep the precedence explicit: CLI flags/bootstrap > `NEOKOD_*` > legacy `T3CODE_*` > existing default. Do not scatter dual writes.
2. Rename internal variables/types (`t3Home`, `DEFAULT_T3_HOME`, `parentEnvWithoutT3Home`) to Neokod/generic names so the old brand remains only in compatibility literals.
3. Make server CLI, dev runner, and desktop agree on `~/.neokod`. Implement one tested migration decision: new exists -> use new; only old exists -> atomic rename then use new; both exist -> use new/no merge; rename error -> use old for this release and warn.
4. Prefer `.neokod/vcs.json`; read `.t3code/vcs.json` only when no new config is found at that search level. Never merge both files. Add a precedence test.
5. Rename the project-script variables to `NEOKOD_PROJECT_ROOT`/`NEOKOD_WORKTREE_PATH` and emit the old names with identical values for `3.0.0` only. This is the sole dual-write exception because existing user scripts are consumers, not Neokod child processes.
6. Delete the dead/docs-only entries identified in the inventory.
7. Add the `3.0.0` Major changelog heading and version changes.

### KEEP vs RENAME

- KEEP: explicit user paths supplied through legacy `T3CODE_HOME`; the migration must not move arbitrary custom directories.
- RENAME: default `~/.t3`, `~/.t3/{dev,userdata}`, `.t3code/vcs.json`, active docs, comments, test fixtures, env keys, marker prefixes, and branded OTLP service default.
- KEEP temporarily: legacy env literals and `~/.t3` only inside the compatibility reader/tests/docs through `3.0.0`.

### Verification

```bash
vp test run apps/server/src/cli/config.test.ts apps/server/src/vcs/VcsProjectConfig.test.ts scripts/dev-runner.test.ts
vp run typecheck
vp check

# Every retained legacy name must have a NEOKOD counterpart; output must be empty.
comm -23 \
  <(rg -o --no-filename 'T3CODE_[A-Z0-9_]+' apps packages scripts docs .cursor | sort -u | sed 's/^T3CODE_/NEOKOD_/') \
  <(rg -o --no-filename 'NEOKOD_[A-Z0-9_]+' apps packages scripts docs .cursor | sort -u)

# Old home/config strings may appear only in migration/fallback tests and explicit legacy docs.
rg -n '\.t3(code)?|T3CODE_HOME' apps packages scripts docs .cursor .gitignore
```

Inspect the second gate against the Stage 1 allowlist (`os-jank`, env compatibility readers/tests, `VcsProjectConfig` fallback/tests, and the `3.0.0` migration note); no default/current instruction may use the old path.

### Risks

- Moving a live SQLite/state directory while another old process is running can corrupt data. Migration must happen before opening state and should fail safely to the old directory rather than copy a live tree.
- If both roots exist, merging is unsafe; selecting `.neokod` may hide old-only state, so emit an actionable warning naming both paths.
- Build/CI jobs using old names continue for `3.0.0` through fallback, but logs/docs must make the sunset visible.
- Project setup scripts temporarily receive both names; test value equality and remove the legacy pair in `3.1.0` to avoid an accidental permanent contract.

## Stage 2 — package, CLI, bin, and invocation rename

### Exact files

- `apps/server/package.json`
- `apps/server/src/bin.ts`
- `apps/server/src/bin.test.ts`
- `apps/server/src/cli/server.ts`
- `apps/server/src/terminal/BunPtyAdapter.ts`
- `apps/server/src/terminal/BunPtyAdapter.test.ts`
- `apps/server/scripts/cli.ts`
- `package.json`
- `pnpm-lock.yaml`
- `apps/desktop/vite.config.ts`
- `scripts/dev-runner.ts`
- `scripts/dev-runner.test.ts`
- `README.md`
- `docs/getting-started/quick-start.md`
- `docs/architecture/connection-runtime.md`
- `docs/architecture/overview.md`
- `docs/operations/observability.md`
- `docs/reference/encyclopedia.md`
- `docs/reference/scripts.md`
- `CHANGELOG.md`, `FORK.md`, `HANDOFF.md`

### Change

1. Set `apps/server/package.json` to `"name": "neokod"` and `"bin": { "neokod": "./dist/bin.mjs" }`. Point its repository metadata at `https://github.com/kamo62/neokod`; this field describes the Neokod package and is not an upstream-provenance KEEP occurrence.
2. Rename the root Effect CLI command to `neokod`, its descriptions to Neokod, and test command paths accordingly.
3. Change all Vite+/workspace filters and dependencies from package `t3`/`t3#build` to `neokod`/`neokod#build` in the root scripts, desktop config, dev runner, and publish helper.
4. Publish/document `npx neokod@latest`, `npx neokod`, and `neokod serve`. Remove all current `npx t3`, `t3 serve`, and `t3@latest` instructions.
5. Do not rename `dist/bin.mjs` or desktop paths that execute it: the file is an internal entrypoint, and changing it adds churn without improving product identity.
6. Add the intentional CLI break and replacement command to the `3.0.0` changelog/migration notes. Do not provide an alias package or second bin.

### KEEP vs RENAME

- KEEP: the upstream remote/setup docs and `scripts/rebase-upstream.sh`.
- RENAME: package name, executable, command help, workspace filters, publish filter, current docs, error guidance, and fork/handoff statements describing the current standalone server.
- KEEP internal filename: `./dist/bin.mjs`.

### Verification

```bash
vp run --filter neokod build
node apps/server/dist/bin.mjs --help
vp run typecheck
vp check

# Must return no current code/docs match; CHANGELOG may contain only explicit legacy migration text.
rg -n 'npx t3(?:@latest)?|\bt3 serve\b|\bt3@latest\b|--filter(?:=| )t3\b|\bt3#build\b|"name": "t3"|"t3": "\./dist/bin\.mjs"' \
  apps packages scripts docs README.md package.json FORK.md HANDOFF.md

# Positive package/bin proof.
rg -n '"name": "neokod"|"neokod": "\./dist/bin\.mjs"|npx neokod|neokod serve' \
  apps/server/package.json apps/server/src README.md docs package.json scripts
```

### Risks

- `npx t3`, globally installed `t3`, automation invoking `t3`, and npm consumers of package `t3` stop working immediately. This is accepted for the private fork and drives the Major bump.
- npm availability/ownership for package name `neokod` must be confirmed before publish; code can still build locally if registry publication is deferred.
- Desktop packaging depends on workspace package filters; missing one `t3#build` edge can produce an incomplete artifact even when TypeScript passes, hence the Stage 2 build gate.

## Stage 3 — active product strings and product-owned internal identifiers

### Exact active surfaces

Use the measured 163-file exact-string inventory plus the identifier sets below. The implementation diff is the output of these commands after subtracting the KEEP manifest, not a blind repository-wide replacement:

```bash
rg -l 'T3 Code|t3code' --hidden \
  -g '!.git/**' -g '!.repos/**' -g '!node_modules/**' -g '!.plans/**' -g '!PLAN-exec-demo.md'
rg -l '"t3/' apps/server/src
rg -l '\bT3_[A-Z0-9_]+|t3-code|\.well-known/t3|refs/t3|t3code[:.]|persist:t3code|data-t3code|--t3-' \
  apps packages scripts docs experiments vite.config.ts package.json pnpm-workspace.yaml pnpm-lock.yaml
```

Primary exact file groups:

- Product copy/docs: `.devcontainer/devcontainer.json`, `.cursor/rules/cursor-cloud.mdc`, `AGENTS.md`, `README.md`, `CHANGELOG.md`, `FORK.md`, `HANDOFF.md`, `docs/architecture/{overview,runtime-modes}.md`, `docs/getting-started/codex-prerequisites.md`, `docs/integrations/source-control-providers.md`, `docs/operations/{ci,observability}.md`, `docs/providers/{claude,codex}.md`, `docs/reference/{encyclopedia,scripts}.md`, `docs/user/keybindings.md`.
- Server display/log/instruction copy: `apps/server/src/bin.ts`, `apps/server/src/cli/server.ts`, `apps/server/src/mcp/McpHttpServer.ts`, `apps/server/src/serverRuntimeStartup.ts`, `apps/server/src/startupAccess.ts`, `apps/server/src/provider/CodexDeveloperInstructions.ts`, provider layer/maintenance files and their assertion tests, text-generation title files, `packages/contracts/src/settings.ts`, and `apps/server/src/vcs/GitVcsDriver.ts` (Git author/committer name).
- MCP identity: `apps/server/src/provider/CodexDeveloperInstructions.ts`, `apps/server/src/provider/Layers/{ClaudeAdapter,CodexAdapter,CursorAdapter,GrokAdapter,OpenCodeAdapter}.ts`, provider probes/text generators and tests, `apps/web/src/components/chat/CopilotMcpControls.tsx`, and `apps/web/src/session-logic.test.ts`.
- Descriptor route: `packages/contracts/src/environmentHttp.ts`, `packages/client-runtime/src/environment/descriptor.ts`, `apps/server/src/server.test.ts`, `apps/desktop/src/backend/{DesktopBackendManager,DesktopBackendPool}.ts`, and backend tests.
- Git refs/branch prefixes/config: `apps/server/src/checkpointing/Utils.ts`, orchestration/projector tests, `apps/server/src/git/GitManager.ts` and tests, `apps/server/src/sourceControl/BitbucketApi.ts` and tests, branch-related orchestration/web tests, and `apps/server/src/vcs/VcsProjectConfig.ts` from Stage 1.
- Browser persistence/events: `apps/web/index.html`, `apps/web/src/clientPersistenceStorage.{ts,test.ts}`, `apps/web/src/connection/storage.ts`, `apps/web/src/{composerDraftStore,diffPanelStore,editorPreferences,providerUpdateDismissal,rightPanelStore,subagentUiStore,terminalUiStateStore,uiStateStore,versionSkew}.ts` and relevant tests, `apps/web/src/hooks/{useLocalStorage,useTheme}.ts` and tests, `apps/web/src/components/ChatView.logic.ts`, file/preview panel storage keys, and `previewActionBus.ts`.
- Lint plugin: rename directory `oxlint-plugin-t3code/` to `oxlint-plugin-neokod/`; update its package name to `@neokod/oxlint-plugin-neokod`, plugin namespace to `neokod/*`, `vite.config.ts`, `pnpm-workspace.yaml`, `package.json`, `pnpm-lock.yaml`, `scripts/release-smoke.ts`, all 32 current `t3code/<rule>` disable/harness files, and plugin tests.
- Effect service/span tags: the 88 `apps/server/src/**` files returned by `rg -l '"t3/' apps/server/src`; mechanically rename tag prefixes to `neokod/` in one batch. These are diagnostic identities, not public APIs.
- Private `T3_*` identifiers: `apps/server/scripts/acp-mock-agent.ts` and ACP/provider/text-generation tests, `apps/server/src/provider/Layers/CodexAdapter.ts` (`NEOKOD_MCP_BEARER_TOKEN`), `apps/desktop/src/wsl/wslNodeEnvironment.ts` and tests, `apps/server/src/vcs/GitVcsDriverCore.test.ts`, and `apps/web/src/pierre-icons.ts`/consumers/tests. Rename cleanly; only the Grok referrer value is kept per the KEEP manifest.
- Obsolete release code: delete unreferenced `scripts/notify-discord-release.ts` and `scripts/notify-discord-release.test.ts` instead of rebranding dead code. Current workflows/package scripts do not call them.
- Neutral test/example strings: replace arbitrary `octocat/t3code`, `T3Tools/t3code`, Windows checkout paths, temp prefixes, `t3.chat` examples, and experimental branch names with Neokod or neutral examples. Keep real `pingdotgg/t3code` fixtures only.

### Change

1. Replace active user-visible `T3 Code` copy with `Neokod`, including CLI help, provider status/error copy, MCP metadata, Git author name, docs headings, devcontainer name, and current changelog/fork/handoff statements.
2. Rename the local descriptor endpoint to `/.well-known/neokod/environment` across contract, server, client runtime, desktop readiness, and tests. This is a deliberate internal/local API break; do not serve both routes indefinitely.
3. Rename the injected MCP server/client identities from `t3-code*` to `neokod*` and the bearer variable to `NEOKOD_MCP_BEARER_TOKEN` in the same commit.
4. Generate new checkpoints under `refs/neokod/checkpoints`. Existing database rows contain exact old ref strings and remain operable; do not rewrite Git refs or historical rows. Rename default branch prefixes from `t3code/` to `neokod/`; existing branches remain ordinary Git branches.
5. Migrate localStorage before application stores initialize: if a new `neokod:*`/`neokod.*` key is absent and its old `t3code:*`/`t3code.*` key exists, copy once to the new key. The early theme script must use the same precedence. Keep old-key reads only in this migration map for `3.0.0`. Rename internal event names directly.
6. Rename IndexedDB to `neokod:connection-runtime`. Its contents are a rebuildable local cache/catalog after the local-first carve-out; start cold rather than adding a bespoke cross-database copier. Do not delete the old database automatically.
7. Rename Electron preview partitions and preview annotation DOM/CSS identifiers. Preview partitions are cache/session data, so a cold partition is acceptable. Edit `Annotation.css` and `PickPreload.ts`, then regenerate `AnnotationStyles.generated.ts` with the existing build script; do not hand-edit generated CSS.
8. Rename the lint plugin/directory/namespace and all disable comments in one atomic change so `vp check` never observes mixed namespaces.
9. Delete the unused Discord release script/test.
10. Update the `3.0.0` changelog entry without falsifying explicitly historical/upstream statements.

### KEEP vs RENAME

- KEEP: only the upstream/provenance/Grok exceptions in the KEEP manifest.
- RENAME: all current UI copy, docs describing Neokod, internal service tags, route, MCP identity, new Git refs/branches, local browser keys/events/database, lint namespace, temp/test names, and examples.
- MIGRATE: localStorage settings/UI state. Existing exact checkpoint refs/branches remain readable without a bulk migration.
- COLD START ACCEPTED: IndexedDB cache and Electron preview partitions.
- DELETE: unused Discord release script/test.

### Verification

```bash
vp test
vp run typecheck
vp check

# Product-owned active occurrences must be gone. Every remaining line must match the KEEP manifest.
rg -n -i 'T3 Code|t3code|t3-code|\bt3\b|\bT3_[A-Z0-9_]+' \
  --hidden -g '!.git/**' -g '!.repos/**' -g '!node_modules/**' -g '!.plans/**' -g '!PLAN-exec-demo.md'

# These product-owned identifiers have no KEEP exception and must return zero.
rg -n '\.well-known/t3|refs/t3|t3code[:.]|persist:t3code|data-t3code|--t3-|"t3/' \
  apps packages scripts docs experiments vite.config.ts package.json pnpm-workspace.yaml pnpm-lock.yaml

# Positive contract proof.
rg -n '\.well-known/neokod|refs/neokod|neokod:|persist:neokod|data-neokod|--neokod-|"neokod/' \
  apps packages scripts
```

The first gate is accepted only if every result is one of: `pingdotgg/t3code`/upstream T3 Code provenance, legal `T3 Tools Inc.`, explicit legacy migration documentation/tests, or the commented Grok OAuth referrer compatibility literal. Arbitrary fixture/path/temp matches are failures.

### Risks

- The descriptor route and MCP name are observable to local integrations; coordinate any external Neokod automation even though desktop/web clients update atomically.
- LocalStorage migration must run before Zustand/hooks read their keys or users will see reset preferences.
- Renaming the lint plugin must be atomic; a partial stage makes `vp check` fail before typecheck.
- Replacing user-agent/partition identifiers can invalidate caches; that is intentional, but source settings/history must not be stored only there.
- Keep the Grok OAuth referrer until provider registration is confirmed; a cosmetically clean grep is not worth breaking authentication.

### Exact Stage 3 `T3 Code|t3code` inventory (163 files)

This is the path snapshot behind the Stage 3 count. Each path is renamed, deleted, or retained only under the KEEP manifest:

```text
.cursor/rules/cursor-cloud.mdc
.devcontainer/devcontainer.json
AGENTS.md
CHANGELOG.md
FORK.md
HANDOFF.md
README.md
apps/desktop/scripts/dev-electron.mjs
apps/desktop/scripts/electron-launcher.mjs
apps/desktop/scripts/electron-launcher.test.mjs
apps/desktop/scripts/ensure-electron-runtime.mjs
apps/desktop/src/app/DesktopAppIdentity.test.ts
apps/desktop/src/app/DesktopAppIdentity.ts
apps/desktop/src/backend/DesktopBackendConfiguration.test.ts
apps/desktop/src/electron/ElectronWindow.test.ts
apps/desktop/src/preview/BrowserSession.test.ts
apps/desktop/src/preview/BrowserSession.ts
apps/desktop/src/preview/Manager.test.ts
apps/desktop/src/preview/PickPreload.ts
apps/desktop/src/window/DesktopWindow.test.ts
apps/desktop/src/wsl/DesktopWslEnvironment.ts
apps/server/package.json
apps/server/src/attachmentStore.test.ts
apps/server/src/bin.ts
apps/server/src/cli/server.ts
apps/server/src/environment/ServerEnvironmentLabel.test.ts
apps/server/src/git/GitManager.test.ts
apps/server/src/git/GitManager.ts
apps/server/src/http.ts
apps/server/src/keybindings.test.ts
apps/server/src/mcp/McpHttpServer.ts
apps/server/src/orchestration/Layers/OrchestrationEngine.test.ts
apps/server/src/orchestration/Layers/ProviderCommandReactor.test.ts
apps/server/src/project/ProjectFaviconResolver.test.ts
apps/server/src/project/RepositoryIdentityResolver.test.ts
apps/server/src/provider/CodexDeveloperInstructions.ts
apps/server/src/provider/Drivers/CodexHomeLayout.test.ts
apps/server/src/provider/Layers/ClaudeAdapter.ts
apps/server/src/provider/Layers/ClaudeProvider.ts
apps/server/src/provider/Layers/CodexProvider.ts
apps/server/src/provider/Layers/CursorAdapter.test.ts
apps/server/src/provider/Layers/CursorProvider.test.ts
apps/server/src/provider/Layers/CursorProvider.ts
apps/server/src/provider/Layers/GrokAdapter.test.ts
apps/server/src/provider/Layers/GrokProvider.test.ts
apps/server/src/provider/Layers/GrokProvider.ts
apps/server/src/provider/Layers/OpenCodeAdapter.ts
apps/server/src/provider/Layers/OpenCodeProvider.ts
apps/server/src/provider/Layers/ProviderRegistry.test.ts
apps/server/src/provider/Layers/ProviderService.ts
apps/server/src/provider/acp/GrokAcpSupport.test.ts
apps/server/src/provider/acp/GrokAcpSupport.ts
apps/server/src/provider/copilot/CopilotProvider.test.ts
apps/server/src/provider/copilot/CopilotProvider.ts
apps/server/src/provider/copilot/ManagedClientEvidence.test.ts
apps/server/src/provider/copilot/ManagedClientEvidence.ts
apps/server/src/provider/copilot/ManagedClientEvidenceForwarder.test.ts
apps/server/src/provider/copilot/ManagedClientEvidenceTestConnection.test.ts
apps/server/src/provider/providerMaintenanceRunner.ts
apps/server/src/provider/providerStatusCache.test.ts
apps/server/src/server.test.ts
apps/server/src/serverRuntimeStartup.ts
apps/server/src/serverSettings.test.ts
apps/server/src/sourceControl/AzureDevOpsCli.test.ts
apps/server/src/sourceControl/BitbucketApi.test.ts
apps/server/src/sourceControl/BitbucketApi.ts
apps/server/src/sourceControl/BitbucketSourceControlProvider.test.ts
apps/server/src/sourceControl/GitHubSourceControlProvider.test.ts
apps/server/src/sourceControl/GitLabCli.test.ts
apps/server/src/sourceControl/GitLabSourceControlProvider.test.ts
apps/server/src/sourceControl/SourceControlProviderRegistry.test.ts
apps/server/src/sourceControl/SourceControlRepositoryService.test.ts
apps/server/src/startupAccess.ts
apps/server/src/terminal/Manager.test.ts
apps/server/src/textGeneration/ClaudeTextGeneration.test.ts
apps/server/src/textGeneration/CodexTextGeneration.test.ts
apps/server/src/textGeneration/CodexTextGeneration.ts
apps/server/src/textGeneration/CursorTextGeneration.test.ts
apps/server/src/textGeneration/GrokTextGeneration.test.ts
apps/server/src/textGeneration/OpenCodeTextGeneration.test.ts
apps/server/src/textGeneration/OpenCodeTextGeneration.ts
apps/server/src/vcs/GitVcsDriver.ts
apps/server/src/vcs/GitVcsDriverCore.test.ts
apps/server/src/vcs/GitVcsDriverCore.ts
apps/server/src/vcs/VcsProcess.test.ts
apps/server/src/vcs/VcsProjectConfig.test.ts
apps/server/src/vcs/VcsProjectConfig.ts
apps/server/src/vcs/VcsStatusBroadcaster.test.ts
apps/server/src/workspace/WorkspaceEntries.test.ts
apps/server/src/workspace/WorkspaceFileSystem.test.ts
apps/server/src/workspace/WorkspacePaths.test.ts
apps/web/index.html
apps/web/src/clientPersistenceStorage.test.ts
apps/web/src/clientPersistenceStorage.ts
apps/web/src/components/ChatView.logic.ts
apps/web/src/components/GitActionsControl.logic.test.ts
apps/web/src/components/chat/MessagesTimeline.test.tsx
apps/web/src/components/files/FilePreviewPanel.tsx
apps/web/src/components/files/filePath.test.ts
apps/web/src/components/preview/PreviewPanelShell.tsx
apps/web/src/components/preview/previewActionBus.ts
apps/web/src/composerDraftStore.ts
apps/web/src/connection/storage.ts
apps/web/src/diffPanelStore.ts
apps/web/src/editorPreferences.ts
apps/web/src/filePathDisplay.test.ts
apps/web/src/hooks/useLocalStorage.ts
apps/web/src/hooks/useTheme.test.ts
apps/web/src/hooks/useTheme.ts
apps/web/src/lib/openPullRequestLink.test.ts
apps/web/src/markdown-links.test.ts
apps/web/src/pierre-icons.ts
apps/web/src/providerUpdateDismissal.ts
apps/web/src/pullRequestReference.test.ts
apps/web/src/rightPanelStore.ts
apps/web/src/subagentUiStore.test.ts
apps/web/src/subagentUiStore.ts
apps/web/src/terminalUiStateStore.ts
apps/web/src/uiStateStore.ts
apps/web/src/versionSkew.ts
apps/web/src/worktreeCleanup.test.ts
docs/architecture/overview.md
docs/architecture/runtime-modes.md
docs/getting-started/codex-prerequisites.md
docs/integrations/source-control-providers.md
docs/operations/ci.md
docs/operations/observability.md
docs/providers/claude.md
docs/providers/codex.md
docs/reference/encyclopedia.md
docs/reference/scripts.md
docs/user/keybindings.md
experiments/messages-glass-lab/MessagesGlassLab/ContentView.swift
oxlint-plugin-t3code/index.ts
oxlint-plugin-t3code/package.json
oxlint-plugin-t3code/rules/namespace-node-imports.test.ts
oxlint-plugin-t3code/rules/no-global-process-runtime.test.ts
oxlint-plugin-t3code/rules/no-inline-schema-compile.test.ts
oxlint-plugin-t3code/rules/no-manual-effect-runtime-in-tests.test.ts
oxlint-plugin-t3code/rules/no-manual-effect-runtime-in-tests.ts
oxlint-plugin-t3code/test/utils.ts
package.json
packages/client-runtime/src/state/threadReducer.test.ts
packages/contracts/src/ipc.ts
packages/contracts/src/orchestration.test.ts
packages/contracts/src/settings.ts
packages/effect-codex-app-server/test/fixtures/codex-app-server-mock-peer.ts
packages/shared/src/agentAwareness.test.ts
packages/shared/src/git.test.ts
packages/shared/src/git.ts
packages/shared/src/logging.test.ts
packages/shared/src/schemaYaml.test.ts
pnpm-lock.yaml
pnpm-workspace.yaml
scripts/build-desktop-artifact.ts
scripts/dev-runner.test.ts
scripts/dev-runner.ts
scripts/lib/public-config.test.ts
scripts/notify-discord-release.test.ts
scripts/notify-discord-release.ts
scripts/rebase-upstream.sh
scripts/release-smoke.ts
vite.config.ts
```

### Exact Stage 3 identifier-only inventories

The 88 files with `"t3/` Effect/service/span tags are:

```text
apps/server/src/checkpointing/CheckpointDiffQuery.ts
apps/server/src/checkpointing/CheckpointStore.ts
apps/server/src/config.ts
apps/server/src/diagnostics/ProcessDiagnostics.ts
apps/server/src/diagnostics/ProcessResourceMonitor.ts
apps/server/src/diagnostics/TraceDiagnostics.ts
apps/server/src/environment/ServerEnvironment.ts
apps/server/src/git/GitManager.ts
apps/server/src/git/GitWorkflowService.ts
apps/server/src/keybindings.ts
apps/server/src/mcp/McpInvocationContext.ts
apps/server/src/mcp/McpSessionRegistry.ts
apps/server/src/mcp/PreviewAutomationBroker.ts
apps/server/src/observability/BrowserTraceCollector.ts
apps/server/src/orchestration/Services/CheckpointReactor.ts
apps/server/src/orchestration/Services/OrchestrationEngine.ts
apps/server/src/orchestration/Services/OrchestrationReactor.ts
apps/server/src/orchestration/Services/ProjectionPipeline.ts
apps/server/src/orchestration/Services/ProjectionSnapshotQuery.ts
apps/server/src/orchestration/Services/ProviderCommandReactor.ts
apps/server/src/orchestration/Services/ProviderRuntimeIngestion.ts
apps/server/src/orchestration/Services/RuntimeReceiptBus.ts
apps/server/src/orchestration/Services/ThreadDeletionReactor.ts
apps/server/src/persistence/ProviderSessionRuntime.ts
apps/server/src/persistence/Services/OrchestrationCommandReceipts.ts
apps/server/src/persistence/Services/OrchestrationEventStore.ts
apps/server/src/persistence/Services/ProjectionCheckpoints.ts
apps/server/src/persistence/Services/ProjectionPendingApprovals.ts
apps/server/src/persistence/Services/ProjectionProjects.ts
apps/server/src/persistence/Services/ProjectionState.ts
apps/server/src/persistence/Services/ProjectionThreadActivities.ts
apps/server/src/persistence/Services/ProjectionThreadMessages.ts
apps/server/src/persistence/Services/ProjectionThreadProposedPlans.ts
apps/server/src/persistence/Services/ProjectionThreadSessions.ts
apps/server/src/persistence/Services/ProjectionThreads.ts
apps/server/src/persistence/Services/ProjectionTurns.ts
apps/server/src/preview/Manager.ts
apps/server/src/preview/PortScanner.ts
apps/server/src/process/externalLauncher.ts
apps/server/src/processRunner.ts
apps/server/src/project/ProjectFaviconResolver.ts
apps/server/src/project/ProjectSetupScriptRunner.ts
apps/server/src/project/RepositoryIdentityResolver.ts
apps/server/src/provider/Layers/ClaudeAdapter.test.ts
apps/server/src/provider/Layers/CodexAdapter.test.ts
apps/server/src/provider/Layers/CursorAdapter.test.ts
apps/server/src/provider/Layers/OpenCodeAdapter.test.ts
apps/server/src/provider/Layers/ProviderEventLoggers.ts
apps/server/src/provider/Services/ProviderAdapterRegistry.ts
apps/server/src/provider/Services/ProviderInstanceRegistry.ts
apps/server/src/provider/Services/ProviderInstanceRegistryMutator.ts
apps/server/src/provider/Services/ProviderRegistry.ts
apps/server/src/provider/Services/ProviderService.ts
apps/server/src/provider/Services/ProviderSessionDirectory.ts
apps/server/src/provider/Services/ProviderSessionReaper.ts
apps/server/src/provider/acp/AcpSessionRuntime.ts
apps/server/src/provider/copilot/CopilotAdapter.test.ts
apps/server/src/provider/opencodeRuntime.ts
apps/server/src/provider/providerMaintenanceRunner.ts
apps/server/src/review/ReviewService.ts
apps/server/src/secrets/ServerSecretStore.ts
apps/server/src/serverLifecycleEvents.ts
apps/server/src/serverRuntimeStartup.ts
apps/server/src/serverSettings.ts
apps/server/src/sourceControl/AzureDevOpsCli.ts
apps/server/src/sourceControl/BitbucketApi.ts
apps/server/src/sourceControl/GitHubCli.ts
apps/server/src/sourceControl/GitLabCli.ts
apps/server/src/sourceControl/SourceControlDiscovery.ts
apps/server/src/sourceControl/SourceControlProvider.ts
apps/server/src/sourceControl/SourceControlProviderRegistry.ts
apps/server/src/sourceControl/SourceControlRepositoryService.ts
apps/server/src/telemetry/AnalyticsService.ts
apps/server/src/terminal/Manager.ts
apps/server/src/terminal/PtyAdapter.ts
apps/server/src/textGeneration/TextGeneration.ts
apps/server/src/transport/WslBearerAuth.ts
apps/server/src/vcs/GitVcsDriver.ts
apps/server/src/vcs/VcsDriver.ts
apps/server/src/vcs/VcsDriverRegistry.ts
apps/server/src/vcs/VcsProcess.ts
apps/server/src/vcs/VcsProjectConfig.ts
apps/server/src/vcs/VcsProvisioningService.ts
apps/server/src/vcs/VcsStatusBroadcaster.ts
apps/server/src/workspace/WorkspaceEntries.ts
apps/server/src/workspace/WorkspaceFileSystem.ts
apps/server/src/workspace/WorkspacePaths.ts
apps/server/src/workspace/WorkspaceSearchIndex.ts
```

The 21 files with additional `T3_*` symbols/private variables are:

```text
apps/desktop/src/wsl/DesktopWslEnvironment.test.ts
apps/desktop/src/wsl/wslNodeEnvironment.test.ts
apps/desktop/src/wsl/wslNodeEnvironment.ts
apps/server/scripts/acp-mock-agent.ts
apps/server/src/provider/CodexDeveloperInstructions.ts
apps/server/src/provider/Layers/CodexAdapter.ts
apps/server/src/provider/Layers/CursorAdapter.test.ts
apps/server/src/provider/Layers/CursorProvider.test.ts
apps/server/src/provider/Layers/GrokAdapter.test.ts
apps/server/src/provider/acp/AcpJsonRpcConnection.test.ts
apps/server/src/provider/acp/CursorAcpCliProbe.test.ts
apps/server/src/provider/acp/GrokAcpCliProbe.test.ts
apps/server/src/provider/acp/GrokAcpSupport.ts
apps/server/src/provider/acp/XAiAcpExtension.test.ts
apps/server/src/textGeneration/ClaudeTextGeneration.test.ts
apps/server/src/textGeneration/CursorTextGeneration.test.ts
apps/server/src/textGeneration/GrokTextGeneration.test.ts
apps/server/src/vcs/GitVcsDriverCore.test.ts
apps/web/src/components/files/FileBrowserPanel.tsx
apps/web/src/pierre-icons.test.ts
apps/web/src/pierre-icons.ts
```

## Stage 4 — desktop metadata, app identifiers, and icon assets

### Current verified state

These are already Neokod and should be asserted, not renamed again:

- `apps/desktop/package.json`: `productName: "Neokod"`.
- `apps/desktop/src/app/DesktopEnvironment.ts`: `APP_BASE_NAME = "Neokod"`, user-data names `neokod`/`neokod-dev`, app user model IDs `com.kamo62.neokod[.dev]`, Linux desktop/WM names.
- `apps/desktop/scripts/electron-launcher.mjs`: Neokod display names, `com.kamo62.neokod`, and `neokod`/`neokod-dev` schemes.
- `scripts/build-desktop-artifact.ts`: `DESKTOP_APP_ID = "com.kamo62.neokod"`, Neokod artifact/product/executable/protocol values.
- `apps/web/index.html`: title `Neokod (Alpha)`.
- Production raster artwork visually uses the Neokod `N` mark, although five filenames still begin `t3-black-`.

### Exact files/assets

- `apps/desktop/scripts/dev-electron.mjs`
- `apps/desktop/scripts/electron-launcher.mjs`
- `apps/desktop/scripts/electron-launcher.test.mjs`
- `apps/desktop/src/app/DesktopAppIdentity.ts`
- `apps/desktop/src/app/DesktopAppIdentity.test.ts`
- `apps/desktop/src/app/DesktopEnvironment.ts`
- `apps/desktop/src/app/DesktopEnvironment.test.ts`
- `apps/server/src/http.ts` for allowed desktop origins
- `apps/desktop/src/preview/BrowserSession.ts` and tests
- `apps/desktop/src/preview/PickPreload.ts`, `Annotation.css`, generated `AnnotationStyles.generated.ts`
- `apps/desktop/src/wsl/DesktopWslEnvironment.ts` and tests
- `scripts/build-desktop-artifact.ts`, `scripts/build-desktop-artifact.test.ts`
- `scripts/lib/brand-assets.ts`, `scripts/lib/brand-assets.test.ts`
- `docs/reference/scripts.md`, `docs/operations/observability.md`, `docs/operations/release.md`
- `experiments/messages-glass-lab/MessagesGlassLab.xcodeproj/project.pbxproj`
- `assets/dev/blueprint-icon-composer.icon/Assets/T3.svg`
- `assets/dev/blueprint-icon-composer.icon/icon.json`
- generated channel assets under `assets/dev/blueprint-{ios,macos,universal,web-apple-touch-180,web-favicon-16x16,web-favicon-32x32,web-favicon,windows}.*`
- corresponding `assets/nightly/blueprint-*` assets
- rename `assets/prod/t3-black-windows.ico`, `assets/prod/t3-black-web-favicon.ico`, `assets/prod/t3-black-web-favicon-16x16.png`, `assets/prod/t3-black-web-favicon-32x32.png`, and `assets/prod/t3-black-web-apple-touch-180.png` to `neokod-*` filenames and update references

### Change

1. Rename the desktop dev-process argument to `--neokod-dev-root` in launcher, cleanup, and tests.
2. Change server allowed desktop renderer origins from stale `t3code://app`/`t3code-dev://app` to the already-shipping `neokod://app`/`neokod-dev://app`; update docs/tests. No old-scheme fallback is required because the app bundle already registers only Neokod schemes.
3. Rename staged metadata `t3codeCommitHash` to `neokodCommitHash`; read the old field as a one-release packaged-artifact fallback. Rename WSL marker `t3code-wsl-node-pty.json` to `neokod-wsl-node-pty.json` in producer/consumer/tests.
4. Change staged package `author: "T3 Tools"` to the chosen Neokod publisher identity (`"Neokod"` unless release/legal metadata specifies another value). Legal `LICENSE` attribution remains unchanged.
5. Rename the experiment bundle identifier `com.t3tools.messagesglasslab` to `com.kamo62.neokod.messagesglasslab`.
6. Replace the actual dev/nightly T3 blueprint mark with a Neokod `N` blueprint variant, using the existing production Neokod mark/composer pipeline; regenerate every desktop/web/iOS size. Rename the source SVG/composer layer from `T3` to `Neokod`/`N`.
7. Rename the five production `t3-black-*` filenames to `neokod-*`; pixels already show the Neokod mark, so do not redesign them.
8. Assert window titles, About panel, bundle IDs, protocols, Linux executable/desktop names, Windows AppUserModelID, updater repo, artifacts, and icons in existing desktop/build tests. Do not change the already-correct bundle IDs again.
9. Finish the `3.0.0` changelog entry with metadata/icon details.

### KEEP vs RENAME

- KEEP: `com.kamo62.neokod`, `neokod` schemes, current Neokod titles/product names, production `N` artwork pixels, and upstream/legal references.
- RENAME: stale protocol allowlist/docs, dev arg, embedded commit field, WSL marker, experimental bundle ID, old asset filenames, and actual dev/nightly T3 artwork.
- COMPAT: old embedded `t3codeCommitHash` read only through `3.0.0`; no protocol/bundle-ID fallback.

### Verification

```bash
vp test run apps/desktop/src/app/DesktopAppIdentity.test.ts apps/desktop/src/app/DesktopEnvironment.test.ts apps/server/src/server.test.ts scripts/build-desktop-artifact.test.ts scripts/lib/brand-assets.test.ts
vp run typecheck
vp check
vp run build:desktop
vp run test:desktop-smoke

# No desktop-owned old identifier or filename may remain.
rg -n -i 'T3 Code|t3code|--t3|com\.t3|t3-black|T3\.svg' \
  apps/desktop apps/server/src/http.ts scripts/build-desktop-artifact.ts scripts/lib/brand-assets.ts assets experiments docs/operations docs/reference/scripts.md

# Existing correct metadata must remain present.
rg -n 'Neokod|com\.kamo62\.neokod|neokod-dev|artifactName: "Neokod|executableName: "neokod"' \
  apps/desktop scripts/build-desktop-artifact.ts apps/web/index.html
```

Visually inspect the generated 16 px, 32 px, 180 px, 512/1024 px, `.ico`, macOS, Windows, nightly, and dev assets; a filename-only pass does not complete the rebrand because the current blueprint assets visibly contain the T3 glyph.

### Risks

- Asset generation can silently leave stale channel sizes. Verify every generated target and the packaged artifact, not only source SVG/PNG.
- Changing macOS bundle IDs would break updater/keychain identity, so preserve the already-correct IDs exactly.
- The old renderer origins are stale relative to current Neokod schemes; fixing them may expose missing test coverage in packaged navigation, so run the desktop smoke test.
- Windows/WSL packaged marker changes must land producer and consumer together.

## Final acceptance gate

Run after all four stages:

```bash
vp test
vp run typecheck
vp check
vp run build
vp run build:desktop
vp run test:desktop-smoke

git remote get-url upstream
rg -n -i 'T3 Code|t3code|t3-code|\bt3\b|\bT3_[A-Z0-9_]+' \
  --hidden -g '!.git/**' -g '!.repos/**' -g '!node_modules/**' -g '!.plans/**'
rg -n 'npx neokod|neokod serve|NEOKOD_HOME|\.well-known/neokod|refs/neokod|com\.kamo62\.neokod' \
  README.md docs apps packages scripts
```

Acceptance requires:

1. `vp run typecheck` and `vp check` pass at every stage, with the stage-specific tests/builds above.
2. The final broad grep contains only the KEEP manifest and explicit `3.0.0` legacy migration compatibility literals/tests. There are zero unclassified current-product T3 strings.
3. `git remote get-url upstream` is still `https://github.com/pingdotgg/t3code.git`; `scripts/rebase-upstream.sh` still targets the `upstream` remote and still runs both repository gates.
4. `npx neokod@latest`/`neokod serve`, `NEOKOD_*`, `~/.neokod`, `.neokod/vcs.json`, `/.well-known/neokod/environment`, `neokod` MCP identity, Neokod storage keys, and Neokod desktop metadata/assets are the only current names.
5. A seeded legacy install proves the one-release migration: old env-only config, old `~/.t3` state, old `.t3code/vcs.json`, old localStorage keys, and old embedded commit metadata all remain usable under `3.0.0` with new names taking precedence.

## Planned commit boundaries

1. `rebrand: migrate NEOKOD env and home state`
2. `rebrand: rename CLI and package to neokod`
3. `rebrand: replace active T3 product identities`
4. `rebrand: finish desktop metadata and icon assets`

Each boundary is compile-safe, has its own grep gate, and can be reverted without leaving a mixed producer/consumer contract inside that stage.
