import { PRIMARY_LOCAL_ENVIRONMENT_ID } from "@neokod/contracts";
import { describe, expect, it } from "@effect/vitest";

import {
  primaryRegistrationToRetainAfterTopologyRead,
  readPrimaryEnvironmentTargetResult,
  secondaryRegistrationsToRetainAfterTopologyRead,
} from "./platform.ts";

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
});
