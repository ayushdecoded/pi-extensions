import assert from "node:assert/strict";
import test from "node:test";
import type { Api, Model } from "@earendil-works/pi-ai";
import {
  requestCodexCompaction,
  type CodexCompactionOptions,
  type CodexResponsesInput,
  type CodexResponsesTools,
} from "../src/compaction/codex-transport.ts";

const artifact = { type: "compaction", id: "cmp-1", encrypted_content: "opaque-☃" };

function model(api: Api = "openai-codex-responses"): Model<Api> {
  return {
    id: "gpt-test",
    name: "Test Codex",
    api,
    provider: "openai-codex",
    baseUrl: "https://example.test/backend-api",
    reasoning: true,
    input: ["text"],
    cost: { input: 2, output: 4, cacheRead: 1, cacheWrite: 3 },
    contextWindow: 100_000,
    maxTokens: 10_000,
  };
}

const input: CodexResponsesInput = [
  { role: "user", content: [{ type: "input_text", text: "retain this" }] },
];
const tools: CodexResponsesTools = [];

function terminal(output: unknown[] = [artifact]): unknown[] {
  return [
    { type: "response.output_item.done", item: artifact },
    {
      type: "response.completed",
      response: {
        status: "completed",
        output,
        usage: {
          input_tokens: 10,
          output_tokens: 3,
          total_tokens: 13,
          input_tokens_details: { cached_tokens: 2, cache_write_tokens: 1 },
          output_tokens_details: { reasoning_tokens: 1 },
        },
      },
    },
  ];
}

function responseFor(events: unknown[], oneByteChunks = false): Response {
  const text = events
    .map((event) => `data: ${JSON.stringify(event)}\r\n\r\n`)
    .join("");
  const bytes = new TextEncoder().encode(text);
  return new Response(new ReadableStream<Uint8Array>({
    start(controller) {
      if (oneByteChunks) {
        for (const byte of bytes) controller.enqueue(new Uint8Array([byte]));
      } else {
        controller.enqueue(bytes);
      }
      controller.close();
    },
  }), { status: 200 });
}

function options(fetchFn: typeof fetch, overrides: Partial<CodexCompactionOptions> = {}): CodexCompactionOptions {
  return {
    model: model(),
    apiKey: "secret-token",
    headers: { "ChatGPT-Account-ID": "acct-test" },
    input,
    tools,
    instructions: "Keep the retained context.",
    fetch: fetchFn,
    ...overrides,
  };
}

test("requests one Codex compaction over same-host SSE with arbitrary UTF-8 chunks", async () => {
  let called: { url: string; init: RequestInit } | undefined;
  const fetchFn: typeof fetch = async (url, init) => {
    called = { url: String(url), init: init ?? {} };
    return responseFor(terminal(), true);
  };

  const result = await requestCodexCompaction(options(fetchFn));
  assert.deepEqual(result.artifact, artifact);
  assert.deepEqual(result.usage, {
    input: 7,
    output: 3,
    cacheRead: 2,
    cacheWrite: 1,
    reasoning: 1,
    totalTokens: 13,
    cost: { input: 0.000014, output: 0.000012, cacheRead: 0.000002, cacheWrite: 0.000003, total: 0.000031 },
  });
  assert.equal(called?.url, "https://example.test/backend-api/codex/responses");
  assert.equal(called?.init.method, "POST");
  const headers = new Headers(called?.init.headers);
  assert.equal(headers.get("authorization"), "Bearer secret-token");
  assert.equal(headers.get("chatgpt-account-id"), "acct-test");
  assert.equal(headers.get("accept"), "text/event-stream");
  assert.equal(headers.get("originator"), "pi");
  const body = JSON.parse(String(called?.init.body)) as Record<string, unknown>;
  assert.equal(body.store, false);
  assert.equal(body.stream, true);
  assert.deepEqual(body.tools, tools);
  assert.deepEqual((body.input as unknown[]).at(-1), { type: "compaction_trigger" });
  assert.deepEqual(body.reasoning, { effort: "low", summary: "auto" });
});

test("passes mapped thinking effort and preserves a configured endpoint path", async () => {
  let sent: Record<string, unknown> | undefined;
  const fetchFn: typeof fetch = async (_url, init) => {
    sent = JSON.parse(String(init?.body)) as Record<string, unknown>;
    return responseFor(terminal());
  };
  const configured = model();
  configured.baseUrl = "https://example.test/backend-api/codex";
  configured.thinkingLevelMap = { high: "xhigh" };
  await requestCodexCompaction(options(fetchFn, { model: configured, thinking: "high" }));
  assert.deepEqual(sent?.reasoning, { effort: "xhigh", summary: "auto" });
});

test("rejects malformed, incomplete, missing, empty, and multiple artifacts", async () => {
  const cases: Array<{ events: unknown[]; message: RegExp }> = [
    { events: [{ type: "not-json" }], message: /no successful terminal/ },
    { events: [{ type: "response.incomplete" }], message: /stream failed/ },
    { events: [{ type: "response.completed", response: { status: "completed", usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 }, output: [] } }], message: /exactly one artifact/ },
    { events: [{ type: "response.output_item.done", item: { type: "compaction", encrypted_content: "" } }], message: /empty or malformed/ },
    { events: [...terminal([artifact, { type: "compaction", id: "cmp-2", encrypted_content: "other" }])], message: /exactly one artifact/ },
    { events: [{ type: "response.output_item.done", item: artifact }, { type: "response.output_item.done", item: artifact }, ...terminal([])], message: /repeated a done artifact/ },
  ];
  for (const current of cases) {
    const fetchFn: typeof fetch = async () => responseFor(current.events);
    await assert.rejects(requestCodexCompaction(options(fetchFn)), current.message);
  }

  const inconsistent: typeof fetch = async () => responseFor([
    ...terminal().slice(0, 1),
    { type: "response.completed", response: {
      status: "completed", output: [],
      usage: { input_tokens: 1, output_tokens: 1, total_tokens: 99 },
    } },
  ]);
  await assert.rejects(requestCodexCompaction(options(inconsistent)), /totals were inconsistent/);

  const malformedJson: typeof fetch = async () => new Response("data: {broken\r\n\r\n", { status: 200 });
  await assert.rejects(requestCodexCompaction(options(malformedJson)), /valid JSON/);
});

test("rejects failed and repeated terminal events without retries", async () => {
  let calls = 0;
  const fetchFn: typeof fetch = async () => {
    calls += 1;
    return responseFor([
      { type: "response.failed" },
      { type: "response.completed", response: { status: "completed", output: [], usage: {} } },
    ]);
  };
  await assert.rejects(requestCodexCompaction(options(fetchFn)), /stream failed/);
  assert.equal(calls, 1);

  const repeated: typeof fetch = async () => responseFor([
    ...terminal(),
    { type: "response.done", response: { status: "completed", output: [], usage: {} } },
  ]);
  await assert.rejects(requestCodexCompaction(options(repeated)), /multiple terminal/);
});

test("propagates cancellation and enforces the defaultable timeout", async () => {
  const pending: typeof fetch = async (_url, init) => new Promise<Response>((_resolve, reject) => {
    init?.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
  });
  await assert.rejects(
    requestCodexCompaction(options(pending, { timeoutMs: 10 })),
    /timed out after 10ms/,
  );

  const controller = new AbortController();
  const cancelled = requestCodexCompaction(options(pending, { signal: controller.signal, timeoutMs: 1_000 }));
  controller.abort();
  await assert.rejects(cancelled, /was aborted/);
});

test("sanitizes HTTP auth errors and refuses non-Codex models", async () => {
  const token = "access-token-that-must-not-escape";
  const authError: typeof fetch = async () => new Response(`invalid ${token}`, { status: 401 });
  await assert.rejects(requestCodexCompaction(options(authError)), (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.match(error.message, /HTTP 401/);
    assert.doesNotMatch(error.message, new RegExp(token));
    return true;
  });

  let called = false;
  const noCall: typeof fetch = async () => {
    called = true;
    return responseFor([]);
  };
  await assert.rejects(
    requestCodexCompaction(options(noCall, { model: model("openai-responses") })),
    /requires the openai-codex-responses API/,
  );
  assert.equal(called, false);
});
