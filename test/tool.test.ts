import assert from "node:assert/strict";
import { test } from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import type { AgentsConfig } from "../src/config/agents.ts";
import { createSubagentTool } from "../src/tool.ts";

const config: AgentsConfig = {
  path: "/tmp/.pi/agents.yaml",
  version: 1,
  defaults: { maxDepth: 7, concurrency: 10, timeoutMinutes: 10 },
  roles: [
    {
      name: "Scout",
      description: "Focused exploration",
      model: "provider/model",
      thinking: "medium",
      promptPath: "agents/scout.md",
      promptFile: "/tmp/.pi/agents/scout.md",
      tools: ["read"],
      delegates: [],
    },
    {
      name: "Builder",
      description: "Implementation",
      model: "provider/model",
      thinking: "high",
      promptPath: "agents/builder.md",
      promptFile: "/tmp/.pi/agents/builder.md",
      tools: ["read", "write"],
      delegates: [],
    },
  ],
  presets: [],
};

test("tool schema derives role names and descriptions without exposing runtime depth", () => {
  const tool = createSubagentTool(config, async () => ({ batchId: "batch", runs: [], allRuns: [], durationMs: 0 }));
  const schema = JSON.stringify(tool.parameters);
  assert.match(schema, /Scout/);
  assert.match(schema, /Focused exploration/);
  assert.match(schema, /Builder/);
  assert.match(schema, /Minutes; omit for default, -1 for no timeout/);
  assert.doesNotMatch(schema, /background/i, "nested tools do not expose background execution");
  assert.doesNotMatch(`${tool.description}\n${schema}`, /maxDepth|remaining depth|depth available|smaller positive|maximum timeout|images/i);
});

test("only root tools expose background batches", () => {
  const completion = Promise.resolve({ batchId: "batch", runs: [], allRuns: [], durationMs: 0 });
  const root = createSubagentTool(
    config,
    async () => ({ batchId: "sync", runs: [], allRuns: [], durationMs: 0 }),
    { startBackgroundBatch: () => ({ batchId: "background", completion }) },
  );
  const nested = createSubagentTool(config, async () => ({ batchId: "nested", runs: [], allRuns: [], durationMs: 0 }));

  assert.match(JSON.stringify(root.parameters), /Defaults to true.*aggregate result.*settles/);
  assert.doesNotMatch(JSON.stringify(nested.parameters), /background/i);
});

test("root delegations default to background and background: false waits inline", async () => {
  let resolveCompletion!: (value: any) => void;
  const completion = new Promise<any>((resolve) => { resolveCompletion = resolve; });
  let synchronousCalls = 0;
  const tool = createSubagentTool(
    config,
    async () => {
      synchronousCalls += 1;
      return { batchId: "sync", runs: [], allRuns: [], durationMs: 0 };
    },
    { startBackgroundBatch: () => ({ batchId: "detached", completion }) },
  ) as any;

  const receipt = await tool.execute("call", { agents: [{ role: "Scout", task: "T1" }] }, undefined);
  assert.deepEqual(receipt.details, { background: true, batchId: "detached", status: "started", agentCount: 1 });
  assert.equal(synchronousCalls, 0, "omitting background detaches instead of blocking");

  const synced = await tool.execute("call", { background: false, agents: [{ role: "Scout", task: "T2" }] }, undefined);
  assert.equal(synchronousCalls, 1);
  assert.equal(synced.details.batchId, "sync");
  resolveCompletion({ batchId: "detached", runs: [], allRuns: [], durationMs: 0 });
});

test("root tool cards mark background by default while nested cards stay unmarked", () => {
  const completion = Promise.resolve({ batchId: "b", runs: [], allRuns: [], durationMs: 0 });
  const root = createSubagentTool(
    config,
    async () => ({ batchId: "sync", runs: [], allRuns: [], durationMs: 0 }),
    { startBackgroundBatch: () => ({ batchId: "bg", completion }) },
  ) as any;
  const nested = createSubagentTool(config, async () => ({ batchId: "nested", runs: [], allRuns: [], durationMs: 0 })) as any;
  const theme = { fg: (_color: string, text: string) => text } as any;

  const rootDefault = root.renderCall({ agents: [{ role: "Scout", task: "T" }] }, theme).render(120).join("\n");
  assert.match(rootDefault, /background/);
  const rootBlocking = root.renderCall({ background: false, agents: [{ role: "Scout", task: "T" }] }, theme).render(120).join("\n");
  assert.doesNotMatch(rootBlocking, /background/);
  const nestedCall = nested.renderCall({ agents: [{ role: "Scout", task: "T" }] }, theme).render(120).join("\n");
  assert.doesNotMatch(nestedCall, /background/);
});

test("tool card shows each role and full prompt once without duplicate result metadata", () => {
  const tool = createSubagentTool(config, async () => ({ batchId: "batch", runs: [], allRuns: [], durationMs: 0 })) as any;
  const theme = { fg: (_color: string, text: string) => `\x1b[36m${text}\x1b[0m` };
  const call = tool.renderCall({ agents: [
    { role: "Scout", task: "SECRET FRESH", timeoutMinutes: 3 },
    { agent: "scout-1", task: "SECRET FOLLOWUP" },
  ] }, theme).render(120).join("\n");
  assert.match(call, /Subagents.*2/);
  assert.match(call, /Scout.*SECRET FRESH/s);
  assert.match(call, /Scout.*↻.*SECRET FOLLOWUP/s);
  assert.doesNotMatch(call, /scout-1|follow-up|timeout|thinking|model|tok|cost/i);

  const run = { invocationId: "i", agent: "scout-1", role: "Scout", status: "complete", durationMs: 12_000, usage: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0, total: 1234, cost: 2.5 } };
  const rendered = tool.renderResult({ details: { batchId: "batch", runs: [run], allRuns: [run], durationMs: 12_000 } }, { expanded: false }, theme).render(120).join("\n");
  assert.equal(rendered, "");
  assert.ok(tool.renderCall({ agents: [{ role: "Scout", task: "A long prompt that remains visible to the user" }] }, theme).render(24).every((line: string) => visibleWidth(line) <= 24));
});

test("tool execution keeps prompts out of model-facing results and emits no duplicate live card", async () => {
  const usage = { input: 1, output: 2, cacheRead: 0, cacheWrite: 0, total: 3, cost: 0.01 };
  const run = { invocationId: "i", agent: "scout-1", role: "Scout", status: "complete" as const, durationMs: 600, usage, output: "done" };
  let receivedProgress: unknown;
  const tool = createSubagentTool(config, async (_requests, _signal, progress) => {
    receivedProgress = progress;
    return { batchId: "batch", runs: [run], allRuns: [run], durationMs: 600 };
  }) as any;
  const updates: any[] = [];
  const result = await tool.execute("call", { agents: [{ role: "Scout", task: "SECRET" }] }, undefined, (update: any) => updates.push(update), {});
  assert.equal(receivedProgress, undefined);
  assert.deepEqual(updates, []);
  assert.doesNotMatch(JSON.stringify(result), /SECRET/);
});

test("background execution returns a receipt immediately without awaiting or invoking the synchronous path", async () => {
  let resolveCompletion!: (value: any) => void;
  const completion = new Promise<any>((resolve) => { resolveCompletion = resolve; });
  let synchronousCalls = 0;
  let backgroundRequests: unknown;
  const tool = createSubagentTool(
    config,
    async () => {
      synchronousCalls += 1;
      return { batchId: "sync", runs: [], allRuns: [], durationMs: 0 };
    },
    {
      startBackgroundBatch: (requests) => {
        backgroundRequests = requests;
        return { batchId: "detached", completion };
      },
    },
  ) as any;

  const result = await tool.execute(
    "call",
    { background: true, agents: [{ role: "Scout", task: "Research while the root continues" }] },
    undefined,
  );
  assert.equal(synchronousCalls, 0);
  assert.deepEqual(backgroundRequests, [{ role: "Scout", task: "Research while the root continues" }]);
  assert.deepEqual(result.details, { background: true, batchId: "detached", status: "started", agentCount: 1 });
  assert.match(result.content[0].text, /Results will be delivered automatically.*without polling/);
  resolveCompletion({ batchId: "detached", runs: [], allRuns: [], durationMs: 0 });
});

test("nested tool execution rejects background requests even if schema validation is bypassed", async () => {
  const tool = createSubagentTool(config, async () => ({ batchId: "sync", runs: [], allRuns: [], durationMs: 0 })) as any;
  await assert.rejects(
    tool.execute("call", { background: true, agents: [{ role: "Scout", task: "no" }] }),
    /only in the root session/,
  );
});

test("tool guidance defines bounded empty-slate delegation", () => {
  const tool = createSubagentTool(config, async () => ({ batchId: "batch", runs: [], allRuns: [], durationMs: 0 }));
  const schema = JSON.stringify(tool.parameters);
  assert.match(tool.description, /bounded, verifiable work/);
  assert.match(tool.description, /specialization, independent judgment, or independent parallelism/);
  assert.match(tool.description, /small tasks, and repeated discovery/);
  assert.match(tool.description, /Fresh agents have no context/);
  assert.match(tool.description, /objective, evidence, paths and symbols/);
  assert.match(tool.description, /stop condition/);
  assert.match(tool.description, /share baseline context and assign distinct responsibilities/);
  assert.match(tool.description, /routine execution, inspection, directly verifiable validation/);
  assert.match(tool.description, /do not delegate merely for confirmation or extra confidence/);
  assert.match(tool.description, /intentional verification/);
  assert.match(tool.description, /Resume useful contexts and integrate results yourself/);
  assert.match(schema, /Context, objective, result, and stop condition/);
  assert.match(schema, /New context, objective, result, and stop condition/);
});
