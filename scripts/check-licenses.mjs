#!/usr/bin/env node
// @ts-check

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

export const ALLOWLIST_FILE = ".licenses-allowlist.json";

/**
 * @typedef {{
 *   name?: string,
 *   version?: string,
 *   resolved?: string,
 *   optional?: boolean,
 *   dependencies?: Record<string, DependencyNode | undefined>,
 * }} DependencyNode
 */

/**
 * @typedef {{
 *   version?: string,
 *   license?: string,
 *   licenses?: Array<string | { type?: string }>,
 * }} PackageManifest
 */

/**
 * @typedef {{ pkgJsonPath: string, pkg: PackageManifest }} ResolvedPackage
 * @typedef {(name: string, parentDir: string) => ResolvedPackage | null} PackageResolver
 */

/**
 * @typedef {{
 *   allowedLicenses?: string[],
 *   packageExceptions?: Record<string, { license?: string, reason?: string }>,
 * }} LicenseAllowlist
 */

/**
 * @typedef {{
 *   package: string,
 *   version: string | undefined,
 *   license: string,
 *   chain: string,
 *   reason: string,
 * }} LicenseViolation
 */

/**
 * @typedef {{
 *   name: string,
 *   version: string | undefined,
 *   license: string,
 *   allowed: boolean,
 *   path: string,
 * }} CheckedPackage
 */

/**
 * @typedef {{
 *   checked: Map<string, CheckedPackage>,
 *   violations: LicenseViolation[],
 *   licenseCounts: Map<string, number>,
 * }} AuditResult
 */

/**
 * Reads and parses the license allow-list. Throws instead of exiting so the
 * same validation logic can be used by tests; the CLI translates the error
 * into the original message and exit code.
 *
 * @param {string} [cwd]
 * @param {string} [fileName]
 * @returns {LicenseAllowlist}
 */
export function loadAllowlist(cwd = process.cwd(), fileName = ALLOWLIST_FILE) {
  const allowlistPath = path.resolve(cwd, fileName);
  if (!fs.existsSync(allowlistPath)) {
    throw new Error(`Allowlist file not found at ${allowlistPath}`);
  }
  return JSON.parse(fs.readFileSync(allowlistPath, "utf8"));
}

/**
 * Finds the closest installed package.json for a dependency name, walking up
 * from `fromDir` so nested dependencies resolve to their own manifest.
 *
 * @param {string} name
 * @param {string} fromDir
 * @returns {string | null}
 */
export function findPackageJson(name, fromDir) {
  let curr = fromDir;
  while (curr && curr !== path.dirname(curr)) {
    const candidate = path.join(curr, "node_modules", name, "package.json");
    if (fs.existsSync(candidate)) return candidate;
    curr = path.dirname(curr);
  }
  return null;
}

/**
 * Default resolver: reads an installed package's manifest from node_modules.
 *
 * @type {PackageResolver}
 */
export function resolveInstalledPackage(name, parentDir) {
  const pkgJsonPath = findPackageJson(name, parentDir);
  if (!pkgJsonPath) return null;
  return { pkgJsonPath, pkg: JSON.parse(fs.readFileSync(pkgJsonPath, "utf8")) };
}

/**
 * Queries npm for the production-only dependency tree.
 *
 * @param {string} [cwd]
 * @returns {DependencyNode}
 */
export function getDependencyTree(cwd = process.cwd()) {
  const npmCmd = process.platform === "win32" ? "npm.cmd" : "npm";
  const stdout = execFileSync(npmCmd, ["ls", "--omit=dev", "--json", "--all"], {
    cwd,
    encoding: "utf8",
    maxBuffer: 20 * 1024 * 1024,
    shell: process.platform === "win32",
  });
  return JSON.parse(stdout);
}

/**
 * Pure auditing logic over an `npm ls` tree. Package manifests are obtained
 * through `resolvePackage`, so tests can exercise allow-list compliance,
 * violations and exceptions without a real node_modules tree.
 *
 * @param {DependencyNode} tree
 * @param {LicenseAllowlist} allowlist
 * @param {{ fromDir?: string, resolvePackage?: PackageResolver, allowlistFile?: string }} [options]
 * @returns {AuditResult}
 */
export function auditDependencyTree(tree, allowlist, options = {}) {
  const {
    fromDir = process.cwd(),
    resolvePackage = resolveInstalledPackage,
    allowlistFile = ALLOWLIST_FILE,
  } = options;

  const allowedSet = new Set(allowlist.allowedLicenses || []);
  const packageExceptions = allowlist.packageExceptions || {};
  const violations = [];
  const checked = new Map();

  /** @param {DependencyNode} node @param {string} parentDir @param {string[]} pathChain */
  function walk(node, parentDir, pathChain) {
    if (!node || !node.dependencies) return;

    for (const [name, dep] of Object.entries(node.dependencies)) {
      // Skip uninstalled optional or peer dependencies (they have no version/resolved in npm ls)
      if (!dep || (!dep.version && !dep.resolved)) {
        continue;
      }

      const currentChain = [...pathChain, `${name}@${dep.version || "unknown"}`];
      const resolved = resolvePackage(name, parentDir);

      if (!resolved) {
        // If it's an optional dependency not present, ignore
        if (dep.optional) {
          continue;
        }
        violations.push({
          package: name,
          version: dep.version,
          license: "NOT_FOUND",
          chain: currentChain.join(" -> "),
          reason: "package.json could not be located in node_modules",
        });
        continue;
      }

      const { pkg, pkgJsonPath } = resolved;
      const version = pkg.version || dep.version;
      const pkgId = `${name}@${version}`;

      if (!checked.has(pkgId)) {
        let license = pkg.license;
        if (!license && Array.isArray(pkg.licenses)) {
          license = pkg.licenses.map((l) => (typeof l === "object" ? l.type : l)).join(" OR ");
        }

        const exception = packageExceptions[pkgId] || packageExceptions[name];
        if (exception) {
          license = exception.license;
        }

        const isAllowed = Boolean(license && allowedSet.has(license));

        checked.set(pkgId, {
          name,
          version,
          license: license || "UNKNOWN",
          allowed: isAllowed,
          path: pkgJsonPath,
        });

        if (!isAllowed) {
          violations.push({
            package: name,
            version,
            license: license || "UNKNOWN",
            chain: currentChain.join(" -> "),
            reason: license
              ? `License "${license}" is not in ${allowlistFile}`
              : "No license field defined in package.json",
          });
        }
      }

      walk(dep, path.dirname(pkgJsonPath), currentChain);
    }
  }

  walk(tree, fromDir, [tree.name || "root"]);

  const licenseCounts = new Map();
  for (const item of checked.values()) {
    licenseCounts.set(item.license, (licenseCounts.get(item.license) || 0) + 1);
  }

  return { checked, violations, licenseCounts };
}

/** @param {AuditResult} audit */
export function formatAuditSummary(audit) {
  const lines = [`Audited licenses across ${audit.checked.size} production dependencies:`];
  for (const [license, count] of audit.licenseCounts.entries()) {
    lines.push(`  - ${license}: ${count} package(s)`);
  }
  return lines.join("\n");
}

/**
 * @param {AuditResult} audit
 * @param {string} [allowlistFile]
 */
export function formatViolationReport(audit, allowlistFile = ALLOWLIST_FILE) {
  const lines = [`❌ Found ${audit.violations.length} license violation(s) in production dependencies:`];
  for (const violation of audit.violations) {
    lines.push(`  - ${violation.package}@${violation.version} (License: ${violation.license})`);
    lines.push(`    Chain: ${violation.chain}`);
    lines.push(`    ${violation.reason}`);
  }
  return `\n${lines.join("\n")}`;
}

/**
 * Full CLI audit. Returns an exit code rather than calling process.exit so it
 * can be exercised directly by tests; output is byte-for-byte the same as the
 * original top-level script.
 *
 * @param {{ cwd?: string, allowlistFile?: string }} [options]
 * @returns {number}
 */
export function checkLicenses(options = {}) {
  const cwd = options.cwd ?? process.cwd();
  const allowlistFile = options.allowlistFile ?? ALLOWLIST_FILE;

  let allowlist;
  try {
    allowlist = loadAllowlist(cwd, allowlistFile);
  } catch (error) {
    console.error(`Error: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }

  const audit = auditDependencyTree(getDependencyTree(cwd), allowlist, {
    fromDir: cwd,
    allowlistFile,
  });

  console.log(formatAuditSummary(audit));
  if (audit.violations.length > 0) {
    console.error(formatViolationReport(audit, allowlistFile));
    return 1;
  }

  console.log("\n✅ All production dependencies comply with the license allow-list.");
  return 0;
}

// CLI execution check: importing this module for unit tests must not run the audit.
const isDirectExecution =
  process.argv[1] !== undefined &&
  fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);

if (isDirectExecution) {
  const exitCode = checkLicenses();
  if (exitCode !== 0) {
    process.exit(exitCode);
  }
}
