import assert from "node:assert/strict";
import test from "node:test";
import {
  SessionManager, compact, convertToLlm, generateSummaryWithUsage, sessionEntryToContextMessages,
  type CompactionResult, type ContextEvent,
  type ExtensionAPI, type ExtensionContext, type SessionBeforeCompactEvent,
  type SessionBeforeTreeEvent, type BeforeProviderRequestEvent,
} from "@earendil-works/pi-coding-agent";
import { convertResponsesMessages } from "@earendil-works/pi-ai/api/openai-responses-shared";
import type {
  Api, AssistantMessage, Message, Model, ToolResultMessage, Usage,
} from "@earendil-works/pi-ai";
import type { CodexCompactionArtifact } from "../src/compaction/codex-transport.ts";
import { registerServerCompaction, type ServerCompactionDependencies } from "../src/compaction/server-compaction.ts";

type AgentMessage = ContextEvent["messages"][number];
type ContextEventResult = { messages?: AgentMessage[] };
type SessionBeforeCompactResult = { cancel?: boolean; compaction?: CompactionResult };
type Remote = NonNullable<ServerCompactionDependencies["remote"]>;
type Summarize = typeof generateSummaryWithUsage;
type NativeCompact = typeof compact;
type RemoteOptions = Parameters<Remote>[0];
type ResponsesInput = ReturnType<typeof convertResponsesMessages>;
type SummaryArguments = Parameters<Summarize>;
type NativeArguments = Parameters<NativeCompact>;
type Handler = (event: unknown, ctx: ExtensionContext) => unknown | Promise<unknown>;
type CheckpointDetails = {
  type: "codex-server-compaction";
  artifact: CodexCompactionArtifact;
  sourceEntryIds: string[];
  previousCompactionId?: string;
};

const usage: Usage = {
  input: 10, output: 4, cacheRead: 0, cacheWrite: 0, totalTokens: 14,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};
const artifact = (id: string): CodexCompactionArtifact => ({ type: "compaction", id, encrypted_content: `ciphertext-${id}` });

function isCheckpointDetails(value: unknown): value is CheckpointDetails {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Record<string, unknown>;
  const savedArtifact = candidate.artifact;
  return candidate.type === "codex-server-compaction" && Array.isArray(candidate.sourceEntryIds) &&
    candidate.sourceEntryIds.every((entry): entry is string => typeof entry === "string") &&
    typeof savedArtifact === "object" && savedArtifact !== null &&
    (savedArtifact as Record<string, unknown>).type === "compaction" &&
    typeof (savedArtifact as Record<string, unknown>).encrypted_content === "string";
}

function checkpointDetails(entry: { details?: unknown }): CheckpointDetails {
  assert.ok(isCheckpointDetails(entry.details), "expected valid checkpoint details");
  return entry.details;
}

function model(provider = "openai-codex", id = "gpt-test"): Model<Api> {
  const api: Api = provider === "openai-codex" ? "openai-codex-responses" : "openai-responses";
  return {
    id, name: id, api, provider, baseUrl: "https://example.test/backend-api", reasoning: true, input: ["text"],
    cost: { input: 1, output: 1, cacheRead: 1, cacheWrite: 1 }, contextWindow: 100_000, maxTokens: 10_000,
  };
}

function user(text: string): Message {
  return { role: "user", content: text, timestamp: 1 };
}
function assistantCall(id: string, q: string, currentModel: Model<Api>): AssistantMessage {
  return {
    role: "assistant", content: [{ type: "toolCall", id: `${id}|fc_${id}`, name: "lookup", arguments: { q } }],
    api: currentModel.api, provider: currentModel.provider, model: currentModel.id, usage, stopReason: "toolUse", timestamp: 2,
  };
}
function toolResult(id: string, text: string): ToolResultMessage {
  return { role: "toolResult", toolCallId: `${id}|fc_${id}`, toolName: "lookup", content: [{ type: "text", text }], isError: false, timestamp: 3 };
}

function makeHarness(child = false) {
  const sessionManager = SessionManager.inMemory("/tmp/server-compaction-test",
    child ? { parentSession: "parent-session" } : undefined);
  let currentModel = model();
  let account = "acct-test";
  const handlers = new Map<string, Handler>();
  const remoteCalls: RemoteOptions[] = [];
  const summaryCalls: SummaryArguments[] = [];
  const nativeCalls: NativeArguments[] = [];
  const notices: string[] = [];
  let remoteCount = 0;
  let aborted = 0;
  let remote: Remote = async (_options) => {
    remoteCount += 1;
    return { artifact: artifact(`remote-${remoteCount}`), usage };
  };
  const summarize: Summarize = async (...args) => {
    summaryCalls.push(args);
    return { text: `plaintext fallback ${summaryCalls.length}`, usage };
  };
  const nativeCompact: NativeCompact = async (...args) => {
    nativeCalls.push(args);
    const [preparation] = args;
    return { summary: "native readable summary", firstKeptEntryId: preparation.firstKeptEntryId, tokensBefore: preparation.tokensBefore, usage };
  };
  const modelRegistry = {
    getApiKeyAndHeaders: async () => ({ ok: true as const, apiKey: "test-token", headers: { "ChatGPT-Account-ID": account } }),
    getProvider: () => ({ streamSimple: () => { throw new Error("unexpected live provider call"); } }),
  };
  const ctx = {
    ui: { notify: (message: string) => notices.push(message) }, mode: "print", hasUI: false,
    cwd: "/tmp/server-compaction-test", sessionManager,
    modelRegistry: modelRegistry as unknown as ExtensionContext["modelRegistry"], scopedModels: [],
    get model() { return currentModel; }, set model(value: Model<Api> | undefined) { if (value) currentModel = value; },
    thinkingLevel: "off", signal: undefined, isIdle: () => true, isProjectTrusted: () => true,
    abort: () => { aborted += 1; }, hasPendingMessages: () => false, shutdown: () => undefined,
    getContextUsage: () => undefined, compact: () => undefined, getSystemPrompt: () => "system prompt",
  } as unknown as ExtensionContext;
  const pi = {
    on: (event: string, handler: Handler) => handlers.set(event, handler),
    appendEntry: (type: string, data: unknown) => { sessionManager.appendCustomEntry(type, data); },
    getActiveTools: () => [], getAllTools: () => [], sendMessage: () => undefined,
  } as unknown as ExtensionAPI;
  const remoteDependency: Remote = async (options) => {
    remoteCalls.push(options);
    return remote(options);
  };
  registerServerCompaction(pi, { remote: remoteDependency, summarize, nativeCompact });
  return {
    sessionManager, handlers, ctx, remoteCalls, summaryCalls, nativeCalls, notices,
    get remote(): Remote { return remote; }, set remote(value: Remote) { remote = value; },
    get model(): Model<Api> { return currentModel; }, set model(value: Model<Api>) { currentModel = value; },
    get account(): string { return account; }, set account(value: string) { account = value; },
    get aborted(): number { return aborted; },
  };
}

function addConversation(h: ReturnType<typeof makeHarness>, prefix: string) {
  const sm = h.sessionManager;
  const current = h.model;
  const oldUser = sm.appendMessage(user(`${prefix} user constraint: preserve this exact requirement`));
  const oldCall = sm.appendMessage(assistantCall(`${prefix}-old`, "discarded", current));
  const oldTool = sm.appendMessage(toolResult(`${prefix}-old`, `${prefix} discarded result`));
  const keptUser = sm.appendMessage(user(`${prefix} retain user`));
  const keptCall = sm.appendMessage(assistantCall(`${prefix}-keep`, "retain", current));
  const keptTool = sm.appendMessage(toolResult(`${prefix}-keep`, `${prefix} retained tool output`));
  return { oldUser, oldCall, oldTool, keptUser, keptCall, keptTool };
}

function preparation(h: ReturnType<typeof makeHarness>, firstKeptEntryId: string): SessionBeforeCompactEvent["preparation"] {
  const branch = h.sessionManager.getBranch();
  const cut = branch.findIndex((entry) => entry.id === firstKeptEntryId);
  return {
    firstKeptEntryId,
    messagesToSummarize: branch.slice(0, cut).flatMap(sessionEntryToContextMessages),
    turnPrefixMessages: [], isSplitTurn: false, tokensBefore: 9000,
    fileOps: { read: new Set(["README.md"]), edited: new Set(["src/changed.ts"]), written: new Set(["src/new.ts"]) },
    settings: { enabled: true, reserveTokens: 4096, keepRecentTokens: 1000 },
  };
}

async function emit<T>(h: ReturnType<typeof makeHarness>, eventName: string, event: unknown): Promise<T> {
  const handler = h.handlers.get(eventName);
  assert.ok(handler, `missing ${eventName} handler`);
  return await handler(event, h.ctx) as T;
}

async function compactOnce(h: ReturnType<typeof makeHarness>, firstKeptEntryId: string,
  reason: "manual" | "threshold" | "overflow" = "manual", signal = new AbortController().signal) {
  const event: SessionBeforeCompactEvent = {
    type: "session_before_compact", preparation: preparation(h, firstKeptEntryId),
    branchEntries: h.sessionManager.getBranch(), reason, willRetry: reason === "overflow", signal,
  };
  const result = await emit<SessionBeforeCompactResult | undefined>(h, "session_before_compact", event);
  if (result?.compaction) {
    h.sessionManager.appendCompaction(result.compaction.summary, result.compaction.firstKeptEntryId,
      result.compaction.tokensBefore, result.compaction.details, true, result.compaction.usage);
  }
  return result;
}

const expectedOldInput = (prefix: string) => [
  { role: "user", content: [{ type: "input_text", text: `${prefix} user constraint: preserve this exact requirement` }] },
  { type: "function_call", id: `fc_${prefix}-old`, call_id: `${prefix}-old`, name: "lookup", arguments: '{"q":"discarded"}' },
  { type: "function_call_output", call_id: `${prefix}-old`, output: `${prefix} discarded result` },
];
const expectedKeptInput = (prefix: string) => [
  { role: "user", content: [{ type: "input_text", text: `${prefix} retain user` }] },
  { type: "function_call", id: `fc_${prefix}-keep`, call_id: `${prefix}-keep`, name: "lookup", arguments: '{"q":"retain"}' },
  { type: "function_call_output", call_id: `${prefix}-keep`, output: `${prefix} retained tool output` },
];

function summaryText(call: SummaryArguments): string {
  const message = call[0][0];
  assert.ok(message);
  assert.equal(message.role, "user");
  return typeof message.content === "string"
    ? message.content
    : message.content.filter((block) => block.type === "text").map((block) => block.text).join("");
}

function inputPayload(value: unknown): value is { input: ResponsesInput } {
  if (typeof value !== "object" || value === null || !("input" in value)) return false;
  return Array.isArray(value.input);
}

async function contextAndProviderRequest(h: ReturnType<typeof makeHarness>) {
  const messages = h.sessionManager.buildSessionContext().messages;
  const contextResult = await emit<ContextEventResult | undefined>(h, "context", { type: "context", messages } satisfies ContextEvent);
  assert.ok(contextResult);
  const contextMessages = contextResult.messages;
  assert.ok(contextMessages);
  const payload = {
    input: convertResponsesMessages(h.model, { messages: convertToLlm(contextMessages) },
      new Set(["openai", "openai-codex"]), { includeSystemPrompt: false }),
  } satisfies BeforeProviderRequestEvent["payload"];
  const requestResult = await emit<unknown>(h, "before_provider_request", { type: "before_provider_request", payload });
  assert.ok(inputPayload(requestResult));
  return { contextResult: { messages: contextMessages }, payload, requestResult };
}

test("uses remote Codex compaction for manual, proactive-threshold, and overflow triggers", async () => {
  for (const reason of ["manual", "threshold", "overflow"] as const) {
    const h = makeHarness(reason === "threshold");
    const entries = addConversation(h, "case");
    const result = await compactOnce(h, entries.keptUser, reason);
    assert.ok(result, reason);
    assert.ok(result.compaction, reason);
    if (reason === "threshold") assert.equal(h.sessionManager.getHeader()?.parentSession, "parent-session");
    assert.equal(h.remoteCalls.length, 1, reason);
    assert.equal(h.summaryCalls.length, 0, reason);
    assert.equal(result.compaction.firstKeptEntryId, entries.keptUser, reason);
    assert.deepEqual(checkpointDetails(result.compaction).sourceEntryIds,
      [entries.oldUser, entries.oldCall, entries.oldTool], reason);
  }
});

test("keeps retained messages while replacing only the serialized compaction marker with the artifact", async () => {
  const h = makeHarness();
  const entries = addConversation(h, "case");
  await compactOnce(h, entries.keptUser);
  const { contextResult, payload, requestResult } = await contextAndProviderRequest(h);
  const summary = h.sessionManager.getBranch().find((entry) => entry.type === "compaction")!.summary;
  assert.deepEqual(contextResult.messages.slice(1), sessionEntryToContextMessages(h.sessionManager.getEntry(entries.keptUser)!)
    .concat(sessionEntryToContextMessages(h.sessionManager.getEntry(entries.keptCall)!))
    .concat(sessionEntryToContextMessages(h.sessionManager.getEntry(entries.keptTool)!)));
  assert.deepEqual(payload.input, [
    { role: "user", content: [{ type: "input_text", text: `The conversation history before this point was compacted into the following summary:\n\n<summary>\n${summary}\n</summary>` }] },
    ...expectedKeptInput("case"),
  ]);
  assert.deepEqual(requestResult.input, [
    { role: "user", content: [{ type: "input_text", text: "case user constraint: preserve this exact requirement" }] },
    artifact("remote-1"), ...expectedKeptInput("case"),
  ]);
  assert.deepEqual(h.remoteCalls[0].input, expectedOldInput("case"));
  assert.equal(h.summaryCalls.length, 0, "a successful remote checkpoint must not eagerly native-summarize");
});

test("replays the active checkpoint artifact and stores source references across repeated compactions", async () => {
  const h = makeHarness();
  const first = addConversation(h, "first");
  await compactOnce(h, first.keptUser);
  const nextUser = h.sessionManager.appendMessage(user("second retain user"));
  const nextCall = h.sessionManager.appendMessage(assistantCall("second-keep", "second", h.model));
  const nextTool = h.sessionManager.appendMessage(toolResult("second-keep", "second retained tool output"));
  const second = await compactOnce(h, nextUser, "threshold");
  assert.ok(second);
  assert.ok(second.compaction);
  assert.equal(h.remoteCalls.length, 2);
  assert.deepEqual(h.remoteCalls[1].input, [
    { role: "user", content: [{ type: "input_text", text: "first user constraint: preserve this exact requirement" }] },
    artifact("remote-1"), ...expectedKeptInput("first"),
  ]);
  assert.equal(h.remoteCalls[1].input.filter((item) => JSON.stringify(item).includes("user constraint")).length, 1);
  assert.equal(h.remoteCalls[1].input.filter((item) => JSON.stringify(item) === JSON.stringify(artifact("remote-1"))).length, 1);
  const secondDetails = checkpointDetails(second.compaction);
  assert.equal(secondDetails.previousCompactionId, h.sessionManager.getEntries().find((entry) => entry.type === "compaction")!.id);
  assert.deepEqual(secondDetails.sourceEntryIds, [first.keptUser, first.keptCall, first.keptTool]);
});

test("bounds retained Codex user reconstruction to 64k tokens without dropping the artifact", async () => {
  const h = makeHarness();
  const huge = h.sessionManager.appendMessage(user("constraint-" + "x".repeat(300_000)));
  const kept = h.sessionManager.appendMessage(user("recent suffix"));
  await compactOnce(h, kept);
  const { requestResult } = await contextAndProviderRequest(h);
  assert.ok(inputPayload(requestResult));
  const input = requestResult.input;
  const artifactIndex = input.findIndex((item) => JSON.stringify(item) === JSON.stringify(artifact("remote-1")));
  assert.ok(artifactIndex > 0);
  assert.ok(input.slice(0, artifactIndex).every((item) => typeof item === "object" && item !== null && "role" in item && item.role === "user"));
  assert.ok(JSON.stringify(input.slice(0, artifactIndex)).length / 4 <= 64_000);
  assert.match(JSON.stringify(input.slice(0, artifactIndex)), /constraint-/);
  assert.equal((input[artifactIndex + 1] as { content?: Array<{ text?: string }> })?.content?.[0]?.text, "recent suffix");
  assert.ok(huge);
});

test("falls back to a readable summary when retained users plus the suffix exceed the destination window", async () => {
  const h = makeHarness();
  const entries = addConversation(h, "pressure");
  await compactOnce(h, entries.keptUser);
  h.model = { ...h.model, contextWindow: 32_000 };
  h.sessionManager.appendMessage(user("suffix-" + "z".repeat(120_000)));
  const contextResult = await emit<ContextEventResult | undefined>(h, "context", { type: "context", messages: h.sessionManager.buildSessionContext().messages });
  assert.ok(contextResult?.messages?.[0]);
  assert.match(JSON.stringify(contextResult.messages?.[0]), /plaintext fallback/);
  const payload = convertResponsesMessages(h.model, { messages: convertToLlm(contextResult.messages ?? []) },
    new Set(["openai", "openai-codex"]), { includeSystemPrompt: false });
  assert.equal(payload.some((item) => JSON.stringify(item) === JSON.stringify(artifact("remote-1"))), false);
  assert.equal(h.summaryCalls.length, 1);
});

test("retains a previous native compaction as user context before a new Codex artifact", async () => {
  const h = makeHarness();
  h.model = model("anthropic", "claude-test");
  const entries = addConversation(h, "native");
  h.sessionManager.appendCompaction("native readable summary", entries.keptUser, 9000,
    { readFiles: [], modifiedFiles: [] }, true, usage);
  h.model = model();
  const next = h.sessionManager.appendMessage(user("next compacted turn"));
  await compactOnce(h, next);
  const { requestResult } = await contextAndProviderRequest(h);
  assert.ok(inputPayload(requestResult));
  const artifactIndex = requestResult.input.findIndex((item) => JSON.stringify(item) === JSON.stringify(artifact("remote-1")));
  assert.ok(artifactIndex > 0);
  assert.match(JSON.stringify(requestResult.input.slice(0, artifactIndex)), /native readable summary/);
});

test("snapshots an incompatible remote checkpoint after lazy native materialization before remote replay", async () => {
  const h = makeHarness();
  const first = addConversation(h, "changed");
  await compactOnce(h, first.keptUser);
  h.model = model("anthropic", "claude-test");
  const lazyContext = await emit<ContextEventResult | undefined>(h, "context", { type: "context", messages: h.sessionManager.buildSessionContext().messages });
  assert.match(JSON.stringify(lazyContext?.messages?.[0]), /plaintext fallback 1/);
  assert.equal(h.summaryCalls.length, 1);
  h.model = model("openai-codex", "other-model");
  const next = h.sessionManager.appendMessage(user("new remote turn"));
  await compactOnce(h, next);
  const { requestResult } = await contextAndProviderRequest(h);
  assert.ok(inputPayload(requestResult));
  const artifactIndex = requestResult.input.findIndex((item) => JSON.stringify(item) === JSON.stringify(artifact("remote-2")));
  assert.ok(artifactIndex > 0);
  const beforeArtifact = JSON.stringify(requestResult.input.slice(0, artifactIndex));
  assert.match(beforeArtifact, /plaintext fallback 1/);
  assert.equal(beforeArtifact.match(/plaintext fallback 1/g)?.length, 1);
});

test("remote failure diagnostics persist safe causes without provider payloads", async () => {
  const h = makeHarness();
  const first = addConversation(h, "diagnostics");
  for (const message of [
    "Codex compaction request failed: HTTP 429",
    "provider payload secret-token private conversation",
    "Codex checkpoint replay cannot fit the destination context.",
  ]) {
    h.remote = async () => { throw new Error(message); };
    assert.equal(await compactOnce(h, first.keptUser), undefined);
  }
  const diagnostics = h.sessionManager.getEntries().filter((entry) => entry.type === "custom" && entry.customType === "compaction-diagnostic");
  assert.equal(diagnostics.length, 3);
  const serialized = JSON.stringify(diagnostics);
  assert.match(serialized, /HTTP 429/);
  assert.match(serialized, /Codex checkpoint replay cannot fit the destination context/);
  assert.match(serialized, /Unclassified error/);
  assert.doesNotMatch(serialized, /secret-token|private conversation/);
});

test("remote failure leaves the first checkpoint to Pi native fallback, and later fallback gets plaintext history", async () => {
  const h = makeHarness();
  const first = addConversation(h, "first");
  h.remote = async () => { throw new Error("remote unavailable"); };
  const firstResult = await compactOnce(h, first.keptUser);
  assert.equal(firstResult, undefined, "undefined lets Pi run its untouched native first compaction");
  assert.equal(h.sessionManager.getEntries().some((entry) => entry.type === "compaction"), false);

  h.remote = async () => { throw new Error("remote unavailable again"); };
  const checkpointHarness = makeHarness();
  const checkpoint = addConversation(checkpointHarness, "first");
  await compactOnce(checkpointHarness, checkpoint.keptUser);
  checkpointHarness.remote = async () => { throw new Error("remote unavailable again"); };
  const newUser = checkpointHarness.sessionManager.appendMessage(user("new user"));
  checkpointHarness.sessionManager.appendMessage(assistantCall("new-call", "new", checkpointHarness.model));
  checkpointHarness.sessionManager.appendMessage(toolResult("new-call", "new tool output"));
  const result = await compactOnce(checkpointHarness, newUser);
  assert.ok(result);
  assert.ok(result.compaction);
  assert.equal(checkpointHarness.remoteCalls.length, 2);
  assert.equal(checkpointHarness.summaryCalls.length, 1);
  assert.equal(checkpointHarness.nativeCalls.length, 1);
  const previousSummary = checkpointHarness.nativeCalls[0][0].previousSummary;
  assert.equal(previousSummary, "plaintext fallback 1");
  assert.equal(summaryText(checkpointHarness.summaryCalls[0]),
    "[User]: first user constraint: preserve this exact requirement\n\n[Assistant tool calls]: lookup(q=\"discarded\")\n\n[Tool result]: first discarded result");
  assert.ok(previousSummary);
  assert.doesNotMatch(previousSummary, /encrypted|checkpoint|ciphertext/i);
});

test("provider, model, and account changes materialize once and reuse the persisted fallback after reload", async () => {
  for (const change of ["provider", "model", "account"] as const) {
    const h = makeHarness();
    const entries = addConversation(h, change);
    await compactOnce(h, entries.keptUser);
    if (change === "provider") h.model = model("anthropic", "claude-test");
    if (change === "model") h.model = model("openai-codex", "other-model");
    if (change === "account") h.account = "different-account";
    const eventMessages = h.sessionManager.buildSessionContext().messages;
    const first = await emit<ContextEventResult | undefined>(h, "context", { type: "context", messages: eventMessages });
    assert.equal(h.summaryCalls.length, 1, change);
    const firstMessages = first?.messages;
    assert.ok(firstMessages);
    assert.equal(firstMessages[0].role, "compactionSummary");
    if (firstMessages[0].role === "compactionSummary") assert.match(firstMessages[0].summary, /plaintext fallback 1/, change);
    emit<undefined>(h, "session_start", { type: "session_start", reason: "reload" });
    const second = await emit<ContextEventResult | undefined>(h, "context", { type: "context", messages: eventMessages });
    assert.equal(h.summaryCalls.length, 1, `${change} fallback was not cached across reload`);
    const secondMessages = second?.messages;
    assert.ok(secondMessages);
    assert.equal(secondMessages[0].role, "compactionSummary");
    if (secondMessages[0].role === "compactionSummary") assert.match(secondMessages[0].summary, /plaintext fallback 1/, change);
  }
});

test("native providers use readable fallback after a remote checkpoint, while Codex threshold still uses remote", async () => {
  const h = makeHarness();
  const first = addConversation(h, "first");
  await compactOnce(h, first.keptUser);
  h.model = model("anthropic", "claude-test");
  const newer = h.sessionManager.appendMessage(user("native retained user"));
  h.sessionManager.appendMessage(assistantCall("native-call", "native", h.model));
  h.sessionManager.appendMessage(toolResult("native-call", "native tool output"));
  const result = await compactOnce(h, newer, "threshold");
  assert.ok(result);
  assert.ok(result.compaction);
  assert.equal(h.remoteCalls.length, 1);
  assert.equal(h.nativeCalls.length, 1);
  assert.equal(result.compaction.summary, "native readable summary");
});

test("branch replay follows the active checkpoint, not a sibling checkpoint", async () => {
  const h = makeHarness();
  const first = addConversation(h, "branch-a");
  await compactOnce(h, first.keptUser);
  const branchPoint = h.sessionManager.getEntry(first.oldTool)!;
  h.sessionManager.branch(branchPoint.id);
  const second = addConversation(h, "branch-b");
  await compactOnce(h, second.keptUser);
  assert.ok(!h.sessionManager.getBranch().some((entry) => entry.id === h.sessionManager.getEntries().find((item) => item.type === "compaction")!.id));
  const active = h.sessionManager.getBranch().filter((entry) => entry.type === "compaction");
  assert.equal(active.length, 1);
  const { requestResult } = await contextAndProviderRequest(h);
  assert.deepEqual(h.remoteCalls[1].input, [...expectedOldInput("branch-a"), ...expectedOldInput("branch-b")]);
  assert.equal(h.remoteCalls[1].input.filter((item) => JSON.stringify(item).includes("user constraint")).length, 2);
  const activeCheckpoint = h.sessionManager.getBranch().find((entry) => entry.type === "compaction");
  assert.ok(activeCheckpoint);
  assert.deepEqual(checkpointDetails(activeCheckpoint).sourceEntryIds,
    [first.oldUser, first.oldCall, first.oldTool, second.oldUser, second.oldCall, second.oldTool]);
  assert.deepEqual(requestResult.input[0], { role: "user", content: [{ type: "input_text", text: "branch-a user constraint: preserve this exact requirement" }] });
  assert.deepEqual(requestResult.input[1], { role: "user", content: [{ type: "input_text", text: "branch-b user constraint: preserve this exact requirement" }] });
  assert.deepEqual(requestResult.input[2], artifact("remote-2"));
  assert.deepEqual(requestResult.input.slice(3), expectedKeptInput("branch-b"));
});

test("corrupt or missing sources abort context, and cancellation cancels compaction", async () => {
  const corrupt = makeHarness();
  const corruptEntries = addConversation(corrupt, "corrupt");
  await compactOnce(corrupt, corruptEntries.keptUser);
  const corruptCheckpoint = corrupt.sessionManager.getEntries().find((entry) => entry.type === "compaction");
  assert.ok(corruptCheckpoint);
  checkpointDetails(corruptCheckpoint).artifact.encrypted_content = "";
  corrupt.model = model("anthropic", "claude-test");
  const corruptResult = await emit<ContextEventResult | undefined>(corrupt, "context", {
    type: "context", messages: corrupt.sessionManager.buildSessionContext().messages,
  });
  assert.ok(corruptResult);
  assert.deepEqual(corruptResult.messages, []);
  assert.equal(corrupt.aborted, 1);

  const missing = makeHarness();
  const missingEntries = addConversation(missing, "missing");
  missing.sessionManager.appendCompaction("[missing checkpoint]", missingEntries.keptUser, 100, {
    type: "codex-server-compaction", version: 1, provider: "openai-codex", model: "gpt-test",
    baseUrl: "https://example.test/backend-api", account: "bad-account", artifact: artifact("missing"),
    sourceEntryIds: ["does-not-exist"], reserveTokens: 4096, readFiles: [], modifiedFiles: [],
  }, true, usage);
  missing.model = model("anthropic", "claude-test");
  const missingResult = await emit<ContextEventResult | undefined>(missing, "context", {
    type: "context", messages: missing.sessionManager.buildSessionContext().messages,
  });
  assert.ok(missingResult);
  assert.deepEqual(missingResult.messages, []);
  assert.equal(missing.aborted, 1);

  const cancelled = makeHarness();
  const cancelledEntries = addConversation(cancelled, "cancel");
  await compactOnce(cancelled, cancelledEntries.keptUser);
  cancelled.model = model("anthropic", "claude-test");
  const next = cancelled.sessionManager.appendMessage(user("cancel next"));
  const controller = new AbortController();
  controller.abort();
  const result = await emit<SessionBeforeCompactResult>(cancelled, "session_before_compact", {
    type: "session_before_compact", preparation: preparation(cancelled, next), branchEntries: cancelled.sessionManager.getBranch(),
    reason: "overflow", willRetry: true, signal: controller.signal,
  } satisfies SessionBeforeCompactEvent);
  assert.deepEqual(result, { cancel: true });

  const race = makeHarness();
  const raceEntries = addConversation(race, "race");
  const raceController = new AbortController();
  let callbackSignal: AbortSignal | undefined;
  let startedResolve!: () => void;
  const started = new Promise<void>((resolve) => { startedResolve = resolve; });
  race.remote = async (options: RemoteOptions) => {
    assert.ok(options.signal);
    callbackSignal = options.signal;
    startedResolve();
    return new Promise<Awaited<ReturnType<Remote>>>((_resolve, reject) =>
      options.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true }));
  };
  const pending = compactOnce(race, raceEntries.keptUser, "manual", raceController.signal);
  await started;
  raceController.abort();
  assert.deepEqual(await pending, { cancel: true });
  assert.equal(callbackSignal?.aborted, true, "remote callback observed the cancellation race");
});

test("reserved server checkpoint summaries with missing details fail closed", async () => {
  const h = makeHarness();
  const entries = addConversation(h, "reserved-missing");
  h.sessionManager.appendCompaction("[Codex server checkpoint reserved-missing]", entries.keptUser, 100);
  h.model = model("anthropic", "claude-test");
  const result = await emit<ContextEventResult | undefined>(h, "context", {
    type: "context", messages: h.sessionManager.buildSessionContext().messages,
  });
  assert.ok(result, "reserved checkpoint must be recognized even without details");
  assert.deepEqual(result.messages, []);
  assert.equal(h.aborted, 1);
});

test("reserved server checkpoint summaries with a damaged type tag fail closed", async () => {
  const h = makeHarness();
  const entries = addConversation(h, "reserved-damaged");
  h.sessionManager.appendCompaction("[Codex server checkpoint reserved-damaged]", entries.keptUser, 100, { type: "wrong-checkpoint" });
  h.model = model("anthropic", "claude-test");
  const result = await emit<ContextEventResult | undefined>(h, "context", {
    type: "context", messages: h.sessionManager.buildSessionContext().messages,
  });
  assert.ok(result, "reserved checkpoint must be recognized with damaged details");
  assert.deepEqual(result.messages, []);
  assert.equal(h.aborted, 1);
});

test("iterative fallback walks prior checkpoints and branch summaries receive plaintext", async () => {
  const h = makeHarness();
  const first = addConversation(h, "first");
  await compactOnce(h, first.keptUser);
  const secondUser = h.sessionManager.appendMessage(user("second user"));
  h.sessionManager.appendMessage(assistantCall("second", "second", h.model));
  h.sessionManager.appendMessage(toolResult("second", "second result"));
  await compactOnce(h, secondUser);
  h.model = model("anthropic", "claude-test");
  const latestMessages = h.sessionManager.buildSessionContext().messages;
  await emit<ContextEventResult | undefined>(h, "context", { type: "context", messages: latestMessages });
  assert.equal(h.summaryCalls.length, 2);
  assert.equal(summaryText(h.summaryCalls[0]),
    "[User]: first user constraint: preserve this exact requirement\n\n[Assistant tool calls]: lookup(q=\"discarded\")\n\n[Tool result]: first discarded result");
  assert.equal(h.summaryCalls[0][0].filter((message) =>
    message.role === "user" && typeof message.content === "string" && message.content.includes("user constraint")).length, 1);
  assert.equal(summaryText(h.summaryCalls[1]),
    "[User]: first retain user\n\n[Assistant tool calls]: lookup(q=\"retain\")\n\n[Tool result]: first retained tool output");
  assert.equal(h.summaryCalls[1][7], "plaintext fallback 1");

  const branchPreparation: SessionBeforeTreeEvent["preparation"] = {
    targetId: "target", oldLeafId: null, commonAncestorId: null,
    entriesToSummarize: [h.sessionManager.getEntries().filter((entry) => entry.type === "compaction").at(-1)!],
    userWantsSummary: true,
  };
  const treeEvent: SessionBeforeTreeEvent = {
    type: "session_before_tree", preparation: branchPreparation, signal: new AbortController().signal,
  };
  const treeResult = await emit<unknown>(h, "session_before_tree", treeEvent);
  assert.equal(treeResult, undefined);
  const summarized = branchPreparation.entriesToSummarize[0];
  assert.equal(summarized?.type, "compaction");
  if (summarized?.type === "compaction") assert.equal(summarized.summary, "plaintext fallback 2");
});
