import * as fs from "node:fs";
import * as path from "node:path";

import { describe, expect, it } from "vitest";
import { parse } from "yaml";

/**
 * #408: Workflow security and pinning policy tests.
 *
 * All GitHub Actions workflow files in .github/workflows/ must follow two
 * repository security rules:
 *
 *  1. Top-level permissions block: every workflow must explicitly declare
 *     top-level `permissions:` (e.g. `contents: read`) to prevent inheriting
 *     broad default repository permissions.
 *
 *  2. Full commit SHA pinning: every external `uses:` action reference must be
 *     pinned to a 40-character hexadecimal commit SHA. Local `./` and `$/`
 *     references within this repository are excluded.
 */
const REPO_ROOT = path.join(__dirname, "..", "..");
const WORKFLOWS_DIR = path.join(REPO_ROOT, ".github", "workflows");

function getWorkflowFiles(): { filename: string; filepath: string; content: string }[] {
  const files = fs.readdirSync(WORKFLOWS_DIR).filter((file) => file.endsWith(".yml") || file.endsWith(".yaml"));
  return files.map((file) => ({
    filename: file,
    filepath: path.join(WORKFLOWS_DIR, file),
    content: fs.readFileSync(path.join(WORKFLOWS_DIR, file), "utf8"),
  }));
}

describe("workflow security and pinning policy (#408)", () => {
  const workflows = getWorkflowFiles();

  it("finds workflow files in .github/workflows", () => {
    expect(workflows.length).toBeGreaterThan(0);
  });

  describe("top-level permissions key", () => {
    for (const { filename, content } of workflows) {
      it(`${filename} declares an explicit top-level permissions block`, () => {
        // Must declare a line starting with `permissions:` at root (no leading spaces)
        const hasTopLevelPermissions = /^permissions:\s*(?:#.*)?$/m.test(content) || /^permissions:\s*\S+/m.test(content);
        expect(hasTopLevelPermissions, `${filename} is missing a top-level permissions: block`).toBe(true);
      });
    }
  });

  describe("action reference SHA pinning", () => {
    for (const { filename, content } of workflows) {
      it(`pins all external uses in ${filename} to 40-character commit SHAs`, () => {
        const lines = content.split(/\r?\n/);
        const SHA_REGEX = /^[0-9a-f]{40}$/i;

        for (let i = 0; i < lines.length; i += 1) {
          const line = lines[i] ?? "";
          const usesMatch = /^\s*(?:-\s+)?uses:\s*(\S+)/.exec(line);
          if (!usesMatch) {
            continue;
          }

          const ref = usesMatch[1] ?? "";

          // Exclude local relative references (./... or $/...) and reusable workflows in the same repo
          if (ref.startsWith("./") || ref.startsWith("$/")) {
            continue;
          }

          // Expected format: <owner>/<repo>[/path]@<ref>
          const atIndex = ref.indexOf("@");
          expect(atIndex, `Line ${i + 1} in ${filename}: 'uses: ${ref}' is missing '@'`).toBeGreaterThan(0);

          const actionTarget = ref.slice(0, atIndex);
          const versionRef = ref.slice(atIndex + 1);

          // If the reusable workflow references this repo's own floating tag (@v1), check if it's explicitly justified
          if (actionTarget === "StellarCanary/ProtocolCanary-Action") {
            // Documented exception for reusable workflow calling the action by release tag
            continue;
          }

          expect(
            SHA_REGEX.test(versionRef),
            `Line ${i + 1} in ${filename}: 'uses: ${ref}' must be pinned to a 40-character commit SHA (got '${versionRef}')`,
          ).toBe(true);
        }
      });
    }
  });
});

/**
 * Issue #618: job-level permission audit.
 *
 * A workflow-level `permissions:` block is not a ceiling. GitHub lets a job
 * replace it with its own `permissions:` block, so a job can grant itself a
 * write scope the workflow deliberately withheld. The #408 suite above only
 * proves every workflow declares *some* top-level permissions; these tests
 * prove no job widens the token beyond a reviewed, cataloged exception.
 *
 * The same audit covers checkout credential persistence: a checkout step
 * without `persist-credentials: false` leaves the token in the workspace's
 * `.git/config` for any later step (including fork-controlled code) to read.
 *
 * Workflows are parsed with the `yaml` devDependency already used elsewhere in
 * the suite, not with line-oriented regexes, so nested `permissions:` and
 * `with:` blocks cannot be confused with the top-level ones. The files under
 * `.github/workflows/examples/` are documentation copied by users and are
 * never executed by GitHub, so they are outside this audit, exactly as the
 * #408 reader treats them.
 */
interface WorkflowStep {
  readonly name?: string;
  readonly uses?: string;
  readonly with?: Record<string, unknown>;
}

interface WorkflowJob {
  readonly name?: string;
  readonly uses?: string;
  readonly permissions?: Record<string, string>;
  readonly steps?: readonly WorkflowStep[];
}

interface WorkflowDocument {
  readonly permissions?: Record<string, string>;
  readonly jobs?: Record<string, WorkflowJob>;
}

/**
 * Scopes that no job may ever receive, cataloged or not. The repository's
 * security model keeps the canary path off these capabilities entirely, and
 * the release/weekly jobs have no use for them either.
 */
const NEVER_GRANTED_WRITE_SCOPES: readonly string[] = ["actions", "pull-requests", "security-events"];

interface JobWriteException {
  readonly workflow: string;
  readonly job: string;
  readonly scopes: readonly string[];
  readonly justification: string;
}

/**
 * Reviewed job-level write grants. Anything not listed here must be read-only.
 * Adding an entry is a security decision, so each one records why the job
 * cannot do its work with a narrower token.
 */
const AUDITED_JOB_WRITE_EXCEPTIONS: readonly JobWriteException[] = [
  {
    workflow: "release.yml",
    job: "release",
    scopes: ["attestations", "contents", "id-token"],
    justification:
      "the publish job pushes the floating major tag and the release commit, signs build provenance, and publishes release assets",
  },
  {
    workflow: "weekly-live.yml",
    job: "track-failure",
    scopes: ["issues"],
    justification:
      "the main-only failure tracker (#420) opens, comments on and closes the single weekly-live issue; the job is gated on github.ref == 'refs/heads/main'",
  },
];

interface CheckoutCredentialException {
  readonly workflow: string;
  readonly job: string;
  readonly justification: string;
}

/**
 * Reviewed checkout steps that deliberately keep credentials in the workspace.
 * Everything else must set `persist-credentials: false`.
 */
const AUDITED_CHECKOUT_CREDENTIAL_EXCEPTIONS: readonly CheckoutCredentialException[] = [
  {
    workflow: "release.yml",
    job: "release",
    justification:
      "the publish job needs the repository credentials to push the floating major tag (documented `zizmor: ignore[artipacked]` on the step)",
  },
];

function parseWorkflow(filename: string, content: string): WorkflowDocument {
  const document = parse(content) as WorkflowDocument | null;
  expect(document, `${filename} is not a YAML mapping`).toBeTruthy();
  return document as WorkflowDocument;
}

function getDocumentJobIds(document: WorkflowDocument): string[] {
  return Object.keys(document.jobs ?? {});
}

/**
 * Line number of each job id under the top-level `jobs:` key. Parsed YAML
 * values carry no positions, and a policy failure has to point at the file
 * and line a reviewer can open, so the keys are located positionally.
 */
function getJobLineNumbers(content: string): Map<string, number> {
  const lines = content.split(/\r?\n/);
  const result = new Map<string, number>();
  const jobsIndex = lines.findIndex((line) => /^jobs:\s*$/.test(line));
  if (jobsIndex === -1) {
    return result;
  }
  for (let i = jobsIndex + 1; i < lines.length; i += 1) {
    const line = lines[i] ?? "";
    if (/^\S/.test(line)) {
      break;
    }
    const match = /^ {2}([A-Za-z0-9_-]+):\s*$/.exec(line);
    if (match) {
      result.set(match[1] as string, i + 1);
    }
  }
  return result;
}

/** Line numbers of `uses: actions/checkout` occurrences in [start, end). */
function getCheckoutLineNumbers(content: string, start: number, end: number): number[] {
  const lines = content.split(/\r?\n/);
  const result: number[] = [];
  for (let i = start - 1; i < end - 1 && i < lines.length; i += 1) {
    if (/^\s*(?:-\s+)?uses:\s*actions\/checkout@/.test(lines[i] ?? "")) {
      result.push(i + 1);
    }
  }
  return result;
}

function isWriteScope(value: string | undefined): boolean {
  return value === "write";
}

describe("workflow job-level permissions and checkout credentials (#618)", () => {
  const workflows = getWorkflowFiles().map((workflow) => ({
    ...workflow,
    document: parseWorkflow(workflow.filename, workflow.content),
  }));

  it("catalogs every exception against a workflow and job that still exist", () => {
    for (const exception of AUDITED_JOB_WRITE_EXCEPTIONS) {
      const workflow = workflows.find((entry) => entry.filename === exception.workflow);
      expect(workflow, `write exception names unknown workflow ${exception.workflow}`).toBeTruthy();
      const job = workflow?.document.jobs?.[exception.job];
      expect(job, `write exception names no job ${exception.workflow}#${exception.job}`).toBeTruthy();
      const granted = Object.entries(job?.permissions ?? {})
        .filter(([, value]) => isWriteScope(value))
        .map(([scope]) => scope);
      for (const scope of exception.scopes) {
        expect(
          granted,
          `${exception.workflow}#${exception.job} no longer grants the cataloged '${scope}: write' scope; remove the stale exception`,
        ).toContain(scope);
      }
    }
    for (const exception of AUDITED_CHECKOUT_CREDENTIAL_EXCEPTIONS) {
      const workflow = workflows.find((entry) => entry.filename === exception.workflow);
      expect(workflow, `checkout exception names unknown workflow ${exception.workflow}`).toBeTruthy();
      const job = workflow?.document.jobs?.[exception.job];
      expect(job, `checkout exception names no job ${exception.workflow}#${exception.job}`).toBeTruthy();
      const checkouts = (job?.steps ?? []).filter((step) => step.uses?.startsWith("actions/checkout") === true);
      expect(
        checkouts.length,
        `${exception.workflow}#${exception.job} has no checkout step for its persisted-credentials exception to cover`,
      ).toBeGreaterThan(0);
    }
  });

  describe("job-level permissions", () => {
    for (const { filename, content, document } of workflows) {
      it(`${filename} grants write scopes only through the audited exception list`, () => {
        const jobLines = getJobLineNumbers(content);
        for (const jobId of getDocumentJobIds(document)) {
          const job = document.jobs?.[jobId];
          const line = jobLines.get(jobId) ?? 1;
          const location = `${filename}:${line} (job ${jobId})`;
          const exception = AUDITED_JOB_WRITE_EXCEPTIONS.find(
            (entry) => entry.workflow === filename && entry.job === jobId,
          );

          for (const [scope, value] of Object.entries(job?.permissions ?? {})) {
            if (!isWriteScope(value)) {
              continue;
            }
            expect(
              NEVER_GRANTED_WRITE_SCOPES,
              `${location} must never request '${scope}: write': the canary and release paths have no use for that capability`,
            ).not.toContain(scope);
            expect(
              exception?.scopes ?? [],
              `${location} requests unauthorized '${scope}: write'. Narrow it to read, or add a reviewed entry to AUDITED_JOB_WRITE_EXCEPTIONS with a justification`,
            ).toContain(scope);
          }
        }
      });
    }
  });

  describe("checkout credential persistence", () => {
    for (const { filename, content, document } of workflows) {
      it(`${filename} disables credential persistence on every checkout except cataloged exceptions`, () => {
        const jobLines = getJobLineNumbers(content);
        const jobIds = getDocumentJobIds(document);
        const lineCount = content.split(/\r?\n/).length + 1;
        for (let jobIndex = 0; jobIndex < jobIds.length; jobIndex += 1) {
          const jobId = jobIds[jobIndex] as string;
          const job = document.jobs?.[jobId];
          const start = jobLines.get(jobId) ?? 1;
          const nextJobId = jobIds[jobIndex + 1];
          const end = nextJobId !== undefined ? (jobLines.get(nextJobId) ?? lineCount) : lineCount;
          const checkoutSteps = (job?.steps ?? []).filter(
            (step) => step.uses?.startsWith("actions/checkout") === true,
          );
          if (checkoutSteps.length === 0) {
            continue;
          }

          const exception = AUDITED_CHECKOUT_CREDENTIAL_EXCEPTIONS.find(
            (entry) => entry.workflow === filename && entry.job === jobId,
          );
          if (exception !== undefined) {
            continue;
          }

          const checkoutLines = getCheckoutLineNumbers(content, start, end);
          checkoutSteps.forEach((step, stepIndex) => {
            const line = checkoutLines[stepIndex] ?? start;
            expect(
              step.with?.["persist-credentials"],
              `${filename}:${line} (job ${jobId}) checkout step must set 'persist-credentials: false' so the token never survives in .git/config`,
            ).toBe(false);
          });
        }
      });
    }
  });
});
