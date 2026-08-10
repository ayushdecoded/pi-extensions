/**
 * Conservative classification of settled assistant/provider failures.
 *
 * Pure functions: no I/O, no provider coupling. Inputs are either a settled pi
 * `AssistantMessage` (stopReason "error" plus errorMessage) or a normalized
 * failure detail record with optional HTTP status/headers and message text.
 *
 * Classification is deliberately conservative:
 * - Auth failures (401/403 and explicit auth text) are never retryable.
 * - Quota/rate-limit is one bucket; exhaustion ("usage limit", billing,
 *   insufficient_quota) is retryable only with explicit retry/reset guidance,
 *   while transient throttles (429, rate limit, remaining: 0) are retryable.
 * - Generic network/5xx failures are transient/retryable but never quota.
 * - Ambiguous failures fall back to "other" and are not retryable without
 *   explicit retry/reset guidance.
 *
 * Standard retry/reset headers (`retry-after`, `x-ratelimit-reset`) and
 * explicit reset timestamps/durations in error text ("resets at <ISO/epoch>",
 * "retry in N seconds") are parsed where defensible and surfaced as absolute
 * epoch-millisecond instants.
 */
import type { AssistantMessage } from "@earendil-works/pi-ai";

export type FailureKind = "quota" | "auth" | "other";

/** Parsed retry/reset guidance. Instants are absolute epoch milliseconds. */
export interface RetryReset {
  /** Do not retry before this instant (Retry-After / "retry in N"). */
  retryAfterMs?: number;
  /** Provider-reported limit-window reset instant (X-RateLimit-Reset / "resets at"). */
  resetAtMs?: number;
}

/** Result of classifying one failure. */
export interface FailureClassification {
  kind: FailureKind;
  /** True when retrying is defensible without user intervention. */
  retryable: boolean;
  /** Present only when the failure carried explicit retry/reset guidance. */
  retry?: RetryReset;
  /** Short stable reason token for diagnostics. */
  reason: string;
}

/** Raw failure shape available before settling into an AssistantMessage. */
export interface ProviderFailureDetails {
  status?: number;
  headers?: Readonly<Record<string, string | readonly string[] | undefined>>;
  message?: string;
}

export type FailureSource = AssistantMessage | ProviderFailureDetails;

type HeaderRecord = NonNullable<ProviderFailureDetails["headers"]>;

/** Explicit auth failures: rejected credentials, missing auth, permissions. */
const AUTH_PATTERN =
  /(?:^|\b)(?:unauthori[sz]ed|invalid.{0,4}(?:api.?key|key|token)|invalid_api_key|authentication.{0,12}(?:failed|error)|access.?denied|forbidden|not.?authenticated|signed.?out|invalid_grant|permission.{0,10}denied)\b/i;

/** Transient throttles: retrying after the throttle lifts is expected to work. */
const RATE_LIMIT_PATTERN = /(?:^|\b)(?:rate.?limit|too many requests|throttl|429|concurrent)\b/i;

/**
 * Plan/account/quota exhaustion: retry is pointless until the window resets or
 * the plan changes. "Rate limit" style phrasing is deliberately excluded.
 */
const EXHAUSTION_PATTERN =
  /(?:^|\b)(?:insufficient_quota|quota.{0,10}(?:exceeded|reached|exhausted)|out of budget|available balance|usage.?limit|(?:usage|plan|daily|monthly|weekly|message)\s+limit.{0,24}(?:reached|exceeded)|free.?tier|free.?usage|billing|budget|go.?usage.?limit|plan.{0,12}(?:limit|exhausted)|out of credits)\b/i;

/** Transport/server transients. Retryable, but never classified as quota. */
const TRANSIENT_PATTERN =
  /(?:^|\b)(?:overloaded|service.?unavailable|server.?error|internal.?error|bad gateway|gateway timeout|network.?error|connection.{0,12}(?:error|refused|lost|reset|closed)|fetch failed|getaddrinfo|ENOTFOUND|EAI_AGAIN|upstream.?connect|reset before headers|socket hang up|timed?.?out|stream ended|http2|ECONNRESET|EPIPE|502|503|504|524)\b/i;

const RETRY_DURATION_PATTERN =
  /(?:retry|try again)\s+(?:after|in|within)\s+(\d+)\s*(ms|seconds?|secs?|s|minutes?|mins?|m|hours?|hrs?|h)?/i;
const RESET_DURATION_PATTERN =
  /reset(?:s|ted)?\s+(?:after|in|within)\s+(\d+)\s*(ms|seconds?|secs?|s|minutes?|mins?|m|hours?|hrs?|h)?/i;
const RESET_AT_PATTERN =
  /(?:reset(?:s|ted)?\s+(?:at|to|on)|until)\s+(\d{4}-\d{2}-\d{2}[T\s][\d:.]+(?:Z|[+-]\d{2}:?\d{2})?)/i;
const RESET_EPOCH_PATTERN = /reset(?:s|ted)?\s+at\s+(\d{10,13})/i;

/**
 * Parse a `Retry-After` header value into an absolute epoch-ms instant.
 * Accepts delta-seconds ("30") or an HTTP-date; undefined when unparseable.
 */
export function parseRetryAfterHeader(
  value: string | readonly string[] | undefined,
  now = Date.now(),
): number | undefined {
  const raw = firstValue(value);
  if (raw === undefined) return undefined;
  const v = raw.trim();
  if (/^\d+$/.test(v)) return now + Number(v) * 1000;
  const parsed = Date.parse(v);
  return Number.isNaN(parsed) ? undefined : parsed;
}

/**
 * Parse an `X-RateLimit-Reset` header value into an absolute epoch-ms instant.
 * Delta-seconds, epoch-seconds, and epoch-ms forms are all recognized.
 */
export function parseRateLimitResetHeader(
  value: string | readonly string[] | undefined,
  now = Date.now(),
): number | undefined {
  const raw = firstValue(value);
  if (raw === undefined) return undefined;
  const v = Number(raw.trim());
  if (!Number.isFinite(v)) return undefined;
  if (v >= 1e11) return v; // epoch milliseconds
  if (v >= 1e8) return v * 1000; // epoch seconds
  return now + v * 1000; // delta seconds
}

/** Classify a settled failure. `now` is injectable for deterministic tests. */
export function classifyFailure(source: FailureSource, now = Date.now()): FailureClassification {
  if (isAssistantMessage(source)) {
    if (source.stopReason !== "error") return { kind: "other", retryable: false, reason: "not-error" };
  }
  const { status, headers, message } = normalize(source);
  const text = message ?? "";
  const retry = mergeRetry(parseHeaderRetry(headers, now), parseTextRetry(text, now));
  const hasGuidance = retry.retryAfterMs !== undefined || retry.resetAtMs !== undefined;
  const guidance = hasGuidance ? { retry } : {};

  const authText = AUTH_PATTERN.test(text);
  const isExhaustion = EXHAUSTION_PATTERN.test(text);
  const isRateLimitText = RATE_LIMIT_PATTERN.test(text);
  const headerLimited = headerRateLimited(headers);

  if (authText) return { kind: "auth", retryable: false, reason: "auth", ...guidance };
  if (isExhaustion) {
    return { kind: "quota", retryable: hasGuidance, reason: "quota-exhaustion", ...guidance };
  }
  if (status === 429 || headerLimited || isRateLimitText) {
    return { kind: "quota", retryable: true, reason: "rate-limit", ...guidance };
  }
  if (status === 401 || status === 403) {
    return { kind: "auth", retryable: false, reason: "auth", ...guidance };
  }
  if ((status !== undefined && status >= 500) || TRANSIENT_PATTERN.test(text)) {
    return { kind: "other", retryable: true, reason: "transient", ...guidance };
  }
  return { kind: "other", retryable: hasGuidance, reason: "other", ...guidance };
}

/** Convenience: classify a settled assistant message. */
export function classifyAssistantMessage(message: AssistantMessage, now = Date.now()): FailureClassification {
  return classifyFailure(message, now);
}

/** Convenience: classify an arbitrary thrown value, extracting status/headers. */
export function classifyError(error: unknown, now = Date.now()): FailureClassification {
  return classifyFailure(errorDetails(error), now);
}

function isAssistantMessage(source: FailureSource): source is AssistantMessage {
  return typeof source === "object" && source !== null && "stopReason" in source;
}

function normalize(source: FailureSource): ProviderFailureDetails {
  if (isAssistantMessage(source)) {
    return { status: extractStatusFromText(source.errorMessage), message: source.errorMessage };
  }
  return {
    status: source.status ?? extractStatusFromText(source.message),
    headers: source.headers,
    message: source.message,
  };
}

function errorDetails(error: unknown): ProviderFailureDetails {
  if (error instanceof Error) {
    const err = error as Error & { status?: unknown; statusCode?: unknown; headers?: unknown };
    const status =
      typeof err.status === "number" ? err.status : typeof err.statusCode === "number" ? err.statusCode : undefined;
    const headers = isHeaderRecord(err.headers) ? err.headers : undefined;
    return { status, headers, message: err.message };
  }
  return { message: typeof error === "string" ? error : String(error) };
}

function isHeaderRecord(value: unknown): value is HeaderRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function headerValue(headers: HeaderRecord | undefined, name: string): string | undefined {
  if (!headers) return undefined;
  const target = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() !== target) continue;
    if (value === undefined) return undefined;
    return Array.isArray(value) ? String(value[0]) : String(value);
  }
  return undefined;
}

function parseHeaderRetry(headers: HeaderRecord | undefined, now: number): RetryReset {
  const retry: RetryReset = {};
  const retryAfter = parseRetryAfterHeader(headerValue(headers, "retry-after"), now);
  if (retryAfter !== undefined) retry.retryAfterMs = retryAfter;
  const reset = parseRateLimitResetHeader(headerValue(headers, "x-ratelimit-reset"), now);
  if (reset !== undefined) retry.resetAtMs = reset;
  return retry;
}

function headerRateLimited(headers: HeaderRecord | undefined): boolean {
  const remaining = headerValue(headers, "x-ratelimit-remaining");
  return remaining !== undefined && String(remaining).trim() === "0";
}

function parseTextRetry(message: string, now: number): RetryReset {
  const retry: RetryReset = {};
  const duration = RETRY_DURATION_PATTERN.exec(message);
  if (duration) {
    const ms = durationToMs(duration[1], duration[2]);
    if (ms !== undefined) retry.retryAfterMs = now + ms;
  }
  const resetIn = RESET_DURATION_PATTERN.exec(message);
  if (resetIn) {
    const ms = durationToMs(resetIn[1], resetIn[2]);
    if (ms !== undefined) retry.resetAtMs = now + ms;
  }
  const iso = RESET_AT_PATTERN.exec(message);
  if (iso) {
    const t = Date.parse(iso[1].replace(" ", "T"));
    if (!Number.isNaN(t)) retry.resetAtMs = t;
  }
  const epoch = RESET_EPOCH_PATTERN.exec(message);
  if (epoch && retry.resetAtMs === undefined) {
    const v = Number(epoch[1]);
    if (Number.isFinite(v)) retry.resetAtMs = v >= 1e12 ? v : v * 1000;
  }
  return retry;
}

function mergeRetry(a: RetryReset, b: RetryReset): RetryReset {
  const retry: RetryReset = {};
  if (a.retryAfterMs !== undefined) retry.retryAfterMs = a.retryAfterMs;
  if (b.retryAfterMs !== undefined && retry.retryAfterMs === undefined) retry.retryAfterMs = b.retryAfterMs;
  if (a.resetAtMs !== undefined) retry.resetAtMs = a.resetAtMs;
  if (b.resetAtMs !== undefined && retry.resetAtMs === undefined) retry.resetAtMs = b.resetAtMs;
  return retry;
}

function durationToMs(value: string, unit: string | undefined): number | undefined {
  const n = Number(value);
  if (!Number.isFinite(n)) return undefined;
  const u = (unit ?? "s").toLowerCase();
  if (u === "ms") return n;
  if (u.startsWith("h")) return n * 3_600_000;
  if (u.startsWith("m")) return n * 60_000;
  return n * 1000; // seconds default
}

function firstValue(value: string | readonly string[] | undefined): string | undefined {
  if (value === undefined) return undefined;
  return Array.isArray(value) ? String(value[0]) : String(value);
}

/**
 * Conservative HTTP status extraction from formatted error text: only labeled
 * ("status: 429", "HTTP 500"), parenthesized ("(401)"), or leading ("429: ...")
 * statuses are recognized, so stray numbers in messages never count.
 */
function extractStatusFromText(text: string | undefined): number | undefined {
  if (!text) return undefined;
  const labeled = /(?:status|code|http)\s*[:=]?\s*(4\d\d|5\d\d)\b/i.exec(text);
  if (labeled) return Number(labeled[1]);
  const paren = /\((4\d\d|5\d\d)\)/.exec(text);
  if (paren) return Number(paren[1]);
  const start = /^(4\d\d|5\d\d)(?:[\s:.\-]|$)/.exec(text.trim());
  if (start) return Number(start[1]);
  return undefined;
}
