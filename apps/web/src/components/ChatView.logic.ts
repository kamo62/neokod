import {
  type EnvironmentId,
  isProviderDriverKind,
  ProjectId,
  type ModelSelection,
  type ProviderDriverKind,
  type ServerProvider,
  type ScopedThreadRef,
  type ThreadId,
  type TurnId,
} from "@neokod/contracts";
import { type ChatMessage, type SessionPhase, type Thread } from "../types";
import {
  type ComposerImageAttachment,
  type DraftThreadState,
  type QueuedComposerMessage,
} from "../composerDraftStore";
import * as Schema from "effect/Schema";
import { appAtomRegistry } from "../rpc/atomRegistry";
import { environmentThreadDetails } from "../state/threads";
import {
  filterTerminalContextsWithText,
  stripInlineTerminalContextPlaceholders,
  type TerminalContextDraft,
} from "../lib/terminalContext";
import type { DraftThreadEnvMode } from "../composerDraftStore";
import { type WorkLogEntry } from "../session-logic";
import { deriveToolCallLabel, formatInProgressToolLabel } from "./chat/ToolCallLabel.logic";

export const LAST_INVOKED_SCRIPT_BY_PROJECT_KEY = "neokod:last-invoked-script-by-project";
export const MAX_HIDDEN_MOUNTED_TERMINAL_THREADS = 10;
export const MAX_HIDDEN_MOUNTED_PREVIEW_THREADS = 3;

export const LastInvokedScriptByProjectSchema = Schema.Record(ProjectId, Schema.String);

export function deriveActiveToolLabel(input: {
  readonly phase: SessionPhase;
  readonly hasPendingApproval?: boolean | undefined;
  readonly hasPendingUserInput?: boolean | undefined;
  readonly activeTurnId: TurnId | null | undefined;
  readonly entries: ReadonlyArray<WorkLogEntry>;
  readonly workspaceRoot?: string | undefined;
}): string | undefined {
  if (
    input.phase !== "running" ||
    input.hasPendingApproval ||
    input.hasPendingUserInput ||
    input.activeTurnId === null ||
    input.activeTurnId === undefined
  ) {
    return undefined;
  }
  const activeTool = input.entries.findLast(
    (entry) => entry.turnId === input.activeTurnId && entry.toolLifecycleStatus === "inProgress",
  );
  if (!activeTool) return undefined;
  return formatInProgressToolLabel(
    deriveToolCallLabel({
      toolName: activeTool.toolName,
      input: activeTool.toolInput,
      command: activeTool.command,
      changedFiles: activeTool.changedFiles,
      itemType: activeTool.itemType,
      requestKind: activeTool.requestKind,
      workspaceRoot: input.workspaceRoot,
      fallbackLabel: activeTool.toolTitle ?? activeTool.label,
    }),
  );
}

export function buildLocalDraftThread(
  threadId: ThreadId,
  draftThread: DraftThreadState,
  fallbackModelSelection: ModelSelection,
): Thread {
  return {
    id: threadId,
    environmentId: draftThread.environmentId,
    projectId: draftThread.projectId,
    title: "New thread",
    modelSelection: fallbackModelSelection,
    runtimeMode: draftThread.runtimeMode,
    interactionMode: draftThread.interactionMode,
    session: null,
    messages: [],
    createdAt: draftThread.createdAt,
    updatedAt: draftThread.createdAt,
    archivedAt: null,
    deletedAt: null,
    latestTurn: null,
    branch: draftThread.branch,
    worktreePath: draftThread.worktreePath,
    checkpoints: [],
    activities: [],
    proposedPlans: [],
  };
}

export function shouldWriteThreadErrorToCurrentServerThread(input: {
  serverThread:
    | {
        environmentId: EnvironmentId;
        id: ThreadId;
      }
    | null
    | undefined;
  routeThreadRef: ScopedThreadRef;
  targetThreadId: ThreadId;
}): boolean {
  return Boolean(
    input.serverThread &&
    input.targetThreadId === input.routeThreadRef.threadId &&
    input.serverThread.environmentId === input.routeThreadRef.environmentId &&
    input.serverThread.id === input.targetThreadId,
  );
}

export function buildThreadTurnInterruptInput(thread: Pick<Thread, "id" | "session">): {
  threadId: ThreadId;
  turnId?: TurnId;
} {
  const runningTurnId = thread.session?.status === "running" ? thread.session.activeTurnId : null;
  return {
    threadId: thread.id,
    ...(runningTurnId !== null ? { turnId: runningTurnId } : {}),
  };
}

export function reconcileMountedTerminalThreadIds(input: {
  currentThreadIds: ReadonlyArray<string>;
  openThreadIds: ReadonlyArray<string>;
  activeThreadId: string | null;
  activeThreadTerminalOpen: boolean;
  maxHiddenThreadCount?: number;
}): string[] {
  return reconcileRetainedMountedThreadIds({
    currentThreadIds: input.currentThreadIds,
    openThreadIds: input.openThreadIds,
    activeThreadId: input.activeThreadId,
    activeThreadOpen: input.activeThreadTerminalOpen,
    maxHiddenThreadCount: input.maxHiddenThreadCount ?? MAX_HIDDEN_MOUNTED_TERMINAL_THREADS,
  });
}

export function reconcileRetainedMountedThreadIds(input: {
  currentThreadIds: ReadonlyArray<string>;
  openThreadIds: ReadonlyArray<string>;
  activeThreadId: string | null;
  activeThreadOpen: boolean;
  maxHiddenThreadCount: number;
  retainInactiveActiveThread?: boolean;
}): string[] {
  const openThreadIdSet = new Set(input.openThreadIds);
  const hiddenThreadIds = input.currentThreadIds.filter(
    (threadId) =>
      (threadId !== input.activeThreadId || input.retainInactiveActiveThread === true) &&
      openThreadIdSet.has(threadId),
  );
  const maxHiddenThreadCount = Math.max(0, input.maxHiddenThreadCount);
  const nextThreadIds =
    hiddenThreadIds.length > maxHiddenThreadCount
      ? hiddenThreadIds.slice(-maxHiddenThreadCount)
      : hiddenThreadIds;

  if (
    input.activeThreadId &&
    input.activeThreadOpen &&
    !nextThreadIds.includes(input.activeThreadId)
  ) {
    nextThreadIds.push(input.activeThreadId);
  }

  return nextThreadIds;
}

export function revokeBlobPreviewUrl(previewUrl: string | undefined): void {
  if (!previewUrl || typeof URL === "undefined" || !previewUrl.startsWith("blob:")) {
    return;
  }
  URL.revokeObjectURL(previewUrl);
}

export function revokeUserMessagePreviewUrls(message: ChatMessage): void {
  if (message.role !== "user" || !message.attachments) {
    return;
  }
  for (const attachment of message.attachments) {
    if (attachment.type !== "image") {
      continue;
    }
    revokeBlobPreviewUrl(attachment.previewUrl);
  }
}

export function collectUserMessageBlobPreviewUrls(message: ChatMessage): string[] {
  if (message.role !== "user" || !message.attachments) {
    return [];
  }
  const previewUrls: string[] = [];
  for (const attachment of message.attachments) {
    if (attachment.type !== "image") continue;
    if (!attachment.previewUrl || !attachment.previewUrl.startsWith("blob:")) continue;
    previewUrls.push(attachment.previewUrl);
  }
  return previewUrls;
}

export interface PullRequestDialogState {
  initialReference: string | null;
  key: number;
}

export function readFileAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.addEventListener("load", () => {
      if (typeof reader.result === "string") {
        resolve(reader.result);
        return;
      }
      reject(new Error("Could not read image data."));
    });
    reader.addEventListener("error", () => {
      reject(reader.error ?? new Error("Failed to read image."));
    });
    reader.readAsDataURL(file);
  });
}

export function resolveSendEnvMode(input: {
  requestedEnvMode: DraftThreadEnvMode;
  isGitRepo: boolean;
}): DraftThreadEnvMode {
  return input.isGitRepo ? input.requestedEnvMode : "local";
}

export function cloneComposerImageForRetry(
  image: ComposerImageAttachment,
): ComposerImageAttachment {
  if (typeof URL === "undefined" || !image.previewUrl.startsWith("blob:")) {
    return image;
  }
  try {
    return {
      ...image,
      previewUrl: URL.createObjectURL(image.file),
    };
  } catch {
    return image;
  }
}

export function deriveComposerSendState(options: {
  prompt: string;
  imageCount: number;
  terminalContexts: ReadonlyArray<TerminalContextDraft>;
  /**
   * Optional element-pick attachment count. Element contexts contribute to
   * "sendable content" exactly like images and (text-bearing) terminal
   * contexts do: a prompt of just element chips is still a valid send.
   */
  elementContextCount?: number;
}): {
  trimmedPrompt: string;
  sendableTerminalContexts: TerminalContextDraft[];
  expiredTerminalContextCount: number;
  hasSendableContent: boolean;
} {
  const trimmedPrompt = stripInlineTerminalContextPlaceholders(options.prompt).trim();
  const sendableTerminalContexts = filterTerminalContextsWithText(options.terminalContexts);
  const expiredTerminalContextCount =
    options.terminalContexts.length - sendableTerminalContexts.length;
  const elementContextCount = options.elementContextCount ?? 0;
  return {
    trimmedPrompt,
    sendableTerminalContexts,
    expiredTerminalContextCount,
    hasSendableContent:
      trimmedPrompt.length > 0 ||
      options.imageCount > 0 ||
      sendableTerminalContexts.length > 0 ||
      elementContextCount > 0,
  };
}

/**
 * A queued message may only be handed to `onSend` when the composer is in a
 * state where that call can actually attempt a send. Otherwise the queue must
 * keep the entry: `onSend` returns without touching the draft.
 */
export function canDispatchQueuedMessage(input: {
  readonly hasActiveThread: boolean;
  readonly isSendBusy: boolean;
  readonly isConnecting: boolean;
  readonly environmentUnavailable: boolean;
  readonly sendInFlight: boolean;
  readonly hasPendingUserInput?: boolean;
}): boolean {
  return (
    input.hasActiveThread &&
    !input.isSendBusy &&
    !input.isConnecting &&
    !input.environmentUnavailable &&
    !input.sendInFlight &&
    input.hasPendingUserInput !== true
  );
}

/**
 * Automatic drain waits for an entry that no send has claimed. Claimed entries
 * are owned by the send that took them, even after the component that started
 * it remounts.
 */
export function canAutoDispatchQueuedMessage(input: {
  readonly dispatchState: QueuedDispatchState;
  readonly hasActiveThread: boolean;
  readonly isSendBusy: boolean;
  readonly isConnecting: boolean;
  readonly environmentUnavailable: boolean;
  readonly sendInFlight: boolean;
  readonly hasPendingUserInput?: boolean;
}): boolean {
  return input.dispatchState === "none" && canDispatchQueuedMessage(input);
}

export type SendOutcome =
  | "not_attempted"
  | "accepted"
  /** The attempt definitively stopped before any command reached the server. */
  | "not_sent"
  /** The command may have been accepted but the outcome could not be observed. */
  | "unknown";

export type DispatchFailureKind = "not_sent" | "unknown";

function taggedErrorName(error: unknown): string | null {
  if (typeof error !== "object" || error === null) return null;
  const tag = (error as { readonly _tag?: unknown })._tag;
  return typeof tag === "string" ? tag : null;
}

/**
 * Classifies a failed send after the turn command was dispatched.
 *
 * An unavailable environment is rejected before the request leaves the client.
 * A typed `OrchestrationDispatchCommandError` is not definitive rejection: the
 * server wraps receipt-read failures, startup/queue failures, and failures
 * after the command transaction committed in the same error tag. It may
 * therefore have accepted the command. Anything else, including transport loss
 * and interruption, may also have happened after the server committed the
 * command. Without affirmative evidence, the outcome stays unknown.
 */
export function classifyDispatchFailure(input: {
  readonly interrupted: boolean;
  readonly error: unknown;
}): DispatchFailureKind {
  if (input.interrupted) return "unknown";
  const tag = taggedErrorName(input.error);
  if (tag === "EnvironmentRpcUnavailableError") return "not_sent";
  return "unknown";
}

export type QueuedDispatchState = "none" | "in_flight" | "unconfirmed" | "failed";

export type QueuedDispatchSettlement = "remove_entry" | "mark_unconfirmed" | "mark_failed";

/**
 * Decides what happens to a queued entry after one dispatch attempt.
 *
 * The entry owns its text until the composer has it or the send was accepted.
 * An outcome that may have been accepted must stay under its stable identity:
 * converting it into an ordinary draft would allow a fresh-id resend.
 */
export function decideQueuedDispatchSettlement(input: {
  readonly outcome: SendOutcome;
  readonly composerStillHoldsText: boolean;
  readonly previousDispatchState: QueuedDispatchState;
}): QueuedDispatchSettlement {
  if (input.outcome === "accepted") return "remove_entry";
  if (input.outcome === "unknown") return "mark_unconfirmed";
  if (input.outcome === "not_attempted") {
    // Never turn a claimed entry back into an automatically dispatchable one:
    // an unreflected blocker could otherwise retry in a loop.
    return input.previousDispatchState === "unconfirmed" ? "mark_unconfirmed" : "mark_failed";
  }
  // `not_sent`. A known local failure on a retry cannot resolve an earlier
  // attempt whose command may already have been accepted.
  if (input.previousDispatchState === "unconfirmed") return "mark_unconfirmed";
  return input.composerStillHoldsText ? "remove_entry" : "mark_failed";
}

/**
 * Retry availability mirrors the handler and the actual send blockers. After
 * a reload the session is often stopped or disconnected, which is not itself a
 * reason to hide the only safe retry for an unconfirmed send.
 */
export function canRetryUnconfirmedQueuedMessage(input: {
  readonly phase: SessionPhase;
  readonly composerDraftEmpty: boolean;
  readonly hasActiveThread: boolean;
  readonly isSendBusy: boolean;
  readonly isConnecting: boolean;
  readonly environmentUnavailable: boolean;
  readonly sendInFlight: boolean;
  readonly hasPendingUserInput?: boolean;
}): boolean {
  return input.phase !== "running" && input.composerDraftEmpty && canDispatchQueuedMessage(input);
}

export function upsertOptimisticUserMessage(
  messages: ReadonlyArray<ChatMessage>,
  message: ChatMessage,
): ChatMessage[] {
  return [...messages.filter((existing) => existing.id !== message.id), message];
}

export function removeOptimisticUserMessage(
  messages: ReadonlyArray<ChatMessage>,
  messageId: string,
): ChatMessage[] {
  return messages.filter((message) => message.id !== messageId);
}

export interface ResolvedSendIdentity {
  readonly messageId: string;
  readonly commandId: string | null;
  readonly messageCreatedAt: string;
}

/**
 * Identity for one queued dispatch attempt.
 *
 * The first attempt derives both ids from the already-saved queue entry, so a
 * claim that never reached persistent browser storage cannot replay under a
 * fresh identity and duplicate a send the server already accepted. An unknown
 * earlier attempt keeps its identity. Only a definitive failure starts over.
 */
export interface QueuedDispatchAttemptIdentity {
  readonly messageId: string;
  readonly commandId: string;
  readonly messageCreatedAt: string;
}

export function queuedDispatchMessageId(queuedMessageId: string): string {
  return `queued-message:${queuedMessageId}`;
}

export function queuedDispatchCommandId(queuedMessageId: string): string {
  return `queued-command:${queuedMessageId}`;
}

export function resolveQueuedDispatchAttempt(input: {
  readonly queuedMessageId: string;
  readonly previousDispatch: {
    readonly messageId: string;
    readonly commandId: string;
    readonly messageCreatedAt?: string;
    readonly attemptedAt: string;
    readonly state: QueuedDispatchState;
  } | null;
  readonly freshMessageId: string;
  readonly freshCommandId: string;
  readonly now: string;
}): QueuedDispatchAttemptIdentity {
  const previous = input.previousDispatch;
  if (previous !== null && previous.state !== "failed") {
    return {
      messageId: previous.messageId,
      commandId: previous.commandId,
      // `messageCreatedAt` is the first attempt's timestamp. Claims written
      // before that field existed fall back to the first attempt time, never
      // to the time the message was queued.
      messageCreatedAt: previous.messageCreatedAt ?? previous.attemptedAt,
    };
  }
  if (previous?.state === "failed") {
    return {
      messageId: input.freshMessageId,
      commandId: input.freshCommandId,
      messageCreatedAt: input.now,
    };
  }
  return {
    messageId: queuedDispatchMessageId(input.queuedMessageId),
    commandId: queuedDispatchCommandId(input.queuedMessageId),
    messageCreatedAt: input.now,
  };
}

/**
 * Resolves the identity submitted to `thread.turn.start`. A claimed queued
 * dispatch always wins over freshly generated ids, in the ordinary and the
 * plan-follow-up branch alike.
 */
export function resolveSendIdentity(input: {
  readonly queuedDispatch?: {
    readonly messageId: string;
    readonly commandId: string;
    readonly messageCreatedAt?: string;
  };
  readonly newMessageId: string;
  readonly now: string;
}): ResolvedSendIdentity {
  if (input.queuedDispatch) {
    return {
      messageId: input.queuedDispatch.messageId,
      commandId: input.queuedDispatch.commandId,
      messageCreatedAt: input.queuedDispatch.messageCreatedAt ?? input.now,
    };
  }
  return {
    messageId: input.newMessageId,
    commandId: null,
    messageCreatedAt: input.now,
  };
}

export function isComposerDraftEmpty(input: {
  readonly prompt: string;
  readonly imageCount: number;
  readonly terminalContextCount: number;
  readonly elementContextCount: number;
  readonly previewAnnotationCount: number;
  readonly reviewCommentCount: number;
}): boolean {
  return (
    input.prompt.length === 0 &&
    input.imageCount === 0 &&
    input.terminalContextCount === 0 &&
    input.elementContextCount === 0 &&
    input.previewAnnotationCount === 0 &&
    input.reviewCommentCount === 0
  );
}

/**
 * True when the original target's durable draft holds exactly the text a
 * failed queued send restored: the text and no live attachments. The queue can
 * then release its entry because the composer owns the content.
 */
export function composerDraftHoldsQueuedText(
  input: {
    readonly prompt: string;
    readonly imageCount: number;
    readonly terminalContextCount: number;
    readonly elementContextCount: number;
    readonly previewAnnotationCount: number;
    readonly reviewCommentCount: number;
  },
  text: string,
): boolean {
  return (
    input.prompt === text &&
    input.imageCount === 0 &&
    input.terminalContextCount === 0 &&
    input.elementContextCount === 0 &&
    input.previewAnnotationCount === 0 &&
    input.reviewCommentCount === 0
  );
}

interface QueueEntryWithDispatch {
  readonly id: string;
  readonly dispatch: { readonly messageId: string } | null;
}

/**
 * Queue entries whose send identity already appears in the thread have been
 * accepted by the server; their local claim can be released without replaying.
 */
export function selectAcknowledgedQueuedMessageIds(input: {
  readonly queuedMessages: ReadonlyArray<QueueEntryWithDispatch>;
  readonly messageIds: ReadonlySet<string>;
}): string[] {
  const acknowledged: string[] = [];
  for (const entry of input.queuedMessages) {
    const dispatch = entry.dispatch;
    if (dispatch && input.messageIds.has(dispatch.messageId)) {
      acknowledged.push(entry.id);
    }
  }
  return acknowledged;
}

/**
 * Splits queued messages into those the normal queue list may control and
 * those whose send is already in flight/unknown. Pending entries keep their
 * durable text but expose no Remove/Steer controls that would imply they can
 * still be cancelled or steered.
 */
export function partitionQueuedMessages(messages: ReadonlyArray<QueuedComposerMessage>): {
  dispatchable: QueuedComposerMessage[];
  pending: QueuedComposerMessage[];
} {
  const dispatchable: QueuedComposerMessage[] = [];
  const pending: QueuedComposerMessage[] = [];
  for (const message of messages) {
    if (message.dispatch === null) {
      dispatchable.push(message);
    } else {
      pending.push(message);
    }
  }
  return { dispatchable, pending };
}

export function buildExpiredTerminalContextToastCopy(
  expiredTerminalContextCount: number,
  variant: "omitted" | "empty",
): { title: string; description: string } {
  const count = Math.max(1, Math.floor(expiredTerminalContextCount));
  const noun = count === 1 ? "Expired terminal context" : "Expired terminal contexts";
  if (variant === "empty") {
    return {
      title: `${noun} won't be sent`,
      description: "Remove it or re-add it to include terminal output.",
    };
  }
  return {
    title: `${noun} omitted from message`,
    description: "Re-add it if you want that terminal output included.",
  };
}

export function threadHasStarted(thread: Thread | null | undefined): boolean {
  return Boolean(
    thread && (thread.latestTurn !== null || thread.messages.length > 0 || thread.session !== null),
  );
}

// `threadProvider` is the open branded driver kind carried by the session.
// Unknown driver kinds degrade to `null` (i.e. "unlocked"), which is the safe
// rollback / fork behavior — the routing layer is the right place to surface
// "driver not installed" errors, not the lock state.
//
// `selectedProvider` takes the same open-string shape because the composer
// now tracks the picker selection as a `ProviderInstanceId` (e.g.
// `codex_personal`). Custom instance ids that don't directly match a
// registered driver resolve to `null` here, which matches the existing
// "unknown driver -> unlocked" semantics. Callers that want the lock to track
// a custom instance's underlying driver kind should resolve the instance id
// upstream and pass the correlated kind.
export function deriveLockedProvider(input: {
  thread: Thread | null | undefined;
  selectedProvider: string | null;
  threadProvider: string | null;
}): ProviderDriverKind | null {
  if (!threadHasStarted(input.thread)) {
    return null;
  }
  const sessionProvider = input.thread?.session?.providerName ?? null;
  if (sessionProvider && isProviderDriverKind(sessionProvider)) {
    return sessionProvider;
  }
  const narrowedThreadProvider =
    input.threadProvider && isProviderDriverKind(input.threadProvider)
      ? input.threadProvider
      : null;
  const narrowedSelectedProvider =
    input.selectedProvider && isProviderDriverKind(input.selectedProvider)
      ? input.selectedProvider
      : null;
  return narrowedThreadProvider ?? narrowedSelectedProvider ?? null;
}

export function getStartedThreadModelChangeBlockReason(input: {
  providers: ReadonlyArray<Pick<ServerProvider, "instanceId" | "requiresNewThreadForModelChange">>;
  hasStartedSession: boolean;
  currentModelSelection: ModelSelection;
  currentProviderInstanceId?: ModelSelection["instanceId"] | null | undefined;
  nextModelSelection: ModelSelection;
}): { title: string; description: string } | null {
  if (!input.hasStartedSession) {
    return null;
  }
  const currentModelSelection = {
    ...input.currentModelSelection,
    instanceId: input.currentProviderInstanceId ?? input.currentModelSelection.instanceId,
  };
  if (
    currentModelSelection.instanceId === input.nextModelSelection.instanceId &&
    currentModelSelection.model === input.nextModelSelection.model
  ) {
    return null;
  }
  const currentProvider = input.providers.find(
    (snapshot) => snapshot.instanceId === currentModelSelection.instanceId,
  );
  const nextProvider = input.providers.find(
    (snapshot) => snapshot.instanceId === input.nextModelSelection.instanceId,
  );
  if (
    currentProvider?.requiresNewThreadForModelChange !== true &&
    nextProvider?.requiresNewThreadForModelChange !== true
  ) {
    return null;
  }
  return {
    title: "Start a new chat to change models",
    description: "This provider does not allow switching models after a conversation has started.",
  };
}

export async function waitForStartedServerThread(
  threadRef: ScopedThreadRef,
  timeoutMs = 1_000,
): Promise<boolean> {
  const threadAtom = environmentThreadDetails.detailAtom(threadRef);
  const getThread = () => appAtomRegistry.get(threadAtom);
  const thread = getThread();

  if (threadHasStarted(thread)) {
    return true;
  }

  return await new Promise<boolean>((resolve) => {
    let settled = false;
    let timeoutId: ReturnType<typeof globalThis.setTimeout> | null = null;
    const finish = (result: boolean) => {
      if (settled) {
        return;
      }
      settled = true;
      if (timeoutId !== null) {
        globalThis.clearTimeout(timeoutId);
      }
      unsubscribe();
      resolve(result);
    };

    const unsubscribe = appAtomRegistry.subscribe(threadAtom, (thread) => {
      if (!threadHasStarted(thread)) {
        return;
      }
      finish(true);
    });

    if (threadHasStarted(getThread())) {
      finish(true);
      return;
    }

    timeoutId = globalThis.setTimeout(() => {
      finish(false);
    }, timeoutMs);
  });
}

export interface LocalDispatchSnapshot {
  startedAt: string;
  preparingWorktree: boolean;
  latestTurnTurnId: TurnId | null;
  latestTurnRequestedAt: string | null;
  latestTurnStartedAt: string | null;
  latestTurnCompletedAt: string | null;
  sessionStatus: NonNullable<Thread["session"]>["status"] | null;
  sessionUpdatedAt: string | null;
}

export function createLocalDispatchSnapshot(
  activeThread: Thread | undefined,
  options: { startedAt: string; preparingWorktree?: boolean },
): LocalDispatchSnapshot {
  const latestTurn = activeThread?.latestTurn ?? null;
  const session = activeThread?.session ?? null;
  return {
    startedAt: options.startedAt,
    preparingWorktree: Boolean(options?.preparingWorktree),
    latestTurnTurnId: latestTurn?.turnId ?? null,
    latestTurnRequestedAt: latestTurn?.requestedAt ?? null,
    latestTurnStartedAt: latestTurn?.startedAt ?? null,
    latestTurnCompletedAt: latestTurn?.completedAt ?? null,
    sessionStatus: session?.status ?? null,
    sessionUpdatedAt: session?.updatedAt ?? null,
  };
}

export function hasServerAcknowledgedLocalDispatch(input: {
  localDispatch: LocalDispatchSnapshot | null;
  phase: SessionPhase;
  latestTurn: Thread["latestTurn"] | null;
  session: Thread["session"] | null;
  hasPendingApproval: boolean;
  hasPendingUserInput: boolean;
  threadError: string | null | undefined;
}): boolean {
  if (!input.localDispatch) {
    return false;
  }
  if (input.hasPendingApproval || input.hasPendingUserInput || Boolean(input.threadError)) {
    return true;
  }

  const latestTurn = input.latestTurn ?? null;
  const session = input.session ?? null;
  const latestTurnChanged =
    input.localDispatch.latestTurnTurnId !== (latestTurn?.turnId ?? null) ||
    input.localDispatch.latestTurnRequestedAt !== (latestTurn?.requestedAt ?? null) ||
    input.localDispatch.latestTurnStartedAt !== (latestTurn?.startedAt ?? null) ||
    input.localDispatch.latestTurnCompletedAt !== (latestTurn?.completedAt ?? null);

  if (input.phase === "running") {
    if (!latestTurnChanged) {
      return false;
    }
    if (latestTurn?.startedAt === null || latestTurn === null) {
      return false;
    }
    if (
      session?.activeTurnId !== null &&
      session?.activeTurnId !== undefined &&
      latestTurn?.turnId !== session.activeTurnId
    ) {
      return false;
    }
    return true;
  }

  return (
    latestTurnChanged ||
    input.localDispatch.sessionStatus !== (session?.status ?? null) ||
    input.localDispatch.sessionUpdatedAt !== (session?.updatedAt ?? null)
  );
}
