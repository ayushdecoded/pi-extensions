import assert from "node:assert/strict";
import test from "node:test";
import { initTheme, type Theme } from "@earendil-works/pi-coding-agent";
import { agentRows, formatTokens, renderCompletion } from "../src/subagents/ui.ts";
import { zeroUsage, type AgentRecord, type Report } from "../src/subagents/runtime.ts";

const theme = { fg: (_color: string, text: string) => text, bold: (text: string) => text } as Theme;
const usage = (totalTokens: number) => ({ ...zeroUsage(), totalTokens });

test("formatTokens keeps exact integers below one thousand", () => {
  assert.equal(formatTokens(0), "0 tokens");
  assert.equal(formatTokens(1), "1 tokens");
  assert.equal(formatTokens(999), "999 tokens");
  // Boundary: 999.9 is not a token count, but it must not be promoted to a "k" label.
  assert.equal(formatTokens(999.9), "999 tokens");
});

test("formatTokens compacts thousands and rounds small ones to whole k", () => {
  assert.equal(formatTokens(1_000), "1k tokens");
  assert.equal(formatTokens(4_102), "4k tokens");
  assert.equal(formatTokens(9_999), "10k tokens");
  assert.equal(formatTokens(10_000), "10k tokens");
  assert.equal(formatTokens(12_500), "12.5k tokens");
  assert.equal(formatTokens(100_000), "100k tokens");
  assert.equal(formatTokens(999_949), "999.9k tokens");
});

test("formatTokens compacts millions with one decimal and no trailing .0", () => {
  assert.equal(formatTokens(1_000_000), "1M tokens");
  assert.equal(formatTokens(1_200_000), "1.2M tokens");
  assert.equal(formatTokens(1_250_000), "1.3M tokens");
  assert.equal(formatTokens(2_000_000), "2M tokens");
  assert.equal(formatTokens(15_000_000), "15M tokens");
  assert.equal(formatTokens(15_500_000), "15.5M tokens");
});

test("formatTokens rolls rounded values into the next unit and clamps invalid input", () => {
  assert.equal(formatTokens(999_950), "1M tokens");
  assert.equal(formatTokens(999_999_999), "1B tokens");
  assert.equal(formatTokens(Number.NaN), "0 tokens");
  assert.equal(formatTokens(-100), "0 tokens");
});

test("agent rows and expanded completion cards share the compact token label", () => {
  initTheme("dark", false);
  const report: Report = {
    handle: "atlas-1", agent: "Atlas", runId: "run", status: "completed", text: "Relevant result", usage: usage(4_102), title: "Inspect tokens",
  };
  const record: AgentRecord = {
    handle: "atlas-1", owner: "root", agent: "Atlas", prompt: "", tools: [], model: "test/model", thinking: "high", depth: 1,
    status: "completed", task: "Inspect tokens", runId: "run", background: true, report,
  };
  assert.match(agentRows(record, theme, 120).join("\n"), /4k tokens · \$0\.000/);

  const message = { role: "custom" as const, customType: "subagent-completion", content: "report", display: true, timestamp: Date.now(), details: report };
  const card = renderCompletion(message, { expanded: true, outputPad: 1 }, theme)!;
  assert.match(card.render(120).join("\n"), /4k tokens · \$0\.000/);
});
