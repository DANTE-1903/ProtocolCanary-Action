import { describe, expect, it } from "vitest";

import { InvalidReportError } from "../../src/errors";
import type { CanaryReport } from "../../src/output";
import { parseReport } from "../../src/output";
import { REDACTED, redact } from "../../src/redact";
import { MAX_DIAGNOSTIC_LENGTH, extractDiagnostic } from "../../src/runner";
import knownDefectsJson from "../fixtures/property-known-defects.json";

interface KnownDefect {
  readonly property: string;
  readonly input: unknown;
  readonly observed: unknown;
  readonly expected: string;
  readonly issue: string;
}

const knownDefects = knownDefectsJson as unknown as readonly KnownDefect[];
const DEFAULT_SEED = 0x0442_5900;
const rawSeed = process.env.SEED;
const parsedSeed = rawSeed === undefined ? DEFAULT_SEED : Number(rawSeed);
const SEED = Number.isSafeInteger(parsedSeed) ? parsedSeed : DEFAULT_SEED;

const JSON_CHARS = "abcXYZ019 \t\n\\\"`'?:-_!#$%&*()[]{}|/.,<>=+";
const REDACT_CHARS = "abcXYZ019 :`'$\";!?-#&/()[]";
const SURROUND_CHARS = "abcXYZ019 .-_!?";
const TOKEN_CHARS = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
const SEED_CHARS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
const DIAGNOSTIC_CHARS = "error: failed pivot 🌱é→`':::\t\n";

function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

function pick<T>(rng: () => number, values: readonly T[]): T {
  return values[Math.floor(rng() * values.length)]!;
}

function genText(rng: () => number, alphabet: string, length: number): string {
  let text = "";
  for (let i = 0; i < length; i++) {
    text += alphabet[Math.floor(rng() * alphabet.length)]!;
  }
  return text;
}

function genExact(rng: () => number, alphabet: string, length: number): string {
  return genText(rng, alphabet, length);
}

function genJson(rng: () => number, depth: number): unknown {
  const choice = Math.floor(rng() * 10);
  if (choice === 0) return null;
  if (choice === 1) return rng() < 0.5;
  if (choice === 2) return Math.floor(rng() * 200) - 100;
  if (choice === 3) return pick(rng, [Number.MAX_VALUE, -Number.MAX_VALUE, 1e308, Number.MIN_VALUE, 1e-308]);
  if (choice === 4) return genText(rng, JSON_CHARS, 20);
  if (choice === 5) return [];
  if (choice === 6) return {};
  if (depth <= 0) return genText(rng, JSON_CHARS, 8);
  if (choice === 7) return Array.from({ length: Math.floor(rng() * 4) }, () => genJson(rng, depth - 1));
  const keys = pick(rng, [
    ["a"],
    ["schemaVersion", "status"],
    ["counts", "results", "project"],
  ]);
  const value: Record<string, unknown> = {};
  for (const key of keys) {
    value[key] = genJson(rng, depth - 1);
  }
  return value;
}

function genMutatedEntry(rng: () => number): Record<string, unknown> {
  const entry: Record<string, unknown> = {
    testId: "t",
    protocol: 28,
    surface: "xdr",
    status: "pass",
    summary: "ok",
    durationMs: 1,
    fixtureId: "t",
  };
  for (let i = 0; i < 1 + Math.floor(rng() * 2); i++) {
    const key = pick(rng, Object.keys(entry));
    if (rng() < 0.2) delete entry[key];
    else entry[key] = genJson(rng, 4);
  }
  return entry;
}

function genReportInput(rng: () => number): unknown {
  if (rng() < 0.2) {
    return genJson(rng, 6);
  }
  const value: Record<string, unknown> = {
    schemaVersion: 1,
    toolVersion: "0.2.0",
    targetProtocol: 28,
    project: { name: "demo", type: "soroban" },
    status: "pass",
    counts: { total: 0, passed: 0, failed: 0, warnings: 0, errors: 0, skipped: 0 },
    results: [],
    git: { commit: null, branch: null, isDirty: null },
  };
  const keys = ["schemaVersion", "status", "results", "counts", "project", "toolVersion", "targetProtocol", "network", "skipped", "git", "extra"];
  const mutations = 1 + Math.floor(rng() * 3);
  for (let i = 0; i < mutations; i++) {
    const key = pick(rng, keys);
    if (rng() < 0.2) delete value[key];
    else value[key] = genJson(rng, 5);
  }
  if (rng() < 0.4) {
    value.results = Array.from({ length: 1 + Math.floor(rng() * 2) }, () => genMutatedEntry(rng));
  }
  if (rng() < 0.2) {
    value.skipped = Array.from({ length: 1 + Math.floor(rng() * 2) }, () => genMutatedEntry(rng));
  }
  return value;
}

function knownDefectApplies(input: string): boolean {
  return knownDefects.some(
    (defect) =>
      defect.property === "redactIdempotence" &&
      typeof defect.input === "string" &&
      input.includes(defect.input),
  );
}

function failure(what: string, iteration: number, details: string): Error {
  return new Error(`${what} failed at iteration ${String(iteration)} with SEED=${String(SEED)}; ${details}`);
}

describe(`seeded properties (SEED=${String(SEED)})`, () => {
  it("parseReport only throws InvalidReportError for 1,000 generated JSON values", () => {
    const rng = mulberry32(SEED);
    for (let iteration = 0; iteration < 1000; iteration++) {
      const input = genReportInput(rng);
      const text = JSON.stringify(input);
      try {
        const parsed: CanaryReport = parseReport(text);
        expect(parsed).toBeDefined();
      } catch (error) {
        if (error instanceof InvalidReportError) continue;
        throw failure("parseReport", iteration, `input=${text}; threw=${String(error)}`);
      }
    }
  });

  it("redact is idempotent for 500 generated strings, except recorded known defects", () => {
    const rng = mulberry32(SEED + 1);
    for (let iteration = 0; iteration < 500; iteration++) {
      const input = genText(rng, REDACT_CHARS, Math.floor(rng() * 40));
      const once = redact(input);
      const twice = redact(once);
      if (twice !== once && !knownDefectApplies(input)) {
        throw failure(
          "redactIdempotence",
          iteration,
          `input=${JSON.stringify(input)}; once=${JSON.stringify(once)}; twice=${JSON.stringify(twice)}`,
        );
      }
    }
  });

  it("masks generated GitHub tokens, Stellar seeds and URL credentials in random text", () => {
    const rng = mulberry32(SEED + 2);
    for (let iteration = 0; iteration < 500; iteration++) {
      const left = `${genText(rng, SURROUND_CHARS, Math.floor(rng() * 20))} `;
      const right = ` ${genText(rng, SURROUND_CHARS, Math.floor(rng() * 20))}`;
      const kind = Math.floor(rng() * 3);
      let secret: string;
      let leaks: readonly string[];
      if (kind === 0) {
        secret = `ghp_${genExact(rng, TOKEN_CHARS, 36)}`;
        leaks = [secret];
      } else if (kind === 1) {
        secret = `S${genExact(rng, SEED_CHARS, 55)}`;
        leaks = [secret];
      } else {
        const query = genExact(rng, TOKEN_CHARS, 12);
        secret = `https://user:pass@example.com/rpc?token=${query}`;
        leaks = ["user:pass", `token=${query}`];
      }
      const input = `${left}${secret}${right}`;
      const output = redact(input);
      for (const leak of leaks) {
        if (output.includes(leak)) {
          throw failure("redactMasking", iteration, `input=${JSON.stringify(input)}; leaked=${JSON.stringify(leak)}; output=${JSON.stringify(output)}`);
        }
      }
      if (!output.includes(REDACTED)) {
        throw failure("redactMasking", iteration, `input=${JSON.stringify(input)}; output=${JSON.stringify(output)} had no ${REDACTED}`);
      }
    }
  });

  it("bounds and deterministically extracts diagnostics for 500 generated strings", () => {
    const rng = mulberry32(SEED + 3);
    for (let iteration = 0; iteration < 500; iteration++) {
      const input = genText(rng, DIAGNOSTIC_CHARS, Math.floor(rng() * 2000));
      const once = extractDiagnostic(input);
      const twice = extractDiagnostic(input);
      if (once !== twice) {
        throw failure("extractDiagnosticDeterminism", iteration, `input=${JSON.stringify(input)}`);
      }
      if (once.length > MAX_DIAGNOSTIC_LENGTH || Buffer.byteLength(once, "utf8") > MAX_DIAGNOSTIC_LENGTH) {
        throw failure("extractDiagnosticBound", iteration, `input=${JSON.stringify(input)}; output=${JSON.stringify(once)}`);
      }
    }
  });
});

describe("known defects guard", () => {
  it("tracks recorded behavior for each known defect", () => {
    for (const [index, defect] of knownDefects.entries()) {
      expect(defect.property).not.toBe("");
      expect(defect.expected).not.toBe("");
      expect(defect.issue).toMatch(/^https:\/\/github\.com\/StellarCanary\/ProtocolCanary-Action\/issues\/\d+$/);

      if (defect.property !== "redactIdempotence") {
        throw new Error(`Known defect ${String(index)} has unsupported property ${JSON.stringify(defect.property)}`);
      }
      const once = redact(String(defect.input));
      const twice = redact(once);
      if (twice === once) {
        throw new Error(
          `Known defect ${String(index)} (${defect.issue}) is fixed: move its case into the enforced properties and delete its entry from tests/fixtures/property-known-defects.json.`,
        );
      }
      expect(twice).toBe(defect.observed);
    }
  });
});
