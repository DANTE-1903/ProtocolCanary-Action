import { describe, expect, it } from "vitest";

import { buildChildEnvironment, isAllowedEnvName } from "../../src/child-env";

/**
 * Issue #742: environment names are case-insensitive on Windows (`Path`,
 * `PATH`, and `path` are the same variable) and case-sensitive on POSIX. The
 * child environment has to preserve the Windows system variables a spawn
 * cannot work without, while never widening the allow-list by accident on
 * Linux or macOS.
 *
 * Every case below passes the platform explicitly; nothing here depends on the
 * OS the suite happens to run on.
 */
describe("Windows: case-insensitive environment names", () => {
  it("keeps PATH whatever spelling the workflow used", () => {
    for (const spelling of ["PATH", "Path", "path"]) {
      const { env } = buildChildEnvironment({ [spelling]: "C:\\Windows\\system32" }, "win32");

      // The source spelling is preserved, because that is what spawn sees.
      expect(env[spelling]).toBe("C:\\Windows\\system32");
    }
  });

  it("keeps the system variables a Windows child process needs to spawn", () => {
    const { env } = buildChildEnvironment(
      {
        Path: "C:\\Windows\\system32;C:\\Windows",
        systemroot: "C:\\Windows",
        comspec: "C:\\Windows\\system32\\cmd.exe",
        pathext: ".COM;.EXE;.BAT;.CMD",
      },
      "win32",
    );

    expect(env.Path).toBe("C:\\Windows\\system32;C:\\Windows");
    expect(env.systemroot).toBe("C:\\Windows");
    expect(env.comspec).toBe("C:\\Windows\\system32\\cmd.exe");
    expect(env.pathext).toBe(".COM;.EXE;.BAT;.CMD");
  });

  it("accepts every allow-listed name in any casing on win32", () => {
    expect(isAllowedEnvName("PATH", "win32")).toBe(true);
    expect(isAllowedEnvName("Path", "win32")).toBe(true);
    expect(isAllowedEnvName("path", "win32")).toBe(true);
    expect(isAllowedEnvName("systemroot", "win32")).toBe(true);
    expect(isAllowedEnvName("COMSPEC", "win32")).toBe(true);
    expect(isAllowedEnvName("cargo_home", "win32")).toBe(true);
    expect(isAllowedEnvName("lc_all", "win32")).toBe(true);
    expect(isAllowedEnvName("cmake_generator", "win32")).toBe(true);
  });

  it("resolves duplicate casing variations predictably instead of crashing", () => {
    const { env } = buildChildEnvironment({ PATH: "C:\\first", Path: "C:\\second" }, "win32");

    expect(env.PATH).toBe("C:\\first");
    expect(env.Path).toBe("C:\\second");
    expect(Object.keys(env)).toHaveLength(2);
  });

  it("still refuses a denied name however it is cased", () => {
    const { env } = buildChildEnvironment(
      {
        Path: "C:\\Windows\\system32",
        Github_Token: "workflow-token-value",
        cargo_REGISTRIES_private_TOKEN: "registry-token-value",
      },
      "win32",
    );

    expect(env).toEqual({ Path: "C:\\Windows\\system32" });
  });
});

describe("POSIX: strict case sensitivity", () => {
  for (const platform of ["linux", "darwin"] as const) {
    it(`drops a mismatched spelling on ${platform}`, () => {
      const { env } = buildChildEnvironment(
        {
          Path: "/usr/local/bin",
          PATH: "/usr/bin",
          Cargo_Home: "/wrong/.cargo",
          CARGO_HOME: "/home/runner/.cargo",
        },
        platform,
      );

      expect(env).toEqual({ PATH: "/usr/bin", CARGO_HOME: "/home/runner/.cargo" });
    });

    it(`keeps only the exact allow-listed system spellings on ${platform}`, () => {
      const { env } = buildChildEnvironment(
        {
          SystemRoot: "C:\\Windows",
          SYSTEMROOT: "C:\\Windows",
          systemroot: "C:\\Windows",
          ComSpec: "cmd.exe",
          COMSPEC: "cmd.exe",
          Path: "/usr/bin",
        },
        platform,
      );

      // SystemRoot and SYSTEMROOT are both listed; ComSpec is listed but
      // COMSPEC is not, and neither is the all-lowercase form.
      expect(env).toEqual({
        SystemRoot: "C:\\Windows",
        SYSTEMROOT: "C:\\Windows",
        ComSpec: "cmd.exe",
      });
      expect(Object.keys(env).sort()).toEqual(["ComSpec", "SYSTEMROOT", "SystemRoot"]);
    });

    it(`does not match allow-list prefixes case-insensitively on ${platform}`, () => {
      expect(isAllowedEnvName("LC_ALL", platform)).toBe(true);
      expect(isAllowedEnvName("lc_all", platform)).toBe(false);
      expect(isAllowedEnvName("CARGO_NET_OFFLINE", platform)).toBe(true);
      expect(isAllowedEnvName("cargo_net_offline", platform)).toBe(false);
    });
  }
});
