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
  MAX_REPORT_UPLOAD_ATTEMPTS,
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
const UNIQUE_SUFFIX = "[a-z0-9]+-[a-z0-9]+";

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
  vi.restoreAllMocks();
});

describe("MAX_REPORT_UPLOAD_ATTEMPTS (#749)", () => {
  it("caps report uploads at three attempts", () => {
    expect(MAX_REPORT_UPLOAD_ATTEMPTS).toBe(3);
  });
});

describe("uploadReport retry and collision policy (#749)", () => {
  it("uploads under the stable name on the first attempt when the name is free", async () => {
    uploadArtifactMock.mockResolvedValue({ id: 7, size: 100 });

    const outcome = await uploadReport(REPORT_PATH);

    expect(outcome).toEqual({ uploaded: true, name: ARTIFACT_NAME, id: 7 });
    expect(uploadArtifactMock).toHaveBeenCalledTimes(1);
    expect(uploadArtifactMock).toHaveBeenCalledWith(ARTIFACT_NAME, [REPORT_PATH], REPORT_DIR);
  });

  it("retries under a differentiator-derived name after a name collision", async () => {
    uploadArtifactMock
      .mockRejectedValueOnce(conflictError())
      .mockResolvedValueOnce({ id: 2, size: 100 });

    const outcome = await uploadReport(REPORT_PATH, "protocol 28 / testnet");

    const expectedName = `${ARTIFACT_NAME}-protocol-28-testnet`;
    expect(outcome).toEqual({ uploaded: true, name: expectedName, id: 2 });
    expect(uploadedNames()).toEqual([ARTIFACT_NAME, expectedName]);
    expect(infoMock).toHaveBeenCalledWith(
      expect.stringContaining("already used in this workflow run"),
    );
  });

  it("falls back to a unique name when no differentiator was supplied", async () => {
    uploadArtifactMock
      .mockRejectedValueOnce(conflictError())
      .mockResolvedValueOnce({ id: 2, size: 100 });

    const outcome = await uploadReport(REPORT_PATH);

    const [first, second] = uploadedNames();
    expect(first).toBe(ARTIFACT_NAME);
    expect(second).toMatch(new RegExp(`^${ARTIFACT_NAME}-${UNIQUE_SUFFIX}$`));
    expect(outcome.uploaded).toBe(true);
    expect(outcome.name).toBe(second);
  });

  it("uses a third unique attempt when the differentiator name also collides", async () => {
    uploadArtifactMock
      .mockRejectedValueOnce(conflictError())
      .mockRejectedValueOnce(conflictError())
      .mockResolvedValueOnce({ id: 3, size: 100 });

    const outcome = await uploadReport(REPORT_PATH, "protocol-28");

    const names = uploadedNames();
    expect(names).toHaveLength(3);
    expect(names[0]).toBe(ARTIFACT_NAME);
    expect(names[1]).toBe(`${ARTIFACT_NAME}-protocol-28`);
    expect(names[2]).toMatch(new RegExp(`^${ARTIFACT_NAME}-protocol-28-${UNIQUE_SUFFIX}$`));
    expect(outcome).toEqual({ uploaded: true, name: names[2], id: 3 });
  });

  it("keeps every attempt distinct when repeated invocations share a differentiator", async () => {
    uploadArtifactMock.mockRejectedValue(conflictError());

    await uploadReport(REPORT_PATH, "protocol-28");

    const names = uploadedNames();
    expect(names).toHaveLength(MAX_REPORT_UPLOAD_ATTEMPTS);
    expect(new Set(names).size).toBe(MAX_REPORT_UPLOAD_ATTEMPTS);
  });

  it("gives two colliding invocations their own readable fallback names", async () => {
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

  it("reports a structured failure once every collision attempt is exhausted", async () => {
    uploadArtifactMock.mockRejectedValue(conflictError());

    const outcome = await uploadReport(REPORT_PATH, "protocol-28");

    expect(outcome.uploaded).toBe(false);
    expect(outcome.reason).toContain("409");
    expect(outcome.reason).toContain("Conflict");
    expect(uploadedNames()).toHaveLength(MAX_REPORT_UPLOAD_ATTEMPTS);
    expect(warningMock).toHaveBeenCalledWith(expect.stringContaining("Failed to upload"));
  });

  it("does not retry a transient upload failure, and reports its reason", async () => {
    uploadArtifactMock.mockRejectedValue(new Error("socket hang up"));

    const outcome = await uploadReport(REPORT_PATH, "protocol-28");

    expect(outcome).toEqual({ uploaded: false, reason: "socket hang up" });
    expect(uploadedNames()).toEqual([ARTIFACT_NAME]);
    expect(warningMock).toHaveBeenCalledWith(
      expect.stringContaining(`Failed to upload ${ARTIFACT_NAME} artifact`),
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
    const junitPath = "/tmp/stellar-canary-report.junit.xml";
    uploadArtifactMock
      .mockRejectedValueOnce(conflictError())
      .mockResolvedValueOnce({ id: 2, size: 100 });

    await uploadReport(REPORT_PATH, "protocol-28", [junitPath]);

    expect(uploadArtifactMock).toHaveBeenNthCalledWith(
      2,
      `${ARTIFACT_NAME}-protocol-28`,
      [REPORT_PATH, junitPath],
      REPORT_DIR,
    );
  });

  it("forwards retentionDays to the client without changing the artifact name", async () => {
    uploadArtifactMock.mockResolvedValue({ id: 5, size: 1 });

    await uploadReport(REPORT_PATH, "protocol-28", 30);

    expect(uploadArtifactMock).toHaveBeenCalledWith(ARTIFACT_NAME, [REPORT_PATH], REPORT_DIR, {
      retentionDays: 30,
    });
  });

  it("accepts retentionDays alongside additional files", async () => {
    const junitPath = "/tmp/stellar-canary-report.junit.xml";
    uploadArtifactMock.mockResolvedValue({ id: 6, size: 1 });

    await uploadReport(REPORT_PATH, undefined, [junitPath], 7);

    expect(uploadArtifactMock).toHaveBeenCalledWith(
      ARTIFACT_NAME,
      [REPORT_PATH, junitPath],
      REPORT_DIR,
      { retentionDays: 7 },
    );
  });

  it("omits the options argument when no retention is configured", async () => {
    uploadArtifactMock.mockResolvedValue({ id: 8, size: 1 });

    await uploadReport(REPORT_PATH);

    expect(uploadArtifactMock.mock.calls[0]).toHaveLength(3);
  });
});

describe("isArtifactNameCollision (#749)", () => {
  it("recognises the 409 Conflict wording from @actions/artifact", () => {
    expect(isArtifactNameCollision(conflictError())).toBe(true);
  });

  it("recognises a bare conflict or already-exists message about an artifact", () => {
    expect(isArtifactNameCollision(new Error("Conflict: duplicate upload"))).toBe(true);
    expect(isArtifactNameCollision(new Error("An artifact with this name already exists"))).toBe(
      true,
    );
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
    expect(fallbackArtifactName("///")).toMatch(
      new RegExp(`^${ARTIFACT_NAME}-${UNIQUE_SUFFIX}$`),
    );
  });

  it("produces distinct names when no differentiator is given", () => {
    vi.spyOn(Date, "now").mockReturnValue(1_700_000_000_000);

    const first = fallbackArtifactName();
    const second = fallbackArtifactName();

    expect(first).toMatch(new RegExp(`^${ARTIFACT_NAME}-${UNIQUE_SUFFIX}$`));
    expect(second).toMatch(new RegExp(`^${ARTIFACT_NAME}-${UNIQUE_SUFFIX}$`));
    expect(first).not.toBe(second);
  });
});

describe("receiptArtifactName (#749)", () => {
  it("prefixes the run id exactly once", () => {
    expect(receiptArtifactName("1234567890")).toBe(`${RECEIPT_ARTIFACT_PREFIX}-1234567890`);
  });

  it("trims the run id and sanitizes characters GitHub rejects", () => {
    expect(receiptArtifactName("  run/42  ")).toBe(`${RECEIPT_ARTIFACT_PREFIX}-run-42`);
  });

  it("uses a unique suffix when the run id is absent or empty", () => {
    for (const runId of [undefined, "", "   "]) {
      expect(receiptArtifactName(runId)).toMatch(
        new RegExp(`^${RECEIPT_ARTIFACT_PREFIX}-${UNIQUE_SUFFIX}$`),
      );
    }
  });
});

describe("uploadReceipt (#749)", () => {
  it("uploads under the run-scoped name", async () => {
    process.env.GITHUB_RUN_ID = "98765";
    uploadArtifactMock.mockResolvedValue({ id: 9, size: 10 });

    const outcome = await uploadReceipt(RECEIPT_PATH);

    const expectedName = `${RECEIPT_ARTIFACT_PREFIX}-98765`;
    expect(outcome).toEqual({ uploaded: true, name: expectedName, id: 9 });
    expect(uploadArtifactMock).toHaveBeenCalledWith(expectedName, [RECEIPT_PATH], REPORT_DIR);
  });

  it("retries once under a unique suffix when the run-scoped name is taken", async () => {
    process.env.GITHUB_RUN_ID = "98765";
    uploadArtifactMock
      .mockRejectedValueOnce(conflictError())
      .mockResolvedValueOnce({ id: 10, size: 10 });

    const outcome = await uploadReceipt(RECEIPT_PATH);

    const names = uploadedNames();
    expect(names).toHaveLength(2);
    expect(names[0]).toBe(`${RECEIPT_ARTIFACT_PREFIX}-98765`);
    expect(names[1]).toMatch(
      new RegExp(`^${RECEIPT_ARTIFACT_PREFIX}-98765-${UNIQUE_SUFFIX}$`),
    );
    expect(outcome).toEqual({ uploaded: true, name: names[1], id: 10 });
  });

  it("forwards retentionDays to the client", async () => {
    process.env.GITHUB_RUN_ID = "98765";
    uploadArtifactMock.mockResolvedValue({ id: 11, size: 10 });

    await uploadReceipt(RECEIPT_PATH, 14);

    expect(uploadArtifactMock).toHaveBeenCalledWith(
      `${RECEIPT_ARTIFACT_PREFIX}-98765`,
      [RECEIPT_PATH],
      REPORT_DIR,
      { retentionDays: 14 },
    );
  });

  it("returns a structured failure instead of throwing when the upload fails", async () => {
    process.env.GITHUB_RUN_ID = "98765";
    uploadArtifactMock.mockRejectedValue(new Error("403 Forbidden"));

    const outcome = await uploadReceipt(RECEIPT_PATH);

    expect(outcome.uploaded).toBe(false);
    expect(outcome.reason).toBe("403 Forbidden");
    expect(warningMock).toHaveBeenCalledWith(
      expect.stringContaining(`Failed to upload ${RECEIPT_ARTIFACT_PREFIX}-98765 artifact`),
    );
  });

  it("reports a non-Error rejection reason verbatim", async () => {
    process.env.GITHUB_RUN_ID = "98765";
    uploadArtifactMock.mockRejectedValue("receipt service down");

    await expect(uploadReceipt(RECEIPT_PATH)).resolves.toEqual({
      uploaded: false,
      reason: "receipt service down",
    });
  });
});
