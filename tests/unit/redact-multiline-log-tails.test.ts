import { afterEach, describe, expect, it } from "vitest";

import { REDACTED, redact, redactSecrets } from "../../src/redact";

const ENV_NAME = "PROTOCOLCANARY_TEST_SECRET";

afterEach(() => {
  delete process.env[ENV_NAME];
  delete process.env.PROTOCOLCANARY_TEST_SECRET2;
});

// Assembled at runtime so secret scanners do not flag this file.
const GITHUB_PAT = `ghp_${"x".repeat(36)}`;
const STELLAR_SEED = `S${"B".repeat(55)}`;

describe("multiline log tail redaction", () => {
  it("redacts a secret that appears on multiple lines of a log tail", () => {
    const lines = [
      `line one with ${GITHUB_PAT} embedded`,
      "line two is clean",
      `line three has seed ${STELLAR_SEED} inside`,
    ].join("\n");

    const out = redactSecrets(lines);
    expect(out).not.toContain(GITHUB_PAT);
    expect(out).not.toContain(STELLAR_SEED);
    expect(out).toContain(REDACTED);
    expect(out.split("\n")).toHaveLength(3);
  });

  it("redacts several credentials on adjacent lines", () => {
    process.env[ENV_NAME] = "my-long-env-secret";
    const tail = [
      `auth: ${GITHUB_PAT}`,
      `seed: ${STELLAR_SEED}`,
      `env: my-long-env-secret`,
    ].join("\n");

    const out = redactSecrets(tail);
    expect(out).not.toContain(GITHUB_PAT);
    expect(out).not.toContain(STELLAR_SEED);
    expect(out).not.toContain("my-long-env-secret");
    expect(out.split("\n")).toHaveLength(3);
  });

  it("preserves non-secret lines between secret-bearing lines intact", () => {
    const tail = [
      `token=${GITHUB_PAT}`,
      "INFO: running compatibility check",
      "INFO: network=testnet",
      `seed=${STELLAR_SEED}`,
    ].join("\n");

    const out = redactSecrets(tail);
    const lines = out.split("\n");
    expect(lines[0]).toBe(`token=${REDACTED}`);
    expect(lines[1]).toBe("INFO: running compatibility check");
    expect(lines[2]).toBe("INFO: network=testnet");
    expect(lines[3]).toBe(`seed=${REDACTED}`);
  });

  it("handles a large multi-line tail without performance issues", () => {
    const credential = `ghp_${"z".repeat(36)}`;
    const lines: string[] = [];
    for (let i = 0; i < 500; i++) {
      lines.push(i % 10 === 0 ? `token=${credential}` : `INFO: step ${String(i)} ok`);
    }
    const tail = lines.join("\n");

    const start = Date.now();
    const out = redactSecrets(tail);
    expect(Date.now() - start).toBeLessThan(2_000);
    expect(out).not.toContain(credential);
  });
});

describe("regex metacharacters in secret values", () => {
  it("redacts a secret value containing *", () => {
    process.env[ENV_NAME] = "pass*word1!";
    expect(redactSecrets("auth=pass*word1!")).toBe(`auth=${REDACTED}`);
  });

  it("redacts a secret value containing +", () => {
    process.env[ENV_NAME] = "pass+word2!";
    expect(redactSecrets("auth=pass+word2!")).toBe(`auth=${REDACTED}`);
  });

  it("redacts a secret value containing ?", () => {
    process.env[ENV_NAME] = "pass?word3!";
    expect(redactSecrets("auth=pass?word3!")).toBe(`auth=${REDACTED}`);
  });

  it("redacts a secret value containing [...]", () => {
    process.env[ENV_NAME] = "pa[ss]word4!";
    expect(redactSecrets("auth=pa[ss]word4!")).toBe(`auth=${REDACTED}`);
  });

  it("redacts a secret value containing ( and )", () => {
    process.env[ENV_NAME] = "pa(ss)word5!";
    expect(redactSecrets("auth=pa(ss)word5!")).toBe(`auth=${REDACTED}`);
  });

  it("redacts a secret value containing ^ and $", () => {
    process.env[ENV_NAME] = "^secure$val6";
    expect(redactSecrets("auth=^secure$val6")).toBe(`auth=${REDACTED}`);
  });

  it("redacts a secret value containing a dot", () => {
    process.env[ENV_NAME] = "my.secret.val7";
    expect(redactSecrets("auth=my.secret.val7")).toBe(`auth=${REDACTED}`);
  });

  it("redacts a secret value containing a backslash", () => {
    process.env[ENV_NAME] = "pass\\word8!";
    expect(redactSecrets("auth=pass\\word8!")).toBe(`auth=${REDACTED}`);
  });

  it("does not use a secret value with regex metacharacters as an inadvertent wildcard", () => {
    process.env[ENV_NAME] = "pa.s.word9!";
    // "paxsyword9!" shares the character count but is NOT the secret
    const result = redactSecrets("auth=paxsyword9!");
    expect(result).toBe("auth=paxsyword9!");
  });
});

describe("idempotent redaction", () => {
  it("running redactSecrets twice on already-redacted text is idempotent", () => {
    const input = `token ${GITHUB_PAT} and seed ${STELLAR_SEED}`;
    const once = redactSecrets(input);
    expect(redactSecrets(once)).toBe(once);
  });

  it("running redact twice on already-redacted text is idempotent", () => {
    const input = `::warning::token ${GITHUB_PAT} and seed ${STELLAR_SEED}`;
    const once = redact(input);
    expect(redact(once)).toBe(once);
  });

  it("is idempotent for a multiline tail with several secrets", () => {
    process.env[ENV_NAME] = "my-idempotent-secret!";
    const tail = [
      `auth=${GITHUB_PAT}`,
      `seed=${STELLAR_SEED}`,
      "env=my-idempotent-secret!",
    ].join("\n");

    const once = redactSecrets(tail);
    expect(redactSecrets(once)).toBe(once);
  });

  it("is idempotent for a tail that contains no secrets", () => {
    const clean = "INFO: 12/12 checks passed\nINFO: status=pass";
    expect(redactSecrets(clean)).toBe(clean);
    expect(redact(clean)).toBe(clean);
  });
});

describe("empty and whitespace-only secret values", () => {
  it("does not redact arbitrary text when the env value is empty", () => {
    process.env[ENV_NAME] = "";
    const line = "INFO: running checks";
    expect(redactSecrets(line)).toBe(line);
  });

  it("does not redact arbitrary text when the env value is whitespace only", () => {
    process.env[ENV_NAME] = "   ";
    const line = "INFO: running checks";
    expect(redactSecrets(line)).toBe(line);
  });

  it("does not redact when the env value is exactly 7 characters (below the minimum)", () => {
    process.env[ENV_NAME] = "1234567";
    const line = "log 1234567 end";
    expect(redactSecrets(line)).toBe(line);
  });

  it("does not redact common short strings even if they appear in the log", () => {
    process.env[ENV_NAME] = "ok";
    // "ok" is too short to be masked
    expect(redactSecrets("status: ok")).toBe("status: ok");
  });

  it("masks two different sensitive env values in one log tail", () => {
    process.env[ENV_NAME] = "first-secret-value!";
    process.env.PROTOCOLCANARY_TEST_SECRET2 = "second-secret-value!";
    const line = "auth=first-secret-value! extra=second-secret-value!";
    const out = redactSecrets(line);
    expect(out).not.toContain("first-secret-value!");
    expect(out).not.toContain("second-secret-value!");
  });
});
