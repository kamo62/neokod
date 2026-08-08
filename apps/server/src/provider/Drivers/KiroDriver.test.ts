// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import { KiroSettings, ProviderDriverKind, ProviderInstanceId, ThreadId } from "@neokod/contracts";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import { ServerConfig } from "../../config.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import { WorkspaceOwnershipRepository } from "../../symphony/Persistence/Services/WorkspaceOwnershipRepository.ts";
import type {
  WorkspaceOwnershipRecord,
  WorkspaceOwnershipRepositoryShape,
} from "../../symphony/Persistence/Services/WorkspaceOwnershipRepository.ts";
import { NoOpProviderEventLoggers, ProviderEventLoggers } from "../Layers/ProviderEventLoggers.ts";
import { KiroDriver, makeKiroProcessEnvironment } from "./KiroDriver.ts";

const decodeKiroSettings = Schema.decodeEffect(KiroSettings);
const __dirname = NodePath.dirname(NodeURL.fileURLToPath(import.meta.url));
const mockAgentPath = NodePath.join(__dirname, "../../../scripts/acp-mock-agent.ts");
const shellQuote = (value: string) => `'${value.replaceAll("'", `'"'"'`)}'`;

function makeOwnershipRepository(): WorkspaceOwnershipRepositoryShape {
  const records = new Map<string, WorkspaceOwnershipRecord>();
  return {
    acquire: (input) =>
      Effect.sync(() => {
        const record: WorkspaceOwnershipRecord = {
          workspacePath: input.workspacePath,
          owner: input.owner,
          workItemId: input.workItemId ?? null,
          threadId: input.threadId ?? null,
          generation: (records.get(input.workspacePath)?.generation ?? 0) + 1,
          leaseExpiresAt: input.leaseExpiresAt ?? null,
          updatedAt: "2026-01-01T00:00:00.000Z",
        };
        records.set(input.workspacePath, record);
        return record;
      }),
    transfer: () => Effect.succeed(null),
    renew: () => Effect.succeed(null),
    release: (input) =>
      Effect.sync(() => {
        const current = records.get(input.workspacePath);
        if (current?.generation !== input.generation) return false;
        records.delete(input.workspacePath);
        return true;
      }),
    getByWorkspacePath: (workspacePath) => Effect.sync(() => records.get(workspacePath) ?? null),
  };
}

it("Kiro v3 accepts only an explicit sensitive per-instance API key", () => {
  const host = { PATH: "/bin", KIRO_API_KEY: "host-key" };

  expect(makeKiroProcessEnvironment("v3", [], host)).not.toHaveProperty("KIRO_API_KEY");
  expect(
    makeKiroProcessEnvironment(
      "v3",
      [{ name: "KIRO_API_KEY", value: "plain-key", sensitive: false }],
      host,
    ),
  ).not.toHaveProperty("KIRO_API_KEY");
  expect(
    makeKiroProcessEnvironment(
      "v3",
      [{ name: "KIRO_API_KEY", value: "instance-key", sensitive: true }],
      host,
    ).KIRO_API_KEY,
  ).toBe("instance-key");
});

it.effect("KiroDriver streams Kiro CLI 2.16.2 from checking to ready", () =>
  Effect.gen(function* () {
    const dir = yield* Effect.promise(() =>
      NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "kiro-driver-health-")),
    );
    const binaryPath = NodePath.join(dir, "kiro-cli");
    const writeBinary = (version: string) =>
      Effect.promise(() =>
        NodeFSP.writeFile(
          binaryPath,
          `#!/bin/sh
if [ "$1" = "--version" ]; then
  printf 'kiro-cli ${version}\\n'
  exit 0
fi
export NEOKOD_ACP_AUTH_METHOD_IDS=
exec ${shellQuote(process.execPath)} ${shellQuote(mockAgentPath)} "$@"
`,
          { encoding: "utf8", mode: 0o755 },
        ),
      );
    yield* writeBinary("2.16.2");
    const config = yield* decodeKiroSettings({ enabled: true, binaryPath });
    const layer = ServerConfig.layerTest(process.cwd(), { prefix: "kiro-driver-test" }).pipe(
      Layer.provideMerge(NodeServices.layer),
      Layer.provideMerge(
        ServerSettingsService.layerTest({ providers: { kiro: { enabled: true, binaryPath } } }),
      ),
      Layer.provideMerge(Layer.succeed(ProviderEventLoggers, NoOpProviderEventLoggers)),
      Layer.provideMerge(Layer.succeed(WorkspaceOwnershipRepository, makeOwnershipRepository())),
    );

    const instance = yield* KiroDriver.create({
      instanceId: ProviderInstanceId.make("kiro"),
      displayName: undefined,
      accentColor: undefined,
      environment: [],
      enabled: true,
      config,
    }).pipe(Effect.provide(layer));
    const initial = yield* instance.snapshot.getSnapshot;
    expect(initial.status).toBe("warning");

    yield* instance.snapshot.refresh.pipe(Effect.timeout("10 seconds"));
    expect((yield* instance.snapshot.getSnapshot).status).toBe("warning");

    const nextFiber = yield* Stream.runHead(instance.snapshot.streamChanges).pipe(Effect.forkChild);
    const threadId = ThreadId.make("kiro-driver-managed-turn");
    yield* instance.adapter
      .startSession({
        threadId,
        provider: ProviderDriverKind.make("kiro"),
        cwd: process.cwd(),
        runtimeMode: "approval-required",
      })
      .pipe(Effect.timeout("10 seconds"));
    yield* instance.adapter
      .sendTurn({ threadId, input: "hello", attachments: [] })
      .pipe(Effect.timeout("10 seconds"));
    const next = yield* Fiber.join(nextFiber).pipe(Effect.timeout("10 seconds"));
    expect(Option.isSome(next) ? next.value.status : undefined).toBe("ready");
    expect(Option.isSome(next) ? next.value.version : undefined).toBe("2.16.2");
    yield* instance.adapter.stopSession(threadId);

    yield* writeBinary("2.16.3");
    yield* instance.snapshot.refresh.pipe(Effect.timeout("10 seconds"));
    yield* Effect.sleep("50 millis");
    const changedRuntime = yield* instance.snapshot.getSnapshot;
    expect(changedRuntime.status).toBe("warning");
    expect(changedRuntime.version).toBe("2.16.3");
  }).pipe(TestClock.withLive, Effect.scoped),
);
