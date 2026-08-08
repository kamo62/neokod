import { expect, it } from "@effect/vitest";

import { globToRegExp, matchesAnyPattern } from "./Glob.ts";

it("matches literal paths", () => {
  expect(globToRegExp("src/foo.ts").test("src/foo.ts")).toBe(true);
  expect(globToRegExp("src/foo.ts").test("src/foo2.ts")).toBe(false);
});

it("matches single-segment wildcards", () => {
  expect(globToRegExp("src/*.ts").test("src/foo.ts")).toBe(true);
  expect(globToRegExp("src/*.ts").test("src/foo.js")).toBe(false);
  expect(globToRegExp("src/*.ts").test("src/deep/foo.ts")).toBe(false);
});

it("matches globstar across segments", () => {
  expect(globToRegExp("**/*.test.ts").test("src/foo.test.ts")).toBe(true);
  expect(globToRegExp("**/*.test.ts").test("src/deep/foo.test.ts")).toBe(true);
  expect(globToRegExp("**/*.test.ts").test("foo.test.ts")).toBe(true);
  expect(globToRegExp("tests/**").test("tests/unit/a.test.ts")).toBe(true);
  expect(globToRegExp("tests/**").test("other/unit/a.test.ts")).toBe(false);
});

it("matches single characters", () => {
  expect(globToRegExp("src/fo?.ts").test("src/foo.ts")).toBe(true);
  expect(globToRegExp("src/fo?.ts").test("src/fo.ts")).toBe(false);
});

it("escapes regex metacharacters", () => {
  expect(globToRegExp("src/foo+bar.ts").test("src/foo+bar.ts")).toBe(true);
  expect(globToRegExp("src/foo+bar.ts").test("src/fooxbar.ts")).toBe(false);
});

it("matchesAnyPattern returns true when any pattern matches", () => {
  const patterns = ["**/*.test.ts", "tests/**"];
  expect(matchesAnyPattern("src/unit.test.ts", patterns)).toBe(true);
  expect(matchesAnyPattern("tests/unit/a.ts", patterns)).toBe(true);
  expect(matchesAnyPattern("src/lib.ts", patterns)).toBe(false);
});
