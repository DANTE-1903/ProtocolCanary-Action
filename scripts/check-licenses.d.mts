export interface DependencyNode {
  name?: string;
  version?: string;
  resolved?: string;
  optional?: boolean;
  dependencies?: Record<string, DependencyNode | undefined>;
}

export interface PackageManifest {
  version?: string;
  license?: string;
  licenses?: Array<string | { type?: string }>;
}

export interface ResolvedPackage {
  pkgJsonPath: string;
  pkg: PackageManifest;
}

export type PackageResolver = (name: string, parentDir: string) => ResolvedPackage | null;

export interface LicenseAllowlist {
  allowedLicenses?: string[];
  packageExceptions?: Record<string, { license?: string; reason?: string }>;
}

export interface LicenseViolation {
  package: string;
  version: string | undefined;
  license: string;
  chain: string;
  reason: string;
}

export interface CheckedPackage {
  name: string;
  version: string | undefined;
  license: string;
  allowed: boolean;
  path: string;
}

export interface AuditResult {
  checked: Map<string, CheckedPackage>;
  violations: LicenseViolation[];
  licenseCounts: Map<string, number>;
}

export interface AuditOptions {
  fromDir?: string;
  resolvePackage?: PackageResolver;
  allowlistFile?: string;
}

export interface CheckLicensesOptions {
  cwd?: string;
  allowlistFile?: string;
}

export const ALLOWLIST_FILE: string;

/** Reads and parses the license allow-list. */
export function loadAllowlist(cwd?: string, fileName?: string): LicenseAllowlist;

/** Finds the closest installed package.json for a dependency name. */
export function findPackageJson(name: string, fromDir: string): string | null;

/** Default resolver that reads an installed package's manifest. */
export function resolveInstalledPackage(name: string, parentDir: string): ResolvedPackage | null;

/** Queries npm for the production-only dependency tree. */
export function getDependencyTree(cwd?: string): DependencyNode;

/** Pure auditing logic over an `npm ls` tree. */
export function auditDependencyTree(
  tree: DependencyNode,
  allowlist: LicenseAllowlist,
  options?: AuditOptions,
): AuditResult;

/** Formats the "audited N dependencies" summary. */
export function formatAuditSummary(audit: AuditResult): string;

/** Formats the violation report, including dependency chain context. */
export function formatViolationReport(audit: AuditResult, allowlistFile?: string): string;

/** Runs the full CLI audit and returns a process exit code. */
export function checkLicenses(options?: CheckLicensesOptions): number;
