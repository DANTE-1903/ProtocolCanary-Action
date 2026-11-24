import * as core from "@actions/core";

const MARKER = "<!-- protocol-canary-pr-comment:v1 -->";
const LIMIT = 60_000;

/**
 * Event and repository facts that decide whether and where a pull request
 * comment is posted. All fields come from the workflow run context.
 */
export interface CommentContext {
  /** Triggering event name; a comment is only posted for `pull_request`. */
  eventName: string;
  /** `owner/repo` slug; an empty owner or repo skips posting with a warning. */
  repository: string;
  /** Pull request number; `undefined` skips posting. */
  pullRequest: number | undefined;
  /** True for fork pull requests, which get a read-only token, so posting is skipped. */
  fork: boolean;
  /** Workflow name; with `job` it identifies which comment to update. */
  workflow: string;
  /** Job name; with `workflow` it identifies which comment to update. */
  job: string;
}

/**
 * Builds the pull request comment body from an already-escaped job summary.
 *
 * The body starts with a hidden marker and a `workflow / job` identity comment
 * (CR, LF, `<` and `>` in the identity become spaces) used to find the comment
 * again. Any copy of the marker inside `summary` is neutralised so report text
 * cannot forge it. The result is capped at 60,000 characters: longer summaries
 * are truncated and end with a note pointing to the job summary. Pure; makes
 * no network calls.
 */
export function buildCommentBody(summary: string, workflow: string, job: string): string {
  // The summary renderer already escapes all engine-controlled Markdown.
  // Never let report text forge our hidden identity marker.
  const safe = summary.split(MARKER).join("&lt;!-- protocol-canary-pr-comment:v1 --&gt;");
  const identity = `${workflow} / ${job}`.replace(/[\r\n<>]/g, " ");
  const prefix = `${MARKER}\n<!-- workflow-job: ${identity} -->\n`;
  const suffix = "\n\n_Additional report details omitted to fit the comment limit. See the job summary._";
  return prefix + (prefix.length + safe.length <= LIMIT ? safe : safe.slice(0, LIMIT - prefix.length - suffix.length) + suffix);
}

/**
 * Creates or updates the Action's comment on a pull request. Never throws.
 *
 * Posting is skipped, with an info or warning log, when the event is not
 * `pull_request` or has no PR number, the PR is from a fork, no token is
 * available, or `repository` is not `owner/repo`. Otherwise it scans up to 10
 * pages (100 each) of the PR's issue comments for one written by a Bot that
 * starts with the marker and this workflow/job identity, PATCHes it if found,
 * and POSTs a new comment if not. The token needs permission to write pull
 * request comments (`pull-requests: write`). A non-OK HTTP status on the
 * lookup or any thrown error, and a non-OK status on the write, are reported as
 * a `PR comment not published` warning and never fail the run.
 *
 * @param summary Markdown job summary, passed through {@link buildCommentBody}.
 * @param token GitHub token sent as a bearer token to `api.github.com`.
 * @param context Event and repository facts, see {@link CommentContext}.
 * @param request Fetch implementation, injectable for tests.
 */
export async function postPullRequestComment(
  summary: string,
  token: string | undefined,
  context: CommentContext,
  request: typeof fetch = fetch,
): Promise<void> {
  if (context.eventName !== "pull_request" || context.pullRequest === undefined) {
    core.info("PR comment skipped: not a pull_request event.");
    return;
  }
  if (context.fork) {
    core.info("PR comment skipped: fork pull requests use read-only permissions.");
    return;
  }
  if (!token) {
    core.warning("PR comment skipped: no GitHub token available.");
    return;
  }
  const [owner, repo] = context.repository.split("/");
  if (!owner || !repo) {
    core.warning("PR comment skipped: invalid repository context.");
    return;
  }
  const base = `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;
  const headers = {
    Authorization: `Bearer ${token}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "Content-Type": "application/json",
  };
  const identity = `<!-- workflow-job: ${`${context.workflow} / ${context.job}`.replace(/[\r\n<>]/g, " ")} -->`;
  const body = buildCommentBody(summary, context.workflow, context.job);
  try {
    let existing: { id: number; body?: string } | undefined;
    for (let page = 1; page <= 10 && !existing; page++) {
      const response = await request(`${base}/issues/${context.pullRequest}/comments?per_page=100&page=${page}`, { headers });
      if (!response.ok) throw new Error(`GitHub API HTTP ${response.status}`);
      const comments = (await response.json()) as { id: number; body?: string; user?: { login?: string; type?: string } }[];
      existing = comments.find((comment) => comment.user?.type === "Bot" && comment.body?.startsWith(MARKER + "\n" + identity + "\n"));
      if (comments.length < 100) break;
    }
    const url = existing ? `${base}/issues/comments/${existing.id}` : `${base}/issues/${context.pullRequest}/comments`;
    const response = await request(url, { method: existing ? "PATCH" : "POST", headers, body: JSON.stringify({ body }) });
    if (!response.ok) core.warning(`PR comment not published: GitHub API HTTP ${response.status}`);
  } catch (error) {
    core.warning(`PR comment not published: ${error instanceof Error ? error.message : "GitHub API error"}`);
  }
}
