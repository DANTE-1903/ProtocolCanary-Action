import { describe, expect, it } from "vitest";

import { REDACTED, redact } from "../../src/redact";

/**
 * Issue #739: diagnostic tails are downloadable by anyone who can read the
 * repository, so every credential shape `src/redact.ts` claims to recognise is
 * exercised here. The synthetic values are assembled at runtime rather than
 * written as literals so a secret scanner does not flag this file; none of
 * them are (or ever were) real credentials.
 */
const TOKEN_BODY = "a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8"; // 36 characters
const PAT = `ghp_${TOKEN_BODY}`;
const FINE_GRAINED_PAT = `github_pat_${"b".repeat(24)}`;
const SEED = `S${"A".repeat(55)}`;
const ADDRESS = `G${"A".repeat(55)}`;
const CONTRACT_ID = `C${"B".repeat(55)}`;

describe("GitHub token variants", () => {
  it("masks every token prefix GitHub issues", () => {
    for (const prefix of ["ghp_", "gho_", "ghu_", "ghs_", "ghr_"]) {
      const token = `${prefix}${TOKEN_BODY}`;

      expect(redact(`remote: Authorization ${token}`)).toBe(`remote: Authorization ${REDACTED}`);
    }
  });

  it("masks a fine-grained personal access token", () => {
    expect(redact(`token=${FINE_GRAINED_PAT} along these lines`)).toBe(
      `token=${REDACTED} along these lines`,
    );
  });

  it("masks every occurrence, not just the first", () => {
    expect(redact(`${PAT} then ${FINE_GRAINED_PAT}`)).toBe(`${REDACTED} then ${REDACTED}`);
  });

  it("leaves a prefix-shaped string that is too short to be a token alone", () => {
    expect(redact("ghp_short")).toBe("ghp_short");
  });
});

describe("Stellar keys", () => {
  it("masks a secret seed but leaves public addresses and contract IDs intact", () => {
    const line = `seed ${SEED} account ${ADDRESS} contract ${CONTRACT_ID}`;

    expect(redact(line)).toBe(`seed ${REDACTED} account ${ADDRESS} contract ${CONTRACT_ID}`);
  });

  it("masks a seed embedded in a sentence without touching its neighbours", () => {
    expect(redact(`Failed to sign with ${SEED}.`)).toBe(`Failed to sign with ${REDACTED}.`);
  });
});

describe("credentials embedded in URLs", () => {
  it("redacts userinfo while keeping the scheme, host, and path", () => {
    expect(redact("GET https://user:pa55word@example.com/v1/report")).toBe(
      `GET https://${REDACTED}@example.com/v1/report`,
    );
  });

  it("redacts a username with no password too", () => {
    expect(redact("http://TokenOnly@example.com/x")).toBe(`http://${REDACTED}@example.com/x`);
  });

  it("redacts a query string or fragment that could carry a credential", () => {
    expect(redact("GET https://example.com/report?access_token=abc123")).toBe(
      `GET https://example.com/report?${REDACTED}`,
    );
    expect(redact("see https://example.com/report#access_token=abc123")).toBe(
      `see https://example.com/report?${REDACTED}`,
    );
  });

  it("keeps a credential-free URL untouched", () => {
    expect(redact("GET https://example.com/report")).toBe("GET https://example.com/report");
  });
});

describe("mixed and benign log text", () => {
  it("masks several credential shapes in one log line", () => {
    const line = `auth ${PAT} seed ${SEED} call https://bot:hunter2@example.com/v1?key=1`;

    expect(redact(line)).toBe(
      `auth ${REDACTED} seed ${REDACTED} call https://${REDACTED}@example.com/v1?${REDACTED}`,
    );
  });

  it("leaves ordinary diagnostic text and public identifiers alone", () => {
    const benign = `summary: 28 fixtures, 0 failures, digest 9f2c8b1e4a6d0c3f5e7a9b1d3f5a7c9e; account ${ADDRESS}`;

    expect(redact(benign)).toBe(benign);
  });
});
