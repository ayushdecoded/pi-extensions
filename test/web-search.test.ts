import assert from "node:assert/strict";
import { mkdtemp, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import type { ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { configureWebSearch, createWebSearchTool } from "../src/web-search/index.ts";
import { createWebSearchSettingsStore } from "../src/web-search/config.ts";
import type { ParallelSearchClient, WebSearchSettingsStore } from "../src/web-search/types.ts";

test("web search exposes one Parallel-backed tool", () => {
  const tool = createWebSearchTool();
  assert.equal(tool.name, "web_search");
  assert.match(tool.description, /using Parallel/);
  assert.match(tool.promptSnippet ?? "", /using Parallel/);
});

test("web search UI shows queries and hides successful Parallel output", () => {
  const tool = createWebSearchTool() as any;
  const theme = {
    fg: (_color: string, text: string) => text,
    bold: (text: string) => text,
  };
  const args = {
    objective: "Find Parallel Search documentation.",
    search_queries: ["Parallel Search API", "Parallel web search docs", "Parallel search best practices"],
  };

  const call = tool.renderCall(args, theme).render(120).join("\n");
  assert.match(call, /^web_search/);
  for (const query of args.search_queries) assert.match(call, new RegExp(query));
  assert.doesNotMatch(call, /Find Parallel Search documentation/);

  const result = tool.renderResult(
    { content: [{ type: "text", text: "SECRET PARALLEL EXCERPTS" }] },
    { expanded: false, isPartial: false },
    theme,
    { args, isError: false },
  ).render(120).join("\n");
  assert.equal(result, "");
});

test("web search follows Parallel's agent search semantics and formats citations", async () => {
  const calls: Array<{ body: unknown; signal?: AbortSignal }> = [];
  const client = {
    search: async (body: unknown, options?: { signal?: AbortSignal }) => {
      calls.push({ body, signal: options?.signal });
      return {
        search_id: "search_test",
        session_id: "session_test",
        results: [
          {
            title: "Parallel Docs",
            url: "https://docs.parallel.ai",
            publish_date: "2025-01-01",
            excerpts: ["Relevant **documentation** excerpt."],
          },
        ],
      };
    },
  } as unknown as ParallelSearchClient;
  const settingsStore: WebSearchSettingsStore = {
    load: () => ({ parallelApiKey: "test-key" }),
    save: () => {},
  };
  const tool = createWebSearchTool({ client, settingsStore });
  const controller = new AbortController();
  const ctx = { model: { id: "claude-opus-4-6" } } as unknown as ExtensionContext;

  const result = await tool.execute(
    "call-1",
    {
      objective: "Find the current Parallel Search API documentation.",
      search_queries: [
        "Parallel Search API",
        "Parallel web search docs",
        "Parallel search best practices",
      ],
    },
    controller.signal,
    undefined,
    ctx,
  );

  assert.deepEqual(calls, [
    {
      body: {
        objective: "Find the current Parallel Search API documentation.",
        search_queries: [
          "Parallel Search API",
          "Parallel web search docs",
          "Parallel search best practices",
        ],
        mode: "basic",
        client_model: "claude-opus-4-6",
      },
      signal: controller.signal,
    },
  ]);
  const text = result.content.find((part) => part.type === "text")?.text ?? "";
  assert.match(text, /\[Parallel Docs\]\(https:\/\/docs\.parallel\.ai\)/);
  assert.match(text, /Relevant \*\*documentation\*\* excerpt/);
  assert.deepEqual(result.details, {
    provider: "parallel",
    product: "search",
    searchId: "search_test",
    sessionId: "session_test",
    resultCount: 1,
    warnings: undefined,
    usage: undefined,
  });
});

test("/web-search stores a pasted Parallel key securely", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "pi-web-search-"));
  const file = path.join(directory, "web-search.json");
  const store = createWebSearchSettingsStore(file);
  const notifications: string[] = [];
  const ctx = {
    hasUI: true,
    ui: {
      input: async () => "  parallel-test-key  ",
      confirm: async () => false,
      notify: (message: string) => notifications.push(message),
    },
  } as unknown as ExtensionCommandContext;

  try {
    await configureWebSearch(ctx, { settingsStore: store });
    assert.deepEqual(store.load(), { parallelApiKey: "parallel-test-key" });
    assert.equal((await stat(file)).mode & 0o777, 0o600);
    assert.deepEqual(notifications, ["Parallel web search configured."]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("web search requires a non-empty objective and exactly three queries", async () => {
  const settingsStore: WebSearchSettingsStore = {
    load: () => ({ parallelApiKey: "test-key" }),
    save: () => {},
  };
  const tool = createWebSearchTool({
    settingsStore,
    client: { search: async () => { throw new Error("should not be called"); } } as unknown as ParallelSearchClient,
  });
  const ctx = {} as ExtensionContext;

  await assert.rejects(
    () =>
      tool.execute(
        "call-objective",
        { objective: " ", search_queries: ["one", "two", "three"] },
        new AbortController().signal,
        undefined,
        ctx,
      ),
    /non-empty objective/,
  );
  await assert.rejects(
    () =>
      tool.execute(
        "call-few",
        { objective: "Find something", search_queries: ["one", "two"] },
        new AbortController().signal,
        undefined,
        ctx,
      ),
    /exactly 3 non-empty search_queries/,
  );
  await assert.rejects(
    () =>
      tool.execute(
        "call-empty",
        { objective: "Find something", search_queries: ["one", " ", "three"] },
        new AbortController().signal,
        undefined,
        ctx,
      ),
    /exactly 3 non-empty search_queries/,
  );
});

test("create-skill is a native prompt template with argument forwarding", async () => {
  const { readFile } = await import("node:fs/promises");
  const prompt = await readFile(".pi/prompts/create-skill.md", "utf8");
  assert.match(prompt, /description: Guide the creation/);
  assert.match(prompt, /\$ARGUMENTS/);
  assert.match(prompt, /\.pi\/skills\/<name>\/SKILL\.md/);
});
