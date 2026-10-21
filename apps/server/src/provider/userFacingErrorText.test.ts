import * as Cause from "effect/Cause";
import { describe, expect, it } from "vite-plus/test";

import { ProviderAdapterRequestError, ProviderValidationError } from "./Errors.ts";
import {
  GENERIC_INTERNAL_ERROR_DETAIL,
  REDACTED_ERROR_DETAIL,
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
    expect(scrubErrorText("C:/Users/me/proj/a.txt missing")).toBe("[path]/a.txt missing");
    expect(scrubErrorText("\\\\server\\share\\deep\\a.txt missing")).toBe("[path]/a.txt missing");
    expect(scrubErrorText("//server/share/deep/a.txt missing")).toBe("[path]/a.txt missing");
    expect(scrubErrorText("see file:///Users/me/x.mjs:1:2")).toBe("see [path]");
  });

  it("covers root files, colon-adjacent paths, quoted spaces and home paths", () => {
    expect(scrubErrorText("read /etc/passwd first")).toBe("read [path]/passwd first");
    expect(scrubErrorText("open /Users/me/a.ts:12:3")).toBe("open [path]/a.ts:12:3");
    expect(scrubErrorText("open '/Users/me/My Documents/file.txt' failed")).toBe(
      "open '[path]/file.txt' failed",
    );
    expect(scrubErrorText('"C:\\Program Files\\App\\a.txt" missing')).toBe(
      '"[path]/a.txt" missing',
    );
    expect(scrubErrorText("open '\\\\server\\share\\My Folder\\a.txt'")).toBe(
      "open '[path]/a.txt'",
    );
    expect(scrubErrorText("read ~/.ssh/id_ed25519")).toBe("read [path]/id_ed25519");
    expect(scrubErrorText("read $HOME/secret/file")).toBe("read [path]/file");
    expect(scrubErrorText("read /home/kamogelo/private")).toBe("read [path]/private");
    expect(scrubErrorText("ENOENT: open `/Users/alice/private/a.txt`")).toBe(
      "ENOENT: open `[path]/a.txt`",
    );
  });

  it("leaves URLs, ids and punctuation-bearing relative paths alone", () => {
    const text =
      "GET https://api.example.com/v1/models?path=/Users/me/x&q=src/(generated)/deep/file.ts failed for anthropic/claude-3 in src/(generated)/deep/file.ts";
    expect(scrubErrorText(text)).toBe(text);
  });

  it("preserves valid apostrophes inside URL queries", () => {
    const url = "https://api.example.com/v1?name=O'Reilly&redirect=/docs/api";
    expect(scrubErrorText(`GET ${url} failed`)).toBe(`GET ${url} failed`);
    expect(scrubErrorText(`'${url}'`)).toBe(`'${url}'`);
    expect(scrubErrorText(`"${url}"`)).toBe(`"${url}"`);
  });

  it("leaves backtick-quoted relative paths alone", () => {
    const text = "run `src/(generated)/deep/file.ts` and `pnpm --filter @neokod/web test`";
    expect(scrubErrorText(text)).toBe(text);
  });

  it("keeps ordinary at language and only strips stack frames", () => {
    expect(scrubErrorText("Retry at most 3 times")).toBe("Retry at most 3 times");
    expect(
      scrubErrorText(
        "failed\n    at Object.<anonymous> (/Users/me/a.js:1:2)\n    at async Worker.process (node:internal/worker:123:4)",
      ),
    ).toBe("failed");
  });

  it("returns a non-empty fallback when every line was a stack frame", () => {
    expect(scrubErrorText("  \n    at foo (/Users/me/a.ts:1:2)\n")).toBe(REDACTED_ERROR_DETAIL);
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
