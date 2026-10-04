# S1 W1 Symphony runner cards (H0, 1.1 to 1.8)

Base commit da7655bb2, branch fix/symphony-runner-and-config-wip.

## Commit order and dependency map

Recommended commit order (one commit per card, in this order):

1. H0 shared fake-Codex harness (no dependencies)
2. 1.1 `rawStreams` option on the Codex client (H0 only for the AgentRuntime test)
3. 1.2 decision mapping and user-input response shape (needs 1.1 and H0)
4. 1.3 approval id spaces (needs 1.2)
5. 1.4 turn status pinning, EOF and termination (needs 1.1, H0)
6. 1.6 `testing` to `retry_scheduled` (independent, small; do it before 1.5 so 1.5 can build on a working retry path)
7. 1.5 cancel, exhaustion and terminal-failed refusal (needs 1.6, 1.4 recommended)
8. 1.7 early failure writes an attempt row (needs 1.5)
9. 1.8 fork dispatch out of the tick and the RPC (needs 1.5 and 1.7 so the forked run cannot loop)

Plan corrections found while reading the code (details inside each card):

- H0: `makeInMemoryStdio` is internal to `packages/effect-codex-app-server` and not in its `package.json` exports, so apps/server cannot reuse it. The harness plugs in at the `ChildProcessSpawner` seam instead.
- 1.2: the plan only lists the approval enum. The user-input reply is also wrong: AgentRuntime sends `{ text }` but Codex requires `{ answers: { [questionId]: { answers: string[] } } }`. The `else` branch replying `{}` is invalid for every Codex request and is fixed in the same card.
- 1.3: no contract change is needed. The RPC input name is `requestId` and the web caller already sends the durable `sym-<uuid>` attention id. The durable `ApprovalRepository.decide` is also called with the wrong id today (live id against the `id` column), so the durable row is never decided.
- 1.4: Dispatcher already ends the attempt failed when `runTurn` fails, so a failed turn only needs `runTurn` to fail. Per-turn consumer fibers also leak and steal notifications from later turns, which is fixed here.
- 1.5: plan row says user cancel "sets `blocked`". The code already allows `cancelled` from `preparing`, `running`, `testing`, `waiting_for_approval`, `retry_scheduled` and `queued` (`DEFAULT_TRANSITION_SOURCES`), and the board maps `cancelled` and `failed` to the Done column. This card uses `cancelled`. `failed` is NOT reachable from `preparing` today, so `preparing` must be added as a source of `failed`.
- 1.6: the existing finalizer test passes at base only because its seed never enters `testing`. The new test must move the item to `running` first.
- 1.8: the manual RPC cannot return a started/refused result without a contract change. That belongs to W4 4.5 (B1). This card keeps `{ ok: true }`.

---

### H0 (W0.4) Shared fake-Codex stdio harness for tests

- Problem: no test drives Symphony's `makeCodexAgentRuntime` through the real Codex client. `AgentRuntime.scrub.test.ts` fakes `client.raw.notifications` with a bare object cast (lines 41 to 43 and 62 to 64), and `packages/effect-codex-app-server` tests either use a real child process (`client.test.ts:23` spawns `test/fixtures/codex-app-server-mock-peer.ts`) or the package-internal `makeInMemoryStdio` (`src/_internal/stdio.ts:24`, used by `protocol.test.ts:15`). `makeInMemoryStdio` is not in the package `exports` (`packages/effect-codex-app-server/package.json` lists only client, schema, rpc, protocol, errors), so apps/server cannot import it. AgentRuntime builds its client from a child handle (`AgentRuntime.ts:152-173`: `spawner.spawn(...)` then `CodexClient.layerChildProcess(child)`), so the correct seam is the `ChildProcessSpawner` service.
- Files to change (all new, test-only):
  - `apps/server/src/symphony/Runner/testkit/FakeCodexPeer.ts` : `makeFakeCodexPeer`, `makeFakeCodexRuntime`, `fakeCodexRuntimeFactory`
  - `apps/server/src/symphony/Runner/testkit/RunnerFixtures.ts` : `makeRunnerTestConfig`, `makeRunnerTestIssue`, `seedQueuedWorkItem`, `fakeWorkspaceManagerLayer`, `testServerConfigLayer`
  - `apps/server/src/symphony/Runner/testkit/RunnerFlowLayer.ts` : `runnerFlowLayer` (Dispatcher, ApprovalService, LiveRequests, repositories and the fake peer, composed once for the W1 flow tests)
  - `apps/server/src/symphony/Runner/testkit/FakeCodexPeer.test.ts` : harness self tests
- Change:
  1. Entry point: the harness plugs into `makeCodexAgentRuntime(deps)` (`AgentRuntime.ts:122`) by providing `ChildProcessSpawner.ChildProcessSpawner` with a fake spawner. Its `spawnAppServer` closure (`AgentRuntime.ts:139`, not exported, do not export it) calls `spawner.spawn`, reads `child.pid`, and passes the handle to `CodexClient.layerChildProcess` which uses `handle.stdout`, `handle.stdin`, `handle.stderr` and `handle.exitCode` (`client.ts:264-268`, `_internal/stdio.ts:13-23`, `:52-63`). For `AgentRuntimeFactory.make` (`Dispatcher.ts:94-101`), `fakeCodexRuntimeFactory` returns a `Layer` that implements `make` by calling `makeCodexAgentRuntime` with the fake spawner, so Dispatcher, ApprovalService and LiveRequests can run end to end with no process.
  2. Build the spawner with the repo pattern from `apps/server/src/provider/opencodeRuntime.test.ts:76-96`: `ChildProcessSpawner.make(() => Effect.succeed(handle))` and `ChildProcessSpawner.makeHandle({ pid, exitCode, isRunning, kill, unref, stdin, stdout, stderr, all, getInputFd, getOutputFd })`. Use `pid: ChildProcessSpawner.ProcessId(options.pid ?? 4242)`, `stderr: Stream.empty`, `all: Stream.empty`, `unref: Effect.succeed(Effect.void)`, `getInputFd: () => Sink.drain`, `getOutputFd: () => Stream.empty`, `kill: () => Effect.void`.
  3. Plumbing inside `makeFakeCodexPeer(options)`. It returns `Effect<FakeCodexPeer>` (no Scope needed):
     ```ts
     const stdoutQueue = yield * Queue.unbounded<Uint8Array, Cause.Done<void>>(); // peer to client
     const clientMessages = yield * Queue.unbounded<JsonRpcMessage>(); // client to peer
     const received = yield * Ref.make<ReadonlyArray<JsonRpcMessage>>([]);
     const exitSignal = yield * Deferred.make<ChildProcessSpawner.ExitCode>();
     ```
     `handle.stdout = Stream.fromQueue(stdoutQueue)`. `handle.exitCode = Deferred.await(exitSignal)`. `handle.isRunning = Deferred.isDone(exitSignal).pipe(Effect.map((done) => !done))`. `handle.stdin = Sink.forEach((chunk: Uint8Array) => ...)` that decodes UTF-8, keeps a remainder string in a `Ref`, splits on `"\n"`, parses each non-empty line with `Schema.decodeUnknownSync(Schema.UnknownFromJsonString)` (the pattern at `packages/effect-codex-app-server/src/protocol.test.ts:16-22`, do not use `JSON.parse`), appends to `received` and offers to `clientMessages`, then runs the built-in answers below. Write lines with `new TextEncoder().encode(`${Schema.encodeSync(Schema.UnknownFromJsonString)(message)}\n`)`.
  4. Built-in answers (each answered with `{ id, result }` the moment the client request arrives, so a test only scripts the interesting events). The result objects must pass the generated response schemas because `client.request` decodes them (`client.ts:197-211`):
     - `initialize`: `{ userAgent: "fake-codex-app-server", codexHome: "/tmp/fake-codex", platformFamily: "unix", platformOs: "macos" }` (same shape as `test/fixtures/codex-app-server-mock-peer.ts` lines 36-41).
     - `thread/start`: a `V2ThreadStartResponse` (`_generated/schema.gen.ts:41988`): `{ approvalPolicy: "on-request", approvalsReviewer: "user", cwd: "/tmp/fake-ws", model: "fake-model", modelProvider: "fake", sandbox: { type: "workspaceWrite" }, thread: { cliVersion: "0.0.0", createdAt: 0, cwd: "/tmp/fake-ws", ephemeral: false, id: threadId, modelProvider: "fake", preview: "", sessionId: "session-1", source: "appServer", status: { type: "idle" }, turns: [], updatedAt: 0 } }`. `threadId` defaults to `"thread-1"`.
     - `turn/start`: `{ turn: { id, items: [], status: "inProgress" } }` (`V2TurnStartResponse__Turn`, `schema.gen.ts:29605`). `id` is entry `n` of `options.turnIds` when present, otherwise the text `turn-` followed by `n + 1`, where `n` is the number of `turn/start` requests answered so far, so a second turn on the same runtime gets `turn-2`. The id of the latest answered turn is kept in a `Ref` (`"turn-1"` before any turn starts).
     - `turn/interrupt`: `{}`.
     - Option `unanswered?: ReadonlyArray<string>` lists client request methods whose built-in answer is suppressed (for example `["turn/interrupt"]` to test an interrupt timeout, or `["thread/start"]` to test a hung handshake). The request is still recorded in `received`.
     - Notifications from the client (`initialized`) get no answer. Any other request gets no answer (the test replies with `peer.reply`).
       If the implementer finds a built-in result fails schema decode, fix the fixture, do not loosen the schema.
  5. Public surface of `FakeCodexPeer` (exact names):
     ```ts
     export interface JsonRpcMessage {
       readonly id?: string | number;
       readonly method?: string;
       readonly params?: unknown;
       readonly result?: unknown;
       readonly error?: unknown;
     }
     export interface FakeCodexPeerOptions {
       readonly pid?: number;
       readonly threadId?: string;
       readonly turnIds?: ReadonlyArray<string>;
       readonly unanswered?: ReadonlyArray<string>;
     }
     export interface FakeCodexPeer {
       readonly spawner: ChildProcessSpawner.ChildProcessSpawner["Service"];
       readonly threadId: string;
       readonly currentTurnId: Effect.Effect<string>;
       readonly received: Effect.Effect<ReadonlyArray<JsonRpcMessage>>;
       readonly spawnCount: Effect.Effect<number>;
       readonly awaitClientRequest: (method: string) => Effect.Effect<JsonRpcMessage>;
       readonly awaitClientResponse: (id: string | number) => Effect.Effect<JsonRpcMessage>;
       readonly reply: (id: string | number, result: unknown) => Effect.Effect<void>;
       readonly replyError: (
         id: string | number,
         code: number,
         message: string,
       ) => Effect.Effect<void>;
       readonly sendNotification: (method: string, params?: unknown) => Effect.Effect<void>;
       readonly sendRequest: (method: string, params?: unknown) => Effect.Effect<number>; // returns the id
       readonly sendCommandApproval: (
         params?: Partial<CommandApprovalParams>,
       ) => Effect.Effect<number>;
       readonly sendUserInputRequest: (
         questions: ReadonlyArray<{ id: string; question: string }>,
       ) => Effect.Effect<number>;
       readonly completeTurn: (
         status: "completed" | "failed" | "interrupted",
         options?: {
           readonly error?: string;
           readonly threadId?: string;
           readonly turnId?: string;
         },
       ) => Effect.Effect<void>;
       readonly sendError: (
         message: string,
         options?: { readonly willRetry?: boolean },
       ) => Effect.Effect<void>;
       readonly closeStdout: Effect.Effect<void>; // stdout EOF, process stays alive, exitCode never resolves
       readonly crash: (exitCode?: number) => Effect.Effect<void>; // closes stdout and resolves exitCode (default 1)
     }
     ```
     Details: `sendRequest` ids come from a per-peer counter that starts at `0` (real Codex starts at 0, and 1.3 needs two peers both using id `0`). `awaitClientRequest` and `awaitClientResponse` loop on `Queue.take(clientMessages)` until the predicate matches (non-matching messages stay visible in `received`). `sendCommandApproval` sends method `item/commandExecution/requestApproval` with params `{ threadId, turnId: <current turn id>, itemId: "item-1", command: "echo hi", cwd: "/tmp/fake-ws", ...overrides }`. `sendUserInputRequest` sends `item/tool/requestUserInput` with `{ threadId, turnId: <current turn id>, itemId: "item-2", questions: questions.map((q) => ({ header: q.id, id: q.id, question: q.question })) }`. `completeTurn` sends notification `turn/completed` with `{ threadId, turn: { id, items: [], status, ...(error ? { error: { message: error } } : {}) } }`, where `threadId` and `id` default to the peer's thread id and current turn id and can be overridden through the options (used to send a completion for a different turn or thread). `sendError` sends `error` with `{ error: { message }, threadId, turnId: <current turn id>, willRetry: options.willRetry ?? false }`. `spawnCount` increments inside the spawner function.
  6. `makeFakeCodexRuntime(input: { peer: FakeCodexPeer; liveRequests: LiveRequestsService; recordRequest?: AgentRuntimeDeps["recordRequest"]; secretEnvironmentNames?: ReadonlyArray<string> })` returns `Effect<AgentRuntimeService, never, Scope.Scope>`:
     ```ts
     makeCodexAgentRuntime({
       codexCommand: "fake-codex",
       codexHomePath: undefined,
       env: {},
       liveRequests: input.liveRequests,
       ...(input.recordRequest ? { recordRequest: input.recordRequest } : {}),
     }).pipe(
       Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, input.peer.spawner),
       Effect.provideService(HostProcessPlatform, "linux"), // from "@neokod/shared/hostProcess"; keeps resolveSpawnCommand off the win32 path
       Effect.orDie, // construction is lazy and cannot fail; Live.ts:57 does the same with mapError(never)
     );
     ```
  7. `fakeCodexRuntimeFactory(nextPeer: () => FakeCodexPeer): Layer.Layer<AgentRuntimeFactory, never, LiveRequests | ApprovalService>`. It reads `LiveRequests` and `ApprovalService` from context and implements `make: () => makeFakeCodexRuntime({ peer: nextPeer(), liveRequests, recordRequest })`, where `recordRequest` is the same `approvalService.recordPending({ id: input.requestId, requestId: input.requestId, workItemId, runAttemptId, action, scope: "once", ...(command) }).pipe(Effect.asVoid, Effect.catch(() => Effect.void))` mapping used in `Live.ts:36-50`. This keeps the production recording path in the harness, so a flow test sees the durable approval row.
  8. `RunnerFixtures.ts`: copy `makeConfig` and `makeIssue` from `Dispatcher.test.ts:41-81` as `makeRunnerTestConfig(overrides?: Partial<EffectiveWorkflowConfig>)` (default `repositoryPath: "/repo"`, `autonomy: "execute"`) and `makeRunnerTestIssue(id)`. Copy `seedWorkItem` (`Dispatcher.test.ts:83-104`) as `seedQueuedWorkItem(id)` (lifecycle `queued`, project `SymphonyProjectId.make("dispatcher-project")`). Copy `fakeWorkspaceManager` (`Dispatcher.test.ts:212-224`) as `fakeWorkspaceManagerLayer(options?: { createdNow?: boolean; ensureWorkspace?: WorkspaceManager["Service"]["ensureWorkspace"] })` so later cards can make workspace creation fail. Add `testServerConfigLayer = Layer.succeed(ServerConfig, { symphonyLogsDir: "/logs/symphony" } as ServerConfig["Service"])` (`Dispatcher.test.ts:245-249`). Do not migrate the existing tests in this commit.
  9. `RunnerFlowLayer.ts` exports `runnerFlowLayer(input: { nextPeer: () => FakeCodexPeer; finalizer?: Layer.Layer<ExecutionFinalizer>; workspaceManager?: Layer.Layer<WorkspaceManager> })`. It composes, in this order (each `provideMerge` target must be satisfied by a later entry; if typecheck complains, reorder so that is true):
     ```ts
     RunDispatcherLive.pipe(
       Layer.provideMerge(fakeCodexRuntimeFactory(input.nextPeer)),
       Layer.provideMerge(ApprovalServiceLive),
       Layer.provideMerge(LiveRequestsLive),
       Layer.provideMerge(ApprovalRepositoryLive),
       Layer.provideMerge(WorkItemRepositoryLive),
       Layer.provideMerge(RunAttemptRepositoryLive),
       Layer.provideMerge(RunEventRepositoryLive),
       Layer.provideMerge(input.workspaceManager ?? fakeWorkspaceManagerLayer()),
       Layer.provideMerge(input.finalizer ?? fakeFinalizerLayer),
       Layer.provideMerge(testServerConfigLayer),
       Layer.provideMerge(SqlitePersistenceMemory),
       Layer.provideMerge(NodeServices.layer),
     );
     ```
     `fakeFinalizerLayer` is `Layer.succeed(ExecutionFinalizer, { finalize: () => Effect.succeed("review_ready") })` (`Dispatcher.test.ts:226-228`). Import paths are the ones at `Dispatcher.test.ts:1-39`. Existing `Dispatcher.test.ts` keeps its own local layer.
  10. Self tests (`FakeCodexPeer.test.ts`) listed below. Wrap each body in `Effect.scoped` like `AgentRuntime.scrub.test.ts:37`.
- Do not:
  - Do not add the harness to `packages/effect-codex-app-server` exports and do not import `_internal/stdio.ts` from apps/server.
  - Do not use real time. Everything is queue driven, so `Queue.take` waits are deterministic under `it.effect`'s TestClock. Never `Effect.sleep` in the harness.
  - Do not export `spawnAppServer` or change `AgentRuntime.ts` in this commit. Production code stays untouched.
  - Do not reuse `Dispatcher.test.ts`'s `layer(...)` helper for flow tests: it provides the factory before `LiveRequests`, so a factory that needs `LiveRequests` cannot resolve. `runnerFlowLayer` orders them correctly.
  - Do not make `closeStdout` resolve `exitCode`. The "stdout closed, process alive" case depends on exitCode staying pending (`_internal/stdio.ts:52-63` awaits it).
- Tests (`apps/server/src/symphony/Runner/testkit/FakeCodexPeer.test.ts`, `describe("FakeCodexPeer")`). All must pass at base (the harness is new; there is no "fails on base" requirement, but test 1 would fail if the fixtures do not decode):
  - `completes a turn through the real client`: `peer = yield* makeFakeCodexPeer()`, `liveRequests = yield* makeLiveRequests`, `runtime = yield* makeFakeCodexRuntime({ peer, liveRequests })`, `fiber = yield* runtime.runTurn({ issue: makeRunnerTestIssue("1"), config: makeRunnerTestConfig(), workspacePath: "/tmp/fake-ws", branch: "b", runAttemptId: RunAttemptId.make("run-1"), workItemId: WorkItemId.make("wi-1") }).pipe(Effect.forkScoped)`; `yield* peer.awaitClientRequest("turn/start")`; `yield* peer.completeTurn("completed")`; `result = yield* Fiber.join(fiber)`. Assert `result` equals `{ turnId: "turn-1", threadId: "thread-1", completed: true }`, `(yield* peer.received).map((m) => m.method)` equals `["initialize", "initialized", "thread/start", "turn/start"]`, `yield* peer.spawnCount` is `1`, `yield* runtime.pid()` is `4242`.
  - `delivers a server request and records the client reply`: build the client directly with `CodexClient.layerChildProcess(handle)` where `handle = yield* peer.spawner.spawn(ChildProcess.make("fake-codex", ["app-server"]))` (providing `Scope`), register `client.handleServerRequest("item/tool/requestUserInput", () => Effect.succeed({ answers: { q1: { answers: ["yes"] } } }))`, call `id = yield* peer.sendUserInputRequest([{ id: "q1", question: "Go?" }])`, then `response = yield* peer.awaitClientResponse(id)`. Assert `response.result` deep equals `{ answers: { q1: { answers: ["yes"] } } }`. (Typed path, so it also passes before and after 1.1.)
  - `stdout EOF leaves the process alive`: spawn a handle, `yield* peer.closeStdout`; `Stream.runCollect(handle.stdout)` completes with no bytes; `exitFiber.pollUnsafe()` of a forked `handle.exitCode` is `undefined` after `Effect.yieldNow` (there is no `Fiber.poll`); `handle.isRunning` is `true`.
  - `crash resolves the exit code`: `yield* peer.crash(7)`; `handle.exitCode` returns `ChildProcessSpawner.ExitCode(7)`; `handle.isRunning` is `false`; `Stream.runCollect(handle.stdout)` completes.
  - `runs a prepare-mode dispatch end to end through the real client`: `makeFakeCodexPeer` is an Effect, so `runnerFlowLayer({ nextPeer })` reads the peer from a holder: `const holder: { peer?: FakeCodexPeer } = {}` and `nextPeer: () => holder.peer as FakeCodexPeer`. Use `it.layer(runnerFlowLayer({ nextPeer: () => holder.peer as FakeCodexPeer }))`. In the test: `holder.peer = yield* makeFakeCodexPeer()`; `workItem = yield* seedQueuedWorkItem("h0-1")`; fork `dispatcher.dispatchWorkItem({ workItem, issue: makeRunnerTestIssue("h0-1"), config: makeRunnerTestConfig({ autonomy: "prepare" }) })` with `Effect.forkScoped`; `yield* holder.peer.awaitClientRequest("turn/start")`; `yield* holder.peer.completeTurn("completed")`; `runAttemptId = yield* Fiber.join(fiber)`. Assert the attempt status is `"succeeded"` and the work item lifecycle is `"ready_for_review"` (same outcome as `Dispatcher.test.ts:258-285`, now through the real client).
- Verify: from `apps/server`: `PATH=/var/folders/b6/87d2msqd6fdbtcddcw5k8gbw0000gn/T/opencode/node-v24.21.0-darwin-arm64/bin:$PATH pnpm exec vp test run src/symphony/Runner/testkit/FakeCodexPeer.test.ts` shows 5 passing tests. Then `pnpm exec tsgo --noEmit` from `apps/server`, and `vp check` from the repo root.
- Depends on: none. Effort: L. Commit message: `test(symphony): add fake Codex app-server harness for runner tests`

---

### 1.1 (N0b, S10) `rawStreams` option on the Codex client

- Problem: every client, typed or not, (a) installs `onRequest: dispatchRequest` (`client.ts:187-195`), which answers any server request that has no typed handler with a method-not-found error (`dispatchRequest` ends in `CodexAppServerRequestError.methodNotFound`, and `runHandler` does the same for a known method with no handler, `_internal/shared.ts:82-84`), and (b) offers every incoming request and notification to two unbounded queues (`protocol.ts:156-157`, offers at `:273` and `:295`) that nothing drains in a typed-only session. Symphony's raw consumer therefore races the client's own error reply, and Code sessions retain all raw history. Only Symphony reads the raw streams (`AgentRuntime.ts:279`, `:365`); `CodexSessionRuntime.ts:763` and `CodexProvider.ts:403` use typed handlers and `client.raw.request` only.
- Files to change:
  - `packages/effect-codex-app-server/src/protocol.ts` : `CodexAppServerPatchedProtocolOptions` (line 34), queue creation (lines 156-157), `handleRequest` (line 272), `handleNotification` (line 294), returned object (lines 414-421)
  - `packages/effect-codex-app-server/src/client.ts` : `CodexAppServerClientOptions` (line 21), `make` (lines 87-251), the four `handle*` registrations (lines 232-249)
  - `packages/effect-codex-app-server/src/protocol.test.ts` : first raw-stream test (line 45) must pass `rawStreams: true`
  - `packages/effect-codex-app-server/src/client.test.ts` : new tests
  - `apps/server/src/symphony/Runner/AgentRuntime.ts` : `CodexClient.layerChildProcess(child)` (line 167)
- Change:
  1. `protocol.ts`: add to `CodexAppServerPatchedProtocolOptions`:
     ```ts
     /** Publish incoming requests and notifications on `incomingRequests` and
      *  `incomingNotifications`. Default false: both streams are empty and
      *  nothing is retained. */
     readonly rawStreams?: boolean;
     ```
  2. `protocol.ts`: replace the two unconditional queues with conditional ones:
     ```ts
     const rawStreams = options.rawStreams === true;
     const incomingNotifications = rawStreams
       ? yield * Queue.unbounded<CodexAppServerIncomingNotification>()
       : null;
     const incomingRequests = rawStreams
       ? yield * Queue.unbounded<CodexAppServerIncomingRequest>()
       : null;
     ```
     In `handleRequest` and `handleNotification`, replace `Queue.offer(queue, x)` with `incomingRequests === null ? Effect.void : Queue.offer(incomingRequests, request).pipe(Effect.asVoid)` (same for notifications), keeping the `Effect.andThen(options.onRequest ? ... : Effect.void)` tail unchanged. In the returned object use `incomingNotifications === null ? Stream.empty : Stream.fromQueue(incomingNotifications)` and the same for requests. The interface types stay `Stream.Stream<...>` (`Stream.empty` is assignable).
  3. `client.ts`: add `readonly rawStreams?: boolean` to `CodexAppServerClientOptions` with this doc comment: `Raw mode. The client does not answer server requests and does not run typed handlers. The caller owns every incoming request and notification through client.raw.requests and client.raw.notifications and must answer each request with client.raw.respond or respondError. Default false (typed mode: raw streams are empty).`
  4. `client.ts` `make`: compute `const rawStreams = options.rawStreams === true;` and change the transport construction (line 187) to:
     ```ts
     const transport =
       yield *
       CodexProtocol.makeCodexAppServerPatchedProtocol({
         stdio,
         ...(terminationError ? { terminationError } : {}),
         ...(options.logIncoming !== undefined ? { logIncoming: options.logIncoming } : {}),
         ...(options.logOutgoing !== undefined ? { logOutgoing: options.logOutgoing } : {}),
         ...(options.logger ? { logger: options.logger } : {}),
         rawStreams,
         ...(rawStreams
           ? {}
           : { onNotification: dispatchNotification, onRequest: dispatchRequest }),
       });
     ```
     Raw mode and typed mode are mutually exclusive: with no `onRequest` the existing `: Effect.void` branch (`protocol.ts:289`) sends no auto reply, and with no `onNotification` the notification decode cost is skipped.
  5. `client.ts`: in raw mode the four `handle*` functions would silently do nothing. Make them fail loudly: at the top of each of `handleServerRequest`, `handleServerNotification`, `handleUnknownServerRequest`, `handleUnknownServerNotification` return `Effect.die(new Error("Codex client handlers are unavailable when rawStreams is true"))` when `rawStreams` is true. `request`, `notify` and `raw.request`, `raw.notify`, `raw.respond`, `raw.respondError` work in both modes.
  6. `CodexSessionRuntime.ts` (`CodexClient.layerChildProcess(child)` at line 763 and its `handleServerRequest` and `handleServerNotification` registrations) and `CodexProvider.ts:403` stay unchanged. The default is `false`, which is exactly their current typed behaviour, minus the retained raw queues.
  7. `AgentRuntime.ts:167`: change to `CodexClient.layerChildProcess(child, { rawStreams: true })`. Nothing else in AgentRuntime changes in this card (its `consumeIncoming` already answers every request, including the unknown-method branch).
  8. `protocol.test.ts`: the test at line 45 calls `makeCodexAppServerPatchedProtocol({ stdio })` and reads both raw streams. Change that call (line 50) to `makeCodexAppServerPatchedProtocol({ stdio, rawStreams: true })`. The other protocol tests do not read the raw streams.
- Do not:
  - Do not default the protocol option to `true` to avoid touching the test. The default must be `false` at both layers so no typed session retains history.
  - Do not keep typed notification decoding in raw mode. It decodes every delta for no reader.
  - Do not touch `_generated/` or `CodexSessionRuntime.ts`.
  - Do not add a `Queue.end` on termination here. Card 1.4 does that.
- Tests (`packages/effect-codex-app-server/src/client.test.ts`, add a second `describe`-less block using `makeInMemoryStdio` from `./_internal/stdio.ts`, the same import `protocol.test.ts:15` uses; use `it.effect` with `Effect.scoped` and `CodexClient.make(stdio, options)` because `client.test.ts:20` wraps its tests in `it.layer(NodeServices.layer)`, keep the new tests in that same `it.layer` block or a plain `it.effect`; reuse the local `encodeJsonl` pattern from `protocol.test.ts:16-20`):
  - `typed-only sessions retain no raw history`: `const { stdio, input } = yield* makeInMemoryStdio(); const client = yield* CodexClient.make(stdio);` register `client.handleServerNotification("item/agentMessage/delta", ...)` completing a `Deferred`; offer `encodeJsonl({ method: "item/agentMessage/delta", params: { delta: "x", itemId: "i-1", threadId: "t-1", turnId: "u-1" } })` three times; await the deferred; then `const drain = yield* Stream.runCollect(client.raw.notifications).pipe(Effect.forkScoped); yield* Effect.yieldNow;` and assert `drain.pollUnsafe()` is defined (the stream is empty and completed). Also assert the same for `client.raw.requests`. Fails at base: the raw queue stays open and `pollUnsafe()` is `undefined`.
  - `raw mode does not auto-reply and a raw consumer can answer an approval`: `client = yield* CodexClient.make(stdio, { rawStreams: true })`; fork `Stream.runHead(client.raw.requests)`; offer `encodeJsonl({ id: 0, method: "item/commandExecution/requestApproval", params: { threadId: "t-1", turnId: "u-1", itemId: "i-1", command: "echo hi" } })`; join the fiber to get the request; `yield* client.raw.respond(request.id, { decision: "accept" })`; decode the first line from `output` with `Schema.decodeEffect(Schema.UnknownFromJsonString)` and assert it deep equals `{ id: 0, result: { decision: "accept" } }`; then assert `yield* Queue.size(output)` is `0` (no second reply). Fails at base: the first outgoing line is the typed method-not-found error for id 0.
  - `raw mode rejects typed handler registration`: `Effect.exit(client.handleServerRequest("item/tool/requestUserInput", () => Effect.succeed({ answers: {} })))` is a defect failure (`Exit.isFailure`).
  - In `apps/server/src/symphony/Runner/AgentRuntime.test.ts` (new file, uses H0): `sends exactly one reply to a command approval`: `peer = yield* makeFakeCodexPeer()`, `liveRequests = yield* makeLiveRequests`, `runtime = yield* makeFakeCodexRuntime({ peer, liveRequests })`; fork `runtime.runTurn(...)` (input as in the H0 test); `yield* peer.awaitClientRequest("turn/start")`; `const id = yield* peer.sendCommandApproval()`; wait until `liveRequests.listPending(runAttemptId)` has one entry (loop with `Effect.yieldNow`, at most 100 iterations); `yield* liveRequests.respondToApproval("0", "approved")`; `const reply = yield* peer.awaitClientResponse(id)`; assert `reply.error` is `undefined` and `reply.result` is defined; then `yield* peer.completeTurn("completed")` and join. (The exact `decision` value is asserted in card 1.2. Note the live request id here is `"0"` until card 1.3 changes the signature, so write `respondToApproval` with the signature of the commit you are on.) Fails at base: `reply.error` holds the client's method-not-found reply.
- Verify: from `packages/effect-codex-app-server`: `pnpm exec vp test run src/client.test.ts src/protocol.test.ts` (all pass) and `pnpm exec tsgo --noEmit`. From `apps/server`: `pnpm exec vp test run src/symphony/Runner/AgentRuntime.test.ts src/provider/Layers/CodexSessionRuntime.test.ts` and `pnpm exec tsgo --noEmit`. From the repo root: `vp check`.
- Depends on: H0. Effort: M. Commit message: `fix(codex): add rawStreams option so typed clients retain no raw history`

---

### 1.2 (N2) Map Symphony approval decisions and user-input answers to Codex wire values

- Problem: `AgentRuntime.ts:325` replies `{ decision }` where `decision` is Symphony's `ApprovalDecision` (`"approved" | "rejected"`, `LiveRequests.ts:28`). Codex only accepts `accept`, `acceptForSession`, `decline`, `cancel` for `item/commandExecution/requestApproval` (`_generated/schema.gen.ts:19880-19925`, plus two object forms for exec-policy and network amendments) and for `item/fileChange/requestApproval` (`schema.gen.ts:1531-1541`). The user-input reply at `AgentRuntime.ts:351` is `{ text }`, but the response schema is `{ answers: { [questionId]: { answers: ReadonlyArray<string> } } }` (`ToolRequestUserInputResponse`, `schema.gen.ts:36372-36380`; this is what `CodexSessionRuntime.ts:1121-1130` returns via `toCodexUserInputAnswers`). The final `else` replies `{}` (`AgentRuntime.ts:353`), which is invalid for every Codex request. `isApprovalRequest` (`AgentRuntime.ts:267`) is `endsWith("/requestApproval")`, which also matches `item/permissions/requestApproval`, whose response is `{ permissions, scope }` (`schema.gen.ts:34504`), not a decision.
- Files to change:
  - `apps/server/src/symphony/Runner/AgentRuntime.ts` : `isApprovalRequest` (line 267), `isUserInputRequest` (line 269), `handleRequest` (lines 286-355)
  - `apps/server/src/symphony/Runner/AgentRuntime.test.ts` (new in 1.1, extend here)
- Change:
  1. Add imports to `AgentRuntime.ts`, matching `CodexSessionRuntime.ts:33-36`: `import * as CodexErrors from "effect-codex-app-server/errors"; import * as CodexRpc from "effect-codex-app-server/rpc"; import type * as EffectCodexSchema from "effect-codex-app-server/schema";`.
  2. Add the single mapping function (exported for tests) next to `scrubEnvironment`:
     ```ts
     /** The only place Symphony's decision vocabulary meets Codex's wire enum. */
     export const toCodexApprovalDecision = (
       decision: ApprovalDecision,
     ): EffectCodexSchema.CommandExecutionRequestApprovalResponse["decision"] &
       EffectCodexSchema.FileChangeRequestApprovalResponse["decision"] =>
       decision === "approved" ? "accept" : "decline";
     ```
     `acceptForSession` and `cancel` are not produced: `cancel` would interrupt the whole turn and Symphony cancels runs through `turn/interrupt`; a timed-out or settled approval is `"rejected"` and must map to `decline` (the agent continues without that action).
  3. Add the user-input builder (exported for tests):
     ```ts
     export const toCodexUserInputResponse = (
       questions: unknown,
       text: string,
     ): EffectCodexSchema.ToolRequestUserInputResponse => ({
       answers: Object.fromEntries(
         (Array.isArray(questions) ? questions : []).flatMap((question) =>
           typeof question === "object" &&
           question !== null &&
           typeof (question as { id?: unknown }).id === "string"
             ? [[(question as { id: string }).id, { answers: [text] }] as const]
             : [],
         ),
       ),
     });
     ```
     One free-text operator answer is applied to every question id in `params.questions`. When `questions` is missing the answer map is empty.
  4. Replace the suffix matchers with exact method sets built from the generated constants:
     ```ts
     const APPROVAL_METHODS: ReadonlySet<string> = new Set([
       CodexRpc.SERVER_REQUEST_METHODS["item/commandExecution/requestApproval"],
       CodexRpc.SERVER_REQUEST_METHODS["item/fileChange/requestApproval"],
     ]);
     const isApprovalRequest = (method: string): boolean => APPROVAL_METHODS.has(method);
     const isUserInputRequest = (method: string): boolean =>
       method === CodexRpc.SERVER_REQUEST_METHODS["item/tool/requestUserInput"];
     ```
  5. In `handleRequest`:
     - line 325 becomes `yield* client.raw.respond(request.id, { decision: toCodexApprovalDecision(decision) }).pipe(Effect.catch(() => Effect.void));`
     - line 351 becomes `yield* client.raw.respond(request.id, toCodexUserInputResponse(params.questions, answer)).pipe(Effect.catch(() => Effect.void));`
     - the final `else` becomes `yield* client.raw.respondError(request.id, CodexErrors.CodexAppServerRequestError.methodNotFound(request.method)).pipe(Effect.catch(() => Effect.void));` (this is what the typed path did before card 1.1 for methods Symphony does not handle; `item/permissions/requestApproval`, `item/tool/call`, `mcpServer/elicitation/request`, `applyPatchApproval` and `execCommandApproval` fall here).
  6. `CodexSessionRuntime.ts:1021` and `:1079` send `decision: resolved` where `resolved` is already a `ProviderApprovalDecision` (the same four literals). They need no mapping and stay unchanged. Do not route them through `toCodexApprovalDecision`.
- Do not:
  - Do not change `ApprovalDecision` or the durable decision strings (`"approved"`, `"rejected"` are stored by `ApprovalRepository.decide`).
  - Do not use `cancel` for rejection.
  - Do not treat `scope` from the approve RPC as `acceptForSession` here. `ws.ts:978` ignores `input.scope` today (see Open questions).
  - Do not widen `isApprovalRequest` back to a suffix match.
- Tests (`apps/server/src/symphony/Runner/AgentRuntime.test.ts`, uses H0 and 1.1):
  - Pure: `toCodexApprovalDecision("approved")` is `"accept"`; `toCodexApprovalDecision("rejected")` is `"decline"`. `toCodexUserInputResponse([{ id: "q1" }, { id: "q2" }], "main")` deep equals `{ answers: { q1: { answers: ["main"] }, q2: { answers: ["main"] } } }`; with `undefined` questions it equals `{ answers: {} }`.
  - Wire, command approved: `peer`, `liveRequests`, `runtime` as in card 1.1, fork `runTurn`, `await turn/start`, `id = yield* peer.sendCommandApproval()`, wait for the pending entry, `respondToApproval("0", "approved")`, `reply = yield* peer.awaitClientResponse(id)`; assert `reply.result` deep equals `{ decision: "accept" }`.
  - Wire, command rejected: same with `"rejected"`, assert `{ decision: "decline" }`.
  - Wire, file change: `id = yield* peer.sendRequest("item/fileChange/requestApproval", { threadId: "thread-1", turnId: "turn-1", itemId: "item-3", startedAtMs: 0 })`, approve, assert `{ decision: "accept" }`.
  - Wire, settled: after the request is registered call `liveRequests.settleRun(runAttemptId, "cancelled")`; assert the reply is `{ decision: "decline" }`.
  - Wire, user input: `id = yield* peer.sendUserInputRequest([{ id: "q1", question: "Which branch?" }, { id: "q2", question: "Why?" }])`, `respondToUserInput("0", "main")`, assert `reply.result` deep equals `{ answers: { q1: { answers: ["main"] }, q2: { answers: ["main"] } } }`.
  - Wire, unsupported method: `id = yield* peer.sendRequest("item/permissions/requestApproval", {})`, assert `reply.result` is `undefined` and `(reply.error as { code: number }).code` is `-32601`.
    All wire tests fail at base (value `"approved"`, `{ text }`, `{}`). They need card 1.1 to have landed so the client does not add its own reply. Finish each test by `yield* peer.completeTurn("completed")` and joining the `runTurn` fiber.
- Verify: from `apps/server`: `pnpm exec vp test run src/symphony/Runner/AgentRuntime.test.ts src/symphony/Runner/AgentRuntime.scrub.test.ts`, then `pnpm exec tsgo --noEmit`. From the repo root `vp check`.
- Depends on: H0, 1.1. Effort: S. Commit message: `fix(symphony): send Codex accept/decline and answer maps for approvals and user input`

---

### 1.3 (N1) Key live requests by run and request id, resolve the durable row first

- Problem: two id spaces are mixed. The UI sends the durable id: `approvalToAttentionItem` sets `id: request.id` (`SymphonyOrchestratorLive.ts:443`, the `sym-<uuid>` minted by `makeId` in `ApprovalService.ts:103-111`), and `SymphonyAttentionView.tsx:36-47` sends `requestId: item.id` to `symphony.approve` and `symphony.reject`. `ApprovalService.decide` (`ApprovalService.ts:135-148`) passes that id straight to `liveRequests.respondToApproval`, whose `findEntry` (`LiveRequests.ts:163-171`) matches `value.requestId === requestId`, and live entries are stored under the Codex id (`AgentRuntime.ts:299`). The lookup misses, so approve from the UI fails with `ApprovalRequestNotFoundError`. `decide` also calls `repository.decide(requestId, ...)` with the live id against the `id` column (`ApprovalRepository.ts:decide`, `WHERE id = ${id}`), so a durable row is never decided on this path. Separately, `findEntry` returns the first entry with a matching `requestId` regardless of run, so two runs whose Codex ids are both `"0"` collide. `removeByRequestId` and `settleRequest` (`LiveRequests.ts:122-132`, `:226-239`) have the same flaw.
- Files to change:
  - `apps/server/src/symphony/Runner/LiveRequests.ts` : `keyOf` (line 113), `put` (line 116), `removeByRequestId` (line 122), `findEntry` (line 163), `respondToApproval` (line 173), `respondToUserInput` (line 183), `settleRequest` (line 226), the `LiveRequestsService` interface (lines 45-102), `LiveRequestNotFoundError` (line 35)
  - `apps/server/src/symphony/Runner/ApprovalService.ts` : `decide` (line 135), `approve` (line 150), `reject` (line 153), `respondToUserInput` (line 156), `expire` (line 171), `interrupt` (line 179)
  - `apps/server/src/symphony/Runner/AgentRuntime.ts` : `handleRequest` ordering of `recordRequest` and `registerApproval`/`registerUserInput` (lines 303-325 and 333-350)
  - `apps/server/src/symphony/Runner/LiveRequests.test.ts` : update calls
  - `apps/server/src/symphony/Runner/ApprovalService.test.ts` (new)
- Change:
  1. `LiveRequests.ts`: key every entry by run and request id, the two values the registering side already has:
     ```ts
     const keyOf = (runAttemptId: RunAttemptId, requestId: string): string =>
       `${runAttemptId}:${requestId}`;
     ```
     `put` uses `keyOf(entry.runAttemptId, entry.requestId)`. Replace `removeByRequestId(requestId)` with `removeKey(key: string)` that deletes that single key. Replace `findEntry(requestId)` with `findEntry(runAttemptId, requestId)` that reads `current[keyOf(runAttemptId, requestId)]` and fails with `LiveRequestNotFoundError` when absent. `settleRun` is unchanged (it already filters on `runAttemptId`).
  2. `LiveRequests.ts` interface signatures (exact new shapes):
     ```ts
     readonly respondToApproval: (runAttemptId: RunAttemptId, requestId: string, decision: ApprovalDecision) => Effect.Effect<void, LiveRequestNotFoundError>;
     readonly respondToUserInput: (runAttemptId: RunAttemptId, requestId: string, text: string) => Effect.Effect<void, LiveRequestNotFoundError>;
     readonly settleRequest: (runAttemptId: RunAttemptId, requestId: string, reason: string) => Effect.Effect<void>;
     ```
     `LiveRequestNotFoundError` gets a second optional constructor argument `runAttemptId?: string`; keep the `requestId` property. Update the file header comment ("keyed by `(workItemId, runAttemptId, requestId)`") to "keyed by `(runAttemptId, requestId)`".
  3. `ApprovalService.ts`: `decide` takes the durable id. It resolves the durable row first, then the live entry using that row's run and Codex id, then persists:
     ```ts
     const decide = (
       id: string,
       decision: ApprovalDecision,
       reason: string | undefined,
     ): Effect.Effect<void, ApprovalRequestNotFoundError> =>
       Effect.gen(function* () {
         const record = yield* repository
           .getById(id)
           .pipe(Effect.catch(() => Effect.succeed(null)));
         if (record === null || record.state !== "pending" || record.runAttemptId === undefined) {
           return yield* Effect.fail(new ApprovalRequestNotFoundError(id));
         }
         const live = yield* Effect.result(
           liveRequests.respondToApproval(record.runAttemptId, record.requestId, decision),
         );
         if (live._tag === "Failure") {
           return yield* Effect.fail(new ApprovalRequestNotFoundError(id));
         }
         yield* repository.decide(record.id, decision).pipe(Effect.catch(() => Effect.void));
       });
     ```
     Keep the `reason` parameter exactly as it is today (it is already unused in the body); `approve` and `reject` keep their public signatures and still call `decide(id, ..., reason)`. `respondToUserInput(id, text)` does the same lookup, calls `liveRequests.respondToUserInput(record.runAttemptId, record.requestId, text)`, then `repository.decide(record.id, "approved")` (existing behaviour: a user-input answer is stored as `approved`). `expire(id)` and `interrupt(id)` keep reading the record and now call `liveRequests.settleRequest(record.runAttemptId, record.requestId, ...)` only when `record !== null && record.runAttemptId !== undefined`; the durable `repository.decide(id, ...)` stays.
  4. `ApprovalServiceShape` (public) does not change, and `ws.ts:974-1011` is unchanged. The RPC inputs are `SymphonyApproveInput { requestId, scope }`, `SymphonyRejectInput { requestId, reason? }` and `SymphonyRespondToUserInputInput { requestId, text }` (`packages/contracts/src/symphony.ts:1176-1187`). The field is called `requestId` but must carry the durable `sym-<uuid>` id, which is what the only web caller sends (`apps/web/src/components/symphony/SymphonyAttentionView.tsx:36-47`; `packages/client-runtime/src/state/symphony.ts:114-121` only wires the RPC tags; no web caller exists for `respondToUserInput`, see Open questions). No contract change is needed.
  5. `AgentRuntime.ts` `handleRequest`: swap the order so the live entry exists before the durable row is visible to the UI. In the approval branch, move the `registerApproval` call above the `recordRequest` call; in the user-input branch do the same with `registerUserInput`. Nothing else changes. (The attention list is built from durable rows, so the UI can no longer click a request that has no live entry.)
  6. Update the existing calls in `LiveRequests.test.ts` to the new signatures: `service.respondToApproval(runAttemptId, "req-1", "approved")`, `service.respondToUserInput(runAttemptId, "req-2", "main")`, `service.respondToApproval(runAttemptId, "missing", "approved")`.
- Do not:
  - Do not change what `recordRequest` stores as `requestId` (`AgentRuntime.ts:299`, the Codex id). The durable row needs it to find the live entry.
  - Do not add a durable-id to live-id side table. The durable row already has `runAttemptId` and `requestId`.
  - Do not let a decided or expired row be decided again (`record.state !== "pending"` fails).
  - Do not change the `ApprovalRepository` schema or migrations.
- Tests:
  - `LiveRequests.test.ts`, new `it.effect("keeps the same request id in two runs apart")`: `service = yield* makeLiveRequests`; register approval `requestId: "0"` for `runAttemptId` and for `otherRun`; `respondToApproval(otherRun, "0", "approved")`; assert the `otherRun` deferred resolves `"approved"` and `Deferred.isDone` of the first is `false`; `settleRequest(runAttemptId, "0", "x")` then `listPending(runAttemptId)` is empty. Fails at base (the first registered entry would be answered).
  - `ApprovalService.test.ts` (new). Layer: `ApprovalServiceLive.pipe(Layer.provideMerge(ApprovalRepositoryLive), Layer.provideMerge(LiveRequestsLive), Layer.provideMerge(WorkItemRepositoryLive), Layer.provideMerge(SqlitePersistenceMemory), Layer.provideMerge(NodeServices.layer))`, copied from `Dispatcher.test.ts:7-23, 286-300`. Seed two work items (`wi-a`, `wi-b`) with `seedWorkItem` copied from `Dispatcher.test.ts:81-100` (the `approvals.work_item_id` column references `symphony_work_items`). Helper `request(runAttemptId, workItemId, requestId)` calls `live.registerApproval({ requestId, workItemId, runAttemptId, action: "command_execution", prompt: "p" })` then `service.recordPending({ id: "ignored", requestId, workItemId, runAttemptId, action: "command_execution", scope: "once" })` and returns `{ deferred, record }` (the live entry is registered first, matching step 5). Test names and assertions:
    - `approve by durable id resolves the live request and persists the decision`: `service.approve(record.id)`; `Deferred.await(deferred)` is `"approved"`; `repo.getById(record.id)` has `state: "approved"`. Fails at base: `approve` fails with `ApprovalRequestNotFoundError` because `record.id` is `sym-...`.
    - `two runs using JSON-RPC id 0 do not collide`: create `a = request(run-a, wi-a, "0")` and `b = request(run-b, wi-b, "0")`; `service.approve(b.record.id)`; `b.deferred` is `"approved"`; `Deferred.isDone(a.deferred)` is `false`; `a.record` is still `pending`; then `service.reject(a.record.id)` gives `"rejected"` on `a.deferred`.
    - `unknown id fails`: `Effect.flip(service.approve("sym-missing"))` is an `ApprovalRequestNotFoundError`.
    - `a decided request cannot be decided twice`: approve, then `Effect.flip(service.approve(record.id))` is `ApprovalRequestNotFoundError`.
    - `user input by durable id`: register with `live.registerUserInput`, `recordPending({ ..., action: "user_input" })`, `service.respondToUserInput(record.id, "main")`; deferred is `"main"`.
    - `expire settles the live request by run and id`: `service.expire(record.id)`; `Effect.flip(Deferred.await(deferred))` is an `Error` whose message contains `"approval wait timed out"`; row state is `"expired"`.
- Verify: from `apps/server`: `pnpm exec vp test run src/symphony/Runner/LiveRequests.test.ts src/symphony/Runner/ApprovalService.test.ts src/symphony/Runner/AgentRuntime.test.ts src/ws-symphony.test.ts src/symphony/Orchestrator/Layers/SymphonyOrchestratorLive.test.ts` all pass; `pnpm exec tsgo --noEmit`. From the repo root `vp check`.
- Depends on: 1.2 (the AgentRuntime tests call the new `respondToApproval` signature; update the `"0"` calls in `AgentRuntime.test.ts` to `respondToApproval(runAttemptId, "0", ...)`). Effort: S. Commit message: `fix(symphony): resolve approvals by durable id and key live requests by run`

---

### 1.4 (N10, S04) Pin the turn wait to thread and turn, honour `turn.status`, bound EOF and fail late requests

- Problem:
  1. `waitForTurnCompletion` (`AgentRuntime.ts:357-397`) completes on any `turn/completed` (`:366-367`), ignoring `threadId`, `turn.id` and `turn.status`. Codex sends `turn/completed` with `status` `completed`, `interrupted` or `failed` (`_generated/schema.gen.ts:10148-10153`; params shape `{ threadId, turn: { id, status, error? } }`, `schema.gen.ts:29489-29498`, `:42428-42431`). A failed turn therefore counts as success and `Dispatcher.ts:433-459` goes on to `finalize` and open a PR.
  2. The per-turn consumers are `Effect.forkScoped` (`AgentRuntime.ts:231` for requests, `:364` for notifications) and never end. On a second turn of the same runtime the first turn's notification fiber still competes for the same queue and can take the second turn's `turn/completed`, so continuation turns can hang until the one hour timeout.
  3. EOF: `protocol.ts:354-384` calls `handleTermination` when stdin ends. For a child process the classifier is `makeTerminationError(handle)` which awaits `handle.exitCode` (`_internal/stdio.ts:52-63`). If stdout closes while the process stays alive, this never returns, so pending requests are never failed and `Queue.end(outgoing)` never runs (`protocol.ts:186-202`). The raw queues are never ended either, so the notification stream never completes and a raw consumer hangs.
  4. After termination `request()` (`protocol.ts:388-406`) registers a pending entry that nothing resolves, and `Queue.offer` on the ended `outgoing` queue returns `false` unnoticed. `AgentRuntime.interrupt` (`AgentRuntime.ts:247-254`) awaits `turn/interrupt` and `Dispatcher.cancelRun` awaits `interrupt` (`Dispatcher.ts:562`), so a dead or hung child blocks cancel forever.
- What happens to a failed turn in Dispatcher (read at `Dispatcher.ts:404-474` and `:482-502`): if `runTurn` fails, `.pipe(Effect.mapError((cause) => new RunDispatchError(cause.message)))` (lines 414 and 430) fails `runDispatch`; the `Effect.catch` at line 484 logs `symphony.run.failed` and calls `markFailed(... { category: "agent", message: error.message } ...)`, which writes attempt status `failed` and then retry or release. Neither the continuation loop (line 415) nor `finalize` (line 446) runs. So the correct way to make a failed or interrupted turn end the attempt failed is to make `runTurn` FAIL, not to return `completed: false` (a `completed: false` result enters the continuation loop at line 415 and runs more turns). No Dispatcher change is needed in this card.
- Files to change:
  - `apps/server/src/symphony/Runner/AgentRuntime.ts` : `runTurn` (lines 188-245), `interrupt` (lines 247-254), `waitForTurnCompletion` (lines 357-397), `handleRequest` default wait (line 297)
  - `packages/effect-codex-app-server/src/protocol.ts` : queue creation from card 1.1, `handleTermination` (line 186), `offerOutgoing` (line 204), `request` (line 388)
  - `apps/server/src/symphony/Runner/AgentRuntime.scrub.test.ts` : the two `waitForTurnCompletion` tests (lines 37-80)
  - `apps/server/src/symphony/Runner/AgentRuntime.test.ts`, `apps/server/src/symphony/Runner/RunnerFlow.test.ts` (new), `packages/effect-codex-app-server/src/protocol.test.ts`
- Change:
  1. Named constants. In `protocol.ts` add `import * as Duration from "effect/Duration"; import * as Option from "effect/Option";` and
     ```ts
     /** How long to wait for the child's exit status after its stdout closes before
      *  classifying the termination as a plain end of input. */
     export const CODEX_EXIT_STATUS_WAIT = Duration.seconds(2);
     ```
     In `AgentRuntime.ts` add `import { WORKFLOW_DEFAULTS } from "../Workflow/Config.ts";` and
     ```ts
     /** `turn/interrupt` must not block cancel on a hung or dead child. */
     export const INTERRUPT_REQUEST_TIMEOUT = Duration.seconds(5);
     ```
     Replace the inline defaults `3_600_000` (line 362) with `WORKFLOW_DEFAULTS.codexTurnTimeoutMs` and `1_800_000` (line 297) with `WORKFLOW_DEFAULTS.liveRequestsWaitTimeoutMs` (same values, `Workflow/Config.ts:43` and `:48`).
  2. `protocol.ts`: end the raw queues. Change the two creations from card 1.1 to carry the done type, exactly like `outgoing` (line 155): `Queue.unbounded<CodexAppServerIncomingNotification, Cause.Done<void>>()` and `Queue.unbounded<CodexAppServerIncomingRequest, Cause.Done<void>>()`. In `handleTermination`, after `Queue.end(outgoing)`, add `if (incomingNotifications !== null) yield* Queue.end(incomingNotifications); if (incomingRequests !== null) yield* Queue.end(incomingRequests);`. Buffered items are still delivered before the stream completes.
  3. `protocol.ts`: bound the exit wait and record the termination. Add `const terminated = yield* Ref.make<CodexError.CodexAppServerError | null>(null);` next to `terminationHandled` (line 161). Replace the body of the termination `Effect.gen` (lines 192-199) with:
     ```ts
     const error =
       yield *
       classify().pipe(
         Effect.timeoutOption(CODEX_EXIT_STATUS_WAIT),
         Effect.map(Option.getOrElse(() => new CodexError.CodexAppServerInputStreamEndedError({}))),
       );
     yield * Ref.set(terminated, error); // BEFORE failing pending, so late requests see it
     yield * failAllPending(error);
     yield * Queue.end(outgoing);
     /* end raw queues here (step 2) */
     if (options.onTermination) {
       yield * options.onTermination(error);
     }
     ```
     `Ref.set(terminated, ...)` must come before `failAllPending`. A request registered after the snapshot taken by `failAllPending` then still sees `terminated` set in step 4.
  4. `protocol.ts`: make sends after termination fail. Add
     ```ts
     const failIfTerminated = Ref.get(terminated).pipe(
       Effect.flatMap((error) => (error === null ? Effect.void : Effect.fail(error))),
     );
     ```
     and make it the first statement of `offerOutgoing` (line 204). `request` already registers its pending entry before calling `offerOutgoing` and removes it on error (`.pipe(Effect.tapError(() => removePending(...)))`, line 402), so a request made after termination now fails with the termination error instead of waiting forever. `notify`, `respond` and `respondError` use `offerOutgoing` and fail the same way.
  5. `AgentRuntime.ts`: replace `waitForTurnCompletion` with a pinned version and a pure classifier (both exported):

     ```ts
     export interface PinnedTurn {
       readonly threadId: string;
       readonly turnId: string;
     }
     export type TurnSignal =
       | { readonly _tag: "completed" }
       | { readonly _tag: "failed"; readonly message: string };

     export const classifyTurnNotification = (
       notification: { readonly method: string; readonly params?: unknown },
       pinned: PinnedTurn,
     ): TurnSignal | null => {
       const params = (notification.params ?? {}) as Record<string, unknown>;
       if (notification.method === "turn/completed") {
         const turn = (params.turn ?? {}) as {
           id?: unknown;
           status?: unknown;
           error?: { message?: unknown } | null;
         };
         if (params.threadId !== pinned.threadId || turn.id !== pinned.turnId) return null;
         if (turn.status === "completed") return { _tag: "completed" };
         if (turn.status === "failed") {
           return {
             _tag: "failed",
             message:
               typeof turn.error?.message === "string" ? turn.error.message : "Codex turn failed",
           };
         }
         if (turn.status === "interrupted")
           return { _tag: "failed", message: "Codex turn was interrupted" };
         return null; // inProgress or unknown: keep waiting
       }
       if (notification.method === "error") {
         if (params.willRetry === true) return null;
         if (typeof params.threadId === "string" && params.threadId !== pinned.threadId)
           return null;
         if (typeof params.turnId === "string" && params.turnId !== pinned.turnId) return null;
         const error = params.error as { message?: unknown } | undefined;
         return {
           _tag: "failed",
           message:
             typeof error?.message === "string"
               ? error.message
               : "Codex app-server reported an error",
         };
       }
       return null;
     };
     ```

     ```ts
     export const waitForTurnCompletion = (
       client: CodexClientService,
       config: EffectiveWorkflowConfig,
       pinned: PinnedTurn,
     ): Effect.Effect<boolean, AgentRuntimeSpawnError> =>
       Effect.gen(function* () {
         const timeout = Duration.millis(
           config.codexTurnTimeoutMs ?? WORKFLOW_DEFAULTS.codexTurnTimeoutMs,
         );
         const outcome = yield* Deferred.make<boolean, AgentRuntimeSpawnError>();
         const pump = yield* Stream.runForEach(client.raw.notifications, (notification) => {
           const signal = classifyTurnNotification(notification, pinned);
           if (signal === null) return Effect.void;
           return (
             signal._tag === "completed"
               ? Deferred.succeed(outcome, true)
               : Deferred.fail(outcome, new AgentRuntimeSpawnError(signal.message))
           ).pipe(Effect.asVoid);
         }).pipe(
           // The stream completes when the app-server connection ends (step 2).
           Effect.andThen(
             Deferred.fail(
               outcome,
               new AgentRuntimeSpawnError("Codex app-server exited before the turn finished"),
             ),
           ),
           Effect.catch(() => Effect.void),
           Effect.forkChild,
         );
         return yield* Deferred.await(outcome).pipe(
           Effect.timeoutOption(timeout),
           Effect.flatMap(
             Option.match({
               onNone: () => Effect.fail(new AgentRuntimeSpawnError("turn timed out")),
               onSome: (value) => Effect.succeed(value),
             }),
           ),
           Effect.ensuring(Fiber.interrupt(pump)),
         );
       });
     ```

     Add `import * as Fiber from "effect/Fiber";`. The consumer is a child of the waiting fiber and is interrupted when the wait ends, so exactly one notification consumer exists at a time. It no longer needs `Scope.Scope`. `AgentRuntimeSpawnError` keeps its name; its message carries the Codex text (the existing scrub test asserts `"out of credits"`).

  6. `AgentRuntime.ts` `runTurn`: capture the ids and pin the wait; start the request consumer once per runtime. Add `let requestConsumerStarted = false;` beside `let activePid` (line 137). Directly after `const policy = ...` (line 191):
     ```ts
     if (!requestConsumerStarted) {
       requestConsumerStarted = true;
       yield *
         Effect.forkScoped(
           consumeIncoming(
             client,
             input.runAttemptId,
             input.workItemId,
             liveRequests,
             recordRequest,
             input.config,
           ),
         );
     }
     ```
     and delete the per-turn `Effect.forkScoped(consumeIncoming(...))` at lines 231-240. After `turnId = ...turn.id` (line 229) use `const activeThreadId = thread id string`, `const activeTurnId = turn id string` locals and call `waitForTurnCompletion(client, input.config, { threadId: activeThreadId, turnId: activeTurnId })`; return `{ turnId: activeTurnId, threadId: activeThreadId, completed }`. A failed or interrupted turn now fails `runTurn` (see the Dispatcher paragraph above); `completed` is only ever `true`.
  7. `AgentRuntime.ts` `interrupt` (lines 247-254): `.request("turn/interrupt", { threadId, turnId }).pipe(Effect.timeoutOption(INTERRUPT_REQUEST_TIMEOUT), Effect.asVoid, Effect.catch(() => Effect.void))`.
  8. Update the two existing tests in `AgentRuntime.scrub.test.ts` (lines 37-80) to the new signature: pass `{ threadId: "thread-1", turnId: "turn-1" }` as the third argument and send `{ method: "turn/completed", params: { threadId: "thread-1", turn: { id: "turn-1", status: "completed" } } }` and `{ method: "error", params: { error: { message: "out of credits" }, threadId: "thread-1", turnId: "turn-1", willRetry: false } }`.

- Do not:
  - Do not return `completed: false` for failed or interrupted turns. It enters the continuation loop (`Dispatcher.ts:415`) and runs more turns.
  - Do not call `Fiber.join` on the pump or leave it as `forkScoped`; a leaked pump is bug 2 above.
  - Do not add a timeout to `thread/start`, `turn/start` or `initialize` here (see Open questions).
  - Do not decode `turn/completed` with the generated schema in the pump; the notification can carry the whole item list. Use the narrow reads above.
- Tests:
  - `packages/effect-codex-app-server/src/protocol.test.ts` (inside the existing `it.layer(NodeServices.layer)` block, same `makeInMemoryStdio` and `encodeJsonl` helpers; import `* as TestClock from "effect/testing/TestClock"`; add a helper `const settle = Effect.repeat(Effect.yieldNow, { times: 50 })`):
    - `request after the input stream ended fails with the termination error`: `transport = makeCodexAppServerPatchedProtocol({ stdio, onTermination })`; `Queue.end(input)`; `yield* Deferred.await(termination)`; `late = yield* transport.request("x/late").pipe(Effect.forkScoped)`; `yield* settle`; `late.pollUnsafe()` is defined; `Effect.flip(Fiber.join(late))` is an instance of `CodexAppServerInputStreamEndedError`. Also `Effect.flip(transport.notify("x/late"))` is an instance of the same class. Fails at base (the request never completes).
    - `bounds the exit-status wait when stdout closes and the process stays alive`: pass `terminationError: Effect.never`; `Queue.end(input)`; `yield* TestClock.adjust("3 seconds")`; `yield* settle`; `Deferred.isDone(termination)` is `true` and the error is a `CodexAppServerInputStreamEndedError`. Fails at base. Also assert nothing completes before the wait: `TestClock.adjust("1 second")` first, `Deferred.isDone` is `false`.
    - `raw streams end when the connection ends`: `rawStreams: true`; offer one `item/agentMessage/delta` line, then `Queue.end(input)`; `Chunk` from `Stream.runCollect(transport.incomingNotifications)` has length `1`; `Stream.runCollect(transport.incomingRequests)` has length `0` and both complete.
  - `apps/server/src/symphony/Runner/AgentRuntime.test.ts` (H0 harness; use a helper `settle` as above and `TestClock` where noted):
    - pure `classifyTurnNotification` cases: completed for the pinned turn gives `{ _tag: "completed" }`; wrong `threadId` gives `null`; wrong `turn.id` gives `null`; status `inProgress` gives `null`; `failed` with `error.message` gives `{ _tag: "failed", message }`; `failed` without error gives `"Codex turn failed"`; `interrupted` gives a `failed` signal; `error` with `willRetry: true` gives `null`; `error` for another `turnId` gives `null`.
    - `a failed turn fails runTurn with the Codex message`: `peer.completeTurn("failed", { error: "out of credits" })`; `Effect.result(Fiber.join(fiber))` is a `Failure` whose message contains `"out of credits"`. Fails at base (returns `completed: true`).
    - `an interrupted turn fails runTurn`: `peer.completeTurn("interrupted")` gives a failure containing `"interrupted"`. Fails at base.
    - `a completion for another turn or thread is ignored`: send `completeTurn("completed", { turnId: "turn-other" })` and `completeTurn("completed", { threadId: "thread-other" })`; `settle`; `fiber.pollUnsafe()` is `undefined`; then `completeTurn("completed")` and the join succeeds. Fails at base.
    - `a second turn on the same runtime completes`: run turn 1 (`turn-1`) to completion, then run turn 2 with `continuation: true`; `await turn/start` twice via `awaitClientRequest`; complete `turn-2`; the second join succeeds with `turnId: "turn-2"`. Fails at base (the stale consumer takes the notification).
    - `a crash before turn/completed fails the turn`: `peer.crash(1)`; `settle`; `fiber.pollUnsafe()` defined; failure message contains `"exited"`. Fails at base (hangs).
    - `stdout closed with a live process fails the turn after the exit wait`: `peer.closeStdout`; `TestClock.adjust("3 seconds")`; `settle`; same assertion. Fails at base.
    - `interrupt does not block on an unanswered turn/interrupt`: `makeFakeCodexPeer({ unanswered: ["turn/interrupt"] })`; start a turn, `await turn/start`; `interruptFiber = yield* runtime.interrupt().pipe(Effect.forkScoped)`; `TestClock.adjust("6 seconds")`; `settle`; `interruptFiber.pollUnsafe()` defined. Fails at base.
  - `apps/server/src/symphony/Runner/RunnerFlow.test.ts` (new, W1 flow tests; `it.layer(runnerFlowLayer({ nextPeer, finalizer: countingFinalizer }))` with the holder pattern from H0, where `countingFinalizer` is `Layer.succeed(ExecutionFinalizer, { finalize: () => Effect.sync(() => { finalizeCalls += 1; return "review_ready" as const; }) })`): `a failed turn ends the attempt failed and never finalizes`: seed a queued item, dispatch with `makeRunnerTestConfig({ autonomy: "execute" })`, `await turn/start`, `completeTurn("failed", { error: "out of credits" })`, join; attempt `status` is `"failed"` and `error?.message` contains `"out of credits"`; `finalizeCalls` is `0`; item lifecycle is `"retry_scheduled"` (attempt 1 of 5). Fails at base (`finalizeCalls` is `1`).
- Verify: from `packages/effect-codex-app-server`: `pnpm exec vp test run src/protocol.test.ts src/client.test.ts` and `pnpm exec tsgo --noEmit`. From `apps/server`: `pnpm exec vp test run src/symphony/Runner src/provider/Layers/CodexSessionRuntime.test.ts` (the provider tests guard the `request()` after termination change) and `pnpm exec tsgo --noEmit`. From the repo root `vp check`.
- Depends on: H0, 1.1 (queues and `rawStreams`), 1.2 (same file, avoid conflicts). Effort: M (tight). Commit message: `fix(symphony): honour Codex turn status and fail pending work when the app-server ends`

---

### 1.6 (N6) Allow `testing` to `retry_scheduled` and stop swallowing refused transitions

- Problem: `finalize` moves the item `running` to `testing` (`ExecutionFinalizer.ts:89-95`, `from: ["running"]`; the Dispatcher puts it in `running` first at `Dispatcher.ts:358-364`). After a failed validation it calls `transition(..., "retry_scheduled", { ownerToken, generation })` (`ExecutionFinalizer.ts:167-174`). `DEFAULT_TRANSITION_SOURCES.retry_scheduled` is `["preparing", "running", "waiting_for_approval", "validation_failed"]` (`WorkItemRepository.ts:81`), with no `testing`, so the SQL matches no row, `transition` returns `false` (it does not fail), and the code ignores the boolean. The same ignore applies to the `validation_failed` and `ready_for_review` transitions (`:176-181`, `:280-285`). The item stays `testing`, the Dispatcher's `ensuring` block releases it to `queued` (`Dispatcher.ts:529-531`, `releaseClaim` matches `testing`) and the item is relaunched with no backoff. The existing finalizer test passes at base only because its seed (`ExecutionFinalizer.test.ts:62-87`) claims the item (lifecycle `preparing`) and never enters `testing`.
- Files to change:
  - `apps/server/src/symphony/Persistence/Layers/WorkItemRepository.ts` : `DEFAULT_TRANSITION_SOURCES.retry_scheduled` (line 81)
  - `apps/server/src/symphony/Runner/ExecutionFinalizer.ts` : the three outcome transitions (lines 169-174, 176-181 and 280-285), new local helper
  - `apps/server/src/symphony/Runner/ExecutionFinalizer.test.ts`, `apps/server/src/symphony/Persistence/Layers/WorkItemRepository.test.ts`
- Change:
  1. `WorkItemRepository.ts:81`: `retry_scheduled: ["preparing", "running", "waiting_for_approval", "validation_failed", "testing"],`. Nothing else in the table changes in this card (`validation_failed` and `ready_for_review` already list `testing`).
  2. `ExecutionFinalizer.ts`: add a helper inside `makeExecutionFinalizer` after `appendEvent` (defined at line 79):
     ```ts
     const settleLifecycle = (
       input: {
         readonly workItem: WorkItem;
         readonly runAttemptId: RunAttemptId;
         readonly ownerToken: string;
         readonly generation: number;
       },
       lifecycle: "retry_scheduled" | "validation_failed" | "ready_for_review",
     ) =>
       workItems
         .transition(input.workItem.id, lifecycle, {
           ownerToken: input.ownerToken,
           generation: input.generation,
         })
         .pipe(
           Effect.catch((cause) =>
             Effect.logWarning("symphony.finalizer.transition_error", {
               workItemId: String(input.workItem.id),
               to: lifecycle,
               cause: String(cause),
             }).pipe(Effect.as(false)),
           ),
           Effect.flatMap((moved) =>
             moved
               ? Effect.void
               : Effect.logWarning("symphony.finalizer.transition_refused", {
                   workItemId: String(input.workItem.id),
                   to: lifecycle,
                 }).pipe(
                   Effect.andThen(
                     appendEvent(input.runAttemptId, "lifecycle_transition_refused", {
                       to: lifecycle,
                     }),
                   ),
                 ),
           ),
         );
     ```
     Replace the three `workItems.transition(... "retry_scheduled" | "validation_failed" | "ready_for_review" ...).pipe(Effect.catch(() => Effect.void))` calls with `yield* settleLifecycle(input, "<lifecycle>")`. Leave the `testing` entry transition (lines 89-95) as is; its `false` is expected for the committed-handoff resume path where the item may already be past `running`.
  3. No fallback is added when a transition is refused. The recorded event and warning make the case visible; the Dispatcher's existing `ensuring` release still applies.
- Do not:
  - Do not add `testing` to the sources of any other lifecycle.
  - Do not change `finishedAt: now` handling (it is set before validation; backoff accuracy is a separate concern).
  - Do not make the helper fail the finalizer (`finalize` has error type `never` and Dispatcher ignores failures).
- Tests:
  - `WorkItemRepository.test.ts`, inside `layer("WorkItemRepository lifecycle legality (plan section 19 suite 6)", ...)` (line 219): `it.effect("a testing item can be re-scheduled for retry")`: `id = yield* seed("lifecycle-4", "64", "testing")`; `repo.transition(id, "retry_scheduled")` is `true`; `repo.getById(id)` has lifecycle `"retry_scheduled"`. Fails at base (`false`).
  - `ExecutionFinalizer.test.ts`, inside `layer(["failed"], makePullRequest())("ExecutionFinalizer validation failure path", ...)` (line 322): `it.effect("re-schedules an item that is in testing")`: `workItem = yield* seedWorkItem("6", "owner-6")`; `moved = yield* workItems.transition(workItem.id, "running", { ownerToken: "owner-6", generation: 1, from: ["preparing"] })` and `expect(moved).toBe(true)`; `runAttemptId = yield* seedAttempt("6")`; call `finalize` exactly like the test at line 324 with `ownerToken: "owner-6"`, `generation: 1`, `workspacePath: "/ws/6"`, `branch: "symphony/issue-6"`; assert outcome `"validation_failed"` and `after?.lifecycle` is `"retry_scheduled"`. Fails at base (`"testing"`). This is the production path (`running` then `testing` then retry); the older test at line 324 skips `running` and must stay as is.
  - Same block: `it.effect("records a refused lifecycle transition instead of swallowing it")`: seed `"7"` with `"owner-7"`, move it to `running`, then call `finalize` with `generation: 99` (the fence no longer matches); assert the run events (`RunEventRepository.listForAttempt`) include `lifecycle_transition_refused` and the item is still `running` or `preparing` (not `retry_scheduled`). Fails at base (no such event).
- Verify: from `apps/server`: `pnpm exec vp test run src/symphony/Runner/ExecutionFinalizer.test.ts src/symphony/Persistence/Layers/WorkItemRepository.test.ts`, then `pnpm exec tsgo --noEmit`. From the repo root `vp check`.
- Depends on: none. Effort: S. Commit message: `fix(symphony): allow testing to retry_scheduled and record refused finalizer transitions`

---

### 1.5 (N3, B3) Cancel ends `cancelled`, exhaustion ends `failed`, the scheduler never relaunches a terminal-failed item

- Problem: nothing writes `cancelled` or `failed` (plan B3). `releaseClaim` (`Dispatcher.ts:135-138`) moves the item to `queued`. It is used by the non-retryable branch of `markFailed` (`:217-219`), the completed-but-terminal check (`:437-443`) and the early failures. The interrupted-dispatch `ensuring` block also releases to `queued` (`:529-531`), which is what a cancel falls into: `cancelRun` interrupts the fiber (`:561`), the fiber's `ensuring` releases the claim to `queued`, then `cancelRun` writes attempt `user_cancelled` (`:567-569`). `launchNextQueuedWork` (`SymphonyOrchestratorLive.ts:1501-1524`) picks every `queued` item, so a cancelled or exhausted item is relaunched on the next 5 second tick (`SCHEDULER_SCAN_INTERVAL`, line 83) with a fresh attempt number. `maxAttempts` is only compared when choosing `retry_scheduled` (`retryableFromAttempt`, `:164-176`), and a queued item is never checked against it, so retries are unbounded. The existing tests pin the wrong lifecycle (`Dispatcher.test.ts:494` and `:568` expect `"queued"` after cancel).
- Plan correction: plan row 1.5 says cancel sets `blocked`. The code already allows `cancelled` from `draft`, `eligible`, `queued`, `preparing`, `blocked`, `running`, `testing`, `waiting_for_approval` and `retry_scheduled` (`WorkItemRepository.ts:94-104`), the board maps `cancelled` and `failed` to the Done column (`ProjectBoard.ts:31-34`) with `outcome` set (`:64-69`), and tracker polls never overwrite a lifecycle outside `draft`, `eligible`, `queued` (`updateRow`, `WorkItemRepository.ts:282-285`). So `cancelled` is correct and needs no new transition. `failed` is the one missing legal source: `failed: ["running", "testing", "retry_scheduled", "validation_failed"]` (line 105) has no `preparing`, but prepare-mode runs and early failures fail while `preparing`.
- Definitions used by this card (state them in the code comments where the constants live):
  - `maxAttempts` (`config.maxAttempts`, default `WORKFLOW_DEFAULTS.maxAttempts` = 5, `Dispatcher.ts:225`) is the maximum total number of attempts for a work item, counting the first. Attempt number is the item's running count (`latestAttempt.attemptNumber + 1`, `Dispatcher.ts:252`). After attempt N fails, a retry is allowed only while `N < maxAttempts` (already how `retryableFromAttempt` and `ExecutionFinalizer.ts:167` compare). A manual retry does not reset the count: when the cap is already reached a manual retry runs exactly once and its failure ends `failed`.
  - Retryable failure: the attempt's error category is in `RETRYABLE_CATEGORIES` (`agent`, `timed_out`, `process_failed`, `provider_error`, `stalled`, `validation_failed`, `interrupted`, `Retry.ts:19-27`), the attempt status is not `user_cancelled` or `tracker_cancelled`, and `attemptNumber < maxAttempts`. Item goes to `retry_scheduled` (existing).
  - Not retryable (category `workflow_error`, `user_cancelled`, `tracker_cancelled`, any unknown category, or the cap reached): item goes to `failed`.
  - User cancel: item goes to `cancelled`, attempt `user_cancelled`.
  - Attempt statuses after which the scheduler must not start another attempt by itself: `failed`, `user_cancelled`, `tracker_cancelled`, `workflow_error`, `retries_exhausted`. `interrupted` (server shutdown without a terminal write) and `stalled` (Reconciler releases to `queued`, `Reconciler.ts:141`) are NOT in this set; they stay auto-relaunchable.
- Files to change:
  - `apps/server/src/symphony/Persistence/Layers/WorkItemRepository.ts` : `DEFAULT_TRANSITION_SOURCES.failed` (line 105)
  - `apps/server/src/symphony/Orchestrator/Retry.ts` : new constant and predicate
  - `apps/server/src/symphony/Runner/Dispatcher.ts` : `markFailed` (lines 183-220), `cancelRun` (lines 544-571), `stopAllRuns` (lines 576-597)
  - `apps/server/src/symphony/Orchestrator/Layers/SymphonyOrchestratorLive.ts` : `prepareDispatch` (line 1350) and its two callers (lines 1513, 1527)
  - `apps/server/src/symphony/Orchestrator/SymphonyOrchestrator.ts` : `dispatchWorkItem` signature (line 128)
  - `apps/server/src/ws.ts` : `dispatchWorkItem` handler (line 1053)
  - tests: `Dispatcher.test.ts`, `RunnerFlow.test.ts`, `WorkItemRepository.test.ts`, `Retry.test.ts`, `SymphonyOrchestratorLive.test.ts`
- Change:
  1. `WorkItemRepository.ts:105`: `failed: ["preparing", "running", "testing", "retry_scheduled", "validation_failed"],`.
  2. `Retry.ts`: add
     ```ts
     /** Latest-attempt statuses after which only an explicit user dispatch may start the next attempt. */
     export const AUTO_DISPATCH_BLOCKING_STATUSES: ReadonlySet<string> = new Set([
       "failed",
       "user_cancelled",
       "tracker_cancelled",
       "workflow_error",
       "retries_exhausted",
     ]);
     export const isAutoDispatchBlockedStatus = (status: string): boolean =>
       AUTO_DISPATCH_BLOCKING_STATUSES.has(status);
     ```
  3. `Dispatcher.ts` `markFailed`. After reading `attempt`, return early when the cancel path owns the item, and replace the `else { releaseClaim }` branch:
     ```ts
     if (attempt !== null && (attempt.status === "user_cancelled" || attempt.status === "tracker_cancelled")) {
       return; // cancelRun owns the item lifecycle
     }
     ...
     } else {
       yield* workItems
         .transition(workItemId, "failed", { ownerToken, generation })
         .pipe(Effect.catch(() => Effect.void));
       yield* appendEvent(
         runAttemptId,
         isRetryableCategory(error.category) ? "retries_exhausted" : "run_failed",
         { attemptNumber, maxAttempts, category: error.category },
       );
     }
     ```
     (`appendEvent` is the local helper at `Dispatcher.ts:129`.) Keep the retryable branch as is. Keep `releaseClaim` for its other callers in this card (it is replaced by card 1.7 for the early failures).
  4. `Dispatcher.ts` shared cancel helper. Add inside `makeRunDispatcher`, above `cancelRun`:
     ```ts
     const cancelAttempt = (runAttemptId: RunAttemptId, eventPayload: Record<string, unknown>) =>
       Effect.gen(function* () {
         const attempt = yield* runAttempts
           .getById(runAttemptId)
           .pipe(Effect.catch(() => Effect.succeed(null)));
         // 1. Persist the cancellation BEFORE interrupting anything. Every failure path then sees a
         //    terminal attempt (markFailed returns early, the ensuring block skips its `interrupted`
         //    write) and the item is already `cancelled` when the ensuring block releases the claim.
         yield* runAttempts
           .updateStatus(runAttemptId, "user_cancelled", { finishedAt: yield* nowIso })
           .pipe(Effect.catch(() => Effect.void));
         yield* appendEvent(runAttemptId, "user_cancelled", eventPayload);
         if (attempt !== null) {
           const latest = yield* runAttempts
             .latestForWorkItem(attempt.workItemId)
             .pipe(Effect.catch(() => Effect.succeed(null)));
           if (latest !== null && latest.id === runAttemptId) {
             // Unfenced (the canceller is not the claim owner) and bounded by the legality table.
             yield* workItems
               .transition(attempt.workItemId, "cancelled")
               .pipe(Effect.catch(() => Effect.void));
           }
         }
         // 2. Then stop the live run.
         const registered = (yield* Ref.get(activeAgents)).get(String(runAttemptId));
         if (registered !== undefined) {
           registered.fiber.interruptUnsafe();
           yield* registered.agent.interrupt().pipe(Effect.catch(() => Effect.void));
         }
         yield* liveRequests
           .settleRun(runAttemptId, "user cancelled")
           .pipe(Effect.catch(() => Effect.void));
       });
     ```
     `cancelRun = (runAttemptId) => cancelAttempt(runAttemptId, {})`. In `stopAllRuns`, for each registered attempt call `cancelAttempt(RunAttemptId.make(attemptId), { reason: "stop_all_runs" })` instead of the inline interrupt, settle, `updateStatus` and `appendEvent` block, and keep `stopped += 1`. Keep the comment about using `interruptUnsafe` (no await) from the existing code. Only the latest attempt's item is cancelled, so cancelling an old run id never cancels a newer attempt.
  5. `SymphonyOrchestrator.ts:128`: `readonly dispatchWorkItem: (workItemId: string, options?: { readonly explicit?: boolean }) => Effect.Effect<void, never, Scope.Scope>;` and in `ws.ts:1053`: `orchestrator.dispatchWorkItem(input.workItemId, { explicit: true })`. This is the explicit user retry. `retrySweep` (`SymphonyOrchestratorLive.ts:780`) and `launchNextQueuedWork` stay non-explicit.
  6. `SymphonyOrchestratorLive.ts` `prepareDispatch`: new signature `(workItemId: string, options: { readonly explicit: boolean })`. Update both callers (`launchNextQueuedWork` passes `{ explicit: false }`, `dispatchWorkItem` passes `{ explicit: options?.explicit === true }`). After the existing `changes_requested` block (lines 1368-1375) add:
     ```ts
     if (options.explicit && (item.lifecycle === "failed" || item.lifecycle === "cancelled")) {
       // A user chose to run this item again. Leaving a terminal lifecycle needs an explicit `from`.
       const requeued =
         yield *
         workItems
           .transition(item.id, "queued", { from: [item.lifecycle] })
           .pipe(Effect.catch(() => Effect.succeed(false)));
       if (!requeued) return null;
     }
     if (item.lifecycle === "queued" && !options.explicit) {
       const latestAttempt =
         yield *
         runAttempts.latestForWorkItem(item.id).pipe(Effect.catch(() => Effect.succeed(null)));
       if (latestAttempt !== null && isAutoDispatchBlockedStatus(latestAttempt.status)) return null;
     }
     ```
     Import `isAutoDispatchBlockedStatus` from `../Retry.ts` (the file already imports `retryDueAtMs` from there).
  7. Update `Dispatcher.test.ts`: line 494 `expect(after.lifecycle).toBe("queued")` becomes `"cancelled"` (test "cancelRun records a durable user_cancelled status and ends the dispatch"); in the test at line 534 ("a failing turn cancelled in flight never lands retry_scheduled") keep `not.toBe("retry_scheduled")` (line 567) and change the `toBe("queued")` at line 568 to `"cancelled"`. Widen `makeConfig`'s `Pick` (line 43) to `"autonomy" | "maxTurns" | "maxAttempts"`.
- Do not:
  - Do not call `releaseClaim` after a cancel and do not add a `blocked` lifecycle for cancel.
  - Do not write `retries_exhausted` as an attempt status in this card; it is only an event name here.
  - Do not change `Recovery.ts` or `Reconciler.ts` in this card. They still release to `queued`, and the guard in step 6 covers a `user_cancelled` or `failed` latest attempt (see Open questions).
  - Do not apply the guard to `retry_scheduled` items (retrySweep needs them) or when `explicit` is true.
  - Do not reorder the interrupt before the writes in `cancelAttempt`; the order is the fix for the lost-update window described in the existing comment at `Dispatcher.ts:556-560`.
- Tests:
  - `Dispatcher.test.ts` (existing helpers `layer`, `scriptedFactory`, `scriptedAgent`, `seedWorkItem`): `exhaustion ends failed, not queued`: `layer(scriptedFactory(scriptedAgent(false)))("Dispatcher exhaustion", ...)`; seed `"1010"`; dispatch with `makeConfig("/repo", { maxAttempts: 1 })` (prepare autonomy path, turn not completed); assert attempt `status` `"failed"`, item lifecycle `"failed"`, and events include `"retries_exhausted"`. Fails at base (`"queued"`). A second test `a retryable failure below the cap still schedules a retry` (`maxAttempts: 5`) keeps `"retry_scheduled"` (this is the existing test at line 293-315; leave it).
  - `Dispatcher.test.ts` cancel tests per step 7. Add to the first one: `expect((yield* workItems.listByLifecycle(["queued"])).map((i) => i.id)).not.toContain(workItem.id)`.
  - `RunnerFlow.test.ts` (H0 harness): `cancel interrupts the real turn and ends cancelled`: dispatch execute run, `await turn/start`, `runAttemptId` from `RunAttemptRepository.listByWorkItem`, `yield* dispatcher.cancelRun(runAttemptId)`; `yield* peer.awaitClientRequest("turn/interrupt")`; assert attempt `"user_cancelled"` with `finishedAt` not null, item `"cancelled"`, and after `TestClock.adjust("30 seconds")` the item is still `"cancelled"` and `listByWorkItem` has exactly one attempt.
  - `WorkItemRepository.test.ts` (legality layer): `a preparing item can fail`: `repo.transition(seed("lifecycle-5","65","preparing"), "failed")` is `true`; `a failed item cannot be re-queued without an explicit from`: `transition(id, "queued")` is `false` and `transition(id, "queued", { from: ["failed"] })` is `true`.
  - `Retry.test.ts`: `isAutoDispatchBlockedStatus` is `true` for `failed`, `user_cancelled`, `tracker_cancelled`, `workflow_error`, `retries_exhausted` and `false` for `interrupted`, `stalled`, `succeeded`, `streaming_turn`.
  - `ws-symphony.test.ts` (line 107 fake orchestrator and the test at line 128): change the fake to `dispatchWorkItem: (workItemId: string, options?: { readonly explicit?: boolean }) => Effect.sync(() => { dispatchCalls.push({ workItemId, explicit: options?.explicit === true }); })` with a module-level `dispatchCalls` array; in `dispatchWorkItem calls through to the orchestrator` assert `dispatchCalls` equals `[{ workItemId: "wi-1", explicit: true }]`. Fails at base (`explicit` is `false`).
  - `SymphonyOrchestratorLive.test.ts` (uses `mockDispatcherLayer`, `dispatchedIds`, `seedWorkflow` as in the tests at lines 1069 and 916; seed each item without `trackerIssueId` (fallback in `refreshIssueSnapshot`, `SymphonyOrchestratorLive.ts:241-257`), with its own `projectId` (the work-item key is unique on project, kind and tracker issue id, `041_SymphonyProjects.ts:109`, and `project_id` has no foreign key) and its own workflow id and repository path; the mock dispatcher claims via `workItems.claim`, which accepts `eligible`, `queued` and `retry_scheduled`):
    - `does not auto-relaunch a queued item whose latest attempt was cancelled`: seed workflow autonomy `execute`, item `lifecycle: "queued"`, a `RunAttemptRepository.create` row with status `"user_cancelled"`, `finishedAt` now, error category `user_cancelled`; `dispatchedIds.length = 0; yield* orchestrator.dispatchWorkItem(id)`; `dispatchedIds` does not contain it. Also `TestClock.adjust("10 seconds")` and check still not dispatched. Fails at base.
    - `an explicit dispatch retries a failed item`: item `lifecycle: "failed"` with a `failed` attempt; `yield* orchestrator.dispatchWorkItem(id, { explicit: true })`; `dispatchedIds` contains it and the item lifecycle is `"preparing"` (the mock claims it). Fails at base (the claim fails on a `failed` item).
    - `an explicit dispatch also overrides the guard for a queued item`: queued item with a `user_cancelled` latest attempt, `explicit: true`, dispatched.
- Verify: from `apps/server`: `pnpm exec vp test run src/symphony/Runner src/symphony/Orchestrator src/symphony/Persistence/Layers/WorkItemRepository.test.ts src/ws-symphony.test.ts` then `pnpm exec tsgo --noEmit`. From the repo root `vp check`.
- Depends on: 1.6 (clean retry path), 1.4 (a failed turn reaches `markFailed`). H0 for the flow test. Effort: M. Commit message: `fix(symphony): end cancelled and exhausted runs in cancelled/failed and stop auto-relaunching them`

---

### 1.7 (N4) A failure before the attempt row exists records a failed attempt and leaves the queue

- Problem: in `dispatchWorkItem` the item is claimed (`Dispatcher.ts:231-233`, lifecycle `preparing`), then `ensureWorkspace` runs (`:238-243`) and the attempt row is created (`:258-278`). If either fails, the `tapError` calls `releaseClaim(...)`, which puts the item back in `queued` with no attempt row (`:242`, `:277`). The orchestrator launches at most one candidate per tick: `launchNextQueuedWork` (`SymphonyOrchestratorLive.ts:1501-1524`) forks the first candidate whose `prepareDispatch` is non-null and then `return`s (line 1522). Candidates come ordered by priority and `created_at` (`WorkItemRepository.ts:447-451`). A workspace that cannot be created (for example `git worktree add` failing) therefore makes the same head item win every 5 seconds, fail, and return to `queued`, so no other item is ever launched. Retry limits cannot apply because no attempt rows exist to count (`latestForWorkItem` returns `null`, so `attemptNumber` stays 1).
- Files to change:
  - `apps/server/src/symphony/Runner/Dispatcher.ts` : new `failEarly` helper; `ensureWorkspace` error handling (lines 238-243); attempt creation error handling (lines 271-277); import of `WorkspaceOutsideRootError`
  - `apps/server/src/symphony/Runner/Dispatcher.test.ts`
  - `apps/server/src/symphony/Orchestrator/Layers/SymphonyOrchestratorLive.test.ts` (scheduler regression guard)
- Change:
  1. Add the helper inside `makeRunDispatcher` after `markFailed`. It records a terminal failed attempt and then reuses `markFailed` for the retry-or-fail decision from card 1.5:
     ```ts
     const failEarly = (input: {
       readonly workItemId: WorkItemId;
       readonly ownerToken: string;
       readonly generation: number;
       readonly config: EffectiveWorkflowConfig;
       readonly maxAttempts: number;
       readonly stage: "workspace";
       readonly error: { readonly category: string; readonly message: string };
     }) =>
       Effect.gen(function* () {
         const runAttemptId = yield* makeRunAttemptId().pipe(
           Effect.catch(() => Effect.succeed(null)),
         );
         const latest = yield* runAttempts
           .latestForWorkItem(input.workItemId)
           .pipe(Effect.catch(() => Effect.succeed(null)));
         const attemptNumber = (latest?.attemptNumber ?? 0) + 1;
         const now = yield* nowIso;
         const created =
           runAttemptId === null
             ? false
             : yield* runAttempts
                 .create({
                   id: runAttemptId,
                   workItemId: input.workItemId,
                   attemptNumber,
                   workspacePath: "",
                   provider: input.config.agentProvider,
                   ...(input.config.agentModel !== undefined
                     ? { model: input.config.agentModel }
                     : {}),
                   status: "failed",
                   startedAt: now,
                   finishedAt: now,
                   error: { ...input.error, attemptNumber },
                 })
                 .pipe(
                   Effect.as(true),
                   Effect.catch(() => Effect.succeed(false)),
                 );
         if (runAttemptId !== null && created) {
           yield* appendEvent(runAttemptId, "dispatch_failed_early", {
             stage: input.stage,
             message: input.error.message,
           });
           yield* markFailed(
             runAttemptId,
             input.workItemId,
             input.ownerToken,
             input.generation,
             input.error,
             input.maxAttempts,
           );
         } else {
           // No attempt row means the retry sweep (which needs a finished attempt) could never pick the
           // item up, so end it `failed` instead of leaving it in `preparing` or `queued`.
           yield* workItems
             .transition(input.workItemId, "failed", {
               ownerToken: input.ownerToken,
               generation: input.generation,
             })
             .pipe(Effect.catch(() => Effect.void));
         }
       });
     ```
     The attempt row is written with status `failed` and `finishedAt` set, so `markFailed` sees an already terminal attempt (`TERMINAL_STATUSES` contains `failed`), does not rewrite it, and decides retry-or-fail with `retryableFromAttempt` using the real `attemptNumber`.
  2. Workspace failure. Replace the `Effect.tapError(() => releaseClaim(...))` at line 242 with:
     ```ts
     Effect.tapError((cause) =>
       failEarly({
         workItemId, ownerToken, generation: claimed.generation, config, maxAttempts, stage: "workspace",
         error: {
           category: cause instanceof WorkspaceOutsideRootError ? "workflow_error" : "process_failed",
           message: cause.message,
         },
       }),
     ),
     ```
     Import `WorkspaceOutsideRootError` from `../Workspaces/Manager.ts` (the file already imports `WorkspaceManager` and `SymphonyWorkspace` there). An outside-root workspace is a configuration error and is not retried (`workflow_error`, item `failed`); every other workspace error (`WorkspacePopulationError`, `WorkspaceLeaseError`) is `process_failed`, retried with backoff while `attemptNumber < maxAttempts`, then `failed`. The mapped `RunDispatchError` is still returned to the caller exactly as before. Move the `makeConfig`-independent `const maxAttempts` computation if needed so `maxAttempts` is in scope (it is defined at line 225, above this code).
  3. Attempt-row creation failure (line 277): replace `Effect.tapError(() => releaseClaim(workItemId, ownerToken, claimed.generation))` with `Effect.tapError(() => workItems.transition(workItemId, "failed", { ownerToken, generation: claimed.generation }).pipe(Effect.catch(() => Effect.void)))`. No attempt row can be written here (the write just failed), so the item ends `failed` (legal from `preparing` after card 1.5) rather than looping in `queued`. Update the stale comment above it ("Release the claim so the item can be re-dispatched").
  4. Do not change `launchNextQueuedWork`. With the item out of `queued`, the next tick's candidate list no longer contains it and the scheduler moves on. The head-of-line behaviour disappears once the failing item has left the queue.
  5. `releaseClaim` (`Dispatcher.ts:135`) now has one caller left, the completed-but-terminal check at `:441`. Keep it.
- Do not:
  - Do not create the attempt row before `ensureWorkspace` to "fix" the order; the attempt requires `workspacePath`, and `resumeCommittedHandoff` (`:253-257`) reads `latestAttempt` before the new row exists.
  - Do not use the status `workflow_error` for the attempt row; it is the error category. The attempt status stays `failed` (the existing set of terminal statuses and UI labels handle it).
  - Do not store a fake workspace path. `""` is correct because no workspace exists.
  - Do not let `failEarly` fail (`Effect.catch` everywhere). A failure inside the failure handler must not mask the original error.
- Tests:
  - `Dispatcher.test.ts`, new `layer(scriptedFactory(scriptedAgent(true)), failingWorkspaceManager("population"))("Dispatcher early failure", ...)`, where `failingWorkspaceManager` is `Layer.succeed(WorkspaceManager, { ensureWorkspace: () => Effect.fail(new WorkspacePopulationError("key", "git worktree add failed")), removeWorkspace: () => Effect.void, hasCommittedHandoff: () => Effect.succeed(false), resolvePath: () => "/ws" })` modelled on `resumableWorkspaceManager` (line 340):
    - `a workspace failure writes a failed attempt and schedules a retry`: seed `"1020"`; `result = yield* Effect.result(dispatcher.dispatchWorkItem({ workItem, issue: makeIssue("1020"), config: makeConfig("/repo", { autonomy: "execute" }) }))` is a `Failure` whose message contains `"git worktree add failed"`; `attempts.listByWorkItem(workItem.id)` has exactly 1 row with `status: "failed"`, `attemptNumber: 1`, `workspacePath: ""`, `error.category: "process_failed"`; item lifecycle `"retry_scheduled"`; events of that attempt include `"dispatch_failed_early"` and `"retry_scheduled"`. Fails at base (no attempt rows, lifecycle `"queued"`).
    - `a workspace failure at the attempt cap ends failed`: same layer, `makeConfig("/repo", { autonomy: "execute", maxAttempts: 1 })`, seed `"1021"`; lifecycle `"failed"`, one attempt row. Fails at base.
    - `an outside-root workspace is not retried` (second layer failing with `new WorkspaceOutsideRootError("/x", "/root")`, constructor `(path, root)` at `Workspaces/Manager.ts:27-36`): attempt `error.category` is `"workflow_error"`, lifecycle `"failed"`.
    - `the queue is not blocked by a failing head item`: seed two queued items `"1022"` and `"1023"` with `priority` such that `"1022"` sorts first (`seedWorkItem` uses `priority: 1` for both and `created_at` ascending, so seeding `"1022"` first is enough); dispatch `"1022"` (fails), then `workItems.listByLifecycle(["queued"])` returns only `"1023"`. Fails at base (`"1022"` is still first).
  - `SymphonyOrchestratorLive.test.ts` is not given a new dispatcher-failure test: `mockDispatcherLayer` cannot reproduce the real early failure. The Dispatcher tests above cover the semantic. Add one scheduler guard instead: `launches the next candidate once the head item has left the queue`: two queued items in an `execute` workflow (`priority: 1` then `2`), `dispatchedIds.length = 0`; `TestClock.adjust("5 seconds")` and `Effect.yieldNow`; `dispatchedIds` is `[<first>]`; then simulate the early failure by `workItems.transition(<first>, "failed", { from: ["preparing"] })`; `TestClock.adjust("5 seconds")`; `dispatchedIds` is `[<first>, <second>]`. (This documents the one-launch-per-tick behaviour; it passes at base and must keep passing.)
- Verify: from `apps/server`: `pnpm exec vp test run src/symphony/Runner/Dispatcher.test.ts src/symphony/Orchestrator/Layers/SymphonyOrchestratorLive.test.ts`, then `pnpm exec tsgo --noEmit`. From the repo root `vp check`.
- Depends on: 1.5 (`failed` is legal from `preparing`; `markFailed` ends `failed`). Effort: M. Commit message: `fix(symphony): record early dispatch failures as failed attempts so the queue keeps moving`

---

### 1.8 (N5) Fork dispatches into the dispatch scope from both retrySweep and the manual RPC

- Problem: `RunDispatcher.dispatchWorkItem` does not return until the run ends: it forks the run fiber and then `Fiber.join(fiber)` (`Dispatcher.ts:482`, `:541`). The orchestrator's `dispatchWorkItem` (`SymphonyOrchestratorLive.ts:1526-1531`) awaits it inline. Two callers hold the caller open for the whole run: `retrySweep` (`:780`, called from `runTick` at `:727`), so one due retry blocks the scheduler tick (no polling, reconcile, approval expiry or launch for up to the one hour turn timeout), and the manual RPC (`ws.ts:1048-1054`), whose handler runs under the request scope (the handler type needs `Scope.Scope`, see `ws-symphony.test.ts:132` `Effect.scoped(handler(...))`). A UI reload interrupts the RPC, which closes that scope and kills the run fiber (`Effect.forkScoped` inside `dispatchWorkItem`). Only `launchNextQueuedWork` already forks correctly (`:1517-1521`: `Effect.scoped` then `Effect.forkIn(dispatchScope)`, with `dispatchScope` created at `:580-581`).
- Files to change:
  - `apps/server/src/symphony/Orchestrator/Layers/SymphonyOrchestratorLive.ts` : new `launchDispatch`; `launchNextQueuedWork` (line 1501), `dispatchWorkItem` (line 1526), `retrySweep` (line 739), `runTick` (line 726-730)
  - `apps/server/src/symphony/Orchestrator/Layers/SymphonyOrchestratorLive.test.ts`
- Change:
  1. Add one helper next to `executePreparedDispatch` (line 1456) that holds the pattern `launchNextQueuedWork` already uses, and returns whether anything was launched:
     ```ts
     const launchDispatch = Effect.fn("symphonyOrchestrator.launchDispatch")(function* (
       workItemId: string,
       options: { readonly explicit: boolean },
     ) {
       const prepared = yield* prepareDispatch(workItemId, options);
       if (prepared === null) return false;
       yield* executePreparedDispatch(prepared).pipe(
         Effect.scoped,
         Effect.forkIn(dispatchScope),
         Effect.asVoid,
       );
       return true;
     });
     ```
     `prepareDispatch` and its `options` argument come from card 1.5. The run, its agent runtime and its scope now belong to `dispatchScope`, which is closed only by the orchestrator's finalizer (`:581`).
  2. `launchNextQueuedWork`: replace the `prepareDispatch` plus inline fork (lines 1513-1522) with `if (yield* launchDispatch(String(candidate.id), { explicit: false })) { return; }`. Behaviour is unchanged (one launch per tick).
  3. `dispatchWorkItem` (the shape method, line 1526): `(workItemId, options) => launchDispatch(workItemId, { explicit: options?.explicit === true }).pipe(Effect.asVoid)`. Keep the shape type at `SymphonyOrchestrator.ts:128` as changed in card 1.5 (it still lists `Scope.Scope` in `R`; an implementation that needs no scope is assignable, so leave the type alone to avoid touching `ws.ts` and mocks).
  4. `retrySweep`: it must return `Effect<boolean>` ("launched one"). Replace line 780 with `if (yield* launchDispatch(String(item.id), { explicit: false })) { return true; }` and `return false` after the loop. Returning after the first launch keeps the concurrency caps honest: `prepareDispatch` counts in-flight items from the database (`:1417-1439`) and a forked run claims its item a moment later, so launching several in one tick could exceed the caps.
  5. `runTick` (lines 726-730):
     ```ts
     yield * reconcileStaleClaims({ workItems, runAttempts, runEvents, workflows, dispatcher });
     const retried = yield * retrySweep();
     if (allowDispatch && !retried) {
       yield * launchNextQueuedWork();
     }
     yield * sweepExpiredApprovals(now);
     ```
  6. RPC return value: unchanged. `ws.ts:1053` still returns `{ ok: true }` (`SymphonyEmptyResult`) as soon as the prepare step finishes and the run is forked. It cannot say "started" or "refused" without a contract change; that is plan item 4.5 (B1, `plan.md:303`, `plan.md:524`), which can use the boolean `launchDispatch` already returns. No contract or web change in this card.
  7. Update the four existing orchestrator tests that call `orchestrator.dispatchWorkItem(...)` and assert on the mock dispatcher immediately (`SymphonyOrchestratorLive.test.ts` lines 1112-1113, 1713-1717, 1790-1792; the "not.toContain" cases at 1108-1109 and 1234-1235 need no change). Add a local helper that waits for the forked mock dispatch:
     ```ts
     const awaitDispatched = (id: string) =>
       Effect.gen(function* () {
         for (let i = 0; i < 200 && !dispatchedIds.includes(id); i++) {
           yield* Effect.yieldNow;
           yield* TestClock.adjust("1 millis");
         }
       });
     ```
     and call `yield* awaitDispatched("pause-1")` (and `"review-fr-1"`, `"review-fr-2"`) after the corresponding `dispatchWorkItem` before the assertions.
- Do not:
  - Do not interrupt or join the forked fiber from `dispatchWorkItem`. The run must outlive the caller.
  - Do not fork into the tick scope or the RPC scope; both close before the run ends (`runTick(...).pipe(Effect.scoped)` at `:859-862`, `:879`).
  - Do not make `retrySweep` launch every due retry in one pass (concurrency caps, see step 4).
  - Do not change `Dispatcher.dispatchWorkItem` to return early. Its join is what keeps the per-dispatch scope (agent runtime, child process) alive and its callers are fine with it now that they run inside `dispatchScope`.
- Tests (`SymphonyOrchestratorLive.test.ts`): extend `mockDispatcherLayer` (lines 251-284) with a gate and an interruption flag at module level next to `dispatchedIds`:
  ```ts
  let dispatchGate: Deferred.Deferred<void> | null = null;
  const dispatchStatus = { interrupted: false, completed: false };
  ```
  and make the mock's `dispatchWorkItem` run, after the claim and the `dispatchedIds.push`, `Effect.andThen(dispatchGate === null ? Effect.void : Deferred.await(dispatchGate))`, then `Effect.onInterrupt(() => Effect.sync(() => { dispatchStatus.interrupted = true; }))` and `Effect.tap(() => Effect.sync(() => { dispatchStatus.completed = true; }))` (add `import * as Deferred from "effect/Deferred";`). Reset both in each new test. Helper `settle = Effect.repeat(Effect.yieldNow, { times: 50 })`.
  Seeding rules for the three tests below. The layer and its database are shared by the whole file, the mock dispatcher leaves claimed items in `preparing`, and the work-item key is unique on `(project_id, tracker_kind, tracker_issue_id)` (`041_SymphonyProjects.ts:109`). So: seed each item without `trackerIssueId` (the fallback in `refreshIssueSnapshot`, `SymphonyOrchestratorLive.ts:241-257`, needs no tracker), give each item its own `projectId` (for example `SymphonyProjectId.make("fork-project-1")`; `project_id` has no foreign key, `041_SymphonyProjects.ts:75`), use `createdAt: "2000-01-01T00:00:00.000Z"` and `priority: 1` so the item sorts ahead of leftovers from other tests, give each its own workflow id and repository path (`seedWorkflow` then `workflows.upsert` with `autonomy: "execute"`, copy the setup at lines 916-960), and assert on `dispatchedIds.filter((id) => id.startsWith("fork-"))` only.
  - `manual dispatch returns before the run ends and survives the caller's scope`: item `fork-1` in lifecycle `queued`; `dispatchGate = yield* Deferred.make<void>()`; `yield* Effect.scoped(orchestrator.dispatchWorkItem("fork-1", { explicit: true }))` returns; `yield* awaitDispatched("fork-1")`; `yield* settle`; `dispatchStatus.interrupted` is `false` and `completed` is `false` (the run is still held); the item's lifecycle is `"preparing"`; then `yield* Deferred.succeed(dispatchGate, undefined)`, `yield* settle`, `completed` is `true`. Fails at base (the scoped call never returns while the gate is held).
  - `a due retry does not block the scheduler tick`: item `fork-2` in `retry_scheduled` plus an attempt row (`RunAttemptRepository.create`, status `"failed"`, `attemptNumber: 1`, `error: { category: "agent", message: "turn failed" }`, `finishedAt: "1969-12-31T00:00:00.000Z"`, which is before the TestClock epoch so the 10 second backoff has elapsed without advancing the clock and waking the scheduler); `dispatchGate = yield* Deferred.make<void>()`; `tick = yield* orchestrator.refreshNow().pipe(Effect.forkScoped)`; `yield* settle`; `tick.pollUnsafe()` is defined and `dispatchedIds` contains `"fork-2"`. Fails at base (`tick.pollUnsafe()` is `undefined`: `retrySweep` is joined on the gate).
  - `one retry launch per tick suppresses the queued launch`: items `fork-3-retry` (`retry_scheduled` with the same kind of 1969 attempt row, item `createdAt` 2000-01-01) and `fork-3-queued` (`queued`, `createdAt` 2000-01-02), both in the same `execute` workflow; `dispatchGate = yield* Deferred.make<void>()`; `yield* TestClock.adjust("5 seconds")` (one scheduler scan); `yield* settle`; the filtered `dispatchedIds` equals `["fork-3-retry"]`; `yield* TestClock.adjust("5 seconds")`; `yield* settle`; it equals `["fork-3-retry", "fork-3-queued"]`.
  - Release the gate at the end of each test (`Deferred.succeed(dispatchGate, undefined)`) and set `dispatchGate = null` in an `Effect.ensuring`.
  - Because the shared database can hold other due `retry_scheduled` items, `retrySweep` now returns after its first launch. If an existing retry test (for example the one at line 916) now needs one more scan to see its dispatch, widen its `TestClock.adjust` by one `SCHEDULER_SCAN_INTERVAL` (5 seconds) and leave the production behaviour as specified.
- Verify: from `apps/server`: `pnpm exec vp test run src/symphony/Orchestrator/Layers/SymphonyOrchestratorLive.test.ts src/ws-symphony.test.ts`, then `pnpm exec tsgo --noEmit`. From the repo root `vp check`.
- Depends on: 1.5 (signature of `prepareDispatch` and `dispatchWorkItem`), 1.7 (a forked run that fails early must leave `queued`, otherwise forking increases the retry loop rate). Effort: S to M. Commit message: `fix(symphony): run dispatches in the dispatch scope so retries and the RPC do not hold the caller`

---

## Symphony runner after these cards

1. Launch: the scheduler tick (retrySweep first, then the queue) or the explicit RPC calls `launchDispatch`, which runs `prepareDispatch` (pause and cap checks, tracker refresh, refusal of a queued item whose latest attempt is terminal-failed unless the user asked) and forks the run into `dispatchScope`, so no tick or RPC waits for it.
2. Claim: `RunDispatcher` claims the row (`eligible`, `queued` or `retry_scheduled` to `preparing`, fenced by owner token and generation), creates the workspace, then writes the attempt row; a failure before the attempt exists writes a failed attempt and ends `retry_scheduled` or `failed`, never `queued`.
3. Spawn: `AgentRuntime` starts `codex app-server` on the first `runTurn` with a `rawStreams` client (no automatic replies), runs `initialize`, `thread/start`, and starts one request consumer that lives as long as the runtime.
4. Turn: `turn/start`, then a wait pinned to that thread id and turn id; only `turn/completed` with status `completed` succeeds, while `failed`, `interrupted`, a non-retried `error`, EOF or a crash fail `runTurn` with the Codex message.
5. Approvals: each approval or user-input request registers a live entry keyed by run and request id, then a durable `sym-<uuid>` row; the UI sends the durable id, the service reads the row first, answers the live entry and persists the decision, and the agent receives exactly one reply (`accept`, `decline`, or the `answers` map).
6. Completion: in prepare mode a completed turn ends the attempt `succeeded` and the item `ready_for_review`; in execute mode the finalizer runs validation, evidence, model review and PR creation, moving the item `running`, `testing`, `ready_for_review`.
7. Failure: a failed `runTurn` goes to `markFailed` and never to the finalizer; a retryable error below `maxAttempts` (including a validation failure from `testing`) goes to `retry_scheduled`, anything else goes to `failed`, with an event recording why.
8. Retry: `retrySweep` launches at most one due retry per tick through the same forked `launchDispatch`, once the backoff after `finishedAt` has elapsed, and that tick skips the queue launch so concurrency caps hold.
9. Cancel: `cancelRun` and `stopAllRuns` write attempt `user_cancelled` and item `cancelled` first, then interrupt the run fiber, send `turn/interrupt` (bounded by `INTERRUPT_REQUEST_TIMEOUT`) and settle pending requests; a `cancelled` or `failed` item runs again only through an explicit user dispatch.
10. Shutdown and recovery: an interrupted fiber without a terminal status writes `interrupted` and releases to `queued`, which the scheduler may relaunch; Reconciler and Recovery still release to `queued`, and the `prepareDispatch` guard stops them from looping on terminal-failed attempts.

## Open questions

1. Budget reset on manual retry. As specified, `maxAttempts` counts all attempts of the item, so a manual retry after exhaustion runs once and cannot auto-retry. Should an explicit retry reset the budget (needs a stored cycle start, for example an event or a column)?
2. Reconciler and Recovery (`Reconciler.ts:115`, `:141`; `Recovery.ts:150`, `:179`, `:231`) still release terminal-attempt items to `queued`. After card 1.5 an item whose latest attempt is `user_cancelled` or `failed` and that was released this way is refused by the guard and stays in Not Started until a user retries. Should those paths write `cancelled` or `failed` instead?
3. `ws.ts:978` ignores `SymphonyApproveInput.scope`. Should `current_run` map to Codex `acceptForSession`?
4. Symphony user-input requests surface as `command_approval` attention items with Approve and Reject buttons (`SymphonyOrchestratorLive.ts:448-454`), and no web caller exists for `symphony.respondToUserInput`. After card 1.3 an Approve on such a row fails with not found. The UI needs a text answer path, which is outside W1.
5. The dispatch RPC still returns `{ ok: true }` for refusals. Plan item 4.5 (B1) will add started or refused; `launchDispatch` already returns the boolean it needs.
6. Early workspace failures use category `process_failed` (retried) except `WorkspaceOutsideRootError` (`workflow_error`, not retried). Confirm `WorkspaceLeaseError` should be retried.
7. `initialize`, `thread/start` and `turn/start` have no timeout. `WORKFLOW_DEFAULTS.codexReadTimeoutMs` (5000) exists and is unused. Wire it in as a follow-up?
8. The request consumer in `AgentRuntime` uses `Stream.runForEach`, which handles requests one at a time, so two concurrent approvals serialise. Make it concurrent?

## Unverified

- Nothing was compiled or run beyond one existing test file (`AgentRuntime.scrub.test.ts`, 5 tests pass with Node 24.21.0). All snippets are unchecked against `tsgo`. Likely friction points: the intersection return type of `toCodexApprovalDecision`, `Effect.timeoutOption` with `Option.getOrElse` in `protocol.ts`, `Sink.forEach` assignability to `ChildProcessHandle["stdin"]`, and the `provideMerge` order in `runnerFlowLayer`.
- The built-in `thread/start` and `turn/start` fixtures in H0 were written from the generated types (`schema.gen.ts:41988`, `:31246`, `:29605`) and not decoded. The first H0 test is the check.
- `Queue.end` delivering buffered items before completion was confirmed from `Queue.ts` state names (`Closing`, line 975) but not run.
- Orchestrator tests share one database and one scheduler. The new tests in 1.5 and 1.8 use isolating seeds (own `projectId`, no `trackerIssueId`, early `createdAt`), but whether an older test needs a longer `TestClock.adjust` after `retrySweep` stops at its first launch is only known by running the whole file.
- `Fiber` and `Effect.forkChild` usage follows `.repos/effect-smol` and `CodexAdapter.test.ts:454`. `Effect.timeoutOption` under `TestClock` was assumed to fire on `TestClock.adjust`.
- The plan row 1.5 text ("cancel sets `blocked`") was overridden using the task brief and the code. No call was made on whether `blocked` has UI meaning elsewhere.
