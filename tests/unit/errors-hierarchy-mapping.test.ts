import { describe, expect, it } from "vitest";

import {
  CanaryActionError,
  CanaryExecutionFailedError,
  CanaryNotFoundError,
  ChecksumMismatchError,
  ConfigNotFoundError,
  InstallationFailedError,
  InvalidInputError,
  InvalidReportError,
  SummaryPublishFailedError,
  TimeoutError,
  describeError,
  isCanaryActionError,
} from "../../src/errors";
import { describeExitCode } from "../../src/output";

/**
 * Issue #748: the Action keeps a typed error taxonomy so a compatibility
 * failure (Canary ran and found a real problem) is never confused with the
 * Action failing to run Canary at all. `src/errors.ts` names the categories;
 * `describeExitCode` in `src/output.ts` is the Action's only understanding of
 * what an engine exit code means. Neither side may drift from the other.
 */
const concreteErrors: CanaryActionError[] = [
  new InvalidInputError("invalid input"),
  new ConfigNotFoundError("/work/.stellar-canary.toml"),
  new CanaryNotFoundError("no usable stellar-canary binary"),
  new InstallationFailedError("installing stellar-canary failed"),
  new ChecksumMismatchError("checksum mismatch"),
  new CanaryExecutionFailedError("stellar-canary failed to run"),
  new TimeoutError("stellar-canary timed out"),
  new InvalidReportError("report did not match the schema"),
  new SummaryPublishFailedError("publishing the job summary failed"),
];

describe("CanaryActionError hierarchy", () => {
  it("makes every category a real Error with its own class identity", () => {
    for (const error of concreteErrors) {
      expect(error).toBeInstanceOf(Error);
      expect(error).toBeInstanceOf(CanaryActionError);
      expect(isCanaryActionError(error)).toBe(true);
      // The base constructor assigns `name` from `new.target.name`, so a
      // subclass that forgets neither its name nor its identity is obvious.
      expect(error.name).toBe(error.constructor.name);
    }
  });

  it("gives each category a distinct class and a distinct code", () => {
    const names = concreteErrors.map((error) => error.constructor.name);
    const codes = concreteErrors.map((error) => error.code);

    expect(new Set(names).size).toBe(concreteErrors.length);
    expect(new Set(codes).size).toBe(concreteErrors.length);
  });

  it("maps each category to its documented code", () => {
    const documented: ReadonlyArray<readonly [CanaryActionError, string]> = [
      [new InvalidInputError("x"), "InvalidInput"],
      [new ConfigNotFoundError("/x"), "ConfigNotFound"],
      [new CanaryNotFoundError("x"), "CanaryNotFound"],
      [new InstallationFailedError("x"), "InstallationFailed"],
      [new ChecksumMismatchError("x"), "ChecksumMismatch"],
      [new CanaryExecutionFailedError("x"), "CanaryExecutionFailed"],
      [new TimeoutError("x"), "Timeout"],
      [new InvalidReportError("x"), "InvalidReport"],
      [new SummaryPublishFailedError("x"), "SummaryPublishFailed"],
    ];

    for (const [error, code] of documented) {
      expect(error.code).toBe(code);
    }
  });

  it("preserves the structured diagnostics each category carries", () => {
    const config = new ConfigNotFoundError("/work/.stellar-canary.toml");
    expect(config.path).toBe("/work/.stellar-canary.toml");
    expect(config.message).toBe("Configuration file not found: /work/.stellar-canary.toml");

    const installation = new InstallationFailedError("install failed", "cargo exited 1");
    expect(installation.diagnostic).toBe("cargo exited 1");

    const checksum = new ChecksumMismatchError("digest mismatch", "expected-digest", "actual-digest");
    expect(checksum.expected).toBe("expected-digest");
    expect(checksum.actual).toBe("actual-digest");

    const timeout = new TimeoutError("timed out", "partial stdout", "partial stderr");
    expect(timeout.stdout).toBe("partial stdout");
    expect(timeout.stderr).toBe("partial stderr");
  });

  it("rejects a value that is not one of the Action's own errors", () => {
    expect(isCanaryActionError(new Error("plain"))).toBe(false);
    expect(isCanaryActionError("a string")).toBe(false);
    expect(isCanaryActionError({ code: "Timeout" })).toBe(false);
  });
});

describe("error cause chaining", () => {
  it("keeps the underlying root cause reachable on a wrapped error", () => {
    const root = new Error("spawn ENOENT");
    const wrapped = new Error("could not start stellar-canary", { cause: root });

    expect(wrapped.cause).toBe(root);
    // The cause is available for debugging but is never part of the message
    // that reaches a job log.
    expect(describeError(wrapped)).toBe("could not start stellar-canary");
  });

  it("keeps a cause attached to a typed error without printing it", () => {
    const root = new Error("root failure under /home/runner/.cargo");
    const error = new InstallationFailedError("cargo install failed", "exit 1");
    Object.defineProperty(error, "cause", { value: root, configurable: true, enumerable: false });

    expect(error.cause).toBe(root);
    expect(describeError(error)).toBe("cargo install failed");
  });

  it("does not invent a cause for errors the Action raises directly", () => {
    expect(new CanaryExecutionFailedError("engine crashed").cause).toBeUndefined();
    expect(new TimeoutError("timed out").cause).toBeUndefined();
  });
});

describe("error serialization for user-facing logs", () => {
  it("describes a typed error as a single line of message only", () => {
    const error = new InvalidReportError("report did not match the schema");
    const described = describeError(error);

    expect(described).toBe("report did not match the schema");
    expect(described.split("\n")).toHaveLength(1);
    expect(described).not.toMatch(/\n\s+at /);
  });

  it("says nothing about the stack frames that point at internal files", () => {
    const error = new CanaryNotFoundError("no usable stellar-canary binary");
    const described = describeError(error);

    expect(described).not.toContain("errors.ts");
    expect(described).not.toContain("function ");
  });

  it("serializes a plain thrown object instead of printing [object Object]", () => {
    expect(describeError({ stage: "install", code: 3 })).toBe('{"stage":"install","code":3}');
  });
});

describe("engine exit-code diagnostic mapping", () => {
  const documented: ReadonlyArray<readonly [number, string]> = [
    [0, "pass"],
    [1, "compatibility_failure"],
    [2, "configuration_error"],
    [3, "execution_error"],
    [4, "invalid_fixture"],
    [5, "internal_error"],
    [6, "verification_failure"],
  ];

  it("maps the documented engine exit codes to their categories", () => {
    for (const [code, category] of documented) {
      expect(describeExitCode(code).category).toBe(category);
      expect(describeExitCode(code).description.length).toBeGreaterThan(0);
    }
  });

  it("gives every documented code a distinct diagnostic", () => {
    const descriptions = documented.map(([code]) => describeExitCode(code).description);

    expect(new Set(descriptions).size).toBe(documented.length);
  });

  it("keeps a real compatibility failure distinct from an execution error", () => {
    // Exit 1 is Canary's verdict; exit 3 means the check never completed. They
    // must never be reported as the same kind of outcome.
    expect(describeExitCode(1).category).not.toBe(describeExitCode(3).category);
    expect(describeExitCode(1).description).toContain("compatibility assertion failed");
    expect(describeExitCode(3).description).toContain("could not complete");
  });

  it("treats codes outside the documented contract as unknown", () => {
    // The Action documents 0-6; anything else (including a hypothetical 7 or
    // a signal-derived code) must fall back rather than be misreported.
    for (const code of [7, 8, 42, 255, -1]) {
      const info = describeExitCode(code);

      expect(info.category).toBe("unknown");
      expect(info.description).toContain(String(code));
    }
  });
});
