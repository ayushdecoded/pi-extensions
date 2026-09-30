import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Value } from "typebox/value";
import type { ExtensionToolContext } from "@earendil-works/pi-coding-agent";
import { bundledConfig, readConfig, loadConfig, type Config } from "../src/subagents/config.ts";
import { Subagents, canDelegate, zeroUsage, type AgentRecord, type Child, type Report, type Spec, type Snapshot } from "../src/subagents/runtime.ts";
import { createSubagentTool } from "../src/subagents/tool.ts";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}
const spec = (agent = "Atlas", depth = 1): Spec => ({ agent, depth, prompt: "Role prompt", model: "test/model", thinking: "high", tools: ["read"] });
const tick = () => new Promise<void>(resolve => setImmediate(resolve));
function fixture() {
  const gates = new Map<string, ReturnType<typeof deferred>>();
  const disposed: string[] = [];
  const delivered: Report[] = [];
  const saves: Snapshot[] = [];
  const runtime = new Subagents("root", async record => {
    const gate = deferred(); gates.set(record.handle, gate);
    return {
      prompt: () => gate.promise, waitForIdle: async () => {}, abort: async () => { gate.resolve(); },
      dispose: () => { disposed.push(record.handle); }, output: () => `Answer for ${record.task}`, error: () => undefined,
      usage: zeroUsage, deliver: async () => {},
    } satisfies Child;
  });
  runtime.attach({ save: state => { saves.push(state); }, deliver: report => { delivered.push(report); } });
  return { runtime, gates, disposed, delivered, saves };
}

test("background agents finish and deliver independently, in completion order", async () => {
  const f = fixture();
  const a = f.runtime.reserve("root", spec(), "slow", true);
  const b = f.runtime.reserve("root", spec("Forge"), "fast", true);
  const pa = f.runtime.start(a, a.task, true); const pb = f.runtime.start(b, b.task, true);
  await tick();
  f.gates.get(b.handle)!.resolve(); await pb;
  assert.deepEqual(f.delivered.map(r => r.handle), [b.handle]);
  assert.equal(f.runtime.jobs.has(a.handle), true);
  f.gates.get(a.handle)!.resolve(); await pa;
  assert.deepEqual(f.delivered.map(r => r.handle), [b.handle, a.handle]);
  assert.equal(f.runtime.jobs.size, 0);
});

test("reload detaches delivery without stopping work; completion drains once on rebind", async () => {
  const f = fixture();
  const a = f.runtime.reserve("root", spec(), "task", true);
  const p = f.runtime.start(a, a.task, true);
  await tick();
  f.runtime.detach();
  assert.equal(f.disposed.length, 0);
  f.gates.get(a.handle)!.resolve(); await p;
  assert.equal(f.delivered.length, 0);
  assert.equal(f.runtime.snapshot().pending.length, 1);
  const after: Report[] = [];
  f.runtime.attach({ save() {}, deliver(report) { after.push(report); } });
  f.runtime.attach({ save() {}, deliver(report) { after.push(report); } });
  assert.equal(after.length, 1);
});

test("follow-ups preserve settings, reject busy handles, and get distinct run ids", async () => {
  const f = fixture(); const a = f.runtime.reserve("root", spec(), "first", false);
  const p = f.runtime.start(a, "first", false);
  assert.throws(() => f.runtime.start(a, "overlap", false), /busy/);
  await tick(); f.gates.get(a.handle)!.resolve(); const first = await p;
  const next = f.runtime.start(a, "second", false);
  await tick(); f.gates.get(a.handle)!.resolve(); const second = await next;
  assert.notEqual(first.runId, second.runId);
  assert.equal(a.model, "test/model"); assert.equal(a.prompt, "Role prompt");
  assert.equal(second.text, "Answer for second"); assert.equal(f.delivered.length, 0);
});

test("owner scopes and delegation depths are enforced in the runtime", () => {
  const f = fixture();
  for (const role of ["Atlas", "minimal", "custom"]) {
    const a = f.runtime.reserve("root", spec(role), "task", false);
    assert.throws(() => f.runtime.reserve(a.handle, spec("Atlas", 2), "nested", true), /Only depth-1/);
  }
  for (const role of ["Forge", "Vigil"]) {
    const a = f.runtime.reserve("root", spec(role), "task", false);
    const atlas = f.runtime.reserve(a.handle, spec("Atlas", 2), "nested", true);
    assert.equal(atlas.depth, 2);
    assert.throws(() => f.runtime.reserve(a.handle, spec("Forge", 2), "bad", true));
    assert.throws(() => f.runtime.reserve(atlas.handle, spec("Atlas", 3), "bad", true));
    assert.throws(() => f.runtime.owned("root", atlas.handle), /Unknown handle/);
  }
  assert.equal(canDelegate(spec("Forge", 2)), false);
});

test("cancel terminates a run; close stops all work without waking the parent", async () => {
  const f = fixture(); const a = f.runtime.reserve("root", spec(), "cancel", true);
  f.runtime.start(a, a.task, true); await tick();
  await f.runtime.cancel("root", a.handle);
  assert.equal(a.status, "cancelled"); assert.equal(f.delivered.length, 1);
  const b = f.runtime.reserve("root", spec(), "close", true);
  f.runtime.start(b, b.task, true); await tick();
  await f.runtime.close();
  assert.equal(b.status, "cancelled"); assert.equal(f.delivered.length, 1);
  assert.equal(f.runtime.jobs.size, 0);
});

test("restored active records become interrupted; forked parents do not share handles", async () => {
  const f = fixture(); const a = f.runtime.reserve("root", spec(), "persist", true);
  a.status = "running";
  const restored = new Subagents("root", f.runtime.createChild, f.runtime.snapshot());
  assert.equal(restored.owned("root", a.handle).status, "interrupted");
  const fork = new Subagents("other-root", f.runtime.createChild, f.runtime.snapshot());
  assert.equal(fork.records.size, 0);
});

test("creation failures produce a completion instead of losing the handle", async () => {
  const f = fixture(); f.runtime.createChild = async () => { throw new Error("missing model"); };
  const a = f.runtime.reserve("root", spec(), "task", true);
  const report = await f.runtime.start(a, a.task, true);
  assert.equal(report.status, "failed"); assert.match(report.text, /missing model/);
  assert.equal(f.delivered.length, 1); assert.equal(f.runtime.jobs.size, 0);
});

test("a delegated background Atlas keeps Forge alive until delivery and continuation settle", async () => {
  const events: string[] = [];
  const gate = deferred(); const continuation = deferred();
  let nestedRun: Promise<Report>;
  const runtime = new Subagents("root", async record => ({
    async prompt() {
      if (record.agent === "Forge") {
        const a = runtime.reserve(record.handle, spec("Atlas", 2), "research", true);
        nestedRun = runtime.start(a, a.task, true);
      } else await gate.promise;
    },
    async waitForIdle() { if (record.agent === "Forge") await continuation.promise; },
    async abort() { gate.resolve(); continuation.resolve(); }, dispose() { events.push(`dispose:${record.agent}`); },
    output: () => "done", error: () => undefined, usage: zeroUsage,
    async deliver() { events.push("delivered:Atlas"); continuation.resolve(); },
  }));
  runtime.attach({ save() {}, deliver: report => { events.push(`root:${report.agent}`); } });
  const forge = runtime.reserve("root", spec("Forge"), "implement", true);
  const run = runtime.start(forge, forge.task, true);
  await tick(); assert.equal(forge.status, "running");
  gate.resolve(); await run; await nestedRun!;
  assert.ok(events.indexOf("delivered:Atlas") < events.indexOf("root:Forge"));
  assert.equal(runtime.jobs.size, 0);
});

const context = { model: { provider: "test", id: "parent" }, thinkingLevel: "medium" } as ExtensionToolContext;
function toolFixture(config: Config, parent?: Spec) {
  const f = fixture();
  const tool = createSubagentTool({ runtime: () => f.runtime, config: () => config, owner: "root", parent, activeTools: () => ["read", "bash", "web", "subagent"] });
  return { ...f, tool, run: (params: Parameters<typeof tool.execute>[1], signal?: AbortSignal) => tool.execute("call", params, signal, undefined, context) };
}

test("minimal uses only Pi prompt and inherits model/thinking/tools, excluding delegation", async () => {
  const f = toolFixture(await readConfig(bundledConfig));
  await f.run({ agents: [{ agent: "minimal", task: "do work" }] });
  const record = [...f.runtime.records.values()][0];
  assert.equal(record.prompt, ""); assert.equal(record.model, "test/parent"); assert.equal(record.thinking, "medium");
  assert.deepEqual(record.tools, ["read", "bash", "web"]);
  await f.runtime.close();
});

test("named config and custom overrides resolve without leaking into followups", async () => {
  const f = toolFixture(await readConfig(bundledConfig));
  await f.run({ agents: [{ agent: "Atlas", task: "research" }, { agent: "custom", prompt: "Custom role", model: "test/custom", thinking: "low", tools: ["read"], task: "work" }] });
  const [atlas, custom] = [...f.runtime.records.values()];
  assert.equal(atlas.model, "openai-codex/gpt-6-luna"); assert.equal(atlas.thinking, "high");
  assert.equal(custom.prompt, "Custom role"); assert.equal(custom.model, "test/custom");
  await assert.rejects(f.run({ agents: [{ handle: custom.handle, model: "test/other", task: "override" }] }), /original configuration/);
  await f.runtime.close();
});

test("nested schema exposes Atlas alone and hides ad hoc fields", async () => {
  const config = await readConfig(bundledConfig);
  const { tool } = toolFixture(config, spec("Forge"));
  assert.ok(Value.Check(tool.parameters, { agents: [{ agent: "Atlas", task: "research" }] }));
  for (const agent of ["Forge", "Vigil", "minimal", "custom"]) assert.equal(Value.Check(tool.parameters, { agents: [{ agent, task: "work" }] }), false);
  assert.equal(Value.Check(tool.parameters, { agents: [{ agent: "Atlas", prompt: "bad", task: "work" }] }), false);
  assert.throws(() => toolFixture(config, spec("Atlas")), /cannot delegate/);
});

test("batch validation is atomic and sync calls await results", async () => {
  const f = toolFixture(await readConfig(bundledConfig));
  await assert.rejects(f.run({ agents: [{ agent: "Atlas", task: "work" }, { agent: "custom", task: "missing prompt" }] }));
  assert.equal(f.runtime.records.size, 0);
  const p = f.run({ background: false, agents: [{ agent: "minimal", task: "work" }] });
  await tick(); const record = [...f.runtime.records.values()][0];
  assert.equal(record.status, "running"); f.gates.get(record.handle)!.resolve();
  const result = await p;
  assert.equal(result.usage?.totalTokens, 0); assert.equal(f.delivered.length, 0);
});

test("config rejects unknown fields and duplicate YAML keys with useful paths", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-agent-config-"));
  try {
    const path = join(dir, "agents.yaml");
    await writeFile(path, "version: 1\nagents: {}\npresets: {}\n");
    await assert.rejects(readConfig(path), /agents.yaml.*presets/);
    await writeFile(path, "version: 1\nversion: 1\nagents: {}\n");
    await assert.rejects(readConfig(path), /unique|Duplicate/i);
    await writeFile(path, "version: 1\nagents: {}\n");
    await assert.rejects(readConfig(path), /agents\/Atlas/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("untrusted project config is ignored; invalid trusted config never silently falls through", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-agent-trust-"));
  try {
    await mkdir(join(dir, ".pi")); await writeFile(join(dir, ".pi", "agents.yaml"), "version: broken\n");
    assert.equal((await loadConfig(dir, false, join(dir, "global"))).path, bundledConfig);
    await assert.rejects(loadConfig(dir, true, join(dir, "global")), /agents.yaml/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
