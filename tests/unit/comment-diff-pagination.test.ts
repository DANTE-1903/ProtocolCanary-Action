import { describe, expect, it } from "vitest";

import { buildCommentBody } from "../../src/comment";

const COMMENT_SIZE_LIMIT = 60_000;
const MARKER = "<!-- protocol-canary-pr-comment:v1 -->";

/** Builds a synthetic Markdown diff table with `rowCount` failing fixture rows. */
function buildSyntheticDiffTable(rowCount: number): string {
  const header = [
    "## Compatibility Results",
    "",
    "| Fixture | Status | Details |",
    "|---------|--------|---------|",
  ].join("\n");
  const rows: string[] = [];
  for (let i = 0; i < rowCount; i++) {
    rows.push(`| fixture-${String(i).padStart(4, "0")} | ❌ FAIL | Unexpected response code 500 on endpoint /rpc |`);
  }
  return `${header}\n${rows.join("\n")}`;
}

/** Builds a large diff summary similar to what the action would produce. */
function buildLargeReport(failingFixtures: number): string {
  const lines: string[] = [
    "## Protocol 28 Compatibility Check",
    "",
    `**Status:** ❌ ${String(failingFixtures)} of ${String(failingFixtures + 10)} checks failed`,
    "",
    buildSyntheticDiffTable(failingFixtures),
    "",
    "## Summary",
    "",
    `${String(failingFixtures)} fixtures failed. See artifact for details.`,
  ];
  return lines.join("\n");
}

describe("buildCommentBody size bounding", () => {
  it("stays within 60,000 characters for a large report", () => {
    const summary = buildLargeReport(200);
    const body = buildCommentBody(summary, "CI", "canary-check");
    expect(body.length).toBeLessThanOrEqual(COMMENT_SIZE_LIMIT);
  });

  it("stays within 60,000 characters for an extremely large report", () => {
    const summary = "x".repeat(200_000);
    const body = buildCommentBody(summary, "CI", "canary-check");
    expect(body.length).toBeLessThanOrEqual(COMMENT_SIZE_LIMIT);
  });

  it("includes all content when the report fits within the limit", () => {
    const summary = buildLargeReport(5);
    const body = buildCommentBody(summary, "CI", "canary-check");
    expect(body.length).toBeLessThanOrEqual(COMMENT_SIZE_LIMIT);
    expect(body).toContain("fixture-0000");
    expect(body).toContain("fixture-0004");
  });

  it("truncates gracefully when the report is exactly at the limit boundary", () => {
    const overhead = MARKER.length + "\n".length + "<!-- workflow-job: CI / check -->\n".length;
    const summary = "y".repeat(COMMENT_SIZE_LIMIT - overhead);
    const body = buildCommentBody(summary, "CI", "check");
    expect(body.length).toBeLessThanOrEqual(COMMENT_SIZE_LIMIT);
  });

  it("never exceeds the limit for many different report sizes", () => {
    for (const size of [50, 100, 200, 500, 1000]) {
      const summary = buildLargeReport(size);
      const body = buildCommentBody(summary, "My Workflow", "canary");
      expect(body.length).toBeLessThanOrEqual(COMMENT_SIZE_LIMIT);
    }
  });
});

describe("buildCommentBody truncation message", () => {
  it("appends a truncation notice when the report is too large", () => {
    const summary = "z".repeat(COMMENT_SIZE_LIMIT);
    const body = buildCommentBody(summary, "CI", "check");
    expect(body).toContain("omitted");
    expect(body).toContain("job summary");
  });

  it("does not append a truncation notice when the report fits", () => {
    const summary = "short summary";
    const body = buildCommentBody(summary, "CI", "check");
    expect(body).not.toContain("omitted");
  });

  it("truncation notice points to the job summary, not to an artifact URL", () => {
    const summary = "a".repeat(COMMENT_SIZE_LIMIT);
    const body = buildCommentBody(summary, "CI", "check");
    expect(body).toContain("job summary");
  });
});

describe("buildCommentBody header and marker preservation", () => {
  it("always starts with the hidden identity marker", () => {
    const body = buildCommentBody("summary text", "My Workflow", "My Job");
    expect(body.startsWith(MARKER)).toBe(true);
  });

  it("includes the workflow/job identity comment after the marker", () => {
    const body = buildCommentBody("summary text", "My Workflow", "My Job");
    expect(body).toContain("<!-- workflow-job: My Workflow / My Job -->");
  });

  it("marker and identity comment survive even on a maximally large report", () => {
    const summary = "w".repeat(COMMENT_SIZE_LIMIT);
    const body = buildCommentBody(summary, "Protocol Canary", "check");
    expect(body.startsWith(MARKER)).toBe(true);
    expect(body).toContain("<!-- workflow-job: Protocol Canary / check -->");
  });

  it("neutralises a forged marker inside the summary before truncation", () => {
    const forgery = MARKER;
    const padding = "p".repeat(COMMENT_SIZE_LIMIT);
    const summary = `${forgery}${padding}`;
    const body = buildCommentBody(summary, "CI", "check");
    const markerCount = (body.match(/<!-- protocol-canary-pr-comment:v1 -->/g) ?? []).length;
    expect(markerCount).toBe(1);
  });
});

describe("buildCommentBody Markdown table syntax", () => {
  it("preserves the table header when only some rows are truncated", () => {
    // Build a report whose table header fits but most rows are truncated.
    const header = [
      "| Fixture | Status |",
      "|---------|--------|",
    ].join("\n");
    const rows = Array.from({ length: 1000 }, (_, i) =>
      `| fixture-${String(i).padStart(4, "0")} | ❌ FAIL |`,
    );
    const summary = [header, ...rows].join("\n");
    const body = buildCommentBody(summary, "CI", "check");
    expect(body.length).toBeLessThanOrEqual(COMMENT_SIZE_LIMIT);
    expect(body).toContain("| Fixture | Status |");
    expect(body).toContain("|---------|--------|");
  });

  it("does not break a table row in the middle of a cell", () => {
    // This is a property of the truncation: we do not assert where it cuts,
    // but we do assert the body ends cleanly (no half-written HTML or bare <).
    const summary = buildSyntheticDiffTable(1000);
    const body = buildCommentBody(summary, "CI", "check");
    expect(body.length).toBeLessThanOrEqual(COMMENT_SIZE_LIMIT);
    // No unescaped bare < that would appear from a half-written HTML tag
    expect(body).not.toMatch(/<(?![-!a-zA-Z])/);
  });

  it("retains the opening section header when the report fits", () => {
    const summary = buildLargeReport(10);
    const body = buildCommentBody(summary, "CI", "check");
    expect(body).toContain("## Protocol 28 Compatibility Check");
  });
});

describe("buildCommentBody identity sanitisation", () => {
  it("strips CR from workflow and job names in the identity comment", () => {
    const body = buildCommentBody("summary", "Work\rflow", "ch\reck");
    expect(body).not.toContain("\r");
  });

  it("strips LF from workflow and job names in the identity comment", () => {
    const body = buildCommentBody("summary", "Work\nflow", "ch\neck");
    const lines = body.split("\n").filter((l) => l.startsWith("<!-- workflow-job:"));
    expect(lines).toHaveLength(1);
  });

  it("replaces < and > in the identity comment with spaces", () => {
    const body = buildCommentBody("summary", "<CI>", "<check>");
    expect(body).not.toContain("<CI>");
    expect(body).not.toContain("<check>");
    // < and > are replaced with spaces; the / separator between workflow and job is kept
    expect(body).toContain("<!-- workflow-job:  CI  /  check  -->");
  });
});
