import assert from "node:assert/strict";
import { test } from "node:test";
import type { SessionEntry, Theme } from "@earendil-works/pi-coding-agent";
import {
  BREAKDOWN_MESSAGE_TYPE,
  BreakdownPanel,
  buildBreakdownDetails,
  collectModelShares,
  formatBreakdownContent,
  mergeModelShares,
} from "../src/ui/breakdown.ts";

type UsageShape = {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cost: { total: number };
};

function assistantEntry(id: string, provider: string, model: string, usage: UsageShape): SessionEntry {
  return {
    type: "message",
    id,
    parentId: null,
    timestamp: "2026-01-01T00:00:00.000Z",
    message: {
      role: "assistant",
      content: [{ type: "text", text: "ok" }],
      api: "openai-completions",
      provider,
      model,
      usage,
      stopReason: "stop",
      timestamp: 1,
    },
  } as unknown as SessionEntry;
}

const usage = (input: number, output: number, cacheRead: number, cacheWrite: number, cost: number): UsageShape => ({
  input,
  output,
  cacheRead,
  cacheWrite,
  cost: { total: cost },
});

function sampleDetails() {
  return buildBreakdownDetails(
    mergeModelShares(
      collectModelShares([
        assistantEntry("a", "opencode-go", "deepseek-v4-flash", usage(100, 20, 0, 0, 0.25)),
        assistantEntry("b", "opencode-go", "deepseek-v4-flash", usage(50, 10, 0, 0, 0.15)),
      ]),
      collectModelShares([assistantEntry("c", "openai-codex", "gpt-5.6-sol", usage(200, 40, 0, 0, 1.6))]),
    ),
  );
}

function ansiTheme(): Theme {
  const code = (color: string): string => ({
    success: "32", warning: "33", error: "31", accent: "35", dim: "2", muted: "90", text: "37", borderMuted: "90",
  })[color] ?? "37";
  return {
    fg: (color: string, text: string) => `\x1b[${code(color)}m${text}\x1b[0m`,
    bold: (text: string) => `\x1b[1m${text}\x1b[0m`,
  } as unknown as Theme;
}

function plain(lines: string[]): string {
  return lines.map((line) => line.replace(/\x1b\[[0-9;]*m/g, "")).join("\n");
}

test("collectModelShares buckets assistant usage per canonical provider/model and skips other roles", () => {
  const entries = [
    assistantEntry("a", "opencode-go", "deepseek-v4-flash", usage(100, 20, 300, 10, 0.5)),
    assistantEntry("b", "opencode-go", "deepseek-v4-flash", usage(50, 10, 100, 5, 0.2)),
    assistantEntry("c", "openai-codex", "gpt-5.6-sol", usage(200, 40, 0, 0, 1.1)),
    { type: "message", id: "u", parentId: null, timestamp: "x", message: { role: "user", content: "hi", timestamp: 1 } } as unknown as SessionEntry,
    { type: "custom", id: "cst", customType: "pi-subagents", parentId: null, timestamp: "x", data: {} } as unknown as SessionEntry,
  ];
  const shares = collectModelShares(entries);

  assert.equal(shares.size, 2);
  const flash = shares.get("opencode-go/deepseek-v4-flash")!;
  assert.deepEqual(flash, {
    provider: "opencode-go",
    model: "deepseek-v4-flash",
    calls: 2,
    tokens: 100 + 20 + 300 + 10 + 50 + 10 + 100 + 5,
    input: 150,
    output: 30,
    cache: 415,
    cost: 0.7,
  });
  assert.equal(shares.get("openai-codex/gpt-5.6-sol")!.calls, 1);
});

test("plan account aliases collapse onto the canonical provider", () => {
  const shares = collectModelShares([
    assistantEntry("a", "plan:opencode-go:0123456789abcdef", "deepseek-v4-flash", usage(10, 10, 0, 0, 0.1)),
    assistantEntry("b", "opencode-go", "deepseek-v4-flash", usage(20, 20, 0, 0, 0.2)),
  ]);
  assert.equal(shares.size, 1);
  assert.ok(Math.abs(shares.get("opencode-go/deepseek-v4-flash")!.cost - 0.3) < 1e-9);
});

test("mergeModelShares sums overlapping models across sources", () => {
  const left = collectModelShares([assistantEntry("a", "opencode-go", "deepseek-v4-flash", usage(10, 0, 0, 0, 1))]);
  const right = collectModelShares([assistantEntry("b", "opencode-go", "deepseek-v4-flash", usage(0, 20, 0, 0, 2))]);
  const merged = mergeModelShares(left, right);
  assert.equal(merged.size, 1);
  assert.equal(merged.get("opencode-go/deepseek-v4-flash")!.tokens, 30);
  assert.equal(merged.get("opencode-go/deepseek-v4-flash")!.cost, 3);
});

test("buildBreakdownDetails sorts by cost and computes shares plus totals", () => {
  const shares = mergeModelShares(
    collectModelShares([assistantEntry("a", "opencode-go", "deepseek-v4-flash", usage(800, 0, 0, 0, 0.3))]),
    collectModelShares([assistantEntry("b", "openai-codex", "gpt-5.6-sol", usage(200, 0, 0, 0, 0.7))]),
  );
  const details = buildBreakdownDetails(shares);

  assert.deepEqual(details.rows.map((row) => row.model), ["gpt-5.6-sol", "deepseek-v4-flash"]);
  assert.equal(details.totals.tokens, 1000);
  assert.equal(details.totals.cost, 1);
  assert.equal(details.totals.calls, 2);
  assert.equal(details.rows[0]!.costShare, 70);
  assert.equal(details.rows[1]!.tokenShare, 80);
});

test("formatBreakdownContent renders aligned ASCII bars with shares and token mix", () => {
  const details = buildBreakdownDetails(
    collectModelShares([
      assistantEntry("a", "opencode-go", "deepseek-v4-flash", usage(1_000_000, 200_000, 100_000, 50_000, 0.42)),
    ]),
  );
  const content = formatBreakdownContent(details);

  assert.match(content, /Cost & tokens by model · whole session/);
  assert.match(content, /1\. opencode-go\/deepseek-v4-flash\s+· 1 call/);
  assert.match(content, /cost\s+[█░]+\s+\$0\.42\s+100\.0%/);
  assert.match(content, /tokens\s+[█░]+\s+1\.4M\s+100\.0%\s+↑1\.0M ↓200\.0k ⚡150\.0k/);
  assert.match(content, /total\s+1\.4M\s+\$0\.42\s+1 call/);
});

test("the pane renders a clean aligned layout with header, totals, and footer", () => {
  const details = sampleDetails();
  const panel = new BreakdownPanel(
    details,
    { terminal: { rows: 24 } } as any,
    ansiTheme(),
    { matches: () => false } as any,
    () => {},
  );
  const lines = panel.render(100);
  const text = plain(lines);

  assert.equal(lines.length, 22, "header + body + footer fill the viewport height");
  assert.match(text, /Cost & tokens by model · whole session\s+420 tokens · \$2\.00/);
  assert.match(lines[1]!, /─+/);
  assert.match(text, /1\.\s+openai-codex\/gpt-5\.6-sol\s+· 1 call/);
  assert.match(text, /cost\s+[█░]+\s+\$1\.60\s+80\.0%/);
  assert.match(text, /tokens\s+[█░]+\s+240\s+57\.1%\s+↑200 ↓40 ⚡0/);
  assert.match(text, /2\.\s+opencode-go\/deepseek-v4-flash\s+· 2 calls/);
  assert.match(text, /cost\s+[█░]+\s+\$0\.40\s+20\.0%/);
  // Numeric columns line up across rows: the cost value starts at the same column.
  const costValues = text.split("\n").filter((line) => /^\s+cost\s+█/.test(line)).map((line) => line.indexOf("$"));
  assert.equal(new Set(costValues).size, 1, "cost values share one column");
  const footer = lines[lines.length - 1]!;
  assert.match(plain([footer]), /↑↓ scroll · Esc close/);
  assert.match(plain([footer]), /TOTAL.*3 calls.*420 tokens.*\$2\.00/);
  // Cost bar for the leading model is tinted green (below $2).
  assert.match(lines[4]!, /\x1b\[32m█/);
});

test("the pane scrolls when rows exceed the viewport and clamps at the end", () => {
  const rows = Array.from({ length: 8 }, (_, index) =>
    assistantEntry(`m${index}`, "opencode-go", `model-${index}`, usage(10, 0, 0, 0, index + 1)),
  );
  const details = buildBreakdownDetails(collectModelShares(rows));
  const panel = new BreakdownPanel(
    details,
    { terminal: { rows: 12 }, requestRender: () => {} } as any,
    ansiTheme(),
    { matches: () => false } as any,
    () => {},
  );

  // 8 blocks × 4 lines = 32 body lines; viewport body is ~6 lines.
  let lines = panel.render(80);
  assert.match(plain(lines), /^\s+1\.\s/m);
  assert.doesNotMatch(plain(lines), /^\s+8\.\s/m);

  panel.handleInput("\x1b[F");
  lines = panel.render(80);
  assert.match(plain(lines), /^\s+8\.\s/m);
  assert.doesNotMatch(plain(lines), /^\s+1\.\s/m);
});

test("the pane closes on escape and cancels via the done callback", () => {
  let closed = 0;
  const panel = new BreakdownPanel(
    sampleDetails(),
    { terminal: { rows: 24 } } as any,
    ansiTheme(),
    { matches: (data: string, binding: string) => binding === "tui.select.cancel" && data === "\x1b" } as any,
    () => { closed += 1; },
  );
  panel.handleInput("\x1b");
  assert.equal(closed, 1);
});
