Finding: the fresh failure is a confirmed local response-schema mismatch for historical `subAgentActivity.kind`, not an unidentified resume failure.

The backend log at `/tmp/neokod-provider-reliability-2026-10-24/backend.log:93-94` records:

```text
SchemaError: Expected "started" | "interacted" | "interrupted", got "completed"
at ["thread"]["turns"][3]["items"][3]["kind"]
```

The enclosing command failure is the supplied older disposable thread `bfd2de18-8c0d-4dd0-9a35-7694a0a571a7`, backend timestamp `12:21:43.678`, operation `turn-start`, method `thread/resume`, operation `decode-payload`. These are structural diagnostics only; no message body or credential is needed to identify the mismatch.

Runtime/source boundary: the backend stack names `/Users/kamogelo/.codex/worktrees/neokod-core-execution/t3code`. I verified that checkout is exactly `3b134e4dcfb0d909601eed00f822b2b6c7013be1` and traced that source. The ordinary `/Users/kamogelo/Code/t3code` checkout is at a different HEAD and was not used as the final runtime source. Codex app-server version `0.163.0` is the version supplied by root; no process/version command was run during this investigation.

Exact path through the client:

1. `provider/Layers/CodexSessionRuntime.ts:477` requests `thread/resume` when the session has a provider resume cursor.
2. `packages/effect-codex-app-server/src/client.ts:201-214` encodes the request, awaits the transport response and then decodes the raw response using the method's response schema. This observed error is in that final response decode, not request encoding or a wire-level JSON parse.
3. `_generated/meta.gen.ts:591` maps `thread/resume` to `V2ThreadResumeResponse`.
4. `_generated/schema.gen.ts:40896` validates the response, including its nested thread/turn/item history. The `subAgentActivity` item branch at `24861-24870` validates `kind` using `V2ThreadResumeResponse__SubAgentActivityKind`.
5. That exact enum at `8358-8363` accepts only `started`, `interacted` and `interrupted`; the logged response contains `completed`. The item type declaration at `24625-24632` uses the same enum.
6. `_internal/shared.ts:34-37` wraps the schema failure in `CodexAppServerRequestError.invalidPayload`. `errors.ts:354-367` adds the generic method/operation message and preserves the SchemaError as its cause. The adapter then surfaces the request failure as a process/start-session failure. The generic outer message hides the useful detail unless the nested cause is retained, but the fresh backend log does retain it.
7. The existing fallback only handles missing/unknown-thread errors (`CodexSessionRuntime.ts:57-64`, `430-440`, `482-491`). This validation error intentionally does not qualify. Falling back to a fresh thread would conceal a compatibility failure and discard continuation context.

Why fresh start can succeed: the failure is in decoding resumed history. A newly started thread does not initially contain the offending historical item. Root's fresh-thread `CODEX_FRESH_1024_OK` result is consistent with this mechanism; it does not prove that fresh thread will resume successfully after native child history is stored.

Bounded provider-log inspection:

- Inspected only the supplied older and fresh disposable thread log files under `/tmp/neokod-implementation-2026-10-23/runtime/dev/logs/provider`, parsing structural keys without printing text, paths, prompts or child IDs.
- Older thread: four native `subAgentActivity` observations, two item/started and two item/completed; every observed `kind` was `started`. Their item field names were only `agentPath`, `agentThreadId`, `id`, `kind`, `type`.
- Fresh thread: the same structural pattern, four observations with `kind: started`.
- Neither file contains the raw failing resume response or the `Invalid payload` diagnostic. Thus these accepted live-event logs do not independently expose the historical `kind: completed` object. The precise failing value/path is established by the backend SchemaError, not reconstructed from unrelated history.

Schema provenance and limits:

- The generated source header records upstream ref `25af12f7e61572b0bc18ddb1008be543b91519b0`. The generator's current source comment calls this release pin `rust-v0.145.0` (2026-07-21), while the supplied runtime binary is 0.163.0. This is concrete evidence that the checked-in generated provenance does not describe the supplied binary version. It does not by itself establish which local compatibility additions produced the current generated file.
- Equivalent three-value `SubAgentActivityKind` declarations appear in item notification, turn, read, resume and other response schema families. A live `completed` kind would also fail notification validation and be dropped by the client's existing decode-error handler (`client.ts:144-160`). That is a conditional source consequence. The two inspected provider logs do not prove that live notification drop occurred.

Minimal further evidence, if root later authorises a reproduction or diagnostic change:

1. Existing backend diagnostic plus the exact source/binary versions is already enough to identify the immediate decode blocker. Do not capture a full response just to rediscover it.
2. To construct a source-faithful fixture or verify whether more than one value is missing, capture only the failing response item's discriminator and structural projection: method, issue path, item type, item kind and item field names. For this case the expected safe projection is `{method: "thread/resume", path: ["thread", "turns", 3, "items", 3, "kind"], type: "subAgentActivity", kind: "completed", fieldNames: [...]}`. Whitelist `type` and `kind`; omit `agentPath`, IDs, thread content, tool payloads, environment and credentials.
3. Record the method-specific allowed kinds from the actual 0.163 protocol schema, using a permitted existing source/schema artefact or a separately authorised schema export. No provider call or schema-export process was run here.

Smallest supported correction direction: align the applicable generated `SubAgentActivityKind` schema families with the actual protocol, preserving existing strict decoding and the reviewed parent/child semantics. `completed` must be accepted as an observed protocol value where supplied; accepting it should not by itself fabricate parent completion or change child-card authority. Avoid a generic validation bypass, untyped history discard, or fresh-thread fallback for schema errors. This investigation does not implement or validate a fix.

Actions performed: read-only source/log inspection and this report only. No provider calls, process launches/signals, source edits, tests, installs or browser actions. Reviewer configuration: gpt-6.1-sol, high, as delegated.
