import { describe, expect, it } from "vitest";

import { isExactGithubApiUrl, parseSafeHttpsUrl } from "../../src/safe-url";

describe("parseSafeHttpsUrl (#607)", () => {
  it("accepts valid standard HTTPS URLs", () => {
    const result = parseSafeHttpsUrl("https://api.github.com/repos/test/repo");
    expect(result.url).toBeDefined();
    expect(result.url?.hostname).toBe("api.github.com");
    expect(result.reason).toBeUndefined();
  });

  it("accepts valid IPv6 bracketed hosts", () => {
    const result1 = parseSafeHttpsUrl("https://[::1]/path");
    expect(result1.url).toBeDefined();
    expect(result1.url?.hostname).toBe("[::1]");
    expect(result1.reason).toBeUndefined();

    const result2 = parseSafeHttpsUrl("https://[2001:db8::1]/test/endpoint");
    expect(result2.url).toBeDefined();
    expect(result2.url?.hostname).toBe("[2001:db8::1]");
    expect(result2.reason).toBeUndefined();
  });

  it("rejects non-HTTPS schemes", () => {
    expect(parseSafeHttpsUrl("http://example.com/api").reason).toBe("URL must use HTTPS");
    expect(parseSafeHttpsUrl("ftp://example.com/file").reason).toBe("URL must use HTTPS");
    expect(parseSafeHttpsUrl("javascript:alert(1)").reason).toBe("an absolute HTTPS URL with an authority is required");
  });

  it("rejects percent-encoded authorities", () => {
    const res = parseSafeHttpsUrl("https://api%2Egithub.com/path");
    expect(res.reason).toBe("percent-encoded URL authorities are not allowed");
  });

  it("rejects embedded userinfo", () => {
    const res = parseSafeHttpsUrl("https://user:pass@api.github.com/path");
    expect(res.reason).toBe("URL userinfo is not allowed");
  });

  it("rejects explicit ports", () => {
    const res = parseSafeHttpsUrl("https://api.github.com:8443/path");
    expect(res.reason).toBe("non-default URL ports are not allowed");
  });

  it("rejects backslashes, control characters, and malformed URLs", () => {
    expect(parseSafeHttpsUrl("https://api.github.com\\path").reason).toBe("backslashes are not allowed in URLs");
    expect(parseSafeHttpsUrl("https://api.github.com/\x01path").reason).toBe("control characters are not allowed in URLs");
    expect(parseSafeHttpsUrl("not a url").reason).toBe("an absolute HTTPS URL with an authority is required");
    expect(parseSafeHttpsUrl("https://").reason).toBe("a non-empty URL authority is required");
  });
});

describe("isExactGithubApiUrl (#607)", () => {
  it("returns true only for exact api.github.com host", () => {
    expect(isExactGithubApiUrl("https://api.github.com/repos/owner/repo")).toBe(true);
    expect(isExactGithubApiUrl("https://API.GITHUB.COM/releases")).toBe(true);
  });

  it("returns false for other domains or subdomains", () => {
    expect(isExactGithubApiUrl("https://github.com/owner/repo")).toBe(false);
    expect(isExactGithubApiUrl("https://fake-api.github.com/repos")).toBe(false);
    expect(isExactGithubApiUrl("https://api.github.com.attacker.com/repos")).toBe(false);
    expect(isExactGithubApiUrl("http://api.github.com/repos")).toBe(false);
    expect(isExactGithubApiUrl("https://[::1]/repos")).toBe(false);
  });
});
