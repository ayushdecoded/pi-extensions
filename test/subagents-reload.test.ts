import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { randomUUID } from "node:crypto";
import type { ExtensionAPI, ExtensionContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import extension from "../src/subagents/index.ts";
import { bundledConfig } from "../src/subagents/config.ts";
import { Subagents, zeroUsage } from "../src/subagents/runtime.ts";

test("actual extension lifecycle adopts live jobs after reload and retains valid config on errors", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-reload-test-"));
  const root = randomUUID(); const entries: unknown[] = [];
  const configPath = join(cwd, ".pi", "agents.yaml");
  await mkdir(join(cwd, ".pi"));
  await writeFile(configPath, `version: 1\nagents:\n${["Atlas", "Forge", "Vigil"].map(name => `  ${name}:\n    description: ${name}\n    prompt: ${join(dirname(bundledConfig), "agents", `${name.toLowerCase()}.md`)}\n    tools: [read]\n`).join("")}`);
  const ctx = { cwd, mode: "print", isProjectTrusted: () => true,
    sessionManager: { getSessionId: () => root, getBranch: () => entries },
    ui: { notify() {}, setWidget() {} },
  } as unknown as ExtensionContext;
  async function harness() {
    const events = new Map<string, Function>(); const tools = new Map<string, ToolDefinition>(); const sent: unknown[] = [];
    const commands: string[] = []; const shortcuts = new Map<string, { handler: (ctx: ExtensionContext) => void }>();
    let active = true;
    const check = () => { assert.ok(active, "stale parent API used"); };
    const pi = {
      on(name: string, handler: Function) { events.set(name, handler); },
      registerTool(tool: ToolDefinition) { check(); tools.set(tool.name, tool); },
      registerCommand(name: string) { commands.push(name); },
      registerMessageRenderer() {},
      registerShortcut(name: string, options: { handler: (ctx: ExtensionContext) => void }) { shortcuts.set(name, options); },
      getActiveTools: () => ["read", "subagent"],
      appendEntry(customType: string, data: unknown) { check(); entries.push({ type: "custom", customType, data }); },
      sendMessage(message: unknown, options: unknown) { check(); sent.push({ message, options }); },
    } as unknown as ExtensionAPI;
    await extension(pi);
    return { events, sent, tools, commands, shortcuts, invalidate() { active = false; } };
  }
  const first = await harness();
  try {
    // The bootstrap registration must happen during factory load so /reload's pre-session_start
    // chat rebuild can find renderers instead of dumping raw JSON.
    const bootstrap = first.tools.get("subagent");
    assert.ok(bootstrap, "subagent tool registered before session_start");
    assert.equal(typeof bootstrap!.renderCall, "function");
    assert.equal(typeof bootstrap!.renderResult, "function");
    await first.events.get("session_start")!({ reason: "startup" }, ctx);
    const registry = (globalThis as any)[Symbol.for("pi-extensions/subagents/v1")] as Map<string, { runtime: Subagents; config: unknown }>;
    const service = registry.get(root)!;
    assert.equal(first.commands.includes("agents"), false);
    first.shortcuts.get("alt+m")!.handler({ ...ctx, mode: "tui" });
    assert.equal(service.runtime.widgetCollapsed, true);
    assert.equal((entries.at(-1) as any).data.widgetCollapsed, true);
    let finish!: () => void;
    const gate = new Promise<void>(resolve => { finish = resolve; });
    let disposed = false;
    service.runtime.createChild = async () => ({
      prompt: () => gate, waitForIdle: async () => {}, abort: async () => { finish(); }, dispose: () => { disposed = true; },
      output: () => "Survived reload", error: () => undefined, usage: zeroUsage, deliver: async () => {},
    });
    const record = service.runtime.reserve(root, { agent: "minimal", depth: 1, prompt: "", model: "test/fake", thinking: "high", tools: ["read"] }, "task", true);
    const work = service.runtime.start(record, "task", true);
    await new Promise(resolve => setImmediate(resolve));
    await first.events.get("session_shutdown")!({ reason: "reload" }, ctx);
    first.invalidate();
    assert.equal(disposed, false);
    const second = await harness();
    // Recovery after reload must re-register renderers before session_start too.
    const recovered = second.tools.get("subagent");
    assert.ok(recovered, "subagent tool registered before reload session_start");
    assert.equal(typeof recovered!.renderCall, "function");
    assert.equal(typeof recovered!.renderResult, "function");
    await second.events.get("session_start")!({ reason: "reload" }, ctx);
    assert.equal(registry.get(root)!.runtime, service.runtime);
    assert.equal(service.runtime.widgetCollapsed, true);
    finish(); await work;
    assert.equal(first.sent.length, 0); assert.equal(second.sent.length, 1);
    assert.deepEqual((second.sent[0] as any).options, { triggerTurn: true, deliverAs: "followUp" });
    const valid = service.config;
    await writeFile(configPath, "version: not-valid\n");
    await second.events.get("session_shutdown")!({ reason: "reload" }, ctx);
    second.invalidate();
    const third = await harness(); await third.events.get("session_start")!({ reason: "reload" }, ctx);
    assert.equal(service.config, valid);
    await third.events.get("session_shutdown")!({ reason: "quit" }, ctx);
    assert.equal(registry.has(root), false);
  } finally { await rm(cwd, { recursive: true, force: true }); }
});
