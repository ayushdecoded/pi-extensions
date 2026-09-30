import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createAssistantMessageEventStream, type AssistantMessage } from "@earendil-works/pi-ai";
import { ModelRuntime, SessionManager } from "@earendil-works/pi-coding-agent";
import { readConfig, bundledConfig } from "../src/subagents/config.ts";
import { Subagents, zeroUsage } from "../src/subagents/runtime.ts";
import { createChildSession } from "../src/subagents/session.ts";

test("native SDK sessions isolate prompts/tools and reopen for followups", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pi-child-sdk-"));
  await writeFile(join(directory, "SYSTEM.md"), "PARENT_ONLY_SYSTEM_MARKER");
  await writeFile(join(directory, "APPEND_SYSTEM.md"), "PARENT_ONLY_APPEND_MARKER");
  const contexts: string[] = [];
  const modelRuntime = await ModelRuntime.create({ authPath: join(directory, "auth.json"), modelsPath: null, refreshOnCreate: false });
  modelRuntime.registerProvider("test", {
    apiKey: "test", api: "openai-completions", baseUrl: "https://invalid.example", models: [{
      id: "fake", name: "Fake", reasoning: true, input: ["text"], contextWindow: 100000, maxTokens: 1000,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    }],
    streamSimple(model, context) {
      contexts.push(JSON.stringify(context));
      const stream = createAssistantMessageEventStream();
      const message: AssistantMessage = { role: "assistant", api: "openai-completions", provider: "test", model: model.id,
        content: [{ type: "text", text: `Response ${contexts.length}` }], stopReason: "stop", timestamp: Date.now(),
        usage: { ...zeroUsage(), input: 5, output: 3, totalTokens: 8 } };
      queueMicrotask(() => { stream.push({ type: "done", reason: "stop", message }); stream.end(); });
      return stream;
    },
  });
  const config = await readConfig(bundledConfig); config.titling = undefined;
  const runtime: Subagents = new Subagents("sdk-test", (record, signal, progress) => createChildSession({ cwd: directory, config: () => config, runtime, record, signal, progress, modelRuntime }));
  try {
    for (const [agent, depth] of [["minimal", 1], ["Forge", 1], ["Vigil", 1], ["Atlas", 1]] as const) {
      const record = runtime.reserve("sdk-test", { agent, depth, model: "test/fake", thinking: "high", tools: ["read"], prompt: agent === "minimal" ? "" : `${agent} role fixture` }, "FIRST TASK", false);
      const manager = SessionManager.create(directory, directory);
      record.sessionFile = manager.getSessionFile();
      // SessionManager.open requires a persisted session; initialize an empty test transcript.
      manager.appendMessage({ role: "assistant", api: "openai-completions", provider: "test", model: "fake", content: [{ type: "text", text: "Fixture start" }], usage: zeroUsage(), stopReason: "stop", timestamp: Date.now() });
      const first = await runtime.start(record, "FIRST TASK", false);
      assert.equal(first.status, "completed", first.text);
      assert.ok(first.usage.totalTokens > 0);
      const dispatched = contexts.at(-1)!;
      assert.match(dispatched, /FIRST TASK/);
      assert.doesNotMatch(dispatched, /PARENT_ONLY_/);
      assert.equal(dispatched.includes('\\"subagent\\"') || dispatched.includes('"name":"subagent"'), agent === "Forge" || agent === "Vigil");
      if (agent === "minimal") assert.doesNotMatch(dispatched, /role fixture/);
      else assert.match(dispatched, new RegExp(`${agent} role fixture`));
      const second = await runtime.start(record, "FOLLOWUP TASK", false);
      assert.equal(second.status, "completed", second.text);
      assert.match(contexts.at(-1)!, /FIRST TASK/); assert.match(contexts.at(-1)!, /FOLLOWUP TASK/);
      assert.equal(second.usage.totalTokens, 8);
    }
    config.titling = { model: "test/fake", thinking: "high" };
    const titled = runtime.reserve("sdk-test", { agent: "minimal", depth: 1, model: "test/fake", thinking: "high", tools: ["read"], prompt: "" }, "Title this task", false);
    const manager = SessionManager.create(directory, directory);
    titled.sessionFile = manager.getSessionFile();
    manager.appendMessage({ role: "assistant", api: "openai-completions", provider: "test", model: "fake", content: [{ type: "text", text: "Fixture" }], usage: zeroUsage(), stopReason: "stop", timestamp: Date.now() });
    const result = await runtime.start(titled, titled.task, false);
    assert.equal(result.status, "completed", result.text);
    assert.ok(titled.title); assert.equal(result.usage.totalTokens, 16);
    assert.ok(SessionManager.open(titled.sessionFile!).getEntries().some(entry => entry.type === "usage"));
    const savedTitle = titled.title;
    const count = contexts.length;
    // Old live runtimes may clear title on follow-up; native session metadata restores it.
    titled.title = undefined;
    const followup = await runtime.start(titled, "Without tools repeat the previous answer", false);
    assert.equal(followup.status, "completed", followup.text);
    assert.equal(titled.title, savedTitle);
    assert.equal(contexts.length, count + 1, "follow-up should not invoke the title model again");
    assert.equal(followup.usage.totalTokens, 8);
  } finally { await runtime.close(); await rm(directory, { recursive: true, force: true }); }
});
