import assert from "node:assert/strict";
import { test } from "node:test";
import { contentText, lastAssistantResponse, normalizeFilename } from "../src/save-md.ts";

function message(role: string, content: unknown, stopReason?: string) {
  return { type: "message", message: { role, content, ...(stopReason ? { stopReason } : {}) } };
}

test("finds the latest completed assistant response and ignores tool calls", () => {
  const entries = [
    message("assistant", [{ type: "text", text: "Earlier" }], "stop"),
    message("assistant", [{ type: "toolCall", id: "call", name: "read", arguments: {} }], "toolUse"),
    message("toolResult", [{ type: "text", text: "Tool output" }]),
    message("assistant", [{ type: "text", text: "# Final\n\n```ts\nconst answer = true;\n```" }], "stop"),
  ];
  assert.equal(lastAssistantResponse(entries as any), "# Final\n\n```ts\nconst answer = true;\n```");
});

test("extracts all text parts without changing Markdown", () => {
  assert.equal(contentText([
    { type: "text", text: "# Heading" },
    { type: "image", data: "ignored" },
    { type: "text", text: "\n\nBody" },
  ]), "# Heading\n\n\nBody");
});

test("normalizes Spark output into a safe Markdown filename", () => {
  assert.equal(normalizeFilename("  **Fix API / streaming bugs.**  "), "fix-api-streaming-bugs.md");
  assert.equal(normalizeFilename("One\ntwo"), "one-two.md");
  assert.equal(normalizeFilename("***"), undefined);
});
