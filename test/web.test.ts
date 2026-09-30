import assert from "node:assert/strict";
import { readFile, rm } from "node:fs/promises";
import { dirname } from "node:path";
import test from "node:test";
import Parallel from "parallel-web";
import type { ExtensionAPI, ExtensionToolContext } from "@earendil-works/pi-coding-agent";
import { Value } from "typebox/value";
import webExtension, { createWebTool } from "../src/web.ts";

const page = { title: "Example", url: "https://example.com", publish_date: "2026-01-01", excerpts: ["Relevant evidence."] };
const searchResponse = { search_id: "search_1", session_id: "session_1", results: [page], usage: [{ name: "sku_search", count: 1 }] };
const extractResponse = { extract_id: "extract_1", session_id: "session_1", results: [page], errors: [] };
const search = { operation: "search" as const, objective: "Find documentation", search_queries: ["example API documentation"] };
const focusedFetch = { operation: "fetch" as const, objective: "Find documentation", urls: [page.url] };
const context = {} as ExtensionToolContext;

function setup(response: unknown = searchResponse, status = 200) {
  const requests: { url: string; body: Record<string, any> }[] = [];
  const client = new Parallel({ apiKey: "test-key", maxRetries: 0, logLevel: "off", fetch: async (input, init) => {
    requests.push({ url: String(input), body: JSON.parse(String(init?.body)) });
    return new Response(JSON.stringify(response), { status, headers: { "content-type": "application/json" } });
  } });
  const tool = createWebTool(() => client);
  return {
    requests,
    run: (params: Parameters<typeof tool.execute>[1], signal?: AbortSignal) => tool.execute("call-1", params, signal, undefined, context),
  };
}

function text(result: Awaited<ReturnType<ReturnType<typeof createWebTool>["execute"]>>) {
  return result.content.map(c => c.type === "text" ? c.text : "").join("");
}

test("registers exactly one tool without requiring credentials at startup", () => {
  const names: string[] = [];
  webExtension({ registerTool: (tool: { name: string }) => { names.push(tool.name); } } as unknown as ExtensionAPI);
  assert.deepEqual(names, ["web"]);
});

test("search uses the stable SDK API, budget, and concise source output", async () => {
  const { run, requests } = setup();
  const result = await run(search);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, "https://api.parallel.ai/v1/search");
  assert.deepEqual(requests[0].body, { objective: search.objective, search_queries: search.search_queries, max_chars_total: 20000 });
  assert.match(text(result), /https:\/\/example.com/);
  assert.match(text(result), /Published: 2026-01-01/);
  assert.match(text(result), /Relevant evidence/);
  assert.equal(result.usage, undefined);
  assert.deepEqual(result.details.parallelUsage, searchResponse.usage);
  assert.equal(result.isError, false);
});

test("focused fetch uses extract without enabling full content", async () => {
  const { run, requests } = setup(extractResponse);
  await run({ ...focusedFetch, max_chars: 3000 });
  assert.equal(requests[0].url, "https://api.parallel.ai/v1/extract");
  assert.deepEqual(requests[0].body, { urls: [page.url], objective: focusedFetch.objective, max_chars_total: 3000 });
});

test("full-content fetch does not duplicate excerpts or require objective", async () => {
  const { run, requests } = setup({ ...extractResponse, results: [{ ...page, full_content: "Full page Markdown" }] });
  const result = await run({ operation: "fetch", urls: [page.url], full_content: true });
  assert.deepEqual(requests[0].body.advanced_settings, { full_content: true });
  assert.match(text(result), /Full page Markdown/);
  assert.doesNotMatch(text(result), /Relevant evidence/);
});

test("missing full content is explicitly labelled", async () => {
  const { run } = setup(extractResponse);
  const result = await run({ operation: "fetch", urls: [page.url], full_content: true });
  assert.match(text(result), /Full content unavailable/);
  assert.match(text(result), /Relevant evidence/);
});

test("partial fetch failures preserve successes and warnings; all failures mark error", async () => {
  const error = { url: "https://example.com/missing", error_type: "not_found", http_status_code: 404, content: "DO NOT ECHO RAW ERROR BODY" };
  const { run } = setup({ ...extractResponse, errors: [error], warnings: [{ type: "test", message: "A warning" }] });
  const result = await run(focusedFetch);
  assert.equal(result.isError, false);
  assert.match(text(result), /Relevant evidence/);
  assert.match(text(result), /HTTP 404/);
  assert.match(text(result), /A warning/);
  assert.doesNotMatch(JSON.stringify(result), /DO NOT ECHO/);
  const failed = await setup({ ...extractResponse, results: [], errors: [error] }).run(focusedFetch);
  assert.equal(failed.isError, true);
});

test("empty search is not a tool failure", async () => {
  const result = await setup({ ...searchResponse, results: [] }).run(search);
  assert.equal(result.isError, false);
  assert.equal(text(result), "No results returned.");
});

test("invalid operation-specific fields fail before any network request", async () => {
  const { run, requests } = setup();
  for (const params of [
    { ...search, objective: " " }, { ...search, search_queries: [] },
    { ...search, search_queries: [" "] }, { ...search, urls: [page.url] },
    { ...search, full_content: false }, { ...focusedFetch, objective: undefined },
    { ...focusedFetch, urls: [] }, { ...focusedFetch, search_queries: ["x"] },
    { ...focusedFetch, urls: ["file:///etc/passwd"] },
    { ...focusedFetch, urls: ["https://user:password@example.com"] },
    { ...focusedFetch, urls: ["not a URL"] },
  ]) await assert.rejects(run(params));
  assert.equal(requests.length, 0);
});

test("schema bounds queries, URLs, and budgets", () => {
  const schema = createWebTool().parameters;
  assert.ok(Value.Check(schema, search));
  assert.ok(Value.Check(schema, focusedFetch));
  for (const params of [
    { ...search, operation: "unknown" }, { ...search, search_queries: Array(6).fill("query") },
    { ...focusedFetch, urls: Array(21).fill(page.url) },
    { ...search, max_chars: 999 }, { ...search, max_chars: 100001 },
    { ...search, max_chars: 1.5 }, { ...search, unexpected: true },
  ]) assert.equal(Value.Check(schema, params), false);
});

test("oversized output is saved, with both character and native safety caps", async () => {
  for (const [content, budget] of [["x".repeat(25000), 1000], ["界".repeat(30000), 100000], ["line\n".repeat(3000), 100000]] as const) {
    const { run } = setup({ ...extractResponse, results: [{ ...page, full_content: content }] });
    const result = await run({ operation: "fetch", urls: [page.url], full_content: true, max_chars: budget });
    const path = result.details.fullOutputPath!;
    try {
      assert.equal(result.details.truncated, true);
      assert.match(text(result), /Use read with offset\/limit/);
      const saved = await readFile(path, "utf8");
      assert.ok(saved.includes(content));
      assert.ok(Buffer.byteLength(text(result)) < 52000);
    } finally { await rm(dirname(path), { recursive: true, force: true }); }
  }
});

test("HTTP failures propagate and do not retry", async () => {
  const { run, requests } = setup({ error: { message: "Rate limited" } }, 429);
  await assert.rejects(run(search), Parallel.RateLimitError);
  assert.equal(requests.length, 1);
});

test("already aborted calls never reach the SDK", async () => {
  const { run, requests } = setup();
  await assert.rejects(run(search, AbortSignal.abort()));
  assert.equal(requests.length, 0);
});

test("cancellation reaches an in-flight SDK request", async () => {
  let started!: () => void;
  const ready = new Promise<void>(resolve => { started = resolve; });
  const client = new Parallel({ apiKey: "test-key", maxRetries: 0, logLevel: "off", fetch: async (_input, init) => {
    started();
    return new Promise<Response>((_resolve, reject) => {
      init!.signal!.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true });
    });
  } });
  const controller = new AbortController();
  const pending = createWebTool(() => client).execute("call", search, controller.signal, undefined, context);
  await ready;
  controller.abort();
  await assert.rejects(pending, Parallel.APIUserAbortError);
});
