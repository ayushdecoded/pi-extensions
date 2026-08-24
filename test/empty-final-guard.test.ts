import assert from "node:assert/strict";
import { test } from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerEmptyFinalGuard } from "../src/empty-final-guard.ts";

function harness() {
  const handlers = new Map<string, Function>();
  const sent: Array<{ content: string; options: any }> = [];
  const warnings: string[] = [];
  const pi = {
    on(event: string, handler: Function) { handlers.set(event, handler); },
    async sendUserMessage(content: string, options?: any) { sent.push({ content, options }); },
  } as unknown as ExtensionAPI;
  registerEmptyFinalGuard(pi);
  return {
    handlers,
    sent,
    warnings,
    /** Simulate a settled turn; `messages` is the tail of the session branch. */
    settle(messages: any[], opts: { sessionFile?: string; pending?: boolean } = {}) {
      const ctx = {
        sessionManager: { getSessionFile: () => opts.sessionFile, getBranch: () => messages },
        hasPendingMessages: () => opts.pending ?? false,
        ui: { notify: (_m: string, level: string) => { if (level === "warning") warnings.push(_m); } },
      };
      return handlers.get("agent_settled")!({}, ctx);
    },
  };
}

const assistant = (stopReason: string, content: unknown[]) => ({
  type: "message",
  message: { role: "assistant", stopReason, content },
});
const userEntry = (text: string) => ({ type: "message", message: { role: "user", content: [{ type: "text", text }] } });
const toolResult = () => ({ type: "message", message: { role: "toolResult", content: [], toolCallId: "t1" } });

test("an empty stop completion triggers exactly one automatic follow-up", async () => {
  const h = harness();
  await h.settle([userEntry("do the thing"), assistant("stop", [])]);
  assert.equal(h.sent.length, 1);
  assert.match(h.sent[0]!.content, /final report/i);
  assert.equal(h.sent[0]!.options.deliverAs, "followUp");
});

test("a length-truncated empty completion also triggers the follow-up", async () => {
  const h = harness();
  await h.settle([userEntry("task"), assistant("length", [{ type: "text", text: "" }])]);
  assert.equal(h.sent.length, 1);
});

test("a healthy response never triggers anything and closes the retry episode", async () => {
  const h = harness();
  await h.settle([userEntry("task"), assistant("stop", [{ type: "text", text: "All done." }])]);
  assert.equal(h.sent.length, 0);

  // Episode bookkeeping: healthy turn after an empty one resets the guard.
  await h.settle([userEntry("task"), assistant("stop", [])]);
  await h.settle([userEntry("task"), assistant("stop", [{ type: "text", text: "Recovered." }])]);
  await h.settle([userEntry("task"), assistant("stop", [])]);
  assert.equal(h.sent.length, 2); // would be 1 if the flag had stayed set
  assert.equal(h.warnings.length, 0);
});

test("two consecutive empty completions warn instead of looping", async () => {
  const h = harness();
  const emptyTurn = [userEntry("task"), assistant("stop", [])];
  await h.settle(emptyTurn);
  await h.settle(emptyTurn);
  assert.equal(h.sent.length, 1);
  assert.equal(h.warnings.length, 1);
});

test("subagent child sessions are skipped entirely", async () => {
  const h = harness();
  await h.settle([userEntry("task"), assistant("stop", [])], {
    sessionFile: "/home/x/.pi/agent/subagent-sessions/01a-parent/2026-08-24T_child.jsonl",
  });
  assert.equal(h.sent.length, 0);
});

test("pending messages prevent racing the user", async () => {
  const h = harness();
  await h.settle([userEntry("task"), assistant("stop", [])], { pending: true });
  assert.equal(h.sent.length, 0);
});

test("non-assistant tails (user retyped, tool results pending) are ignored", async () => {
  const h = harness();
  await h.settle([assistant("stop", []), userEntry("hello?")]);
  await h.settle([assistant("toolUse", [{ type: "toolCall", id: "t1" }]), toolResult()]);
  assert.equal(h.sent.length, 0);
});

test("aborted or errored empty turns are not retried", async () => {
  const h = harness();
  await h.settle([userEntry("task"), assistant("aborted", [])]);
  await h.settle([userEntry("task"), assistant("error", [])]);
  assert.equal(h.sent.length, 0);
});
