import type * as actionsCore from "@actions/core";

import { beforeEach, describe, expect, it, vi } from "vitest";

const { infoMock, warningMock, setSecretMock } = vi.hoisted(() => ({
  infoMock: vi.fn(),
  warningMock: vi.fn(),
  setSecretMock: vi.fn(),
}));

vi.mock("@actions/core", async (importOriginal) => {
  const actual = await importOriginal<typeof actionsCore>();
  return { ...actual, info: infoMock, warning: warningMock, setSecret: setSecretMock };
});

import { InvalidInputError } from "../../src/errors";
import { getInputs } from "../../src/inputs";

/** Every input that `getInputs` parses through `parseBoolean`. */
const BOOLEAN_INPUTS = [
  "upload-report",
  "annotations",
  "diagnostics",
  "allow-empty",
  "fail-on-warning",
  "offline",
  "generate-receipt",
  "junit-report",
  "strict-integrity",
  "pr-comment",
] as const;

type BooleanInputName = (typeof BOOLEAN_INPUTS)[number];

const PROPERTY_BY_INPUT: Record<BooleanInputName, keyof ReturnType<typeof getInputs>> = {
  "upload-report": "uploadReport",
  annotations: "annotations",
  diagnostics: "diagnostics",
  "allow-empty": "allowEmpty",
  "fail-on-warning": "failOnWarning",
  offline: "offline",
  "generate-receipt": "generateReceipt",
  "junit-report": "junitReport",
  "strict-integrity": "strictIntegrity",
  "pr-comment": "prComment",
};

const ACCEPTED_LITERALS = ["true", "True", "TRUE", "false", "False", "FALSE"] as const;
const AMBIGUOUS_LITERALS = [
  "yes",
  "no",
  "on",
  "off",
  "enabled",
  "disabled",
  "1",
  "0",
  "Y",
  "N",
] as const;

function envKey(name: string): string {
  return `INPUT_${name.toUpperCase()}`;
}

function setInput(name: string, value: string): void {
  process.env[envKey(name)] = value;
}

function clearInputs(): void {
  for (const name of BOOLEAN_INPUTS) {
    delete process.env[envKey(name)];
  }
  // The sentinel makes `network-passphrase` resolve to "unset" instead of
  // tripping its non-empty validation, the same way inputs.test.ts does it.
  process.env["INPUT_NETWORK-PASSPHRASE"] = "\u0001";
  infoMock.mockClear();
  warningMock.mockClear();
  setSecretMock.mockClear();
}

function readBoolean(name: BooleanInputName): boolean {
  return getInputs()[PROPERTY_BY_INPUT[name]] as boolean;
}

describe("strict boolean input parsing (#744)", () => {
  beforeEach(clearInputs);

  for (const name of BOOLEAN_INPUTS) {
    describe(name, () => {
      for (const raw of ACCEPTED_LITERALS) {
        const expected = raw.toLowerCase() === "true";

        it(`parses ${JSON.stringify(raw)} as ${String(expected)}`, () => {
          setInput(name, raw);

          expect(readBoolean(name)).toBe(expected);
        });
      }

      it("trims surrounding whitespace", () => {
        setInput(name, "  false  ");

        expect(readBoolean(name)).toBe(false);
      });

      for (const raw of AMBIGUOUS_LITERALS) {
        it(`rejects ${JSON.stringify(raw)} with a UserError naming the input`, () => {
          setInput(name, raw);

          let thrown: unknown;
          try {
            getInputs();
          } catch (error) {
            thrown = error;
          }

          expect(thrown).toBeInstanceOf(InvalidInputError);
          const message = (thrown as Error).message;
          expect(message).toContain(`Invalid "${name}" input`);
          expect(message).toContain(JSON.stringify(raw));
          expect(message).toContain("true/True/TRUE/false/False/FALSE");
        });
      }

      it("falls back to the documented default when omitted or empty", () => {
        const defaultValue = name === "upload-report" || name === "annotations";

        expect(readBoolean(name)).toBe(defaultValue);

        setInput(name, "");
        expect(readBoolean(name)).toBe(defaultValue);

        setInput(name, "   ");
        expect(readBoolean(name)).toBe(defaultValue);
      });
    });
  }

  it("applies the documented defaults when every boolean input is omitted", () => {
    const inputs = getInputs();

    expect(inputs.uploadReport).toBe(true);
    expect(inputs.annotations).toBe(true);
    expect(inputs.diagnostics).toBe(false);
    expect(inputs.allowEmpty).toBe(false);
    expect(inputs.failOnWarning).toBe(false);
    expect(inputs.offline).toBe(false);
    expect(inputs.generateReceipt).toBe(false);
    expect(inputs.junitReport).toBe(false);
    expect(inputs.strictIntegrity).toBe(false);
    expect(inputs.prComment).toBe(false);
  });
});
