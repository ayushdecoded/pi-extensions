import assert from "node:assert/strict";
import { test } from "node:test";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { advanceStateRevision, applyEvent, emptyRuntimeState, SUBAGENT_ENTRY_TYPE } from "../src/runtime/state.ts";
import type { InvocationRecord, Usage } from "../src/runtime/types.ts";
import { footerUsageTotals } from "../src/ui/accounting.ts";
import { costLabel, createFooterController, mainSessionCacheHit, modelLabel, sessionCostColor, tokenLabel } from "../src/ui/footer.ts";

const parentLeaf = assistantEntry("parent-leaf", usage(10, 4, 20, 7, 1));
const parentOther = assistantEntry("parent-other", usage(5, 2, 8, 3, 0.5));
const childLeaf = invocation("child-leaf", usage(30, 6, 50, 9, 2));
const childOther = invocation("child-other", usage(40, 8, 60, 11, 3));

const leafChildEntries = invocationEntries(childLeaf);
const otherChildEntries = invocationEntries(childOther);
const branch = [parentLeaf, ...leafChildEntries];
const entries = [...branch, parentOther, ...otherChildEntries];

test("footer totals combine native and subagent usage once for leaf and complete tree", () => {
  const totals = footerUsageTotals(branch, entries);

  assert.deepEqual(totals.leaf, usage(40, 10, 70, 16, 3));
  assert.deepEqual(totals.tree, usage(85, 20, 138, 30, 6.5));
});

test("cache hit uses ordered main assistant usage only and footer omits aggregate R", () => {
  const withChild = [
    assistantEntry("first", usage(100, 1, 50, 50, 0)),
    ...invocationEntries(invocation("huge-child-cache", usage(0, 0, 10_000, 0, 0))),
    assistantEntry("latest", usage(80, 1, 20, 0, 0)),
  ];
  assert.equal(mainSessionCacheHit(withChild), 20);
  assert.equal(mainSessionCacheHit([assistantEntry("none", usage(100, 1, 0, 0, 0))]), undefined);
  const theme = taggedTheme();
  const label = tokenLabel({ input: 12, output: 3 }, 20, theme);
  assert.match(label, /CH20\.0%/);
  assert.doesNotMatch(label, /R\d/);
});

test("footer costs follow session budget thresholds and model identity remains distinctly spaced", () => {
  const theme = taggedTheme();
  assert.equal(sessionCostColor(14.99), "success");
  assert.equal(sessionCostColor(15), "warning");
  assert.equal(sessionCostColor(24.99), "warning");
  assert.equal(sessionCostColor(25), "error");
  assert.equal(sessionCostColor(50), "error");
  assert.equal(sessionCostColor(50.01), "muted");
  assert.match(costLabel(24.9, 50.1, theme), /↳ \$24\.9<\/warning>    <muted>◆ \$50\.1/);
  const label = modelLabel({ model: { provider: "openai-codex", id: "gpt-5.6-sol" } } as any, "medium", theme);
  assert.match(label, /codex.*  ·  .*gpt-5\.6-sol.*  ·  .*<thinkingMedium>medium/);
});

test("footer reuses accounting reads until session or runtime revision invalidation", () => {
  let branchReads = 0;
  let entryReads = 0;
  let runtimeListener: (() => void) | undefined;
  let branchListener: (() => void) | undefined;
  let footer: any;
  const state = emptyRuntimeState();
  const runtime = {
    state,
    subscribe(listener: () => void) { runtimeListener = listener; return () => {}; },
  } as any;
  const theme = taggedTheme();
  const ctx = {
    mode: "tui",
    model: { provider: "test", id: "model" },
    getContextUsage: () => undefined,
    sessionManager: {
      getBranch: () => { branchReads += 1; return branch; },
      getEntries: () => { entryReads += 1; return entries; },
    },
    ui: {
      setFooter(factory: any) {
        footer = factory(
          { requestRender() {} },
          theme,
          { getGitBranch: () => null, onBranchChange: (listener: () => void) => { branchListener = listener; return () => {}; } },
        );
      },
    },
  } as any;
  const controller = createFooterController({ getThinkingLevel: () => "medium" } as any);
  controller.install(ctx, runtime);

  footer.render(120);
  footer.render(120);
  assert.deepEqual([branchReads, entryReads], [1, 1]);
  runtimeListener?.(); // Activity-only notification: state revision is unchanged.
  footer.render(120);
  assert.deepEqual([branchReads, entryReads], [1, 1]);

  advanceStateRevision(state);
  runtimeListener?.();
  footer.render(120);
  assert.deepEqual([branchReads, entryReads], [2, 2]);
  branchListener?.();
  footer.render(120);
  assert.deepEqual([branchReads, entryReads], [3, 3]);
  controller.requestRender(true);
  footer.render(120);
  assert.deepEqual([branchReads, entryReads], [4, 4]);
  footer.dispose();
  controller.dispose();
});

test("live invocation usage replaces its persisted value rather than double counting", () => {
  const live = emptyRuntimeState();
  const running = { ...childLeaf, usage: usage(35, 7, 55, 10, 2.5), status: "running" as const };
  applyEvent(live, { type: "invocation.queued", invocation: running });

  const totals = footerUsageTotals(branch, entries, live);

  assert.deepEqual(totals.leaf, usage(45, 11, 75, 17, 3.5));
  assert.deepEqual(totals.tree, usage(90, 21, 143, 31, 7));
});

function taggedTheme(): any {
  return { fg: (color: string, text: string) => `<${color}>${text}</${color}>`, bold: (text: string) => `<bold>${text}</bold>` };
}

function usage(input: number, output: number, cacheRead: number, cacheWrite: number, cost: number): Usage {
  return { input, output, cacheRead, cacheWrite, total: input + output + cacheRead + cacheWrite, cost };
}

function invocation(id: string, invocationUsage: Usage): InvocationRecord {
  return {
    id,
    batchId: `batch-${id}`,
    agent: `agent-${id}`,
    role: "Atlas",
    task: "inspect",
    followup: false,
    ordinal: 1,
    depth: 1,
    status: "complete",
    queuedAt: 1,
    finishedAt: 2,
    timeoutMinutes: 10,
    usage: invocationUsage,
  };
}

function invocationEntries(record: InvocationRecord): SessionEntry[] {
  return [
    customEntry(`${record.id}-queued`, { type: "invocation.queued", invocation: { ...record, status: "queued", usage: usage(0, 0, 0, 0, 0) } }),
    customEntry(`${record.id}-finished`, {
      type: "invocation.finished",
      id: record.id,
      status: "complete",
      finishedAt: record.finishedAt!,
      usage: record.usage,
    }),
  ];
}

function assistantEntry(id: string, value: Usage): SessionEntry {
  return {
    id,
    parentId: null,
    timestamp: new Date(0).toISOString(),
    type: "message",
    message: {
      role: "assistant",
      content: [],
      api: "openai-responses",
      provider: "openai-codex",
      model: "test",
      usage: {
        input: value.input,
        output: value.output,
        cacheRead: value.cacheRead,
        cacheWrite: value.cacheWrite,
        totalTokens: value.total,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: value.cost },
      },
      stopReason: "stop",
      timestamp: 0,
    },
  } as unknown as SessionEntry;
}

function customEntry(id: string, data: unknown): SessionEntry {
  return {
    id,
    parentId: null,
    timestamp: new Date(0).toISOString(),
    type: "custom",
    customType: SUBAGENT_ENTRY_TYPE,
    data,
  } as unknown as SessionEntry;
}
