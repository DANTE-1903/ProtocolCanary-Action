/**
 * Candidate policy for following release download redirects. This remains
 * blocked by D-11 and must not be wired into a runtime redirect path until
 * maintainers approve the exact hosts and rules. The runtime currently
 * rejects every redirect.
 */

import type { URL } from "node:url";
import { isExactGithubApiUrl, parseSafeHttpsUrl } from "./safe-url";

/**
 * Candidate maximum number of redirect hops. Documentation of a proposed
 * limit only: runtime redirect following stays blocked (D-11) and no download
 * path follows redirects, so this is not an active setting.
 */
export const MAX_REDIRECT_HOPS = 3;

/**
 * Candidate exact-match hostname allow-list for redirect sources and targets,
 * based on observed release download hosts (see docs/download-policy.md).
 * Not enforced at runtime: redirects are still rejected outright (D-11), so
 * listing a host here does not authorise following a redirect to it.
 */
export const ALLOWED_REDIRECT_HOSTS = Object.freeze([
  "github.com",
  "release-assets.githubusercontent.com",
] as const);

const OBSERVED_REDIRECTS = Object.freeze([
  Object.freeze({ from: "github.com", to: "release-assets.githubusercontent.com" }),
]);

/** Union of the hostnames in {@link ALLOWED_REDIRECT_HOSTS}. Candidate policy only. */
export type AllowedRedirectHost = (typeof ALLOWED_REDIRECT_HOSTS)[number];

/**
 * Verdict from the candidate policy checks. A result of `allowed: true` is
 * advisory and does not cause any redirect to be followed at runtime.
 */
export interface RedirectHopEvaluation {
  /** Whether the candidate policy would accept the URL or hop. */
  allowed: boolean;
  /** `"allowed"` on acceptance, otherwise a human-readable rejection reason. */
  reason: string;
}

/** Options for {@link getHeadersForUrl}. */
export interface HeadersForUrlOptions {
  /** Optional bearer token, attached only for an exact `api.github.com` URL. */
  token?: string | undefined;
}

/**
 * Returns a raw absolute or protocol-relative URL authority. Backslashes are
 * included because WHATWG parsing treats them as slash separators for special
 * schemes. Relative path/query references have no authority.
 */
interface ParsedAllowedUrl {
  url?: URL;
  reason?: string;
}

/**
 * Parses and validates one absolute URL used by the still-unapproved policy.
 * This is also used for `from`, so both ends of a redirect must meet the same
 * HTTPS, host, port, and userinfo rules.
 */
function parseAllowedUrl(
  rawUrl: string,
  allowedHosts: readonly string[] = ALLOWED_REDIRECT_HOSTS,
): ParsedAllowedUrl {
  const parsed = parseSafeHttpsUrl(rawUrl);
  if (parsed.url === undefined) return { reason: parsed.reason };
  const url = parsed.url;

  const host = url.hostname.toLowerCase();
  if (host.includes(":") || /^\d+\.\d+\.\d+\.\d+$/.test(host)) {
    return { reason: "IP literals not allowed" };
  }
  if (!allowedHosts.includes(host)) {
    return { reason: "host not in allow-list" };
  }
  return { url };
}

/** Validates a source URL without following or authorizing a request. */
export function evaluateDownloadUrl(rawUrl: string): RedirectHopEvaluation {
  const parsed = parseAllowedUrl(rawUrl);
  return parsed.url === undefined
    ? { allowed: false, reason: parsed.reason ?? "invalid source URL" }
    : { allowed: true, reason: "allowed" };
}

/**
 * Evaluate a single proposed redirect hop. Relative and protocol-relative
 * Location values are deliberately rejected until maintainers approve a
 * precise resolution rule under D-11.
 */
export function evaluateRedirectHop(
  from: string,
  to: string,
  hopIndex: number,
): RedirectHopEvaluation {
  if (!Number.isInteger(hopIndex) || hopIndex < 0) {
    return { allowed: false, reason: "hop index must be a non-negative integer" };
  }
  if (hopIndex >= MAX_REDIRECT_HOPS) {
    return { allowed: false, reason: `exceeded maximum redirects (${MAX_REDIRECT_HOPS})` };
  }
  const source = parseAllowedUrl(from);
  if (source.url === undefined) {
    return { allowed: false, reason: `invalid source URL: ${source.reason ?? "invalid URL"}` };
  }
  const protocolRelativeAuthority = /^[\\/]{2}([^\\/?#]*)/.exec(to)?.[1];
  if (protocolRelativeAuthority?.includes("%")) {
    return { allowed: false, reason: "percent-encoded authority not allowed" };
  }
  if (!/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(to)) {
    return { allowed: false, reason: "relative and protocol-relative redirect targets are not allowed" };
  }
  const target = parseAllowedUrl(to);
  if (target.url === undefined) {
    return { allowed: false, reason: `invalid redirect target: ${target.reason ?? "invalid URL"}` };
  }
  const observedHop = OBSERVED_REDIRECTS.some(
    (hop) => hop.from === source.url?.hostname.toLowerCase() && hop.to === target.url?.hostname.toLowerCase(),
  );
  if (!observedHop) {
    return { allowed: false, reason: "redirect source and destination pair has not been observed" };
  }
  return { allowed: true, reason: "allowed" };
}

/**
 * Return headers allowed for a request to the given URL with an optional token.
 * Authorization is ONLY attached for exactly api.github.com and is NEVER
 * forwarded to other hosts.
 */
export function getHeadersForUrl(url: string, options: HeadersForUrlOptions = {}): Record<string, string> {
  const headers: Record<string, string> = {
    "User-Agent": "ProtocolCanary-Action",
    Accept: "application/vnd.github+json",
  };
  try {
    if (
      options.token !== undefined &&
      options.token !== "" &&
      isExactGithubApiUrl(url)
    ) {
      headers.Authorization = `Bearer ${options.token}`;
    }
    // Never attach Authorization to github.com or CDN hosts
  } catch {
    // If URL is invalid, return safe headers without credentials
  }
  return headers;
}
