// Creates an offline native transcript for checking tool rendering before/after /reload.
// Not included in the package manifest; does not call a model.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { zeroUsage } from "../../src/subagents/runtime.ts";

const manager = SessionManager.create(process.cwd(), mkdtempSync(join(tmpdir(), "subagent-render-fixture-")));
const assistant = { role: "assistant" as const, api: "openai-responses" as const, model: "fixture", provider: "fixture", usage: zeroUsage(), timestamp: Date.now() };
manager.appendMessage({ role: "user", content: "Check compact subagent tool rendering.", timestamp: Date.now() });
manager.appendMessage({ ...assistant, content: [{ type: "toolCall", id: "fixture-call", name: "subagent", arguments: {
  agents: [{ agent: "Forge", task: "RAW_ARGUMENTS_MUST_STAY_HIDDEN: inspect a deterministic offline UI fixture." }], background: true,
} }], stopReason: "toolUse" });
manager.appendMessage({ role: "toolResult", toolCallId: "fixture-call", toolName: "subagent", content: [{ type: "text", text: "RAW_RESULT_MUST_STAY_HIDDEN" }],
  details: { background: true, agents: [{ handle: "fixture-handle", agent: "Forge", title: "Inspect offline UI fixture", task: "Inspect fixture", status: "running", depth: 1, startedAt: Date.now() }] }, isError: false, timestamp: Date.now() });
manager.appendMessage({ ...assistant, content: [{ type: "text", text: "Fixture ready. Reload should preserve the compact tool card." }], stopReason: "stop" });
console.log(manager.getSessionFile());
