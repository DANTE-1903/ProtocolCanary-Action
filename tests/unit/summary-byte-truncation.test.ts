/**
 * Tests for GitHub Step Summary byte-limit truncation and writeSummary
 * error handling (issue #738).
 *
 * Verifies that renderSummaryMarkdown appends TRUNCATION_NOTICE when the
 * rendered output exceeds SUMMARY_BYTE_LIMIT, that under-limit reports are
 * returned unchanged, that UTF-8 multi-byte boundaries are respected, and
 * that writeSummary wraps core.summary failures in SummaryPublishFailedError.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import { SummaryPublishFailedError } from "../../src/errors";
import {
  SUMMARY_BYTE_LIMIT,
  TRUNCATION_NOTICE,
  renderSummaryMarkdown,
  writeSummary,
} from "../../src/summary";
import { report, result } from "./helpers";

// ─── @actions/core mock for writeSummary tests ────────────────────────────────

const { summaryWriteMock } = vi.hoisted(() => ({
  summaryWriteMock: vi.fn<[], Promise<typeof undefined>>(),
}));

vi.mock("@actions/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@actions/core")>();
  return {
    ...actual,
    summary: {
      addRaw: vi.fn().mockReturnValue({ write: summaryWriteMock }),
    },
  };
});

beforeEach(() => {
  summaryWriteMock.mockReset();
  summaryWriteMock.mockResolvedValue(undefined);
});

// ─── under-limit reports ──────────────────────────────────────────────────────

describe("renderSummaryMarkdown under-limit (issue #738)", () => {
  it("does not append TRUNCATION_NOTICE when the report is small", () => {
    const small = report({ status: "pass" });
    const markdown = renderSummaryMarkdown(small);
    expect(markdown).not.toContain(TRUNCATION_NOTICE);
    expect(Buffer.byteLength(markdown, "utf8")).toBeLessThan(SUMMARY_BYTE_LIMIT);
  });

  it("includes the project name in the output", () => {
    // Use a name without markdown-special characters so we can check the
    // literal string (escapeInline would otherwise backslash-escape - and .).
    const r = report({ project: { name: "myproject", type: "soroban" } });
    const markdown = renderSummaryMarkdown(r);
    expect(markdown).toContain("myproject");
  });

  it("includes the tool version in the output", () => {
    // escapeInline escapes . so "0.2.0" appears as "0\.2\.0" in the markdown
    const r = report({ toolVersion: "0.2.0" });
    const markdown = renderSummaryMarkdown(r);
    expect(markdown).toContain("0\\.2\\.0");
  });

  it("includes the target protocol in the output", () => {
    const r = report({ targetProtocol: 28 });
    const markdown = renderSummaryMarkdown(r);
    expect(markdown).toContain("28");
  });

  it("produces consistent output on repeated calls for the same report", () => {
    const r = report({ status: "pass" });
    expect(renderSummaryMarkdown(r)).toBe(renderSummaryMarkdown(r));
  });
});

// ─── over-limit truncation ────────────────────────────────────────────────────

describe("renderSummaryMarkdown over-limit truncation (issue #738)", () => {
  function buildOverLimitReport() {
    // 500 failing results with 2000-char details each produces > 1 MB of markdown
    const manyResults = Array.from({ length: 500 }, (_, i) =>
      result({
        testId: `fixture-${String(i).padStart(4, "0")}`,
        status: "fail",
        surface: "xdr",
        summary: "Protocol check failed",
        details: "diagnostic: ".concat("x".repeat(2000)),
      }),
    );
    return report({
      results: manyResults,
      status: "fail",
      counts: { total: 500, passed: 0, failed: 500, warnings: 0, errors: 0, skipped: 0 },
    });
  }

  it("appends TRUNCATION_NOTICE when markdown exceeds SUMMARY_BYTE_LIMIT", () => {
    const overLimitReport = buildOverLimitReport();
    const markdown = renderSummaryMarkdown(overLimitReport);
    expect(markdown.endsWith(TRUNCATION_NOTICE)).toBe(true);
  });

  it("truncated output stays at or below SUMMARY_BYTE_LIMIT bytes", () => {
    const overLimitReport = buildOverLimitReport();
    const markdown = renderSummaryMarkdown(overLimitReport);
    expect(Buffer.byteLength(markdown, "utf8")).toBeLessThanOrEqual(SUMMARY_BYTE_LIMIT);
  });

  it("truncated output still contains the report preamble (heading)", () => {
    const overLimitReport = buildOverLimitReport();
    const markdown = renderSummaryMarkdown(overLimitReport);
    expect(markdown).toContain("## Stellar Protocol Canary");
  });

  it("truncated output still contains the protocol number", () => {
    const overLimitReport = buildOverLimitReport();
    const markdown = renderSummaryMarkdown(overLimitReport);
    expect(markdown).toContain("28");
  });

  it("TRUNCATION_NOTICE appears exactly once in the truncated output", () => {
    const overLimitReport = buildOverLimitReport();
    const markdown = renderSummaryMarkdown(overLimitReport);
    const occurrences = (markdown.match(new RegExp(TRUNCATION_NOTICE.replace(/[[\]|!]/g, "\\$&"), "g")) ?? []).length;
    expect(occurrences).toBe(1);
  });

  it("TRUNCATION_NOTICE is a GitHub Markdown callout (starts with >)", () => {
    expect(TRUNCATION_NOTICE.startsWith(">")).toBe(true);
    expect(TRUNCATION_NOTICE).toContain("[!WARNING]");
  });

  it("non-truncated report output does not end with TRUNCATION_NOTICE", () => {
    const small = report({ status: "pass", results: [] });
    const markdown = renderSummaryMarkdown(small);
    expect(markdown.endsWith(TRUNCATION_NOTICE)).toBe(false);
  });
});

// ─── UTF-8 boundary safety ────────────────────────────────────────────────────

describe("renderSummaryMarkdown UTF-8 boundary safety (issue #738)", () => {
  it("produces valid UTF-8 output for a report with multi-byte characters", () => {
    const r = report({
      project: { name: "プロトコル検証", type: "soroban" },
      toolVersion: "0.1.0",
    });
    const markdown = renderSummaryMarkdown(r);
    // Re-encoding as UTF-8 and back should be lossless (no replacement characters)
    const roundTripped = Buffer.from(markdown, "utf8").toString("utf8");
    expect(roundTripped).not.toContain("�");
  });

  it("produces valid UTF-8 for truncated output with multi-byte characters in details", () => {
    // Fill result details with multi-byte emoji to stress UTF-8 boundary splitting
    const emoji = "🔥🌊⚡💥"; // 4 bytes each
    const manyResults = Array.from({ length: 400 }, (_, i) =>
      result({
        testId: `emo-${String(i)}`,
        status: "fail",
        summary: "emoji failure",
        details: emoji.repeat(500),
      }),
    );
    const r = report({
      results: manyResults,
      status: "fail",
      counts: { total: 400, passed: 0, failed: 400, warnings: 0, errors: 0, skipped: 0 },
    });
    const markdown = renderSummaryMarkdown(r);
    const roundTripped = Buffer.from(markdown, "utf8").toString("utf8");
    expect(roundTripped).not.toContain("�");
  });

  it("byte length of output is accurate (not off by UTF-8 encoding)", () => {
    const r = report({ project: { name: "日本語プロジェクト", type: "soroban" } });
    const markdown = renderSummaryMarkdown(r);
    const byteLen = Buffer.byteLength(markdown, "utf8");
    // Byte length must be >= char count (multi-byte chars push it higher)
    expect(byteLen).toBeGreaterThanOrEqual(markdown.length);
  });
});

// ─── writeSummary ─────────────────────────────────────────────────────────────

describe("writeSummary (issue #738)", () => {
  it("calls core.summary.addRaw with the markdown and resolves", async () => {
    await expect(writeSummary("# Hello")).resolves.toBeUndefined();
    const coreMod = await import("@actions/core");
    expect(coreMod.summary.addRaw).toHaveBeenCalledWith("# Hello", true);
  });

  it("calls write() on the value returned by addRaw", async () => {
    await writeSummary("# Test");
    expect(summaryWriteMock).toHaveBeenCalled();
  });

  it("throws SummaryPublishFailedError when write() rejects", async () => {
    summaryWriteMock.mockRejectedValueOnce(new Error("disk full"));
    await expect(writeSummary("# Test")).rejects.toBeInstanceOf(SummaryPublishFailedError);
  });

  it("SummaryPublishFailedError message includes the underlying error", async () => {
    summaryWriteMock.mockRejectedValueOnce(new Error("disk full"));
    await expect(writeSummary("# Test")).rejects.toThrow(/disk full/);
  });

  it("SummaryPublishFailedError has code SummaryPublishFailed", async () => {
    summaryWriteMock.mockRejectedValueOnce(new Error("write failure"));
    const err = await writeSummary("# Test").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SummaryPublishFailedError);
    if (err instanceof SummaryPublishFailedError) {
      expect(err.code).toBe("SummaryPublishFailed");
    }
  });

  it("resolves with undefined on success", async () => {
    const result = await writeSummary("## Success");
    expect(result).toBeUndefined();
  });

  it("propagates a non-Error thrown value wrapped in a SummaryPublishFailedError", async () => {
    // mockRejectedValueOnce is consumed by a single call — use two mocks for two assertions
    summaryWriteMock.mockRejectedValueOnce("string error");
    summaryWriteMock.mockRejectedValueOnce("string error 2");
    await expect(writeSummary("# Test")).rejects.toBeInstanceOf(SummaryPublishFailedError);
    await expect(writeSummary("# Test 2")).rejects.toBeInstanceOf(SummaryPublishFailedError);
  });
});

// ─── SUMMARY_BYTE_LIMIT and TRUNCATION_NOTICE constants ───────────────────────

describe("summary constants (issue #738)", () => {
  it("SUMMARY_BYTE_LIMIT is 1_000_000", () => {
    expect(SUMMARY_BYTE_LIMIT).toBe(1_000_000);
  });

  it("TRUNCATION_NOTICE is non-empty", () => {
    expect(TRUNCATION_NOTICE.length).toBeGreaterThan(0);
  });

  it("TRUNCATION_NOTICE byte length is well below SUMMARY_BYTE_LIMIT", () => {
    expect(Buffer.byteLength(TRUNCATION_NOTICE, "utf8")).toBeLessThan(SUMMARY_BYTE_LIMIT / 10);
  });
});
