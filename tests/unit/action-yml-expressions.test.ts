import * as fs from "node:fs";
import * as path from "node:path";

import { describe, expect, it } from "vitest";
import { parse } from "yaml";

const ACTION_YML_PATH = path.resolve(__dirname, "../../action.yml");
const ACTION_YML = fs.readFileSync(ACTION_YML_PATH, "utf8");

interface ActionManifest {
  readonly inputs?: Record<string, { readonly default?: unknown }> | undefined;
}

const BOOLEAN_INPUTS = [
  "fail-on-warning",
  "offline",
  "strict-integrity",
  "generate-receipt",
] as const;

function actionInputs(source: string): Record<string, { readonly default?: unknown }> {
  return (parse(source) as ActionManifest).inputs ?? {};
}

function booleanDefaultViolations(source: string): string[] {
  const inputs = actionInputs(source);
  const violations: string[] = [];
  let inInputs = false;
  let currentInput: string | undefined;

  for (const [index, line] of source.split(/\r?\n/).entries()) {
    if (/^inputs:\s*$/.test(line)) {
      inInputs = true;
      currentInput = undefined;
      continue;
    }
    if (/^\S/.test(line)) {
      inInputs = false;
      currentInput = undefined;
      continue;
    }
    if (!inInputs) {
      continue;
    }

    const input = /^ {2}([A-Za-z0-9_-]+):\s*$/.exec(line);
    if (input) {
      currentInput = input[1];
      continue;
    }
    if (currentInput === undefined) {
      continue;
    }

    const defaultValue = /^\s+default:\s*(.*?)\s*(?:#.*)?$/.exec(line)?.[1]?.trim();
    if (defaultValue === undefined) {
      continue;
    }
    const isBooleanToken = /^(?:true|false)$/i.test(defaultValue);
    const isStringLiteral =
      /^(['"])(?:true|false)\1$/i.test(defaultValue) &&
      (inputs[currentInput]?.default === "true" || inputs[currentInput]?.default === "false");
    if ((isBooleanToken || typeof inputs[currentInput]?.default === "boolean") && !isStringLiteral) {
      violations.push(`${currentInput} (line ${index + 1}): default ${defaultValue} is an unquoted YAML boolean`);
    }
  }

  return violations;
}

describe("action.yml expressions", () => {
  // The runner evaluates `${{ ... }}` anywhere in action.yml, including inside
  // `description:` text, where the `github` context is not available. A literal
  // `${{ github.token }}` in a description therefore makes the runner refuse to
  // load the whole Action ("Unrecognized named-value: 'github'"). Only input
  // `default:` values may carry an expression.
  it("uses expressions only in input defaults, never in descriptions", () => {
    const offenders = ACTION_YML.split(/\r?\n/)
      .map((text, index) => ({ line: index + 1, text }))
      .filter(({ text }) => text.includes("${{") && !/^\s*default:\s/.test(text));

    expect(offenders).toEqual([]);
  });

  it("does not use github context in an action input default", () => {
    expect(ACTION_YML).not.toMatch(/^\s*default:.*\$\{\{\s*github\./m);
    expect(ACTION_YML).toMatch(/github-token:[\s\S]*?required:\s*false/m);
  });
});

describe("action.yml boolean input defaults", () => {
  it("keeps boolean input defaults as quoted string literals", () => {
    const inputs = actionInputs(ACTION_YML);
    const invalid: string[] = [];

    for (const name of BOOLEAN_INPUTS) {
      const value = inputs[name]?.default;
      if (value !== "true" && value !== "false") {
        invalid.push(`${name} (${JSON.stringify(value)}): expected the string "true" or "false"`);
      }
    }

    expect(invalid).toEqual([]);
  });

  it("has no unquoted YAML boolean defaults anywhere in inputs", () => {
    expect(booleanDefaultViolations(ACTION_YML)).toEqual([]);
  });

  it("reports offending defaults with their input name and line number", () => {
    const source = [
      "name: Example",
      "inputs:",
      "  safe:",
      '    default: "true"',
      "  unsafe:",
      "    default: false",
      "outputs:",
      "  status:",
      "    default: true",
    ].join("\n");

    expect(booleanDefaultViolations(source)).toEqual([
      "unsafe (line 6): default false is an unquoted YAML boolean",
    ]);
  });
});
