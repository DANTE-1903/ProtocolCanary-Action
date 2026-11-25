/**
 * Input-layer tests for the optional strict-integrity policy (issue #372).
 *
 * Kept in its own file on purpose: `tests/unit/canary.test.ts` and
 * `tests/unit/inputs.test.ts` are actively edited by other open work, so
 * this suite lives beside them without colliding.
 *
 * Contract under test:
 *  - the `strict-integrity` input defaults to `false` (existing consumers
 *    keep today's degrade-to-pinning behaviour),
 *  - it accepts exactly the same boolean literals as every other boolean
 *    input of the Action and rejects anything else by name,
 *  - the parsed value reaches the installation boundary as the third
 *    parameter of `ensureCanaryInstalled` (covered behaviourally by
 *    `tests/unit/integrity.test.ts`).
 */
import * as fs from "node:fs";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { InvalidInputError } from "../../src/errors";
import { getInputs } from "../../src/inputs";

const INPUT_KEYS = [
  "INPUT_PROTOCOL",
  "INPUT_CONFIG",
  "INPUT_NETWORK",
  "INPUT_NETWORK-PASSPHRASE",
  "INPUT_RPC-URL",
  "INPUT_FIXTURES-DIR",
  "INPUT_VERSION",
  "INPUT_UPLOAD-REPORT",
  "INPUT_ANNOTATIONS",
  "INPUT_TIMEOUT-MINUTES",
  "INPUT_ALLOW-EMPTY",
  "INPUT_FIXTURES-PACK-VERSION",
  "INPUT_FIXTURES-PACK-PROTOCOL",
  "INPUT_STRICT-INTEGRITY",
];

function clearInputs(): void {
  for (const key of INPUT_KEYS) {
    delete process.env[key];
  }
  process.env["INPUT_NETWORK-PASSPHRASE"] = "\u0001";
}

function setStrict(value: string): void {
  process.env["INPUT_STRICT-INTEGRITY"] = value;
}

describe("strict-integrity input (issue #372)", () => {
  beforeEach(clearInputs);
  afterEach(clearInputs);

  it("defaults to false when the input is absent", () => {
    expect(getInputs().strictIntegrity).toBe(false);
  });

  it("defaults to false for an empty or whitespace-only value", () => {
    setStrict("");
    expect(getInputs().strictIntegrity).toBe(false);
    setStrict("   ");
    expect(getInputs().strictIntegrity).toBe(false);
  });

  it.each(["true", "True", "TRUE"])("accepts %s as enabled", (value) => {
    setStrict(value);
    expect(getInputs().strictIntegrity).toBe(true);
  });

  it.each(["false", "False", "FALSE"])("accepts %s as disabled", (value) => {
    setStrict(value);
    expect(getInputs().strictIntegrity).toBe(false);
  });

  it("trims surrounding whitespace before validating", () => {
    setStrict("  true  ");
    expect(getInputs().strictIntegrity).toBe(true);
    setStrict("\tFALSE\t");
    expect(getInputs().strictIntegrity).toBe(false);
  });

  // YAML 1.1 / colloquial truthy-falsy strings that @actions/core
  // getBooleanInput also rejects (Core Schema: true|True|TRUE|false|False|FALSE).
  const INVALID_BOOLEAN_STRINGS = [
    "yes",
    "no",
    "on",
    "off",
    "y",
    "n",
    "1",
    "0",
    "enabled",
    "disabled",
    "Yes",
    "ON",
    "tRuE",
    "null",
  ] as const;

  const BOOLEAN_LITERALS_MESSAGE =
    'Expected one of true/True/TRUE/false/False/FALSE.';

  function expectRejectedStrictIntegrity(rawQuotedInError: string): void {
    expect(() => getInputs()).toThrow(InvalidInputError);
    expect(() => getInputs()).toThrow(
      `Invalid "strict-integrity" input: ${JSON.stringify(rawQuotedInError)}. ${BOOLEAN_LITERALS_MESSAGE}`,
    );
  }

  it.each(INVALID_BOOLEAN_STRINGS)(
    "rejects non-standard boolean string %j with InvalidInputError (no default fallback)",
    (value) => {
      setStrict(value);
      expectRejectedStrictIntegrity(value);
    },
  );

  it.each(["  yes  ", " 1 ", "\ton\t", " enabled "])(
    "rejects padded non-standard boolean %j after getInput trimming, quoting the trimmed value",
    (value) => {
      setStrict(value);
      // @actions/core getInput trims by default, matching getBooleanInput.
      // The parser does not fall back to the default `false`; it still errors.
      expectRejectedStrictIntegrity(value.trim());
    },
  );

  it("is read from the input name declared in action.yml", () => {
    // A silent name drift between action.yml and src/inputs.ts would make
    // the policy unsettable; pin the exact input name here. The repo root
    // is two levels up from this test file in every CI checkout, including
    // Windows, so join through path rather than string concatenation.
    const contents = fs.readFileSync(path.join(__dirname, "..", "..", "action.yml"), "utf8");
    expect(contents).toMatch(/^ {2}strict-integrity:/m);
  });
});
