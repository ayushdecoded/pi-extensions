import assert from "node:assert/strict";
import { test } from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  COMPACTION_PERCENT,
  registerProactiveCompaction,
  shouldAllowThresholdCompaction,
  shouldCompactActiveTurn,
} from "../src/proactive-compaction.ts";

const context = (percent: number | null, contextWindow = 272_000) => ({
  model: { contextWindow },
  getContextUsage: () => ({ percent }),
}) as any;

test("only active tool-loop turns compact at the 85 percent boundary", () => {
  const toolTurn = { toolResults: [{}] } as any;
  const finalTurn = { toolResults: [] } as any;
  assert.equal(COMPACTION_PERCENT, 85);
  assert.equal(shouldCompactActiveTurn(toolTurn, context(84.9)), false);
  assert.equal(shouldCompactActiveTurn(toolTurn, context(85)), true);
  assert.equal(shouldCompactActiveTurn(finalTurn, context(90)), false);
  assert.equal(shouldCompactActiveTurn(toolTurn, context(null)), false);
});

test("native threshold compaction is deferred until 85 percent for each model window", () => {
  const event = (tokensBefore: number) => ({ preparation: { tokensBefore } }) as any;
  assert.equal(shouldAllowThresholdCompaction(event(230_000), context(0, 272_000)), false);
  assert.equal(shouldAllowThresholdCompaction(event(231_200), context(0, 272_000)), true);
  assert.equal(shouldAllowThresholdCompaction(event(108_800), context(0, 128_000)), true);
});

test("successful proactive compaction queues one hidden continuation", () => {
  const handlers = new Map<string, Function>();
  const sent: Array<{ message: any; options: any }> = [];
  const pi = {
    on(event: string, handler: Function) { handlers.set(event, handler); },
    sendMessage(message: any, options: any) { sent.push({ message, options }); },
  } as unknown as ExtensionAPI;
  registerProactiveCompaction(pi);

  let compactOptions: any;
  const ctx = {
    ...context(85),
    compact(options: any) { compactOptions = options; },
  };
  handlers.get("turn_end")!({ toolResults: [{}] }, ctx);
  assert.ok(compactOptions);
  compactOptions.onComplete({});
  assert.deepEqual(sent, [{
    message: {
      customType: "proactive-compaction-continuation",
      content: "Continue the active task from the compacted context. Do not stop merely because compaction occurred; complete the work that was in progress.",
      display: false,
    },
    options: { triggerTurn: true, deliverAs: "followUp" },
  }]);
});
