import { randomUUID } from "node:crypto";
import {
  defineTool,
  type ExtensionAPI,
  type ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import Parallel from "parallel-web";
import {
  createWebSearchSettingsStore,
  loadWebSearchPolicy,
  providerLabel,
} from "./config.ts";
import { duckDuckGoSearch } from "./duckduckgo.ts";
import type {
  DuckDuckGoResult,
  ParallelSearchClient,
  ParallelSearchResponse,
  WebSearchDetails,
  WebSearchParams,
  WebSearchProvider,
  WebSearchSettingsStore,
} from "./types.ts";

function oneLine(value: string, max = 280): string {
  const text = value.replace(/\s+/g, " ").trim();
  return text.length <= max ? text : `${text.slice(0, max - 1).trim()}…`;
}

function formatParallelResults(response: ParallelSearchResponse): string {
  if (response.results.length === 0) return "## Search results\n\nNo results found.";

  const lines = ["## Search results", ""];
  for (const [index, result] of response.results.entries()) {
    const title = result.title?.trim() || result.url;
    lines.push(`${index + 1}. [${title}](${result.url})`);
    if (result.publish_date) lines.push(`   - Published: ${result.publish_date}`);
    for (const excerpt of result.excerpts) {
      const text = excerpt.trim();
      if (text) lines.push("", `   ${text}`);
    }
    if (index < response.results.length - 1) lines.push("");
  }
  return lines.join("\n").trim();
}

function formatDuckDuckGoResults(groups: Array<{ query: string; results: DuckDuckGoResult[] }>): string {
  return groups
    .map(({ query, results }) => {
      const lines = [`## Search: ${query}`, ""];
      if (results.length === 0) {
        lines.push("No results found.");
        return lines.join("\n");
      }
      for (const [index, result] of results.entries()) {
        lines.push(`${index + 1}. [${result.title}](${result.url})`);
        if (result.snippet) lines.push(`   - ${oneLine(result.snippet)}`);
        if (index < results.length - 1) lines.push("");
      }
      return lines.join("\n");
    })
    .join("\n\n---\n\n");
}

export interface CreateWebSearchToolOptions {
  client?: ParallelSearchClient;
  sessionId?: string;
  settingsStore?: WebSearchSettingsStore;
}

export interface ConfigureWebSearchOptions {
  settingsStore?: WebSearchSettingsStore;
}

// One tool, with a selectable provider. Parallel queries are sent together in
// one provider request; DuckDuckGo queries run concurrently for equivalent UX.
export function createWebSearchTool(options: CreateWebSearchToolOptions = {}) {
  const policy = loadWebSearchPolicy();
  const sessionId = options.sessionId ?? randomUUID();
  const settingsStore = options.settingsStore ?? createWebSearchSettingsStore();
  let client = options.client;
  let clientApiKey: string | undefined;

  const getClient = (apiKey: string) => {
    if (options.client) return options.client;
    if (!client || clientApiKey !== apiKey) {
      client = new Parallel({ apiKey });
      clientApiKey = apiKey;
    }
    return client;
  };

  return defineTool({
    name: "web_search",
    label: "Web Search",
    description:
      "Search the web using the configured DuckDuckGo or Parallel provider. Returns ranked sources with citation-friendly excerpts.",
    promptSnippet: "Search the web using the configured web search provider",
    promptGuidelines: [
      "Use when current or external web information is needed.",
      "Provide 2-3 concise keyword search queries when possible; each should be 3-6 words.",
      "Write the objective as a self-contained description of the information needed.",
      "Cite URLs from the returned results.",
    ],
    parameters: Type.Object({
      objective: Type.Optional(
        Type.String({
          description:
            "Self-contained description of the underlying question or research goal.",
        }),
      ),
      search_queries: Type.Optional(
        Type.Array(
          Type.String({
            description:
              "Concise keyword queries, 3-6 words each. Provide 2-3 when possible; maximum 5.",
          }),
        ),
      ),
    }),
    renderCall(args, theme) {
      const queries = args.search_queries ?? [];
      const target = queries.length > 1 ? `${queries.length} queries` : (queries[0] ?? "web");
      return new Text(
        `${theme.fg("toolTitle", theme.bold("web_search"))}: ${theme.fg("accent", oneLine(target, 80))}`,
        0,
        0,
      );
    },
    renderResult(result, options, theme, context) {
      // UI shows queries only; raw excerpts stay in tool content for the model.
      if ((context as unknown as { isError: boolean }).isError) {
        const text = result.content.map((part) => (part as { text?: string }).text ?? "").join("\n").trim();
        return new Text(theme.fg("error", text || "Search failed."), 0, 0);
      }
      if (options.isPartial) {
        const queries = (context.args as WebSearchParams)?.search_queries ?? [];
        if (queries.length === 0) return new Text(theme.fg("muted", "Searching…"), 0, 0);
        const preview = queries.map((query) => `• ${oneLine(query, 80)}`).join("\n");
        return new Text(`${theme.fg("muted", "Searching…")}\n${theme.fg("text", preview)}`, 0, 0);
      }
      const details = result.details as WebSearchDetails | undefined;
      const args = context.args as WebSearchParams | undefined;
      const queries = args?.search_queries ?? [];
      const count = details?.resultCount ?? 0;
      const provider = details?.provider ? providerLabel(details.provider) : "Search";
      const lines: string[] = [];
      lines.push(
        theme.fg("muted", `${provider} · ${count} result${count === 1 ? "" : "s"} · hidden in UI, visible to model`),
      );
      if (queries.length > 0) {
        lines.push("");
        for (const query of queries) lines.push(theme.fg("text", `• ${oneLine(query, 80)}`));
      }
      if (args?.objective) {
        lines.push("");
        lines.push(theme.fg("dim", `objective: ${oneLine(args.objective, 100)}`));
      }
      return new Text(lines.join("\n"), 0, 0);
    },
    async execute(_toolCallId, params: WebSearchParams, signal) {
      const queries = (params.search_queries ?? []).map((query) => query.trim()).filter(Boolean);
      if (queries.length === 0) {
        throw new Error("web_search requires at least one search_queries item.");
      }
      if (queries.length > 5) {
        throw new Error("web_search accepts at most 5 search_queries items.");
      }

      const settings = settingsStore.load();
      try {
        if (settings.provider === "duckduckgo") {
          const groups = await Promise.all(
            queries.map(async (query) => ({
              query,
              results: await duckDuckGoSearch(query, {
                maxResults: policy.maxResults,
                signal,
              }),
            })),
          );
          const details: WebSearchDetails = {
            provider: settings.provider,
            product: "search",
            resultCount: groups.reduce((count, group) => count + group.results.length, 0),
          };
          return {
            content: [{ type: "text", text: formatDuckDuckGoResults(groups) }],
            details,
          };
        }

        const apiKey = settings.parallelApiKey?.trim() || process.env.PARALLEL_API_KEY?.trim();
        if (!apiKey) {
          throw new Error("Parallel is not configured. Run /web-search and paste a Parallel API key.");
        }
        const response = await getClient(apiKey).search(
          {
            objective: params.objective?.trim() || undefined,
            search_queries: queries,
            mode: policy.mode,
            max_chars_total: policy.maxCharsTotal,
            session_id: sessionId,
            advanced_settings: { max_results: policy.maxResults },
          },
          { signal },
        );

        const details: WebSearchDetails = {
          provider: settings.provider,
          product: "search",
          searchId: response.search_id,
          sessionId: response.session_id,
          resultCount: response.results.length,
          warnings: response.warnings ?? undefined,
          usage: response.usage ?? undefined,
        };
        return {
          content: [{ type: "text", text: formatParallelResults(response) }],
          details,
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(`${providerLabel(settings.provider)} web search failed: ${message}`);
      }
    },
  });
}

export async function configureWebSearch(
  ctx: ExtensionCommandContext,
  options: ConfigureWebSearchOptions = {},
): Promise<void> {
  if (!ctx.hasUI) throw new Error("/web-search requires an interactive UI.");

  const settingsStore = options.settingsStore ?? createWebSearchSettingsStore();
  const current = settingsStore.load();
  const duckLabel = current.provider === "duckduckgo" ? "DuckDuckGo (active)" : "DuckDuckGo";
  const parallelLabel = current.provider === "parallel" ? "Parallel (active)" : "Parallel";
  const selected = await ctx.ui.select("Web search provider", [duckLabel, parallelLabel]);
  if (!selected) return;

  const provider: WebSearchProvider = selected.startsWith("Parallel") ? "parallel" : "duckduckgo";
  if (provider === "duckduckgo") {
    settingsStore.save({ ...current, provider });
    ctx.ui.notify("Web search provider: DuckDuckGo", "info");
    return;
  }

  let apiKey = current.parallelApiKey;
  if (apiKey) {
    const replace = await ctx.ui.confirm("Parallel API key", "Replace the saved API key?");
    if (!replace) {
      settingsStore.save({ ...current, provider });
      ctx.ui.notify("Web search provider: Parallel", "info");
      return;
    }
  }

  const pasted = await ctx.ui.input("Paste Parallel API key", "PARALLEL_API_KEY");
  if (!pasted?.trim()) {
    ctx.ui.notify("Parallel was not selected because no API key was provided.", "warning");
    return;
  }
  apiKey = pasted.trim();
  settingsStore.save({ provider, parallelApiKey: apiKey });
  ctx.ui.notify("Web search provider: Parallel", "info");
}

export default function registerWebSearch(pi: ExtensionAPI): void {
  const settingsStore = createWebSearchSettingsStore();
  pi.registerTool(createWebSearchTool({ settingsStore }));
  pi.registerCommand("web-search", {
    description: "Choose DuckDuckGo or Parallel for web search",
    handler: async (_args, ctx) => {
      try {
        await configureWebSearch(ctx, { settingsStore });
      } catch (error) {
        ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
      }
    },
  });
}
