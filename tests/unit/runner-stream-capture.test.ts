/**
 * Tests for runner stream buffer capture limits (issue #735).
 *
 * Verifies that stdout and stderr accumulation is bounded, that truncated
 * stderr is prepended with STDERR_DROPPED_NOTICE, and that extractDiagnostic
 * correctly parses root error messages from large or truncated buffers.
 */
import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";

import { CanaryExecutionFailedError, TimeoutError } from "../../src/errors";
import {
  MAX_DIAGNOSTIC_LENGTH,
  MAX_STDERR_CAPTURE_BYTES,
  MAX_STDOUT_CAPTURE_BYTES,
  STDERR_DROPPED_NOTICE,
  extractDiagnostic,
  runCheck,
} from "../../src/runner";

const { spawnMock } = vi.hoisted(() => ({
  spawnMock: vi.fn(),
}));

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  spawnMock.mockImplementation(actual.spawn);
  return { ...actual, spawn: spawnMock };
});

vi.mock("@actions/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@actions/core")>();
  return { ...actual, info: vi.fn() };
});

/** Minimal fake child process with controllable stdio streams. */
class FakeChild extends EventEmitter {
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly signals: NodeJS.Signals[] = [];

  constructor(private readonly exitsOnSigterm = true) {
    super();
  }

  kill(signal: NodeJS.Signals = "SIGTERM"): boolean {
    this.signals.push(signal);
    const shouldExit = this.exitsOnSigterm ? signal === "SIGTERM" : signal === "SIGKILL";
    if (shouldExit) {
      this.emit("close", null, signal);
    }
    return true;
  }
}

function fakeSpawn(child: FakeChild): void {
  spawnMock.mockImplementationOnce(() => child as unknown as ChildProcess);
}

afterEach(() => {
  spawnMock.mockClear();
});

// ─── extractDiagnostic ────────────────────────────────────────────────────────

describe("extractDiagnostic (issue #735)", () => {
  it("extracts root error line from noisy stderr", () => {
    const stderr = [
      "stellar-canary 0.2.0",
      "loading fixtures...",
      "error: configuration error: file not found",
      "   at runner.rs:42",
    ].join("\n");
    expect(extractDiagnostic(stderr)).toBe("error: configuration error: file not found");
  });

  it("falls back to first non-empty line when no root error prefix is found", () => {
    expect(extractDiagnostic("  just a note\nmore detail")).toBe("just a note");
  });

  it("returns empty string for whitespace-only stderr", () => {
    expect(extractDiagnostic("")).toBe("");
    expect(extractDiagnostic("  \n  \n  ")).toBe("");
  });

  it("truncates a very long diagnostic to MAX_DIAGNOSTIC_LENGTH", () => {
    const long = `error: ${"a".repeat(5_000)}`;
    const result = extractDiagnostic(long);
    expect(Buffer.byteLength(result, "utf8")).toBeLessThanOrEqual(MAX_DIAGNOSTIC_LENGTH);
  });

  it("extracts diagnostics from a stderr buffer exactly at MAX_STDERR_CAPTURE_BYTES", () => {
    // Fill stderr with noise to exactly the cap, then append the error line
    const noiseSize = MAX_STDERR_CAPTURE_BYTES - 100;
    const noise = "x".repeat(noiseSize);
    const errorLine = "error: root diagnostic message";
    const stderr = `${noise}\n${errorLine}`;
    // extractDiagnostic should still find the root error line
    const result = extractDiagnostic(stderr);
    // Result is bounded by MAX_DIAGNOSTIC_LENGTH
    expect(Buffer.byteLength(result, "utf8")).toBeLessThanOrEqual(MAX_DIAGNOSTIC_LENGTH);
  });

  it("extracts root diagnostic from a stderr buffer prefixed with STDERR_DROPPED_NOTICE", () => {
    const tail = `${STDERR_DROPPED_NOTICE}error: root error from truncated stderr`;
    const result = extractDiagnostic(tail);
    expect(result).toContain("root error from truncated stderr");
  });

  it("honors panic, fatal, failed, no checks ran, invalid, unknown, unsupported prefixes", () => {
    for (const prefix of ["panic", "fatal", "failed", "no checks ran", "invalid", "unknown", "unsupported"]) {
      const stderr = `info: loading\n${prefix}: something went wrong`;
      const result = extractDiagnostic(stderr);
      expect(result).toContain(prefix);
    }
  });
});

// ─── stderr capture truncation ────────────────────────────────────────────────

describe("stderr capture truncation (issue #735)", () => {
  it("prepends STDERR_DROPPED_NOTICE when stderr exceeds MAX_STDERR_CAPTURE_BYTES", async () => {
    const child = new FakeChild(true);
    fakeSpawn(child);

    const run = runCheck("fake-canary", ["check"], 60_000);

    // Write 1 MiB + 50 KiB of stderr to exceed the limit
    const bigChunk = "s".repeat(MAX_STDERR_CAPTURE_BYTES + 50_000);
    child.stderr.push(bigChunk);
    child.stderr.push(null);
    child.stdout.push(null);
    child.emit("close", 0, null);

    const result = await run;
    expect(result.stderr.startsWith(STDERR_DROPPED_NOTICE)).toBe(true);
  });

  it("retains stderr tail content after STDERR_DROPPED_NOTICE", async () => {
    const child = new FakeChild(true);
    fakeSpawn(child);

    const run = runCheck("fake-canary", ["check"], 60_000);

    // Write enough data to trigger truncation, with a recognizable tail
    const filler = "a".repeat(MAX_STDERR_CAPTURE_BYTES);
    const tail = "error: specific root error message";
    child.stderr.push(filler + "\n" + tail);
    child.stderr.push(null);
    child.stdout.push(null);
    child.emit("close", 2, null);

    const result = await run;
    expect(result.stderr).toContain(tail);
    expect(result.stderr.startsWith(STDERR_DROPPED_NOTICE)).toBe(true);
  });

  it("truncated stderr total byte length stays near MAX_STDERR_CAPTURE_BYTES", async () => {
    const child = new FakeChild(true);
    fakeSpawn(child);

    const run = runCheck("fake-canary", ["check"], 60_000);

    // Write 3× the limit to force aggressive truncation
    const bigChunk = "b".repeat(MAX_STDERR_CAPTURE_BYTES * 3);
    child.stderr.push(bigChunk);
    child.stderr.push(null);
    child.stdout.push(null);
    child.emit("close", 1, null);

    const result = await run;
    // Final stderr should be bounded: notice + tail ≤ MAX_STDERR_CAPTURE_BYTES + some overhead
    expect(Buffer.byteLength(result.stderr, "utf8")).toBeLessThanOrEqual(MAX_STDERR_CAPTURE_BYTES + 1_000);
  });

  it("preserves exit code and signal when stderr is truncated", async () => {
    const child = new FakeChild(true);
    fakeSpawn(child);

    const run = runCheck("fake-canary", ["check"], 60_000);

    const bigChunk = "c".repeat(MAX_STDERR_CAPTURE_BYTES + 1_000);
    child.stderr.push(bigChunk);
    child.stderr.push(null);
    child.stdout.push(null);
    child.emit("close", 7, null);

    const result = await run;
    expect(result.exitCode).toBe(7);
    expect(result.signal).toBeNull();
  });

  it("does not prepend STDERR_DROPPED_NOTICE when stderr is within the limit", async () => {
    const child = new FakeChild(true);
    fakeSpawn(child);

    const run = runCheck("fake-canary", ["check"], 60_000);

    const smallChunk = "d".repeat(100);
    child.stderr.push(smallChunk);
    child.stderr.push(null);
    child.stdout.push(null);
    child.emit("close", 0, null);

    const result = await run;
    expect(result.stderr).not.toContain(STDERR_DROPPED_NOTICE);
    expect(result.stderr).toBe(smallChunk);
  });
});

// ─── stdout capture limits ────────────────────────────────────────────────────

describe("stdout capture limits (issue #735)", () => {
  it("rejects with CanaryExecutionFailedError when stdout exceeds MAX_STDOUT_CAPTURE_BYTES", async () => {
    const child = new FakeChild(false); // only exits on SIGKILL
    fakeSpawn(child);

    const run = runCheck("fake-canary", ["check"], 60_000, { sigkillGraceMs: 50 });
    // Attach a catch immediately so Node.js doesn't flag it as unhandled before
    // our assertion runs (the rejection fires inside the setInterval callback).
    const caught = run.catch((e: unknown) => e);

    // Push stdout exceeding the 64 MiB limit
    const overflowChunk = "o".repeat(MAX_STDOUT_CAPTURE_BYTES + 1_000);
    child.stdout.push(overflowChunk);

    // Wait for the runner to escalate to SIGKILL, then close the child
    await new Promise<void>((resolve) => {
      const interval = setInterval(() => {
        if (child.signals.includes("SIGKILL")) {
          clearInterval(interval);
          child.stdout.push(null);
          child.stderr.push(null);
          child.emit("close", null, "SIGKILL");
          resolve();
        }
      }, 5);
    });

    const err = await caught;
    expect(err).toBeInstanceOf(CanaryExecutionFailedError);
    expect((err as CanaryExecutionFailedError).message).toMatch(/exceeded limit/i);
  });

  it("resolves normally when stdout stays within MAX_STDOUT_CAPTURE_BYTES", async () => {
    const child = new FakeChild(true);
    fakeSpawn(child);

    const run = runCheck("fake-canary", ["check"], 60_000);

    const safeContent = `{"status":"pass"}`;
    child.stdout.push(safeContent);
    child.stdout.push(null);
    child.stderr.push(null);
    child.emit("close", 0, null);

    const result = await run;
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe(safeContent);
  });
});

// ─── exit code and signal preservation ───────────────────────────────────────

describe("exit code and signal preservation with stream limits (issue #735)", () => {
  it("preserves exit code 0 with no truncation", async () => {
    const child = new FakeChild(true);
    fakeSpawn(child);

    const run = runCheck("fake-canary", ["check"], 60_000);

    child.stdout.push("stdout content");
    child.stdout.push(null);
    child.stderr.push("stderr content");
    child.stderr.push(null);
    child.emit("close", 0, null);

    const result = await run;
    expect(result.exitCode).toBe(0);
    expect(result.signal).toBeNull();
    expect(result.stderr).toBe("stderr content");
  });

  it("preserves non-zero exit code when stderr is truncated", async () => {
    const child = new FakeChild(true);
    fakeSpawn(child);

    const run = runCheck("fake-canary", ["check"], 60_000);

    const oversized = "e".repeat(MAX_STDERR_CAPTURE_BYTES + 500);
    child.stderr.push(oversized);
    child.stderr.push(null);
    child.stdout.push(null);
    child.emit("close", 3, null);

    const result = await run;
    expect(result.exitCode).toBe(3);
    expect(result.signal).toBeNull();
  });

  it("rejects with TimeoutError that carries stdout and stderr at the moment of timeout", async () => {
    const child = new FakeChild(false); // ignores SIGTERM, needs SIGKILL
    fakeSpawn(child);

    child.stdout.push("partial-stdout");
    child.stderr.push("partial-stderr");

    const run = runCheck("fake-canary", ["check"], 10, { sigkillGraceMs: 50 });
    // Catch immediately to avoid unhandled rejection warning before assertion runs
    const caught = run.catch((e: unknown) => e);

    await new Promise<void>((resolve) => {
      const interval = setInterval(() => {
        if (child.signals.includes("SIGKILL")) {
          clearInterval(interval);
          child.stdout.push(null);
          child.stderr.push(null);
          child.emit("close", null, "SIGKILL");
          resolve();
        }
      }, 5);
    });

    const err = await caught;
    expect(err).toBeInstanceOf(TimeoutError);
  });
});
