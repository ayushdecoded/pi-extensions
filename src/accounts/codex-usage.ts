/**
 * Codex quota-usage adapter: fetch and parse the ChatGPT wham usage payload
 * into stable {@link LimitWindow} records.
 *
 * Pure data handling: the parser never touches the network, and the fetcher
 * takes an already-resolved API key plus provider headers and an injectable
 * fetch. No polling, timers, or coordinator wiring lives here.
 *
 * Payload tolerance mirrors the live API's variations:
 * - top-level `rate_limit`/`rateLimits` (snake or camel) containers;
 * - primary/secondary windows under `primary_window`/`primaryWindow`/`primary`
 *   (and the `secondary_*`/`secondary` equivalents), merged per logical window;
 * - `additional_rate_limits`/`additionalRateLimits` arrays of extra windows;
 * - snake/camel field names for used percent, window length, and reset;
 * - reset instants as epoch seconds, epoch ms, or ISO strings, plus relative
 *   reset-after durations resolved against the fetched timestamp.
 *
 * Fields that cannot be parsed cleanly are omitted rather than guessed, so a
 * malformed percentage or unknown reset never fails the whole fetch and never
 * produces data the accounts store would reject.
 */
import type { ProviderHeaders } from "@earendil-works/pi-ai";
import { codexAuthHeaders } from "../codex-auth.ts";
import type { LimitWindow } from "./types.ts";

/** ChatGPT backend endpoint returning per-account quota windows. */
export const CODEX_USAGE_URL = "https://chatgpt.com/backend-api/wham/usage";

/** Inputs for {@link fetchCodexUsage}. */
export interface CodexUsageFetchInput {
  /** Already-resolved ChatGPT access token for the Codex login. */
  apiKey: string;
  /** Provider-supplied headers (account selection, ...), already resolved. */
  headers?: ProviderHeaders;
  /** Injectable fetch for tests; defaults to the global fetch. */
  fetch?: typeof fetch;
  /** Injectable clock for deterministic fetches; defaults to `Date.now()`. */
  now?: number;
}

/** Stable window names for the primary/secondary rate-limit pair. */
const PRIMARY_WINDOW_NAME = "primary";
const SECONDARY_WINDOW_NAME = "secondary";

/** Accepted field-name variants for each raw window field. */
const USED_PERCENT_KEYS = ["used_percent", "usedPercent"] as const;
const WINDOW_SECONDS_KEYS = [
  "limit_window_seconds",
  "limitWindowSeconds",
  "window_seconds",
  "windowSeconds",
] as const;
const RESET_AT_KEYS = ["reset_at", "resetAt"] as const;
const RESET_AFTER_KEYS = ["reset_after", "resetAfter"] as const;
const LABEL_KEYS = ["name", "label"] as const;

/** Naming variants for each logical window; the `*_window` variant wins on length. */
const PRIMARY_VARIANTS = ["primary_window", "primaryWindow", "primary"] as const;
const SECONDARY_VARIANTS = ["secondary_window", "secondaryWindow", "secondary"] as const;

/**
 * Parse a wham/usage payload into stable {@link LimitWindow} records.
 *
 * `fetchedAt` is injected into every window as `updatedAt` and anchors
 * relative reset-after durations. Returns an empty array for malformed
 * payloads; unparseable fields are omitted, never invented. Window order is
 * deterministic: primary, secondary, then additional windows in payload order.
 */
export function parseCodexUsagePayload(payload: unknown, fetchedAt = Date.now()): LimitWindow[] {
  const fetchedAtMs = typeof fetchedAt === "number" && Number.isFinite(fetchedAt) ? fetchedAt : Date.now();
  const updatedAt = new Date(fetchedAtMs).toISOString();
  const windows: LimitWindow[] = [];
  const usedNames = new Set<string>();
  const root = asRecord(payload);
  if (root === undefined) return windows;

  const rateLimit = firstRecord(root.rate_limit, root.rateLimits);
  if (rateLimit !== undefined) {
    for (const [name, variants] of [
      [PRIMARY_WINDOW_NAME, PRIMARY_VARIANTS],
      [SECONDARY_WINDOW_NAME, SECONDARY_VARIANTS],
    ] as const) {
      const merged = mergeVariants(variants.map((key) => rateLimit[key]));
      const window = parseWindow(merged, { fetchedAtMs, updatedAt, usedNames, fixedName: name });
      if (window !== undefined) windows.push(window);
    }
  }

  const additional = firstArray(root.additional_rate_limits, root.additionalRateLimits);
  if (additional !== undefined) {
    for (const entry of additional) {
      const raw = asRecord(entry);
      if (raw === undefined) continue;
      const window = parseWindow(raw, {
        fetchedAtMs,
        updatedAt,
        usedNames,
        nameFor: (windowSeconds) => windowName(raw, windowSeconds),
      });
      if (window !== undefined) windows.push(window);
    }
  }

  return windows;
}

/**
 * Fetch the Codex quota usage for an already-resolved login and parse it into
 * stable {@link LimitWindow} records.
 *
 * Uses {@link codexAuthHeaders} for the base Bearer/accept/account headers and
 * adds the endpoint-specific Codex beta and originator headers. HTTP errors
 * surface a concise status-only message: response bodies are never read or
 * echoed, so tokens and payloads stay out of error text.
 */
export async function fetchCodexUsage(input: CodexUsageFetchInput): Promise<LimitWindow[]> {
  const { apiKey, headers } = input;
  const fetchFn = input.fetch ?? fetch;
  const response = await fetchFn(CODEX_USAGE_URL, {
    headers: {
      ...codexAuthHeaders(apiKey, headers),
      "OpenAI-Beta": "codex-1",
      originator: "Pi",
    },
  });
  if (!response.ok) {
    throw new Error(`Codex usage request failed: HTTP ${response.status}`);
  }
  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    throw new Error("Codex usage request returned an unparseable body");
  }
  return parseCodexUsagePayload(payload, input.now ?? Date.now());
}

interface ParseWindowContext {
  fetchedAtMs: number;
  updatedAt: string;
  usedNames: Set<string>;
  /** Fixed stable name (primary/secondary), or a name derived from the window. */
  fixedName?: string;
  nameFor?: (windowSeconds: number | undefined) => string;
}

function parseWindow(raw: Record<string, unknown>, ctx: ParseWindowContext): LimitWindow | undefined {
  const usedPercent = parseUsedPercent(raw);
  const windowSeconds = parseWindowSeconds(raw);
  const resetAt = parseResetAt(raw, ctx.fetchedAtMs);
  if (usedPercent === undefined && windowSeconds === undefined && resetAt === undefined) return undefined;
  const name = ctx.fixedName ?? uniqueName(ctx.nameFor?.(windowSeconds) ?? "unlabeled", ctx.usedNames);
  ctx.usedNames.add(name);
  return {
    name,
    ...(usedPercent === undefined ? {} : { usedPercent }),
    ...(windowSeconds === undefined ? {} : { windowSeconds }),
    ...(resetAt === undefined ? {} : { resetAt }),
    updatedAt: ctx.updatedAt,
  };
}

function parseUsedPercent(raw: Record<string, unknown>): number | undefined {
  const n = toFiniteNumber(firstValue(raw, USED_PERCENT_KEYS), /*stripPercentSuffix*/ true);
  if (n === undefined || n < 0 || n > 100) return undefined;
  return n;
}

function parseWindowSeconds(raw: Record<string, unknown>): number | undefined {
  const n = toFiniteNumber(firstValue(raw, WINDOW_SECONDS_KEYS));
  if (n === undefined || n <= 0) return undefined;
  return n;
}

function parseResetAt(raw: Record<string, unknown>, fetchedAtMs: number): string | undefined {
  const at = firstValue(raw, RESET_AT_KEYS);
  const after = firstValue(raw, RESET_AFTER_KEYS);
  let ms = resetAtMilliseconds(at);
  if (ms === undefined) ms = resetAfterMilliseconds(after, fetchedAtMs);
  return ms === undefined ? undefined : new Date(ms).toISOString();
}

/** Absolute reset instants: epoch seconds (10 digits) or epoch ms (13 digits). */
function resetAtMilliseconds(value: unknown): number | undefined {
  if (typeof value === "number") return epochMilliseconds(value);
  if (typeof value !== "string") return undefined;
  const text = value.trim();
  if (/^\d+(\.\d+)?$/.test(text)) return epochMilliseconds(Number(text));
  const parsed = Date.parse(text); // ISO timestamps are accepted defensively
  return Number.isNaN(parsed) ? undefined : parsed;
}

function epochMilliseconds(value: number): number | undefined {
  if (!Number.isFinite(value) || value < 0) return undefined;
  if (value >= 1e11) return value; // epoch milliseconds
  if (value >= 1e8) return value * 1000; // epoch seconds
  return undefined; // too small to be an absolute instant
}

/** Relative resets ("reset after N") resolve against the fetched timestamp. */
function resetAfterMilliseconds(value: unknown, fetchedAtMs: number): number | undefined {
  const seconds = durationSeconds(value);
  if (seconds === undefined) return undefined;
  return fetchedAtMs + seconds * 1000;
}

const DURATION_PATTERN =
  /^(\d+(?:\.\d+)?)\s*(ms|s|sec|secs|second|seconds|m|min|mins|minute|minutes|h|hr|hrs|hour|hours|d|day|days|w|week|weeks)?$/i;

/** Parse a reset-after duration: plain seconds or a suffixed duration string. */
function durationSeconds(value: unknown): number | undefined {
  if (typeof value === "number") return Number.isFinite(value) && value >= 0 ? value : undefined;
  if (typeof value !== "string") return undefined;
  const text = value.trim();
  if (/^\d+(\.\d+)?$/.test(text)) return Number(text);
  const match = DURATION_PATTERN.exec(text);
  if (!match) return undefined;
  const n = Number(match[1]);
  const unit = (match[2] ?? "s").toLowerCase();
  if (unit === "ms") return n / 1000;
  if (unit.startsWith("w")) return n * 7 * 86400;
  if (unit.startsWith("d")) return n * 86400;
  if (unit.startsWith("h")) return n * 3600;
  if (unit.startsWith("m")) return n * 60;
  return n;
}

/** Prefer a supplied human label; otherwise derive one from the window length. */
function windowName(raw: Record<string, unknown>, windowSeconds: number | undefined): string {
  const label = firstStringValue(raw, LABEL_KEYS);
  if (label !== undefined) return label;
  return labelFromWindowSeconds(windowSeconds);
}

/** Stable fallback labels: 5h, weekly, monthly, then compact durations. */
function labelFromWindowSeconds(windowSeconds: number | undefined): string {
  if (windowSeconds === undefined) return "unlabeled";
  if (windowSeconds === 604_800) return "weekly"; // 7 days
  if (windowSeconds === 2_592_000 || windowSeconds === 2_678_400) return "monthly"; // 30 / 31 days
  if (windowSeconds % 3600 === 0) return `${windowSeconds / 3600}h`;
  if (windowSeconds % 60 === 0) return `${windowSeconds / 60}m`;
  return `${windowSeconds}s`;
}

/** Deduplicate names so every window keeps a stable, distinct identifier. */
function uniqueName(base: string, usedNames: Set<string>): string {
  if (!usedNames.has(base)) return base;
  let suffix = 2;
  let candidate = `${base} (${suffix})`;
  while (usedNames.has(candidate)) {
    suffix += 1;
    candidate = `${base} (${suffix})`;
  }
  return candidate;
}

/**
 * Merge the naming variants of one logical window. Window-length fields prefer
 * the `*_window` variant; live fields (used percent, reset) prefer the plain
 * variant (`primary`/`secondary`), which carries the current usage.
 */
function mergeVariants(records: readonly unknown[]): Record<string, unknown> {
  const merged: Record<string, unknown> = {};
  for (const record of records) {
    if (!isRecord(record)) continue;
    for (const [key, value] of Object.entries(record)) {
      if (!(key in merged)) merged[key] = value;
    }
  }
  for (const record of records) {
    if (!isRecord(record)) continue;
    for (const key of [...USED_PERCENT_KEYS, ...RESET_AT_KEYS, ...RESET_AFTER_KEYS]) {
      if (record[key] !== undefined) merged[key] = record[key];
    }
  }
  return merged;
}

function firstValue(raw: Record<string, unknown>, keys: readonly string[]): unknown {
  for (const key of keys) {
    if (raw[key] !== undefined) return raw[key];
  }
  return undefined;
}

function firstStringValue(raw: Record<string, unknown>, keys: readonly string[]): string | undefined {
  for (const key of keys) {
    const value = raw[key];
    if (typeof value === "string" && value.trim() !== "") return value.trim();
  }
  return undefined;
}

function toFiniteNumber(value: unknown, stripPercentSuffix = false): number | undefined {
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
  if (typeof value !== "string") return undefined;
  let text = value.trim();
  if (stripPercentSuffix && text.endsWith("%")) text = text.slice(0, -1).trim();
  if (text === "") return undefined;
  const n = Number(text);
  return Number.isFinite(n) ? n : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return isRecord(value) ? value : undefined;
}

function firstRecord(...values: unknown[]): Record<string, unknown> | undefined {
  for (const value of values) {
    const record = asRecord(value);
    if (record !== undefined) return record;
  }
  return undefined;
}

function firstArray(...values: unknown[]): unknown[] | undefined {
  for (const value of values) {
    if (Array.isArray(value)) return value;
  }
  return undefined;
}
