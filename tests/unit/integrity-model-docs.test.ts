/**
 * Documentation gate for issue #376 (Security Model, Integrity Guarantees,
 * and Trust Boundaries).
 *
 * The document deliberately lives at `docs/integrity-model.md`, not at the
 * `docs/security-model.md` path named in the issue: that path is created by
 * open PR #461 (its fork-PR threat model, asserted by
 * `tests/unit/fork-boundary.test.ts`), and two unmerged PRs adding the same
 * path with different content is the one collision no later rebase resolves
 * without deleting a maintainer's text. The two documents are siblings on
 * different axes and cross-reference each other.
 *
 * Tests here keep the document honest: the required topics must be present,
 * the stated facts about D-07/D-11 must not overstate, every relative link
 * must resolve on disk (issue #376 "Negative testing: verify all
 * documentation links resolve cleanly"), and SECURITY.md must point at it.
 */
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

import { describe, expect, it } from "vitest";
import { parse as parseYaml } from "yaml";

const REPO_ROOT = path.join(__dirname, "..", "..");
const DOC_PATH = path.join(REPO_ROOT, "docs", "integrity-model.md");

function doc(): string {
  return fs.readFileSync(DOC_PATH, "utf8");
}

/** Relative (non-anchor, non-URL) link targets inside the document. */
function relativeLinkTargets(text: string): string[] {
  const targets: string[] = [];
  for (const match of text.matchAll(/\]\(([^)\s]+)\)/g)) {
    const target = match[1] ?? "";
    if (/^(https?:|mailto:|#)/.test(target)) {
      continue;
    }
    targets.push(target.split("#")[0] ?? "");
  }
  return targets.filter((target) => target !== "");
}

interface FencedCodeSnippet {
  readonly language: string;
  readonly content: string;
}

/** Extracts all fenced code blocks from markdown with their declared language. */
function extractFencedSnippets(markdown: string): FencedCodeSnippet[] {
  const snippets: FencedCodeSnippet[] = [];
  for (const match of markdown.matchAll(/```([a-zA-Z0-9_-]+)?\r?\n([\s\S]*?)```/g)) {
    snippets.push({
      language: (match[1] ?? "").trim().toLowerCase(),
      content: match[2] ?? "",
    });
  }
  return snippets;
}

/** Validates YAML snippet syntax using the pinned YAML parser. */
function validateYamlSnippet(snippet: string): void {
  parseYaml(snippet);
}

/** Validates basic shell quote and delimiter balance when bash is unavailable. */
function validateBasicShellSyntax(code: string): void {
  let inSingleQuote = false;
  let inDoubleQuote = false;
  let escaped = false;
  let parenDepth = 0;
  let braceDepth = 0;

  for (let i = 0; i < code.length; i++) {
    const ch = code[i];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (ch === "\\" && !inSingleQuote) {
      escaped = true;
      continue;
    }
    if (ch === "'" && !inDoubleQuote) {
      inSingleQuote = !inSingleQuote;
      continue;
    }
    if (ch === '"' && !inSingleQuote) {
      inDoubleQuote = !inDoubleQuote;
      continue;
    }
    if (!inSingleQuote && !inDoubleQuote) {
      if (ch === "(") parenDepth++;
      else if (ch === ")") parenDepth--;
      else if (ch === "{") braceDepth++;
      else if (ch === "}") braceDepth--;
      if (parenDepth < 0 || braceDepth < 0) {
        throw new Error(`Unbalanced delimiter in shell code: ${code}`);
      }
    }
  }
  if (inSingleQuote || inDoubleQuote || parenDepth !== 0 || braceDepth !== 0) {
    throw new Error(`Unterminated quotes or unclosed blocks in shell code: ${code}`);
  }
}

/** Validates shell/bash syntax using bash -n with fallback to delimiter balance. */
function validateBashSnippet(snippet: string): void {
  const result = spawnSync("bash", ["-n", "-c", snippet], { encoding: "utf8" });
  if (result.error) {
    validateBasicShellSyntax(snippet);
    return;
  }
  if (result.status !== 0) {
    throw new Error(`Bash syntax error: ${result.stderr || result.stdout}`);
  }
}

/** Extracts relative file paths referenced in backticks (e.g. `src/inputs.ts`). */
function relativeFileReferences(text: string): string[] {
  const refs: string[] = [];
  for (const match of text.matchAll(/`((?:src|docs|tests)\/[^`\s]+\.[a-zA-Z0-9_-]+)`/g)) {
    if (match[1]) {
      refs.push(match[1]);
    }
  }
  return refs;
}

describe("docs/integrity-model.md (issue #376)", () => {
  it("exists", () => {
    expect(fs.existsSync(DOC_PATH)).toBe(true);
  });

  it("documents the strict-integrity policy introduced by #372", () => {
    const contents = doc();
    expect(contents).toContain("strict-integrity");
    expect(contents).toContain("fail closed");
    // The default must be stated honestly: compatibility-preserving false.
    expect(contents).toMatch(/default(?:s)? (?:to )?`?false/i);
  });

  it("records D-07 and D-11 at their true status without overstating", () => {
    const contents = doc();
    expect(contents).toContain("D-07");
    expect(contents).toContain("D-11");
    // Checksums are data integrity, never author authenticity.
    expect(contents).toMatch(/not.*proof of.*authenticit/i);
    // Redirect policy is unresolved, not "allowlisted".
    expect(contents).toMatch(/redirect.*(unresolved|blocked|not \(yet\)? follow)/i);
  });

  it("documents least-privilege workflow permissions and the fork PR trust boundary (#369)", () => {
    const contents = doc();
    expect(contents).toMatch(/least[- ]privilege/i);
    expect(contents).toMatch(/fork PR/i);
  });

  it("contains a threat model section", () => {
    expect(doc()).toMatch(/^##.*threat model/im);
  });

  it("links only to files that exist in the repository", () => {
    for (const target of relativeLinkTargets(doc())) {
      const resolved = path.resolve(path.dirname(DOC_PATH), target);
      expect(
        fs.existsSync(resolved),
        `broken relative link in docs/integrity-model.md -> ${target}`,
      ).toBe(true);
    }
  });

  it("is linked from SECURITY.md", () => {
    const security = fs.readFileSync(path.join(REPO_ROOT, "SECURITY.md"), "utf8");
    expect(security).toContain("docs/integrity-model.md");
  });

  describe("code snippet syntax and link validity (#661)", () => {
    it("all fenced YAML snippets in docs/integrity-model.md have valid syntax", () => {
      const snippets = extractFencedSnippets(doc()).filter((s) =>
        ["yaml", "yml"].includes(s.language),
      );
      for (const [index, snippet] of snippets.entries()) {
        expect(() => validateYamlSnippet(snippet.content), `YAML snippet ${index} has invalid syntax`).not.toThrow();
      }

      // Non-vacuous check: verify parser fails on invalid YAML
      expect(() => validateYamlSnippet("key: : invalid\n  bad-indent")).toThrow();
    });

    it("all fenced bash snippets in docs/integrity-model.md have valid syntax", () => {
      const snippets = extractFencedSnippets(doc()).filter((s) =>
        ["bash", "sh", "shell"].includes(s.language),
      );
      for (const [index, snippet] of snippets.entries()) {
        expect(() => validateBashSnippet(snippet.content), `Bash snippet ${index} has invalid syntax`).not.toThrow();
      }

      // Non-vacuous check: verify bash validator rejects syntax errors
      expect(() => validateBashSnippet("if true; then echo unclosed")).toThrow();
    });

    it("all relative markdown links in docs/integrity-model.md resolve to existing files on disk", () => {
      const targets = relativeLinkTargets(doc());
      expect(targets.length).toBeGreaterThan(0);
      for (const target of targets) {
        const resolved = path.resolve(path.dirname(DOC_PATH), target);
        expect(
          fs.existsSync(resolved),
          `broken relative markdown link in docs/integrity-model.md: ${target} (resolved to ${resolved})`,
        ).toBe(true);
      }
    });

    it("all relative repository source file references in docs/integrity-model.md resolve on disk", () => {
      const refs = relativeFileReferences(doc());
      expect(refs.length).toBeGreaterThan(0);
      for (const ref of refs) {
        const resolved = path.resolve(REPO_ROOT, ref);
        expect(
          fs.existsSync(resolved),
          `broken repository file reference in docs/integrity-model.md: ${ref} (resolved to ${resolved})`,
        ).toBe(true);
      }
    });
  });
});
