# Independent review: 512c36be9 vs eef750bfb (Codex subAgentActivity `completed`)

Verdict: **ACCEPT**

Reviewer: Claude Opus 5.5 through GitHub Copilot (authorised fallback), high reasoning as configured for this session. No delegation. Earlier fallback answers were read only to check for disagreement. Every finding below was re-derived from source and upstream schema files.

Scope: `/Users/kamogelo/.codex/worktrees/neokod-native-orchestration/t3code`, HEAD `512c36be9da6033d85b9ffdf4a192524e0494a78`. The worktree was clean. The diff against `eef750bfbf86c9d6c1943211678f8f7a1a91386e` touches exactly three files:

- `packages/effect-codex-app-server/scripts/generate.ts`
- `packages/effect-codex-app-server/src/_generated/schema.gen.ts`
- `packages/effect-codex-app-server/src/protocol.test.ts`

Context read: `README.md`, root `AGENTS.md`, `docs/architecture/state-and-evidence.md`, and `/tmp/neokod-provider-reliability-2026-10-24/sol-resume-trace.md`. The trace documents this failure: `thread/resume` decode, `Expected "started" | "interacted" | "interrupted", got "completed"` at `thread.turns[3].items[3].kind`.

## 1. Bounded enum compatibility: pass

- `schema.gen.ts` has 16 `*__SubAgentActivityKind` definitions: ServerNotification, V2ItemCompleted/Started notifications, V2ReviewStart, ThreadFork, ThreadList, ThreadMetadataUpdate, ThreadRead, ThreadResume, ThreadRollback, ThreadStarted, ThreadStart, ThreadUnarchive, TurnCompleted, TurnStarted and TurnStart. All 16 changed. Each TypeScript union and its `Schema.Literals` array now contain exactly `started | interacted | interrupted | completed`. The kind remains a closed set; nothing falls back to string.
- All 16 `subAgentActivity` item branches use the local enum (`kind: <Family>__SubAgentActivityKind`). No inline copy or cross-file reference was missed.
- **New independent evidence:** I fetched the published upstream schema `openai/codex@rust-v0.163.0` `codex-rs/app-server-protocol/schema/json/v2/ItemCompletedNotification.json` (read-only). It defines `SubAgentActivityKind.enum = ["started","interacted","interrupted","completed"]`, which matches this commit's set and order. `completed` is therefore part of the official 0.163.0 protocol, not just a value observed in practice. The pinned ref `25af12f7…` (`ThreadResumeResponse.json`) lists only the three earlier values. That confirms the root cause was the pinned schema being out of date.

## 2. Generator targeting: pass

- `generate.ts:589-603` checks the raw upstream definition name (`definitionName === "SubAgentActivityKind"`) before reference rewriting and nullable or default normalisation. The per-file rename (`${exportName}__${definitionName}`) is applied after this check, so the rule reaches every namespaced copy and nothing else.
- `extendObservedSubAgentActivityKind` (`generate.ts:285-313`) changes the definition only when it is a plain object with an `enum` array that contains all three pinned values and does not yet contain `completed`. It then appends `completed`. It is idempotent, and it becomes a no-op once the pin moves to a release such as 0.163.0 that already lists `completed`. It never widens the kind to a string.
- The fetched pinned-ref schema has exactly the expected shape (`{enum:[3 values], type:"string"}`). The guard matches it, and appending gives the order seen in `schema.gen.ts`. The hand-checked delta is therefore consistent with what the generator would produce. I did not run the generator, so byte-for-byte regeneration is not proven.

## 3. Unknown kind rejection: pass

- `protocol.test.ts:109-143` decodes the same fixture twice with only `kind` changed, through the real method maps `CLIENT_REQUEST_RESPONSES["thread/resume"]` and `SERVER_NOTIFICATION_PARAMS["item/completed"]` (`meta.gen.ts:591`, `740`). `"unknownActivity"` must fail on both paths.
- The `completed` decodes run first and are yielded, so a failure would fail the test. This stops an otherwise invalid fixture from making the negative assertions pass by accident. I checked the fixture against the generated `V2ThreadResumeResponse`, `__Thread`, `__Turn`, AgentMessage/SubAgentActivity items and `V2ItemCompletedNotification`. All required fields are present, and `never`, `user`, `dangerFullAccess`, `cli`, `idle` and `completed` are valid literals.

## 4. Parent/child lifecycle isolation: pass (unchanged code, verified by reading source)

- `apps/server/src/provider/Layers/CodexAdapter.ts:610`: `subAgentActivityTaskEvents` returns `[]` unless `kind === "started"`. The `item/started` (`1110-1111`) and `item/completed` (`1128-1129`) branches return through that helper before the generic item lifecycle runs. A `completed` activity therefore creates no card, closes no card, does not reach parent item lifecycle, and fabricates no `task.completed`.
- `apps/server/src/provider/Layers/CodexSessionRuntime.ts:626`: lineage (`childThreadTurns`) is recorded for every kind, including `completed`. This is routing only, the same as the existing `interacted` and `interrupted` handling.
- Resume history is not replayed as runtime events. `openCodexThread` (`CodexSessionRuntime.ts:456-492`) only needs the response to decode. The `thread/read` and `thread/rollback` snapshot only carries `turns[].items` through to callers. Accepting `completed` in history therefore changes no lifecycle.
- The fresh-start fallback is still limited to recoverable missing-thread errors (`isRecoverableThreadResumeError`). Schema failures were not turned into a silent fallback. This matches trace step 7 and state-and-evidence principle 1 (a failure is not replaced with a default).
- This also follows state-and-evidence: the child's own `turn/completed` / `turn/aborted` stays the authority for closure, and an ambiguous parent-side activity value is not treated as a terminal outcome.

## 5. Meaningful regression: pass

- The fixture reproduces the reported failure: the item sits at `thread.turns[3].items[3]` in a `thread/resume` response, with `cliVersion: "0.163.0"`. Before this commit it would fail with the exact SchemaError in the trace. The test also covers the live `item/completed` path, which `client.ts` would previously have dropped through its decode-error handler.
- It guards regeneration as well. If upstream reshaped or renamed the definition and the generator silently skipped the change, this test would fail.

## Non-blocking observations

1. **Wider 0.163 schema drift (most important follow-up, outside this commit).** Comparing the pinned ref with the `rust-v0.163.0` `ItemCompletedNotification.json` shows other values that the checked-in schema would still reject in resumed history or live notifications:
   - the `functionCallOutput` thread item type, which is absent from `schema.gen.ts` (0 matches);
   - `CollabAgentTool` values `sendMessage`, `followupTask`, `interruptAgent` and `listAgents` (0 matches);
   - `CollabAgentToolCallStatus` value `interrupted`;
   - `MessagePhase` value `partial_answer`.

   Extra optional fields, such as `agentMessage.delivery`/`questions` and `subAgentActivity.model`/`reasoningEffort`, should be harmless under the default excess-property handling. A 0.163 thread whose history contains any of the values above would still fail `thread/resume` the same way. I recommend a separate pin refresh to `rust-v0.163.0`, regenerated, which would also make this shim a no-op. Alternatively, add targeted equivalents. This does not block the scoped fix.

2. The `generate.ts:285-290` doc comment says the value is "observed". It could also cite the published `rust-v0.163.0` schema as provenance.
3. The guard in `extendObservedSubAgentActivityKind` silently returns the definition unchanged when the shape does not match. A `GeneratorError` for a `SubAgentActivityKind` whose shape is not recognised would make drift visible at generation time. Today the protocol test catches it later, at test time.
4. The comment above `subAgentActivityTaskEvents` in `CodexAdapter.ts:596-603` does not mention `completed` (outside the commit). There is also no adapter-level test showing that a `completed` activity emits no events. The `!== "started"` guard makes this correct today.
5. The generated header still records upstream ref `25af12f7…` (rust-v0.145.0), while the runtime binary is 0.163.0. See item 1.

## Limitations

- No tests, typecheck, `vp check`, build, generator run, provider call, install, signal, edit, commit or push was performed. The only file written is this report. Pass/fail of the new test and of typecheck rests on reading the code. The implementer's reported check results were not rerun.
- Two read-only HTTPS fetches of upstream schema files from `raw.githubusercontent.com` (pinned ref and `rust-v0.163.0` tag) were used as provenance evidence.
- A real Codex 0.163.0 `thread/resume` of the failing thread `bfd2de18-…` after this change has not been run, so that live check is still open. It may still fail because of the drift in observation 1 if that history contains those values.
