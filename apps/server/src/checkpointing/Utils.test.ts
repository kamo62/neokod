import { ThreadId } from "@neokod/contracts";
import * as Encoding from "effect/Encoding";
import { describe, expect, it } from "vite-plus/test";

import {
  RECOVERY_REFS_PREFIX,
  findActiveSessionsSharingCwd,
  recoveryRefForThreadRevert,
} from "./Utils.ts";

const threadId = ThreadId.make("thread-1");

describe("recoveryRefForThreadRevert", () => {
  it("encodes the thread id and epoch milliseconds", () => {
    expect(recoveryRefForThreadRevert(threadId, 1700000000000)).toBe(
      `${RECOVERY_REFS_PREFIX}/${Encoding.encodeBase64Url(threadId)}/1700000000000`,
    );
  });
});

describe("findActiveSessionsSharingCwd", () => {
  const cwd = "/repo/project";

  const find = (
    sessions: ReadonlyArray<{
      readonly threadId: string;
      readonly cwd?: string | undefined;
      readonly status: string;
    }>,
    targetCwd = cwd,
  ) =>
    findActiveSessionsSharingCwd({
      threadId,
      cwd: targetCwd,
      sessions: sessions.map((session) => ({
        ...session,
        threadId: ThreadId.make(session.threadId),
      })),
    });

  it("returns another thread running in the same folder even with a trailing separator", () => {
    expect(find([{ threadId: "thread-2", cwd: "/repo/project/", status: "running" }])).toEqual([
      ThreadId.make("thread-2"),
    ]);
  });

  it("counts a connecting session", () => {
    expect(find([{ threadId: "thread-2", cwd, status: "connecting" }])).toEqual([
      ThreadId.make("thread-2"),
    ]);
  });

  it("ignores ready, error and closed sessions", () => {
    expect(
      find([
        { threadId: "thread-2", cwd, status: "ready" },
        { threadId: "thread-3", cwd, status: "error" },
        { threadId: "thread-4", cwd, status: "closed" },
      ]),
    ).toEqual([]);
  });

  it("ignores a session in a different folder", () => {
    expect(find([{ threadId: "thread-2", cwd: "/repo/other", status: "running" }])).toEqual([]);
  });

  it("ignores the thread's own session", () => {
    expect(find([{ threadId: "thread-1", cwd, status: "running" }])).toEqual([]);
  });

  it("ignores a session without a folder", () => {
    expect(find([{ threadId: "thread-2", status: "running" }])).toEqual([]);
  });

  it("returns every busy thread in the folder", () => {
    expect(
      find([
        { threadId: "thread-2", cwd, status: "running" },
        { threadId: "thread-3", cwd: `${cwd}/`, status: "connecting" },
        { threadId: "thread-4", cwd: "/repo/other", status: "running" },
      ]),
    ).toEqual([ThreadId.make("thread-2"), ThreadId.make("thread-3")]);
  });
});
