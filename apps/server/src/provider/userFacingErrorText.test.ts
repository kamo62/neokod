import * as Cause from "effect/Cause";
import { describe, expect, it } from "vite-plus/test";

import { ProviderAdapterRequestError, ProviderValidationError } from "./Errors.ts";
import {
  GENERIC_INTERNAL_ERROR_DETAIL,
  scrubErrorText,
  userFacingFailureDetail,
} from "./userFacingErrorText.ts";

describe("scrubErrorText", () => {
  it("strips stack frames", () => {
    expect(
      scrubErrorText(
        "ProviderValidationError: Provider validation failed in ProviderService.interruptTurn: boom\n    at toValidationError (file:///Users/kamogelo/Code/t3code/apps/server/dist/bin.mjs:40875:9)\n    at next (/Users/kamogelo/Code/t3code/a.js:1:2)",
      ),
    ).toBe(
      "ProviderValidationError: Provider validation failed in ProviderService.interruptTurn: boom",
    );
  });

  it("replaces absolute paths but keeps the file name", () => {
    expect(
      scrubErrorText(
        "ENOENT: no such file or directory, open '/Users/kamogelo/Code/t3code/crash.txt'",
      ),
    ).toBe("ENOENT: no such file or directory, open '[path]/crash.txt'");
    expect(scrubErrorText("C:\\Users\\me\\proj\\a.txt missing")).toBe("[path]/a.txt missing");
    expect(scrubErrorText("see file:///Users/me/x.mjs:1:2")).toBe("see [path]");
  });

  it("leaves URLs, ids and relative paths alone", () => {
    const text = "GET https://api.example.com/v1/models failed for anthropic/claude-3 in src/a.ts";
    expect(scrubErrorText(text)).toBe(text);
  });
});

describe("userFacingFailureDetail", () => {
  it("uses the message of a typed error without a stack", () => {
    expect(
      userFacingFailureDetail(
        Cause.fail(
          new ProviderValidationError({
            operation: "ProviderService.interruptTurn",
            issue: "x",
          }),
        ),
      ),
    ).toBe("Provider validation failed in ProviderService.interruptTurn: x");
  });

  it("keeps the detail of request errors", () => {
    expect(
      userFacingFailureDetail(
        Cause.fail(
          new ProviderAdapterRequestError({
            provider: "codex",
            method: "m",
            detail: "interrupt failed",
          }),
        ),
      ),
    ).toBe("interrupt failed");
  });

  it("hides defects", () => {
    expect(userFacingFailureDetail(Cause.die(new Error("boom /Users/a/b.ts")))).toBe(
      GENERIC_INTERNAL_ERROR_DETAIL,
    );
  });

  it("truncates long text", () => {
    const detail = userFacingFailureDetail(Cause.fail(new Error("x".repeat(5000))));
    expect(detail).toHaveLength(2003);
    expect(detail.endsWith("...")).toBe(true);
  });
});
