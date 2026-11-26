import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { uploadArtifactMock, infoMock, warningMock } = vi.hoisted(() => ({
  uploadArtifactMock: vi.fn(),
  infoMock: vi.fn(),
  warningMock: vi.fn(),
}));

vi.mock("@actions/artifact", () => ({
  DefaultArtifactClient: class {
    uploadArtifact = uploadArtifactMock;
  },
}));

vi.mock("@actions/core", () => ({ info: infoMock, warning: warningMock }));

import {
  ARTIFACT_NAME,
  RECEIPT_ARTIFACT_PREFIX,
  fallbackArtifactName,
  isArtifactNameCollision,
  receiptArtifactName,
  uploadReceipt,
  uploadReport,
} from "../../src/artifact";

const REPORT_PATH = "/tmp/stellar-canary-report.json";
const REPORT_DIR = "/tmp";
const RECEIPT_PATH = "/tmp/stellar-canary-receipt.json";

/** The exact error `@actions/artifact` throws for a duplicate artifact name. */
function conflictError(): Error {
  return new Error(
    "Received non-retryable error: Failed request: (409) Conflict: " +
      "an artifact with this name already exists on the workflow run",
  );
}

/** The artifact names the mocked client was asked to upload, in order. */
function uploadedNames(): string[] {
  return uploadArtifactMock.mock.calls.map((call) => String(call[0]));
}

beforeEach(() => {
  uploadArtifactMock.mockReset();
  infoMock.mockReset();
  warningMock.mockReset();
});

afterEach(() => {
  delete process.env.GITHUB_RUN_ID;
});

describe("uploadReport retry and collision policy (#749)", () => {
  it("uploads under the stable name on the first attempt when the name is free", async () => {
    uploadArtifactMock.mockResolvedValue({ id: 1, size: 100 });

    const outcome = await uploadReport(REPORT_PATH);

    expect(outcome).toEqual({ uploaded: true });
    expect(uploadArtifactMock).toHaveBeenCalledTimes(1);
    expect(uploadArtifactMock).toHaveBeenCalledWith(ARTIFACT_NAME, [REPORT_PATH], REPORT_DIR);
  });

  it("retries exactly once under a differentiator-derived name on a name collision", async () => {
    uploadArtifactMock
      .mockRejectedValueOnce(conflictError())
      .mockResolvedValueOnce({ id: 2, size: 100 });

    const outcome = await uploadReport(REPORT_PATH, "protocol 28 / testnet");

    expect(outcome).toEqual({ uploaded: true });
    expect(uploadedNames()).toEqual([ARTIFACT_NAME, `${ARTIFACT_NAME}-protocol-28-testnet`]);
    expect(infoMock).toHaveBeenCalledWith(
      expect.stringContaining("already used in this workflow run"),
    );
  });

  it("falls back to a unique name when no differentiator was supplied", async () => {
    uploadArtifactMock
      .mockRejectedValueOnce(conflictError())
      .mockResolvedValueOnce({ id: 2, size: 100 });

    await uploadReport(REPORT_PATH);

    const fallbackName = uploadedNames()[1] ?? "";
    expect(fallbackName).toMatch(new RegExp(`^${ARTIFACT_NAME}-[a-z0-9]+-[a-z0-9]+$`));
    expect(fallbackName).not.toBe(ARTIFACT_NAME);
  });

  it("gives two colliding invocations distinct fallback names", async () => {
    uploadArtifactMock
      .mockRejectedValueOnce(conflictError())
      .mockResolvedValueOnce({ id: 1, size: 1 })
      .mockRejectedValueOnce(conflictError())
      .mockResolvedValueOnce({ id: 2, size: 1 });

    await uploadReport(REPORT_PATH, "protocol-28-network-testnet");
    await uploadReport(REPORT_PATH, "protocol-28-network-mainnet");

    expect(uploadedNames()).toEqual([
      ARTIFACT_NAME,
      `${ARTIFACT_NAME}-protocol-28-network-testnet`,
      ARTIFACT_NAME,
      `${ARTIFACT_NAME}-protocol-28-network-mainnet`,
    ]);
  });

  it("reports a structured failure after exhausting its attempts on a persistent collision", async () => {
    uploadArtifactMock.mockRejectedValue(conflictError());

    const outcome = await uploadReport(REPORT_PATH, "protocol-28");

    expect(outcome.uploaded).toBe(false);
    expect(outcome.reason).toContain("409");
    expect(outcome.reason).toContain("Conflict");
    expect(uploadedNames()).toEqual([
      ARTIFACT_NAME,
      `${ARTIFACT_NAME}-protocol-28`,
    ]);
    expect(warningMock).toHaveBeenCalledWith(expect.stringContaining("Failed to upload"));
  });

  it("does not treat a transient upload failure as a collision", async () => {
    uploadArtifactMock.mockRejectedValue(new Error("socket hang up"));

    const outcome = await uploadReport(REPORT_PATH, "protocol-28");

    expect(outcome).toEqual({ uploaded: false, reason: "socket hang up" });
    expect(uploadedNames()).toEqual([ARTIFACT_NAME]);
    expect(warningMock).toHaveBeenCalledWith(
      expect.stringContaining("Failed to upload stellar-protocol-canary-report artifact"),
    );
  });

  it("reports a non-Error rejection reason verbatim", async () => {
    uploadArtifactMock.mockRejectedValue("service unavailable");

    await expect(uploadReport(REPORT_PATH)).resolves.toEqual({
      uploaded: false,
      reason: "service unavailable",
    });
  });

  it("uploads extra files (e.g. JUnit XML) in the same artifact on the fallback attempt", async () => {
    uploadArtifactMock
      .mockRejectedValueOnce(conflictError())
      .mockResolvedValueOnce({ id: 2, size: 100 });

    await uploadReport(REPORT_PATH, "protocol-28", ["/tmp/stellar-canary-report.junit.xml"]);

    expect(uploadArtifactMock).toHaveBeenNthCalledWith(
      2,
      `${ARTIFACT_NAME}-protocol-28`,
      [REPORT_PATH, "/tmp/stellar-canary-report.junit.xml"],
      REPORT_DIR,
    );
  });
});

describe("isArtifactNameCollision (#749)", () => {
  it("recognises the 409 Conflict wording from @actions/artifact", () => {
    expect(isArtifactNameCollision(conflictError())).toBe(true);
  });

  it("recognises a bare conflict or already-exists message about an artifact", () => {
    expect(isArtifactNameCollision(new Error("Conflict: duplicate upload"))).toBe(true);
    expect(
      isArtifactNameCollision(new Error("An artifact with this name already exists")),
    ).toBe(true);
    expect(isArtifactNameCollision("this artifact already exists")).toBe(true);
  });

  it("does not classify unrelated failures as collisions", () => {
    expect(isArtifactNameCollision(new Error("service unavailable"))).toBe(false);
    expect(isArtifactNameCollision(new Error("(403) Forbidden"))).toBe(false);
    expect(isArtifactNameCollision(new Error("already exists"))).toBe(false);
    expect(isArtifactNameCollision(undefined)).toBe(false);
  });
});

describe("fallbackArtifactName (#749)", () => {
  it("keeps a differentiator-derived name stable and readable", () => {
    expect(fallbackArtifactName("protocol-28")).toBe(`${ARTIFACT_NAME}-protocol-28`);
  });

  it("reduces characters GitHub rejects in artifact names", () => {
    expect(fallbackArtifactName("protocol 28 / network:testnet")).toBe(
      `${ARTIFACT_NAME}-protocol-28-network-testnet`,
    );
  });

  it("trims leading and trailing separators left by sanitization", () => {
    expect(fallbackArtifactName("  --protocol-28--  ")).toBe(`${ARTIFACT_NAME}-protocol-28`);
  });

  it("falls back to a unique suffix when the differentiator sanitizes to nothing", () => {
    const name = fallbackArtifactName("///");

    expect(name).toMatch(new RegExp(`^${ARTIFACT_NAME}-[a-z0-9]+-[a-z0-9]+$`));
  });

  it("produces distinct names when no differentiator is given", () => {
    vi.spyOn(Date, "now").mockReturnValue(1_700_000_000_000);

    const first = fallbackArtifactName();
    const second = fallbackArtifactName();

    expect(first).toMatch(new RegExp(`^${ARTIFACT_NAME}-[a-z0-9]+-[a-z0-9]+$`));
    expect(second).toMatch(new RegExp(`^${ARTIFACT_NAME}-[a-z0-9]+-[a-z0-9]+$`));
    expect(first).not.toBe(second);
    vi.restoreAllMocks();
  });
});

describe("receiptArtifactName (#749)", () => {
  it("prefixes the run id exactly once", () => {
    expect(receiptArtifactName("1234567890")).toBe(
      `${RECEIPT_ARTIFACT_PREFIX}-1234567890`,
    );
  });

  it("trims the run id and sanitizes characters GitHub rejects", () => {
    expect(receiptArtifactName("  run/42  ")).toBe(`${RECEIPT_ARTIFACT_PREFIX}-run-42`);
  });

  it("uses a unique suffix when the run id is absent or empty", () => {
    for (const runId of [undefined, "", "   "]) {
      expect(receiptArtifactName(runId)).toMatch(
        new RegExp(`^${RECEIPT_ARTIFACT_PREFIX}-[a-z0-9]+-[a-z0-9]+$`),
      );
    }
  });
});

describe("uploadReceipt (#749)", () => {
  it("uploads under the run-scoped name", async () => {
    process.env.GITHUB_RUN_ID = "98765";
    uploadArtifactMock.mockResolvedValue({ id: 1, size: 10 });

    const outcome = await uploadReceipt(RECEIPT_PATH);

    expect(outcome).toEqual({ uploaded: true });
    expect(uploadArtifactMock).toHaveBeenCalledWith(
      `${RECEIPT_ARTIFACT_PREFIX}-98765`,
      [RECEIPT_PATH],
      REPORT_DIR,
    );
  });

  it("retries once under a unique suffix when the run-scoped name is taken", async () => {
    process.env.GITHUB_RUN_ID = "98765";
    uploadArtifactMock
      .mockRejectedValueOnce(conflictError())
      .mockResolvedValueOnce({ id: 2, size: 10 });

    const outcome = await uploadReceipt(RECEIPT_PATH);

    expect(outcome).toEqual({ uploaded: true });
    const names = uploadedNames();
    expect(names).toHaveLength(2);
    expect(names[0]).toBe(`${RECEIPT_ARTIFACT_PREFIX}-98765`);
    expect(names[1]).toMatch(
      new RegExp(`^${RECEIPT_ARTIFACT_PREFIX}-98765-[a-z0-9]+-[a-z0-9]+$`),
    );
  });

  it("returns a structured failure instead of throwing when the upload keeps failing", async () => {
    process.env.GITHUB_RUN_ID = "98765";
    uploadArtifactMock.mockRejectedValue(new Error("403 Forbidden"));

    const outcome = await uploadReceipt(RECEIPT_PATH);

    expect(outcome.uploaded).toBe(false);
    expect(outcome.reason).toBe("403 Forbidden");
    expect(warningMock).toHaveBeenCalledWith(
      expect.stringContaining(`Failed to upload ${RECEIPT_ARTIFACT_PREFIX}-98765 artifact`),
    );
  });
});
