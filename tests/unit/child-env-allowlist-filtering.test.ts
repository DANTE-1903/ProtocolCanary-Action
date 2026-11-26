import { describe, expect, it } from "vitest";

import {
  ALLOWED_ENV_NAMES,
  ALLOWED_ENV_PREFIXES,
  buildChildEnvironment,
} from "../../src/child-env";

/**
 * Issue #741: children spawned by the Action (`cargo`, `cargo install`, and the
 * engine) compile and run arbitrary code from the engine's dependency tree, so
 * each one receives an explicit allow-list instead of a copy of `process.env`.
 * These tests pin the secret-isolation half of that contract: what must never
 * reach a child, and what a real Rust build cannot run without.
 */
const PLATFORM = "linux" as const;

/** Workflow variables that would let a malicious build script exfiltrate the
 * job's credentials if they were inherited. */
const sensitiveEnvironment: Readonly<Record<string, string>> = {
  GITHUB_TOKEN: "ghs_workflow-token-value",
  ACTIONS_RUNTIME_TOKEN: "runtime-token-value",
  ACTIONS_ID_TOKEN_REQUEST_TOKEN: "id-token-request-value",
  INPUT_GITHUB_TOKEN: "input-github-token-value",
  INPUT_CONFIG: "/work/.stellar-canary.toml",
  SECRET_API_KEY: "secret-api-key-value",
  MY_WORKFLOW_PASSWORD: "workflow-password-value",
  CARGO_REGISTRY_TOKEN: "cargo-registry-token-value",
  NODE_AUTH_TOKEN: "npm-auth-token-value",
};

describe("buildChildEnvironment: workflow secret isolation", () => {
  it("strips every sensitive workflow variable from the child environment", () => {
    const { env } = buildChildEnvironment({ PATH: "/usr/bin", ...sensitiveEnvironment }, PLATFORM);

    for (const name of Object.keys(sensitiveEnvironment)) {
      expect(Object.prototype.hasOwnProperty.call(env, name)).toBe(false);
      expect(env[name]).toBeUndefined();
    }
  });

  it("does not re-admit a sensitive value under any other name", () => {
    const { env } = buildChildEnvironment({ PATH: "/usr/bin", ...sensitiveEnvironment }, PLATFORM);

    for (const secret of Object.values(sensitiveEnvironment)) {
      expect(Object.values(env)).not.toContain(secret);
    }
  });

  it("keeps the build toolchain variables a real cargo run needs", () => {
    const { env } = buildChildEnvironment(
      {
        PATH: "/usr/local/bin:/usr/bin",
        HOME: "/home/runner",
        CARGO_HOME: "/home/runner/.cargo",
        RUSTUP_HOME: "/home/runner/.rustup",
        RUST_LOG: "info",
        CARGO_TARGET_DIR: "/work/target",
        RUSTUP_TOOLCHAIN: "stable",
        LC_ALL: "C.UTF-8",
        CMAKE_BUILD_TYPE: "Release",
      },
      PLATFORM,
    );

    expect(env).toMatchObject({
      PATH: "/usr/local/bin:/usr/bin",
      HOME: "/home/runner",
      CARGO_HOME: "/home/runner/.cargo",
      RUSTUP_HOME: "/home/runner/.rustup",
      RUST_LOG: "info",
    });
    // Allowed prefixes carry valid toolchain configuration through unchanged.
    expect(env.CARGO_TARGET_DIR).toBe("/work/target");
    expect(env.RUSTUP_TOOLCHAIN).toBe("stable");
    expect(env.LC_ALL).toBe("C.UTF-8");
    expect(env.CMAKE_BUILD_TYPE).toBe("Release");
  });

  it("passes only the prefixes the allow-list names", () => {
    const { env } = buildChildEnvironment(
      {
        CARGO_NET_OFFLINE: "true",
        LC_NUMERIC: "C",
        CMAKE_GENERATOR: "Ninja",
        // Neither `STELLAR_*` nor a bare `RUST_*` prefix is allow-listed: only
        // the enumerated RUST_* names above are, which is why RUST_LOG is
        // allowed and an arbitrary RUST_* name is not.
        STELLAR_NETWORK: "testnet",
        RUST_SOMETHING_ELSE: "1",
      },
      PLATFORM,
    );

    expect(env.CARGO_NET_OFFLINE).toBe("true");
    expect(env.LC_NUMERIC).toBe("C");
    expect(env.CMAKE_GENERATOR).toBe("Ninja");
    expect(env.STELLAR_NETWORK).toBeUndefined();
    expect(env.RUST_SOMETHING_ELSE).toBeUndefined();
  });

  it("denies a credential even when an allowed prefix would match it", () => {
    const { env } = buildChildEnvironment(
      {
        CARGO_REGISTRIES_PRIVATE_TOKEN: "registry-token-value",
        CARGO_HTTP_SECRET: "header-secret-value",
        CARGO_NET_OFFLINE: "true",
      },
      PLATFORM,
    );

    expect(env.CARGO_REGISTRIES_PRIVATE_TOKEN).toBeUndefined();
    expect(env.CARGO_HTTP_SECRET).toBeUndefined();
    expect(env.CARGO_NET_OFFLINE).toBe("true");
  });

  it("pins the allow-list the filtering is derived from", () => {
    expect(ALLOWED_ENV_NAMES).toContain("PATH");
    expect(ALLOWED_ENV_NAMES).toContain("RUST_LOG");
    expect(ALLOWED_ENV_NAMES).toContain("CARGO_HOME");
    expect(ALLOWED_ENV_NAMES).not.toContain("GITHUB_TOKEN");
    expect(ALLOWED_ENV_NAMES).not.toContain("ACTIONS_RUNTIME_TOKEN");
    expect(ALLOWED_ENV_PREFIXES).toEqual(["LC_", "RUSTUP_", "CARGO_", "CMAKE_"]);
  });
});

describe("buildChildEnvironment: isolation from the caller's environment", () => {
  it("returns a new plain object that does not alias the source", () => {
    const source = {
      PATH: "/usr/bin",
      HOME: "/home/runner",
      GITHUB_TOKEN: "workflow-token-value",
    };

    const { env } = buildChildEnvironment(source, PLATFORM);

    expect(env).not.toBe(source);
    expect(Object.getPrototypeOf(env)).toBe(Object.prototype);

    (env as Record<string, string>).PATH = "/tampered";
    expect(source.PATH).toBe("/usr/bin");
    // The caller's environment is never mutated, secrets included.
    expect(source.GITHUB_TOKEN).toBe("workflow-token-value");
    expect(Object.keys(source)).toHaveLength(3);
  });

  it("cannot re-open the allow-list through the passthrough list", () => {
    const source = {
      PATH: "/usr/bin",
      GITHUB_TOKEN: "workflow-token-value",
      CARGO_REGISTRY_TOKEN: "registry-token-value",
      ENGINE_BUILD_FLAG: "1",
    };

    const { env, forwarded } = buildChildEnvironment(source, PLATFORM, [
      "GITHUB_TOKEN",
      "CARGO_REGISTRY_TOKEN",
      "ENGINE_BUILD_FLAG",
    ]);

    expect(env.GITHUB_TOKEN).toBeUndefined();
    expect(env.CARGO_REGISTRY_TOKEN).toBeUndefined();
    expect(env.ENGINE_BUILD_FLAG).toBe("1");
    expect(forwarded).toEqual(["ENGINE_BUILD_FLAG"]);
  });

  it("reports no forwarded names when none were requested", () => {
    expect(buildChildEnvironment({ PATH: "/usr/bin" }, PLATFORM).forwarded).toEqual([]);
  });

  it("skips undefined values instead of emitting undefined entries", () => {
    const { env } = buildChildEnvironment({ PATH: "/usr/bin", HOME: undefined }, PLATFORM);

    expect(env).toEqual({ PATH: "/usr/bin" });
  });

  it("copies values verbatim, including an embedded newline", () => {
    const { env } = buildChildEnvironment({ CARGO_HTTP_CAINFO: "line one\nline two" }, PLATFORM);

    expect(env.CARGO_HTTP_CAINFO).toBe("line one\nline two");
  });
});
