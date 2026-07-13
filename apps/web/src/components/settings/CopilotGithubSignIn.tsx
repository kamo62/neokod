"use client";

import { CheckIcon, CopyIcon, ExternalLinkIcon, LoaderIcon, LogOutIcon } from "lucide-react";
import { useEffect, useReducer, useRef, useState } from "react";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@neokod/client-runtime/state/runtime";

import { usePrimaryEnvironment } from "../../state/environments";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { writeTextToClipboard } from "../../hooks/useCopyToClipboard";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { stackedThreadToast, toastManager } from "../ui/toast";

export type CopilotGithubSignInState =
  | { readonly tag: "idle" }
  | { readonly tag: "starting" }
  | {
      readonly tag: "code_visible";
      readonly flowId: string;
      readonly userCode: string;
      readonly verificationUri: string;
      readonly intervalSeconds: number;
      readonly remainingSeconds: number;
    }
  | { readonly tag: "authorized" }
  | { readonly tag: "signed_in" }
  | { readonly tag: "expired" }
  | { readonly tag: "denied" }
  | { readonly tag: "error"; readonly message: string }
  | { readonly tag: "signing_out" }
  | { readonly tag: "sign_out_error"; readonly message: string };

export type CopilotGithubSignInEvent =
  | { readonly type: "start" }
  | {
      readonly type: "start_succeeded";
      readonly flowId: string;
      readonly userCode: string;
      readonly verificationUri: string;
      readonly expiresInSeconds: number;
      readonly intervalSeconds: number;
    }
  | { readonly type: "start_failed"; readonly message: string }
  | {
      readonly type: "poll";
      readonly status: "pending" | "success" | "expired" | "denied" | "error";
    }
  | { readonly type: "poll_failed" }
  | { readonly type: "countdown_expired" }
  | { readonly type: "refresh_completed" }
  | { readonly type: "sign_out" }
  | { readonly type: "sign_out_succeeded" }
  | { readonly type: "sign_out_not_removed" }
  | { readonly type: "sign_out_failed"; readonly message: string }
  | { readonly type: "reset" };

/** Pure device-login state machine, kept separate from transport and rendering for focused tests. */
export function reduceCopilotGithubSignIn(
  state: CopilotGithubSignInState,
  event: CopilotGithubSignInEvent,
): CopilotGithubSignInState {
  switch (event.type) {
    case "start":
      return state.tag === "starting" ? state : { tag: "starting" };
    case "start_succeeded":
      return {
        tag: "code_visible",
        flowId: event.flowId,
        userCode: event.userCode,
        verificationUri: event.verificationUri,
        intervalSeconds: event.intervalSeconds,
        remainingSeconds: event.expiresInSeconds,
      };
    case "start_failed":
      return { tag: "error", message: event.message };
    case "countdown_expired":
      if (state.tag !== "code_visible") return state;
      return { tag: "expired" };
    case "poll":
      if (state.tag !== "code_visible") return state;
      switch (event.status) {
        case "pending":
          return state;
        case "success":
          return { tag: "authorized" };
        case "expired":
          return { tag: "expired" };
        case "denied":
          return { tag: "denied" };
        case "error":
          return {
            tag: "error",
            message:
              "Sign-in failed. If you signed in at GitHub, the account may lack a Copilot subscription or seat.",
          };
      }
    case "poll_failed":
      return state.tag === "code_visible"
        ? { tag: "error", message: "Could not reach the server. Check your connection and retry." }
        : state;
    case "refresh_completed":
      return state.tag === "authorized" ? { tag: "signed_in" } : state;
    case "sign_out":
      return { tag: "signing_out" };
    case "sign_out_succeeded":
      return { tag: "idle" };
    case "sign_out_not_removed":
      return {
        tag: "sign_out_error",
        message: "Could not remove the stored GitHub token. You are still signed in.",
      };
    case "sign_out_failed":
      return { tag: "sign_out_error", message: event.message };
    case "reset":
      return { tag: "idle" };
  }
}

export function shouldPollDeviceLogin(state: CopilotGithubSignInState): boolean {
  return state.tag === "code_visible";
}

export function isCurrentDeviceLoginGeneration(current: number, candidate: number): boolean {
  return current === candidate;
}

function formatCountdown(seconds: number): string {
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

function commandFailureMessage(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}

export function CopilotGithubSignIn(props: {
  readonly isAuthenticated: boolean;
  readonly providerStatus: string | undefined;
  readonly onRefresh: () => void | Promise<void>;
}) {
  const primaryEnvironment = usePrimaryEnvironment();
  const startDeviceLogin = useAtomCommand(serverEnvironment.copilotDeviceLoginStart, {
    reportFailure: false,
  });
  const getDeviceLoginStatus = useAtomCommand(serverEnvironment.copilotDeviceLoginStatus, {
    reportFailure: false,
  });
  const signOut = useAtomCommand(serverEnvironment.copilotSignOut, { reportFailure: false });
  const [open, setOpen] = useState(false);
  const [state, dispatch] = useReducer(reduceCopilotGithubSignIn, { tag: "idle" });
  const [remainingSeconds, setRemainingSeconds] = useState(0);
  const deviceLoginGeneration = useRef(0);
  const deviceLoginDeadline = useRef<number | null>(null);
  const isStartingDeviceLogin = useRef(false);
  const deviceLoginFlowId = state.tag === "code_visible" ? state.flowId : null;
  const deviceLoginIntervalSeconds = state.tag === "code_visible" ? state.intervalSeconds : null;
  const isDeviceLoginTerminal = state.tag !== "code_visible";

  useEffect(() => {
    if (state.tag !== "code_visible") return;
    const updateCountdown = () => {
      const deadline = deviceLoginDeadline.current;
      if (deadline === null) return;
      const nextRemainingSeconds = Math.max(0, Math.ceil((deadline - Date.now()) / 1_000));
      setRemainingSeconds(nextRemainingSeconds);
      if (nextRemainingSeconds === 0) dispatch({ type: "countdown_expired" });
    };
    updateCountdown();
    const interval = window.setInterval(updateCountdown, 1_000);
    return () => window.clearInterval(interval);
  }, [state.tag]);

  useEffect(() => {
    if (
      isDeviceLoginTerminal ||
      !primaryEnvironment ||
      !deviceLoginFlowId ||
      !deviceLoginIntervalSeconds
    ) {
      return;
    }
    const generation = deviceLoginGeneration.current;
    const interval = window.setInterval(() => {
      void (async () => {
        const result = await getDeviceLoginStatus({
          environmentId: primaryEnvironment.environmentId,
          input: { flowId: deviceLoginFlowId },
        });
        if (!isCurrentDeviceLoginGeneration(deviceLoginGeneration.current, generation)) return;
        if (result._tag === "Success") {
          dispatch({ type: "poll", status: result.value.status });
        } else if (!isAtomCommandInterrupted(result)) {
          dispatch({ type: "poll_failed" });
        }
      })();
    }, deviceLoginIntervalSeconds * 1_000);
    return () => window.clearInterval(interval);
  }, [
    deviceLoginFlowId,
    deviceLoginIntervalSeconds,
    getDeviceLoginStatus,
    isDeviceLoginTerminal,
    primaryEnvironment,
  ]);

  useEffect(() => {
    if (state.tag !== "authorized") return;
    void Promise.resolve(props.onRefresh()).then(() => dispatch({ type: "refresh_completed" }));
  }, [props.onRefresh, state.tag]);

  const begin = async () => {
    if (isStartingDeviceLogin.current || state.tag === "starting") return;
    if (!primaryEnvironment) {
      dispatch({ type: "start_failed", message: "No active environment." });
      return;
    }
    const generation = ++deviceLoginGeneration.current;
    isStartingDeviceLogin.current = true;
    dispatch({ type: "start" });
    const result = await startDeviceLogin({
      environmentId: primaryEnvironment.environmentId,
      input: {},
    });
    if (!isCurrentDeviceLoginGeneration(deviceLoginGeneration.current, generation)) return;
    isStartingDeviceLogin.current = false;
    if (result._tag === "Success") {
      deviceLoginDeadline.current = Date.now() + result.value.expiresInSeconds * 1_000;
      setRemainingSeconds(result.value.expiresInSeconds);
      dispatch({ type: "start_succeeded", ...result.value });
    } else {
      dispatch({
        type: "start_failed",
        message: isAtomCommandInterrupted(result)
          ? "GitHub sign-in was interrupted. Try again."
          : commandFailureMessage(
              squashAtomCommandFailure(result),
              "Could not start GitHub sign-in.",
            ),
      });
    }
  };

  const copyCode = async () => {
    if (state.tag !== "code_visible") return;
    try {
      await writeTextToClipboard(state.userCode, "GitHub device code");
      toastManager.add({ type: "success", title: "GitHub device code copied" });
    } catch (error) {
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: "Could not copy GitHub device code",
          description: commandFailureMessage(error, "Clipboard access is unavailable."),
        }),
      );
    }
  };

  const handleSignOut = async () => {
    if (!primaryEnvironment) {
      dispatch({ type: "sign_out_failed", message: "No active environment." });
      return;
    }
    dispatch({ type: "sign_out" });
    const result = await signOut({ environmentId: primaryEnvironment.environmentId, input: {} });
    if (result._tag === "Success" && result.value.signedOut) {
      await props.onRefresh();
      dispatch({ type: "sign_out_succeeded" });
      return;
    }
    if (result._tag === "Success") {
      dispatch({ type: "sign_out_not_removed" });
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: "Could not sign out of GitHub Copilot",
          description: "The stored GitHub token could not be removed. You are still signed in.",
        }),
      );
      return;
    }
    dispatch({
      type: "sign_out_failed",
      message: commandFailureMessage(
        squashAtomCommandFailure(result),
        "Could not sign out of GitHub Copilot.",
      ),
    });
  };

  const showSignedIn =
    props.isAuthenticated || state.tag === "signed_in" || state.tag === "signing_out";
  const close = (nextOpen: boolean) => {
    setOpen(nextOpen);
    if (!nextOpen) {
      deviceLoginGeneration.current += 1;
      isStartingDeviceLogin.current = false;
      deviceLoginDeadline.current = null;
      setRemainingSeconds(0);
      if (state.tag !== "signing_out") dispatch({ type: "reset" });
    }
  };

  return (
    <Dialog open={open} onOpenChange={close}>
      <Button
        type="button"
        size="xs"
        variant="outline"
        className="w-fit shrink-0"
        onClick={() => setOpen(true)}
      >
        {showSignedIn ? "GitHub Copilot" : "Sign in with GitHub"}
      </Button>
      <DialogPopup className="max-w-md">
        <DialogHeader>
          <DialogTitle>GitHub Copilot sign-in</DialogTitle>
          <DialogDescription>
            A GitHub account with a Copilot subscription or assigned seat is required.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel className="space-y-4">
          <div aria-live="polite" className="text-sm text-muted-foreground">
            {state.tag === "starting" ? "Starting GitHub sign-in..." : null}
            {state.tag === "code_visible" ? (
              <div className="space-y-3">
                <p>Enter this code at GitHub:</p>
                <Button
                  type="button"
                  variant="outline"
                  className="h-auto w-full py-4 font-mono text-2xl tracking-widest"
                  onClick={() => void copyCode()}
                  aria-label="Copy code"
                >
                  {state.userCode} <CopyIcon />
                </Button>
                <p>
                  Code expires in {formatCountdown(remainingSeconds)}. Waiting for authorization...
                </p>
                <Button
                  type="button"
                  variant="outline"
                  onClick={() =>
                    window.open(state.verificationUri, "_blank", "noopener,noreferrer")
                  }
                >
                  <ExternalLinkIcon /> Open github.com/login/device
                </Button>
              </div>
            ) : null}
            {state.tag === "authorized" ? "Authorized. Verifying Copilot access..." : null}
            {state.tag === "signed_in"
              ? `Signed in. Provider status: ${props.providerStatus ?? "authenticated"}.`
              : null}
            {state.tag === "expired" ? "Code expired." : null}
            {state.tag === "denied" ? "Sign-in was denied." : null}
            {state.tag === "error" || state.tag === "sign_out_error" ? state.message : null}
            {state.tag === "signing_out" ? "Signing out..." : null}
            {state.tag === "idle" && showSignedIn
              ? `Signed in. Provider status: ${props.providerStatus ?? "authenticated"}.`
              : null}
          </div>
        </DialogPanel>
        <DialogFooter>
          {showSignedIn && state.tag !== "signing_out" ? (
            <Button type="button" variant="outline" onClick={() => void handleSignOut()}>
              <LogOutIcon /> Sign out
            </Button>
          ) : null}
          {state.tag === "idle" && !showSignedIn ? (
            <Button type="button" onClick={() => void begin()}>
              Sign in with GitHub
            </Button>
          ) : null}
          {state.tag === "starting" || state.tag === "signing_out" ? (
            <Button type="button" disabled>
              <LoaderIcon className="animate-spin" /> Please wait
            </Button>
          ) : null}
          {state.tag === "expired" ||
          state.tag === "denied" ||
          state.tag === "error" ||
          state.tag === "sign_out_error" ? (
            <Button type="button" onClick={() => void begin()}>
              <CheckIcon /> Try again
            </Button>
          ) : null}
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
