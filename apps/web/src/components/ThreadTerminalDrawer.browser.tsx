import "~/index.css";

import { EnvironmentId, ThreadId } from "@neokod/contracts";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { render, type RenderResult } from "vitest-browser-react";

import { TerminalViewport } from "./ThreadTerminalDrawer";

interface PendingWrite {
  data: string;
  resolve: (result: { _tag: "Success"; value: undefined }) => void;
}

const harness = vi.hoisted(() => {
  const writes: Array<PendingWrite> = [];
  const terminals: Array<{ emit: (data: string) => void }> = [];
  let exits = 0;
  const runningSummary = {
    threadId: "thread-terminal-browser",
    terminalId: "term-1",
    cwd: "/tmp",
    worktreePath: null,
    status: "running" as const,
    pid: 123,
    exitCode: null,
    exitSignal: null,
    hasRunningSubprocess: false,
    label: "term-1",
    updatedAt: "2026-10-22T00:00:00.000Z",
  };
  let session = {
    summary: runningSummary,
    buffer: "",
    status: "running" as string,
    error: null as string | null,
    hasRunningSubprocess: false,
    updatedAt: null as string | null,
    version: 1,
  };

  return {
    writes,
    terminals,
    get exits() {
      return exits;
    },
    markExit() {
      exits += 1;
    },
    getSession: () => session,
    setSession(next: { readonly status: string; readonly version: number }) {
      session = { ...session, ...next };
    },
    write(input: { readonly input: { readonly data: string } }) {
      return new Promise<{ _tag: "Success"; value: undefined }>((resolve) => {
        writes.push({ data: input.input.data, resolve });
      });
    },
    resolve(index: number) {
      const write = writes[index];
      if (write === undefined) throw new Error(`No terminal write at index ${index}`);
      write.resolve({ _tag: "Success", value: undefined });
    },
    reset() {
      writes.length = 0;
      terminals.length = 0;
      exits = 0;
      session = {
        summary: runningSummary,
        buffer: "",
        status: "running",
        error: null,
        hasRunningSubprocess: false,
        updatedAt: null,
        version: 1,
      };
    },
  };
});

vi.mock("@effect/atom-react", () => ({
  useAtomValue: () => ({ availableEditors: [] }),
}));

vi.mock("@xterm/addon-fit", () => ({
  FitAddon: class {
    fit() {}
  },
}));

vi.mock("@xterm/xterm", () => {
  class Terminal {
    cols = 80;
    rows = 24;
    options: Record<string, unknown> = {};
    buffer = { active: { viewportY: 0, baseY: 0 } };
    private dataHandler: ((data: string) => void) | undefined;

    constructor() {
      harness.terminals.push({ emit: (data) => this.dataHandler?.(data) });
    }

    loadAddon() {}
    open() {}
    attachCustomKeyEventHandler() {}
    registerLinkProvider() {
      return { dispose() {} };
    }
    onData(handler: (data: string) => void) {
      this.dataHandler = handler;
      return { dispose() {} };
    }
    onSelectionChange() {
      return { dispose() {} };
    }
    write() {}
    dispose() {}
    focus() {}
    clearSelection() {}
    hasSelection() {
      return false;
    }
    getSelection() {
      return "";
    }
    getSelectionPosition() {
      return undefined;
    }
    refresh() {}
    scrollToBottom() {}
  }
  return { Terminal };
});

vi.mock("../state/terminalSessions", () => ({
  useAttachedTerminalSession: () => harness.getSession(),
}));

vi.mock("../state/server", () => ({
  serverEnvironment: { configValueAtom: () => ({}) },
}));

vi.mock("../state/preview", () => ({
  previewEnvironment: { open: {} },
}));

vi.mock("../state/terminal", () => ({
  terminalEnvironment: {
    write: { kind: "write" },
    resize: { kind: "resize" },
  },
}));

vi.mock("../state/use-atom-command", () => ({
  useAtomCommand: (command: { readonly kind?: string }) =>
    command.kind === "write" ? harness.write : async () => ({ _tag: "Success", value: undefined }),
}));

vi.mock("../editorPreferences", () => ({
  useOpenInPreferredEditor: () => async () => ({ _tag: "Success", value: undefined }),
}));

vi.mock("~/localApi", () => ({
  readLocalApi: () => null,
}));

vi.mock("./preview/openTerminalLinkInPreview", () => ({
  openTerminalLinkInPreview: async () => {},
}));

vi.mock("~/components/ui/popover", () => ({
  Popover: () => null,
  PopoverPopup: () => null,
  PopoverTrigger: () => null,
}));

const environmentId = EnvironmentId.make("env-terminal-browser");
const threadId = ThreadId.make("thread-terminal-browser");

function viewport(terminalId: string, version: number) {
  return (
    <div style={{ height: 200, width: 600 }}>
      <TerminalViewport
        threadRef={{ environmentId, threadId }}
        threadId={threadId}
        terminalId={terminalId}
        terminalLabel={`${terminalId}-${version}`}
        cwd="/tmp"
        onSessionExited={() => harness.markExit()}
        onAddTerminalContext={() => {}}
        focusRequestId={0}
        autoFocus={false}
        resizeEpoch={0}
        drawerHeight={200}
        keybindings={[]}
      />
    </div>
  );
}

async function waitForWrites(count: number): Promise<void> {
  await vi.waitFor(() => {
    expect(harness.writes).toHaveLength(count);
  });
}

let screen: RenderResult | undefined;

afterEach(async () => {
  await screen?.unmount();
  screen = undefined;
  document.body.replaceChildren();
  harness.reset();
});

describe("TerminalViewport input lifecycle", () => {
  it("keeps a pending paste across a tab switch and orders later input after it", async () => {
    screen = await render(viewport("term-1", 1));
    expect(harness.terminals).toHaveLength(1);

    const paste = "x".repeat(70_000);
    harness.terminals[0]?.emit(paste);
    await waitForWrites(1);
    expect(harness.writes[0]?.data).toHaveLength(32_768);

    // Switch to terminal B: A's viewport unmounts while its server session runs.
    await screen.rerender(viewport("term-2", 1));
    harness.resolve(0);
    await waitForWrites(2);
    expect(harness.writes[1]?.data).toHaveLength(32_768);

    // Switch back to A while the same paste is still being acknowledged.
    await screen.rerender(viewport("term-1", 1));
    harness.resolve(1);
    await waitForWrites(3);
    expect(harness.writes[2]?.data).toHaveLength(4_464);

    harness.terminals.at(-1)?.emit("late");
    await vi.waitFor(() => {
      expect(harness.writes).toHaveLength(3);
    });
    harness.resolve(2);
    await waitForWrites(4);
    expect(harness.writes[3]?.data).toBe("late");
    harness.resolve(3);

    expect(
      harness.writes
        .slice(0, 3)
        .map((write) => write.data)
        .join(""),
    ).toBe(paste);
  });

  it("keeps a pending paste when the attach query fails but shared metadata is running", async () => {
    screen = await render(viewport("term-1", 1));
    expect(harness.terminals).toHaveLength(1);

    const paste = "x".repeat(70_000);
    harness.terminals[0]?.emit(paste);
    await waitForWrites(1);
    expect(harness.writes[0]?.data).toHaveLength(32_768);

    // The attach subscription fails, but the shared metadata still reports the
    // same running session. Unavailable evidence must not dispose the queue.
    harness.setSession({ status: "error", version: 2 });
    await screen.rerender(viewport("term-1", 2));

    harness.resolve(0);
    await waitForWrites(2);
    expect(harness.writes[1]?.data).toHaveLength(32_768);
    harness.resolve(1);
    await waitForWrites(3);
    harness.resolve(2);

    expect(harness.writes.map((write) => write.data).join("")).toBe(paste);
  });

  it("starts a fresh queue when an exited session restarts in the same viewport", async () => {
    screen = await render(viewport("term-1", 1));
    expect(harness.terminals).toHaveLength(1);

    harness.terminals[0]?.emit("x".repeat(70_000));
    await waitForWrites(1);
    expect(harness.writes[0]?.data).toHaveLength(32_768);

    harness.setSession({ status: "exited", version: 2 });
    await screen.rerender(viewport("term-1", 2));
    await vi.waitFor(() => {
      expect(harness.exits).toBe(1);
    });
    harness.resolve(0);
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(harness.writes).toHaveLength(1);

    harness.setSession({ status: "running", version: 3 });
    await screen.rerender(viewport("term-1", 3));
    harness.terminals[0]?.emit("after restart");
    await waitForWrites(2);
    expect(harness.writes[1]?.data).toBe("after restart");
    harness.resolve(1);

    expect(harness.writes.map((write) => write.data)).toEqual([
      "x".repeat(32_768),
      "after restart",
    ]);
  });
});
