import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { ProjectWriteFileError } from "@neokod/contracts";
import type { AtomCommandResult } from "@neokod/client-runtime/state/runtime";
import * as Cause from "effect/Cause";
import { AsyncResult } from "effect/unstable/reactivity";

import { FileSaveBaseline, FileSaveCoordinator, isFileChangedOnDisk } from "./fileSaveCoordinator";

function deferred<A = void, E = never>() {
  let resolve!: (result: AtomCommandResult<A, E>) => void;
  const promise = new Promise<AtomCommandResult<A, E>>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

describe("isFileChangedOnDisk", () => {
  it("recognises the typed file-changed-on-disk write failure", () => {
    const conflict = new ProjectWriteFileError({
      cwd: "/repo",
      relativePath: "notes.md",
      failure: "file_changed_on_disk",
      resolvedPath: "/repo/notes.md",
    });

    expect(isFileChangedOnDisk(AsyncResult.failure(Cause.fail(conflict)))).toBe(true);
    expect(isFileChangedOnDisk(AsyncResult.failure(Cause.fail(new Error("other"))))).toBe(false);
    expect(isFileChangedOnDisk(AsyncResult.success(undefined))).toBe(false);
  });
});

describe("FileSaveCoordinator", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("debounces edits and persists only the latest contents", async () => {
    vi.useFakeTimers();
    const persist = vi
      .fn<(contents: string) => Promise<AtomCommandResult<void, never>>>()
      .mockResolvedValue(AsyncResult.success(undefined));
    const onPendingChange = vi.fn();
    const onConfirmed = vi.fn();
    const coordinator = new FileSaveCoordinator({
      debounceMs: 500,
      persist,
      onPendingChange,
      onConfirmed,
    });

    coordinator.change("first");
    await vi.advanceTimersByTimeAsync(300);
    coordinator.change("latest");
    await vi.advanceTimersByTimeAsync(499);
    expect(persist).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    expect(persist).toHaveBeenCalledOnce();
    expect(persist).toHaveBeenCalledWith("latest");
    expect(onConfirmed).toHaveBeenCalledWith("latest");
    expect(onPendingChange.mock.calls).toEqual([[true], [true], [false]]);
  });

  it("keeps pending state until an edit made during a write is also saved", async () => {
    vi.useFakeTimers();
    const firstWrite = deferred();
    const persist = vi
      .fn<(contents: string) => Promise<AtomCommandResult<void, never>>>()
      .mockReturnValueOnce(firstWrite.promise)
      .mockResolvedValueOnce(AsyncResult.success(undefined));
    const onPendingChange = vi.fn();
    const coordinator = new FileSaveCoordinator({
      debounceMs: 500,
      persist,
      onPendingChange,
      onConfirmed: vi.fn(),
    });

    coordinator.change("first");
    await vi.advanceTimersByTimeAsync(500);
    coordinator.change("latest");
    await vi.advanceTimersByTimeAsync(500);
    expect(persist).toHaveBeenCalledTimes(1);

    firstWrite.resolve(AsyncResult.success(undefined));
    await vi.runAllTimersAsync();
    expect(persist).toHaveBeenCalledTimes(2);
    expect(persist).toHaveBeenLastCalledWith("latest");
    expect(onPendingChange.mock.calls.at(-1)).toEqual([false]);
  });

  it("leaves the file pending when the latest write fails", async () => {
    vi.useFakeTimers();
    const onPendingChange = vi.fn();
    const coordinator = new FileSaveCoordinator({
      debounceMs: 500,
      persist: vi
        .fn()
        .mockResolvedValue(AsyncResult.failure(Cause.fail(new Error("write failed")))),
      onPendingChange,
      onConfirmed: vi.fn(),
    });

    coordinator.change("latest");
    await vi.advanceTimersByTimeAsync(500);
    await Promise.resolve();
    expect(onPendingChange).toHaveBeenCalledWith(true);
    expect(onPendingChange).not.toHaveBeenCalledWith(false);
  });

  it("ignores edits when canWrite is false", async () => {
    vi.useFakeTimers();
    const persist = vi.fn().mockResolvedValue(AsyncResult.success(undefined));
    const onPendingChange = vi.fn();
    const coordinator = new FileSaveCoordinator({
      debounceMs: 500,
      persist,
      onPendingChange,
      onConfirmed: vi.fn(),
      canWrite: () => false,
    });

    coordinator.change("x");
    await vi.advanceTimersByTimeAsync(500);

    expect(persist).not.toHaveBeenCalled();
    expect(onPendingChange).not.toHaveBeenCalled();
  });

  it("stops saving and reports a conflict until it is resolved", async () => {
    vi.useFakeTimers();
    const conflict = AsyncResult.failure(Cause.fail(new Error("file changed on disk")));
    const persist = vi
      .fn()
      .mockResolvedValueOnce(conflict)
      .mockResolvedValue(AsyncResult.success(undefined));
    const onPendingChange = vi.fn();
    const onConflict = vi.fn();
    const coordinator = new FileSaveCoordinator({
      debounceMs: 500,
      persist,
      onPendingChange,
      onConfirmed: vi.fn(),
      onConflict,
      isConflict: (result) => result._tag === "Failure",
    });

    coordinator.change("a");
    await vi.advanceTimersByTimeAsync(500);
    expect(persist).toHaveBeenCalledOnce();
    expect(onConflict).toHaveBeenCalledOnce();
    expect(onPendingChange).not.toHaveBeenCalledWith(false);

    coordinator.change("b");
    await vi.advanceTimersByTimeAsync(500);
    expect(persist).toHaveBeenCalledOnce();

    coordinator.dispose();
    await vi.runAllTimersAsync();
    expect(persist).toHaveBeenCalledOnce();

    coordinator.resolveConflict();
    coordinator.change("c");
    await vi.advanceTimersByTimeAsync(500);
    expect(persist).toHaveBeenCalledTimes(2);
    expect(persist).toHaveBeenLastCalledWith("c");
  });

  it("does not retry an edit made during a conflicting write", async () => {
    vi.useFakeTimers();
    const firstWrite = deferred<void, Error>();
    const persist = vi
      .fn()
      .mockReturnValueOnce(firstWrite.promise)
      .mockResolvedValue(AsyncResult.success(undefined));
    const onConflict = vi.fn();
    const coordinator = new FileSaveCoordinator({
      debounceMs: 500,
      persist,
      onPendingChange: vi.fn(),
      onConfirmed: vi.fn(),
      onConflict,
      isConflict: (result) => result._tag === "Failure",
    });

    coordinator.change("a");
    await vi.advanceTimersByTimeAsync(500);
    coordinator.change("b");
    firstWrite.resolve(AsyncResult.failure(Cause.fail(new Error("changed on disk"))));
    await vi.runAllTimersAsync();

    expect(onConflict).toHaveBeenCalledOnce();
    expect(persist).toHaveBeenCalledOnce();

    coordinator.dispose();
    await vi.runAllTimersAsync();
    expect(persist).toHaveBeenCalledOnce();
  });

  it("carries a confirmed local hash across a deferred save and surface remount", async () => {
    vi.useFakeTimers();
    const baseline = new FileSaveBaseline("hash-from-read");
    const firstWrite = deferred<{ contentHash: string }, never>();
    const write = vi.fn((input: { contents: string; expectedHash: string | undefined }) =>
      input.contents === "first"
        ? firstWrite.promise
        : Promise.resolve(AsyncResult.success({ contentHash: "hash-after-second" })),
    );
    const persist = (contents: string) =>
      baseline.persist(contents, {
        write,
        confirmedHash: (value) => value.contentHash,
      });
    const firstSurface = new FileSaveCoordinator({
      debounceMs: 500,
      persist,
      onPendingChange: vi.fn(),
      onConfirmed: vi.fn(),
    });

    firstSurface.change("first");
    await vi.advanceTimersByTimeAsync(500);
    expect(write).toHaveBeenCalledWith({ contents: "first", expectedHash: "hash-from-read" });

    // The editor surface remounts while the first write is still in flight. The
    // remounted surface keeps the panel baseline instead of a stale ref.
    const remountedSurface = new FileSaveCoordinator({
      debounceMs: 500,
      persist,
      onPendingChange: vi.fn(),
      onConfirmed: vi.fn(),
    });
    firstWrite.resolve(AsyncResult.success({ contentHash: "hash-after-first" }));
    await Promise.resolve();

    expect(baseline.expectedHash).toBe("hash-after-first");
    // A read that observes an external write must not replace the acknowledged
    // local baseline; the next save has to conflict instead of overwriting it.
    baseline.adoptInitialHash("hash-from-external-write");
    expect(baseline.expectedHash).toBe("hash-after-first");

    remountedSurface.change("second");
    await vi.advanceTimersByTimeAsync(500);
    expect(write).toHaveBeenLastCalledWith({
      contents: "second",
      expectedHash: "hash-after-first",
    });
  });

  it("keeps an explicit overwrite unconditional when the panel rerenders", async () => {
    vi.useFakeTimers();
    const baseline = new FileSaveBaseline("hash-from-read");
    const write = vi
      .fn<
        (input: {
          contents: string;
          expectedHash: string | undefined;
        }) => Promise<AtomCommandResult<{ contentHash: string }, never>>
      >()
      .mockResolvedValueOnce(AsyncResult.success({ contentHash: "hash-after-overwrite" }))
      .mockResolvedValueOnce(AsyncResult.success({ contentHash: "hash-after-next-write" }));
    const onConfirmedHash = vi.fn();
    const persist = (contents: string) =>
      baseline.persist(contents, {
        write,
        confirmedHash: (value) => value.contentHash,
        onConfirmedHash,
      });
    const coordinator = new FileSaveCoordinator({
      debounceMs: 500,
      persist,
      onPendingChange: vi.fn(),
      onConfirmed: vi.fn(),
    });

    // Overwrite drops the precondition, then clearing the conflict banner
    // rerenders the panel while the file query still holds the stale read hash.
    baseline.clear();
    baseline.adoptInitialHash("hash-from-read");
    coordinator.change("overwritten");
    await vi.advanceTimersByTimeAsync(500);

    expect(write).toHaveBeenCalledWith({ contents: "overwritten", expectedHash: undefined });
    expect(onConfirmedHash).toHaveBeenCalledWith("hash-after-overwrite");

    coordinator.change("next");
    await vi.advanceTimersByTimeAsync(500);
    expect(write).toHaveBeenLastCalledWith({
      contents: "next",
      expectedHash: "hash-after-overwrite",
    });
  });

  it("does not rewrite a saved buffer on dispose", async () => {
    vi.useFakeTimers();
    const persist = vi.fn().mockResolvedValue(AsyncResult.success(undefined));
    const coordinator = new FileSaveCoordinator({
      debounceMs: 500,
      persist,
      onPendingChange: vi.fn(),
      onConfirmed: vi.fn(),
    });

    coordinator.change("a");
    await vi.advanceTimersByTimeAsync(500);
    expect(persist).toHaveBeenCalledOnce();

    coordinator.dispose();
    await vi.runAllTimersAsync();

    expect(persist).toHaveBeenCalledOnce();
  });

  it("flushes an unsaved edit on dispose", async () => {
    vi.useFakeTimers();
    const persist = vi.fn().mockResolvedValue(AsyncResult.success(undefined));
    const coordinator = new FileSaveCoordinator({
      debounceMs: 500,
      persist,
      onPendingChange: vi.fn(),
      onConfirmed: vi.fn(),
    });

    coordinator.change("a");
    coordinator.dispose();
    await vi.runAllTimersAsync();

    expect(persist).toHaveBeenCalledOnce();
    expect(persist).toHaveBeenCalledWith("a");
  });

  it("flushes again on dispose after a failed save", async () => {
    vi.useFakeTimers();
    const persist = vi
      .fn()
      .mockResolvedValueOnce(AsyncResult.failure(Cause.fail(new Error("write failed"))))
      .mockResolvedValueOnce(AsyncResult.success(undefined));
    const coordinator = new FileSaveCoordinator({
      debounceMs: 500,
      persist,
      onPendingChange: vi.fn(),
      onConfirmed: vi.fn(),
    });

    coordinator.change("a");
    await vi.advanceTimersByTimeAsync(500);
    expect(persist).toHaveBeenCalledOnce();

    coordinator.dispose();
    await vi.runAllTimersAsync();

    expect(persist).toHaveBeenCalledTimes(2);
  });

  it("flushes only the edit made after the last confirmed save", async () => {
    vi.useFakeTimers();
    const persist = vi.fn().mockResolvedValue(AsyncResult.success(undefined));
    const coordinator = new FileSaveCoordinator({
      debounceMs: 500,
      persist,
      onPendingChange: vi.fn(),
      onConfirmed: vi.fn(),
    });

    coordinator.change("a");
    await vi.advanceTimersByTimeAsync(500);
    coordinator.change("b");
    coordinator.dispose();
    await vi.runAllTimersAsync();

    expect(persist.mock.calls.map(([contents]) => contents)).toEqual(["a", "b"]);
  });
});
