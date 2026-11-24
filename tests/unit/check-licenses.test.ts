import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  ALLOWLIST_FILE,
  auditDependencyTree,
  checkLicenses,
  findPackageJson,
  formatAuditSummary,
  formatViolationReport,
  loadAllowlist,
} from "../../scripts/check-licenses.mjs";

const REPO_ROOT = path.resolve(__dirname, "..", "..");
const SCRIPT_PATH = path.join(REPO_ROOT, "scripts", "check-licenses.mjs");
const tempDirs: string[] = [];

type FakeManifest = { version?: string; license?: string; licenses?: string[] };

function resolverFrom(manifests: Record<string, FakeManifest>) {
  return (name: string): { pkgJsonPath: string; pkg: FakeManifest } | null => {
    const pkg = manifests[name];
    if (!pkg) return null;
    return { pkgJsonPath: path.join("/fake/node_modules", name, "package.json"), pkg };
  };
}

function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "check-licenses-test-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  tempDirs.length = 0;
});

describe("loadAllowlist", () => {
  it("loads the repository allow-list", () => {
    const allowlist = loadAllowlist(REPO_ROOT);
    expect(allowlist.allowedLicenses).toContain("MIT");
    expect(allowlist.packageExceptions).toHaveProperty("buffers@0.1.1");
  });

  it("throws a descriptive error when the allow-list is missing", () => {
    expect(() => loadAllowlist(tempDir())).toThrow(/Allowlist file not found/);
  });
});

describe("findPackageJson", () => {
  it("walks up from nested directories to the installed manifest", () => {
    const dir = tempDir();
    const nested = path.join(dir, "src", "deep");
    fs.mkdirSync(nested, { recursive: true });
    const manifest = path.join(dir, "node_modules", "demo", "package.json");
    fs.mkdirSync(path.dirname(manifest), { recursive: true });
    fs.writeFileSync(manifest, JSON.stringify({ name: "demo", version: "1.0.0" }));

    expect(findPackageJson("demo", nested)).toBe(manifest);
    expect(findPackageJson("absent", nested)).toBeNull();
  });
});

describe("auditDependencyTree", () => {
  it("accepts dependencies whose licenses are on the allow-list", () => {
    const audit = auditDependencyTree(
      {
        name: "root",
        dependencies: {
          alpha: { version: "1.0.0" },
          beta: { version: "2.0.0" },
        },
      },
      loadAllowlist(REPO_ROOT),
      {
        resolvePackage: resolverFrom({
          alpha: { version: "1.0.0", license: "MIT" },
          beta: { version: "2.0.0", license: "Apache-2.0" },
        }),
      },
    );

    expect(audit.violations).toEqual([]);
    expect(audit.checked.size).toBe(2);
    expect(audit.checked.get("alpha@1.0.0")).toMatchObject({ license: "MIT", allowed: true });
    expect(audit.licenseCounts.get("MIT")).toBe(1);
    expect(audit.licenseCounts.get("Apache-2.0")).toBe(1);
  });

  it("reports a disallowed license with its dependency chain context", () => {
    const audit = auditDependencyTree(
      {
        name: "root",
        dependencies: {
          parent: {
            version: "1.2.0",
            dependencies: { child: { version: "3.4.5" } },
          },
        },
      },
      loadAllowlist(REPO_ROOT),
      {
        resolvePackage: resolverFrom({
          parent: { version: "1.2.0", license: "MIT" },
          child: { version: "3.4.5", license: "GPL-3.0" },
        }),
      },
    );

    expect(audit.violations).toHaveLength(1);
    expect(audit.violations[0]).toMatchObject({
      package: "child",
      version: "3.4.5",
      license: "GPL-3.0",
      chain: "root -> parent@1.2.0 -> child@3.4.5",
      reason: `License "GPL-3.0" is not in ${ALLOWLIST_FILE}`,
    });
    expect(audit.checked.get("parent@1.2.0")).toMatchObject({ allowed: true });
    expect(audit.checked.get("child@3.4.5")).toMatchObject({ allowed: false });
  });

  it("respects package exceptions from the allow-list", () => {
    const audit = auditDependencyTree(
      {
        name: "root",
        dependencies: { buffers: { version: "0.1.1" } },
      },
      loadAllowlist(REPO_ROOT),
      { resolvePackage: resolverFrom({ buffers: { version: "0.1.1" } }) },
    );

    expect(audit.violations).toEqual([]);
    expect(audit.checked.get("buffers@0.1.1")).toMatchObject({ license: "MIT", allowed: true });
  });

  it("flags missing manifests as NOT_FOUND with chain context", () => {
    const audit = auditDependencyTree(
      { name: "root", dependencies: { missing: { version: "9.9.9" } } },
      loadAllowlist(REPO_ROOT),
      { resolvePackage: () => null },
    );

    expect(audit.violations).toMatchObject([
      {
        package: "missing",
        version: "9.9.9",
        license: "NOT_FOUND",
        chain: "root -> missing@9.9.9",
        reason: "package.json could not be located in node_modules",
      },
    ]);
  });

  it("ignores uninstalled optional and peer-like dependencies", () => {
    const audit = auditDependencyTree(
      {
        name: "root",
        dependencies: {
          uninstalled: {},
          optionalMissing: { version: "1.0.0", optional: true },
        },
      },
      loadAllowlist(REPO_ROOT),
      { resolvePackage: () => null },
    );

    expect(audit.violations).toEqual([]);
    expect(audit.checked.size).toBe(0);
  });

  it("supports the licenses array manifest form", () => {
    const audit = auditDependencyTree(
      { name: "root", dependencies: { multi: { version: "1.0.0" } } },
      loadAllowlist(REPO_ROOT),
      { resolvePackage: resolverFrom({ multi: { version: "1.0.0", licenses: ["MIT"] } }) },
    );

    expect(audit.violations).toEqual([]);
    expect(audit.checked.get("multi@1.0.0")).toMatchObject({ license: "MIT", allowed: true });
  });
});

describe("audit reporting", () => {
  it("formats the summary and violation report without mutating the audit", () => {
    const audit = auditDependencyTree(
      { name: "root", dependencies: { bad: { version: "1.0.0" } } },
      loadAllowlist(REPO_ROOT),
      { resolvePackage: resolverFrom({ bad: { version: "1.0.0", license: "GPL-3.0" } }) },
    );

    expect(formatAuditSummary(audit)).toContain("Audited licenses across 1 production dependencies:");
    expect(formatViolationReport(audit)).toContain("❌ Found 1 license violation(s)");
    expect(formatViolationReport(audit)).toContain("Chain: root -> bad@1.0.0");
    expect(audit.violations).toHaveLength(1);
  });
});

describe("CLI entry point", () => {
  it("direct invocation still audits production dependencies with exit code 0", () => {
    const stdout = execFileSync(process.execPath, [SCRIPT_PATH], {
      cwd: REPO_ROOT,
      encoding: "utf8",
    });

    expect(stdout).toContain("Audited licenses across");
    expect(stdout).toContain("✅ All production dependencies comply with the license allow-list.");
    expect(checkLicenses({ cwd: REPO_ROOT })).toBe(0);
  });
});
