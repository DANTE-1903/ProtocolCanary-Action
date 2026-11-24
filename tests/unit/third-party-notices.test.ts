import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, describe, expect, it } from "vitest";

const REPO_ROOT = path.resolve(__dirname, "..", "..");
const SCRIPT_PATH = path.join(REPO_ROOT, "scripts", "third-party-notices.mjs");
const NOTICES_PATH = path.join(REPO_ROOT, "THIRD_PARTY_NOTICES.txt");
const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "third-party-notices-test-"));

afterAll(() => {
  fs.rmSync(TMP_DIR, { recursive: true, force: true });
});

function regenerate(name: string): string {
  const outputPath = path.join(TMP_DIR, `${name}.txt`);
  execFileSync(process.execPath, [SCRIPT_PATH, "--output", outputPath], {
    cwd: REPO_ROOT,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    maxBuffer: 50 * 1024 * 1024,
    timeout: 120_000,
  });
  return fs.readFileSync(outputPath, "utf8");
}

function inventory(text: string): string[] {
  return [...text.matchAll(/^NOTICES-PACKAGE: (.+)$/gm)].map((match) => match[1]!);
}

function counts(values: readonly string[]): Map<string, number> {
  const result = new Map<string, number>();
  for (const value of values) {
    result.set(value, (result.get(value) ?? 0) + 1);
  }
  return result;
}

function differences(committed: readonly string[], fresh: readonly string[]): string[] {
  const expected = counts(committed);
  const actual = counts(fresh);
  const keys = new Set([...expected.keys(), ...actual.keys()]);
  const result: string[] = [];
  for (const key of [...keys].sort()) {
    const expectedCount = expected.get(key) ?? 0;
    const actualCount = actual.get(key) ?? 0;
    if (expectedCount !== actualCount) {
      result.push(`${key}: committed=${String(expectedCount)} fresh=${String(actualCount)}`);
    }
  }
  return result;
}

describe("THIRD_PARTY_NOTICES.txt", () => {
  it("lists exactly the install copies that enter a fresh bundle", () => {
    const committed = fs.readFileSync(NOTICES_PATH, "utf8");
    const fresh = regenerate("fresh");
    const diff = differences(inventory(committed), inventory(fresh));
    expect(diff, diff.join("\n")).toEqual([]);
    expect(inventory(committed).length).toBeGreaterThan(0);
  });

  it("regenerates byte-identical output", () => {
    expect(regenerate("first")).toBe(regenerate("second"));
  });

  it("keeps unresolved copies visible with a repository URL", () => {
    const text = fs.readFileSync(NOTICES_PATH, "utf8");
    const blocks = text.split(/^NOTICES-PACKAGE: /m).slice(1);
    const flagged = blocks.filter((block) => /^FLAGS: .*NEEDS MAINTAINER REVIEW/m.test(block));
    expect(flagged.length).toBeGreaterThan(0);
    for (const block of flagged) {
      expect(block).toMatch(/^REPOSITORY: (?!\(no repository URL declared\))/m);
      expect(block).toMatch(/^FLAGS: .*NEEDS MAINTAINER REVIEW/m);
    }
  });
});
