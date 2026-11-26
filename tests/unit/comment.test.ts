import { describe, expect, it, vi } from "vitest";
import { buildCommentBody, postPullRequestComment } from "../../src/comment";

const context = {
  eventName: "pull_request",
  repository: "example/project",
  pullRequest: 42,
  fork: false,
  workflow: "Canary",
  job: "check",
};

describe("PR comments", () => {
  it("bounds oversized comments and describes omitted content", () => {
    const body = buildCommentBody("x".repeat(100_000), "Canary", "check");
    expect(body.length).toBeLessThanOrEqual(60_000);
    expect(body).toContain("omitted");
  });

  it("neutralizes forged marker text", () => {
    const body = buildCommentBody("<!-- protocol-canary-pr-comment:v1 -->", "Canary", "check");
    expect(body.match(/<!-- protocol-canary-pr-comment:v1 -->/g)).toHaveLength(1);
  });

  it("skips fork pull requests", async () => {
    const request = vi.fn();
    await postPullRequestComment("summary", "token", { ...context, fork: true }, request);
    expect(request).not.toHaveBeenCalled();
  });

  it("creates a comment when no existing bot comment matches", async () => {
    const request = vi.fn()
      .mockResolvedValueOnce({ ok: true, json: async () => [] })
      .mockResolvedValueOnce({ ok: true });
    await postPullRequestComment("summary", "token", context, request);
    expect(request).toHaveBeenCalledTimes(2);
    expect(request.mock.calls[1]![1]!.method).toBe("POST");
  });

  it("updates an existing bot comment", async () => {
    const request = vi.fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => [{ id: 7, user: { type: "Bot" }, body: buildCommentBody("old", "Canary", "check") }],
      })
      .mockResolvedValueOnce({ ok: true });
    await postPullRequestComment("new", "token", context, request);
    expect(request.mock.calls[1]![1]!.method).toBe("PATCH");
    expect(request.mock.calls[1]![0]).toContain("/issues/comments/7");
  });

  it("does not fail when permission is denied", async () => {
    const request = vi.fn().mockResolvedValue({ ok: false, status: 403 });
    await expect(postPullRequestComment("summary", "token", context, request)).resolves.toBeUndefined();
  });

  it("skips cleanly outside a pull_request event", async () => {
    const request = vi.fn();
    await expect(
      postPullRequestComment("summary", "token", { ...context, eventName: "push", pullRequest: undefined }, request),
    ).resolves.toBeUndefined();
    expect(request).not.toHaveBeenCalled();
  });

  it("skips cleanly when a pull_request event carries no number", async () => {
    const request = vi.fn();
    await expect(
      postPullRequestComment("summary", "token", { ...context, pullRequest: undefined }, request),
    ).resolves.toBeUndefined();
    expect(request).not.toHaveBeenCalled();
  });

  it("skips malformed repository slugs without calling the API", async () => {
    for (const repository of ["", "no-slash", "/missing-owner", "missing-repo/"]) {
      const request = vi.fn();
      await expect(
        postPullRequestComment("summary", "token", { ...context, repository }, request),
      ).resolves.toBeUndefined();
      expect(request, `repository ${JSON.stringify(repository)} must not be queried`).not.toHaveBeenCalled();
    }
  });

  it("finds an existing bot comment on a later page and updates it", async () => {
    const firstPage = Array.from({ length: 100 }, (_, index) => ({
      id: index + 1,
      user: { type: "User" },
      body: "unrelated comment",
    }));
    const request = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, json: async () => firstPage })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => [{ id: 99, user: { type: "Bot" }, body: buildCommentBody("old", "Canary", "check") }],
      })
      .mockResolvedValueOnce({ ok: true });

    await postPullRequestComment("new", "token", context, request);

    expect(request).toHaveBeenCalledTimes(3);
    expect(request.mock.calls[1]![0]).toContain("page=2");
    expect(request.mock.calls[2]![0]).toContain("/issues/comments/99");
    expect(request.mock.calls[2]![1]!.method).toBe("PATCH");
  });

  it("creates a comment after scanning the bounded page window", async () => {
    const fullPage = () =>
      Array.from({ length: 100 }, (_, index) => ({
        id: index + 1,
        user: { type: "User" },
        body: "unrelated comment",
      }));
    const request = vi.fn();
    for (let page = 1; page <= 10; page++) {
      request.mockResolvedValueOnce({ ok: true, json: async () => fullPage() });
    }
    request.mockResolvedValueOnce({ ok: true });

    await postPullRequestComment("summary", "token", context, request);

    expect(request).toHaveBeenCalledTimes(11);
    expect(request.mock.calls[9]![0]).toContain("page=10");
    expect(request.mock.calls[10]![0]).toContain("/issues/42/comments");
    expect(request.mock.calls[10]![1]!.method).toBe("POST");
  });

  it("reports a non-OK lookup on a later page without throwing", async () => {
    const request = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () =>
          Array.from({ length: 100 }, (_, index) => ({ id: index + 1, user: { type: "User" }, body: "x" })),
      })
      .mockResolvedValueOnce({ ok: false, status: 502 });

    await expect(postPullRequestComment("summary", "token", context, request)).resolves.toBeUndefined();
    expect(request).toHaveBeenCalledTimes(2);
  });
});
