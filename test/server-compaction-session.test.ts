import assert from "node:assert/strict";
import { createServer } from "node:http";
import { zstdDecompressSync } from "node:zlib";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager,
  type AgentSession, type SessionEntry,
} from "@earendil-works/pi-coding-agent";
import { openaiCodexProvider } from "@earendil-works/pi-ai/providers/openai-codex";
import type { Model, Usage } from "@earendil-works/pi-ai";
import { registerServerCompaction, SERVER_COMPACTION_TYPE, COMPACTION_FALLBACK_TYPE } from "../src/compaction/server-compaction.ts";
import { fallbackEntriesUsage, sessionEntriesUsage } from "../src/runtime/state.ts";

const usage: Usage = { input: 100, output: 10, cacheRead: 0, cacheWrite: 0, totalTokens: 110,
  cost: { input: 0.001, output: 0.001, cacheRead: 0, cacheWrite: 0, total: 0.002 } };
const wireUsage = { input_tokens: 100, output_tokens: 10, total_tokens: 110 };
const token = `test.${Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "synthetic-account" } })).toString("base64url")}.test`;

test("real Pi SDK: compact, persisted reload, repeated checkpoint, model switch and native fallback", { timeout: 30_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "pi-server-session-"));
  const requests: Array<{ input: Array<Record<string, unknown>>; instructions?: string }> = [];
  let failCompaction = false;
  let checkpointCount = 0;
  const server = createServer(async (request, response) => {
    const buffers: Buffer[] = [];
    for await (const chunk of request) buffers.push(Buffer.from(chunk));
    const rawBody = Buffer.concat(buffers);
    const bodyBytes = request.headers["content-encoding"] === "zstd" ? zstdDecompressSync(rawBody) : rawBody;
    const body = JSON.parse(bodyBytes.toString()) as typeof requests[number];
    requests.push(body);
    const isCompact = body.input.some((item) => item.type === "compaction_trigger");
    if (isCompact && failCompaction) { response.writeHead(503); response.end("synthetic failure"); return; }
    const item = isCompact
      ? { type: "compaction", id: `cmp_${++checkpointCount}`, encrypted_content: `synthetic-encrypted-${checkpointCount}` }
      : { type: "message", id: `msg_${requests.length}`, role: "assistant", content: [{ type: "output_text", text: "Native readable summary preserves the synthetic release identifier." }] };
    response.writeHead(200, { "Content-Type": "text/event-stream" });
    const event = (value: unknown) => response.write(`data: ${JSON.stringify(value)}\n\n`);
    event({ type: "response.output_item.added", output_index: 0, item: { ...item, content: [] } });
    event({ type: "response.output_item.done", output_index: 0, item });
    event({ type: "response.completed", response: { id: `resp_${requests.length}`, status: "completed", output: [item], usage: wireUsage } });
    response.end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const baseUrl = `http://127.0.0.1:${address.port}`;
  const base = openaiCodexProvider();
  const models = ["synthetic-a", "synthetic-b"].map((id) => ({ ...base.getModels()[0]!, id, baseUrl, contextWindow: 32768, maxTokens: 2048 }));
  const runtime = await ModelRuntime.create({ authPath: join(directory, "auth.json"), modelsPath: null, modelsStorePath: join(directory, "catalog.json"), allowModelNetwork: false });
  // The stock Codex provider is OAuth-only. Use its real response stream and
  // model shape, but give this local-only fixture deterministic API-key auth so
  // createAgentSession's own pre-compaction auth lookup is configured too.
  runtime.registerNativeProvider({ ...base, baseUrl, getModels: () => models,
    // Keep every SDK turn on the mock's HTTP/SSE path. The Codex API's default
    // auto transport may probe a WebSocket after a session reload.
    streamSimple: (model, context, options) => base.streamSimple(
      model as Model<"openai-codex-responses">, context, { ...options, transport: "sse" }),
    auth: { apiKey: { name: "synthetic Codex key", resolve: async ({ credential, signal }) => {
      signal.throwIfAborted();
      return credential?.key ? { auth: { apiKey: credential.key }, source: "fixture" } : undefined;
    } } } });
  await runtime.setRuntimeApiKey("openai-codex", token);
  const settings = SettingsManager.inMemory({ compaction: { enabled: true, keepRecentTokens: 64, reserveTokens: 1024 }, transport: "sse", retry: { enabled: false } });
  const sessions: AgentSession[] = [];
  async function open(manager: SessionManager) {
    const loader = new DefaultResourceLoader({ cwd: directory, agentDir: directory, settingsManager: settings,
      noExtensions: true, noSkills: true, noContextFiles: true, noPromptTemplates: true, noThemes: true,
      extensionFactories: [{ name: "server-compaction", factory: registerServerCompaction }] });
    await loader.reload();
    const result = await createAgentSession({ cwd: directory, agentDir: directory, modelRuntime: runtime,
      model: models[0], thinkingLevel: "off", tools: [], settingsManager: settings, sessionManager: manager, resourceLoader: loader });
    sessions.push(result.session);
    return result.session;
  }
  try {
    const manager = SessionManager.create(directory, join(directory, "sessions"));
    for (let index = 0; index < 8; index++) {
      manager.appendMessage({ role: "user", content: `Synthetic history ${index}: ${"retain this release context ".repeat(30)}`, timestamp: Date.now() });
      manager.appendMessage({ role: "assistant", content: [{ type: "text", text: `Recorded fixture ${index}.` }], api: models[0]!.api,
        provider: "openai-codex", model: models[0]!.id, stopReason: "stop", timestamp: Date.now(), usage });
    }
    const session = await open(manager);
    const result = await session.compact();
    assert.equal((result.details as { type: string }).type, SERVER_COMPACTION_TYPE);
    assert.equal(requests.length, 1, "no eager text summary");
    assert.equal(checkpointCount, 1);
    const first = manager.getBranch().filter((entry) => entry.type === "compaction").at(-1)!;
    assert.ok(first);
    assert.equal(manager.getEntries().filter((entry) => entry.type === "custom" && entry.customType === COMPACTION_FALLBACK_TYPE).length, 0);

    await session.prompt("Continue after compaction.");
    const firstReplay = requests.at(-1)!.input;
    const firstArtifactIndex = firstReplay.findIndex((item) => item.type === "compaction");
    const olderUserIndex = firstReplay.findIndex((item) => JSON.stringify(item).includes("Synthetic history 0"));
    assert.equal(firstReplay.filter((item) => item.type === "compaction").length, 1);
    assert.ok(olderUserIndex >= 0 && olderUserIndex < firstArtifactIndex,
      "Codex replay keeps bounded older user context before the encrypted artifact");
    assert.doesNotMatch(JSON.stringify(requests.at(-1)), /Codex server checkpoint/);
    const sessionFile = manager.getSessionFile();
    assert.ok(sessionFile);
    session.dispose();
    const restored = await open(SessionManager.open(sessionFile, join(directory, "sessions"), directory));
    await restored.prompt("Continue after a process reload.");
    assert.equal(requests.at(-1)!.input.find((item) => item.type === "compaction")?.encrypted_content, "synthetic-encrypted-1");

    await restored.compact();
    const secondRequest = requests.at(-1)!;
    assert.ok(secondRequest.input.some((item) => item.type === "compaction_trigger"));
    assert.ok(secondRequest.input.some((item) => item.type === "compaction" && item.encrypted_content === "synthetic-encrypted-1"));
    assert.equal(checkpointCount, 2);

    await restored.setModel(models[1]!);
    const beforeSwitch = requests.length;
    await restored.prompt("Continue with the other model.");
    assert.equal(requests.length - beforeSwitch, 3, "two historical lazy checkpoints then the user's request");
    const records = restored.sessionManager.getEntries();
    assert.equal(records.filter((entry) => entry.type === "custom" && entry.customType === COMPACTION_FALLBACK_TYPE).length, 2);
    const fallbackUsage = fallbackEntriesUsage(records);
    const packedUsage = sessionEntriesUsage(records);
    assert.ok(fallbackUsage.total > 0);
    assert.equal(packedUsage.total - restored.getSessionStats().tokens.total, fallbackUsage.total,
      "pack totals include lazy fallback work that native stats omit");
    assert.equal(requests.at(-1)!.input.filter((item) => item.type === "compaction").length, 0);
    assert.doesNotMatch(JSON.stringify(requests.at(-1)), /Codex server checkpoint|synthetic-encrypted/);
    assert.match(JSON.stringify(requests.at(-1)), /Native readable summary/);
    const beforeCached = requests.length;
    await restored.prompt("Another turn with the portable summary.");
    assert.equal(requests.length, beforeCached + 1, "cached fallback is not regenerated");

    failCompaction = true;
    const before503 = requests.length;
    const fallback = await restored.compact();
    assert.ok(requests.slice(before503).some((request) => request.input.some((item) => item.type === "compaction_trigger")),
      "native fallback follows a local mock HTTP 503 from the Codex checkpoint request");
    assert.notEqual((fallback.details as { type?: string }).type, SERVER_COMPACTION_TYPE);
    assert.match(fallback.summary, /Native readable summary/);
    const native = restored.sessionManager.getEntries().filter((entry): entry is Extract<SessionEntry, { type: "compaction" }> => entry.type === "compaction").at(-1)!;
    assert.ok(native.usage);
    assert.ok(sessionEntriesUsage(records).total > fallbackEntriesUsage(records).total);
  } finally {
    for (const session of sessions) session.dispose();
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    await rm(directory, { recursive: true, force: true });
  }
});
