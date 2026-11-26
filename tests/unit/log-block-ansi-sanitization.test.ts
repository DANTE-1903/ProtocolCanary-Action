import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const coreMocks = vi.hoisted(() => ({
  infoMock: vi.fn(),
  startGroupMock: vi.fn(),
  endGroupMock: vi.fn(),
}));

vi.mock("@actions/core", () => ({
  info: coreMocks.infoMock,
  startGroup: coreMocks.startGroupMock,
  endGroup: coreMocks.endGroupMock,
}));

import {
  DEFAULT_LOG_BLOCK_MAX_LINES,
  TRUNCATION_NOTICE,
  printLogBlock,
  sanitizeLogText,
  truncateLogTail,
} from "../../src/log-block";

/** The text passed to printLogBlock, i.e. everything after the stop-commands token. */
function printedText(): string {
  const infoCalls = coreMocks.infoMock.mock.calls.map((call) => String(call[0]));
  return infoCalls[1] ?? "";
}

describe("sanitizeLogText ANSI stripping (#743)", () => {
  it("strips CSI color, reset, erase and cursor-movement sequences", () => {
    const raw =
      "\x1B[1;31mFAIL\x1B[0m \x1B[38;5;208mwarning\x1B[39m\x1B[2K\x1B[1A\x1B[3Grestored";

    expect(sanitizeLogText(raw)).toBe("FAIL warningrestored");
  });

  it("strips simple two-character escapes and any leftover ESC byte", () => {
    const raw = "\x1BMinverse index\x1B\x1BD";

    expect(sanitizeLogText(raw)).toBe("inverse index");
  });

  it("removes every escape byte from an OSC 8 hyperlink while keeping its label", () => {
    const raw = "\x1B]8;;https://example.com/build/42\x1B\\click here\x1B]8;;\x1B\\ done";

    const sanitized = sanitizeLogText(raw);

    expect(sanitized).not.toContain("\x1B");
    expect(sanitized).toContain("click here");
    expect(sanitized).toContain("done");
  });

  it("removes ESC and BEL bytes from an OSC window-title sequence", () => {
    const raw = "\x1B]0;cargo build: 1m 02s\x07compiling crate";

    const sanitized = sanitizeLogText(raw);

    expect(sanitized).not.toContain("\x1B");
    expect(sanitized).not.toContain("\x07");
    expect(sanitized).toContain("compiling crate");
  });

  it("keeps newlines and tabs while dropping other control characters", () => {
    const raw = "\x1B[32mok\x1B[0m\r\n\tindented\x00\x07\x1F";

    expect(sanitizeLogText(raw)).toBe("ok\n\tindented");
  });
});

describe("printLogBlock fold markers (#743)", () => {
  beforeEach(() => {
    coreMocks.infoMock.mockClear();
    coreMocks.startGroupMock.mockClear();
    coreMocks.endGroupMock.mockClear();
  });

  it("wraps sanitized diagnostics in a group bounded by a fresh stop-commands token", () => {
    printLogBlock("cargo install", "\x1B[31merror\x1B[0m: \x1B[1mboom\x1B[0m");

    expect(coreMocks.startGroupMock).toHaveBeenCalledWith("cargo install");
    expect(coreMocks.endGroupMock).toHaveBeenCalledTimes(1);
    expect(printedText()).toBe("error: boom");

    const infoCalls = coreMocks.infoMock.mock.calls.map((call) => String(call[0]));
    const opening = /^::stop-commands::([0-9a-f]{32})$/.exec(infoCalls[0] ?? "");
    expect(opening).not.toBeNull();
    expect(infoCalls[2]).toBe(`::${opening?.[1] ?? ""}::`);
  });

  it("generates a different stop-commands token per call so a block cannot forge its end", () => {
    printLogBlock("first", "one");
    printLogBlock("second", "two");

    const tokens = coreMocks.infoMock.mock.calls
      .map((call) => String(call[0]))
      .filter((line) => line.startsWith("::stop-commands::"));

    expect(tokens).toHaveLength(2);
    expect(tokens[0]).not.toBe(tokens[1]);
  });

  it("neutralises workflow commands inside the diagnostic text", () => {
    printLogBlock("diagnostics", "boom\n::error::Injected workflow command");

    expect(printedText()).not.toContain("::error::");
    expect(printedText()).toContain("Injected workflow command");
  });

  it("prints no group at all for empty or whitespace-only output", () => {
    printLogBlock("empty", "   \n\t\n");

    expect(coreMocks.startGroupMock).not.toHaveBeenCalled();
    expect(coreMocks.endGroupMock).not.toHaveBeenCalled();
    expect(coreMocks.infoMock).not.toHaveBeenCalled();
  });
});

describe("truncateLogTail (#743)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("keeps the tail of a long log and prepends the truncation notice", () => {
    const lines = Array.from({ length: 250 }, (_, index) => `line ${index + 1}`);

    const { text, truncated } = truncateLogTail(lines.join("\n"), 200);

    expect(truncated).toBe(true);
    expect(text.startsWith(TRUNCATION_NOTICE)).toBe(true);
    const kept = text.slice(TRUNCATION_NOTICE.length).split("\n");
    expect(kept).toHaveLength(200);
    expect(kept[0]).toBe("line 51");
    expect(kept[kept.length - 1]).toBe("line 250");
  });

  it("uses the documented default line limit when no options are given", () => {
    const lines = Array.from({ length: DEFAULT_LOG_BLOCK_MAX_LINES + 5 }, (_, index) => `l${index}`);

    const { text, truncated } = truncateLogTail(lines.join("\n"));

    expect(truncated).toBe(true);
    expect(text.slice(TRUNCATION_NOTICE.length).split("\n")).toHaveLength(
      DEFAULT_LOG_BLOCK_MAX_LINES,
    );
  });

  it("enforces the byte limit without splitting multi-byte UTF-8 text", () => {
    const { text, truncated } = truncateLogTail("é".repeat(100), 1_000, 50);

    expect(truncated).toBe(true);
    expect(text.startsWith(TRUNCATION_NOTICE)).toBe(true);
    const body = text.slice(TRUNCATION_NOTICE.length);
    expect(body).toBe("é".repeat(7));
    expect(Buffer.byteLength(text, "utf8")).toBeLessThanOrEqual(50);
    expect(text).not.toContain("\uFFFD");
  });

  it("leaves text within both limits untouched", () => {
    const raw = "one\ntwo\nthree";

    expect(truncateLogTail(raw, 10, 1024)).toEqual({ text: raw, truncated: false });
    expect(truncateLogTail(raw, 3, Buffer.byteLength(raw, "utf8"))).toEqual({
      text: raw,
      truncated: false,
    });
  });
});
