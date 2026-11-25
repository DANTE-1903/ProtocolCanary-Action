import type * as actionsCore from "@actions/core";
import { afterEach, describe, expect, it, vi } from "vitest";

const { errorMock, warningMock, infoMock } = vi.hoisted(() => ({
  errorMock: vi.fn(),
  warningMock: vi.fn(),
  infoMock: vi.fn(),
}));

vi.mock("@actions/core", async (importOriginal) => {
  const actual = await importOriginal<typeof actionsCore>();
  return { ...actual, error: errorMock, warning: warningMock, info: infoMock };
});

import { emitAnnotations } from "../../src/annotations";
import { report, result } from "./helpers";

afterEach(() => {
  errorMock.mockReset();
  warningMock.mockReset();
  infoMock.mockReset();
});

describe("emitAnnotations runner limits (#614)", () => {
  it("caps error annotations at 10 and reports omitted results", () => {
    emitAnnotations(report(Array.from({ length: 15 }, (_, index) => result({ status: "fail", testId: `error-${index}` }))));

    expect(errorMock).toHaveBeenCalledTimes(10);
    expect(warningMock).not.toHaveBeenCalled();
    expect(infoMock).toHaveBeenCalledOnce();
    expect(infoMock.mock.calls[0]?.[0]).toContain("Suppressed 5 additional error results");
    expect(infoMock.mock.calls[0]?.[0]).toContain("job summary and report artifact");
  });

  it("caps warning annotations independently at 10", () => {
    emitAnnotations(
      report(Array.from({ length: 15 }, (_, index) => result({ status: "warning", testId: `warning-${index}` }))),
    );

    expect(errorMock).not.toHaveBeenCalled();
    expect(warningMock).toHaveBeenCalledTimes(10);
    expect(infoMock).toHaveBeenCalledOnce();
    expect(infoMock.mock.calls[0]?.[0]).toContain("Suppressed 5 additional warning results");
  });

  it("applies the error and warning limits independently for mixed results", () => {
    const results = [
      ...Array.from({ length: 12 }, (_, index) => result({ status: "error", testId: `error-${index}` })),
      ...Array.from({ length: 12 }, (_, index) => result({ status: "warning", testId: `warning-${index}` })),
    ];
    emitAnnotations(report(results));

    expect(errorMock).toHaveBeenCalledTimes(10);
    expect(warningMock).toHaveBeenCalledTimes(10);
    expect(infoMock).toHaveBeenCalledTimes(2);
    expect(infoMock.mock.calls.map(([message]) => String(message))).toEqual(
      expect.arrayContaining([
        expect.stringContaining("Suppressed 2 additional error results"),
        expect.stringContaining("Suppressed 2 additional warning results"),
      ]),
    );
  });

  it("counts a protocol-mismatch warning toward the warning limit", () => {
    const warnings = Array.from({ length: 9 }, (_, index) => result({ status: "warning", testId: `warning-${index}` }));
    emitAnnotations(
      report({
        results: warnings,
        targetProtocol: 28,
        network: { name: "testnet", observedProtocol: 27 },
      }),
    );

    expect(warningMock).toHaveBeenCalledTimes(10);
    expect(warningMock.mock.calls[9]?.[0]).toContain("Protocol mismatch");
    expect(infoMock).not.toHaveBeenCalled();
  });

  it("omits a protocol-mismatch warning when the warning limit is already reached", () => {
    const warnings = Array.from({ length: 10 }, (_, index) => result({ status: "warning", testId: `warning-${index}` }));
    emitAnnotations(
      report({
        results: warnings,
        targetProtocol: 28,
        network: { name: "testnet", observedProtocol: 27 },
      }),
    );

    expect(warningMock).toHaveBeenCalledTimes(10);
    expect(infoMock).toHaveBeenCalledOnce();
    expect(infoMock.mock.calls[0]?.[0]).toContain("Suppressed 1 additional warning result");
  });
});
