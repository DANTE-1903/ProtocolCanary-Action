import { describe, expect, it } from "vitest";

import {
  PREBUILT_TARGET_TRIPLES,
  getReleaseAssetName,
  prebuiltTargetTriple,
} from "../../src/canary";
import { InstallationFailedError } from "../../src/errors";

describe("PREBUILT_TARGET_TRIPLES", () => {
  it("contains exactly the five supported platform/arch pairs", () => {
    expect(Object.keys(PREBUILT_TARGET_TRIPLES).sort()).toEqual([
      "darwin-arm64",
      "darwin-x64",
      "linux-arm64",
      "linux-x64",
      "win32-x64",
    ]);
  });

  it("maps linux-x64 to the GNU x86_64 triple", () => {
    expect(PREBUILT_TARGET_TRIPLES["linux-x64"]).toBe("x86_64-unknown-linux-gnu");
  });

  it("maps linux-arm64 to the GNU aarch64 triple", () => {
    expect(PREBUILT_TARGET_TRIPLES["linux-arm64"]).toBe("aarch64-unknown-linux-gnu");
  });

  it("maps darwin-x64 to the Apple x86_64 triple", () => {
    expect(PREBUILT_TARGET_TRIPLES["darwin-x64"]).toBe("x86_64-apple-darwin");
  });

  it("maps darwin-arm64 to the Apple aarch64 triple", () => {
    expect(PREBUILT_TARGET_TRIPLES["darwin-arm64"]).toBe("aarch64-apple-darwin");
  });

  it("maps win32-x64 to the MSVC triple", () => {
    expect(PREBUILT_TARGET_TRIPLES["win32-x64"]).toBe("x86_64-pc-windows-msvc");
  });
});

describe("prebuiltTargetTriple", () => {
  it.each([
    ["linux", "x64", "x86_64-unknown-linux-gnu"],
    ["linux", "arm64", "aarch64-unknown-linux-gnu"],
    ["darwin", "x64", "x86_64-apple-darwin"],
    ["darwin", "arm64", "aarch64-apple-darwin"],
    ["win32", "x64", "x86_64-pc-windows-msvc"],
  ])("maps %s/%s to the correct Rust triple", (platform, arch, expected) => {
    expect(prebuiltTargetTriple(platform, arch)).toBe(expected);
  });

  it.each([
    ["linux", "arm"],
    ["linux", "ia32"],
    ["linux", "mips"],
    ["linux", "s390x"],
    ["darwin", "ia32"],
    ["win32", "arm64"],
    ["win32", "ia32"],
    ["freebsd", "x64"],
    ["sunos", "x64"],
    ["android", "arm64"],
  ])("throws InstallationFailedError for unsupported %s/%s", (platform, arch) => {
    expect(() => prebuiltTargetTriple(platform, arch)).toThrow(InstallationFailedError);
  });

  it("includes the unsupported pair in the error message", () => {
    let caught: unknown;
    try {
      prebuiltTargetTriple("linux", "mips");
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(InstallationFailedError);
    expect((caught as InstallationFailedError).message).toContain("linux-mips");
  });

  it("lists supported platforms in the error message for an unsupported pair", () => {
    let caught: unknown;
    try {
      prebuiltTargetTriple("android", "arm64");
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(InstallationFailedError);
    const msg = (caught as InstallationFailedError).message;
    expect(msg).toContain("linux-x64");
    expect(msg).toContain("darwin-arm64");
    expect(msg).toContain("win32-x64");
  });

  it("throws for an entirely unknown platform string", () => {
    expect(() => prebuiltTargetTriple("haiku", "x64")).toThrow(InstallationFailedError);
  });

  it("throws for an empty platform string", () => {
    expect(() => prebuiltTargetTriple("", "x64")).toThrow(InstallationFailedError);
  });

  it("throws for an empty arch string", () => {
    expect(() => prebuiltTargetTriple("linux", "")).toThrow(InstallationFailedError);
  });
});

describe("getReleaseAssetName", () => {
  it.each([
    ["linux", "x64", "stellar-canary-linux-x86_64"],
    ["linux", "arm64", "stellar-canary-linux-aarch64"],
    ["darwin", "x64", "stellar-canary-macos-x86_64"],
    ["darwin", "arm64", "stellar-canary-macos-aarch64"],
    ["win32", "x64", "stellar-canary-windows-x86_64.exe"],
  ])("returns the correct asset name for %s/%s", (platform, arch, expected) => {
    expect(getReleaseAssetName(platform, arch)).toBe(expected);
  });

  it("returns undefined for linux/arm (unsupported)", () => {
    expect(getReleaseAssetName("linux", "arm")).toBeUndefined();
  });

  it("returns undefined for linux/ia32 (unsupported)", () => {
    expect(getReleaseAssetName("linux", "ia32")).toBeUndefined();
  });

  it("returns undefined for linux/mips (unsupported)", () => {
    expect(getReleaseAssetName("linux", "mips")).toBeUndefined();
  });

  it("returns undefined for darwin/ia32 (unsupported)", () => {
    expect(getReleaseAssetName("darwin", "ia32")).toBeUndefined();
  });

  it("returns undefined for win32/arm64 (not shipped as a prebuilt)", () => {
    expect(getReleaseAssetName("win32", "arm64")).toBeUndefined();
  });

  it("returns undefined for an entirely unknown platform", () => {
    expect(getReleaseAssetName("freebsd", "x64")).toBeUndefined();
  });

  it("returns undefined for empty platform and arch strings", () => {
    expect(getReleaseAssetName("", "")).toBeUndefined();
  });

  it("Linux and macOS asset names do not carry an .exe extension", () => {
    expect(getReleaseAssetName("linux", "x64")).not.toMatch(/\.exe$/);
    expect(getReleaseAssetName("linux", "arm64")).not.toMatch(/\.exe$/);
    expect(getReleaseAssetName("darwin", "x64")).not.toMatch(/\.exe$/);
    expect(getReleaseAssetName("darwin", "arm64")).not.toMatch(/\.exe$/);
  });

  it("Windows asset name carries an .exe extension", () => {
    expect(getReleaseAssetName("win32", "x64")).toMatch(/\.exe$/);
  });

  it("all supported asset names are prefixed with stellar-canary-", () => {
    const supported: Array<[string, string]> = [
      ["linux", "x64"],
      ["linux", "arm64"],
      ["darwin", "x64"],
      ["darwin", "arm64"],
      ["win32", "x64"],
    ];
    for (const [platform, arch] of supported) {
      expect(getReleaseAssetName(platform, arch)).toMatch(/^stellar-canary-/);
    }
  });

  it("Linux asset names encode x64 as x86_64 and arm64 as aarch64 (Rust triple conventions)", () => {
    expect(getReleaseAssetName("linux", "x64")).toContain("x86_64");
    expect(getReleaseAssetName("linux", "arm64")).toContain("aarch64");
  });

  it("macOS asset names encode x64 as x86_64 and arm64 as aarch64", () => {
    expect(getReleaseAssetName("darwin", "x64")).toContain("x86_64");
    expect(getReleaseAssetName("darwin", "arm64")).toContain("aarch64");
  });
});

describe("prebuiltTargetTriple and getReleaseAssetName consistency", () => {
  it("every pair that returns a triple also returns an asset name", () => {
    for (const key of Object.keys(PREBUILT_TARGET_TRIPLES)) {
      const [platform, arch] = key.split("-") as [string, string];
      expect(getReleaseAssetName(platform, arch)).toBeDefined();
    }
  });

  it("pairs that have no triple also have no asset name", () => {
    const unsupported: Array<[string, string]> = [
      ["linux", "arm"],
      ["linux", "ia32"],
      ["linux", "mips"],
      ["darwin", "ia32"],
      ["freebsd", "x64"],
    ];
    for (const [platform, arch] of unsupported) {
      expect(PREBUILT_TARGET_TRIPLES[`${platform}-${arch}`]).toBeUndefined();
      expect(getReleaseAssetName(platform, arch)).toBeUndefined();
    }
  });
});
