import { scopeThreadRef, scopedThreadKey } from "@neokod/client-runtime/environment";
import type { EnvironmentThreadShell } from "@neokod/client-runtime/state/shell";
import { useAtomValue } from "@effect/atom-react";
import { useNavigate, useParams } from "@tanstack/react-router";
import { useEffect, useMemo, useRef, useState } from "react";

import { resolveShortcutCommand, THREAD_SWITCHER_COMMAND } from "../keybindings";
import { cn } from "../lib/utils";
import { primaryServerKeybindingsAtom } from "../state/server";
import { useProjects, useThreadShells } from "../state/entities";
import { buildThreadRouteParams, resolveThreadRouteTarget } from "../threadRoutes";
import {
  INITIAL_THREAD_SWITCHER_STATE,
  advanceThreadSwitcher,
  buildThreadSwitcherMruOrder,
  cancelThreadSwitcher,
  commitThreadSwitcher,
  highlightedThreadId,
  openThreadSwitcher,
  reconcileThreadSwitcher,
  type ThreadSwitcherState,
} from "../threadSwitcher";
import { useUiStateStore } from "../uiStateStore";

/**
 * Root-mounted MRU thread switcher (REVIEW-UI item 12). Holding Ctrl and
 * pressing Tab opens a transient overlay listing threads most-recently
 * visited first; repeated presses move the highlight without navigating;
 * releasing Ctrl (or pressing Enter) commits the highlighted thread;
 * Escape cancels. All keyboard/MRU-order state lives in the pure
 * ../threadSwitcher module — this component only wires it to DOM events,
 * the thread list, and routing.
 */
export function ThreadSwitcherOverlay() {
  const [state, setState] = useState<ThreadSwitcherState>(INITIAL_THREAD_SWITCHER_STATE);
  const stateRef = useRef(state);
  useEffect(() => {
    stateRef.current = state;
  }, [state]);

  const keybindings = useAtomValue(primaryServerKeybindingsAtom);
  const navigate = useNavigate();
  const threadShells = useThreadShells();
  const projects = useProjects();
  const visitedAtById = useUiStateStore((store) => store.threadLastVisitedAtById);
  const routeTarget = useParams({
    strict: false,
    select: (params) => resolveThreadRouteTarget(params),
  });
  const currentThreadKey =
    routeTarget?.kind === "server" ? scopedThreadKey(routeTarget.threadRef) : null;

  const threadsByKey = useMemo(() => {
    const map = new Map<string, EnvironmentThreadShell>();
    for (const thread of threadShells) {
      map.set(scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id)), thread);
    }
    return map;
  }, [threadShells]);
  const threadsByKeyRef = useRef(threadsByKey);
  useEffect(() => {
    threadsByKeyRef.current = threadsByKey;
  }, [threadsByKey]);

  const projectTitleByKey = useMemo(() => {
    const map = new Map<string, string>();
    for (const project of projects) {
      map.set(`${project.environmentId}:${project.id}`, project.title);
    }
    return map;
  }, [projects]);

  const mruOrder = useMemo(
    () =>
      buildThreadSwitcherMruOrder(
        threadShells.map((thread) => ({
          key: scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id)),
          archivedAt: thread.archivedAt,
          updatedAt: thread.updatedAt,
        })),
        visitedAtById,
        currentThreadKey,
      ),
    [threadShells, visitedAtById, currentThreadKey],
  );
  const mruOrderRef = useRef(mruOrder);
  useEffect(() => {
    mruOrderRef.current = mruOrder;
  }, [mruOrder]);

  // Entries removed (archived/deleted) while the overlay is open are
  // reconciled by identity rather than snapshotted once at open time.
  useEffect(() => {
    if (!state.visible) return;
    setState((prev) => reconcileThreadSwitcher(prev, new Set(threadsByKey.keys())));
  }, [threadsByKey, state.visible]);

  useEffect(() => {
    const navigateToCommitted = (threadId: string | null) => {
      if (threadId === null) return;
      const thread = threadsByKeyRef.current.get(threadId);
      if (!thread) return;
      void navigate({
        to: "/$environmentId/$threadId",
        params: buildThreadRouteParams(scopeThreadRef(thread.environmentId, thread.id)),
      });
    };

    const commitNow = () => {
      const result = commitThreadSwitcher(stateRef.current);
      setState(result.state);
      navigateToCommitted(result.committedThreadId);
    };

    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.defaultPrevented) return;

      if (!stateRef.current.visible) {
        if (event.repeat) return;
        const command = resolveShortcutCommand(event, keybindings);
        if (command !== THREAD_SWITCHER_COMMAND) return;
        if (mruOrderRef.current.length <= 1) return;
        event.preventDefault();
        event.stopPropagation();
        setState((prev) =>
          openThreadSwitcher(prev, mruOrderRef.current, event.shiftKey ? "reverse" : "forward"),
        );
        return;
      }

      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        setState((prev) => cancelThreadSwitcher(prev));
        return;
      }
      if (event.key === "Enter") {
        event.preventDefault();
        event.stopPropagation();
        commitNow();
        return;
      }
      if (event.key === "Tab" && event.ctrlKey) {
        event.preventDefault();
        event.stopPropagation();
        setState((prev) => advanceThreadSwitcher(prev, event.shiftKey ? "reverse" : "forward"));
      }
    };

    const onKeyUp = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Control" && stateRef.current.visible) {
        commitNow();
      }
    };

    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
    };
  }, [keybindings, navigate]);

  if (!state.visible) {
    return null;
  }

  const highlighted = highlightedThreadId(state);

  return (
    <div
      aria-hidden={false}
      className="pointer-events-none fixed inset-0 z-100 flex items-start justify-center pt-[20vh]"
    >
      <div
        role="listbox"
        aria-label="Switch thread"
        className="pointer-events-auto w-full max-w-sm overflow-hidden rounded-2xl border border-border bg-popover text-popover-foreground shadow-2xl"
      >
        <ul className="max-h-80 overflow-y-auto p-1.5">
          {state.order.flatMap((threadKey) => {
            const thread = threadsByKey.get(threadKey);
            if (!thread) return [];
            const isHighlighted = threadKey === highlighted;
            const projectTitle = projectTitleByKey.get(
              `${thread.environmentId}:${thread.projectId}`,
            );
            return [
              <li
                key={threadKey}
                role="option"
                aria-selected={isHighlighted}
                className={cn(
                  "flex min-w-0 items-center gap-2 rounded-lg px-3 py-2 text-sm",
                  isHighlighted ? "bg-accent text-accent-foreground" : "text-foreground",
                )}
              >
                <span className="min-w-0 flex-1 truncate">{thread.title}</span>
                {projectTitle ? (
                  <span className="shrink-0 truncate text-xs text-muted-foreground">
                    {projectTitle}
                  </span>
                ) : null}
              </li>,
            ];
          })}
        </ul>
      </div>
    </div>
  );
}
