import assert from "node:assert/strict";
import { test } from "node:test";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { AutoRenameController, cleanConversation, cleanTitleContext, entriesSinceLastCompaction, formatConversation, normalizeTitle, registerAutoRename } from "../src/auto-rename.ts";

const entries = [
  message("user", "Help refactor auth"),
  message("assistant", "I will inspect it", "stop"),
  message("assistant", "", "toolUse", [{ type: "toolCall", id: "call-1", name: "read", arguments: {} }]),
  toolResult("very verbose tool output that must never reach Spark"),
  message("user", "Keep API compatibility"),
  message("assistant", "Compatibility is preserved", "stop"),
  message("user", "Go ahead"),
];

test("clean conversation keeps only user prompts and final assistant text", () => {
  const conversation = cleanConversation(entries as any);
  assert.deepEqual(conversation, [
    { role: "User", text: "Help refactor auth" },
    { role: "Assistant", text: "I will inspect it" },
    { role: "User", text: "Keep API compatibility" },
    { role: "Assistant", text: "Compatibility is preserved" },
    { role: "User", text: "Go ahead" },
  ]);
  assert.doesNotMatch(formatConversation(conversation), /verbose|toolUse|call-1/i);
});

test("manual title context starts at the latest compaction and excludes tools and thinking", () => {
  const context = cleanTitleContext(entriesSinceLastCompaction([
    message("user", "Old conversation that was compacted"),
    { type: "compaction", summary: "First summary that was later replaced." },
    message("user", "Also compacted later"),
    { type: "compaction", summary: "Latest summary established the CRM intake design." },
    message("user", "Name the remaining design work"),
    message("assistant", "I will summarize the M8 API plan", "stop"),
    message("assistant", "", "toolUse", [{ type: "toolCall", id: "call-2", name: "read", arguments: {} }]),
    toolResult("Never send this tool output to Spark"),
  ] as any));

  assert.deepEqual(context, [
    { role: "Summary", text: "Latest summary established the CRM intake design." },
    { role: "User", text: "Name the remaining design work" },
    { role: "Assistant", text: "I will summarize the M8 API plan" },
  ]);
});

test("auto-rename rejects an instruction that pushes the complete Spark request over its limit", async () => {
  let handler!: (args: string, ctx: ExtensionContext) => Promise<void>;
  registerAutoRename({
    on: () => {},
    registerCommand: (_name: string, command: { handler: (args: string, ctx: ExtensionContext) => Promise<void> }) => { handler = command.handler; },
    setSessionName: () => {},
  } as any);
  const notices: string[] = [];
  const ctx = {
    hasUI: true,
    getContextUsage: () => ({ percent: 1 }),
    modelRegistry: { find: () => ({ contextWindow: 128_000 }) },
    sessionManager: { getBranch: () => [message("user", "short context")] },
    ui: { notify: (message: string) => notices.push(message) },
  } as unknown as ExtensionContext;

  await handler("x".repeat(500_000), ctx);
  assert.deepEqual(notices, ["📦 The distilled story is still too big for Spark (98%)."]);
});

test("normalizes title-only model output", () => {
  assert.equal(normalizeTitle("  **Auth compatibility refactor.**  "), "Auth compatibility refactor");
  assert.equal(normalizeTitle("One two three four five six seven eight nine ten"), "One two three four five six seven eight nine");
  assert.equal(normalizeTitle(undefined), undefined);
});

test("names a new chat from its first prompt and removes the widget after expiry", async () => {
  const harness = createHarness([]);
  const controller = new AutoRenameController(harness.pi as any, async (transcript) => {
    assert.equal(transcript, "User: Help refactor auth while preserving compatibility");
    return "Auth compatibility refactor";
  }, 1);

  controller.startSession("new", harness.ctx);
  await controller.renameFromFirstPrompt("Help refactor auth while preserving compatibility", harness.ctx);

  assert.equal(harness.name, "Auth compatibility refactor");
  const widget = harness.widgets.at(-1)?.value as string[];
  assert.match(widget[0]!, /Renamed/);

  await delay(10);
  assert.equal(harness.widgets.at(-1)?.value, undefined);
});

test("blank startup sessions are named from their first prompt", async () => {
  const harness = createHarness([{ type: "model_change" }, { type: "thinking_level_change" }]);
  const controller = new AutoRenameController(harness.pi as any, async () => "Weather coffee chat naming", 1);

  controller.startSession("startup", harness.ctx);
  await controller.renameFromFirstPrompt("Discuss weather over coffee", harness.ctx);

  assert.equal(harness.name, "Weather coffee chat naming");
});

test("a manual name aborts a pending automatic title and wins", async () => {
  const harness = createHarness(entries);
  let resolveTitle!: (title: string) => void;
  const controller = new AutoRenameController(harness.pi as any, async (_transcript, _ctx, signal) => {
    assert.equal(signal.aborted, false);
    return new Promise<string>((resolve) => { resolveTitle = resolve; });
  });

  controller.startSession("new", harness.ctx);
  const pending = controller.renameFromFirstPrompt("Refactor authentication compatibility", harness.ctx);
  await Promise.resolve();
  controller.observeSessionName("My manual title");
  resolveTitle("Generated title");
  await pending;

  assert.equal(harness.name, undefined);
});

test("does not retroactively title resumed or forked sessions", async () => {
  for (const reason of ["resume", "fork"] as const) {
    const harness = createHarness(entries);
    let calls = 0;
    const controller = new AutoRenameController(harness.pi as any, async () => { calls += 1; return "Never used"; });
    controller.startSession(reason, harness.ctx);
    await controller.renameFromFirstPrompt("Do not rename this old session", harness.ctx);
    assert.equal(calls, 0);
  }
});

function createHarness(branch: unknown[]) {
  let name: string | undefined;
  const widgets: Array<{ key: string; value: unknown }> = [];
  const pi = {
    getSessionName: () => name,
    setSessionName: (next: string) => { name = next; },
  };
  const ctx = {
    mode: "tui",
    sessionManager: { getBranch: () => branch },
    ui: { setWidget: (key: string, value: unknown) => widgets.push({ key, value }) },
  } as unknown as ExtensionContext;
  return {
    pi,
    ctx,
    widgets,
    get name() { return name; },
  };
}

function message(role: "user" | "assistant", text: string, stopReason?: string, content?: unknown[]) {
  return {
    type: "message",
    message: { role, content: content ?? [{ type: "text", text }], ...(stopReason ? { stopReason } : {}) },
  };
}

function toolResult(text: string) {
  return { type: "message", message: { role: "toolResult", content: [{ type: "text", text }] } };
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
