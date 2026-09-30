import assert from "node:assert/strict";
import test from "node:test";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { summarizeEntries } from "../src/composer.ts";
import { backgroundSubagentUsage } from "../src/subagents/accounting.ts";
import { STATE_TYPE } from "../src/subagents/runtime.ts";

function usage(input: number, output: number, cacheRead: number, cacheWrite: number, total: number) {
  return {
    input,
    output,
    cacheRead,
    cacheWrite,
    totalTokens: input + output + cacheRead + cacheWrite,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total },
  };
}

let entryId = 0;
function entry(extra: Record<string, unknown>): SessionEntry {
  entryId += 1;
  return { id: `e${entryId}`, parentId: null, timestamp: "2025-01-01T00:00:00.000Z", ...extra } as unknown as SessionEntry;
}

function state(records: unknown[], options: { root?: string; version?: number } = {}): SessionEntry {
  return entry({
    type: "custom",
    customType: STATE_TYPE,
    data: { version: options.version ?? 1, root: options.root ?? "root", records, pending: [] },
  });
}

function record(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { handle: "atlas-1", agent: "Atlas", owner: "root", background: true, status: "completed", runId: "run", task: "task", ...overrides };
}

function reported(overrides: Record<string, unknown>, runId: string, reportUsage = usage(1, 2, 3, 4, 0.5)): Record<string, unknown> {
  const base = record(overrides);
  return { ...base, runId, report: { handle: base.handle, agent: base.agent, runId, status: base.status, text: "", usage: reportUsage } };
}

function assistant(u: ReturnType<typeof usage>): SessionEntry {
  return entry({ type: "message", message: { role: "assistant", usage: u } });
}

function toolResult(u: ReturnType<typeof usage>): SessionEntry {
  return entry({ type: "message", message: { role: "toolResult", usage: u } });
}

test("backgroundSubagentUsage deduplicates repeated snapshots and keeps distinct follow-up run ids", () => {
  const first = reported({ handle: "atlas-1" }, "run-1", usage(10, 1, 0, 0, 0.1));
  const followup = reported({ handle: "atlas-1" }, "run-2", usage(20, 2, 0, 0, 0.2));
  const totals = backgroundSubagentUsage([
    state([first]),
    state([first]), // append-only snapshots repeat the same completion
    state([followup]), // follow-up reuses the handle with a fresh run id
  ]);
  assert.deepEqual(totals, { input: 30, output: 3, cacheRead: 0, cacheWrite: 0, cost: 0.1 + 0.2 });
});

test("backgroundSubagentUsage rejects contradictory or stale reports", () => {
  const completed = reported({}, "done");
  for (const invalid of [
    { ...completed, status: "running" },
    { ...completed, runId: "new-run" },
    { ...completed, handle: "different-handle" },
    reported({ status: "running" }, "running-with-report"),
  ]) {
    assert.equal(backgroundSubagentUsage([state([invalid])]).cost, 0);
  }
});

test("backgroundSubagentUsage counts root-owned background completions but not synchronous work", () => {
  const background = reported({ handle: "bg", background: true }, "run-bg", usage(1, 1, 1, 1, 1));
  const synchronous = reported({ handle: "sync", background: false }, "run-sync", usage(5, 5, 5, 5, 5));
  assert.deepEqual(backgroundSubagentUsage([state([background, synchronous])]), {
    input: 1,
    output: 1,
    cacheRead: 1,
    cacheWrite: 1,
    cost: 1,
  });
});

test("backgroundSubagentUsage excludes nested reports already rolled into the root owner", () => {
  const root = reported({ handle: "forge", owner: "root" }, "run-root", usage(100, 10, 0, 0, 1));
  const nested = reported({ handle: "atlas", owner: "forge" }, "run-nested", usage(7, 7, 7, 7, 7));
  assert.deepEqual(backgroundSubagentUsage([state([root, nested])]), {
    input: 100,
    output: 10,
    cacheRead: 0,
    cacheWrite: 0,
    cost: 1,
  });
});

test("backgroundSubagentUsage includes failed and cancelled reports with positive costs", () => {
  const failed = reported({ status: "failed" }, "run-failed", usage(1, 2, 3, 4, 0.25));
  const cancelled = reported({ handle: "atlas-2", status: "cancelled" }, "run-cancelled", usage(5, 6, 7, 8, 0.5));
  assert.deepEqual(backgroundSubagentUsage([state([failed, cancelled])]), {
    input: 6,
    output: 8,
    cacheRead: 10,
    cacheWrite: 12,
    cost: 0.75,
  });
});

test("backgroundSubagentUsage skips running records that have no matching report", () => {
  const running = record({ status: "running" });
  assert.deepEqual(backgroundSubagentUsage([state([running])]), { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 });
});

test("backgroundSubagentUsage ignores malformed persisted data and unrelated metadata", () => {
  const valid = reported({ handle: "valid" }, "run-valid", usage(1, 1, 1, 1, 1));
  const entries: SessionEntry[] = [
    state([valid]),
    state([record({ report: { runId: "nan", usage: { ...usage(1, 1, 1, 1, 1), input: Number.NaN } } })]),
    state([record({ report: { runId: "infinity", usage: { ...usage(1, 1, 1, 1, 1), output: Number.POSITIVE_INFINITY } } })]),
    state([record({ report: { runId: "negative", usage: { ...usage(1, 1, 1, 1, 1), cacheWrite: -1 } } })]),
    state([record({ report: { runId: "missing-cost", usage: { ...usage(1, 1, 1, 1, 1), cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } } } })]),
    state([record({ report: { runId: "non-numeric-cost", usage: { ...usage(1, 1, 1, 1, 1), cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: "free" } } } })]),
    state([record({ report: { runId: 42, usage: usage(1, 1, 1, 1, 1) } })]),
    state([record({ report: { runId: "no-usage" } })]),
    state([record({})]),
    state([reported({}, "run-foreign", usage(9, 9, 9, 9, 9))], { root: "other" }),
    state([reported({}, "run-old", usage(9, 9, 9, 9, 9))], { version: 2 }),
    state([null, "not-a-record", 42]),
    entry({ type: "custom", customType: STATE_TYPE, data: "not-an-object" }),
    entry({ type: "custom", customType: STATE_TYPE, data: { version: 1, root: "root", records: "not-an-array" } }),
    entry({ type: "custom_message", customType: "subagent-completion", display: true, content: "done", details: { report: valid.report } }),
  ];
  assert.deepEqual(backgroundSubagentUsage(entries), {
    input: 1,
    output: 1,
    cacheRead: 1,
    cacheWrite: 1,
    cost: 1,
  });
});

test("summarizeEntries adds background subagent usage exactly once and leaves the native CH untouched", () => {
  const background = reported({ handle: "bg", background: true }, "run-bg", usage(30, 3, 0, 0, 0.3));
  const synchronous = reported({ handle: "sync", background: false }, "run-sync", usage(50, 50, 50, 50, 5));
  const entries: SessionEntry[] = [
    assistant(usage(100, 10, 900, 0, 1.5)),
    toolResult(usage(5, 6, 7, 8, 0.25)),
    state([background, synchronous]),
    state([background]), // repeated snapshot must not double count
  ];
  const { totals, latestCacheHitRate } = summarizeEntries(entries);
  assert.deepEqual(totals, {
    input: 100 + 5 + 30,
    output: 10 + 6 + 3,
    cacheRead: 900 + 7,
    cacheWrite: 8,
    cost: 1.5 + 0.25 + 0.3,
  });
  assert.equal(latestCacheHitRate, 90);
});

test("summarizeEntries reports background usage across historical snapshots", () => {
  const entries: SessionEntry[] = [
    state([reported({ handle: "a" }, "run-a", usage(10, 0, 0, 0, 0.1))]),
    assistant(usage(1, 0, 0, 0, 0.01)),
    state([reported({ handle: "a" }, "run-a", usage(10, 0, 0, 0, 0.1)), reported({ handle: "b" }, "run-b", usage(20, 0, 0, 0, 0.2))]),
  ];
  const { totals } = summarizeEntries(entries);
  assert.deepEqual(totals, { input: 31, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0.01 + (0.1 + 0.2) });
});
