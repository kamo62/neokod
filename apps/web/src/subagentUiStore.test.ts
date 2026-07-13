import { scopeThreadRef, scopedThreadKey } from "@neokod/client-runtime/environment";
import { ThreadId } from "@neokod/contracts";
import { beforeEach, describe, expect, it } from "vite-plus/test";

import {
  HIDDEN_SUBAGENT_MAX_AGE_MS,
  MAX_HIDDEN_SUBAGENT_THREAD_ENTRIES,
  pruneHiddenSubagentTaskIds,
  selectHiddenSubagentTaskIds,
  useSubagentUiStore,
} from "./subagentUiStore";

const THREAD_ID = ThreadId.make("thread-1");
const THREAD_REF = scopeThreadRef("environment-a" as never, THREAD_ID);
const SAME_THREAD_OTHER_ENVIRONMENT_REF = scopeThreadRef("environment-b" as never, THREAD_ID);

describe("subagentUiStore", () => {
  beforeEach(() => {
    useSubagentUiStore.persist.clearStorage();
    useSubagentUiStore.setState({ hiddenTaskIdsByThreadKey: {} });
  });

  it("persists hidden task ids by scoped environment and thread identity", () => {
    const store = useSubagentUiStore.getState();
    store.hideSubagent(THREAD_REF, "task-a");

    expect(
      selectHiddenSubagentTaskIds(
        useSubagentUiStore.getState().hiddenTaskIdsByThreadKey,
        THREAD_REF,
      ),
    ).toEqual(["task-a"]);
    expect(
      selectHiddenSubagentTaskIds(
        useSubagentUiStore.getState().hiddenTaskIdsByThreadKey,
        SAME_THREAD_OTHER_ENVIRONMENT_REF,
      ),
    ).toEqual([]);
    expect(useSubagentUiStore.persist.getOptions().name).toBe("neokod:subagent-ui-state:v1");
  });

  it("keeps the newly hidden thread when the cap is exceeded", () => {
    const now = Date.now();
    const entries = Object.fromEntries(
      Array.from({ length: MAX_HIDDEN_SUBAGENT_THREAD_ENTRIES }, (_, index) => [
        scopedThreadKey(
          scopeThreadRef(`environment-${index}` as never, ThreadId.make(`thread-${index}`)),
        ),
        { taskIds: [`task-${index}`], updatedAt: now - index - 1 },
      ]),
    );
    useSubagentUiStore.setState({ hiddenTaskIdsByThreadKey: entries });

    useSubagentUiStore.getState().hideSubagent(THREAD_REF, "task-new");

    const after = useSubagentUiStore.getState().hiddenTaskIdsByThreadKey;
    expect(Object.keys(after)).toHaveLength(MAX_HIDDEN_SUBAGENT_THREAD_ENTRIES);
    expect(selectHiddenSubagentTaskIds(after, THREAD_REF)).toEqual(["task-new"]);
  });

  it("prunes expired entries on rehydrate even at the current version", async () => {
    const options = useSubagentUiStore.persist.getOptions();
    const expiredKey = scopedThreadKey(THREAD_REF);
    await options.storage!.setItem(options.name!, {
      state: {
        hiddenTaskIdsByThreadKey: {
          [expiredKey]: {
            taskIds: ["stale-task"],
            updatedAt: Date.now() - HIDDEN_SUBAGENT_MAX_AGE_MS - 1,
          },
        },
      },
      version: 1,
    });

    await useSubagentUiStore.persist.rehydrate();

    expect(
      selectHiddenSubagentTaskIds(
        useSubagentUiStore.getState().hiddenTaskIdsByThreadKey,
        THREAD_REF,
      ),
    ).toEqual([]);
  });

  it("prunes old entries and caps retained thread entries", () => {
    const now = 1_000_000_000;
    const oldKey = scopedThreadKey(scopeThreadRef("old" as never, ThreadId.make("old")));
    const entries = Object.fromEntries(
      Array.from({ length: MAX_HIDDEN_SUBAGENT_THREAD_ENTRIES + 1 }, (_, index) => [
        scopedThreadKey(
          scopeThreadRef(`environment-${index}` as never, ThreadId.make(`thread-${index}`)),
        ),
        { taskIds: [`task-${index}`], updatedAt: now - index },
      ]),
    );
    entries[oldKey] = { taskIds: ["old-task"], updatedAt: now - HIDDEN_SUBAGENT_MAX_AGE_MS - 1 };

    const pruned = pruneHiddenSubagentTaskIds(entries, now);

    expect(Object.keys(pruned)).toHaveLength(MAX_HIDDEN_SUBAGENT_THREAD_ENTRIES);
    expect(pruned[oldKey]).toBeUndefined();
  });
});
