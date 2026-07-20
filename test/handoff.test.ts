import assert from "node:assert/strict";
import { test } from "node:test";
import { buildHandoffPrompt, extractGeneratedHandoff, registerHandoffCommand } from "../src/handoff.ts";

function assistantEntry(id: string, text: string, stopReason = "stop", errorMessage?: string): any {
  return {
    type: "message",
    id,
    parentId: null,
    timestamp: new Date().toISOString(),
    message: {
      role: "assistant",
      content: text ? [{ type: "text", text }] : [],
      stopReason,
      errorMessage,
    },
  };
}

test("handoff prompt requires evidence-based chronological transfer and optional focus", () => {
  const focused = buildHandoffPrompt("  verify phase two  ", "/tmp/session.jsonl", "marker-1");
  for (const required of [
    "original goal",
    "direction changes",
    "actions and findings",
    "decisions and their recorded rationale",
    "user-approved decisions",
    "agent or subagent proposals",
    "never promote a recommendation",
    "files inspected or changed",
    "commands, tests, and other validation",
    "issues or blockers",
    "success criteria",
    "current state",
    "unresolved questions or risks",
    "clear next steps",
    "facts, decisions, and assumptions",
    "do not guess",
    "do not implement anything",
    "Do not delegate for an ordinary session",
    "read-only Atlas subagents",
    "chronological chunks",
    "old subagent handles",
  ]) {
    assert.match(focused, new RegExp(required, "i"));
  }
  assert.match(focused, /verify phase two/);
  assert.match(focused, /\/tmp\/session\.jsonl/);
  assert.match(focused, /<session-handoff generation="marker-1">HANDOFF<\/session-handoff>/);
  assert.match(focused, /exactly one envelope and nothing before or after it/i);

  const continuing = buildHandoffPrompt("", "/tmp/session.jsonl", "marker-2");
  assert.match(continuing, /Continue the current work from its present state/);
});

test("handoff extraction attributes the matching envelope across interleaved responses", () => {
  const old = assistantEntry("old", "stale handoff");
  const marker = {
    type: "custom_message",
    id: "marker-entry",
    parentId: "old",
    timestamp: new Date().toISOString(),
    customType: "session-handoff-generation",
    content: "generate",
    display: false,
    details: { generationMarker: "unique" },
  } as any;
  const unrelatedBefore = assistantEntry("unrelated-before", "queued response");
  const toolUse = assistantEntry("tool-use", "", "toolUse");
  const handoff = assistantEntry(
    "handoff",
    '<session-handoff generation="unique">\n  fresh handoff\n</session-handoff>',
  );
  const unrelatedAfter = assistantEntry("unrelated-after", "another queued response");

  assert.equal(
    extractGeneratedHandoff(
      [old, marker, unrelatedBefore, toolUse, handoff, unrelatedAfter],
      new Set(["old"]),
      "unique",
    ),
    "fresh handoff",
  );
  assert.throws(
    () => extractGeneratedHandoff([old, marker, assistantEntry("failed", "", "error", "provider failed")], new Set(["old"]), "unique"),
    /provider failed/,
  );
  assert.throws(
    () => extractGeneratedHandoff([old, marker, assistantEntry("aborted", "", "aborted")], new Set(["old"]), "unique"),
    /cancelled/,
  );
  assert.throws(
    () => extractGeneratedHandoff(
      [old, marker, assistantEntry("empty", '<session-handoff generation="unique">  </session-handoff>')],
      new Set(["old"]),
      "unique",
    ),
    /empty response envelope/,
  );
  assert.throws(
    () => extractGeneratedHandoff(
      [old, marker, assistantEntry("length", '<session-handoff generation="unique">partial</session-handoff>', "length")],
      new Set(["old"]),
      "unique",
    ),
    /incomplete \(stop reason: length\)/,
  );
  assert.throws(
    () => extractGeneratedHandoff([old, marker, assistantEntry("raw", "fresh handoff")], new Set(["old"]), "unique"),
    /no matching complete response envelope/,
  );
  assert.throws(() => extractGeneratedHandoff([old, handoff], new Set(["old"]), "unique"), /marker was not recorded/);
});

test("registered handoff command generates, reviews, and drafts a parent-linked session without submitting", async () => {
  let command: any;
  const branch: any[] = [
    {
      type: "message",
      id: "user-1",
      parentId: null,
      timestamp: new Date().toISOString(),
      message: { role: "user", content: "work on it" },
    },
  ];
  let waitCount = 0;
  let newSessionOptions: any;
  const replacementNotifications: Array<[string, string]> = [];
  const sentMessages: Array<{ message: any; options: any }> = [];
  let replacementEditorText: string | undefined;

  const pi = {
    registerCommand(name: string, definition: unknown) {
      assert.equal(name, "handoff");
      command = definition;
    },
    sendMessage(message: any, options: any) {
      sentMessages.push({ message, options });
      assert.equal(message.display, false);
      assert.ok(message.details.generationMarker);
      if (message.customType === "session-handoff-rollback-anchor") {
        branch.push({
          type: "custom_message",
          id: "rollback-anchor",
          parentId: "user-1",
          timestamp: new Date().toISOString(),
          ...message,
        });
        return;
      }
      assert.equal(message.customType, "session-handoff-generation");
      branch.push({
        type: "custom_message",
        id: "marker-entry",
        parentId: "rollback-anchor",
        timestamp: new Date().toISOString(),
        ...message,
      });
      branch.push(
        assistantEntry(
          "assistant-1",
          `<session-handoff generation="${message.details.generationMarker}">generated handoff</session-handoff>`,
        ),
      );
    },
  } as any;
  const notifications: Array<[string, string]> = [];
  const ctx = {
    mode: "tui",
    model: { id: "test-model" },
    sessionManager: {
      getSessionFile: () => "/tmp/parent.jsonl",
      getBranch: () => branch,
      getLeafId: () => branch.at(-1)?.id ?? null,
    },
    waitForIdle: async () => {
      waitCount++;
    },
    ui: {
      editor: async (title: string, initial: string) => {
        assert.equal(title, "Review session handoff");
        assert.equal(initial, "generated handoff");
        return "  edited handoff  ";
      },
      notify: (message: string, level: string) => notifications.push([message, level]),
    },
    newSession: async (options: any) => {
      newSessionOptions = options;
      await options.withSession({
        ui: {
          setEditorText: (text: string) => {
            replacementEditorText = text;
          },
          notify: (message: string, level: string) => replacementNotifications.push([message, level]),
        },
        sendUserMessage: async () => assert.fail("handoff must not auto-submit"),
      });
      return { cancelled: false };
    },
  } as any;

  registerHandoffCommand(pi);
  assert.equal(command.description, "Transfer the current work to a new parent-linked session");
  await command.handler(" next focus ", ctx);

  assert.equal(waitCount, 2);
  assert.equal(sentMessages.length, 2);
  assert.deepEqual(sentMessages[0]!.options, { triggerTurn: false });
  assert.equal(sentMessages[0]!.message.customType, "session-handoff-rollback-anchor");
  assert.equal(sentMessages[0]!.message.content, "");
  assert.deepEqual(sentMessages[1]!.options, { triggerTurn: true });
  assert.equal(sentMessages[1]!.message.customType, "session-handoff-generation");
  assert.equal(sentMessages[1]!.message.details.generationMarker, sentMessages[0]!.message.details.generationMarker);
  assert.equal(branch.find((entry) => entry.id === "marker-entry")?.parentId, "rollback-anchor");
  assert.equal(newSessionOptions.parentSession, "/tmp/parent.jsonl");
  assert.equal(replacementEditorText, "edited handoff");
  assert.deepEqual(replacementNotifications, [["Handoff ready. Review and submit when ready.", "info"]]);
  assert.deepEqual(notifications, []);
});

test("missing rollback anchor stops before handoff generation", async () => {
  let command: any;
  let sendCount = 0;
  const notifications: Array<[string, string]> = [];
  const branch: any[] = [
    {
      type: "message",
      id: "original-leaf",
      parentId: null,
      timestamp: new Date().toISOString(),
      message: { role: "user", content: "current work" },
    },
  ];
  const pi = {
    registerCommand(_name: string, definition: unknown) {
      command = definition;
    },
    sendMessage(message: any, options: any) {
      sendCount++;
      assert.equal(message.customType, "session-handoff-rollback-anchor");
      assert.deepEqual(options, { triggerTurn: false });
      // Simulate a send that did not append the anchor.
    },
  } as any;
  const ctx = {
    mode: "tui",
    model: { id: "test-model" },
    sessionManager: {
      getSessionFile: () => "/tmp/parent.jsonl",
      getBranch: () => branch,
      getLeafId: () => "original-leaf",
    },
    waitForIdle: async () => {},
    navigateTree: async () => assert.fail("an unrecorded anchor cannot be used for rollback"),
    ui: {
      editor: async () => assert.fail("generation must not start without an anchor"),
      notify: (message: string, level: string) => notifications.push([message, level]),
    },
  } as any;

  registerHandoffCommand(pi);
  await command.handler("", ctx);

  assert.equal(sendCount, 1);
  assert.deepEqual(notifications.at(-1), [
    "Handoff failed: The handoff rollback anchor was not recorded as the active child of the original leaf.",
    "error",
  ]);
});

test("editor cancellation navigates through the hidden rollback anchor", async () => {
  let command: any;
  const branch: any[] = [
    {
      type: "message",
      id: "original-leaf",
      parentId: null,
      timestamp: new Date().toISOString(),
      message: { role: "user", content: "current work" },
    },
  ];
  const navigations: Array<[string, unknown]> = [];
  const notifications: Array<[string, string]> = [];
  const pi = {
    registerCommand(_name: string, definition: unknown) {
      command = definition;
    },
    sendMessage(message: any, options: any) {
      if (message.customType === "session-handoff-rollback-anchor") {
        assert.deepEqual(options, { triggerTurn: false });
        branch.push({
          type: "custom_message",
          id: "rollback-anchor",
          parentId: "original-leaf",
          timestamp: new Date().toISOString(),
          ...message,
        });
        return;
      }
      assert.deepEqual(options, { triggerTurn: true });
      branch.push({
        type: "custom_message",
        id: "generation-marker",
        parentId: "rollback-anchor",
        timestamp: new Date().toISOString(),
        ...message,
      });
      branch.push(
        assistantEntry(
          "generated",
          `<session-handoff generation="${message.details.generationMarker}">draft</session-handoff>`,
        ),
      );
    },
  } as any;
  const ctx = {
    mode: "tui",
    model: { id: "test-model" },
    sessionManager: {
      getSessionFile: () => "/tmp/parent.jsonl",
      getBranch: () => branch,
      getLeafId: () => branch.at(-1)?.id ?? null,
    },
    waitForIdle: async () => {},
    navigateTree: async (id: string, options: unknown) => {
      navigations.push([id, options]);
      return { cancelled: false };
    },
    newSession: async () => assert.fail("cancelled review must not create a session"),
    ui: {
      editor: async () => undefined,
      notify: (message: string, level: string) => notifications.push([message, level]),
    },
  } as any;

  registerHandoffCommand(pi);
  await command.handler("", ctx);

  assert.deepEqual(navigations, [["rollback-anchor", { summarize: false }]]);
  assert.deepEqual(notifications.at(-1), ["Handoff cancelled.", "info"]);
});

test("generation errors preserve the error and roll back synthetic entries", async () => {
  let command: any;
  const branch: any[] = [
    {
      type: "message",
      id: "original-leaf",
      parentId: null,
      timestamp: new Date().toISOString(),
      message: { role: "user", content: "current work" },
    },
  ];
  const navigations: Array<[string, unknown]> = [];
  const notifications: Array<[string, string]> = [];
  const pi = {
    registerCommand(_name: string, definition: unknown) {
      command = definition;
    },
    sendMessage(message: any, options: any) {
      if (message.customType === "session-handoff-rollback-anchor") {
        assert.deepEqual(options, { triggerTurn: false });
        branch.push({
          type: "custom_message",
          id: "rollback-anchor",
          parentId: "original-leaf",
          timestamp: new Date().toISOString(),
          ...message,
        });
        return;
      }
      assert.deepEqual(options, { triggerTurn: true });
      branch.push({
        type: "custom_message",
        id: "generation-marker",
        parentId: "rollback-anchor",
        timestamp: new Date().toISOString(),
        ...message,
      });
      branch.push(assistantEntry("failed", "", "error", "provider failed"));
    },
  } as any;
  const ctx = {
    mode: "tui",
    model: { id: "test-model" },
    sessionManager: {
      getSessionFile: () => "/tmp/parent.jsonl",
      getBranch: () => branch,
      getLeafId: () => branch.at(-1)?.id ?? null,
    },
    waitForIdle: async () => {},
    navigateTree: async (id: string, options: unknown) => {
      navigations.push([id, options]);
      return { cancelled: false };
    },
    ui: {
      editor: async () => assert.fail("failed generation must not open the editor"),
      notify: (message: string, level: string) => notifications.push([message, level]),
    },
  } as any;

  registerHandoffCommand(pi);
  await command.handler("", ctx);

  assert.deepEqual(navigations, [["rollback-anchor", { summarize: false }]]);
  assert.deepEqual(notifications.at(-1), ["Handoff failed: provider failed", "error"]);
});
