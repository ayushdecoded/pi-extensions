import assert from "node:assert/strict";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { SubagentRuntime } from "../src/runtime/runtime.ts";
import type { AgentsConfig } from "../src/config/agents.ts";

test("runtime routes a Forge invocation through Devin and persists its ACP session", async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "pi-devin-runtime-"));
  const command = path.join(cwd, "fake-devin");
  const promptFile = path.join(cwd, "forge.md");
  await writeFile(promptFile, "You are Forge.\n", "utf8");
  await writeFile(command, `#!/usr/bin/env node
let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  while (buffer.includes("\\n")) {
    const newline = buffer.indexOf("\\n");
    const line = buffer.slice(0, newline);
    buffer = buffer.slice(newline + 1);
    if (!line) continue;
    const message = JSON.parse(line);
    if (message.method === "initialize") process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: message.id, result: {} }) + "\\n");
    else if (message.method === "session/new") process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: message.id, result: { sessionId: "runtime-session" } }) + "\\n");
    else if (message.method === "session/load") process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: message.id, result: {} }) + "\\n");
    else if (message.method === "session/prompt") {
      process.stdout.write(JSON.stringify({ jsonrpc: "2.0", method: "session/update", params: { sessionId: message.params.sessionId, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "done" } } } }) + "\\n");
      process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: message.id, result: { stopReason: "end_turn" } }) + "\\n");
    }
  }
});
`, "utf8");
  await chmod(command, 0o755);

  const config = {
    path: path.join(cwd, "agents.yaml"),
    version: 1,
    defaults: { maxDepth: 1, concurrency: 1, timeoutMinutes: 1 },
    roles: [{
      name: "Forge",
      description: "Implement changes",
      model: "provider/model",
      thinking: "high",
      promptPath: "forge.md",
      promptFile,
      tools: [],
      delegates: [],
      backend: "devin",
      backendOptions: ["native", "devin"],
    }],
    presets: [],
  } as unknown as AgentsConfig;
  const events: unknown[] = [];
  const runtime = new SubagentRuntime({
    rootSessionId: `devin-test-${process.pid}-${Date.now()}`,
    cwd,
    config,
    modelRegistry: {} as any,
    appendEvent: (event) => events.push(event),
    devinCommand: command,
  });
  try {
    const batch = await runtime.runRootBatch([{ role: "Forge", task: "Implement it" }]);
    assert.equal(batch.runs[0]?.status, "complete");
    assert.equal(batch.runs[0]?.output, "done");
    const agent = [...runtime.state.agents.values()][0];
    assert.equal(agent?.backend, "devin");
    assert.equal(agent?.backendSessionId, "runtime-session");
    assert.ok(events.some((event) => (event as { type?: string }).type === "agent.backend-session"));
    const followup = await runtime.runRootBatch([{ agent: agent!.handle, task: "Follow up" }]);
    assert.equal(followup.runs[0]?.status, "complete");
    assert.equal(followup.runs[0]?.output, "done");
  } finally {
    await runtime.shutdown();
    await rm(cwd, { recursive: true, force: true });
  }
});
