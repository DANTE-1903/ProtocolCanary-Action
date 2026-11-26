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
import { getInputs, TIMEOUT_MINUTES_MAX } from "../../src/inputs";

function setInput(name: string, value: string): void {
  process.env[`INPUT_${name.toUpperCase()}`] = value;
}

function clearInputs(): void {
  for (const name of ["protocol", "rpc-max-retries", "rpc-retry-delay-ms", "timeout-minutes"]) {
    delete process.env[`INPUT_${name.toUpperCase()}`];
  }
  // The sentinel makes `network-passphrase` resolve to "unset" instead of
  // tripping its non-empty validation, the same way inputs.test.ts does it.
  process.env["INPUT_NETWORK-PASSPHRASE"] = "\u0001";
  infoMock.mockClear();
  warningMock.mockClear();
  setSecretMock.mockClear();
}

/** Runs `getInputs`, returning the thrown error or undefined when it parsed. */
function captureError(): unknown {
  try {
    getInputs();
  } catch (error) {
    return error;
  }
  return undefined;
}

function expectInvalidInput(name: string, raw: string): void {
  const thrown = captureError();

  expect(thrown).toBeInstanceOf(InvalidInputError);
  const message = (thrown as Error).message;
  expect(message).toContain(`Invalid "${name}" input`);
  expect(message).toContain(JSON.stringify(raw));
}

/** Inputs whose accepted range is `[0, 4294967295]` (u32). */
const U32_ZERO_BASED = ["rpc-max-retries"] as const;
/** Inputs whose accepted range is `[0, Number.MAX_SAFE_INTEGER]`. */
const SAFE_INTEGER_ZERO_BASED = ["rpc-retry-delay-ms"] as const;
/** Inputs whose accepted range is `[1, 4294967295]` (u32, zero rejected). */
const U32_ONE_BASED = ["protocol"] as const;

describe("numeric input bounds validation (#745)", () => {
  beforeEach(clearInputs);

  describe("negative values", () => {
    for (const name of [
      ...U32_ZERO_BASED,
      ...SAFE_INTEGER_ZERO_BASED,
      ...U32_ONE_BASED,
      "timeout-minutes",
    ]) {
      it(`rejects a negative ${name}`, () => {
        setInput(name, "-1");

        expectInvalidInput(name, "-1");
      });

      it(`rejects a signed ${name}`, () => {
        setInput(name, "+5");

        expectInvalidInput(name, "+5");
      });

      it(`rejects a negative zero-padded ${name}`, () => {
        setInput(name, "-000");

        expectInvalidInput(name, "-000");
      });
    }
  });

  describe("non-integer values", () => {
    for (const name of [
      ...U32_ZERO_BASED,
      ...SAFE_INTEGER_ZERO_BASED,
      ...U32_ONE_BASED,
      "timeout-minutes",
    ]) {
      for (const raw of ["1.5", "10.0", "0.5"]) {
        it(`rejects ${JSON.stringify(raw)} for ${name}`, () => {
          setInput(name, raw);

          expectInvalidInput(name, raw);
        });
      }

      for (const raw of ["1e3", "0x10", "5 minutes", "NaN", "Infinity"]) {
        it(`rejects the non-decimal ${JSON.stringify(raw)} for ${name}`, () => {
          setInput(name, raw);

          expectInvalidInput(name, raw);
        });
      }
    }
  });

  describe("overflow beyond the accepted maximum", () => {
    it("rejects an rpc-max-retries above the u32 range", () => {
      setInput("rpc-max-retries", "4294967296");

      expectInvalidInput("rpc-max-retries", "4294967296");
    });

    it("rejects an rpc-retry-delay-ms beyond Number.MAX_SAFE_INTEGER", () => {
      setInput("rpc-retry-delay-ms", "9007199254740993");

      expectInvalidInput("rpc-retry-delay-ms", "9007199254740993");
    });

    it("rejects a digit string too large to be a safe integer at all", () => {
      const raw = "99999999999999999999999999";
      setInput("rpc-retry-delay-ms", raw);

      expectInvalidInput("rpc-retry-delay-ms", raw);
    });

    it("rejects a timeout-minutes whose millisecond value would overflow setTimeout", () => {
      setInput("timeout-minutes", String(TIMEOUT_MINUTES_MAX + 1));

      expectInvalidInput("timeout-minutes", String(TIMEOUT_MINUTES_MAX + 1));
    });

    it("rejects a protocol above the u32 range and below its one-based minimum", () => {
      setInput("protocol", "4294967296");
      expectInvalidInput("protocol", "4294967296");

      setInput("protocol", "0");
      expectInvalidInput("protocol", "0");
    });

    it("rejects a zero timeout-minutes", () => {
      setInput("timeout-minutes", "0");

      expectInvalidInput("timeout-minutes", "0");
    });
  });

  describe("valid integers", () => {
    it("parses rpc-max-retries and rpc-retry-delay-ms as numbers", () => {
      setInput("rpc-max-retries", "3");
      setInput("rpc-retry-delay-ms", "250");

      const inputs = getInputs();

      expect(inputs.rpcMaxRetries).toBe(3);
      expect(inputs.rpcRetryDelayMs).toBe(250);
    });

    it("parses the inclusive boundaries of every range", () => {
      setInput("rpc-max-retries", "4294967295");
      setInput("rpc-retry-delay-ms", String(Number.MAX_SAFE_INTEGER));
      setInput("timeout-minutes", String(TIMEOUT_MINUTES_MAX));
      setInput("protocol", "4294967295");

      const inputs = getInputs();

      expect(inputs.rpcMaxRetries).toBe(4294967295);
      expect(inputs.rpcRetryDelayMs).toBe(Number.MAX_SAFE_INTEGER);
      expect(inputs.timeoutMinutes).toBe(TIMEOUT_MINUTES_MAX);
      expect(inputs.protocol).toBe(4294967295);
    });

    it("accepts leading zeros and trims surrounding whitespace", () => {
      setInput("protocol", "  028  ");
      setInput("rpc-max-retries", "007");

      const inputs = getInputs();

      expect(inputs.protocol).toBe(28);
      expect(inputs.rpcMaxRetries).toBe(7);
    });

    it("accepts the lower boundaries of zero-based inputs", () => {
      setInput("rpc-max-retries", "0");
      setInput("rpc-retry-delay-ms", "0");

      const inputs = getInputs();

      expect(inputs.rpcMaxRetries).toBe(0);
      expect(inputs.rpcRetryDelayMs).toBe(0);
    });
  });

  describe("omitted inputs", () => {
    it("preserves the documented defaults", () => {
      const inputs = getInputs();

      expect(inputs.timeoutMinutes).toBe(15);
      expect(inputs.rpcMaxRetries).toBeUndefined();
      expect(inputs.rpcRetryDelayMs).toBeUndefined();
      expect(inputs.protocol).toBeUndefined();
    });

    it("treats an empty or whitespace-only value as unset", () => {
      setInput("rpc-max-retries", "");
      setInput("rpc-retry-delay-ms", "   ");
      setInput("protocol", "");

      const inputs = getInputs();

      expect(inputs.rpcMaxRetries).toBeUndefined();
      expect(inputs.rpcRetryDelayMs).toBeUndefined();
      expect(inputs.protocol).toBeUndefined();
    });

    it("falls back to the default timeout for an empty value", () => {
      setInput("timeout-minutes", "");

      expect(getInputs().timeoutMinutes).toBe(15);
    });
  });
});
