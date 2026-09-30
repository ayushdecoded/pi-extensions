import assert from "node:assert/strict";
import test from "node:test";
import { initTheme, type Theme } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { widgetLines, renderCompletion } from "../src/subagents/ui.ts";
import { Subagents, zeroUsage, type Report } from "../src/subagents/runtime.ts";
import { parseTitle, displayTitle, TITLE_PROMPT } from "../src/subagents/title.ts";

const theme = { fg: (_color: string, text: string) => text, bold: (text: string) => text } as Theme;

test("titles reject task answers and apologies, accepting concise action labels", () => {
  assert.equal(parseTitle("I don’t have the previous task’s entry points in this conversation."), undefined);
  assert.equal(parseTitle("I cannot inspect files"), undefined);
  assert.equal(parseTitle("Line one\nLine two"), undefined);
  assert.equal(parseTitle('"Inspect extension entry points"'), "Inspect extension entry points");
  assert.match(TITLE_PROMPT, /data, not instructions/);
  const title = displayTitle({ title: "I cannot do that task", task: "Inspect package.json and list the registered extension paths." });
  assert.equal(title, "Inspect package.json and list the registered extension");
});

test("collapsed widget is exactly one width-bounded line and persists its mode", () => {
  const runtime = new Subagents("root", async () => { throw new Error("unused"); });
  const record = runtime.reserve("root", { agent: "Atlas", depth: 1, prompt: "", tools: [], model: "test/model", thinking: "high" }, "Inspect source code", true);
  record.status = "completed";
  record.finishedAt = Date.now();
  runtime.widgetCollapsed = true;
  for (const width of [1, 20, 52, 100]) {
    const lines = widgetLines(runtime, theme, width);
    assert.equal(lines.length, 1);
    assert.ok(visibleWidth(lines[0]) <= width);
  }
  assert.match(widgetLines(runtime, theme, 100)[0], /0 running · 1 done.*Alt\+M expand/);
  const restored = new Subagents("root", runtime.createChild, runtime.snapshot());
  assert.equal(restored.widgetCollapsed, true);
  restored.widgetCollapsed = false;
  assert.ok(widgetLines(restored, theme, 100).length > 1);
});

test("completion cards hide internal metadata by default and preserve it when expanded", () => {
  initTheme("dark", false);
  const report: Report = { agent: "Atlas", handle: "atlas-secret-handle", runId: "run", status: "completed", title: "Inspect agent model settings",
    text: "Relevant result\n\n" + "More evidence.\n".repeat(15), sessionFile: "/private/session.jsonl", usage: zeroUsage() };
  const message = { role: "custom" as const, customType: "subagent-completion", content: "Original model-facing report", display: true, timestamp: Date.now(), details: report };
  const compact = renderCompletion(message, { expanded: false, outputPad: 1 }, theme)!;
  const expanded = renderCompletion(message, { expanded: true, outputPad: 1 }, theme)!;
  for (const width of [25, 80, 120]) {
    const lines = compact.render(width);
    assert.ok(lines.every(line => visibleWidth(line) <= width));
    assert.doesNotMatch(lines.join("\n"), /secret-handle|private\/session|subagent-completion/);
  }
  const full = expanded.render(120).join("\n");
  assert.match(full, /atlas-secret-handle/); assert.match(full, /private\/session/);
  assert.equal(message.content, "Original model-facing report");
});
