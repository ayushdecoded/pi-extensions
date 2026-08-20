import {
  defineTool,
  type ExtensionAPI,
  type ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import Parallel from "parallel-web";
import { createWebSearchSettingsStore } from "./config.ts";
import type {
  ParallelSearchClient,
  ParallelSearchResponse,
  WebSearchDetails,
  WebSearchParams,
  WebSearchSettingsStore,
} from "./types.ts";

const MAX_TOOL_OUTPUT_CHARS = 25_000;

function oneLine(value: string, max = 280): string {
  const text = value.replace(/\s+/g, " ").trim();
  return text.length <= max ? text : `${text.slice(0, max - 1).trim()}…`;
}

function boundToolOutput(value: string): string {
  if (value.length <= MAX_TOOL_OUTPUT_CHARS) return value;
  return `${value.slice(0, MAX_TOOL_OUTPUT_CHARS).trimEnd()}\n\n[Search output truncated]`;
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
  return boundToolOutput(lines.join("\n").trim());
}

export interface CreateWebSearchToolOptions {
  client?: ParallelSearchClient;
  settingsStore?: WebSearchSettingsStore;
}

export interface ConfigureWebSearchOptions {
  settingsStore?: WebSearchSettingsStore;
}

export function createWebSearchTool(options: CreateWebSearchToolOptions = {}) {
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
      "Search the web for current and factual information using Parallel, returning relevant results with titles, URLs, and LLM-optimized excerpts.",
    promptSnippet: "Search the web using Parallel for current information",
    promptGuidelines: [
      "Use when current or external web information is needed.",
      "Provide exactly 3 diverse keyword queries of 3-6 words, varying names, synonyms, or angles.",
      "Make the objective self-contained and include the key entity or topic in every query.",
      "Do not write query sentences, instructions, or site: operators.",
      "Cite URLs from the returned results.",
    ],
    parameters: Type.Object({
      objective: Type.String({
        minLength: 1,
        maxLength: 5_000,
        description:
          "A concise, self-contained search objective. Must include the key entity or topic being searched for.",
      }),
      search_queries: Type.Array(
        Type.String({ minLength: 1, maxLength: 200 }),
        {
          minItems: 3,
          maxItems: 3,
          description:
            "Exactly 3 keyword search queries, each 3-6 words. Must be diverse: vary entity names, synonyms, and angles. Each query must include the key entity or topic. Never write sentences, instructions, or use site: operators.",
        },
      ),
    }),
    renderCall(args, theme) {
      const queries = args.search_queries ?? [];
      const lines = [theme.fg("toolTitle", theme.bold("web_search"))];
      for (const query of queries) lines.push(theme.fg("text", `  • ${oneLine(query, 80)}`));
      return new Text(lines.join("\n"), 0, 0);
    },
    renderResult(result, _options, theme, context) {
      if ((context as unknown as { isError: boolean }).isError) {
        const text = result.content.map((part) => (part as { text?: string }).text ?? "").join("\n").trim();
        return new Text(theme.fg("error", text || "Search failed."), 0, 0);
      }
      // Parallel excerpts remain model-visible in result.content but are intentionally hidden from the terminal UI.
      return new Text("", 0, 0);
    },
    async execute(_toolCallId, params: WebSearchParams, signal, _onUpdate, ctx) {
      const objective = params.objective?.trim();
      if (!objective) throw new Error("web_search requires a non-empty objective.");

      const queries = (params.search_queries ?? []).map((query) => query.trim()).filter(Boolean);
      if (queries.length !== 3) {
        throw new Error("web_search requires exactly 3 non-empty search_queries items.");
      }

      const settings = settingsStore.load();
      const apiKey = settings.parallelApiKey?.trim() || process.env.PARALLEL_API_KEY?.trim();
      if (!apiKey) {
        throw new Error("Parallel is not configured. Run /web-search and paste a Parallel API key.");
      }

      try {
        const response = await getClient(apiKey).search(
          {
            objective,
            search_queries: queries,
            mode: "basic",
            client_model: ctx.model?.id,
          },
          { signal },
        );

        const details: WebSearchDetails = {
          provider: "parallel",
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
        throw new Error(`Parallel web search failed: ${message}`);
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
  if (current.parallelApiKey) {
    const replace = await ctx.ui.confirm("Parallel API key", "Replace the saved API key?");
    if (!replace) {
      ctx.ui.notify("Parallel web search is configured.", "info");
      return;
    }
  }

  const pasted = await ctx.ui.input("Paste Parallel API key", "PARALLEL_API_KEY");
  if (!pasted?.trim()) {
    ctx.ui.notify("Parallel API key was not changed.", "warning");
    return;
  }

  settingsStore.save({ parallelApiKey: pasted.trim() });
  ctx.ui.notify("Parallel web search configured.", "info");
}

export default function registerWebSearch(pi: ExtensionAPI): void {
  const settingsStore = createWebSearchSettingsStore();
  pi.registerTool(createWebSearchTool({ settingsStore }));
  pi.registerCommand("web-search", {
    description: "Configure the Parallel API key for web search",
    handler: async (_args, ctx) => {
      try {
        await configureWebSearch(ctx, { settingsStore });
      } catch (error) {
        ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
      }
    },
  });
}
