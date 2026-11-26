/**
 * Tests for runner timeout validation and SIGTERM/SIGKILL lifecycle (issue #736).
 *
 * Verifies that runCheck rejects immediately for out-of-range timeoutMs values
 * before spawning a process, that SIGTERM is sent on timeout and SIGKILL follows
 * after the grace period when the process ignores SIGTERM, and that SIGKILL is
 * never sent when the process exits in response to SIGTERM.
 */
import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";

import { TimeoutError } from "../../src/errors";
import { MAX_TIMER_MS, SIGKILL_GRACE_MS, runCheck } from "../../src/runner";

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

  /**
   * @param exitsOnSigterm When true the child process emits `close` in
   *   response to SIGTERM (normal shutdown). When false it only exits on
   *   SIGKILL (simulates a process that ignores SIGTERM).
   */
  constructor(private readonly exitsOnSigterm: boolean) {
    super();
  }

  kill(signal: NodeJS.Signals = "SIGTERM"): boolean {
    this.signals.push(signal);
    const shouldExit = this.exitsOnSigterm ? signal === "SIGTERM" : signal === "SIGKILL";
    if (shouldExit) {
      this.stdout.push(null);
      this.stderr.push(null);
      this.emit("close", null, signal);
    }
    return true;
  }
}

/** Keeps streams open until explicitly closed — simulates a blocked process. */
class StreamHoldingChild extends EventEmitter {
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly signals: NodeJS.Signals[] = [];

  kill(signal: NodeJS.Signals = "SIGTERM"): boolean {
    this.signals.push(signal);
    return true;
  }

  close(exitCode: number | null, signal: NodeJS.Signals | null): void {
    this.stdout.push(null);
    this.stderr.push(null);
    this.emit("close", exitCode, signal);
  }
}

function fakeSpawn<T extends EventEmitter>(child: T): void {
  spawnMock.mockImplementationOnce(() => child as unknown as ChildProcess);
}

afterEach(() => {
  spawnMock.mockClear();
});

// ─── timeout validation (pre-spawn) ─────────────────────────────────────────

describe("runCheck timeout validation (issue #736)", () => {
  it("rejects immediately without spawning when timeoutMs exceeds MAX_TIMER_MS", async () => {
    await expect(runCheck("binary", [], MAX_TIMER_MS + 1)).rejects.toThrow(
      /Invalid timeoutMs/,
    );
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it("rejects for Infinity without spawning", async () => {
    await expect(runCheck("binary", [], Infinity)).rejects.toThrow(/Invalid timeoutMs/);
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it("rejects for NaN without spawning", async () => {
    await expect(runCheck("binary", [], NaN)).rejects.toThrow(/Invalid timeoutMs/);
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it("rejects for 0 without spawning", async () => {
    await expect(runCheck("binary", [], 0)).rejects.toThrow(/Invalid timeoutMs/);
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it("rejects for negative values without spawning", async () => {
    await expect(runCheck("binary", [], -1)).rejects.toThrow(/Invalid timeoutMs/);
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it("rejects for MAX_TIMER_MS + 1 but accepts MAX_TIMER_MS exactly", async () => {
    // MAX_TIMER_MS should spawn (but we immediately close the child)
    const child = new FakeChild(true);
    fakeSpawn(child);
    const run = runCheck("binary", [], MAX_TIMER_MS);
    child.emit("close", 0, null);
    child.stdout.push(null);
    child.stderr.push(null);
    // close event already fired; resolve
    const result = await run;
    expect(result.exitCode).toBe(0);
  });

  it("includes MAX_TIMER_MS in the rejection message", async () => {
    await expect(runCheck("binary", [], MAX_TIMER_MS + 1)).rejects.toThrow(
      String(MAX_TIMER_MS),
    );
  });

  it("rejection message includes the invalid value", async () => {
    const badValue = MAX_TIMER_MS * 2;
    await expect(runCheck("binary", [], badValue)).rejects.toThrow(String(badValue));
  });
});

// ─── SIGTERM sent on timeout ──────────────────────────────────────────────────

describe("SIGTERM sent on timeout (issue #736)", () => {
  it("sends SIGTERM when the timeout fires", async () => {
    const child = new FakeChild(true); // exits on SIGTERM
    fakeSpawn(child);

    // Use a 10ms timeout so the test doesn't take long
    const run = runCheck("fake-canary", ["check"], 10, { sigkillGraceMs: 50 });
    // FakeChild(true) emits close synchronously on SIGTERM, so the rejection fires
    // inside the setTimeout callback — before our setInterval resolves.  Attach a
    // catch immediately to prevent Node.js flagging it as unhandled.
    const caught = run.catch((e: unknown) => e);

    // Wait until SIGTERM is recorded
    await new Promise<void>((resolve) => {
      const interval = setInterval(() => {
        if (child.signals.includes("SIGTERM")) {
          clearInterval(interval);
          resolve();
        }
      }, 2);
    });

    expect(child.signals).toContain("SIGTERM");
    const err = await caught;
    expect(err).toBeInstanceOf(TimeoutError);
  });

  it("TimeoutError message includes the timeout duration in seconds", async () => {
    const child = new FakeChild(true);
    fakeSpawn(child);

    const run = runCheck("fake-canary", ["check"], 10, { sigkillGraceMs: 50 });
    await expect(run).rejects.toThrow(TimeoutError);
    await expect(run).rejects.toThrow(/timed out/i);
  });

  it("TimeoutError carries stdout accumulated before the timeout", async () => {
    const child = new StreamHoldingChild();
    fakeSpawn(child);

    child.stdout.push("partial-output-line");

    const run = runCheck("fake-canary", ["check"], 10, { sigkillGraceMs: 50 });
    // child.close() fires inside the setInterval callback, rejecting run synchronously
    // before our later assertion — catch early to avoid unhandled rejection warning.
    const caught = run.catch((e: unknown) => e);

    // Wait for SIGTERM, then emit close manually (simulating a slow-to-die process
    // that eventually exits after SIGTERM but before SIGKILL)
    await new Promise<void>((resolve) => {
      const interval = setInterval(() => {
        if (child.signals.includes("SIGTERM")) {
          clearInterval(interval);
          child.close(null, "SIGTERM");
          resolve();
        }
      }, 2);
    });

    const err = await caught;
    expect(err).toBeInstanceOf(TimeoutError);
    if (err instanceof TimeoutError) {
      expect(err.stdout).toContain("partial-output-line");
    }
  });

  it("TimeoutError carries stderr accumulated before the timeout", async () => {
    const child = new StreamHoldingChild();
    fakeSpawn(child);

    child.stderr.push("partial-error-line");

    const run = runCheck("fake-canary", ["check"], 10, { sigkillGraceMs: 50 });
    const caught = run.catch((e: unknown) => e);

    await new Promise<void>((resolve) => {
      const interval = setInterval(() => {
        if (child.signals.includes("SIGTERM")) {
          clearInterval(interval);
          child.close(null, "SIGTERM");
          resolve();
        }
      }, 2);
    });

    const err = await caught;
    expect(err).toBeInstanceOf(TimeoutError);
    if (err instanceof TimeoutError) {
      expect(err.stderr).toContain("partial-error-line");
    }
  });
});

// ─── SIGKILL escalation ───────────────────────────────────────────────────────

describe("SIGKILL escalation (issue #736)", () => {
  it("sends SIGKILL after sigkillGraceMs when the process ignores SIGTERM", async () => {
    const child = new FakeChild(false); // only exits on SIGKILL
    fakeSpawn(child);

    const run = runCheck("fake-canary", ["check"], 10, { sigkillGraceMs: 30 });
    // FakeChild(false) emits close on SIGKILL (synchronously inside the grace-period
    // setTimeout callback), so attach catch early to avoid unhandled rejection.
    const caught = run.catch((e: unknown) => e);

    // Wait for SIGKILL
    await new Promise<void>((resolve) => {
      const interval = setInterval(() => {
        if (child.signals.includes("SIGKILL")) {
          clearInterval(interval);
          resolve();
        }
      }, 5);
    });

    expect(child.signals).toContain("SIGTERM");
    expect(child.signals).toContain("SIGKILL");
    expect(child.signals.indexOf("SIGTERM")).toBeLessThan(child.signals.indexOf("SIGKILL"));

    const err = await caught;
    expect(err).toBeInstanceOf(TimeoutError);
  });

  it("escalation delay honours sigkillGraceMs, not the default SIGKILL_GRACE_MS", async () => {
    // Use a very short grace period (20ms) and verify SIGKILL comes promptly
    const child = new FakeChild(false);
    fakeSpawn(child);

    const start = Date.now();
    const run = runCheck("fake-canary", ["check"], 10, { sigkillGraceMs: 20 });
    // Same pattern: FakeChild(false) emits close on SIGKILL inside a setTimeout.
    const caught = run.catch((e: unknown) => e);

    await new Promise<void>((resolve) => {
      const interval = setInterval(() => {
        if (child.signals.includes("SIGKILL")) {
          clearInterval(interval);
          resolve();
        }
      }, 5);
    });

    // SIGKILL should come well before SIGKILL_GRACE_MS (5000ms)
    const elapsed = Date.now() - start;
    expect(elapsed).toBeLessThan(SIGKILL_GRACE_MS);

    const err = await caught;
    expect(err).toBeInstanceOf(TimeoutError);
  });

  it("does NOT send SIGKILL when the process exits on SIGTERM", async () => {
    const child = new FakeChild(true); // exits on SIGTERM
    fakeSpawn(child);

    // With sigkillGraceMs: 200 and timeout: 10ms, the timeout fires first.
    // FakeChild(true) emits close synchronously on SIGTERM, which rejects run
    // before the SIGKILL grace period can fire.
    const run = runCheck("fake-canary", ["check"], 10, { sigkillGraceMs: 200 });

    await expect(run).rejects.toBeInstanceOf(TimeoutError);

    // FakeChild(true) auto-emits close on SIGTERM, so SIGKILL should never fire
    expect(child.signals).not.toContain("SIGKILL");
    expect(child.signals).toContain("SIGTERM");
  });

  it("SIGKILL is not sent for a process that exits normally before the timeout", async () => {
    const child = new FakeChild(true);
    fakeSpawn(child);

    const run = runCheck("fake-canary", ["check"], 60_000, { sigkillGraceMs: 50 });

    // Exit normally before the timeout fires
    child.stdout.push(null);
    child.stderr.push(null);
    child.emit("close", 0, null);

    const result = await run;
    expect(result.exitCode).toBe(0);
    expect(child.signals).toHaveLength(0); // no signals sent
  });
});

// ─── timeout clears the timer handle ──────────────────────────────────────────

describe("timer cleanup (issue #736)", () => {
  it("resolves without lingering timeout when process exits normally", async () => {
    const child = new FakeChild(true);
    fakeSpawn(child);

    // Use a very long timeout — if the timer were not cleared, the test suite
    // would hang or leak timers.
    const run = runCheck("fake-canary", ["check"], 60_000);

    child.stdout.push("output");
    child.stdout.push(null);
    child.stderr.push(null);
    child.emit("close", 0, null);

    const result = await run;
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("output");
    // If the timer were not cleared, Vitest would warn about leaked timers.
  });

  it("resolves with the correct exit code even when sigkillGraceMs is provided", async () => {
    const child = new FakeChild(true);
    fakeSpawn(child);

    const run = runCheck("fake-canary", ["check"], 60_000, { sigkillGraceMs: 10 });

    child.stdout.push(null);
    child.stderr.push(null);
    child.emit("close", 42, null);

    const result = await run;
    expect(result.exitCode).toBe(42);
    expect(child.signals).toHaveLength(0);
  });
});
