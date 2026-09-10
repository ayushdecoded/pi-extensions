import assert from "node:assert/strict";
import { createServer } from "node:http";
import { zstdDecompressSync } from "node:zlib";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager,
  type AgentSession } from "@earendil-works/pi-coding-agent";
import { openaiCodexProvider } from "@earendil-works/pi-ai/providers/openai-codex";
import type { Model } from "@earendil-works/pi-ai";
import { registerContextMemory, latestNotes, type ContextMemoryAction } from "../src/context-memory/index.ts";
import { registerServerCompaction } from "../src/compaction/server-compaction.ts";
import { createRoleResourceLoader } from "../src/runtime/resources.ts";
import { toolsForRole } from "../src/runtime/runtime.ts";
import type { AgentRole } from "../src/config/agents.ts";

const token = `test.${Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "memory-fixture" } })).toString("base64url")}.test`;

test("real SDK: tool calls, checkpoint replay, reload, and native child resource injection", { timeout: 30_000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-memory-sdk-"));
  const requests: Array<{ input: Array<Record<string, unknown>>; tools?: Array<{ name?: string }> }> = [];
  const actions: ContextMemoryAction[] = [];
  let checkpoints = 0;
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const raw = Buffer.concat(chunks);
    const body = JSON.parse((request.headers["content-encoding"] === "zstd" ? zstdDecompressSync(raw) : raw).toString()) as typeof requests[number];
    requests.push(body);
    const compact = body.input.some((item) => item.type === "compaction_trigger");
    const action = compact ? undefined : actions.shift();
    const item = compact
      ? { type: "compaction", id: `cmp_${++checkpoints}`, encrypted_content: `memory-checkpoint-${checkpoints}` }
      : action ? { type: "function_call", id: `fc_${requests.length}`, call_id: `call_${requests.length}`, name: "context_memory", arguments: JSON.stringify(action) }
      : { type: "message", id: `msg_${requests.length}`, role: "assistant", content: [{ type: "output_text", text: "Recorded. " + "Useful context. ".repeat(100) }] };
    response.writeHead(200, { "Content-Type": "text/event-stream" });
    const event = (value: unknown) => response.write(`data: ${JSON.stringify(value)}\n\n`);
    event({ type: "response.output_item.added", output_index: 0, item: { ...item, content: [], ...(action ? { arguments: "" } : {}) } });
    event({ type: "response.output_item.done", output_index: 0, item });
    event({ type: "response.completed", response: { id: `resp_${requests.length}`, status: "completed", output: [item], usage: { input_tokens: 100, output_tokens: 10, total_tokens: 110 } } });
    response.end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const baseUrl = `http://127.0.0.1:${address.port}`;
  const base = openaiCodexProvider();
  const model = { ...base.getModels()[0]!, id: "memory-fixture", baseUrl, contextWindow: 32768, maxTokens: 2048 };
  const runtime = await ModelRuntime.create({ authPath: join(dir, "auth.json"), modelsPath: null, modelsStorePath: join(dir, "catalog.json"), allowModelNetwork: false });
  runtime.registerNativeProvider({ ...base, baseUrl, getModels: () => [model],
    streamSimple: (selected, context, options) => base.streamSimple(selected as Model<"openai-codex-responses">, context, { ...options, transport: "sse" }),
    auth: { apiKey: { name: "fixture", resolve: async ({ credential }) => credential?.key ? { auth: { apiKey: credential.key }, source: "fixture" } : undefined } } });
  await runtime.setRuntimeApiKey("openai-codex", token);
  const settings = SettingsManager.inMemory({ compaction: { enabled: true, keepRecentTokens: 64, reserveTokens: 1024 }, transport: "sse", retry: { enabled: false } });
  const sessions: AgentSession[] = [];
  const role: AgentRole = { name: "MemoryFixture", description: "Read-only fixture", model: "openai-codex/memory-fixture", thinking: "off",
    promptPath: "role.md", promptFile: join(dir, "role.md"), tools: ["read"], delegates: [], timeoutMinutes: 1 };
  await writeFile(role.promptFile, "Investigate the assigned task without modifying workspace files.");
  async function open(manager: SessionManager, child = false) {
    const loader = child ? (await createRoleResourceLoader(dir, role)).loader : new DefaultResourceLoader({ cwd: dir, agentDir: dir, settingsManager: settings,
      noExtensions: true, noSkills: true, noContextFiles: true, noPromptTemplates: true, noThemes: true,
      extensionFactories: [{ name: "memory", factory: registerContextMemory }, { name: "compaction", factory: registerServerCompaction }] });
    if (!child) await loader.reload();
    const { session } = await createAgentSession({ cwd: dir, agentDir: dir, modelRuntime: runtime, model, thinkingLevel: "off",
      tools: child ? toolsForRole(role, 1, 2) : ["context_memory"], settingsManager: settings, sessionManager: manager, resourceLoader: loader });
    sessions.push(session);
    return session;
  }
  try {
    const manager = SessionManager.create(dir, join(dir, "sessions"));
    const parent = await open(manager);
    actions.push({ action: "edit", ref: "notes", edits: [{ oldText: "", newText: "Cookie fix failed. Investigate refresh." }] });
    await parent.prompt("The original test failed: AUTH-401. " + "Preserve release requirements. ".repeat(150));
    assert.equal(latestNotes(manager.getBranch()), "Cookie fix failed. Investigate refresh.");
    assert.ok(requests[0]!.tools?.some((tool) => tool.name === "context_memory"));
    actions.push({ action: "list" });
    await parent.prompt("Discover the available historical evidence.");
    assert.match(JSON.stringify(requests.at(-1)!.input.filter((item) => item.type === "function_call_output")), /entries/);
    await parent.compact();
    assert.equal(checkpoints, 1);
    actions.push({ action: "search", query: "AUTH-401" });
    await parent.prompt("Recover the original failure.");
    const replay = requests.at(-1)!;
    assert.ok(replay.input.some((item) => item.type === "compaction"));
    assert.match(JSON.stringify(replay.input), /Cookie fix failed/);
    assert.match(JSON.stringify(replay.input.filter((item) => item.type === "function_call_output")), /AUTH-401/);
    assert.doesNotMatch(JSON.stringify(replay.input), /Codex server checkpoint/);
    const note = replay.input.find((item) => JSON.stringify(item).includes("Session working note at context boundary"));
    assert.ok(note);
    actions.push({ action: "edit", ref: "notes", edits: [{ oldText: "Cookie fix failed. Investigate refresh.", newText: "Refresh fixed. Verify expiry." }] });
    await parent.prompt("Record the new finding.");
    assert.deepEqual(requests.at(-1)!.input.find((item) => JSON.stringify(item).includes("Session working note at context boundary")), note);
    parent.dispose();
    const restored = await open(SessionManager.open(manager.getSessionFile()!, join(dir, "sessions"), dir));
    actions.push({ action: "read", ref: "notes" });
    await restored.prompt("Continue after reload.");
    assert.deepEqual(requests.at(-1)!.input.find((item) => JSON.stringify(item).includes("Session working note at context boundary")), note);
    assert.match(JSON.stringify(requests.at(-1)!.input.filter((item) => item.type === "function_call_output")), /Refresh fixed/);

    const childManager = SessionManager.create(dir, join(dir, "children"), { parentSession: manager.getSessionFile() });
    const child = await open(childManager, true);
    actions.push({ action: "read", ref: "notes" }, { action: "edit", ref: "notes", edits: [{ oldText: "", newText: "Child verification evidence." }] });
    await child.prompt("Verify expiry independently.");
    assert.equal(latestNotes(childManager.getBranch()), "Child verification evidence.");
    assert.equal(latestNotes(manager.getBranch()), "Refresh fixed. Verify expiry.");
    const outputs = childManager.getBranch().filter((entry) => entry.type === "message" && entry.message.role === "toolResult");
    assert.match(JSON.stringify(outputs[0]), /\\"text\\":\\"\\"/);
    child.dispose();
    const followup = await open(SessionManager.open(childManager.getSessionFile()!, join(dir, "children"), dir), true);
    actions.push({ action: "read", ref: "notes" });
    await followup.prompt("Continue your verification.");
    assert.match(JSON.stringify(requests.at(-1)!.input.filter((item) => item.type === "function_call_output")), /Child verification evidence/);
  } finally {
    for (const session of sessions) session.dispose();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(dir, { recursive: true, force: true });
  }
});
