import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { DEFAULT_ASS_CONFIG, loadAgentsConfig, projectAgentsPath, resolveAssConfig } from "../src/config/agents.ts";
import { AssController, assStory, buildAssPrompt, renderDingWav } from "../src/ass.ts";

// ---------- config ----------

const yaml = `version: 1
defaults:
  maxDepth: 1
  concurrency: 2
  timeoutMinutes: 10
roles:
  Worker:
    description: Implement bounded changes
    model: openai-codex/gpt-5.6-luna
    thinking: xhigh
    prompt: agents/worker.md
    tools: [read, bash, edit, write]
`;

async function loadWithAss(assYaml: string) {
  const root = await mkdtemp(path.join(os.tmpdir(), "pi-extensions-ass-"));
  await mkdir(path.join(root, ".pi", "agents"), { recursive: true });
  await writeFile(path.join(root, ".pi", "agents", "worker.md"), "Worker prompt\n");
  await writeFile(projectAgentsPath(root), `${yaml}${assYaml}`);
  return loadAgentsConfig({ cwd: root });
}

test("ass is disabled with defaults when the section is absent", async () => {
  const config = await loadWithAss("");
  const ass = resolveAssConfig(config);
  assert.equal(ass.enabled, false);
  assert.equal(ass.persona, DEFAULT_ASS_CONFIG.persona);
  assert.deepEqual(ass.cadence, { userMessages: 3, minutes: 5 });
});

test("ass parses the minimal section with defaults", async () => {
  const config = await loadWithAss("ass:\n  enabled: true\n");
  const ass = resolveAssConfig(config);
  assert.equal(ass.enabled, true);
  assert.equal(ass.persona, DEFAULT_ASS_CONFIG.persona);
  assert.deepEqual(ass.cadence, DEFAULT_ASS_CONFIG.cadence);
});

test("ass parses persona and cadence overrides", async () => {
  const config = await loadWithAss("ass:\n  enabled: true\n  persona: roast me harder\n  cadence:\n    userMessages: 2\n    minutes: 7\n");
  assert.deepEqual(resolveAssConfig(config), {
    enabled: true,
    persona: "roast me harder",
    cadence: { userMessages: 2, minutes: 7 },
  });
});

test("ass rejects invalid config", async () => {
  await assert.rejects(loadWithAss("ass:\n  enabled: \"true\"\n"));
  await assert.rejects(loadWithAss("ass:\n  enabled: true\n  cadence:\n    userMessages: 0\n"));
  await assert.rejects(loadWithAss("ass:\n  maxPerSession: 10\n"));
});

// ---------- context assembly ----------

function message(role: "user" | "assistant", text: string, stopReason?: string, content?: unknown[]) {
  return {
    type: "message",
    message: {
      role,
      content: content ?? [{ type: "text", text }],
      ...(stopReason ? { stopReason } : {}),
      usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, cost: { total: 0.01 } },
    },
  };
}

function toolResult(text: string) {
  return { type: "message", message: { role: "toolResult", content: [{ type: "text", text }] } };
}

const storyEntries = [
  { type: "compaction", summary: "Earlier work established the CRM intake design." },
  message("user", "The accounting branch keeps double-counting"),
  message("assistant", "I traced it to the tree-vs-leaf merge", "stop"),
  message("assistant", "", "toolUse", [{ type: "toolCall", id: "call-1", name: "read", arguments: {} }]),
  toolResult("very verbose tool output that must never reach ass"),
  message("user", "So which number do I actually pay?"),
  message("assistant", "The tree total is what you pay", "stop"),
];

test("ass story keeps the compaction summary and conversation but never tool calls", () => {
  const story = assStory(storyEntries as any);
  assert.match(story, /CRM intake design/);
  assert.match(story, /double-counting/);
  assert.match(story, /which number do I actually pay/);
  assert.doesNotMatch(story, /verbose|toolUse|call-1|toolResult/i);
});

// ---------- prompt ----------

test("buildAssPrompt carries persona, conversation, and stats", () => {
  const prompt = buildAssPrompt({
    persona: "roast me",
    story: "User: hello",
    stats: {
      cost: 4.2, tokensIn: 1200, tokensOut: 480, elapsedMin: 96,
      contextPercent: 78,
    },
  });
  assert.match(prompt, /ass \(a successful shitposter\)/);
  assert.match(prompt, /roast me/);
  assert.match(prompt, /User: hello/);
  assert.match(prompt, /\$4.20/);
  assert.match(prompt, /96 min/);
  assert.match(prompt, /context 78%/);
});

// ---------- ding ----------

test("renderDingWav produces a valid mono 16-bit WAV with audible samples", () => {
  const wav = renderDingWav();
  assert.equal(wav.toString("ascii", 0, 4), "RIFF");
  assert.equal(wav.toString("ascii", 8, 12), "WAVE");
  assert.equal(wav.readUInt16LE(22), 1); // mono
  assert.equal(wav.readUInt16LE(34), 16); // 16-bit
  const dataSize = wav.readUInt32LE(40);
  assert.equal(wav.length, 44 + dataSize);
  let peak = 0;
  for (let index = 44; index < wav.length; index += 2) {
    peak = Math.max(peak, Math.abs(wav.readInt16LE(index)));
  }
  assert.ok(peak > 1000, "ding should have audible samples");
});

// ---------- controller ----------

function basicEntries() {
  return [
    message("user", "Let's build the announcer"),
    message("assistant", "It will be called ass", "stop"),
    message("user", "The enshittification matters"),
  ];
}

function createHarness(options: { entries?: unknown[]; generateLine?: (prompt: string) => Promise<string | undefined> } = {}) {
  const widgets: Array<{ key: string; value: unknown }> = [];
  let dings = 0;
  let generated = 0;
  const ctx = {
    mode: "tui",
    ui: { setWidget: (key: string, value: unknown) => widgets.push({ key, value }) },
    modelRegistry: {
      find: () => ({ provider: "openai-codex", id: "gpt-5.3-codex-spark" }),
      getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "key", headers: {}, env: {} }),
    },
    sessionManager: { buildContextEntries: () => options.entries ?? basicEntries() },
    getContextUsage: () => ({ percent: 40, contextWindow: 128_000 }),
  } as unknown as ExtensionContext;
  const controller = new AssController({
    generateLine: async (prompt) => {
      generated++;
      return options.generateLine ? options.generateLine(prompt) : "you have been roasted 🔥";
    },
    widgetDurationMs: 60_000,
    playDing: () => { dings++; },
  });
  return {
    controller,
    ctx,
    widgets,
    get dings() { return dings; },
    get generated() { return generated; },
  };
}

test("controller fires only after the user-message threshold settles", async () => {
  const h = createHarness();
  h.controller.start(h.ctx, { enabled: true, persona: "roast me", cadence: { userMessages: 3, minutes: 5 } });
  h.widgets.length = 0; // start() clears any stale widget; forget that entry
  h.controller.observeMessage({ message: { role: "user" } });
  h.controller.observeMessage({ message: { role: "user" } });
  await h.controller.settle({}, h.ctx);
  assert.equal(h.generated, 0);

  h.controller.observeMessage({ message: { role: "user" } });
  await h.controller.settle({}, h.ctx);
  assert.equal(h.generated, 1);
  assert.equal(h.dings, 1);
  assert.deepEqual(h.widgets.at(-1)?.value, ["you have been roasted 🔥"]); // raw model text, as-is
  h.controller.stop(h.ctx);
});

test("controller resets the cadence even when spark stays silent", async () => {
  const h = createHarness({ generateLine: async () => undefined });
  h.controller.start(h.ctx, { enabled: true, persona: "roast me", cadence: { userMessages: 2, minutes: 5 } });
  h.widgets.length = 0;
  h.controller.observeMessage({ message: { role: "user" } });
  h.controller.observeMessage({ message: { role: "user" } });
  await h.controller.settle({}, h.ctx);
  assert.equal(h.generated, 1);
  assert.equal(h.widgets.length, 0); // silence: no widget
  assert.equal(h.dings, 0);

  // A fresh threshold is needed for the next attempt.
  h.controller.observeMessage({ message: { role: "user" } });
  await h.controller.settle({}, h.ctx);
  assert.equal(h.generated, 1);
  h.controller.stop(h.ctx);
});

test("controller trims whitespace-only output to silence", async () => {
  const h = createHarness({ generateLine: async () => "   \n  " });
  h.controller.start(h.ctx, { enabled: true, persona: "roast me", cadence: { userMessages: 1, minutes: 5 } });
  h.widgets.length = 0;
  h.controller.observeMessage({ message: { role: "user" } });
  await h.controller.settle({}, h.ctx);
  assert.equal(h.generated, 1);
  assert.equal(h.widgets.length, 0);
  h.controller.stop(h.ctx);
});

test("force fires even when ass is disabled", async () => {
  const h = createHarness();
  await h.controller.force(h.ctx);
  assert.equal(h.generated, 1);
  assert.equal(h.widgets.at(-1)?.key, "pi-ass");
  h.controller.stop(h.ctx);
});

test("compaction restarts the message cadence", async () => {
  const h = createHarness();
  h.controller.start(h.ctx, { enabled: true, persona: "roast me", cadence: { userMessages: 3, minutes: 5 } });
  h.widgets.length = 0;
  h.controller.compacted();
  h.controller.observeMessage({ message: { role: "user" } });
  h.controller.observeMessage({ message: { role: "user" } });
  await h.controller.settle({}, h.ctx);
  assert.equal(h.generated, 0); // compaction reset the baseline; still needs 3 fresh messages
  h.controller.stop(h.ctx);
});

test("widget disappears after its display duration", async () => {
  const widgets: Array<{ key: string; value: unknown }> = [];
  const ctx = {
    mode: "tui",
    ui: { setWidget: (key: string, value: unknown) => widgets.push({ key, value }) },
    modelRegistry: {
      find: () => ({ provider: "openai-codex", id: "gpt-5.3-codex-spark" }),
      getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "key", headers: {}, env: {} }),
    },
    sessionManager: { buildContextEntries: () => basicEntries() },
    getContextUsage: () => ({ percent: 40, contextWindow: 128_000 }),
  } as unknown as ExtensionContext;
  const controller = new AssController({
    widgetDurationMs: 20,
    playDing: () => {},
    generateLine: async () => "you have been roasted",
  });
  controller.start(ctx, { enabled: true, persona: "roast me", cadence: { userMessages: 1, minutes: 5 } });
  widgets.length = 0;
  controller.observeMessage({ message: { role: "user" } });
  await controller.settle({}, ctx);
  assert.equal(widgets.length, 1);
  assert.equal(widgets[0]?.key, "pi-ass");
  assert.deepEqual(widgets[0]?.value, ["you have been roasted"]);
  await delay(60);
  assert.equal(widgets.at(-1)?.value, undefined); // cleared by the timer
  controller.stop(ctx);
});

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
