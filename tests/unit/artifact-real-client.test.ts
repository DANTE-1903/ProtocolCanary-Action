import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterAll, describe, expect, it } from "vitest";

// The tests in artifact.test.ts mock DefaultArtifactClient entirely, so they
// exercise uploadReport/uploadReceipt's error handling only through artificial
// rejections. These tests drive both functions through the REAL
// @actions/artifact client with files that do not exist on disk — the failure
// mode most likely to occur in practice. That client detects missing files
// while building its upload specification, before any network access, so the
// tests run fully offline. A syntactically valid ACTIONS_RUNTIME_TOKEN is
// stubbed as insurance so the missing-path scenarios can never fail for a
// missing environment instead; the receipt test below removes it deliberately
// to reach the client's service-setup failure deterministically.
process.env.ACTIONS_RUNTIME_TOKEN = process.env.ACTIONS_RUNTIME_TOKEN ?? "stub-token";

import { uploadReceipt, uploadReport } from "../../src/artifact";

const REPORT_CONTENT = '{"schemaVersion":1,"status":"pass"}\n';
const RECEIPT_CONTENT = '{"schemaVersion":1,"status":"pass"}\n';

const tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "canary-artifact-test-"));
  tempDirs.push(dir);
  return dir;
}

/** Writes a fixture file inside `dir` and returns its absolute path. */
function writeFixture(dir: string, name: string, contents: string): string {
  const filePath = path.join(dir, name);
  fs.writeFileSync(filePath, contents, "utf8");
  return filePath;
}

afterAll(() => {
  for (const dir of tempDirs) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  // Confirm the fixture cleanup contract: no canary-artifact-test-* directory
  // this suite created is left behind for the next run (or the OS) to reap.
  for (const dir of tempDirs) {
    expect(fs.existsSync(dir)).toBe(false);
  }
  tempDirs.length = 0;
});

describe("uploadReport against a real @actions/artifact client", () => {
  it("resolves with uploaded: false (never throws) when the report file does not exist", async () => {
    const dir = makeTempDir();
    const missingReportPath = path.join(dir, "report-does-not-exist.json");

    const outcome = await uploadReport(missingReportPath);

    expect(outcome).toEqual({
      uploaded: false,
      reason: expect.stringContaining(missingReportPath),
    });
  });

  it("fails with a clear diagnostic when an additional file does not exist, leaving the report intact", async () => {
    const dir = makeTempDir();
    const reportPath = writeFixture(dir, "stellar-canary-report.json", REPORT_CONTENT);
    const missingAdditionalPath = path.join(dir, "stellar-canary-report.junit.xml");

    // The JUnit rendering is optional and auxiliary (#423): a caller can pass
    // a path the engine never produced. The real client rejects the whole
    // upload specification before any network call, so the failure is an
    // outcome — never an exception — and its reason names the missing file.
    const outcome = await uploadReport(reportPath, undefined, [missingAdditionalPath]);

    expect(outcome.uploaded).toBe(false);
    expect(outcome.reason).toContain(missingAdditionalPath);

    // The report that was written successfully is untouched, the missing
    // optional file was not created, and no partial upload (zip or temp file)
    // is left behind in the fixture directory.
    expect(fs.readFileSync(reportPath, "utf8")).toBe(REPORT_CONTENT);
    expect(fs.existsSync(missingAdditionalPath)).toBe(false);
    expect(fs.readdirSync(dir)).toEqual(["stellar-canary-report.json"]);
  });
});

describe("uploadReceipt against a real @actions/artifact client", () => {
  it("resolves with uploaded: false (never throws) when the receipt file does not exist", async () => {
    const dir = makeTempDir();
    const missingReceiptPath = path.join(dir, "stellar-canary-receipt-does-not-exist.json");

    const outcome = await uploadReceipt(missingReceiptPath);

    expect(outcome).toEqual({
      uploaded: false,
      reason: expect.stringContaining(missingReceiptPath),
    });
  });

  it("accepts an existing receipt and reports the artifact service's failure as a diagnostic", async () => {
    const dir = makeTempDir();
    const receiptPath = writeFixture(dir, "stellar-canary-receipt.json", RECEIPT_CONTENT);

    // No artifact service is configured for unit tests. Removing the runtime
    // token makes the real client fail *after* it has accepted the receipt
    // file, its artifact name, and its root directory — deterministically and
    // without a network call. Per the receipt artifact policy the failure is
    // reported through the outcome (never thrown), exactly like uploadReport's.
    const savedToken = process.env.ACTIONS_RUNTIME_TOKEN;
    delete process.env.ACTIONS_RUNTIME_TOKEN;
    try {
      const outcome = await uploadReceipt(receiptPath);

      expect(outcome.uploaded).toBe(false);
      expect(outcome.reason).toContain("ACTIONS_RUNTIME_TOKEN");

      // The receipt itself is kept for debugging/re-upload, and the failed
      // attempt left no stray files in the fixture directory.
      expect(fs.readFileSync(receiptPath, "utf8")).toBe(RECEIPT_CONTENT);
      expect(fs.readdirSync(dir)).toEqual(["stellar-canary-receipt.json"]);
    } finally {
      if (savedToken === undefined) {
        delete process.env.ACTIONS_RUNTIME_TOKEN;
      } else {
        process.env.ACTIONS_RUNTIME_TOKEN = savedToken;
      }
    }
  });
});
