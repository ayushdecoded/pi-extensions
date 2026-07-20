import assert from "node:assert/strict";
import { test } from "node:test";
import type { ExtensionAPI, ExtensionContext, SessionEntry } from "@earendil-works/pi-coding-agent";
import {
  completionSource,
  desktopNotificationArguments,
  desktopNotificationSequences,
  notificationPresentation,
  parseCompletionLabel,
  registerLongTaskNotifications,
  sanitizeNotificationText,
} from "../src/long-task-notifications.ts";
import type { PromptDurationEntryData } from "../src/ui/prompt-duration.ts";

test("parses and bounds Spark completion metadata", () => {
  assert.deepEqual(
    parseCompletionLabel('{"status":"needs-input","summary":"Choose the storage backend for generated audit records please now"}'),
    { status: "needs-input", summary: "Choose the storage backend for generated audit records please now" },
  );
  assert.equal(parseCompletionLabel('{"status":"maybe","summary":"Unknown"}'), undefined);
  assert.equal(parseCompletionLabel("not json"), undefined);
});

test("completion source includes execution evidence from the matching prompt to branch end", () => {
  const entries = [
    messageEntry("old", "user", "Earlier unrelated task"),
    messageEntry("u1", "user", "Refactor authentication"),
    messageEntry("a1", "assistant", "I will inspect it", "stop"),
    toolCallEntry("bash-call", "bash", { command: "npm test" }),
    toolResultEntry("bash-result", "bash-call", "bash", "102 tests passed", false),
    toolCallEntry("grep-call", "grep", { pattern: "refreshToken", path: "src" }),
    toolResultEntry("grep-result", "grep-call", "grep", [
      "src/a.ts:1", "src/b.ts:2", "src/c.ts:3", "src/d.ts:4",
      "src/e.ts:5", "src/f.ts:6", "src/g.ts:7", "src/h.ts:8",
    ].join("\n"), false),
    messageEntry("a2", "assistant", "Authentication refactor completed and tests pass", "stop"),
    messageEntry("u2", "user", "Also verify compatibility"),
    messageEntry("a3", "assistant", "Compatibility is verified", "stop"),
  ];

  const source = completionSource(entries, "u1");
  assert.match(source ?? "", /^User: Refactor authentication/);
  assert.match(source ?? "", /Assistant: I will inspect it/);
  assert.match(source ?? "", /Tool bash succeeded/);
  assert.match(source ?? "", /Command: npm test/);
  assert.match(source ?? "", /Returned: 1 non-empty lines, 16 characters/);
  assert.match(source ?? "", /Final output:\n102 tests passed/);
  assert.match(source ?? "", /Tool grep succeeded/);
  assert.match(source ?? "", /Search: "refreshToken" in src/);
  assert.match(source ?? "", /Returned: 8 matches/);
  assert.match(source ?? "", /src\/a\.ts:1[\s\S]*… 2 omitted …[\s\S]*src\/h\.ts:8/);
  assert.match(source ?? "", /Authentication refactor completed/);
  assert.match(source ?? "", /User: Also verify compatibility/);
  assert.match(source ?? "", /Compatibility is verified/);
  assert.doesNotMatch(source ?? "", /Earlier unrelated/);
});

test("notification text and desktop protocols are terminal safe", () => {
  assert.equal(sanitizeNotificationText("hello;\x1b]777\\world\n"), "hello, ]777,world");
  assert.deepEqual(desktopNotificationArguments("Pi", "--unsafe\nbody"), [
    "--app-name=Pi",
    "--urgency=critical",
    "--expire-time=15000",
    "--",
    "Pi",
    "--unsafe body",
  ]);
  const kitty = desktopNotificationSequences("Pi;Title", "done\x07now", true);
  assert.equal(kitty.length, 2);
  assert.ok(kitty.every((sequence) => !sequence.includes("\x07")));
  assert.match(kitty[0]!, /^\x1b\]99;/);

  const osc777 = desktopNotificationSequences("Pi", "done", false);
  assert.deepEqual(osc777, ["\x1b]777;notify;Pi;done\x07"]);
});

test("long completion produces matching in-terminal and desktop notifications", async () => {
  const handlers = new Map<string, Function[]>();
  const pi = {
    on(event: string, handler: Function) {
      const list = handlers.get(event) ?? [];
      list.push(handler);
      handlers.set(event, list);
    },
  } as unknown as ExtensionAPI;
  const terminal: Array<{ message: string; tone: string }> = [];
  const desktop: Array<{ title: string; body: string }> = [];
  const branch = [
    messageEntry("user", "user", "Implement refresh tokens"),
    messageEntry("assistant", "assistant", "Refresh tokens implemented and verified", "stop"),
  ];
  const ctx = {
    mode: "tui",
    sessionManager: { getBranch: () => branch },
    ui: { notify: (message: string, tone: string) => terminal.push({ message, tone }) },
  } as unknown as ExtensionContext;
  const listener = registerLongTaskNotifications(
    pi,
    async () => ({ status: "completed", summary: "Refresh tokens implemented and verified" }),
    (title, body) => desktop.push({ title, body }),
  );

  listener(duration("user"), ctx);
  await settleAsyncWork();

  assert.deepEqual(terminal, [{ message: "✓ Refresh tokens implemented and verified (2m 00s)", tone: "info" }]);
  assert.deepEqual(desktop, [{ title: "Pi · Completed", body: "Refresh tokens implemented and verified · 2m 00s" }]);
});

test("a new agent run cancels stale completion metadata", async () => {
  const handlers = new Map<string, Function[]>();
  const pi = {
    on(event: string, handler: Function) {
      const list = handlers.get(event) ?? [];
      list.push(handler);
      handlers.set(event, list);
    },
  } as unknown as ExtensionAPI;
  const terminal: string[] = [];
  let resolveLabel!: (value: { status: "completed"; summary: string }) => void;
  const ctx = {
    mode: "tui",
    sessionManager: { getBranch: () => [
      messageEntry("user", "user", "Long task"),
      messageEntry("assistant", "assistant", "Done", "stop"),
    ] },
    ui: { notify: (message: string) => terminal.push(message) },
  } as unknown as ExtensionContext;
  const listener = registerLongTaskNotifications(
    pi,
    async () => new Promise((resolve) => { resolveLabel = resolve; }),
    () => {},
  );

  listener(duration("user"), ctx);
  await Promise.resolve();
  for (const handler of handlers.get("agent_start") ?? []) handler({}, ctx);
  resolveLabel({ status: "completed", summary: "Stale result" });
  await settleAsyncWork();
  assert.deepEqual(terminal, []);
});

test("status presentation controls icon and notification severity", () => {
  assert.deepEqual(notificationPresentation({ durationMs: 60_000 }, { status: "failed", summary: "Test suite failed" }), {
    title: "Pi · Failed",
    body: "Test suite failed · 1m 00s",
    message: "✗ Test suite failed (1m 00s)",
    tone: "error",
  });
});

function duration(promptEntryId: string): PromptDurationEntryData {
  return {
    version: 1,
    promptEntryId,
    startedAt: 0,
    completedAt: 120_000,
    durationMs: 120_000,
  };
}

function toolCallEntry(id: string, name: string, args: unknown): SessionEntry {
  return {
    type: "message",
    id,
    parentId: null,
    timestamp: new Date().toISOString(),
    message: {
      role: "assistant",
      content: [{ type: "toolCall", id, name, arguments: args }],
      stopReason: "toolUse",
      timestamp: Date.now(),
    },
  } as unknown as SessionEntry;
}

function toolResultEntry(id: string, toolCallId: string, toolName: string, text: string, isError: boolean): SessionEntry {
  return {
    type: "message",
    id,
    parentId: null,
    timestamp: new Date().toISOString(),
    message: {
      role: "toolResult",
      toolCallId,
      toolName,
      content: [{ type: "text", text }],
      isError,
      timestamp: Date.now(),
    },
  } as unknown as SessionEntry;
}

function messageEntry(
  id: string,
  role: "user" | "assistant" | "toolResult",
  text: string,
  stopReason?: string,
): SessionEntry {
  const base = {
    type: "message",
    id,
    parentId: null,
    timestamp: new Date().toISOString(),
    message: {
      role,
      content: [{ type: "text", text }],
      timestamp: Date.now(),
      ...(stopReason ? { stopReason } : {}),
    },
  };
  return base as unknown as SessionEntry;
}

async function settleAsyncWork(): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve));
}
