import assert from "node:assert/strict";
import test from "node:test";
import { Subagents, zeroUsage, type Spec } from "../src/subagents/runtime.ts";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}
const spec: Spec = { agent: "Forge", depth: 1, model: "test/fake", thinking: "high", prompt: "", tools: [] };

for (const shutdown of [false, true]) test(`nested background spend survives ${shutdown ? "shutdown" : "parent cancellation"}`, async () => {
  const started = deferred();
  let delivered = 0;
  const runtime: Subagents = new Subagents("root", async record => {
    const gate = deferred();
    let active = false;
    return {
      async prompt() {
        active = true;
        if (record.depth === 1) {
          const child = runtime.reserve(record.handle, { ...spec, agent: "Atlas", depth: 2 }, "nested", true);
          await runtime.start(child, child.task, true);
        } else {
          started.resolve();
          await gate.promise;
        }
      },
      async waitForIdle() {}, async abort() { gate.resolve(); }, dispose() {},
      output: () => "finished", error: () => undefined,
      usage() {
        const usage = zeroUsage();
        if (active) { usage.input = record.depth; usage.totalTokens = record.depth; usage.cost.total = record.depth; }
        return usage;
      },
      async deliver() { delivered++; },
    };
  });
  const parent = runtime.reserve("root", spec, "parent", true);
  const completion = runtime.start(parent, parent.task, true);
  await started.promise;
  if (shutdown) await runtime.close();
  else await runtime.cancel("root", parent.handle);
  const result = await completion;
  assert.equal(result.status, "cancelled");
  assert.equal(result.usage.cost.total, 3, "parent spend plus cancelled Atlas spend");
  assert.equal(result.usage.totalTokens, 3);
  assert.equal(delivered, 0, "usage accounting must not wake an aborted parent");
});
