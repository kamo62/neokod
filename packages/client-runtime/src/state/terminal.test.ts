import {
  EnvironmentId,
  ThreadId,
  type TerminalMetadataStreamEvent,
  type TerminalSummary,
} from "@neokod/contracts";
import { it as effectIt } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { AtomRegistry } from "effect/unstable/reactivity";
import { describe, expect, it } from "vite-plus/test";

import { createTerminalEnvironmentAtoms, projectTerminalMetadata } from "./terminal.ts";
import { acquireTerminalInputQueue, type TerminalInputTarget } from "./terminalSession.ts";

type WriteResult = { readonly _tag: "Success" } | { readonly _tag: "Failure" };

const SUCCESS: WriteResult = { _tag: "Success" };

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

function recordingSend() {
  const sent: Array<string> = [];
  const acknowledgements: Array<ReturnType<typeof deferred<WriteResult>>> = [];
  return {
    sent,
    acknowledgements,
    send: (chunk: string) => {
      sent.push(chunk);
      const acknowledgement = deferred<WriteResult>();
      acknowledgements.push(acknowledgement);
      return acknowledgement.promise;
    },
  };
}

async function waitForSent(sent: ReadonlyArray<unknown>, length: number): Promise<void> {
  for (let attempt = 0; attempt < 100 && sent.length < length; attempt += 1) {
    await Promise.resolve();
  }
  expect(sent).toHaveLength(length);
}

function target(terminalId: string): TerminalInputTarget {
  return {
    environmentId: EnvironmentId.make("env-terminal-commands"),
    threadId: ThreadId.make("thread-terminal-commands"),
    terminalId,
  };
}

async function startPendingWrite(terminalId: string) {
  const recorder = recordingSend();
  const lease = acquireTerminalInputQueue(target(terminalId));
  const pending = lease.queue.write("x".repeat(70_000), recorder.send);
  await waitForSent(recorder.sent, 1);
  return { recorder, lease, pending };
}

describe("terminal command input invalidation", () => {
  const atoms = createTerminalEnvironmentAtoms({} as never);
  const registry = AtomRegistry.make();

  it("pauses the target queue while the real close RPC settles", async () => {
    const { recorder, lease, pending } = await startPendingWrite("term-close");

    await atoms.close.run(registry, {
      environmentId: target("term-close").environmentId,
      input: {
        threadId: target("term-close").threadId,
        terminalId: "term-close",
      },
    });

    expect(lease.isDisposed()).toBe(false);
    expect(lease.queue.isPaused()).toBe(true);
    recorder.acknowledgements[0]?.resolve(SUCCESS);
    lease.queue.dispose();
    expect(await pending).toBeUndefined();
    expect(recorder.sent).toHaveLength(1);
    lease.release();
  });

  it("pauses the target queue while the real restart RPC settles", async () => {
    const { recorder, lease, pending } = await startPendingWrite("term-restart");

    await atoms.restart.run(registry, {
      environmentId: target("term-restart").environmentId,
      input: {
        threadId: target("term-restart").threadId,
        terminalId: "term-restart",
        cwd: "/repo",
        cols: 80,
        rows: 24,
      },
    });

    expect(lease.isDisposed()).toBe(false);
    expect(lease.queue.isPaused()).toBe(true);
    recorder.acknowledgements[0]?.resolve(SUCCESS);
    lease.queue.dispose();
    expect(await pending).toBeUndefined();
    expect(recorder.sent).toHaveLength(1);
    lease.release();
  });
});

function terminalSummary(
  summaryTarget: TerminalInputTarget,
  status: TerminalSummary["status"],
  pid: number | null = status === "running" ? 123 : null,
): TerminalSummary {
  return {
    threadId: summaryTarget.threadId,
    terminalId: summaryTarget.terminalId,
    cwd: "/repo",
    worktreePath: null,
    status,
    pid,
    exitCode: status === "exited" ? 0 : null,
    exitSignal: null,
    hasRunningSubprocess: false,
    label: summaryTarget.terminalId,
    updatedAt: "2026-10-22T00:00:00.000Z",
  };
}

function snapshotEvent(...terminals: TerminalSummary[]): TerminalMetadataStreamEvent {
  return { type: "snapshot", terminals };
}

function upsertEvent(terminal: TerminalSummary): TerminalMetadataStreamEvent {
  return { type: "upsert", terminal };
}

function removeEvent(eventTarget: TerminalInputTarget): TerminalMetadataStreamEvent {
  return {
    type: "remove",
    threadId: eventTarget.threadId,
    terminalId: eventTarget.terminalId,
  };
}

describe("terminal metadata stream invalidation", () => {
  effectIt.effect("disposes a retained queue when metadata removes its target", () =>
    Effect.gen(function* () {
      const leaseTarget = target("term-metadata-archive");
      const lease = acquireTerminalInputQueue(leaseTarget);
      const stream = projectTerminalMetadata(
        leaseTarget.environmentId,
        Stream.make(
          snapshotEvent(terminalSummary(leaseTarget, "running")),
          removeEvent(leaseTarget),
        ),
      );

      yield* Stream.runDrain(stream);

      expect(lease.isDisposed()).toBe(true);
      lease.release();
    }),
  );

  effectIt.effect("disposes a retained queue when metadata reports exit", () =>
    Effect.gen(function* () {
      const leaseTarget = target("term-metadata-exit");
      const lease = acquireTerminalInputQueue(leaseTarget);
      const stream = projectTerminalMetadata(
        leaseTarget.environmentId,
        Stream.make(
          snapshotEvent(terminalSummary(leaseTarget, "running")),
          upsertEvent(terminalSummary(leaseTarget, "exited")),
        ),
      );

      yield* Stream.runDrain(stream);

      expect(lease.isDisposed()).toBe(true);
      lease.release();
    }),
  );

  effectIt.effect("keeps every chunk when a resubscribe reports the same live session", () =>
    Effect.gen(function* () {
      const leaseTarget = target("term-metadata-resubscribe");
      const lease = acquireTerminalInputQueue(leaseTarget);
      const recorder = recordingSend();
      const paste = "x".repeat(70_000);
      const pending = lease.queue.write(paste, recorder.send);
      yield* Effect.promise(() => waitForSent(recorder.sent, 1));

      // A reconnect re-sends the full snapshot for the same running session.
      yield* Stream.runDrain(
        projectTerminalMetadata(
          leaseTarget.environmentId,
          Stream.make(
            snapshotEvent(terminalSummary(leaseTarget, "running", 123)),
            snapshotEvent(terminalSummary(leaseTarget, "running", 123)),
          ),
        ),
      );

      expect(lease.isDisposed()).toBe(false);
      recorder.acknowledgements[0]?.resolve(SUCCESS);
      yield* Effect.promise(() => waitForSent(recorder.sent, 2));
      recorder.acknowledgements[1]?.resolve(SUCCESS);
      yield* Effect.promise(() => waitForSent(recorder.sent, 3));
      recorder.acknowledgements[2]?.resolve(SUCCESS);

      const result = yield* Effect.promise(() => pending);
      expect(result?._tag).toBe("Success");
      expect(recorder.sent.join("")).toBe(paste);
      lease.release();
    }),
  );

  effectIt.effect("keeps a remounted queue on the newer session generation", () =>
    Effect.gen(function* () {
      const leaseTarget = target("term-metadata-generation");
      const lease = acquireTerminalInputQueue(leaseTarget);
      const firstProjection = yield* Stream.runCollect(
        projectTerminalMetadata(
          leaseTarget.environmentId,
          Stream.make(
            snapshotEvent(terminalSummary(leaseTarget, "running", 123)),
            snapshotEvent(terminalSummary(leaseTarget, "running", 456)),
          ),
        ),
      );
      expect(firstProjection.at(-1)?.[0]?.pid).toBe(456);
      expect(lease.isDisposed()).toBe(true);

      const remounted = acquireTerminalInputQueue(leaseTarget);
      const secondProjection = yield* Stream.runCollect(
        projectTerminalMetadata(
          leaseTarget.environmentId,
          Stream.make(
            snapshotEvent(terminalSummary(leaseTarget, "running", 456)),
            snapshotEvent(terminalSummary(leaseTarget, "running", 456)),
          ),
        ),
      );
      expect(secondProjection.at(-1)?.[0]?.pid).toBe(456);
      expect(remounted.isDisposed()).toBe(false);

      const result = yield* Effect.promise(() => remounted.queue.write("ok", async () => SUCCESS));
      expect(result?._tag).toBe("Success");
      remounted.release();
    }),
  );
});
