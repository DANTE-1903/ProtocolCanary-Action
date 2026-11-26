/**
 * Tests for renderReproductionCommand, protocolMismatchMessage, and
 * renderExecutionFailureMarkdown (issue #737).
 *
 * Verifies that shell quoting is applied correctly to args with special
 * characters, that the reproduction command is wrapped in the expected
 * <details> block, that protocol mismatches produce meaningful messages,
 * and that the execution failure block has the correct structure.
 */
import { describe, expect, it } from "vitest";

import { quoteForShell } from "../../src/markdown";
import {
  TRUNCATION_NOTICE,
  protocolMismatchMessage,
  renderExecutionFailureMarkdown,
  renderReproductionCommand,
} from "../../src/summary";
import { report } from "./helpers";

// ─── quoteForShell ────────────────────────────────────────────────────────────

describe("quoteForShell (issue #737)", () => {
  it("leaves safe alphanumeric args unquoted", () => {
    expect(quoteForShell("check")).toBe("check");
    expect(quoteForShell("stellar-canary")).toBe("stellar-canary");
    expect(quoteForShell("0.2.0")).toBe("0.2.0");
    expect(quoteForShell("path/to/file")).toBe("path/to/file");
  });

  it("leaves option-shaped args unquoted (they begin with -)", () => {
    expect(quoteForShell("--format")).toBe("--format");
    expect(quoteForShell("--format=json")).toBe("--format=json");
    expect(quoteForShell("--network=testnet")).toBe("--network=testnet");
    expect(quoteForShell("-v")).toBe("-v");
  });

  it("wraps args containing spaces in single quotes", () => {
    expect(quoteForShell("hello world")).toBe("'hello world'");
    expect(quoteForShell("path with spaces/file")).toBe("'path with spaces/file'");
  });

  it("wraps args containing dollar signs in single quotes", () => {
    expect(quoteForShell("$SECRET")).toBe("'$SECRET'");
    expect(quoteForShell("value=$HOME")).toBe("'value=$HOME'");
  });

  it("wraps args containing semicolons in single quotes", () => {
    expect(quoteForShell("a;b")).toBe("'a;b'");
    expect(quoteForShell(";rm -rf /")).toBe("';rm -rf /'");
  });

  it("escapes embedded single quotes with the POSIX idiom '\\''", () => {
    expect(quoteForShell("it's")).toBe("'it'\\''s'");
    expect(quoteForShell("can't stop")).toBe("'can'\\''t stop'");
    expect(quoteForShell("a'b'c")).toBe("'a'\\''b'\\''c'");
  });

  it("wraps args containing backticks in single quotes", () => {
    expect(quoteForShell("`cmd`")).toBe("'`cmd`'");
  });

  it("wraps args containing double quotes in single quotes", () => {
    expect(quoteForShell('"quoted"')).toBe("'\"quoted\"'");
  });

  it("wraps args containing pipe characters in single quotes", () => {
    expect(quoteForShell("a|b")).toBe("'a|b'");
  });

  it("wraps args containing ampersands in single quotes", () => {
    expect(quoteForShell("a&b")).toBe("'a&b'");
  });

  it("wraps a bare equals sign (non-option assignment) in single quotes", () => {
    // NAME=value at arg start (not preceded by -) must be quoted: shells treat
    // it as an env-var prefix if unquoted.
    expect(quoteForShell("NAME=value")).toBe("'NAME=value'");
  });

  it("wraps args starting with = in single quotes", () => {
    // A leading = would trigger zsh =command expansion.
    expect(quoteForShell("=value")).toBe("'=value'");
  });

  it("roundtrips through single-quote wrapping correctly for complex args", () => {
    const arg = "it's a 'test' with $pecial chars";
    const quoted = quoteForShell(arg);
    // Verify the result starts and ends with single quotes and embeds the escape idiom
    expect(quoted.startsWith("'")).toBe(true);
    expect(quoted.endsWith("'")).toBe(true);
    expect(quoted).toContain("'\\''");
  });
});

// ─── renderReproductionCommand ────────────────────────────────────────────────

describe("renderReproductionCommand (issue #737)", () => {
  it("wraps the command in a <details><summary>Reproduction command</summary> block", () => {
    const output = renderReproductionCommand(["check", "--format", "json"]);
    expect(output).toContain("<details><summary>Reproduction command</summary>");
    expect(output).toContain("</details>");
  });

  it("includes stellar-canary as the command prefix", () => {
    const output = renderReproductionCommand(["check"]);
    expect(output).toContain("stellar-canary");
    expect(output).toContain("check");
  });

  it("includes the engine version when provided", () => {
    const output = renderReproductionCommand(["check"], "0.2.0");
    expect(output).toContain("0.2.0");
    expect(output).toContain("Engine version");
  });

  it("omits the engine version line when not provided", () => {
    const output = renderReproductionCommand(["check"]);
    expect(output).not.toContain("Engine version");
  });

  it("wraps args containing spaces in single quotes", () => {
    const output = renderReproductionCommand(["check", "path with spaces"]);
    expect(output).toContain("'path with spaces'");
  });

  it("wraps args containing dollar signs in single quotes", () => {
    const output = renderReproductionCommand(["check", "$HOME/fixtures"]);
    expect(output).toContain("'$HOME/fixtures'");
  });

  it("wraps args containing semicolons in single quotes", () => {
    const output = renderReproductionCommand(["check", "a;b"]);
    expect(output).toContain("'a;b'");
  });

  it("wraps args containing single quotes using the POSIX escape idiom", () => {
    const output = renderReproductionCommand(["check", "it's"]);
    expect(output).toContain("'it'\\''s'");
  });

  it("leaves safe flag args unquoted for readability", () => {
    const output = renderReproductionCommand(["check", "--format", "json", "--protocol", "28"]);
    expect(output).toContain("--format");
    expect(output).toContain("json");
    expect(output).toContain("--protocol");
    expect(output).toContain("28");
    // These should NOT be wrapped in single quotes
    expect(output).not.toContain("'json'");
    expect(output).not.toContain("'28'");
  });

  it("wraps the command in a fenced code block", () => {
    const output = renderReproductionCommand(["check", "--format", "json"]);
    // Should contain a fenced code block (``` at minimum)
    expect(output).toMatch(/```/);
  });

  it("produces a command starting with stellar-canary followed by all args", () => {
    const args = ["check", "--format", "json", "--network", "testnet"];
    const output = renderReproductionCommand(args);
    // The command line in order
    expect(output).toMatch(/stellar-canary.*check.*--format.*json.*--network.*testnet/s);
  });
});

// ─── protocolMismatchMessage ──────────────────────────────────────────────────

describe("protocolMismatchMessage (issue #737)", () => {
  it("returns undefined when observed and target protocols match", () => {
    const r = report({ targetProtocol: 28, network: { name: "testnet", observedProtocol: 28 } });
    expect(protocolMismatchMessage(r)).toBeUndefined();
  });

  it("returns a message when observed protocol differs from target", () => {
    const r = report({ targetProtocol: 28, network: { name: "testnet", observedProtocol: 27 } });
    const msg = protocolMismatchMessage(r);
    expect(msg).toBeDefined();
    expect(msg).toContain("27"); // observed
    expect(msg).toContain("28"); // target
    expect(msg).toContain("Protocol mismatch");
  });

  it("returns undefined when there is no network field", () => {
    const r = report({ targetProtocol: 28 });
    expect(protocolMismatchMessage(r)).toBeUndefined();
  });

  it("returns undefined when observedProtocol is not a number", () => {
    const r = report({ targetProtocol: 28, network: { name: "testnet" } } as Parameters<typeof report>[0]);
    expect(protocolMismatchMessage(r)).toBeUndefined();
  });

  it("returns undefined when observedProtocol is 0 or negative", () => {
    const r0 = report({
      targetProtocol: 28,
      network: { name: "testnet", observedProtocol: 0 },
    });
    expect(protocolMismatchMessage(r0)).toBeUndefined();
    const rNeg = report({
      targetProtocol: 28,
      network: { name: "testnet", observedProtocol: -1 },
    });
    expect(protocolMismatchMessage(rNeg)).toBeUndefined();
  });

  it("includes both protocol numbers in the message for easy diagnosis", () => {
    const r = report({ targetProtocol: 20, network: { name: "mainnet", observedProtocol: 21 } });
    const msg = protocolMismatchMessage(r);
    expect(msg).toContain("20");
    expect(msg).toContain("21");
  });
});

// ─── renderExecutionFailureMarkdown ───────────────────────────────────────────

describe("renderExecutionFailureMarkdown (issue #737)", () => {
  it("contains the Stellar Protocol Canary heading", () => {
    const output = renderExecutionFailureMarkdown("process exited 1", "some error");
    expect(output).toContain("## Stellar Protocol Canary");
  });

  it("contains the ERROR result indicator", () => {
    const output = renderExecutionFailureMarkdown("process exited 1", "some error");
    expect(output).toContain("🚫 **ERROR**");
  });

  it("includes the reason text", () => {
    const output = renderExecutionFailureMarkdown("process exited with code 2", "");
    expect(output).toContain("process exited with code 2");
    expect(output).toContain("Reason:");
  });

  it("includes the diagnostic text in a fenced code block", () => {
    const diagnostic = "error: fixture not found";
    const output = renderExecutionFailureMarkdown("process exited 1", diagnostic);
    expect(output).toContain(diagnostic);
    // Should be in a fenced code block
    expect(output).toMatch(/```text\n/);
  });

  it("renders '(no diagnostic output)' when diagnostic is empty", () => {
    const output = renderExecutionFailureMarkdown("process exited 1", "");
    expect(output).toContain("(no diagnostic output)");
  });

  it("renders '(no diagnostic output)' when diagnostic is whitespace only", () => {
    const output = renderExecutionFailureMarkdown("process exited 1", "   \n  ");
    expect(output).toContain("(no diagnostic output)");
  });

  it("includes the artifact link when artifact id is provided", () => {
    const output = renderExecutionFailureMarkdown("process exited 1", "some error", {
      id: 42,
      name: "canary-report",
    });
    expect(output).toContain("canary-report");
    expect(output).toContain("42");
    expect(output).toContain("Report artifact:");
  });

  it("omits the artifact link when no artifact is provided", () => {
    const output = renderExecutionFailureMarkdown("process exited 1", "some error");
    expect(output).not.toContain("Report artifact:");
  });

  it("uses at least MAX_EMBEDDED_FENCE_LENGTH (20) backticks for the diagnostic fence", () => {
    // renderExecutionFailureMarkdown always uses a fence of at least 20 backticks
    // (MAX_EMBEDDED_FENCE_LENGTH), regardless of diagnostic content.
    const diagnostic = "error: some diagnostic text";
    const output = renderExecutionFailureMarkdown("failure", diagnostic);
    // A 3-backtick fence line should not appear — the minimum is 20
    expect(output).not.toMatch(/^```text$/m);
    // A 20-backtick fence line should appear
    expect(output).toMatch(/^`{20}text$/m);
    expect(output).toContain(diagnostic);
  });

  it("does not contain TRUNCATION_NOTICE", () => {
    const output = renderExecutionFailureMarkdown("process exited 1", "some error");
    expect(output).not.toContain(TRUNCATION_NOTICE);
  });
});
