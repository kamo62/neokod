import { describe, expect, it } from "@effect/vitest";

import { changeRequestRepositoryKey } from "./ChangeRequestUrl.ts";

describe("changeRequestRepositoryKey", () => {
  it("keeps the effective host and port", () => {
    const first = changeRequestRepositoryKey(
      "https://gitlab.example:8443/group/repo/-/merge_requests/42",
    );
    const second = changeRequestRepositoryKey(
      "https://gitlab.example:9443/group/repo/-/merge_requests/42",
    );
    expect(first).toBe("https://gitlab.example:8443/group/repo");
    expect(second).toBe("https://gitlab.example:9443/group/repo");
    expect(first).not.toBe(second);
    // A default port is the same repository as no port.
    expect(changeRequestRepositoryKey("https://github.com/owner/repo/pull/42")).toBe(
      changeRequestRepositoryKey("https://github.com:443/owner/repo/pull/42"),
    );
  });

  it("parses a recognised change-request suffix instead of the first marker", () => {
    // An owner legitimately named `pull` must not collapse the repository path.
    const first = changeRequestRepositoryKey("https://github.com/pull/a/pull/42");
    const second = changeRequestRepositoryKey("https://github.com/pull/b/pull/42");
    expect(first).toBe("https://github.com:443/pull/a");
    expect(second).toBe("https://github.com:443/pull/b");
    expect(first).not.toBe(second);
  });

  it("normalises each provider's change-request URL shape", () => {
    expect(changeRequestRepositoryKey("https://github.com/owner/repo/pull/42")).toBe(
      "https://github.com:443/owner/repo",
    );
    expect(changeRequestRepositoryKey("https://gitlab.com/group/project/-/merge_requests/42")).toBe(
      "https://gitlab.com:443/group/project",
    );
    expect(changeRequestRepositoryKey("https://bitbucket.org/owner/repo/pull-requests/42")).toBe(
      "https://bitbucket.org:443/owner/repo",
    );
    expect(
      changeRequestRepositoryKey("https://dev.azure.com/org/project/_git/repo/pullrequest/42"),
    ).toBe("https://dev.azure.com:443/org/project/_git/repo");
    expect(changeRequestRepositoryKey("https://gitea.example/owner/repo/pulls/42")).toBe(
      "https://gitea.example:443/owner/repo",
    );
  });

  it("treats a leading www host as an alias but keeps path casing", () => {
    expect(changeRequestRepositoryKey("https://www.github.com/owner/repo/pull/42")).toBe(
      changeRequestRepositoryKey("https://github.com/owner/repo/pull/42"),
    );
    expect(changeRequestRepositoryKey("https://gitlab.com/Group/Repo/-/merge_requests/42")).toBe(
      "https://gitlab.com:443/Group/Repo",
    );
    expect(
      changeRequestRepositoryKey("https://gitlab.com/Group/Repo/-/merge_requests/42"),
    ).not.toBe(changeRequestRepositoryKey("https://gitlab.com/group/repo/-/merge_requests/42"));
  });

  it("ignores trailing slashes and query strings", () => {
    expect(changeRequestRepositoryKey("https://github.com/owner/repo/pull/42/?diff=split")).toBe(
      "https://github.com:443/owner/repo",
    );
  });

  it("keeps distinct authorities distinct", () => {
    // Two independent installations may serve the same path and number. Only
    // the established github.com alias is normalised.
    expect(changeRequestRepositoryKey("https://www.git.example/owner/repo/pull/42")).not.toBe(
      changeRequestRepositoryKey("https://git.example/owner/repo/pull/42"),
    );
    // The scheme is part of the effective authority: http://host and
    // https://host can be independent installations on ports 80 and 443.
    expect(changeRequestRepositoryKey("http://git.example/owner/repo/pull/42")).not.toBe(
      changeRequestRepositoryKey("https://git.example/owner/repo/pull/42"),
    );
    expect(changeRequestRepositoryKey("http://git.example/owner/repo/pull/42")).toBe(
      changeRequestRepositoryKey("http://git.example:80/owner/repo/pull/42"),
    );
    expect(changeRequestRepositoryKey("https://git.example/owner/repo/pull/42")).toBe(
      changeRequestRepositoryKey("https://git.example:443/owner/repo/pull/42"),
    );
  });

  it("returns null when the URL cannot identify a repository", () => {
    expect(changeRequestRepositoryKey(undefined)).toBeNull();
    expect(changeRequestRepositoryKey("not a url")).toBeNull();
    expect(changeRequestRepositoryKey("https://github.com/owner/repo")).toBeNull();
    expect(changeRequestRepositoryKey("https://github.com/pull/42")).toBeNull();
    expect(changeRequestRepositoryKey("https://github.com/owner/repo/issues/42")).toBeNull();
  });
});
