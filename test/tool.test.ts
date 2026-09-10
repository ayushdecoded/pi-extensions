import assert from "node:assert/strict";
import { test } from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import type { AgentsConfig } from "../src/config/agents.ts";
import { createSubagentTool, formatPromotedReceipt } from "../src/tool.ts";

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

test("a promoted foreground result is represented as a background receipt", async () => {
  const tool = createSubagentTool(
    config,
    async () => ({ promoted: true, batchId: "batch-7", agentCount: 2 }),
  ) as any;
  const result = await tool.execute("call", { background: false, agents: [{ role: "Scout", task: "T" }] }, undefined);
  assert.deepEqual(result.details, { promoted: true, batchId: "batch-7", agentCount: 2 });
  assert.match(result.content[0].text, /batch-7.*promoted/);
  assert.match(formatPromotedReceipt(result.details), /continue in the background/);
});

test("tool schema derives role names and descriptions without exposing runtime depth", () => {
  const tool = createSubagentTool(config, async () => ({ batchId: "batch", runs: [], allRuns: [], durationMs: 0 }));
  const schema = JSON.stringify(tool.parameters);
  assert.match(schema, /Scout/);
  assert.match(schema, /Focused exploration/);
  assert.match(schema, /Builder/);
  assert.match(schema, /Minutes; omit for default, -1 for no timeout/);
  assert.match(schema, /"minimum":1/);
  assert.match(schema, /"const":-1/);
  assert.match(schema, /non-whitespace text/);
  assert.doesNotMatch(schema, /background/i, "nested tools do not expose background execution");
  assert.doesNotMatch(`${tool.description}\n${schema}`, /maxDepth|remaining depth|depth available|smaller positive|maximum timeout|images/i);
});

test("all-disabled tools expose only current-session controls", async () => {
  const tool = createSubagentTool({ ...config, roles: [] }, async () => {
    throw new Error("fresh launch must not be callable");
  }, { controlAction: () => ({ action: "inspect", target: { all: true }, agents: [], batches: [], truncated: false }) as any });
  const schema = JSON.stringify(tool.parameters);
  assert.match(schema, /inspect/);
  assert.match(schema, /cancel/);
  assert.doesNotMatch(schema, /No enabled roles/);
  const result = await (tool as any).execute("call", { action: "inspect", target: { all: true } });
  assert.equal(result.details.action, "inspect");
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

test("root and nested tools expose unified inspect/cancel controls without background management", async () => {
  const completion = Promise.resolve({ batchId: "batch", runs: [], allRuns: [], durationMs: 0 });
  const control: any = (request: any) => request.action === "inspect"
    ? { action: "inspect", target: request.target, agents: [], batches: [], truncated: false }
    : { action: "cancel", target: request.target, status: "cancelled", scope: "agent", stopped: 1 };
  const root = createSubagentTool(config, async () => ({ batchId: "sync", runs: [], allRuns: [], durationMs: 0 }), {
    startBackgroundBatch: () => ({ batchId: "bg", completion }),
    controlAction: control,
  }) as any;
  const nested = createSubagentTool(config, async () => ({ batchId: "nested", runs: [], allRuns: [], durationMs: 0 }), { controlAction: control }) as any;
  assert.match(JSON.stringify(root.parameters), /inspect/);
  assert.match(JSON.stringify(root.parameters), /cancel/);
  assert.doesNotMatch(JSON.stringify(root.parameters), /background.*batchId/);
  assert.match(JSON.stringify(nested.parameters), /inspect/);
  const result = await nested.execute("call", { action: "inspect", target: { all: true } }, undefined);
  assert.equal(result.details.action, "inspect");
});

test("unified actions reject mixed or malformed shapes and preserve the read-only inspect contract", async () => {
  let called = 0;
  const tool = createSubagentTool(config, async () => ({ batchId: "sync", runs: [], allRuns: [], durationMs: 0 }), {
    controlAction: (request) => { called += 1; return request.action === "inspect" ? { action: "inspect", target: request.target, agents: [], batches: [], truncated: false } : { action: "cancel", target: request.target, status: "not-found", scope: "agent" }; },
  }) as any;
  await assert.rejects(tool.execute("call", { action: "inspect", target: { all: true }, agents: [{ role: "Scout", task: "no" }] }, undefined), /cannot contain agents or background/);
  await assert.rejects(tool.execute("call", { action: "inspect", target: { agent: "a", batch: "b" } }, undefined), /exactly one/);
  await assert.rejects(tool.execute("call", { action: "cancel" }, undefined), /requires exactly one/);
  assert.equal(called, 0);
});

test("background:false rejects steering before accepting follow-ups", async () => {
  let accepted = false;
  const tool = createSubagentTool(config, async () => ({ batchId: "sync", runs: [], allRuns: [], durationMs: 0 }), {
    submitFollowups: () => {
      accepted = true;
      return { followups: [] };
    },
  }) as any;
  await assert.rejects(
    tool.execute("call", { background: false, agents: [{ agent: "scout-1", messages: [{ message: "interrupt", delivery: "steer" }] }] }),
    /cannot be combined with steering/,
  );
  assert.equal(accepted, false);
});

test("queue-only background:false waits for queued outcomes", async () => {
  let resolved = false;
  let release!: () => void;
  const completion = new Promise<any>((resolve) => { release = () => { resolved = true; resolve({ batchId: "queued", runs: [{ role: "Scout", agent: "scout-1", status: "complete", output: "done", durationMs: 1, usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0, cost: 0 } }], allRuns: [], durationMs: 1 }); }; });
  const tool = createSubagentTool(config, async () => ({ batchId: "sync", runs: [], allRuns: [], durationMs: 0 }), {
    submitFollowups: (_requests, detached) => ({ followups: [{ id: "followup-1", agent: "scout-1", delivery: "queue", status: "accepted", state: "queued" }], ...(detached ? {} : { completion }) }),
  }) as any;
  const pending = tool.execute("call", { background: false, agents: [{ agent: "scout-1", messages: [{ message: "continue" }] }] }, undefined);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(resolved, false);
  release();
  const result = await pending;
  assert.match(result.content[0].text, /done/);
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
    { agent: "scout-1", messages: [{ message: "SECRET FOLLOWUP" }] },
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

test("nested guidance explains owned follow-ups and controls", () => {
  const tool = createSubagentTool(config, async () => ({ batchId: "sync", runs: [], allRuns: [], durationMs: 0 }), {
    controlAction: () => ({ action: "inspect", target: { all: true }, agents: [], batches: [], truncated: false }) as any,
  });
  assert.match(tool.description, /existing agents this child spawned/);
  assert.match(tool.description, /only agents and batches owned by this child/);
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

test("inspection formats minutes, activity details and last-message excerpts without empty fields", async () => {
  const tool = createSubagentTool(config, async () => ({ batchId: "unused", runs: [], allRuns: [], durationMs: 0 }), {
    controlAction: (request) => ({
      action: "inspect", target: request.target, truncated: false,
      agents: [
        { agent: "scout-1", role: "Scout", status: "running", elapsedMs: 144_000,
          taskPreview: "Investigate refresh", activity: { tool: "bash", detail: 'rg -n "refresh" src/' },
          lastMessage: "Found two paths", pendingSteering: [], pendingQueue: [{ id: "q1", preview: "Check expiry too" }] },
        { agent: "scout-2", role: "Scout", status: "idle", pendingSteering: [], pendingQueue: [] },
      ],
      batches: [{ batch: "batch-1", status: "running", elapsedMs: 150_000, liveAgents: 1, totalAgents: 2 }],
    }),
  });
  const result = await tool.execute("inspect", { action: "inspect", target: { all: true } }, undefined, undefined, {} as Parameters<typeof tool.execute>[4]);
  const text = result.content.filter((part) => part.type === "text").map((part) => part.text).join("\n");
  assert.match(text, /scout-1 · Scout · running · elapsed=2\.4m/);
  assert.match(text, /activity: bash · rg -n "refresh" src\//);
  assert.match(text, /last_message: Found two paths/);
  assert.match(text, /pending: queue q1: Check expiry too/);
  assert.match(text, /scout-2 · Scout · idle\nbatch-1/);
  assert.match(text, /batch-1 · running · elapsed=2\.5m · 1\/2 live/);
});
