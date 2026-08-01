import { describe, expect, it } from "vite-plus/test";

import {
  canonicalRepositoryKey,
  nextFreeVersion,
  parseGitRemoteList,
  parsePublishedVersions,
  readChangelogVersion,
  resolveReleaseRemotes,
} from "./check-changelog-version.ts";

describe("release remote resolution", () => {
  it("matches the release repository instead of blindly using origin", () => {
    const remotes = parseGitRemoteList(
      [
        "origin\thttps://github.com/kamo62/t3code.git (fetch)",
        "origin\thttps://github.com/kamo62/t3code.git (push)",
        "neokod\tgit@github.com:kamo62/neokod.git (fetch)",
        "neokod\tgit@github.com:kamo62/neokod.git (push)",
      ].join("\n"),
    );

    expect(resolveReleaseRemotes(remotes, "https://github.com/kamo62/neokod")).toEqual([
      { name: "neokod", url: "git@github.com:kamo62/neokod.git" },
    ]);
  });

  it("uses the only matching origin, as a single-origin CI checkout requires", () => {
    const remotes = [{ name: "origin", url: "https://github.com/kamo62/neokod.git" }];
    expect(resolveReleaseRemotes(remotes, "https://github.com/kamo62/neokod")).toEqual(remotes);
  });

  it("fails when multiple remotes do not identify the release repository", () => {
    expect(() =>
      resolveReleaseRemotes(
        [
          { name: "origin", url: "https://github.com/kamo62/t3code.git" },
          { name: "upstream", url: "https://github.com/pingdotgg/t3code.git" },
        ],
        "https://github.com/kamo62/neokod",
      ),
    ).toThrow("Cannot determine the release remote");
  });

  it("fails when no remote is configured", () => {
    expect(() => resolveReleaseRemotes([], "https://github.com/kamo62/neokod")).toThrow(
      "no Git remotes configured",
    );
  });

  it("normalizes HTTPS, SSH and scp-style repository URLs", () => {
    expect(canonicalRepositoryKey("https://github.com/Kamo62/neokod.git")).toBe(
      "github.com/kamo62/neokod",
    );
    expect(canonicalRepositoryKey("ssh://git@github.com/kamo62/neokod.git")).toBe(
      "github.com/kamo62/neokod",
    );
    expect(canonicalRepositoryKey("git@github.com:kamo62/neokod.git")).toBe(
      "github.com/kamo62/neokod",
    );
  });
});

describe("parsePublishedVersions", () => {
  it("reads npm's JSON version list, including a single-version response", () => {
    expect(parsePublishedVersions('["3.5.11", "3.5.12", "3.5.13"]')).toEqual(
      new Set(["3.5.11", "3.5.12", "3.5.13"]),
    );
    expect(parsePublishedVersions('"3.5.11"')).toEqual(new Set(["3.5.11"]));
  });
});

describe("readChangelogVersion", () => {
  it("reads the first heading the way release.yml does", () => {
    expect(readChangelogVersion("## 3.5.9 - 2026-07-30 (Patch)\n\n- Something\n")).toBe("3.5.9");
  });

  it("tolerates a leading v", () => {
    expect(readChangelogVersion("## v3.5.9 - 2026-07-30 (Patch)\n")).toBe("3.5.9");
  });

  it("ignores content above the first heading", () => {
    expect(readChangelogVersion("# Changelog\n\nBlurb.\n\n## 4.0.0 - 2026-08-01 (Major)\n")).toBe(
      "4.0.0",
    );
  });

  it("rejects a first heading that is not a version", () => {
    expect(() => readChangelogVersion("## Unreleased\n")).toThrow();
  });

  it("rejects a changelog with no heading", () => {
    expect(() => readChangelogVersion("- just a bullet\n")).toThrow();
  });
});

describe("nextFreeVersion", () => {
  it("returns the version unchanged when nothing is taken", () => {
    expect(nextFreeVersion("3.5.9", new Set())).toBe("3.5.9");
  });

  it("walks past a run of taken patches", () => {
    // The real case: 3.5.6 and 3.5.7 were both released while a branch sat open
    // writing 3.5.6, so the suggestion has to clear both.
    expect(nextFreeVersion("3.5.6", new Set(["3.5.6", "3.5.7", "3.5.8"]))).toBe("3.5.9");
  });

  it("leaves a non-numeric version alone rather than guessing", () => {
    expect(nextFreeVersion("3.5.9-beta.1", new Set(["3.5.9-beta.1"]))).toBe("3.5.9-beta.1");
  });
});
