import type { Usage } from "@earendil-works/pi-ai";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { STATE_TYPE } from "./runtime.ts";

/** The slices of the composer footer totals that background subagents contribute. */
export interface BackgroundUsageTotals {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cost: number;
}

export function emptyBackgroundUsage(): BackgroundUsageTotals {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };
}

function finiteNonNegative(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

/** Persisted usage is authoritative only when every numeric field is a finite, non-negative number. */
function isUsage(value: unknown): value is Usage {
  if (typeof value !== "object" || value === null) return false;
  const usage = value as Record<string, unknown>;
  if (!["input", "output", "cacheRead", "cacheWrite", "totalTokens"].every(key => finiteNonNegative(usage[key]))) return false;
  const cost = usage.cost;
  if (typeof cost !== "object" || cost === null) return false;
  const fields = cost as Record<string, unknown>;
  return ["input", "output", "cacheRead", "cacheWrite", "total"].every(key => finiteNonNegative(fields[key]));
}

/**
 * A record contributes only when it is a completed root-owned background invocation. Nested work is
 * already folded into its root owner's report, and synchronous work is counted natively from the
 * tool result the parent received.
 */
function rootBackgroundReport(record: unknown, root: string): { runId: string; usage: Usage } | undefined {
  if (typeof record !== "object" || record === null) return undefined;
  const candidate = record as Record<string, unknown>;
  if (candidate.owner !== root || candidate.background !== true) return undefined;
  const report = candidate.report;
  if (typeof report !== "object" || report === null) return undefined;
  const { runId, usage, handle, status } = report as Record<string, unknown>;
  if (typeof candidate.handle !== "string" || !candidate.handle || handle !== candidate.handle) return undefined;
  if (typeof status !== "string" || !["completed", "failed", "cancelled", "interrupted"].includes(status) || status !== candidate.status) return undefined;
  if (typeof runId !== "string" || runId.length === 0 || runId !== candidate.runId || !isUsage(usage)) return undefined;
  return { runId, usage };
}

/**
 * Accounting scope: sum the usage of completed root-owned background subagent invocations stored in
 * immutable `subagents-state-v1` snapshot entries.
 *
 * Every state entry is scanned, so sessions written before this integration still produce
 * retroactive totals. Results are deduplicated by `report.runId` because snapshots are appended
 * repeatedly and follow-ups reuse a handle while creating a fresh run id. Nested background usage is
 * already rolled into the root owner's report and is never added separately; synchronous subagent
 * usage is counted natively from the parent tool result; running invocations have no report and are
 * skipped. Malformed records and unknown snapshot versions contribute nothing.
 */
export function backgroundSubagentUsage(entries: readonly SessionEntry[]): BackgroundUsageTotals {
  const totals = emptyBackgroundUsage();
  const seen = new Set<string>();
  for (const entry of entries) {
    if (entry.type !== "custom" || entry.customType !== STATE_TYPE) continue;
    const snapshot = entry.data;
    if (typeof snapshot !== "object" || snapshot === null) continue;
    const { version, root, records } = snapshot as Record<string, unknown>;
    if (version !== 1 || typeof root !== "string" || !Array.isArray(records)) continue;
    for (const record of records) {
      const report = rootBackgroundReport(record, root);
      if (!report || seen.has(report.runId)) continue;
      seen.add(report.runId);
      totals.input += report.usage.input;
      totals.output += report.usage.output;
      totals.cacheRead += report.usage.cacheRead;
      totals.cacheWrite += report.usage.cacheWrite;
      totals.cost += report.usage.cost.total;
    }
  }
  return totals;
}
