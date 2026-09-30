import assert from "node:assert/strict";
import test from "node:test";
import { Theme } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { agentRows } from "../src/subagents/ui.ts";
import type { AgentRecord } from "../src/subagents/runtime.ts";

// A minimal semantic theme keeps width tests independent of terminal color probing.
const theme = { fg: (_color: string, text: string) => `\x1b[32m${text}\x1b[0m`, bold: (text: string) => text } as Theme;
test("agent rows fit narrow and wide terminals, Unicode, nested depth, and control characters", () => {
  for (const width of [1, 12, 28, 40, 54, 55, 80, 120]) {
    for (const depth of [1, 2]) {
      const record: AgentRecord = { handle: "test", owner: "root", agent: "Forge", prompt: "", tools: [], model: "test/model", thinking: "high", depth,
        status: "running", task: "Inspect authentication 🔍 日本語", title: "Long title 日本語 🔍".repeat(8), activity: "read\nfile\u001b[31m", background: true, runId: "run", startedAt: Date.now() - 1000 };
      const rows = agentRows(record, theme, width);
      assert.equal(rows.length, 2);
      for (const row of rows) { assert.ok(visibleWidth(row) <= width, `${width}: ${row}`); assert.equal(row.includes("\n"), false); }
    }
  }
});
