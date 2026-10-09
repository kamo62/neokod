import { PRIMARY_LOCAL_ENVIRONMENT_ID } from "@neokod/contracts";
import { describe, expect, it } from "@effect/vitest";

import {
  primaryRegistrationSignature,
  primaryRegistrationToRetainAfterTopologyRead,
  readPrimaryEnvironmentTargetResult,
  secondaryRegistrationsToRetainAfterTopologyRead,
} from "./platform.ts";
import type { PrimaryEnvironmentTarget } from "../environments/primary/target.ts";

describe("local platform topology cache", () => {
  const registration = {} as never;
  const cached = { signature: "local-signature", registration };

  it("captures synchronous primary target read failures", () => {
    const cause = new Error("invalid primary target");
    expect(
      readPrimaryEnvironmentTargetResult(() => {
        throw cause;
      }),
    ).toEqual({ _tag: "Failure", cause });
  });

  it("retains only in-memory topology after a bridge read failure", () => {
    const previous = new Map([
      [PRIMARY_LOCAL_ENVIRONMENT_ID, cached],
      ["wsl:ubuntu", { signature: "wsl-signature", registration }],
    ]);
    expect(
      primaryRegistrationToRetainAfterTopologyRead(previous, {
        _tag: "Failure",
        cause: new Error("IPC unavailable"),
      }),
    ).toBe(cached);
    expect(
      secondaryRegistrationsToRetainAfterTopologyRead(previous, {
        _tag: "Failure",
        cause: new Error("IPC unavailable"),
      }),
    ).toEqual(new Map([["wsl:ubuntu", { signature: "wsl-signature", registration }]]));
  });

  it("treats a successful empty topology as authoritative removal", () => {
    const previous = new Map([["wsl:ubuntu", cached]]);
    expect(
      secondaryRegistrationsToRetainAfterTopologyRead(previous, {
        _tag: "Success",
        bootstraps: [],
      }),
    ).toEqual(new Map());
  });

  it("primaryRegistrationSignature changes when the loopback token changes", () => {
    const base: PrimaryEnvironmentTarget = {
      source: "window-origin",
      target: {
        httpBaseUrl: "http://127.0.0.1:3773/",
        wsBaseUrl: "ws://127.0.0.1:3773/",
      },
      transport: { _tag: "Loopback", loopbackAuthToken: "one" },
    };
    expect(primaryRegistrationSignature(base)).not.toBe(
      primaryRegistrationSignature({
        ...base,
        transport: { _tag: "Loopback", loopbackAuthToken: "two" },
      }),
    );
  });

  it("primaryRegistrationSignature is stable for the same inputs", () => {
    const target: PrimaryEnvironmentTarget = {
      source: "window-origin",
      target: {
        httpBaseUrl: "http://127.0.0.1:3773/",
        wsBaseUrl: "ws://127.0.0.1:3773/",
      },
      transport: { _tag: "Loopback", loopbackAuthToken: "one" },
    };
    expect(primaryRegistrationSignature(target)).toBe(primaryRegistrationSignature({ ...target }));
  });
});
