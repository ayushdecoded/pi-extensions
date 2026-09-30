import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { type Component, type TUI } from "@earendil-works/pi-tui";
import { FINISHED_TTL_MS, hasWidgetContent, installWidget, widgetLines } from "../src/subagents/ui.ts";
import { Subagents, type AgentRecord, type Status } from "../src/subagents/runtime.ts";

const theme = { fg: (_color: string, text: string) => text, bold: (text: string) => text } as Theme;
const rootRuntime = () => new Subagents("root", async () => { throw new Error("unused"); });

function makeRecord(runtime: Subagents, agent: string, status: Status, finishedAt?: number, owner = runtime.root): AgentRecord {
  const record = runtime.reserve(owner, { agent, depth: owner === runtime.root ? 1 : 2, prompt: "", tools: [], model: "test/model", thinking: "high" }, `${agent} task`, true);
  record.status = status;
  record.startedAt = (finishedAt ?? Date.now()) - 5_000;
  if (finishedAt !== undefined) record.finishedAt = finishedAt;
  return record;
}

test("finished rows show just before expiry and drop at the boundary while running rows never expire", () => {
  const now = 1_000_000_000;
  const runtime = rootRuntime();
  makeRecord(runtime, "Running", "running").startedAt = now - 10_000_000;
  makeRecord(runtime, "Recent", "completed", now - (FINISHED_TTL_MS - 1));
  makeRecord(runtime, "Boundary", "failed", now - FINISHED_TTL_MS);
  makeRecord(runtime, "Old", "cancelled", now - FINISHED_TTL_MS - 1);

  const atNow = widgetLines(runtime, theme, 120, now).join("\n");
  assert.match(atNow, /Running/);
  assert.match(atNow, /Recent/);
  assert.doesNotMatch(atNow, /Boundary/);
  assert.doesNotMatch(atNow, /Old/);
  assert.match(atNow, /1 running · 1 done · 2 stopped/);

  // One tick before the boundary the finished row is still eligible.
  const justBefore = widgetLines(runtime, theme, 120, now - 1).join("\n");
  assert.match(justBefore, /Boundary/);
  assert.doesNotMatch(justBefore, /Old/);
});

test("running rows are prioritized and the visible list is capped at five", () => {
  const now = 500_000;
  const runtime = rootRuntime();
  for (const name of ["Fin1", "Fin2", "Fin3"]) makeRecord(runtime, name, "completed", now - 1_000);
  for (const name of ["Run1", "Run2", "Run3", "Run4"]) makeRecord(runtime, name, "running");

  const lines = widgetLines(runtime, theme, 120, now).join("\n");
  for (const name of ["Run1", "Run2", "Run3", "Run4"]) assert.match(lines, new RegExp(name));
  assert.match(lines, /Fin1/);
  assert.doesNotMatch(lines, /Fin2/);
  assert.doesNotMatch(lines, /Fin3/);
  assert.match(lines, /\+2 more/);
  assert.ok(lines.indexOf("Run1") < lines.indexOf("Fin1"), "running rows should precede finished rows");
});

test("collapsed summary counts every session record even after its row expires", () => {
  const now = 900_000;
  const runtime = rootRuntime();
  runtime.widgetCollapsed = true;
  makeRecord(runtime, "Run", "running");
  makeRecord(runtime, "Done", "completed", now - 1_000);
  makeRecord(runtime, "Stopped", "interrupted", now - 1_000);
  makeRecord(runtime, "Old", "completed", now - FINISHED_TTL_MS);

  const lines = widgetLines(runtime, theme, 100, now);
  assert.equal(lines.length, 1);
  // The expired "Old" row is gone, but its completed handle still counts toward "done".
  assert.match(lines[0], /1 running · 2 done · 1 stopped/);
  assert.match(lines[0], /Alt\+M expand/);
});

test("expired completed handles contribute to summary totals but not rows", () => {
  const now = 300_000;
  const runtime = rootRuntime();
  makeRecord(runtime, "Running", "running");
  makeRecord(runtime, "OldCompleted", "completed", now - FINISHED_TTL_MS - 1);
  makeRecord(runtime, "OldFailed", "failed", now - FINISHED_TTL_MS - 1);

  const lines = widgetLines(runtime, theme, 120, now).join("\n");
  assert.match(lines, /1 running · 1 done · 1 stopped/);
  assert.match(lines, /Running/);
  assert.doesNotMatch(lines, /OldCompleted/);
  assert.doesNotMatch(lines, /OldFailed/);
});

test("a widget that reappears after full expiry keeps historical counts", () => {
  const now = 800_000;
  const runtime = rootRuntime();
  makeRecord(runtime, "OldCompleted", "completed", now - FINISHED_TTL_MS - 1);
  assert.deepEqual(widgetLines(runtime, theme, 100, now), []);

  makeRecord(runtime, "Run", "running");
  const lines = widgetLines(runtime, theme, 100, now).join("\n");
  assert.match(lines, /1 running · 1 done/);
  assert.doesNotMatch(lines, /OldCompleted/);
});

test("historical counts survive a reload snapshot", () => {
  const now = 200_000;
  const runtime = rootRuntime();
  makeRecord(runtime, "Recent", "completed", now - 1_000);
  makeRecord(runtime, "Old", "completed", now - FINISHED_TTL_MS - 1);
  assert.match(widgetLines(runtime, theme, 100, now).join("\n"), /0 running · 2 done/);

  const restored = new Subagents("root", runtime.createChild, runtime.snapshot());
  const lines = widgetLines(restored, theme, 100, now).join("\n");
  assert.match(lines, /0 running · 2 done/);
  assert.match(lines, /Recent/);
  assert.doesNotMatch(lines, /Old/);
});

test("an all-expired widget disappears entirely in both collapsed and expanded modes", () => {
  const now = 42;
  const runtime = rootRuntime();
  makeRecord(runtime, "Done", "completed", now - FINISHED_TTL_MS);
  makeRecord(runtime, "Failed", "failed", now - FINISHED_TTL_MS - 5);
  assert.deepEqual(widgetLines(runtime, theme, 100, now), []);
  runtime.widgetCollapsed = true;
  assert.deepEqual(widgetLines(runtime, theme, 100, now), []);
  assert.equal(hasWidgetContent(runtime, now), false);
});

test("expiring the widget leaves runtime records, handles, and history untouched", () => {
  const now = 1_000;
  const runtime = rootRuntime();
  const done = makeRecord(runtime, "Done", "completed", now - 1_000);
  const before = runtime.snapshot();
  const handles = [...runtime.records.keys()];

  assert.deepEqual(widgetLines(runtime, theme, 100, now + FINISHED_TTL_MS), []);
  assert.deepEqual(runtime.snapshot(), before);
  assert.deepEqual([...runtime.records.keys()], handles);
  assert.equal(runtime.records.get(done.handle)?.finishedAt, now - 1_000);
});

test("a running nested child stays visible with its indent after its ancestor expires", () => {
  const now = 7_000;
  const runtime = rootRuntime();
  const parent = makeRecord(runtime, "Forge", "completed", now - FINISHED_TTL_MS - 1);
  makeRecord(runtime, "Atlas", "running", undefined, parent.handle);

  const lines = widgetLines(runtime, theme, 120, now).join("\n");
  assert.doesNotMatch(lines, /Forge/);
  assert.match(lines, /↳/);
  assert.match(lines, /Atlas/);
});

test("LiveView keeps redrawing until finished rows expire, then falls idle and disposes", (t) => {
  t.mock.timers.enable({ apis: ["setInterval", "Date"], now: 1_000_000 });
  const runtime = rootRuntime();
  makeRecord(runtime, "Done", "completed", Date.now());

  const renders: number[] = [];
  const tui = { requestRender: () => renders.push(Date.now()) } as unknown as TUI;
  let view: (Component & { dispose(): void }) | undefined;
  const ctx = { mode: "tui", ui: { setWidget: (_id: string, factory: (tui: TUI, theme: Theme) => Component & { dispose(): void }) => { view = factory(tui, theme); } } } as unknown as ExtensionContext;

  installWidget(ctx, runtime);
  assert.ok(view, "widget component was created");

  t.mock.timers.tick(FINISHED_TTL_MS - 1_000); // still eligible: each tick refreshes
  const live = renders.length;
  assert.ok(live >= 119, `expected per-second refreshes while live, got ${live}`);

  t.mock.timers.tick(1_000); // reaches the boundary: one last render clears the widget
  const expired = renders.length;
  assert.equal(expired, live + 1);

  t.mock.timers.tick(5_000); // no work and no eligible rows: the loop goes quiet
  assert.equal(renders.length, expired);

  view.dispose();
  t.mock.timers.tick(5_000);
  assert.equal(renders.length, expired, "dispose stops the interval");
});
