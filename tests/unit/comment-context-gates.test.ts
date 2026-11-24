import { beforeEach, describe, expect, it, vi } from "vitest";

const { infoSpy, warningSpy } = vi.hoisted(() => ({ infoSpy: vi.fn(), warningSpy: vi.fn() }));

vi.mock("@actions/core", () => ({ info: infoSpy, warning: warningSpy }));

import { postPullRequestComment, type CommentContext } from "../../src/comment";

const context: CommentContext = {
  eventName: "pull_request",
  repository: "example/project",
  pullRequest: 42,
  fork: false,
  workflow: "Canary",
  job: "check",
};

describe("postPullRequestComment no-op context gates (#572)", () => {
  beforeEach(() => {
    infoSpy.mockReset();
    warningSpy.mockReset();
  });

  it("skips a non-pull_request event without a request", async () => {
    const request = vi.fn();
    await postPullRequestComment("summary", "token", { ...context, eventName: "push" }, request);
    expect(request).not.toHaveBeenCalled();
    expect(infoSpy).toHaveBeenCalledWith("PR comment skipped: not a pull_request event.");
    expect(warningSpy).not.toHaveBeenCalled();
  });

  it("skips a pull_request event with no pull request number", async () => {
    const request = vi.fn();
    await postPullRequestComment("summary", "token", { ...context, pullRequest: undefined }, request);
    expect(request).not.toHaveBeenCalled();
    expect(infoSpy).toHaveBeenCalledWith("PR comment skipped: not a pull_request event.");
  });

  it.each([undefined, ""])("skips when the token is %j", async (token) => {
    const request = vi.fn();
    await postPullRequestComment("summary", token, context, request);
    expect(request).not.toHaveBeenCalled();
    expect(warningSpy).toHaveBeenCalledWith("PR comment skipped: no GitHub token available.");
  });

  it.each(["", "project", "example/", "/project"])("skips the invalid repository %j", async (repository) => {
    const request = vi.fn();
    await postPullRequestComment("summary", "token", { ...context, repository }, request);
    expect(request).not.toHaveBeenCalled();
    expect(warningSpy).toHaveBeenCalledWith("PR comment skipped: invalid repository context.");
  });
});
