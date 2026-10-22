import { EnvironmentId, ThreadId } from "@neokod/contracts";
import { AtomRegistry } from "effect/unstable/reactivity";
import { describe, expect, it } from "vite-plus/test";

import { createTerminalEnvironmentAtoms } from "./terminal.ts";
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

  it("disposes the target queue from the real close command before the RPC", async () => {
    const { recorder, lease, pending } = await startPendingWrite("term-close");

    await atoms.close.run(registry, {
      environmentId: target("term-close").environmentId,
      input: {
        threadId: target("term-close").threadId,
        terminalId: "term-close",
      },
    });

    expect(lease.isDisposed()).toBe(true);
    recorder.acknowledgements[0]?.resolve(SUCCESS);
    expect(await pending).toBeUndefined();
    expect(recorder.sent).toHaveLength(1);
    lease.release();
  });

  it("disposes the target queue from the real restart command before the RPC", async () => {
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

    expect(lease.isDisposed()).toBe(true);
    recorder.acknowledgements[0]?.resolve(SUCCESS);
    expect(await pending).toBeUndefined();
    expect(recorder.sent).toHaveLength(1);
    lease.release();
  });
});
