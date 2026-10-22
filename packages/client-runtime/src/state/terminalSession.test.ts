import { describe, expect, it } from "vite-plus/test";

import {
  EnvironmentId,
  TerminalSessionSnapshot,
  ThreadId,
  TERMINAL_WRITE_MAX_LENGTH,
  type TerminalSummary,
} from "@neokod/contracts";

import {
  acquireTerminalInputQueue,
  applyTerminalAttachStreamEvent,
  applyTerminalMetadataStreamEvent,
  combineTerminalSessionState,
  createTerminalInputQueue,
  createTerminalMetadataInputInvalidator,
  disposeTerminalInputQueue,
  EMPTY_TERMINAL_BUFFER_STATE,
  selectRunningSubprocessTerminalIds,
  splitTerminalInput,
  TERMINAL_WRITE_CHUNK_LENGTH,
  withTerminalInputInvalidation,
  type TerminalInputCommandTarget,
} from "./terminalSession.ts";

const TARGET = {
  environmentId: EnvironmentId.make("env-local"),
  threadId: ThreadId.make("thread-1"),
  terminalId: "term-1",
} as const;

const TARGET_A = {
  environmentId: TARGET.environmentId,
  threadId: TARGET.threadId,
  terminalId: TARGET.terminalId,
};
const TARGET_B = { ...TARGET_A, terminalId: "term-2" };

const BASE_SNAPSHOT: TerminalSessionSnapshot = {
  threadId: TARGET.threadId,
  terminalId: TARGET.terminalId,
  cwd: "/repo",
  worktreePath: null,
  status: "running",
  pid: 123,
  history: "hello",
  exitCode: null,
  exitSignal: null,
  label: "Terminal 1",
  updatedAt: "2026-04-01T00:00:00.000Z",
};

describe("terminal session reducers", () => {
  it("prefers live attach status over stale metadata after the attach stream starts", () => {
    const summary = applyTerminalMetadataStreamEvent([], {
      type: "snapshot",
      terminals: [
        {
          threadId: BASE_SNAPSHOT.threadId,
          terminalId: BASE_SNAPSHOT.terminalId,
          cwd: BASE_SNAPSHOT.cwd,
          worktreePath: BASE_SNAPSHOT.worktreePath,
          status: "running",
          pid: BASE_SNAPSHOT.pid,
          exitCode: BASE_SNAPSHOT.exitCode,
          exitSignal: BASE_SNAPSHOT.exitSignal,
          updatedAt: BASE_SNAPSHOT.updatedAt,
          hasRunningSubprocess: false,
          label: BASE_SNAPSHOT.label,
        },
      ],
    })[0]!;
    const attached = applyTerminalAttachStreamEvent(EMPTY_TERMINAL_BUFFER_STATE, {
      type: "error",
      threadId: TARGET.threadId,
      terminalId: TARGET.terminalId,
      message: "Terminal disconnected.",
    });

    expect(combineTerminalSessionState(summary, attached)).toMatchObject({
      status: "error",
      error: "Terminal disconnected.",
      version: 1,
    });
  });

  it("uses metadata status before an attach stream has emitted", () => {
    const summary = applyTerminalMetadataStreamEvent([], {
      type: "snapshot",
      terminals: [
        {
          threadId: BASE_SNAPSHOT.threadId,
          terminalId: BASE_SNAPSHOT.terminalId,
          cwd: BASE_SNAPSHOT.cwd,
          worktreePath: BASE_SNAPSHOT.worktreePath,
          status: "running",
          pid: BASE_SNAPSHOT.pid,
          exitCode: BASE_SNAPSHOT.exitCode,
          exitSignal: BASE_SNAPSHOT.exitSignal,
          updatedAt: BASE_SNAPSHOT.updatedAt,
          hasRunningSubprocess: false,
          label: BASE_SNAPSHOT.label,
        },
      ],
    })[0]!;

    expect(combineTerminalSessionState(summary, EMPTY_TERMINAL_BUFFER_STATE).status).toBe(
      "running",
    );
  });

  it("does not treat an idle running shell as a running subprocess", () => {
    const idleSession = {
      target: TARGET,
      state: {
        ...combineTerminalSessionState(null, EMPTY_TERMINAL_BUFFER_STATE),
        status: "running" as const,
        hasRunningSubprocess: false,
      },
    };
    const activeSession = {
      target: { ...TARGET, terminalId: "term-2" },
      state: {
        ...idleSession.state,
        hasRunningSubprocess: true,
      },
    };

    expect(selectRunningSubprocessTerminalIds([idleSession, activeSession])).toEqual(["term-2"]);
  });

  it("reduces attach snapshots and output without an imperative session manager", () => {
    const snapshot = applyTerminalAttachStreamEvent(EMPTY_TERMINAL_BUFFER_STATE, {
      type: "snapshot",
      snapshot: BASE_SNAPSHOT,
    });
    const output = applyTerminalAttachStreamEvent(
      snapshot,
      {
        type: "output",
        threadId: TARGET.threadId,
        terminalId: TARGET.terminalId,
        data: " world",
      },
      8,
    );

    expect(output).toMatchObject({
      buffer: "lo world",
      status: "running",
      error: null,
      version: 2,
    });
  });

  it("reduces terminal metadata snapshots, upserts, and removals", () => {
    const initial = applyTerminalMetadataStreamEvent([], {
      type: "snapshot",
      terminals: [
        {
          threadId: BASE_SNAPSHOT.threadId,
          terminalId: BASE_SNAPSHOT.terminalId,
          cwd: BASE_SNAPSHOT.cwd,
          worktreePath: BASE_SNAPSHOT.worktreePath,
          status: BASE_SNAPSHOT.status,
          pid: BASE_SNAPSHOT.pid,
          exitCode: BASE_SNAPSHOT.exitCode,
          exitSignal: BASE_SNAPSHOT.exitSignal,
          updatedAt: BASE_SNAPSHOT.updatedAt,
          hasRunningSubprocess: false,
          label: BASE_SNAPSHOT.label,
        },
      ],
    });
    const updated = applyTerminalMetadataStreamEvent(initial, {
      type: "upsert",
      terminal: {
        ...initial[0]!,
        hasRunningSubprocess: true,
      },
    });
    const removed = applyTerminalMetadataStreamEvent(updated, {
      type: "remove",
      threadId: TARGET.threadId,
      terminalId: TARGET.terminalId,
    });

    expect(updated).toHaveLength(1);
    expect(updated[0]?.hasRunningSubprocess).toBe(true);
    expect(removed).toEqual([]);
  });

  it("caps retained output by UTF-8 byte length", () => {
    const state = applyTerminalAttachStreamEvent(
      EMPTY_TERMINAL_BUFFER_STATE,
      {
        type: "output",
        threadId: TARGET.threadId,
        terminalId: TARGET.terminalId,
        data: "🙂🙂",
      },
      4,
    );

    expect(state.buffer).toBe("🙂");
  });
});

type WriteResult =
  | { readonly _tag: "Success" }
  | { readonly _tag: "Failure"; readonly reason: string };

const SUCCESS: WriteResult = { _tag: "Success" };

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

async function waitForSent(sent: ReadonlyArray<unknown>, length: number): Promise<void> {
  for (let attempt = 0; attempt < 100 && sent.length < length; attempt += 1) {
    await Promise.resolve();
  }
  expect(sent).toHaveLength(length);
}

describe("terminal input splitting", () => {
  it("keeps the chunk size below the server limit", () => {
    expect(TERMINAL_WRITE_CHUNK_LENGTH).toBeLessThanOrEqual(TERMINAL_WRITE_MAX_LENGTH);
  });

  it("returns short input unchanged", () => {
    expect(splitTerminalInput("echo hi\n")).toEqual(["echo hi\n"]);
  });

  it("keeps every chunk within the limit, the full content and the order", () => {
    const data = Array.from({ length: 100_001 }, (_, i) => String.fromCharCode(97 + (i % 26))).join(
      "",
    );
    const chunks = splitTerminalInput(data);

    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(TERMINAL_WRITE_CHUNK_LENGTH);
    }
    expect(chunks.join("")).toBe(data);
    expect(chunks).toHaveLength(4);
    expect(chunks.map((chunk) => chunk.length)).toEqual([32_768, 32_768, 32_768, 1_697]);
  });

  it("does not cut a surrogate pair", () => {
    expect(splitTerminalInput("ab😀cd", 2)).toEqual(["ab", "😀", "cd"]);

    const boundary = "a".repeat(TERMINAL_WRITE_CHUNK_LENGTH - 1) + "😀" + "b".repeat(10);
    const chunks = splitTerminalInput(boundary);

    expect(chunks.join("")).toBe(boundary);
    expect(chunks[0]).toHaveLength(TERMINAL_WRITE_CHUNK_LENGTH - 1);
    expect(chunks[1]?.startsWith("😀")).toBe(true);
    for (const chunk of chunks) {
      const first = chunk.charCodeAt(0);
      const last = chunk.charCodeAt(chunk.length - 1);
      expect(first >= 0xdc00 && first <= 0xdfff).toBe(false);
      expect(last >= 0xd800 && last <= 0xdbff).toBe(false);
    }
  });

  it("keeps bracketed paste markers and bytes across chunk boundaries", () => {
    const paste = "\u001b[200~" + "z".repeat(TERMINAL_WRITE_CHUNK_LENGTH + 10) + "\u001b[201~";
    const chunks = splitTerminalInput(paste);

    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.join("")).toBe(paste);
    expect(chunks[0]?.startsWith("\u001b[200~")).toBe(true);
    expect(chunks.at(-1)?.endsWith("\u001b[201~")).toBe(true);
  });
});

describe("terminal input queue", () => {
  it("sends chunks of one write in order and waits for every acknowledgement", async () => {
    const queue = createTerminalInputQueue();
    const sent: Array<string> = [];
    const acknowledgements: Array<ReturnType<typeof deferred<WriteResult>>> = [];
    const send = (chunk: string) => {
      sent.push(chunk);
      const acknowledgement = deferred<WriteResult>();
      acknowledgements.push(acknowledgement);
      return acknowledgement.promise;
    };
    const data = "x".repeat(70_000);

    const done = queue.write(data, send);

    await waitForSent(sent, 1);
    expect(sent).toHaveLength(1);
    acknowledgements[0]?.resolve(SUCCESS);

    await waitForSent(sent, 2);
    expect(sent).toHaveLength(2);
    acknowledgements[1]?.resolve(SUCCESS);

    await waitForSent(sent, 3);
    expect(sent).toHaveLength(3);
    acknowledgements[2]?.resolve(SUCCESS);

    expect((await done)?._tag).toBe("Success");
    expect(sent.map((chunk) => chunk.length)).toEqual([32_768, 32_768, 4_464]);
    expect(sent.join("")).toBe(data);
  });

  it("keeps a whole write contiguous when a keystroke arrives during a paste", async () => {
    const queue = createTerminalInputQueue();
    const sent: Array<string> = [];
    const acknowledgements: Array<ReturnType<typeof deferred<WriteResult>>> = [];
    const send = (chunk: string) => {
      sent.push(chunk);
      const acknowledgement = deferred<WriteResult>();
      acknowledgements.push(acknowledgement);
      return acknowledgement.promise;
    };

    const paste = queue.write("A".repeat(40_000), send);
    const keystroke = queue.write("k", send);

    await waitForSent(sent, 1);
    expect(sent).toEqual(["A".repeat(32_768)]);

    acknowledgements[0]?.resolve(SUCCESS);
    await waitForSent(sent, 2);
    expect(sent[1]).toBe("A".repeat(7_232));

    acknowledgements[1]?.resolve(SUCCESS);
    await waitForSent(sent, 3);
    expect(sent[2]).toBe("k");

    acknowledgements[2]?.resolve(SUCCESS);
    expect((await paste)?._tag).toBe("Success");
    expect((await keystroke)?._tag).toBe("Success");
  });

  it("stops at the first failed chunk and lets a later write proceed", async () => {
    const queue = createTerminalInputQueue();
    const sent: Array<string> = [];
    const failure: WriteResult = { _tag: "Failure", reason: "write failed" };
    let calls = 0;
    const send = async (chunk: string): Promise<WriteResult> => {
      sent.push(chunk);
      calls += 1;
      return calls === 2 ? failure : SUCCESS;
    };

    const result = await queue.write("x".repeat(70_000), send);

    expect(result).toBe(failure);
    expect(sent).toHaveLength(2);
    expect(sent[0]).toHaveLength(32_768);

    const later = await queue.write("ok", send);
    expect(later?._tag).toBe("Success");
    expect(sent.at(-1)).toBe("ok");
  });

  it("abandons queued chunks when its target is disposed", async () => {
    const queue = createTerminalInputQueue();
    const sent: Array<string> = [];
    const acknowledgements: Array<ReturnType<typeof deferred<WriteResult>>> = [];
    const send = (chunk: string) => {
      sent.push(chunk);
      const acknowledgement = deferred<WriteResult>();
      acknowledgements.push(acknowledgement);
      return acknowledgement.promise;
    };

    const done = queue.write("x".repeat(70_000), send);
    await waitForSent(sent, 1);

    queue.dispose();
    acknowledgements[0]?.resolve(SUCCESS);

    expect(await done).toBeUndefined();
    expect(sent).toHaveLength(1);

    const later = await queue.write("ok", send);
    expect(later).toBeUndefined();
    expect(sent).toHaveLength(1);
  });
});

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

describe("terminal input queue registry", () => {
  it("keeps a pending paste across a viewport remount and orders later input after it", async () => {
    const recorder = recordingSend();
    const paste = "x".repeat(70_000);
    const first = acquireTerminalInputQueue(TARGET_A);

    const pendingWrite = first.queue.write(paste, recorder.send);
    await waitForSent(recorder.sent, 1);

    // Switch to terminal B: the viewport for A unmounts but its server session keeps running.
    first.release();

    recorder.acknowledgements[0]?.resolve(SUCCESS);
    await waitForSent(recorder.sent, 2);
    expect(recorder.sent[1]).toHaveLength(32_768);

    // Switch back to terminal A while the paste is still pending.
    const second = acquireTerminalInputQueue(TARGET_A);
    expect(second.queue).toBe(first.queue);
    const laterInput = second.queue.write("late", recorder.send);

    recorder.acknowledgements[1]?.resolve(SUCCESS);
    await waitForSent(recorder.sent, 3);
    expect(recorder.sent[2]).toHaveLength(4_464);

    recorder.acknowledgements[2]?.resolve(SUCCESS);
    await waitForSent(recorder.sent, 4);
    expect(recorder.sent[3]).toBe("late");

    recorder.acknowledgements[3]?.resolve(SUCCESS);
    expect((await pendingWrite)?._tag).toBe("Success");
    expect((await laterInput)?._tag).toBe("Success");
    expect(recorder.sent.slice(0, 3).join("")).toBe(paste);
    second.release();
  });

  it("keeps separate queues for separate terminal targets", () => {
    const first = acquireTerminalInputQueue(TARGET_A);
    const second = acquireTerminalInputQueue(TARGET_B);

    expect(first.queue).not.toBe(second.queue);

    first.release();
    second.release();
  });

  it("drops an idle queue once no viewport holds it", async () => {
    const first = acquireTerminalInputQueue(TARGET_A);
    const result = await first.queue.write("ok", async () => SUCCESS);
    expect(result?._tag).toBe("Success");
    first.release();

    const second = acquireTerminalInputQueue(TARGET_A);
    expect(second.queue).not.toBe(first.queue);
    second.release();
  });

  it("abandons a pending write on close and starts clean after a restart", async () => {
    const recorder = recordingSend();
    const first = acquireTerminalInputQueue(TARGET_A);
    const pendingWrite = first.queue.write("x".repeat(70_000), recorder.send);
    await waitForSent(recorder.sent, 1);

    disposeTerminalInputQueue(TARGET_A);
    recorder.acknowledgements[0]?.resolve(SUCCESS);

    expect(await pendingWrite).toBeUndefined();
    expect(recorder.sent).toHaveLength(1);
    first.release();

    const restarted = acquireTerminalInputQueue(TARGET_A);
    expect(restarted.queue).not.toBe(first.queue);
    const later = await restarted.queue.write("ok", async () => SUCCESS);
    expect(later?._tag).toBe("Success");
    restarted.release();
  });

  it("reacquires a fresh live queue after the previous session was invalidated", async () => {
    const first = acquireTerminalInputQueue(TARGET_A);
    disposeTerminalInputQueue(TARGET_A);

    expect(first.isDisposed()).toBe(true);
    first.release();

    const second = acquireTerminalInputQueue(TARGET_A);
    expect(second.queue).not.toBe(first.queue);
    expect(second.isDisposed()).toBe(false);
    const result = await second.queue.write("ok", async () => SUCCESS);
    expect(result?._tag).toBe("Success");
    second.release();
  });
});

describe("terminal input invalidation at command boundaries", () => {
  function fakeCommand(label: string, calls: Array<TerminalInputCommandTarget>) {
    return withTerminalInputInvalidation<TerminalInputCommandTarget, void, never>({
      label,
      run: async (_registry, input) => {
        calls.push(input);
        return { _tag: "Success", value: undefined } as never;
      },
    });
  }

  it("abandons a pending paste before a wrapped close reaches the replacement", async () => {
    const recorder = recordingSend();
    const lease = acquireTerminalInputQueue(TARGET_A);
    const pendingWrite = lease.queue.write("x".repeat(70_000), recorder.send);
    await waitForSent(recorder.sent, 1);

    const calls: Array<TerminalInputCommandTarget> = [];
    await fakeCommand("environment-data:terminal:close", calls).run(undefined as never, {
      environmentId: TARGET_A.environmentId,
      input: { threadId: TARGET_A.threadId, terminalId: TARGET_A.terminalId },
    });

    recorder.acknowledgements[0]?.resolve(SUCCESS);
    expect(await pendingWrite).toBeUndefined();
    expect(recorder.sent).toHaveLength(1);
    expect(calls).toHaveLength(1);
    lease.release();

    const replacement = acquireTerminalInputQueue(TARGET_A);
    expect(replacement.queue).not.toBe(lease.queue);
    replacement.release();
  });

  it("abandons a pending paste before a wrapped restart reaches the replacement", async () => {
    const recorder = recordingSend();
    const lease = acquireTerminalInputQueue(TARGET_B);
    const pendingWrite = lease.queue.write("x".repeat(70_000), recorder.send);
    await waitForSent(recorder.sent, 1);

    const calls: Array<TerminalInputCommandTarget> = [];
    await fakeCommand("environment-data:terminal:restart", calls).run(undefined as never, {
      environmentId: TARGET_B.environmentId,
      input: { threadId: TARGET_B.threadId, terminalId: TARGET_B.terminalId },
    });

    recorder.acknowledgements[0]?.resolve(SUCCESS);
    expect(await pendingWrite).toBeUndefined();
    expect(recorder.sent).toHaveLength(1);
    expect(calls).toHaveLength(1);
    lease.release();
  });

  it("abandons every queue on a thread when close has no terminal id", async () => {
    const firstRecord = recordingSend();
    const secondRecord = recordingSend();
    const firstLease = acquireTerminalInputQueue(TARGET_A);
    const secondLease = acquireTerminalInputQueue(TARGET_B);
    const firstWrite = firstLease.queue.write("x".repeat(70_000), firstRecord.send);
    const secondWrite = secondLease.queue.write("y".repeat(70_000), secondRecord.send);
    await waitForSent(firstRecord.sent, 1);
    await waitForSent(secondRecord.sent, 1);

    const calls: Array<TerminalInputCommandTarget> = [];
    await fakeCommand("environment-data:terminal:close", calls).run(undefined as never, {
      environmentId: TARGET_A.environmentId,
      input: { threadId: TARGET_A.threadId },
    });

    firstRecord.acknowledgements[0]?.resolve(SUCCESS);
    secondRecord.acknowledgements[0]?.resolve(SUCCESS);
    expect(await firstWrite).toBeUndefined();
    expect(await secondWrite).toBeUndefined();
    expect(firstRecord.sent).toHaveLength(1);
    expect(secondRecord.sent).toHaveLength(1);
    firstLease.release();
    secondLease.release();
  });
});

function terminalSummary(terminalId: string, status: TerminalSummary["status"]): TerminalSummary {
  return {
    threadId: TARGET_A.threadId,
    terminalId,
    cwd: "/repo",
    worktreePath: null,
    status,
    pid: status === "running" ? 123 : null,
    exitCode: status === "exited" ? 0 : null,
    exitSignal: null,
    hasRunningSubprocess: false,
    label: terminalId,
    updatedAt: "2026-10-22T00:00:00.000Z",
  };
}

describe("terminal metadata input invalidation", () => {
  it("abandons an offscreen paste when archive removes its terminal", async () => {
    const invalidate = createTerminalMetadataInputInvalidator(TARGET_A.environmentId);
    invalidate([terminalSummary(TARGET_A.terminalId, "running")]);

    const recorder = recordingSend();
    const lease = acquireTerminalInputQueue(TARGET_A);
    const pendingWrite = lease.queue.write("x".repeat(70_000), recorder.send);
    await waitForSent(recorder.sent, 1);

    // The viewport is unmounted, so only server-observed metadata can invalidate.
    lease.release();
    invalidate([]);

    recorder.acknowledgements[0]?.resolve(SUCCESS);
    expect(await pendingWrite).toBeUndefined();
    expect(recorder.sent).toHaveLength(1);
  });

  it("abandons an offscreen paste on exit and remounts on a fresh queue", async () => {
    const invalidate = createTerminalMetadataInputInvalidator(TARGET_A.environmentId);
    invalidate([terminalSummary(TARGET_A.terminalId, "running")]);

    const recorder = recordingSend();
    const lease = acquireTerminalInputQueue(TARGET_A);
    const pendingWrite = lease.queue.write("x".repeat(70_000), recorder.send);
    await waitForSent(recorder.sent, 1);

    lease.release();
    invalidate([terminalSummary(TARGET_A.terminalId, "exited")]);

    recorder.acknowledgements[0]?.resolve(SUCCESS);
    expect(await pendingWrite).toBeUndefined();
    expect(recorder.sent).toHaveLength(1);

    const remounted = acquireTerminalInputQueue(TARGET_A);
    expect(remounted.queue).not.toBe(lease.queue);
    expect(remounted.isDisposed()).toBe(false);
    const later = await remounted.queue.write("ok", async () => SUCCESS);
    expect(later?._tag).toBe("Success");
    remounted.release();
  });

  it("disposes an exited target and a target missing from the next snapshot", () => {
    const invalidate = createTerminalMetadataInputInvalidator(TARGET_A.environmentId);
    invalidate([
      terminalSummary(TARGET_A.terminalId, "running"),
      terminalSummary(TARGET_B.terminalId, "running"),
    ]);

    const firstLease = acquireTerminalInputQueue(TARGET_A);
    const secondLease = acquireTerminalInputQueue(TARGET_B);
    invalidate([terminalSummary(TARGET_B.terminalId, "exited")]);

    expect(firstLease.isDisposed()).toBe(true);
    expect(secondLease.isDisposed()).toBe(true);

    firstLease.release();
    secondLease.release();
  });

  it("keeps a running terminal's queue", () => {
    const invalidate = createTerminalMetadataInputInvalidator(TARGET_A.environmentId);
    invalidate([terminalSummary(TARGET_A.terminalId, "running")]);

    const lease = acquireTerminalInputQueue(TARGET_A);
    invalidate([terminalSummary(TARGET_A.terminalId, "running")]);

    expect(lease.isDisposed()).toBe(false);
    lease.release();
  });
});
