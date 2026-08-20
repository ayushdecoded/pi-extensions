import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { DevinAcpClient } from "../src/runtime/devin.ts";

test("Devin ACP client handshakes, streams updates, and scrubs Pi environment", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "pi-devin-test-"));
  const script = path.join(directory, "fake-devin");
  const environmentFile = path.join(directory, "environment");
  const argumentsFile = path.join(directory, "arguments");
  await writeFile(script, `#!/usr/bin/env node
const fs = require("node:fs");
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
    if (message.method === "initialize") {
      fs.writeFileSync(${JSON.stringify(environmentFile)}, process.env.AI_AGENT || "missing" + "|" + (process.env.PI_SECRET || "missing"));
      fs.writeFileSync(${JSON.stringify(argumentsFile)}, JSON.stringify(process.argv.slice(2)));
      process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: message.id, result: { protocolVersion: 1 } }) + "\\n");
    } else if (message.method === "session/new") {
      process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: message.id, result: { sessionId: "session-1" } }) + "\\n");
    } else if (message.method === "session/prompt") {
      process.stdout.write(JSON.stringify({ jsonrpc: "2.0", method: "session/update", params: { sessionId: message.params.sessionId, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "hello" } } } }) + "\\n");
      process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: message.id, result: { stopReason: "end_turn" } }) + "\\n");
    }
  }
});
`, "utf8");
  await chmod(script, 0o755);

  const previousAgent = process.env.AI_AGENT;
  const previousPi = process.env.PI_SECRET;
  process.env.AI_AGENT = "pi";
  process.env.PI_SECRET = "hidden";
  const updates: string[] = [];
  const client = new DevinAcpClient(directory, "swe-1-7", script);
  try {
    await client.start();
    const sessionId = await client.newSession();
    const result = await client.prompt(sessionId, "task", undefined, (update) => {
      if (update.kind === "text") updates.push(update.text);
    });
    assert.equal(result.output, "hello");
    assert.deepEqual(updates, ["hello"]);
    assert.equal(await readFile(environmentFile, "utf8"), "missing|missing");
    assert.deepEqual(JSON.parse(await readFile(argumentsFile, "utf8")), [
      "--permission-mode", "dangerous", "--respect-workspace-trust", "false", "acp", "--model", "swe-1-7",
    ]);
  } finally {
    client.dispose();
    if (previousAgent === undefined) delete process.env.AI_AGENT; else process.env.AI_AGENT = previousAgent;
    if (previousPi === undefined) delete process.env.PI_SECRET; else process.env.PI_SECRET = previousPi;
    await rm(directory, { recursive: true, force: true });
  }
});
