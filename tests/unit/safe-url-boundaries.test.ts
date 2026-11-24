import { describe, expect, it } from "vitest";

import { isExactGithubApiUrl, parseSafeHttpsUrl } from "../../src/safe-url";

// Raw backslashes: the WHATWG parser treats "\" like "/" in special schemes,
// which could make these appear to target a trusted host.
const BACKSLASH_URLS = [
  "https://api.github.com\\@evil.example/repos",
  "https://api.github.com\\.evil.example/repos",
  "https://evil.example\\@api.github.com/repos",
  "https://api.github.com\\repos\\octo\\repo",
  "https://api.github.com/repos\\octo/repo",
  "https://api.github.com/repos/octo/repo\\..\\..\\other",
  "https://api.github.com/\\evil.example/path",
  "https://api.github.com?x=1\\y",
  "https://api.github.com/#frag\\ment",
];

describe("backslash-based URL rejection (#574)", () => {
  it.each(BACKSLASH_URLS)("parseSafeHttpsUrl rejects %s", (raw) => {
    const result = parseSafeHttpsUrl(raw);
    expect(result.url).toBeUndefined();
    expect(result.reason).toBeDefined();
  });

  it.each(BACKSLASH_URLS)("isExactGithubApiUrl returns false for %s", (raw) => {
    expect(isExactGithubApiUrl(raw)).toBe(false);
  });

  it("reports the backslash reason for authority and path cases", () => {
    for (const raw of ["https://api.github.com\\@evil.example/repos", "https://api.github.com/repos\\octo/repo"]) {
      expect(parseSafeHttpsUrl(raw).reason).toBe("backslashes are not allowed in URLs");
    }
  });

  it("still accepts the same URL without the backslash", () => {
    expect(isExactGithubApiUrl("https://api.github.com/repos/octo/repo")).toBe(true);
  });
});
