// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import { KiroSettings, ProviderInstanceId } from "@neokod/contracts";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import { ServerConfig } from "../../config.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import { WorkspaceOwnershipRepository } from "../../symphony/Persistence/Services/WorkspaceOwnershipRepository.ts";
import { NoOpProviderEventLoggers, ProviderEventLoggers } from "../Layers/ProviderEventLoggers.ts";
import { KiroDriver } from "./KiroDriver.ts";

const decodeKiroSettings = Schema.decodeEffect(KiroSettings);

const ownershipLayer = Layer.succeed(WorkspaceOwnershipRepository, {
  acquire: () => Effect.succeed(null),
  transfer: () => Effect.succeed(null),
  renew: () => Effect.succeed(null),
  release: () => Effect.succeed(false),
  getByWorkspacePath: () => Effect.succeed(null),
});

it.effect("KiroDriver keeps Kiro CLI 2.16.2 limited pending a managed turn", () =>
  Effect.gen(function* () {
    const dir = yield* Effect.promise(() =>
      NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "kiro-driver-health-")),
    );
    const binaryPath = NodePath.join(dir, "kiro-cli");
    yield* Effect.promise(() =>
      NodeFSP.writeFile(binaryPath, "#!/bin/sh\nprintf 'kiro-cli 2.16.2\\n'\n", {
        encoding: "utf8",
        mode: 0o755,
      }),
    );
    const config = yield* decodeKiroSettings({ enabled: true, binaryPath });
    const layer = ServerConfig.layerTest(process.cwd(), { prefix: "kiro-driver-test" }).pipe(
      Layer.provideMerge(NodeServices.layer),
      Layer.provideMerge(
        ServerSettingsService.layerTest({ providers: { kiro: { enabled: true, binaryPath } } }),
      ),
      Layer.provideMerge(Layer.succeed(ProviderEventLoggers, NoOpProviderEventLoggers)),
      Layer.provideMerge(ownershipLayer),
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

    const nextFiber = yield* Stream.runHead(instance.snapshot.streamChanges).pipe(Effect.forkChild);
    yield* instance.snapshot.refresh;
    const next = yield* Fiber.join(nextFiber);
    expect(Option.isSome(next) ? next.value.status : undefined).toBe("warning");
    expect(Option.isSome(next) ? next.value.version : undefined).toBe("2.16.2");
  }).pipe(Effect.scoped),
);
