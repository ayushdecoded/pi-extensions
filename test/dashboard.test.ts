import assert from "node:assert/strict";
import { test } from "node:test";
import { initTheme } from "@earendil-works/pi-coding-agent";
import { Markdown, Text, visibleWidth } from "@earendil-works/pi-tui";
import { AgentsDashboard, renderTranscript, TranscriptRenderer } from "../src/ui/dashboard.ts";
import { applyEvent, emptyRuntimeState } from "../src/runtime/state.ts";
import { ZERO_USAGE, type InvocationRecord } from "../src/runtime/types.ts";
import type { SubagentRuntime } from "../src/runtime/runtime.ts";

initTheme("dark", false);

const ansiTheme = { fg: (color: string, text: string) => `\x1b[3${color === "error" ? 1 : color === "success" ? 2 : color === "accent" ? 5 : 7}m${text}\x1b[0m` } as any;

test("lightweight transcript sanitizes and renders tool calls, useful results, errors, and running state", () => {
  const lines = renderTranscript([
    { role: "user", content: [{ type: "text", text: "hello\tthere\x1b]0;hidden title\x07" }] },
    { role: "assistant", content: [{ type: "toolCall", id: "running", name: "read", arguments: { path: "a\u001bb" } }] },
    { role: "toolResult", toolName: "read", isError: false, content: [{ type: "text", text: "\n ok\nignored" }] },
    { role: "toolResult", toolName: "bash", isError: true, content: [{ type: "text", text: "failed" }] },
  ], 40, ansiTheme);
  const output = lines.join("\n");
  assert.match(output, /> .*hello  there/);
  assert.match(output, /→ .*read.*running/);
  assert.match(output, /output: .*ok/);
  assert.match(output, /error: .*failed/);
  assert.doesNotMatch(output, /ignored|hidden title|\u001b(?!\[)/);
  assert.match(output, /\x1b\[/);
  assert.ok(lines.every((line) => visibleWidth(line) <= 40));
});

test("transcript uses native Markdown semantics and remains safe at narrow widths", () => {
  const lines = renderTranscript([
    { role: "user", content: [{ type: "text", text: "# Heading\n\n- **bold** item" }] },
    { role: "assistant", content: [{ type: "thinking", thinking: "> quoted `code`" }, { type: "text", text: "1. first\n2. second" }] },
  ], 12, ansiTheme);
  const plain = lines.join("\n").replace(/\x1b\[[0-9;]*m/g, "");
  assert.match(plain, /> Heading/);
  assert.match(plain, /- bold/);
  assert.match(plain, /item/);
  assert.match(plain, /~ │ quoted/);
  assert.match(plain, /1\. first/);
  assert.doesNotMatch(plain, /\*\*bold\*\*/);
  assert.ok(lines.every((line) => visibleWidth(line) <= 12));
});

test("transcript renderer caches immutable messages and reparses a streaming tail or changed tool completion", () => {
  const renderer = new TranscriptRenderer();
  const user = { role: "user", content: [{ type: "text", text: "hello" }] };
  const assistant = { role: "assistant", content: [{ type: "text", text: "answer" }, { type: "toolCall", id: "call", name: "read", arguments: {} }] };
  const original = Markdown.prototype.render;
  let markdownRenders = 0;
  Markdown.prototype.render = function(width: number): string[] {
    markdownRenders += 1;
    return original.call(this, width);
  };
  try {
    renderer.render([user, assistant], 40, ansiTheme);
    assert.equal(markdownRenders, 2);
    renderer.render([user, assistant], 40, ansiTheme);
    assert.equal(markdownRenders, 2, "immutable messages are reused");

    renderer.render([user, assistant, { role: "toolResult", toolCallId: "call", content: "ok" }], 40, ansiTheme);
    assert.equal(markdownRenders, 3, "tool completion invalidates its call summary message");

    renderer.render([user, assistant], 40, ansiTheme, true);
    renderer.render([user, assistant], 40, ansiTheme, true);
    assert.equal(markdownRenders, 5, "the live tail remains volatile");
  } finally {
    Markdown.prototype.render = original;
  }
});

test("live pending tool calls authoritatively invalidate running summaries", () => {
  const renderer = new TranscriptRenderer();
  const assistant = { role: "assistant", content: [
    { type: "toolCall", id: "one", name: "read", arguments: {} },
    { type: "toolCall", id: "two", name: "bash", arguments: {} },
  ] };
  const running = renderer.render([assistant], 50, ansiTheme, false, new Set(["one", "two"])).join("\n");
  assert.equal((running.match(/running/g) ?? []).length, 2);
  const oneSettled = renderer.render([assistant], 50, ansiTheme, false, new Set(["two"])).join("\n");
  assert.equal((oneSettled.match(/running/g) ?? []).length, 1);
  assert.match(oneSettled, /bash.*running/);
  const allSettled = renderer.render([assistant], 50, ansiTheme, false, new Set()).join("\n");
  assert.doesNotMatch(allSettled, /running/);
});

test("native transcript tools pair persisted results at the call and expand through Pi's renderer", () => {
  const tui = { terminal: { rows: 30 }, requestRender() {} } as any;
  const renderer = new TranscriptRenderer({ tui, cwd: process.cwd() });
  const messages = [
    { role: "assistant", content: [{ type: "toolCall", id: "read-1", name: "read", arguments: { path: "package.json" } }] },
    { role: "toolResult", toolCallId: "read-1", toolName: "read", isError: false, content: [{ type: "text", text: "one\ntwo" }], details: {} },
  ];
  const context = { source: "file:test", revision: "1" };
  const collapsed = stripAnsi(renderer.render(messages, 80, ansiTheme, false, undefined, context).join("\n"));
  assert.match(collapsed, /read .*package\.json/);
  assert.doesNotMatch(collapsed, /→|output:|one|two/, "collapsed output comes from Pi's read renderer, not the compact fallback");

  renderer.setToolsExpanded(true);
  const expanded = stripAnsi(renderer.render(messages, 80, ansiTheme, false, undefined, context).join("\n"));
  assert.match(expanded, /one/);
  assert.match(expanded, /two/);
  assert.equal((expanded.match(/one/g) ?? []).length, 1, "the paired tool result is not rendered again as a standalone row");
  assert.ok(expanded.split("\n").every((line) => visibleWidth(line) <= 80));
  renderer.dispose();
});

test("historical Bash output does not invent an execution duration", () => {
  const tui = { terminal: { rows: 30 }, requestRender() {} } as any;
  const renderer = new TranscriptRenderer({ tui, cwd: process.cwd() });
  const messages = [
    { role: "assistant", content: [{ type: "toolCall", id: "bash-history", name: "bash", arguments: { command: "sleep 5" } }] },
    { role: "toolResult", toolCallId: "bash-history", toolName: "bash", isError: false, content: [{ type: "text", text: "done" }], details: {} },
  ];
  const output = stripAnsi(renderer.render(messages, 80, ansiTheme, false, new Set(), {
    source: "file:bash-history", revision: "1", stableMessages: messages,
  }).join("\n"));
  assert.match(output, /\$ sleep 5/);
  assert.doesNotMatch(output, /Took 0\.0s|Elapsed/, "persisted messages have no timing data to report faithfully");
  renderer.dispose();
});

test("live custom tools use their definition, update partial results, and reuse settled components", () => {
  const tui = { terminal: { rows: 30 }, requestRender() {} } as any;
  const renderer = new TranscriptRenderer({ tui, cwd: process.cwd() });
  let callRenders = 0;
  let resultRenders = 0;
  const definition = {
    name: "custom_live",
    label: "custom live",
    description: "test",
    parameters: {},
    async execute() { return { content: [], details: {} }; },
    renderCall(args: any) {
      callRenders += 1;
      return new Text(`native-call:${args.value}`, 0, 0);
    },
    renderResult(result: any, options: any) {
      resultRenders += 1;
      return new Text(`native-result:${result.content[0]?.text}:${options.isPartial ? "partial" : "final"}`, 0, 0);
    },
  } as any;
  const messages = [{ role: "assistant", content: [{ type: "toolCall", id: "custom-1", name: "custom_live", arguments: { value: "old" } }] }];
  const liveTools = new Map<string, any>([["custom-1", {
    toolCallId: "custom-1",
    toolName: "custom_live",
    args: { value: "now" },
    executionStarted: true,
    argsComplete: true,
    result: { content: [{ type: "text", text: "working" }], details: {}, isError: false },
    isPartial: true,
    revision: 1,
  }]]);
  const context = {
    source: "live:test",
    revision: "1",
    liveTools,
    getToolDefinition: () => definition,
  };
  const first = stripAnsi(renderer.render(messages, 80, ansiTheme, false, new Set(["custom-1"]), context).join("\n"));
  assert.match(first, /native-call:now/);
  assert.match(first, /native-result:working:partial/);
  const counts = [callRenders, resultRenders];
  renderer.render(messages, 80, ansiTheme, false, new Set(["custom-1"]), context);
  assert.deepEqual([callRenders, resultRenders], counts, "unchanged transcript reuses its assembled native lines");

  liveTools.set("custom-1", {
    ...liveTools.get("custom-1"),
    result: { content: [{ type: "text", text: "done" }], details: {}, isError: false },
    isPartial: false,
    revision: 2,
  });
  const final = stripAnsi(renderer.render(messages, 80, ansiTheme, false, new Set(), { ...context, revision: "2" }).join("\n"));
  assert.match(final, /native-result:done:final/);

  liveTools.set("custom-1", {
    ...liveTools.get("custom-1"),
    result: { content: [{ type: "image", data: "not-real", mimeType: "image/webp" }], details: {}, isError: false },
    revision: 3,
  });
  const image = stripAnsi(renderer.render(messages, 80, ansiTheme, false, new Set(), { ...context, revision: "3" }).join("\n"));
  assert.match(image, /image omitted in transcript viewer/, "disabled images are filtered before Pi can decode or convert them");

  const historicalMessages = [...messages, {
    role: "toolResult", toolCallId: "custom-1", toolName: "custom_live", content: [{ type: "text", text: "durable" }], isError: false,
  }];
  const historical = stripAnsi(renderer.render(historicalMessages, 80, ansiTheme, false, undefined, { source: "file:test", revision: "4" }).join("\n"));
  assert.match(historical, /→ custom_live/);
  assert.match(historical, /durable/);
  assert.doesNotMatch(historical, /native-call|native-result/, "live custom definitions are not reused for historical calls");
  renderer.dispose();
});

test("historical custom tools stay compact, sanitized, paired, and expandable", () => {
  const tui = { terminal: { rows: 30 }, requestRender() {} } as any;
  const renderer = new TranscriptRenderer({ tui, cwd: process.cwd() });
  const messages = [
    { role: "assistant", content: [{ type: "toolCall", id: "old-custom", name: "custom_old", arguments: { task: "safe\x1b]0;bad\x07" } }] },
    { role: "toolResult", toolCallId: "old-custom", toolName: "custom_old", isError: false, content: [
      { type: "text", text: "first\nsecond\x1b]0;also-bad\x07" },
      { type: "image", data: "not-real", mimeType: "image/webp" },
    ] },
  ];
  const context = { source: "file:old", revision: "1" };
  const collapsed = stripAnsi(renderer.render(messages, 60, ansiTheme, false, undefined, context).join("\n"));
  assert.match(collapsed, /→ custom_old/);
  assert.match(collapsed, /first/);
  assert.doesNotMatch(collapsed, /second|bad|also-bad/);

  renderer.setToolsExpanded(true);
  const expanded = stripAnsi(renderer.render(messages, 60, ansiTheme, false, undefined, context).join("\n"));
  assert.match(expanded, /"task": "safe"/);
  assert.match(expanded, /second/);
  assert.match(expanded, /image omitted/);
  assert.doesNotMatch(expanded, /bad|also-bad|\x1b\]/);
  renderer.dispose();
});

test("result-less historical calls are settled, with built-ins still native", () => {
  const tui = { terminal: { rows: 30 }, requestRender() {} } as any;
  const renderer = new TranscriptRenderer({ tui, cwd: process.cwd() });
  const messages = [{ role: "assistant", content: [
    { type: "toolCall", id: "orphan-read", name: "read", arguments: { path: "missing.txt" } },
    { type: "toolCall", id: "orphan-custom", name: "custom_old", arguments: {} },
  ] }];
  const output = stripAnsi(renderer.render(messages, 80, ansiTheme, false, new Set(), {
    source: "file:orphan", revision: "1", stableMessages: messages,
  }).join("\n"));
  assert.match(output, /read .*missing\.txt/);
  assert.doesNotMatch(output, /→ read|running/);
  assert.match(output, /→ custom_old/);
  renderer.dispose();
});

test("replaced persisted results invalidate native component lines", () => {
  const tui = { terminal: { rows: 30 }, requestRender() {} } as any;
  const renderer = new TranscriptRenderer({ tui, cwd: process.cwd() });
  const assistant = { role: "assistant", content: [{ type: "toolCall", id: "read-replace", name: "read", arguments: { path: "file.txt" } }] };
  const firstMessages = [assistant, {
    role: "toolResult", toolCallId: "read-replace", toolName: "read", content: [{ type: "text", text: "before" }], details: {}, isError: false,
  }];
  renderer.setToolsExpanded(true);
  assert.match(stripAnsi(renderer.render(firstMessages, 80, ansiTheme, false, new Set(), {
    source: "file:replace", revision: "1", stableMessages: firstMessages,
  }).join("\n")), /before/);
  const nextMessages = [assistant, {
    role: "toolResult", toolCallId: "read-replace", toolName: "read", content: [{ type: "text", text: "after" }], details: {}, isError: false,
  }];
  const updated = stripAnsi(renderer.render(nextMessages, 80, ansiTheme, false, new Set(), {
    source: "file:replace", revision: "2", stableMessages: nextMessages,
  }).join("\n"));
  assert.match(updated, /after/);
  assert.doesNotMatch(updated, /before/);
  renderer.dispose();
});

test("same-ID history replacement refreshes native name, arguments, and result", () => {
  const tui = { terminal: { rows: 30 }, requestRender() {} } as any;
  const renderer = new TranscriptRenderer({ tui, cwd: process.cwd() });
  renderer.setToolsExpanded(true);
  const oldMessages = [
    { role: "assistant", content: [{ type: "toolCall", id: "reused", name: "read", arguments: { path: "old.txt" } }] },
    { role: "toolResult", toolCallId: "reused", toolName: "read", content: [{ type: "text", text: "OLD_RESULT" }], details: {}, isError: false },
  ];
  renderer.render(oldMessages, 80, ansiTheme, false, new Set(), { source: "live:reuse", revision: "1", stableMessages: oldMessages });

  const newArgs = [{ role: "assistant", content: [{ type: "toolCall", id: "reused", name: "read", arguments: { path: "new.txt" } }] }];
  const refreshed = stripAnsi(renderer.render(newArgs, 80, ansiTheme, false, new Set(), {
    source: "live:reuse", revision: "2", stableMessages: newArgs,
  }).join("\n"));
  assert.match(refreshed, /new\.txt/);
  assert.doesNotMatch(refreshed, /old\.txt|OLD_RESULT/);

  const changedTool = [
    { role: "assistant", content: [{ type: "toolCall", id: "reused", name: "bash", arguments: { command: "printf NEW" } }] },
    { role: "toolResult", toolCallId: "reused", toolName: "bash", content: [{ type: "text", text: "NEW" }], details: {}, isError: false },
  ];
  const changed = stripAnsi(renderer.render(changedTool, 80, ansiTheme, false, new Set(), {
    source: "live:reuse", revision: "3", stableMessages: changedTool,
  }).join("\n"));
  assert.match(changed, /\$ printf NEW/);
  assert.doesNotMatch(changed, /read new\.txt/);
  renderer.dispose();
});

test("parallel tool results are paired in assistant source order", () => {
  const messages = [
    { role: "assistant", content: [
      { type: "toolCall", id: "one", name: "custom_one", arguments: {} },
      { type: "toolCall", id: "two", name: "custom_two", arguments: {} },
    ] },
    { role: "toolResult", toolCallId: "two", toolName: "custom_two", content: [{ type: "text", text: "result-two" }], isError: true },
    { role: "toolResult", toolCallId: "one", toolName: "custom_one", content: [{ type: "text", text: "result-one" }], isError: false },
  ];
  const output = stripAnsi(renderTranscript(messages, 80, ansiTheme).join("\n"));
  const one = output.indexOf("custom_one");
  const oneResult = output.indexOf("result-one");
  const two = output.indexOf("custom_two");
  const twoResult = output.indexOf("result-two");
  assert.ok(one >= 0 && one < oneResult && oneResult < two && two < twoResult);
  assert.match(output, /error: result-two/);
  assert.equal((output.match(/result-one/g) ?? []).length, 1);
  assert.equal((output.match(/result-two/g) ?? []).length, 1);
});

test("same-source history replacement evicts obsolete native components", () => {
  const tui = { terminal: { rows: 30 }, requestRender() {} } as any;
  const renderer = new TranscriptRenderer({ tui, cwd: process.cwd() });
  const transcript = (id: string) => [
    { role: "assistant", content: [{ type: "toolCall", id, name: "read", arguments: { path: `${id}.txt` } }] },
    { role: "toolResult", toolCallId: id, toolName: "read", content: [{ type: "text", text: id }], details: {}, isError: false },
  ];
  const first = transcript("old-call");
  renderer.render(first, 60, ansiTheme, false, new Set(), { source: "live:compact", revision: "1", stableMessages: first });
  const entries = (renderer as any).nativeTools.entries as Map<string, unknown>;
  assert.equal(entries.has("old-call"), true);
  const replacement = transcript("new-call");
  renderer.render(replacement, 60, ansiTheme, false, new Set(), { source: "live:compact", revision: "2", stableMessages: replacement });
  assert.equal(entries.has("old-call"), false);
  assert.equal(entries.has("new-call"), true);
  renderer.dispose();
});

test("collapsed fallback bounds very large scalar payloads", () => {
  const huge = `visible${"x".repeat(200_000)}tail`;
  const output = stripAnsi(renderTranscript([
    { role: "assistant", content: [{ type: "toolCall", id: "huge", name: "custom_huge", arguments: { value: huge } }] },
    { role: "toolResult", toolCallId: "huge", toolName: "custom_huge", content: [{ type: "text", text: huge }], isError: false },
  ], 60, ansiTheme).join("\n"));
  assert.ok(output.length < 300);
  assert.match(output, /visible/);
  assert.doesNotMatch(output, /tail/);
});

test("native renderer invalidation escapes the transcript line cache", () => {
  let rerenders = 0;
  let invalidate: (() => void) | undefined;
  let label = "before";
  const tui = { terminal: { rows: 30 }, requestRender() { rerenders += 1; } } as any;
  const renderer = new TranscriptRenderer({ tui, cwd: process.cwd() });
  const definition = {
    name: "async_custom",
    label: "async custom",
    description: "test",
    parameters: {},
    async execute() { return { content: [], details: {} }; },
    renderCall(_args: any, _theme: any, context: any) {
      invalidate = context.invalidate;
      const text = context.lastComponent ?? new Text("", 0, 0);
      text.setText(label);
      return text;
    },
  } as any;
  const messages = [{ role: "assistant", content: [{ type: "toolCall", id: "async-1", name: "async_custom", arguments: {} }] }];
  const liveTools = new Map<string, any>([["async-1", {
    toolCallId: "async-1", toolName: "async_custom", args: {}, executionStarted: true, argsComplete: true, isPartial: true, revision: 1,
  }]]);
  const context = { source: "live:async", revision: "1", liveTools, getToolDefinition: () => definition };
  assert.match(stripAnsi(renderer.render(messages, 60, ansiTheme, false, new Set(["async-1"]), context).join("\n")), /before/);
  label = "after";
  invalidate?.();
  assert.equal(rerenders, 1);
  assert.match(stripAnsi(renderer.render(messages, 60, ansiTheme, false, new Set(["async-1"]), context).join("\n")), /after/);
  renderer.dispose();
});

test("discarding a partial native bash tool clears its elapsed-time interval", () => {
  const tui = { terminal: { rows: 30 }, requestRender() {} } as any;
  const renderer = new TranscriptRenderer({ tui, cwd: process.cwd() });
  const messages = [{ role: "assistant", content: [{ type: "toolCall", id: "bash-live", name: "bash", arguments: { command: "sleep 1" } }] }];
  const liveTools = new Map<string, any>([["bash-live", {
    toolCallId: "bash-live",
    toolName: "bash",
    args: { command: "sleep 1" },
    executionStarted: true,
    argsComplete: true,
    result: { content: [{ type: "text", text: "working" }], details: {}, isError: false },
    isPartial: true,
    revision: 1,
  }]]);
  renderer.render(messages, 60, ansiTheme, false, new Set(["bash-live"]), { source: "live:bash", revision: "1", liveTools });
  const entry = (renderer as any).nativeTools.entries.get("bash-live");
  assert.ok(entry.component.rendererState.interval, "Pi's partial bash renderer started its elapsed-time interval");
  renderer.dispose();
  assert.equal(entry.component.rendererState.interval, undefined, "adapter finalization cleared the native interval");
});

test("tree navigation keeps selected index and invocation identity synchronized", () => {
  const state = emptyRuntimeState();
  applyEvent(state, { type: "batch.started", batch: { id: "batch", createdAt: 1 } });
  for (let index = 0; index < 3; index++) {
    applyEvent(state, { type: "invocation.queued", invocation: invocation("batch", index) });
  }
  const runtime = { state, activities: new Map(), liveSessions: new Map(), options: { cwd: "/tmp" }, subscribe: () => () => {} } as unknown as SubagentRuntime;
  const tui = { terminal: { rows: 20 }, requestRender() {} } as any;
  const keybindings = { matches: (data: string, binding: string) =>
    (data === "confirm" && binding === "tui.select.confirm") ||
    (data === "down" && binding === "tui.select.down") } as any;
  const dashboard = new AgentsDashboard(runtime, tui, ansiTheme, keybindings, () => {});
  const batches = dashboard.render(120).map(stripAnsi).join("\n");
  dashboard.handleInput("down");
  assert.equal((dashboard as any).selectedIndex, 1);
  assert.equal((dashboard as any).selectedInvocationId, "inv-1");
  const rendered = dashboard.render(80);
  dashboard.dispose();
  const output = rendered.join("\n");
  const plain = stripAnsi(output);
  assert.match(batches, /Atlas×3.*0 tok/, "batch headings summarize their nested agents and totals");
  assert.match(output, /❯.*Atlas/);
  assert.match(plain, /secret-1.*·  ·.*running/, "agent rows connect their task preview to metrics");
  assert.ok(rendered.every((line) => visibleWidth(line) <= 80));
});

test("generated call and request headings enrich existing batch, tree, and viewer layouts", () => {
  const state = emptyRuntimeState();
  applyEvent(state, { type: "batch.started", batch: { id: "batch", createdAt: 1 } });
  applyEvent(state, { type: "delegation.started", call: { id: "root", batchId: "batch", createdAt: 1 } });
  applyEvent(state, { type: "agent.created", agent: { handle: "agent-0", role: "Atlas", sessionFile: "/tmp/missing-heading-test", createdAt: 1 } });
  applyEvent(state, { type: "invocation.queued", invocation: {
    ...invocation("batch", 0), callId: "root", requestIndex: 0, heading: "Map Existing CRM APIs",
  } });
  applyEvent(state, {
    type: "delegation.headings", callId: "root", callHeading: "CRM API Contract Research",
    requestHeadings: [{ invocationId: "inv-0", heading: "Map Existing CRM APIs" }],
  });
  applyEvent(state, {
    type: "delegation.started",
    call: { id: "nested", batchId: "batch", parentInvocationId: "inv-0", createdAt: 2 },
  });
  applyEvent(state, { type: "invocation.queued", invocation: {
    ...invocation("batch", 1), callId: "nested", requestIndex: 0, parentInvocationId: "inv-0",
    heading: "Inspect Contact Contracts",
  } });
  applyEvent(state, {
    type: "delegation.headings", callId: "nested", callHeading: "Atlas Nested Contract Inspection",
    requestHeadings: [{ invocationId: "inv-1", heading: "Inspect Contact Contracts" }],
  });
  const runtime = { state, activities: new Map(), liveSessions: new Map(), options: { cwd: "/tmp" }, subscribe: () => () => {} } as unknown as SubagentRuntime;
  const tui = { terminal: { rows: 20 }, requestRender() {} } as any;
  const keybindings = { matches: (data: string, binding: string) => data === "confirm" && binding === "tui.select.confirm" } as any;
  const dashboard = new AgentsDashboard(runtime, tui, ansiTheme, keybindings, () => {});

  const tree = stripAnsi(dashboard.render(100).join("\n"));
  assert.match(tree, /CRM API Contract Research/);
  assert.match(tree, /Map Existing CRM APIs/);
  assert.match(tree, /› Nested Contract Inspection/);
  assert.doesNotMatch(tree, /Atlas Nested Contract Inspection/);
  assert.match(tree, /Inspect Contact Contracts/);
  assert.match(tree, /└─.*Atlas[\s\S]*› Nested Contract Inspection[\s\S]*└─.*Atlas/, "call captions do not become false agent parents");
  assert.doesNotMatch(tree, /secret-0|secret-1/);
  dashboard.handleInput("confirm");
  assert.match(stripAnsi(dashboard.render(80)[0] ?? ""), /╭─+ Map Existing CRM APIs ─+╮/);
  dashboard.dispose();
});

test("viewer adapts narrow chrome and reuses its assembled transcript body while scrolling", () => {
  const state = emptyRuntimeState();
  applyEvent(state, { type: "batch.started", batch: { id: "batch", createdAt: 1 } });
  applyEvent(state, { type: "agent.created", agent: { handle: "agent-0", role: "Atlas", sessionFile: "/tmp/unused", createdAt: 1 } });
  applyEvent(state, { type: "invocation.queued", invocation: invocation("batch", 0) });
  const runtime = {
    state,
    activities: new Map(),
    liveSessions: new Map([["agent-0", {
      messages: [{ role: "assistant", content: [{ type: "text", text: "**committed**" }] }],
      state: {
        streamingMessage: { role: "assistant", content: [{ type: "text", text: "partial one\n\ntwo\n\nthree" }] },
        pendingToolCalls: new Set<string>(),
      },
    }]]),
    options: { cwd: "/tmp" },
    subscribe: () => () => {},
    subscribeTranscript: () => () => {},
    transcriptRevision: () => 1,
  } as unknown as SubagentRuntime;
  const tui = { terminal: { rows: 12 }, requestRender() {} } as any;
  const keybindings = {
    matches: (data: string, binding: string) =>
      (data === "confirm" && binding === "tui.select.confirm") ||
      (data === "down" && binding === "tui.select.down") ||
      (data === "custom-expand" && binding === "app.tools.expand"),
    getEffectiveConfig: () => ({ "app.tools.expand": "alt+x" }),
  } as any;
  const dashboard = new AgentsDashboard(runtime, tui, ansiTheme, keybindings, () => {});
  dashboard.handleInput("confirm");
  const first = dashboard.render(24);
  const plainFirst = first.map(stripAnsi);
  assert.match(plainFirst[0] ?? "", /╭─+ secret-0 ─+╮/, "request heading is centered in the existing viewer border");
  assert.ok(plainFirst.some((line) => line.startsWith(" │  ") && line.endsWith("  │ ")), "viewer content has outer and inner horizontal padding");
  const body = (dashboard as any).transcriptBodyCache.lines;
  dashboard.handleInput("down");
  const second = dashboard.render(24);
  assert.strictEqual((dashboard as any).transcriptBodyCache.lines, body);
  dashboard.handleInput("custom-expand");
  dashboard.render(60);
  assert.equal((dashboard as any).toolsExpanded, true, "the configured app.tools.expand binding toggles native tools");
  assert.equal((dashboard as any).transcriptBodyCache.width, 52, "wide viewer reserves margins, borders, and two columns of inner padding");
  assert.match((dashboard as any).viewerHints(60), /alt\+x collapse tools/);
  assert.match(body.join("\n"), /committed/);
  assert.match(body.join("\n"), /partial/);
  assert.ok([...first, ...second].every((line) => visibleWidth(line) <= 24));
  assert.match(first.at(-1) ?? "", /Esc/);
  assert.doesNotMatch(first[1] ?? "", /running|\?/);
  dashboard.dispose();
});

test("dashboard budgets cards around a visible selection and footer and honors configured keys", () => {
  const state = emptyRuntimeState();
  for (let index = 0; index < 8; index++) {
    const id = `batch-${index}`;
    applyEvent(state, { type: "batch.started", batch: { id, createdAt: index } });
    applyEvent(state, { type: "invocation.queued", invocation: invocation(id, index) });
  }
  const runtime = { state, activities: new Map(), liveSessions: new Map(), options: { cwd: "/tmp" }, subscribe: () => () => {} } as unknown as SubagentRuntime;
  const tui = { terminal: { rows: 10 }, requestRender() {} } as any;
  const keybindings = { matches: (data: string, binding: string) => data === "custom-down" && binding === "tui.select.down" } as any;
  const dashboard = new AgentsDashboard(runtime, tui, ansiTheme, keybindings, () => {});
  dashboard.handleInput("custom-down");
  assert.equal((dashboard as any).selectedIndex, 1);
  dashboard.handleInput("\x1b[B"); // Raw Down is not forced when the configured manager rejects it.
  assert.equal((dashboard as any).selectedIndex, 1);
  dashboard.handleInput("\x1b[97;1:3u");
  assert.equal((dashboard as any).selectedIndex, 1);
  (dashboard as any).selectedIndex = 7;
  const lines = dashboard.render(18);
  assert.equal(lines.length, 8);
  assert.ok(lines.some((line) => line.includes("❯")), "selected card remains visible");
  assert.ok(lines.some((line) => line.includes("select")), "controls remain visible");
  assert.ok(lines.every((line) => visibleWidth(line) <= 18));
  dashboard.dispose();
});

function stripAnsi(value: string): string {
  return value.replace(/\x1b\[[0-9;:]*m/g, "");
}

function invocation(batchId: string, index: number): InvocationRecord {
  return { id: `inv-${index}`, batchId, agent: `agent-${index}`, role: "Atlas", task: `secret-${index}`, followup: false, ordinal: 1, depth: 0, status: "running", queuedAt: 1, startedAt: 1, timeoutMinutes: 10, usage: { ...ZERO_USAGE } };
}
