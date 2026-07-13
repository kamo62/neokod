import { useAtomValue } from "@effect/atom-react";
import { scopeThreadRef, scopedThreadKey } from "@t3tools/client-runtime/environment";
import type { EnvironmentId, ScopedThreadRef } from "@t3tools/contracts";
import { useNavigate, useParams } from "@tanstack/react-router";
import * as Option from "effect/Option";
import { useCallback, useEffect, useRef, useState } from "react";

import { environmentCatalog } from "../connection/catalog";
import { stackedThreadToast, toastManager } from "../components/ui/toast";
import { useClientSettings, useClientSettingsHydrated } from "../hooks/useSettings";
import { resolveThreadRouteRef, buildThreadRouteParams } from "../threadRoutes";
import { useEnvironments } from "../state/environments";
import { useEnvironmentQuery } from "../state/query";
import { environmentShell } from "../state/shell";
import { terminalEnvironment } from "../state/terminal";
import {
  activityOccurrenceKey,
  createActivityObservationState,
  flushNextActivityOccurrence,
  reduceEnvironmentActivityObservation,
  retryActivityOccurrence,
  settleActivityOccurrence,
  type ActivityObservationState,
  type ActivityOccurrence,
  type EnvironmentActivityInput,
} from "./activityNotifications.logic";
import { showBrowserActivityNotification } from "./browserNotification";

const FOCUS_TOAST_VISIBLE_MS = 8_000;
const MAX_TOAST_RETRIES = 3;

export function useDocumentAttentionState() {
  const [attention, setAttention] = useState(() => ({
    visible: typeof document !== "undefined" && document.visibilityState === "visible",
    focused: typeof document !== "undefined" && document.hasFocus(),
  }));

  useEffect(() => {
    const update = () =>
      setAttention({
        visible: document.visibilityState === "visible",
        focused: document.hasFocus(),
      });
    update();
    document.addEventListener("visibilitychange", update);
    window.addEventListener("focus", update);
    window.addEventListener("blur", update);
    return () => {
      document.removeEventListener("visibilitychange", update);
      window.removeEventListener("focus", update);
      window.removeEventListener("blur", update);
    };
  }, []);

  return attention;
}

export function isTargetThreadVisibleAndFocused(
  occurrence: ActivityOccurrence,
  activeThreadRef: ScopedThreadRef | null,
): boolean {
  return (
    typeof document !== "undefined" &&
    document.visibilityState === "visible" &&
    document.hasFocus() &&
    activeThreadRef?.environmentId === occurrence.environmentId &&
    activeThreadRef.threadId === occurrence.threadId
  );
}

function openActivityNotificationTarget(
  navigate: ReturnType<typeof useNavigate>,
  occurrence: ActivityOccurrence,
) {
  const ref = scopeThreadRef(occurrence.environmentId, occurrence.threadId as never);
  void navigate({ to: "/$environmentId/$threadId", params: buildThreadRouteParams(ref) });
}

function addActivityToast(
  occurrence: ActivityOccurrence,
  navigate: ReturnType<typeof useNavigate>,
  timeout?: number,
) {
  toastManager.add(
    stackedThreadToast({
      type:
        occurrence.kind === "agent-failed"
          ? "error"
          : occurrence.kind === "agent-completed" || occurrence.kind === "terminal-completed"
            ? "success"
            : "info",
      title: occurrence.headline,
      ...(occurrence.detail ? { description: occurrence.detail } : {}),
      ...(timeout === undefined ? {} : { timeout }),
      actionProps: {
        children: "Open",
        onClick: () => openActivityNotificationTarget(navigate, occurrence),
      },
      ...(timeout === 0 ? { data: { dismissAfterVisibleMs: FOCUS_TOAST_VISIBLE_MS } } : {}),
    }),
  );
}

function nextFlushDelay(state: ActivityObservationState, nowMs: number): number | null {
  let deadline = Number.POSITIVE_INFINITY;
  for (const [scope, value] of state.queueWindowDeadlineByScope) {
    const scopeIsInFlight = [...state.inFlightByKey.values()].some(
      (occurrence) =>
        scopedThreadKey(scopeThreadRef(occurrence.environmentId, occurrence.threadId as never)) === scope,
    );
    if (!scopeIsInFlight) deadline = Math.min(deadline, value);
  }
  return Number.isFinite(deadline) ? Math.max(0, deadline - nowMs) : null;
}

export function ActivityNotificationCoordinator() {
  const { environments, isReady } = useEnvironments();
  const enabled = useClientSettings((settings) => settings.webActivityNotificationsEnabled);
  const settingsHydrated = useClientSettingsHydrated();
  const navigate = useNavigate();
  const routeTarget = useParams({ strict: false, select: (params) => resolveThreadRouteRef(params) });
  const attention = useDocumentAttentionState();
  const stateRef = useRef(createActivityObservationState());
  const focusQueueRef = useRef(new Map<string, ActivityOccurrence>());
  const flushTimerRef = useRef<number | null>(null);
  const toastRetriesRef = useRef(new Map<string, number>());
  const [revision, setRevision] = useState(0);

  const settle = useCallback(
    (occurrence: ActivityOccurrence, outcome: "delivered" | "suppressed" | "failed") => {
      stateRef.current = settleActivityOccurrence(
        stateRef.current,
        activityOccurrenceKey(occurrence),
        outcome,
      );
      focusQueueRef.current.delete(activityOccurrenceKey(occurrence));
      toastRetriesRef.current.delete(activityOccurrenceKey(occurrence));
    },
    [],
  );

  const fail = useCallback((occurrence: ActivityOccurrence) => {
    const key = activityOccurrenceKey(occurrence);
    const attempts = (toastRetriesRef.current.get(key) ?? 0) + 1;
    if (attempts >= MAX_TOAST_RETRIES) {
      settle(occurrence, "suppressed");
      return;
    }
    toastRetriesRef.current.set(key, attempts);
    focusQueueRef.current.delete(key);
    stateRef.current = retryActivityOccurrence(
      stateRef.current,
      occurrence,
      Date.now() + 1_000 * 2 ** (attempts - 1),
    );
  }, [settle]);

  const deliverActivityOccurrence = useCallback((occurrence: ActivityOccurrence): "settled" | "queued" => {
    const visible = typeof document !== "undefined" && document.visibilityState === "visible";
    const focused = typeof document !== "undefined" && document.hasFocus();
    if (!enabled || !settingsHydrated || isTargetThreadVisibleAndFocused(occurrence, routeTarget)) {
      settle(occurrence, "suppressed");
      return "settled";
    }
    if (visible && focused) {
      try {
        addActivityToast(occurrence, navigate);
        settle(occurrence, "delivered");
      } catch {
        fail(occurrence);
      }
      return "settled";
    }
    const nativeResult = showBrowserActivityNotification({
      title: occurrence.headline,
      ...(occurrence.detail ? { body: occurrence.detail } : {}),
      tag: `neokod:${activityOccurrenceKey(occurrence)}`,
      onClick: () => openActivityNotificationTarget(navigate, occurrence),
    });
    if (nativeResult === "shown") {
      settle(occurrence, "delivered");
      return "settled";
    }
    focusQueueRef.current.set(activityOccurrenceKey(occurrence), occurrence);
    return "queued";
  }, [enabled, fail, navigate, routeTarget, settingsHydrated, settle]);

  const flushFocusFallbacks = useCallback(() => {
    if (typeof document === "undefined" || document.visibilityState !== "visible" || !document.hasFocus()) return;
    let progressed = false;
    for (const occurrence of [...focusQueueRef.current.values()]) {
      const key = activityOccurrenceKey(occurrence);
      if (!stateRef.current.inFlightByKey.has(key)) {
        focusQueueRef.current.delete(key);
        continue;
      }
      if (!enabled || !settingsHydrated || isTargetThreadVisibleAndFocused(occurrence, routeTarget)) {
        settle(occurrence, "suppressed");
        progressed = true;
        continue;
      }
      try {
        addActivityToast(occurrence, navigate, 0);
        settle(occurrence, "delivered");
        progressed = true;
      } catch {
        fail(occurrence);
        progressed = true;
      }
    }
    if (progressed) setRevision((value) => value + 1);
  }, [attention.focused, attention.visible, enabled, fail, navigate, routeTarget, settingsHydrated, settle]);

  const flush = useCallback(() => {
    const result = flushNextActivityOccurrence(stateRef.current, Date.now());
    stateRef.current = result.state;
    if (!result.occurrence) return;
    deliverActivityOccurrence(result.occurrence);
    setRevision((value) => value + 1);
  }, [deliverActivityOccurrence]);

  const observe = useCallback((input: EnvironmentActivityInput) => {
    stateRef.current = reduceEnvironmentActivityObservation(stateRef.current, input).state;
    if (!input.notificationsEnabled) focusQueueRef.current.clear();
    setRevision((value) => value + 1);
  }, []);

  useEffect(() => {
    if (flushTimerRef.current !== null) window.clearTimeout(flushTimerRef.current);
    const delay = nextFlushDelay(stateRef.current, Date.now());
    if (delay !== null) flushTimerRef.current = window.setTimeout(flush, delay);
    return () => {
      if (flushTimerRef.current !== null) window.clearTimeout(flushTimerRef.current);
    };
  }, [flush, revision]);

  useEffect(() => {
    flushFocusFallbacks();
  }, [flushFocusFallbacks]);

  if (!isReady) return null;
  return environments.map((environment) => (
    <EnvironmentActivitySource
      enabled={enabled}
      settingsHydrated={settingsHydrated}
      catalogReady={isReady}
      environmentId={environment.environmentId}
      key={environment.environmentId}
      onObservation={observe}
    />
  ));
}

export function EnvironmentActivitySource({
  environmentId,
  enabled,
  settingsHydrated,
  catalogReady,
  onObservation,
}: {
  readonly environmentId: EnvironmentId;
  readonly enabled: boolean;
  readonly settingsHydrated: boolean;
  readonly catalogReady: boolean;
  readonly onObservation: (input: EnvironmentActivityInput) => void;
}) {
  const supervisor = useEnvironmentQuery(environmentCatalog.stateAtom(environmentId)).data;
  const shell = useAtomValue(environmentShell.stateValueAtom(environmentId));
  const terminalMetadata = useEnvironmentQuery(terminalEnvironment.metadata({ environmentId, input: null }));
  const snapshot = Option.getOrNull(shell.snapshot);
  const terminalMetadataSnapshotRef = useRef(terminalMetadata.data);
  const terminalMetadataEpochRef = useRef(0);

  useEffect(() => {
    if (terminalMetadata.data !== terminalMetadataSnapshotRef.current) {
      terminalMetadataSnapshotRef.current = terminalMetadata.data;
      terminalMetadataEpochRef.current += 1;
    }
    onObservation({
      environmentId,
      generation: supervisor?.generation ?? 0,
      catalogReady,
      shellStatus: shell.status,
      threads: snapshot?.threads ?? [],
      projects: snapshot?.projects ?? [],
      terminals: terminalMetadata.data ?? [],
      terminalMetadataReady: terminalMetadata.data !== null && !terminalMetadata.isPending,
      terminalMetadataEpoch: terminalMetadataEpochRef.current,
      notificationsEnabled: settingsHydrated && enabled,
      nowMs: Date.now(),
    });
  }, [
    catalogReady,
    enabled,
    environmentId,
    onObservation,
    shell.status,
    snapshot,
    supervisor?.generation,
    settingsHydrated,
    terminalMetadata.data,
    terminalMetadata.isPending,
  ]);

  return null;
}
