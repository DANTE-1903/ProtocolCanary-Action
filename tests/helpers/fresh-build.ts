import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execFileSync } from "node:child_process";

import { describe, expect, it } from "vitest";

/** Runs the build script. Injectable so the failure paths need no real build. */
type ExecFile = typeof execFileSync;

/**
 * Result of {@link freshBuild}: the generated bundle and source map, plus
 * the temporary directory they live in (the caller removes it with
 * `cleanup` when the assertions are done).
 */
export interface FreshBuildResult {
  /** Absolute path to the freshly generated `dist/index.js`. */
  readonly bundlePath: string;
  /** Absolute path to the freshly generated `dist/index.js.map`. */
  readonly mapPath: string;
  /** Absolute path to the temporary build directory. Remove it with `cleanup`. */
  readonly tmpDir: string;
  /** Removes the temporary build directory and everything in it. */
  readonly cleanup: () => void;
}

/** Options for {@link freshBuild}. */
export interface FreshBuildOptions {
  /**
   * Overrides the source directory copied into the temp build; used by the
   * guard tests to prove a broken build fails loudly.
   */
  readonly srcDir?: string;
  /**
   * Child-process runner used to execute `scripts/build.mjs`. Defaults to
   * `execFileSync`; the self-checks below inject a fake so a non-zero exit
   * code can be asserted without running a real build.
   */
  readonly exec?: ExecFile;
}

/**
 * Builds the bundle in a temporary directory and returns the paths of the
 * generated bundle and source map. The temporary directory is removed by
 * `cleanup` (and also when the build fails). Throws with the build output
 * if the build fails — it never hangs.
 */
export function freshBuild(options: FreshBuildOptions = {}): FreshBuildResult {
  const exec = options.exec ?? execFileSync;
  const repoRoot = path.resolve(__dirname, "../..");
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "bundle-guard-build-"));
  const cleanup = (): void => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  };

  try {
    const srcDir = options.srcDir ?? path.join(repoRoot, "src");
    fs.cpSync(srcDir, path.join(tmpDir, "src"), { recursive: true });
    fs.cpSync(path.join(repoRoot, "scripts"), path.join(tmpDir, "scripts"), { recursive: true });
    fs.cpSync(path.join(repoRoot, "package.json"), path.join(tmpDir, "package.json"));
    fs.cpSync(path.join(repoRoot, "tsconfig.json"), path.join(tmpDir, "tsconfig.json"));
    fs.symlinkSync(path.join(repoRoot, "node_modules"), path.join(tmpDir, "node_modules"), "junction");

    const bundlePath = path.join(tmpDir, "dist", "index.js");
    const mapPath = path.join(tmpDir, "dist", "index.js.map");

    try {
      exec(process.execPath, [path.join(tmpDir, "scripts", "build.mjs")], {
        cwd: tmpDir,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
        maxBuffer: 50 * 1024 * 1024,
        timeout: 120_000,
      });
    } catch (error) {
      const stdout = streamOf(error, "stdout");
      const stderr = streamOf(error, "stderr");
      cleanup();
      throw new Error(
        `Fresh build in ${tmpDir} failed:\n${stdout}${stderr}\n${String(error)}`,
      );
    }

    if (!fs.existsSync(bundlePath) || !fs.existsSync(mapPath)) {
      cleanup();
      throw new Error(`Fresh build did not produce ${bundlePath} and ${mapPath}`);
    }

    return { bundlePath, mapPath, tmpDir, cleanup };
  } catch (error) {
    cleanup();
    throw error;
  }
}

/** Reads a `stdout`/`stderr` string off a caught value of any type. */
function streamOf(error: unknown, key: "stdout" | "stderr"): string {
  if (typeof error === "object" && error !== null && key in error) {
    const value = (error as Record<string, unknown>)[key];
    return typeof value === "string" ? value : "";
  }
  return "";
}

/**
 * #673: failure-path coverage for this helper.
 *
 * The issue scopes the change to `tests/helpers/fresh-build.ts`, so the
 * assertions live beside the code they cover rather than in a new test file.
 * Vitest registers them whenever a suite imports `freshBuild` (today
 * `tests/unit/bundle-guard.test.ts`), so `npm test` runs them. The child
 * process is injected, which keeps the failure cases off a real
 * `scripts/build.mjs` run while preserving exit-code semantics: a non-zero
 * exit is a thrown error that carries the script's `stderr`, and exit code 0
 * returns the generated artifacts.
 */
describe("freshBuild error propagation (#673)", () => {
  const tempPrefix = "bundle-guard-build-";

  function countTempBuilds(): number {
    return fs.readdirSync(os.tmpdir()).filter((name) => name.startsWith(tempPrefix)).length;
  }

  it("propagates a non-zero build exit code as a thrown error with its stderr", () => {
    let buildCwd: string | undefined;
    const failure = Object.assign(new Error("Command failed: node scripts/build.mjs"), {
      status: 1,
      signal: null,
      stdout: "bundling src/main.ts\n",
      stderr: 'error: Could not resolve "../src/main"\n',
    });
    const exec = ((_file: string, _args: readonly string[], execOptions: { cwd?: string }) => {
      buildCwd = execOptions.cwd;
      throw failure;
    }) as unknown as ExecFile;

    const before = countTempBuilds();
    let thrown: unknown;
    try {
      freshBuild({ exec });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(Error);
    const message = String(thrown);
    // The failure is reported as a fresh-build error, not swallowed.
    expect(message).toContain("Fresh build");
    expect(message).toContain("failed");
    // The build script's own diagnostics reach the caller.
    expect(message).toContain('error: Could not resolve "../src/main"');
    // The non-zero exit code is propagated, never treated as success.
    expect(message).toContain("Command failed");
    // Temporary build artifacts are cleaned up when the build fails.
    expect(buildCwd).toBeDefined();
    expect(fs.existsSync(buildCwd!)).toBe(false);
    expect(countTempBuilds()).toBe(before);
  });

  it("returns the generated bundle when the build script exits 0", () => {
    const exec = ((_file: string, _args: readonly string[], execOptions: { cwd?: string }) => {
      const dist = path.join(String(execOptions.cwd), "dist");
      fs.mkdirSync(dist, { recursive: true });
      fs.writeFileSync(path.join(dist, "index.js"), "module.exports = {};\n");
      fs.writeFileSync(path.join(dist, "index.js.map"), "{}\n");
      return "";
    }) as unknown as ExecFile;

    const result = freshBuild({ exec });
    try {
      expect(fs.existsSync(result.bundlePath)).toBe(true);
      expect(fs.existsSync(result.mapPath)).toBe(true);
    } finally {
      result.cleanup();
    }
    expect(fs.existsSync(result.tmpDir)).toBe(false);
  });
});
