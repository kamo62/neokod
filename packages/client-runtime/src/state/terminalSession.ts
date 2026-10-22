import {
  TERMINAL_WRITE_MAX_LENGTH,
  type EnvironmentId,
  type TerminalAttachStreamEvent,
  type TerminalMetadataStreamEvent,
  type TerminalSessionSnapshot,
  type TerminalSummary,
  type ThreadId,
} from "@neokod/contracts";

export interface TerminalSessionState {
  readonly summary: TerminalSummary | null;
  readonly buffer: string;
  readonly status: TerminalSessionSnapshot["status"] | "closed";
  readonly error: string | null;
  readonly hasRunningSubprocess: boolean;
  readonly updatedAt: string | null;
  readonly version: number;
}

export interface TerminalBufferState {
  readonly buffer: string;
  readonly status: TerminalSessionSnapshot["status"] | "closed";
  readonly error: string | null;
  readonly updatedAt: string | null;
  readonly version: number;
}

export interface KnownTerminalSessionTarget {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly terminalId: string;
}

export interface KnownTerminalSession {
  readonly target: KnownTerminalSessionTarget;
  readonly state: TerminalSessionState;
}

export function selectRunningSubprocessTerminalIds(
  sessions: ReadonlyArray<KnownTerminalSession>,
): ReadonlyArray<string> {
  return sessions
    .filter((session) => session.state.hasRunningSubprocess)
    .map((session) => session.target.terminalId);
}

export const EMPTY_TERMINAL_BUFFER_STATE = Object.freeze<TerminalBufferState>({
  buffer: "",
  status: "closed",
  error: null,
  updatedAt: null,
  version: 0,
});

export const EMPTY_TERMINAL_SESSION_STATE = Object.freeze<TerminalSessionState>({
  summary: null,
  buffer: "",
  status: "closed",
  error: null,
  hasRunningSubprocess: false,
  updatedAt: null,
  version: 0,
});

export const DEFAULT_MAX_TERMINAL_BUFFER_BYTES = 512 * 1024;
const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

function trimBufferToBytes(buffer: string, maxBufferBytes: number): string {
  if (maxBufferBytes <= 0) {
    return "";
  }

  const encoded = textEncoder.encode(buffer);
  if (encoded.byteLength <= maxBufferBytes) {
    return buffer;
  }

  let start = encoded.byteLength - maxBufferBytes;
  while (start < encoded.length) {
    const byte = encoded[start];
    if (byte === undefined || (byte & 0b1100_0000) !== 0b1000_0000) {
      break;
    }
    start += 1;
  }

  return textDecoder.decode(encoded.subarray(start));
}

export function terminalBufferStateFromSnapshot(
  snapshot: TerminalSessionSnapshot,
  maxBufferBytes: number,
): TerminalBufferState {
  return {
    buffer: trimBufferToBytes(snapshot.history, maxBufferBytes),
    status: snapshot.status,
    error: null,
    updatedAt: snapshot.updatedAt,
    version: 1,
  };
}

function latestTimestamp(left: string | null, right: string | null): string | null {
  if (left === null) return right;
  if (right === null) return left;
  return Date.parse(left) >= Date.parse(right) ? left : right;
}

export function combineTerminalSessionState(
  summary: TerminalSummary | null,
  buffer: TerminalBufferState,
): TerminalSessionState {
  return {
    summary,
    buffer: buffer.buffer,
    status: buffer.version > 0 ? buffer.status : (summary?.status ?? buffer.status),
    error: buffer.error,
    hasRunningSubprocess: summary?.hasRunningSubprocess ?? false,
    updatedAt: latestTimestamp(summary?.updatedAt ?? null, buffer.updatedAt),
    version: buffer.version,
  };
}

export function applyTerminalAttachStreamEvent(
  current: TerminalBufferState,
  event: TerminalAttachStreamEvent,
  maxBufferBytes = DEFAULT_MAX_TERMINAL_BUFFER_BYTES,
): TerminalBufferState {
  switch (event.type) {
    case "snapshot":
    case "restarted":
      return terminalBufferStateFromSnapshot(event.snapshot, maxBufferBytes);
    case "output":
      return {
        ...current,
        buffer: trimBufferToBytes(`${current.buffer}${event.data}`, maxBufferBytes),
        status: current.status === "closed" ? "running" : current.status,
        error: null,
        version: current.version + 1,
      };
    case "cleared":
      return {
        ...current,
        buffer: "",
        error: null,
        version: current.version + 1,
      };
    case "exited":
      return {
        ...current,
        status: "exited",
        error: null,
        version: current.version + 1,
      };
    case "closed":
      return {
        ...current,
        status: "closed",
        error: null,
        version: current.version + 1,
      };
    case "error":
      return {
        ...current,
        status: "error",
        error: event.message,
        version: current.version + 1,
      };
    case "activity":
      return current;
  }
}

export function applyTerminalMetadataStreamEvent(
  current: ReadonlyArray<TerminalSummary>,
  event: TerminalMetadataStreamEvent,
): ReadonlyArray<TerminalSummary> {
  if (event.type === "snapshot") {
    return event.terminals;
  }
  if (event.type === "remove") {
    return current.filter(
      (terminal) =>
        terminal.threadId !== event.threadId || terminal.terminalId !== event.terminalId,
    );
  }
  const next = current.filter(
    (terminal) =>
      terminal.threadId !== event.terminal.threadId ||
      terminal.terminalId !== event.terminal.terminalId,
  );
  return [...next, event.terminal];
}

/** Half the server limit, so a chunk never sits at the boundary. */
export const TERMINAL_WRITE_CHUNK_LENGTH = TERMINAL_WRITE_MAX_LENGTH / 2;

/**
 * Split input into pieces of at most `maxLength` UTF-16 units without cutting a
 * surrogate pair. The server limit and this splitter both count UTF-16 units.
 */
export function splitTerminalInput(
  data: string,
  maxLength: number = TERMINAL_WRITE_CHUNK_LENGTH,
): ReadonlyArray<string> {
  const size = Number.isFinite(maxLength)
    ? Math.max(2, Math.floor(maxLength))
    : TERMINAL_WRITE_CHUNK_LENGTH;
  if (data.length <= size) return [data];
  const chunks: Array<string> = [];
  let start = 0;
  while (start < data.length) {
    let end = Math.min(start + size, data.length);
    if (end < data.length) {
      const last = data.charCodeAt(end - 1);
      if (last >= 0xd800 && last <= 0xdbff) end -= 1;
    }
    chunks.push(data.slice(start, end));
    start = end;
  }
  return chunks;
}

export interface TerminalInputQueue {
  /**
   * Send one whole write, one chunk at a time. Resolves with the last chunk's
   * result, or `undefined` when the queue was disposed before the write
   * completed. A failed chunk stops that write and is returned to the caller.
   */
  readonly write: <R extends { readonly _tag: string }>(
    data: string,
    send: (chunk: string) => Promise<R>,
  ) => Promise<R | undefined>;
  /**
   * Abandon queued and in-flight chunks for a target that is gone. Later
   * writes on this queue are abandoned too; callers create a queue per target.
   */
  readonly dispose: () => void;
}

/**
 * Whole writes run one after another, and the chunks of one write run one
 * after another. Each chunk waits for the server to acknowledge the previous
 * one (backpressure), a keystroke typed during a paste lands after the paste,
 * and the first failed chunk stops the rest of that write. Every chunk of a
 * write goes to the `send` captured when that write started, so a write never
 * spills into a replacement thread, session or terminal.
 */
export function createTerminalInputQueue(): TerminalInputQueue {
  let tail: Promise<unknown> = Promise.resolve();
  let disposed = false;
  return {
    dispose: () => {
      disposed = true;
    },
    write: <R extends { readonly _tag: string }>(
      data: string,
      send: (chunk: string) => Promise<R>,
    ): Promise<R | undefined> => {
      const run = async (): Promise<R | undefined> => {
        if (disposed) return undefined;
        let result: R | undefined;
        for (const chunk of splitTerminalInput(data)) {
          if (disposed) return undefined;
          result = await send(chunk);
          if (result._tag !== "Success") return result;
        }
        return result;
      };
      const next = tail.then(run, run);
      tail = next.catch(() => undefined);
      return next;
    },
  };
}

export interface TerminalInputTarget {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly terminalId: string;
}

export interface TerminalInputLease {
  readonly queue: TerminalInputQueue;
  /**
   * Stop this viewport holding the target's queue. Pending chunks keep going,
   * so unmounting a viewport does not truncate an accepted paste.
   */
  readonly release: () => void;
}

interface TerminalInputQueueEntry {
  queue: TerminalInputQueue;
  mounts: number;
  pendingWrites: number;
}

/**
 * Queues survive viewport remounts (switching terminal tabs) because they belong
 * to the live terminal target, not to a React component. An entry is dropped
 * once no viewport holds it and its last write settles.
 */
const terminalInputQueues = new Map<string, TerminalInputQueueEntry>();

function terminalInputTargetKey(target: TerminalInputTarget): string {
  return JSON.stringify([target.environmentId, target.threadId, target.terminalId]);
}

function removeIdleTerminalInputQueue(key: string, entry: TerminalInputQueueEntry): void {
  if (entry.mounts === 0 && entry.pendingWrites === 0 && terminalInputQueues.get(key) === entry) {
    terminalInputQueues.delete(key);
  }
}

function createTerminalInputQueueEntry(key: string): TerminalInputQueueEntry {
  const rawQueue = createTerminalInputQueue();
  const entry: TerminalInputQueueEntry = {
    queue: rawQueue,
    mounts: 0,
    pendingWrites: 0,
  };
  entry.queue = {
    write: (data, send) => {
      entry.pendingWrites += 1;
      return rawQueue.write(data, send).finally(() => {
        entry.pendingWrites -= 1;
        removeIdleTerminalInputQueue(key, entry);
      });
    },
    dispose: () => {
      rawQueue.dispose();
      if (terminalInputQueues.get(key) === entry) terminalInputQueues.delete(key);
    },
  };
  return entry;
}

export function acquireTerminalInputQueue(target: TerminalInputTarget): TerminalInputLease {
  const key = terminalInputTargetKey(target);
  let entry = terminalInputQueues.get(key);
  if (entry === undefined) {
    entry = createTerminalInputQueueEntry(key);
    terminalInputQueues.set(key, entry);
  }
  entry.mounts += 1;
  let released = false;
  return {
    queue: entry.queue,
    release: () => {
      if (released) return;
      released = true;
      entry.mounts -= 1;
      removeIdleTerminalInputQueue(key, entry);
    },
  };
}

/** Close the target's queue: queued chunks are abandoned and a restart starts clean. */
export function disposeTerminalInputQueue(target: TerminalInputTarget): void {
  terminalInputQueues.get(terminalInputTargetKey(target))?.queue.dispose();
}
