import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import type { Usage } from "@earendil-works/pi-ai";

export const COMPACTION_FALLBACK_TYPE = "codex-compaction-fallback";

/** Lazy summary work has no native compaction entry; account for its durable cache record. */
export function fallbackUsage(entry: SessionEntry): Usage | undefined {
  if (entry.type !== "custom" || entry.customType !== COMPACTION_FALLBACK_TYPE ||
      !entry.data || typeof entry.data !== "object" || !("usage" in entry.data)) return;
  const usage: unknown = entry.data.usage;
  if (!usage || typeof usage !== "object" || Array.isArray(usage) || !("cost" in usage)) return;
  const values = usage as Record<string, unknown>;
  const cost = values.cost;
  if (!cost || typeof cost !== "object" || Array.isArray(cost)) return;
  const fields = ["input", "output", "cacheRead", "cacheWrite", "totalTokens"] as const;
  const costFields = ["input", "output", "cacheRead", "cacheWrite", "total"] as const;
  const costs = cost as Record<string, unknown>;
  if (!fields.every((key) => typeof values[key] === "number" && Number.isFinite(values[key]) && values[key] >= 0) ||
      !costFields.every((key) => typeof costs[key] === "number" && Number.isFinite(costs[key]) && costs[key] >= 0) ||
      (values.reasoning !== undefined && (typeof values.reasoning !== "number" || !Number.isFinite(values.reasoning) || values.reasoning < 0)) ||
      (values.cacheWrite1h !== undefined && (typeof values.cacheWrite1h !== "number" || !Number.isFinite(values.cacheWrite1h) || values.cacheWrite1h < 0))) return;
  return usage as Usage;
}
