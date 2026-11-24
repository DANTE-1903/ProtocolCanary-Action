import type * as actionsCore from "@actions/core";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// #521: the version probe, the `tar` extraction and the `cargo --version`
// probe are bounded. Unlike tests/unit/canary.test.ts (which asserts the
// wiring against mocked children), these tests exercise the bounds against
// REAL child processes that spawn and then never exit, so the timeout,
// the termination, and the resulting error/warning are the production
// code paths end to end. The stand-in is a Node script so it runs on the
// Windows, macOS and Linux runners; no test here sleeps longer than about
// two seconds.

const { warningMock } = vi.hoisted(() => ({ warningMock: vi.fn() }));

// Partial mock per CONTRIBUTING.md: only `warning` is overridden, so the
// rest of @actions/core keeps working through the real module.
vi.mock("@actions/core", async (importOriginal) => {
  const actual = await importOriginal<typeof actionsCore>();
  return { ...actual, warning: warningMock };
});

import {
  CARGO_PROBE_TIMEOUT_MS,
  TAR_EXTRACTION_TIMEOUT_MS,
  VERSION_PROBE_TIMEOUT_MS,
  ensureCargoAvailable,
  extractPrebuiltArchive,
  getInstalledVersion,
} from "../../src/canary";
import type { ChildProcessEnvironment } from "../../src/child-env";
import { buildChildEnvironment } from "../../src/child-env";
import { InstallationFailedError, TimeoutError } from "../../src/errors";
import { runCheck } from "../../src/runner";

/** Injected bound so a hanging stand-in resolves fast; every assertion
 * below tolerates at most a couple of seconds of wall time. */
const SHORT_BOUND_MS = 600;

/**
 * The filtered child environment these probes run with (#433). The two
 * stand-in controls are test-only variables rather than Action inputs, so
 * they are forwarded through the same `engine-env-passthrough` mechanism a
 * workflow would use; PATH is picked up from `process.env` when this is
 * called, after {@link installShim} has prepended its directory.
 */
function childEnv(): ChildProcessEnvironment {
  return buildChildEnvironment(process.env, process.platform, [
    "STANDIN_MODE",
    "STANDIN_PID_FILE",
  ]).env;
}

/** Stand-in child body: records its PID (so the test can assert the child
 * is gone after the timeout) and then either answers and exits, or hangs
 * forever. Behaviour is selected through STANDIN_MODE. */
const STANDIN_SOURCE = [
  'const fs = require("node:fs");',
  'const pidFile = process.env.STANDIN_PID_FILE;',
  'if (pidFile) { fs.writeFileSync(pidFile, String(process.pid)); }',
  'const mode = process.env.STANDIN_MODE ?? "hang";',
  'if (mode === "print") { process.stdout.write("stellar-canary 0.1.0\\n"); process.exit(0); }',
  'if (mode === "fail") { process.exit(1); }',
  "setInterval(() => {}, 1000); // never exits",
].join("\n");

/** Waits until the process no longer exists (or the deadline passes). */
async function waitForChildGone(pid: number, deadlineMs: number): Promise<boolean> {
  const start = Date.now();
  for (;;) {
    try {
      process.kill(pid, 0);
    } catch {
      return true;
    }
    if (Date.now() - start >= deadlineMs) {
      return false;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

async function captureError(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
    return undefined;
  } catch (error) {
    return error;
  }
}

/**
 * The recorded stand-in PID, or undefined when the child never wrote it. The
 * child writes it as its very first action, so the only reason it can still be
 * missing when the bound expires is that the runner had not scheduled the
 * process yet — with 61 worker spawns in one file that is a real race, and it
 * would read as a broken bound. Waiting is bounded, and the assertion at each
 * call site is unchanged: the PID still has to exist.
 */
async function standinPid(): Promise<number | undefined> {
  return waitForPid(pidFile);
}

let tempDir: string;
let standinPath: string;
let pidFile: string;
let savedPath: string | undefined;
let savedMode: string | undefined;
let savedPidFile: string | undefined;

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "canary-bounds-"));
  standinPath = path.join(tempDir, "stand-in.cjs");
  fs.writeFileSync(standinPath, `${STANDIN_SOURCE}\n`);
  pidFile = path.join(tempDir, "standin.pid");
  savedPath = process.env.PATH;
  savedMode = process.env.STANDIN_MODE;
  savedPidFile = process.env.STANDIN_PID_FILE;
  process.env.STANDIN_PID_FILE = pidFile;
  process.env.STANDIN_MODE = "hang";
  warningMock.mockReset();
});

afterEach(() => {
  process.env.PATH = savedPath;
  if (savedMode === undefined) delete process.env.STANDIN_MODE;
  else process.env.STANDIN_MODE = savedMode;
  if (savedPidFile === undefined) delete process.env.STANDIN_PID_FILE;
  else process.env.STANDIN_PID_FILE = savedPidFile;
  fs.rmSync(tempDir, { recursive: true, force: true });
});

/** Puts a shim named `name` on PATH that runs the stand-in script. Works
 * wherever a PATH-resolved command can be an executable script (Linux and
 * macOS); Windows resolves only real executables by name, so the shim
 * tests below skip there with a visible reason. */
function installShim(name: "tar" | "cargo"): void {
  fs.writeFileSync(path.join(tempDir, name), `#!/usr/bin/env node\n${STANDIN_SOURCE}\n`, { mode: 0o755 });
  process.env.PATH = `${tempDir}${path.delimiter}${savedPath ?? ""}`;
}

// On win32 a PATH shim cannot be spawned by bare name (`tar`/`cargo` resolve
// to real executables or nothing, never a script), so the shim-driven tests
// are POSIX-only — the same platform gating tests/unit/runner.test.ts uses
// for its Unix-signal behaviour. The timeout code path itself is shared.
const itShim = process.platform === "win32" ? it.skip : it;

// #600 stand-in: exits (or ignores SIGTERM) after spawning a grandchild that
// *inherits* its stdout/stderr, so the pipe stays open in a process the bound
// never signalled. This is the shape that can leave `close` — and therefore
// `runCheck`'s promise — waiting forever: the direct child is already gone,
// so SIGTERM and SIGKILL are both no-ops, and the surviving grandchild holds
// the only remaining write end. Node scripts are used so the same stand-in
// runs on the Windows, macOS and Linux runners.
//
// The output goes out through `fs.writeSync(1, …)`: a pipe write queued by
// `process.stdout.write` can be dropped by a following `process.exit()`, and
// a lost line would look like a broken bound rather than a flaky harness.
const STREAM_STANDIN_SOURCE = [
  'const fs = require("node:fs");',
  'const { spawn } = require("node:child_process");',
  'const pidFile = process.env.STANDIN_PID_FILE;',
  'if (pidFile) { fs.writeFileSync(pidFile, String(process.pid)); }',
  'const gcPidFile = process.env.STANDIN_GC_PID_FILE;',
  'const mode = process.env.STANDIN_MODE ?? "exit-leave-stream-open";',
  'const grandchild = spawn(process.execPath, ["-e", "globalThis.hold = setInterval(() => {}, 1000);"], {',
  '  stdio: "inherit",',
  "});",
  'if (gcPidFile) { fs.writeFileSync(gcPidFile, String(grandchild.pid)); }',
  "grandchild.unref();",
  'if (mode === "exit-leave-stream-open") {',
  '  fs.writeSync(1, "stellar-canary 0.1.0\\n");',
  "  process.exit(0);",
  "}",
  'const sigFile = process.env.STANDIN_SIG_FILE;',
  'process.on("SIGTERM", () => {',
  '  if (sigFile) { fs.appendFileSync(sigFile, "SIGTERM\\n"); }',
  "});",
  'fs.writeSync(1, "partial engine log\\n");',
  "setInterval(() => {}, 1000); // ignores SIGTERM; only SIGKILL ends it",
].join("\n");

/** The PID recorded in `file`, or undefined when it was never written. */
function readPid(file: string): number | undefined {
  try {
    const value = Number(fs.readFileSync(file, "utf8"));
    return Number.isInteger(value) && value > 0 ? value : undefined;
  } catch {
    return undefined;
  }
}

/** True when `pid` still names a live process this test may observe. */
function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Reads the PID the stand-in records as its very first action, waiting only
 * for that file to appear. Under a loaded runner a child can be scheduled a
 * few hundred milliseconds after the bound expires; this absorbs that start-up
 * jitter without touching what is asserted — the PID still has to exist, and
 * the child still has to be the one the bound terminated.
 */
async function waitForPid(file: string, deadlineMs = 1_000): Promise<number | undefined> {
  const start = Date.now();
  for (;;) {
    const pid = readPid(file);
    if (pid !== undefined) {
      return pid;
    }
    if (Date.now() - start >= deadlineMs) {
      return undefined;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

// Reuses {@link SHORT_BOUND_MS} (600ms), the bound the #521 tests in this file
// already prove against real Node children in CI, so the child is reliably
// past its own start-up — and therefore has written its PID file and its
// output — before the clock expires. `SHORT_BOUND_MS + this grace` is ~1.1s,
// inside the 2s the tests allow for.
const STREAM_SIGKILL_GRACE_MS = 500;

describe("stream handles left open past the bound (#600)", () => {
  let streamStandin: string;
  let streamPid: string;
  let gcPidFile: string;
  let sigFile: string;
  let savedGcPidFile: string | undefined;
  let savedSigFile: string | undefined;

  beforeEach(() => {
    // `tempDir` comes from the suite-level beforeEach, which runs first, and
    // is removed by the suite-level afterEach, which runs last — so the
    // grandchild is killed before its scratch directory disappears.
    streamStandin = path.join(tempDir, "stream-stand-in.cjs");
    streamPid = path.join(tempDir, "stream.pid");
    gcPidFile = path.join(tempDir, "grandchild.pid");
    sigFile = path.join(tempDir, "signals.txt");
    fs.writeFileSync(streamStandin, `${STREAM_STANDIN_SOURCE}\n`);
    // The suite-level hook already points STANDIN_PID_FILE at its own
    // stand-in; these tests need their child's PID in a separate file so the
    // two suites' children can be told apart.
    process.env.STANDIN_PID_FILE = streamPid;
    savedGcPidFile = process.env.STANDIN_GC_PID_FILE;
    savedSigFile = process.env.STANDIN_SIG_FILE;
    process.env.STANDIN_GC_PID_FILE = gcPidFile;
    process.env.STANDIN_SIG_FILE = sigFile;
  });

  afterEach(() => {
    if (savedGcPidFile === undefined) delete process.env.STANDIN_GC_PID_FILE;
    else process.env.STANDIN_GC_PID_FILE = savedGcPidFile;
    if (savedSigFile === undefined) delete process.env.STANDIN_SIG_FILE;
    else process.env.STANDIN_SIG_FILE = savedSigFile;
    // The bound must not depend on the grandchild cooperating, which is
    // exactly why it is still running when the promise settles. The test,
    // not the code under test, owns its lifecycle.
    const pid = readPid(gcPidFile);
    if (pid !== undefined) {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        // already gone
      }
    }
  });

  /** The filtered child environment, widened for the #600 controls. */
  function streamChildEnv(): ChildProcessEnvironment {
    return buildChildEnvironment(process.env, process.platform, [
      "STANDIN_MODE",
      "STANDIN_PID_FILE",
      "STANDIN_GC_PID_FILE",
      "STANDIN_SIG_FILE",
    ]).env;
  }

  // POSIX-only, and measured rather than assumed: on the Windows runner the
  // direct child's exit closes the pipe it handed down, so `close` fires and
  // `runCheck` resolves normally instead of being held hostage — the hang
  // these tests pin cannot be produced there. (Windows also has no SIGTERM
  // delivery for Node children, so a handler cannot record the signal.) The
  // same release-then-settle path is asserted portably against a fake child
  // whose `close` waits on its stdio streams — see the #600 case in the
  // "runCheck timeout escalation" suite in tests/unit/runner.test.ts.
  const itPosix = process.platform === "win32" ? it.skip : it;

  itPosix("settles the bound with a TimeoutError carrying the captured output, while the inherited pipe stays open", async () => {
    process.env.STANDIN_MODE = "exit-leave-stream-open";
    const started = Date.now();

    const error = await captureError(
      runCheck(process.execPath, [streamStandin], SHORT_BOUND_MS, {
        sigkillGraceMs: STREAM_SIGKILL_GRACE_MS,
        env: streamChildEnv(),
      }),
    );
    // Identity, read the instant the promise settled: the process holding the
    // inherited write end was still alive. The bound therefore cannot have
    // been satisfied by that helper finishing on its own — its 1s interval
    // keeps it running until this suite's own afterEach kills it.
    const gcPid = readPid(gcPidFile);
    const grandchildAliveAtSettle = gcPid !== undefined && isAlive(gcPid);
    const settledAfterMs = Date.now() - started;

    // Bound, not hung: the timeout plus the escalation grace, with slack.
    expect(settledAfterMs).toBeLessThan(2_000);
    expect(error).toBeInstanceOf(TimeoutError);
    // The output captured before the child exited is still reported — the
    // promise is bounded, the diagnostics are not thrown away with the pipe.
    expect((error as TimeoutError).stdout).toContain("stellar-canary 0.1.0");
    expect(grandchildAliveAtSettle, "the bound must not depend on the grandchild exiting").toBe(true);
    const pid = await waitForPid(streamPid);
    expect(pid, "the stand-in recorded its PID").toBeDefined();
    await expect(waitForChildGone(pid as number, 2_000)).resolves.toBe(true);
  });

  itPosix("sends SIGTERM, then SIGKILL, and settles when the child ignores the first", async () => {
    process.env.STANDIN_MODE = "ignore-sigterm";
    const started = Date.now();

    const error = await captureError(
      runCheck(process.execPath, [streamStandin], SHORT_BOUND_MS, {
        sigkillGraceMs: STREAM_SIGKILL_GRACE_MS,
        env: streamChildEnv(),
      }),
    );

    expect(error).toBeInstanceOf(TimeoutError);
    expect((error as TimeoutError).stdout).toContain("partial engine log");
    expect(Date.now() - started).toBeLessThan(2_000);

    // The child recorded the SIGTERM it received...
    expect(fs.readFileSync(sigFile, "utf8")).toContain("SIGTERM");
    // ...and it ignored that signal, so the only thing that can have ended it
    // is the escalation to SIGKILL.
    const pid = await waitForPid(streamPid);
    expect(pid, "the stand-in recorded its PID").toBeDefined();
    await expect(waitForChildGone(pid as number, 2_000)).resolves.toBe(true);
  });
});

describe("documented helper-process bounds (#521)", () => {
  it("ships a 30s bound for both version probes and a 5-minute bound for tar", () => {
    expect(VERSION_PROBE_TIMEOUT_MS).toBe(30_000);
    expect(CARGO_PROBE_TIMEOUT_MS).toBe(30_000);
    expect(TAR_EXTRACTION_TIMEOUT_MS).toBe(5 * 60_000);
  });
});

describe("getInstalledVersion bounds (#521)", () => {
  it("terminates a probe that never exits, warns naming it, and returns undefined", async () => {
    // On every platform the stand-in runs through `node` with its path as a
    // leading argv element (the renderJUnitReport pattern), so the exact
    // same test runs on the Windows, macOS and Linux runners.
    const started = Date.now();
    const version = await getInstalledVersion(process.execPath, SHORT_BOUND_MS, [standinPath], childEnv());

    expect(version).toBeUndefined();
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(warningMock).toHaveBeenCalledTimes(1);
    const warningText = String(warningMock.mock.calls[0]?.[0]);
    expect(warningText).toContain(process.execPath);
    expect(warningText).toContain("did not finish within");

    // The child must actually be gone, not merely abandoned.
    const pid = await standinPid();
    expect(pid, "the stand-in recorded its PID").toBeDefined();
    await expect(waitForChildGone(pid as number, 2_000)).resolves.toBe(true);
  });

  it("still yields the reported version when the probe prints and exits 0", async () => {
    process.env.STANDIN_MODE = "print";

    const version = await getInstalledVersion(process.execPath, SHORT_BOUND_MS, [standinPath], childEnv());

    expect(version).toBe("0.1.0");
    expect(warningMock).not.toHaveBeenCalled();
  });

  it("still returns undefined when the probe exits non-zero", async () => {
    process.env.STANDIN_MODE = "fail";

    const version = await getInstalledVersion(process.execPath, SHORT_BOUND_MS, [standinPath], childEnv());

    expect(version).toBeUndefined();
    expect(warningMock).not.toHaveBeenCalled();
  });
});

describe("extractPrebuiltArchive bounds (#521)", () => {
  itShim("terminates a tar that never exits and fails with an error naming the bound", async () => {
    installShim("tar");
    const archivePath = path.join(tempDir, "asset.tar.gz");
    fs.writeFileSync(archivePath, "not really an archive");
    const destDir = path.join(tempDir, "extracted");

    const error = await captureError(extractPrebuiltArchive(archivePath, destDir, SHORT_BOUND_MS, childEnv()));

    expect(error).toBeInstanceOf(InstallationFailedError);
    expect((error as InstallationFailedError).message).toContain("did not finish within");
    // A partially extracted directory must never be left usable.
    expect(fs.readdirSync(destDir)).toEqual([]);
    const pid = await standinPid();
    expect(pid, "the stand-in recorded its PID").toBeDefined();
    await expect(waitForChildGone(pid as number, 2_000)).resolves.toBe(true);
  });
});

describe("ensureCargoAvailable bounds (#521)", () => {
  itShim("fails with the cargo-not-available error when the probe never exits, naming the bound", async () => {
    installShim("cargo");

    const error = await captureError(ensureCargoAvailable(SHORT_BOUND_MS, childEnv()));

    expect(error).toBeInstanceOf(InstallationFailedError);
    const message = (error as InstallationFailedError).message;
    expect(message).toContain("The `cargo` command was not found on this runner");
    expect(message).toContain("did not finish within");
    const pid = await standinPid();
    expect(pid, "the stand-in recorded its PID").toBeDefined();
    await expect(waitForChildGone(pid as number, 2_000)).resolves.toBe(true);
  });

  itShim("treats a cargo probe that exits non-zero as unavailable", async () => {
    installShim("cargo");
    process.env.STANDIN_MODE = "fail";

    const error = await captureError(ensureCargoAvailable(SHORT_BOUND_MS, childEnv()));

    expect(error).toBeInstanceOf(InstallationFailedError);
    expect((error as InstallationFailedError).message).toContain("exited with code 1");
  });
});
