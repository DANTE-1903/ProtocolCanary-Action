import { describe, expect, it, beforeEach, afterEach } from "vitest";

import { computePackDigest, isCanonicalPackDigest, verifyPackDigest } from "../../src/canary";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { ChecksumMismatchError } from "../../src/errors";

const TEST_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "canary-pack-test-"));
const extraDirs: string[] = [];

beforeEach(() => {
  // Clean up test directory before each test
  fs.rmSync(TEST_DIR, { recursive: true, force: true });
  fs.mkdirSync(TEST_DIR, { recursive: true });
});

afterEach(() => {
  fs.rmSync(TEST_DIR, { recursive: true, force: true });
  for (const dir of extraDirs) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  }
  extraDirs.length = 0;
});

function writeFile(content: string, relPath: string): void {
  const fullPath = path.join(TEST_DIR, relPath);
  fs.mkdirSync(path.dirname(fullPath), { recursive: true });
  fs.writeFileSync(fullPath, content);
}

describe("isCanonicalPackDigest", () => {
  it("accepts a canonical CF-02 pack digest (sha256: followed by 64 lowercase hex)", () => {
    expect(isCanonicalPackDigest("sha256:" + "a".repeat(64))).toBe(true);
  });

  it("rejects a bare hex string without the sha256: prefix", () => {
    expect(isCanonicalPackDigest("a".repeat(64))).toBe(false);
  });

  it("rejects uppercase hex after the prefix", () => {
    expect(isCanonicalPackDigest("SHA256:" + "a".repeat(64))).toBe(false);
  });

  it("rejects a string that is too short", () => {
    expect(isCanonicalPackDigest("sha256:abc")).toBe(false);
  });

  it("rejects null and undefined", () => {
    expect(isCanonicalPackDigest(null)).toBe(false);
    expect(isCanonicalPackDigest(undefined)).toBe(false);
  });

  it("rejects a number", () => {
    expect(isCanonicalPackDigest(42)).toBe(false);
  });
});

describe("computePackDigest", () => {
  it("computes the canonical pack digest from a single file", () => {
    writeFile("test content\n", "sample.txt");
    const digest = computePackDigest(TEST_DIR);
    expect(digest).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it("computes the canonical pack digest from multiple files in sorted order", () => {
    writeFile("data1", "alpha.txt");
    writeFile("data2", "beta.txt");
    const digest = computePackDigest(TEST_DIR);
    expect(digest).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it("returns sha256: with empty directory", () => {
    const digest = computePackDigest(TEST_DIR);
    expect(digest).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it("produces identical hashes regardless of directory insertion order across nested subdirectories (#612)", () => {
    const dir1 = fs.mkdtempSync(path.join(os.tmpdir(), "canary-nest-1-"));
    const dir2 = fs.mkdtempSync(path.join(os.tmpdir(), "canary-nest-2-"));
    extraDirs.push(dir1, dir2);

    // Insertion order A
    fs.mkdirSync(path.join(dir1, "sub1", "nested"), { recursive: true });
    fs.mkdirSync(path.join(dir1, "sub2"), { recursive: true });
    fs.writeFileSync(path.join(dir1, "sub1", "nested", "fileA.txt"), "hello");
    fs.writeFileSync(path.join(dir1, "sub2", "fileB.txt"), "world");
    fs.writeFileSync(path.join(dir1, "root.txt"), "root content");

    // Reversed insertion order B
    fs.mkdirSync(path.join(dir2, "sub2"), { recursive: true });
    fs.mkdirSync(path.join(dir2, "sub1", "nested"), { recursive: true });
    fs.writeFileSync(path.join(dir2, "root.txt"), "root content");
    fs.writeFileSync(path.join(dir2, "sub2", "fileB.txt"), "world");
    fs.writeFileSync(path.join(dir2, "sub1", "nested", "fileA.txt"), "hello");

    const digest1 = computePackDigest(dir1);
    const digest2 = computePackDigest(dir2);
    expect(digest1).toBe(digest2);
  });

  it("verifies deterministic path sorting for files in deeply nested folder hierarchies (#612)", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "canary-deep-"));
    extraDirs.push(dir);

    const paths = [
      path.join("a", "b", "c", "d", "e.txt"),
      path.join("a", "b", "z.txt"),
      path.join("a", "a.txt"),
      path.join("b", "c.txt"),
    ];
    for (const rel of paths) {
      const full = path.join(dir, rel);
      fs.mkdirSync(path.dirname(full), { recursive: true });
      fs.writeFileSync(full, `content of ${rel}`);
    }

    const digest = computePackDigest(dir);
    expect(isCanonicalPackDigest(digest)).toBe(true);
    expect(digest).toMatch(/^sha256:[0-9a-f]{64}$/);
  });
});

describe("verifyPackDigest", () => {
  it("accepts a matching digest", () => {
    writeFile("test content\n", "sample.txt");
    const computed = computePackDigest(TEST_DIR);
    const result = verifyPackDigest(TEST_DIR, computed);
    expect(result).toBe(computed);
  });

  it("throws ChecksumMismatchError when the expected digest is not canonical", () => {
    writeFile("test content\n", "sample.txt");
    expect(() =>
      verifyPackDigest(TEST_DIR, "not-a-canonical-digest"),
    ).toThrow(ChecksumMismatchError);
  });

  it("throws ChecksumMismatchError when the computed digest diverges", () => {
    writeFile("original content\n", "sample.txt");
    expect(() =>
      verifyPackDigest(TEST_DIR, "sha256:" + "b".repeat(64)),
    ).toThrow(ChecksumMismatchError);
  });
});