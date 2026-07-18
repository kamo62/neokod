import { describe, expect, it } from "vite-plus/test";

import {
  isCurrentDeviceLoginGeneration,
  getCopilotSignInStatusMessage,
  reduceCopilotGithubSignIn,
  shouldPollDeviceLogin,
  type CopilotGithubSignInState,
} from "./CopilotGithubSignIn";

const visible: CopilotGithubSignInState = {
  tag: "code_visible",
  flowId: "flow-1",
  userCode: "ABCD-EFGH",
  verificationUri: "https://github.com/login/device",
  intervalSeconds: 5,
  remainingSeconds: 10,
};

describe("reduceCopilotGithubSignIn", () => {
  it("shows a provider creation error instead of stale disabled status", () => {
    expect(
      getCopilotSignInStatusMessage({
        providerStatus: "disabled",
        providerError: "Driver 'githubCopilot' failed to create instance: incompatible runtime",
      }),
    ).toBe("Driver 'githubCopilot' failed to create instance: incompatible runtime");
  });

  it("starts from idle and exposes a returned device code", () => {
    expect(reduceCopilotGithubSignIn({ tag: "idle" }, { type: "start" })).toEqual({
      tag: "starting",
    });
    expect(
      reduceCopilotGithubSignIn(
        { tag: "starting" },
        { type: "start_succeeded", ...visible, expiresInSeconds: 10 },
      ),
    ).toEqual(visible);
  });

  it("keeps waiting when polling is pending", () => {
    expect(reduceCopilotGithubSignIn(visible, { type: "poll", status: "pending" })).toEqual(
      visible,
    );
  });

  it("moves to authorization verification when polling succeeds", () => {
    expect(reduceCopilotGithubSignIn(visible, { type: "poll", status: "success" })).toEqual({
      tag: "authorized",
    });
    expect(reduceCopilotGithubSignIn({ tag: "authorized" }, { type: "refresh_completed" })).toEqual(
      { tag: "signed_in" },
    );
  });

  it("handles expired, denied, and error polling outcomes", () => {
    expect(reduceCopilotGithubSignIn(visible, { type: "poll", status: "expired" })).toEqual({
      tag: "expired",
    });
    expect(reduceCopilotGithubSignIn(visible, { type: "poll", status: "denied" })).toEqual({
      tag: "denied",
    });
    expect(reduceCopilotGithubSignIn(visible, { type: "poll", status: "error" })).toEqual({
      tag: "error",
      message:
        "Sign-in failed. If you signed in at GitHub, the account may lack a Copilot subscription or seat.",
    });
  });

  it("expires locally when the countdown reaches zero before a status response", () => {
    expect(reduceCopilotGithubSignIn(visible, { type: "countdown_expired" })).toEqual({
      tag: "expired",
    });
  });

  it("ignores a stale status response after local expiry", () => {
    const expired = reduceCopilotGithubSignIn(visible, { type: "countdown_expired" });
    expect(reduceCopilotGithubSignIn(expired, { type: "poll", status: "success" })).toEqual(
      expired,
    );
  });

  it("ignores duplicate starts while already starting", () => {
    const starting = reduceCopilotGithubSignIn({ tag: "idle" }, { type: "start" });
    expect(reduceCopilotGithubSignIn(starting, { type: "start" })).toBe(starting);
  });

  it("ignores a start result after closing the dialog mid-start", () => {
    expect(isCurrentDeviceLoginGeneration(5, 4)).toBe(false);
  });

  it("ignores a poll result after closing the dialog mid-poll", () => {
    expect(isCurrentDeviceLoginGeneration(8, 7)).toBe(false);
  });

  it("stops polling after every terminal state", () => {
    for (const terminalState of [
      { tag: "authorized" },
      { tag: "expired" },
      { tag: "denied" },
      { tag: "error", message: "failed" },
    ] satisfies CopilotGithubSignInState[]) {
      expect(shouldPollDeviceLogin(terminalState)).toBe(false);
    }
    expect(shouldPollDeviceLogin(visible)).toBe(true);
  });

  it("uses a distinct message for local polling failures", () => {
    expect(reduceCopilotGithubSignIn(visible, { type: "poll_failed" })).toEqual({
      tag: "error",
      message: "Could not reach the server. Check your connection and retry.",
    });
  });

  it("keeps a failed sign-out as an error instead of claiming the user signed out", () => {
    expect(reduceCopilotGithubSignIn({ tag: "signed_in" }, { type: "sign_out" })).toEqual({
      tag: "signing_out",
    });
    expect(
      reduceCopilotGithubSignIn({ tag: "signing_out" }, { type: "sign_out_not_removed" }),
    ).toEqual({
      tag: "sign_out_error",
      message: "Could not remove the stored GitHub token. You are still signed in.",
    });
  });
});
