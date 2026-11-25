import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("node:https", () => ({
  get: vi.fn(),
}));

import * as https from "node:https";
import { GitHubRequestError, githubFetch } from "../../src/github";

class FakeResponse extends EventEmitter {
  statusCode: number;
  headers: Record<string, string | string[] | undefined>;
  complete = true;
  constructor(statusCode: number, headers: Record<string, string | string[] | undefined> = {}) {
    super();
    this.statusCode = statusCode;
    this.headers = headers;
  }
  destroy(): void {
    this.emit("close");
  }
  pause(): void {}
  setEncoding(): void {}
  resume(): void {}
}

class FakeRequest extends EventEmitter {
  destroyed = false;
  destroy(error?: Error): this {
    if (this.destroyed) return this;
    this.destroyed = true;
    if (error !== undefined) {
      this.emit("error", error);
    }
    return this;
  }
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.mocked(https.get).mockReset();
  vi.useRealTimers();
});

const API_URL = "https://api.github.com/repos/StellarCanary/Protocol-Canary/tags";

/**
 * Makes every `https.get` attempt answer with the next status in `statuses`
 * (repeating the last one) and the given headers. Responses are delivered in
 * a microtask, matching how a real socket callback arrives after `get`
 * returns, so assertions on attempt counts remain meaningful.
 */
function mockStatusResponses(
  statuses: number[],
  headers: Record<string, string | string[] | undefined> = {},
): void {
  let call = 0;
  vi.mocked(https.get).mockImplementation((_url, _options, callback) => {
    const status = statuses[Math.min(call, statuses.length - 1)] ?? 500;
    call += 1;
    const request = new FakeRequest();
    const response = new FakeResponse(status, headers);
    queueMicrotask(() => (callback as unknown as (response: FakeResponse) => void)(response));
    return request as unknown as ReturnType<typeof https.get>;
  });
}

describe("githubFetch", () => {
  it.each([
    ["HTTP API URL", "http://api.github.com/repos"],
    ["userinfo API URL", "https://user:pass@api.github.com/repos"],
    ["empty userinfo API URL", "https://@api.github.com/repos"],
    ["percent-encoded API authority", "https://%61pi.github.com/repos"],
    ["custom-port API URL", "https://api.github.com:8443/repos"],
    ["control character in API URL", "https://api.github.com/\r\n@attacker.example"],
  ])("rejects %s before a request can carry credentials", async (_name, url) => {
    await expect(githubFetch(url, "secret")).rejects.toBeInstanceOf(GitHubRequestError);
    expect(https.get).not.toHaveBeenCalled();
  });

  it.each([
    "https://attacker.example/asset",
    "https://github.com/release/asset",
    "https://release-assets.githubusercontent.com/asset",
  ])("does not send an API token to non-API URL %s", async (url) => {
    let headersSeen: Record<string, string> | undefined;
    vi.mocked(https.get).mockImplementation((_url, options, callback) => {
      headersSeen = (options as { headers?: Record<string, string> }).headers;
      const request = new FakeRequest();
      const response = new FakeResponse(200);
      queueMicrotask(() => {
        (callback as unknown as (response: FakeResponse) => void)(response);
        queueMicrotask(() => {
          response.emit("data", "ok");
          response.emit("end");
        });
      });
      return request as unknown as ReturnType<typeof https.get>;
    });

    await expect(githubFetch(url, "secret")).resolves.toMatchObject({ body: "ok" });
    expect(headersSeen?.Authorization).toBeUndefined();
  });

  it("sends a token to a clean exact GitHub API URL", async () => {
    let headersSeen: Record<string, string> | undefined;
    vi.mocked(https.get).mockImplementation((_url, options, callback) => {
      headersSeen = (options as { headers?: Record<string, string> }).headers;
      const request = new FakeRequest();
      const response = new FakeResponse(200);
      queueMicrotask(() => {
        (callback as unknown as (response: FakeResponse) => void)(response);
        queueMicrotask(() => {
          response.emit("data", "ok");
          response.emit("end");
        });
      });
      return request as unknown as ReturnType<typeof https.get>;
    });

    await expect(githubFetch("https://api.github.com/repos/StellarCanary/Protocol-Canary", "secret"))
      .resolves.toMatchObject({ body: "ok" });
    expect(headersSeen?.Authorization).toBe("Bearer secret");
  });

  it("retries after a timeout and returns the successful body", async () => {
    vi.useFakeTimers();
    let call = 0;
    vi.mocked(https.get).mockImplementation((_url, _options, callback) => {
      call += 1;
      const request = new FakeRequest();
      if (call === 1) {
        queueMicrotask(() => request.emit("timeout"));
        return request as unknown as ReturnType<typeof https.get>;
      }
      const response = new FakeResponse(200);
      queueMicrotask(() => {
        (callback as unknown as (response: FakeResponse) => void)(response);
        queueMicrotask(() => {
          response.emit("data", "success-body");
          response.emit("end");
        });
      });
      return request as unknown as ReturnType<typeof https.get>;
    });

    const pending = githubFetch("https://api.github.com/repos/StellarCanary/Protocol-Canary/tags");
    await vi.advanceTimersByTimeAsync(250);
    const result = await pending;

    expect(result.body).toBe("success-body");
    expect(vi.mocked(https.get)).toHaveBeenCalledTimes(2);
  });

  it("aborts a continuously streaming response at the overall deadline", async () => {
    vi.useFakeTimers();
    let requestInstance: FakeRequest | undefined;
    vi.mocked(https.get).mockImplementation((_url, _options, callback) => {
      const request = new FakeRequest();
      requestInstance = request;
      const destroySpy = vi.spyOn(request, "destroy");
      const response = new FakeResponse(200);
      let timer: ReturnType<typeof setTimeout> | undefined;
      const schedule = (): void => {
        timer = setTimeout(() => {
          if (request.destroyed) return;
          response.emit("data", Buffer.from("chunk"));
          schedule();
        }, 1000);
      };
      queueMicrotask(() => {
        (callback as unknown as (response: FakeResponse) => void)(response);
        schedule();
      });
      // keep timer referenced
      void timer;
      void destroySpy;
      return request as unknown as ReturnType<typeof https.get>;
    });

    const pending = githubFetch("https://api.github.com/repos/StellarCanary/Protocol-Canary/tags");
    const rejected = expect(pending).rejects.toBeInstanceOf(GitHubRequestError);

    await vi.advanceTimersByTimeAsync(25_000);

    await rejected;
    const err = await pending.catch((e) => e);
    expect(err).toBeInstanceOf(GitHubRequestError);
    expect((err as GitHubRequestError).kind).toBe("timeout");
    expect(requestInstance?.destroyed).toBe(true);
  });

  describe("non-retryable 4xx client errors (#650)", () => {
    it.each([
      [401, "Unauthorized"],
      [404, "Not Found"],
    ])("fails fast on HTTP %i without retrying", async (status) => {
      mockStatusResponses([status]);

      const error = await githubFetch(API_URL).catch((e: unknown) => e);

      expect(error).toBeInstanceOf(GitHubRequestError);
      expect(error).toMatchObject({ kind: "http", statusCode: status });
      expect((error as GitHubRequestError).message).toContain(`status ${status}`);
      // A client error is deterministic: the request is attempted exactly once.
      expect(vi.mocked(https.get)).toHaveBeenCalledTimes(1);
    });

    it("does not retry a 4xx even when the response advertises a retry-after header", async () => {
      mockStatusResponses([400], { "retry-after": "1" });

      const error = await githubFetch(API_URL).catch((e: unknown) => e);

      expect(error).toMatchObject({ kind: "http", statusCode: 400, retryAfterMs: 1000 });
      expect(vi.mocked(https.get)).toHaveBeenCalledTimes(1);
    });
  });

  describe("rate-limit diagnostics (#650)", () => {
    it("classifies a 429 with x-ratelimit-remaining: 0 and reports reset and retry-after metadata", async () => {
      mockStatusResponses([429], {
        "x-ratelimit-remaining": "0",
        "x-ratelimit-reset": "1700000000",
        "retry-after": "30",
      });

      const error = await githubFetch(API_URL).catch((e: unknown) => e);

      expect(error).toBeInstanceOf(GitHubRequestError);
      expect(error).toMatchObject({ kind: "rate-limit", statusCode: 429, retryAfterMs: 30_000 });
      expect((error as GitHubRequestError).resetAt?.toISOString()).toBe("2023-11-14T22:13:20.000Z");
      // Rate limits are surfaced immediately; retrying would only burn quota.
      expect(vi.mocked(https.get)).toHaveBeenCalledTimes(1);
      // The message is the un-wrapped status diagnostic, not a generic failure.
      expect((error as GitHubRequestError).message).toContain("GitHub returned status 429");
    });

    it("treats a 403 with x-ratelimit-remaining: 0 as a rate limit even without retry-after", async () => {
      mockStatusResponses([403], { "x-ratelimit-remaining": "0", "x-ratelimit-reset": "1700000000" });

      const error = await githubFetch(API_URL).catch((e: unknown) => e);

      expect(error).toMatchObject({ kind: "rate-limit", statusCode: 403 });
      expect((error as GitHubRequestError).resetAt?.toISOString()).toBe("2023-11-14T22:13:20.000Z");
      expect((error as GitHubRequestError).retryAfterMs).toBeUndefined();
      expect(vi.mocked(https.get)).toHaveBeenCalledTimes(1);
    });

    it("treats a 403 with a retry-after header as a rate limit even if remaining is nonzero", async () => {
      mockStatusResponses([403], { "x-ratelimit-remaining": "42", "retry-after": "5" });

      const error = await githubFetch(API_URL).catch((e: unknown) => e);

      expect(error).toMatchObject({ kind: "rate-limit", statusCode: 403, retryAfterMs: 5_000 });
      expect(vi.mocked(https.get)).toHaveBeenCalledTimes(1);
    });

    it("ignores malformed rate-limit headers rather than misreporting them", async () => {
      mockStatusResponses([403], { "x-ratelimit-remaining": "0", "x-ratelimit-reset": "not-a-number" });

      const error = await githubFetch(API_URL).catch((e: unknown) => e);

      expect(error).toMatchObject({ kind: "rate-limit", statusCode: 403 });
      expect((error as GitHubRequestError).resetAt).toBeUndefined();
      expect(vi.mocked(https.get)).toHaveBeenCalledTimes(1);
    });
  });

  describe("5xx retry limit enforcement (#650)", () => {
    it("retries consecutive 503 responses up to the three-attempt limit", async () => {
      vi.useFakeTimers();
      mockStatusResponses([503]);

      const pending = githubFetch(API_URL).catch((e: unknown) => e);
      // Backoff is exponential: 250 ms before attempt 2, 500 ms before attempt 3.
      await vi.advanceTimersByTimeAsync(250);
      await vi.advanceTimersByTimeAsync(500);
      const error = await pending;

      expect(error).toBeInstanceOf(GitHubRequestError);
      expect(error).toMatchObject({ kind: "server", statusCode: 503 });
      expect((error as GitHubRequestError).message).toContain("after retries");
      expect((error as GitHubRequestError).message).toContain("status 503");
      expect(vi.mocked(https.get)).toHaveBeenCalledTimes(3);
    });

    it("stops retrying once a 5xx recovers and returns the successful body", async () => {
      vi.useFakeTimers();
      let call = 0;
      vi.mocked(https.get).mockImplementation((_url, _options, callback) => {
        call += 1;
        const request = new FakeRequest();
        if (call === 1) {
          const failure = new FakeResponse(503);
          queueMicrotask(() => (callback as unknown as (response: FakeResponse) => void)(failure));
          return request as unknown as ReturnType<typeof https.get>;
        }
        const response = new FakeResponse(200);
        queueMicrotask(() => {
          (callback as unknown as (response: FakeResponse) => void)(response);
          queueMicrotask(() => {
            response.emit("data", "recovered");
            response.emit("end");
          });
        });
        return request as unknown as ReturnType<typeof https.get>;
      });

      const pending = githubFetch(API_URL);
      await vi.advanceTimersByTimeAsync(250);

      await expect(pending).resolves.toMatchObject({ body: "recovered" });
      expect(vi.mocked(https.get)).toHaveBeenCalledTimes(2);
    });
  });
});
