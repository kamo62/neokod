# OpenCode 2 ACP parity spike (O2)

Date: 22 October 2026
Branch: `work/opencode2-acp-parity`, based on `dev` `8c0fc44c8`
Implementer: actual DeepSeek V4.1 Flash through OpenCode 2.0.32 ACP, session
`ses_e9e316707ffeMcrQsNw3dGpqzZ`, requested and selected model
`deepseek/deepseek-flash`.
Scope: staged internal support seam plus deterministic protocol tests. This is
not OpenCode 2 product support, not an adapter migration, and not the O3 HTTP
runtime. The support module is deliberately unwired.

## What this spike adds

- `apps/server/src/provider/acp/OpenCodeAcpSupport.ts`
  - `buildOpenCodeAcpSpawnInput` builds `opencode acp` with the supplied `cwd`
    and environment. A supplied environment is passed exactly with
    `extendEnv: false`; the builder never reads `process.env`.
  - `makeOpenCodeAcpRuntime` reuses the existing
    `AcpSessionRuntime.layer`. It pins the advertised `opencode-login` auth
    method, leaves client `fs` and `terminal` capabilities false, and does not
    accept an auth override or a pre-authenticated environment claim.
  - `inspectOpenCodeAcpCapabilities` reads the advertised `model`,
    `thought_level` effort, and `mode` select options.
  - `applyOpenCodeAcpSelection` writes those options through
    `session/set_config_option`. It applies model first because OpenCode 2.0.32
    changes the effort values after a model switch. It rejects an unadvertised
    option or value before sending an RPC.
  - `runOpenCodeAcpTextPrompt` delegates to the shared filtered event collector
    and returns the prompt stop reason and provider usage. Timeout and
    structured-output policy remain with a future caller.
- `apps/server/src/provider/acp/AcpAssistantText.ts` is the single shared
  collector. It consumes raw session updates, discards every update received
  during startup/load, and ignores non-root sessions. This preserves
  whitespace-only assistant chunks that the shared event projection drops after
  a tool update closes the active segment. Cursor and Grok text generation now
  use this helper instead of their own copies of the raw handler loop.
- `apps/server/scripts/opencode2-acp-mock-agent.ts` is a deterministic ACP
  fixture shaped from 2.0.32 receipts. It is not the OpenCode CLI and makes no
  provider call. It remains separate from the shared Cursor/Grok fixture because
  it models OpenCode 2.0.32's auth method, absent `modes`, config-option set,
  unsupported `session/set_model`, and MCP transport filter.
- `apps/server/src/provider/acp/OpenCodeAcpSupport.test.ts` exercises the real
  `AcpSessionRuntime` through that fixture. Wrapper temp directories are
  released with the test scope, and cleanup is asserted through the fixture's
  exit-log hook.

No changes were made to `AcpSessionRuntime.ts`, `AcpRuntimeModel.ts`,
`OpenCodeAdapter.ts`, `OpenCodeRuntime`, OpenCode drivers, the provider
registry, the SDK dependency, or the lockfile. The only production call-site
changes are the minimal Cursor and Grok text-generation switches to the shared
collector. No client capability, auth override, or product wiring was added.

## Evidence read

- Real lane receipts under
  `/tmp/neokod-core-symphony-2026-10-21/acp/`:
  - `lane-opencode2-acp-parity-selection.json` records
    `requestedModel: deepseek/deepseek-flash`, session
    `ses_e9e316707ffeMcrQsNw3dGpqzZ`, and the selected model.
  - `lane-opencode2-guard-events.jsonl` contains the 2.0.32 initialize result,
    `session/new`, model/effort/mode config options, and streamed update shapes.
  - Across 51 lane receipt files, every initialize result identifies
    `OpenCode` `2.0.32`. Observed `session/update` kinds include
    `agent_thought_chunk` (53,384), `tool_call_update` (13,766), `tool_call`
    (5,293), `agent_message_chunk` (1,394), `available_commands_update` (51),
    `usage_update` (45), `config_option_update` (23), and
    `session_info_update` (8).
- Installed `/Users/kamogelo/.opencode/bin/opencode` embedded bundle, including
  the ACP service object around string offsets 354329 and 381887. It confirms
  the `opencode-login` method, `authenticate` returning success for that method,
  `session/new` MCP filtering, `session/load` replay, `session/resume`,
  `session/close`, config option writes, cancellation stop reasons, and the
  absence of a `session/set_model` handler.
- `packages/effect-acp/src/_generated/schema.gen.ts` for the wire shapes.
- Shared runtime paths: `apps/server/src/provider/acp/AcpSessionRuntime.ts`
  (spawn, auth, start, prompt, cancel, config options, event queue) and
  `apps/server/src/provider/acp/AcpRuntimeModel.ts` (parsing).

## Parity matrix

| Area                                  | OpenCode 2.0.32 evidence                                                                                                                                                                                                                                              | Shared runtime and wrapper result                                                                                                                                                                                                                                                                                                                 | Demonstrated by                                                                                                                                                                                                                                                         | Status                                                                                                     |
| ------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| Initialisation and new session        | Initialize result: load/session capabilities, HTTP MCP only, embedded context and image prompts, auth method `opencode-login`, `agentInfo` 2.0.32. `session/new` returns a session id and model/effort/mode config options.                                           | Wrapper sends the shared handshake with `fs` and `terminal` false, authenticates with `opencode-login`, creates a session in the supplied `cwd`, and exposes the model config id.                                                                                                                                                                 | `initializes, authenticates, creates a session, and forwards MCP servers`; unadvertised-auth test                                                                                                                                                                       | Fixture and source evidence. Live parity not run.                                                          |
| Load and resume                       | Agent advertises `loadSession` and `sessionCapabilities.resume`. Load replays history; resume does not.                                                                                                                                                               | `resumeSessionId` calls `session/load` only. Replay updates are suppressed by the shared load gate. The wrapper never calls `session/resume`.                                                                                                                                                                                                     | `loads an existing session, suppresses replay, and then streams new output`; `surfaces a session/load failure without falling back to a new session`                                                                                                                    | Load path demonstrated. `session/resume` is an unused capability (delta).                                  |
| Model, effort, mode                   | `session/new` advertises `model` (`model`), `effort` (`thought_level`), and `mode` (`mode`) select options. Effort values are model-specific. The ACP service has no `session/set_model` handler.                                                                     | Selection uses the existing runtime's `set_config_option` path. Model is written first, then effort, then mode. Unknown options or values fail before RPC.                                                                                                                                                                                        | `applies model, effort, and mode through advertised config options`; model-specific effort rejection test                                                                                                                                                               | Advertised config path demonstrated. `session/set_model` is unsupported.                                   |
| Streamed assistant and tool events    | Receipts show `agent_message_chunk`, `agent_thought_chunk`, `tool_call`, `tool_call_update`, `config_option_update`, `usage_update`, `session_info_update`, and `available_commands_update`. Tool kinds include execute, edit, read, search, fetch, think, and other. | `agent_message_chunk` becomes assistant segments and content deltas. `tool_call` and `tool_call_update` become tool lifecycle events. Thought chunks, usage updates, command updates, config updates, and session info are ignored by the shared parser.                                                                                          | `streams assistant text and ignores unsupported OpenCode 2 updates`; `carries tool calls and answers a permission request through the runtime`                                                                                                                          | Partial parity. Assistant and tool events demonstrated; reasoning, usage, and session metadata are deltas. |
| Permission request and answer         | Agent can send `session/request_permission` with tool-call context and allow/reject options.                                                                                                                                                                          | Wrapper exposes the shared handler. The test answers `allow-once`; the agent continues and completes the tool.                                                                                                                                                                                                                                    | `carries tool calls and answers a permission request through the runtime`                                                                                                                                                                                               | Demonstrated through the shared runtime.                                                                   |
| Cancellation versus confirmed closure | Prompt responses map interrupted execution to `cancelled`, and otherwise return `end_turn`, `max_tokens`, or `refusal`. A confirmed cancelled response can carry usage.                                                                                               | `cancel` interrupts the local prompt fiber and returns a synthetic `cancelled` response without usage, then forks `session/cancel` without awaiting delivery. A provider-confirmed cancelled response carries usage. The result does not identify which path produced `cancelled`.                                                                | `returns a synthetic cancelled result for a local cancel`; `passes through an agent-confirmed cancelled turn with its usage evidence`; `surfaces a failed prompt as a failure rather than cancellation`                                                                 | Semantic gap. Cancellation exists, but provenance and notification dispatch are not represented.           |
| Terminal and fs capabilities          | OpenCode 2.0.32 executes its own tools. The client capability surface is separate.                                                                                                                                                                                    | The wrapper advertises `fs.readTextFile: false`, `fs.writeTextFile: false`, and `terminal: false`. No client-side terminal or fs handler is claimed.                                                                                                                                                                                              | Initialize payload assertion in the first test                                                                                                                                                                                                                          | Declared unsupported. No parity claim.                                                                     |
| MCP injection                         | Agent advertises HTTP MCP only (`http: true`, `sse: false`) and its `session/new`/`load` code accepts stdio and HTTP, rejecting SSE and ACP MCP entries.                                                                                                              | The wrapper forwards `mcpServers` unchanged on `session/new` and `session/load`. The fixture accepts HTTP and stdio and rejects SSE, matching the agent. The shared runtime does not prefilter against `mcpCapabilities`.                                                                                                                         | `initializes, authenticates, creates a session, and forwards MCP servers`; `lets OpenCode 2 reject an MCP transport it does not advertise`                                                                                                                              | HTTP and stdio demonstrated. SSE rejection is agent-enforced, not wrapper-enforced.                        |
| Model review text generation          | `agent_message_chunk` streams text. Prompt responses carry stop reason and usage.                                                                                                                                                                                     | `runOpenCodeAcpTextPrompt` delegates to `collectAcpAssistantText`, which consumes raw session updates, discards startup/load updates and ignores non-root sessions. Whitespace-only chunks after a tool boundary are preserved for Cursor and Grok. It is not wired into the provider registry or `textGeneration`.                               | `collects model-backed review text without changing runtime ownership`; `excludes load replay from text generation`; `excludes assistant chunks from a foreign session in text generation`; Cursor/Grok `preserves whitespace across tool-interleaved assistant chunks` | Seam demonstrated. Product text-generation integration is absent.                                          |
| Stop and process ownership            | ACP advertises `session/close`; the agent also owns its own execution lifecycle.                                                                                                                                                                                      | The wrapper keeps the child in the shared runtime scope. `pid` is available. `identity` stays null because the wrapper does not request a detached spawn, even though the platform spawner may detach by default on POSIX. The wrapper never calls `session/close`. Scope closure is asserted through the fixture's exit log.                     | Child pid/identity assertion; `writes the fixture exit log when the wrapper scope ends`; existing `CursorAdapter` cleanup test                                                                                                                                          | Partial. Direct scope cleanup is execution-proven; group identity and ACP close are not demonstrated.      |
| Auth                                  | Agent advertises exactly `opencode-login`; `authenticate` returns success for that id after the CLI is logged in.                                                                                                                                                     | The wrapper pins that id and fails closed if the agent advertises a different set. No credential environment variable is read, filtered, printed, or required by this seam.                                                                                                                                                                       | First test; unadvertised-auth test                                                                                                                                                                                                                                      | ACP handshake demonstrated. Real logged-out behaviour was not run.                                         |
| Cleanup and timeouts                  | Agent load replays history and can fail. Prompt and load errors are ordinary ACP errors.                                                                                                                                                                              | Scope closure owns the child through the shared runtime, removes the fixture wrapper directory, and writes the fixture exit log. Load failure surfaces without a `session/new` fallback. The shared runtime has a load timeout option, but this spike did not produce a deterministic timed-out RPC; a pure hanging load was not a sound fixture. | `writes the fixture exit log when the wrapper scope ends`; `removes the fixture wrapper directory when the wrapper scope ends`; load failure test                                                                                                                       | Scope cleanup and load failure demonstrated. Timeout behaviour is source-only, not execution-proven.       |

Model-first selection is not transactional. Because OpenCode 2.0.32 changes the
advertised effort values after a model switch, a valid model write can precede
an effort rejection. The rejection data includes `appliedConfig` so the caller
can see what changed.

## Unsupported methods and deltas with source paths

- **`session/set_model` is absent in 2.0.32.** The embedded ACP service exposes
  `setSessionConfigOption` and `setSessionMode` only. The shared runtime has a
  `setSessionModel` method (`AcpSessionRuntime.ts`) that OpenCode 2.0.32 will
  answer with method-not-found. The wrapper uses `session/set_config_option`.
- **`session/resume` is advertised but unused.** `AcpSessionRuntime.startOnce`
  selects only `session/load` when `resumeSessionId` is set. OpenCode 2.0.32
  advertises resume and would avoid replay with it.
- **`session/close` is advertised but unused.** The shared runtime has no close
  call; cleanup is process-scope ownership. A long-lived shared ACP process
  would need explicit close or detach semantics.
- **`config_option_update` is ignored.** `AcpRuntimeModel.parseSessionUpdateEvent`
  does not handle it. `AcpSessionRuntime` updates its config snapshot from the
  `session/set_config_option` response, so agent-initiated config changes are
  not reflected.
- **`agent_thought_chunk` is ignored.** The parser handles
  `agent_message_chunk` only. OpenCode 2.0.32 emits reasoning as thought chunks,
  so Neokod does not surface that stream.
- **`usage_update` and `session_info_update` are ignored.** Prompt usage is
  passed through on `PromptResponse`, but streamed cost/context and session
  metadata updates are not projected.
- **MCP capability validation is agent-side.** The wrapper forwards all MCP
  entries. OpenCode 2.0.32 itself rejects SSE and ACP entries. A future adapter
  should decide whether the host pre-validates against `mcpCapabilities`.
- **Whitespace-only assistant chunks are dropped at tool boundaries.** When a
  tool update closes the active assistant segment, `AcpSessionRuntime` ignores a
  following whitespace-only `agent_message_chunk` until a new segment starts.
  The shared event projection cannot reconstruct the space. The text-generation
  collector avoids this by reading raw updates, but event consumers still lose
  the chunk. This needs a scoped shared-runtime correction.
- **Cancellation provenance is lost.** `AcpSessionRuntime.cancel` interrupts the
  local prompt fiber, synthesises `{ stopReason: "cancelled" }`, and forks
  `session/cancel` without awaiting it. A local cancel and an agent-confirmed
  cancelled response are indistinguishable except by the presence of usage.
- **Process identity is not recorded by default.** The platform spawner defaults
  to a detached process group on POSIX, while `AcpSessionRuntime` records
  `identity` only when `spawn.detached === true`. The wrapper does not set that
  flag, so ownership evidence is absent even though a group may exist.

## Shared-runtime questions returned to main

These are design decisions, not edits made in this lane:

1. Should cancellation carry explicit provenance (local request versus provider
   confirmation) and should `cancel` await notification dispatch?
2. Should the shared runtime prefer `session/resume` when advertised, and call
   `session/close` when the host keeps a long-lived ACP process?
3. Should `config_option_update`, `agent_thought_chunk`, `usage_update`, and
   `session_info_update` be projected, or left to a future provider adapter?
4. Should the runtime record process-group identity when the platform spawner
   detaches by default, rather than only when the caller sets `detached`?
5. Should the host validate MCP transports against the advertised capabilities
   before `session/new`?

None of these were implemented because the O2 acceptance requires a bounded
wrapper and fixture proof, and because `AcpSessionRuntime` and
`AcpRuntimeModel` were read-only in this lane.

## Review corrections

- **Tool-interleaved whitespace loss (Sol P2, second review).** The shared
  collector now consumes raw session updates and applies startup/load and
  root-session filtering itself. This keeps whitespace-only chunks that the
  runtime event projection drops after a tool update closes the active segment.
  Regressions: Cursor and Grok `preserves whitespace across tool-interleaved
assistant chunks`. Both failed with `Fixname` on `efc95a2d8` and pass after
  the fix. The shared runtime projection still drops those chunks for event
  consumers; that correction belongs to main.
- **Replay and foreign-session text collection (Sol P2).** `runOpenCodeAcpTextPrompt`
  now delegates to `collectAcpAssistantText`, which discards every raw update
  received during startup/load, ignores marked replay updates, and filters to
  the started root session. Regressions: `excludes load replay from text
generation` and `excludes assistant chunks from a foreign session in text
generation`. Both fail on `74e016f36` and pass after the fix.
- **Selection evidence mutation (Sol P2).** `applied` is allocated inside the
  selection Effect, so repeated execution returns independent evidence.
  Regression: `keeps each selection execution's applied evidence independent`.
  It fails on `74e016f36` and passes after the fix.
- **Third text-collection copy (Claude P3).** The loop was extracted to
  `AcpAssistantText.ts`; Cursor and Grok text generation call it instead of
  keeping their own raw handlers.
- **Unasserted cleanup (Claude P3).** `writes the fixture exit log when the
wrapper scope ends` closes the wrapper scope and waits for the fixture's
  `SIGTERM` log line.
- **Leaked temp wrapper directories (Claude P3).** `makeRuntime` acquires the
  fixture wrapper directory with a scoped release, and `removes the fixture
wrapper directory when the wrapper scope ends` asserts removal.
- **Second fixture (Claude P3).** The fixture header and "What this spike adds"
  record why it stays separate from the shared Cursor/Grok fixture.
- **MCP rejection label (Claude P3).** The report and test identify SSE rejection
  as agent-enforced evidence, not wrapper-enforced capability validation.

## Verification

Environment: Node `v24.22.1` at
`/tmp/neokod-core-symphony-2026-10-21/node-v24.22.1-darwin-arm64/bin`.

- `vp test run src/provider/acp/OpenCodeAcpSupport.test.ts` in `apps/server`:
  21 tests passed.
- `vp test run src/textGeneration/CursorTextGeneration.test.ts
src/textGeneration/GrokTextGeneration.test.ts`: 12 tests passed.
- `vp run typecheck` in `apps/server`: exit 0.
- `vp lint` on the changed source and fixture files: clean.
- `vp fmt --check` on the changed source, test and fixture files: clean.
- `git diff --check`: clean.

No application, Electron, browser, Docker, or real OpenCode process was
launched. No provider prompt or credential read occurred. The fixture is a
local Node process speaking ACP over stdio. This is protocol and runtime seam
evidence, not live OpenCode 2 execution parity.
