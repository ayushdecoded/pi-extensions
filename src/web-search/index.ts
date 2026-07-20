import { defineTool, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { loadConfig } from "./config.ts";
import type { SearchResult, WebSearchParams } from "./types.ts";
import { duckDuckGoSearch, fetchPage } from "./primitives/fetch.ts";
import { formatPage, formatResults, oneLine } from "./primitives/format.ts";

function normalizeTargets(value: string | undefined): string[] {
  return (value ?? "")
    .split(/\n+/)
    .map((item) => item.trim())
    .filter(Boolean);
}

// Create one lean web_search tool. Public params stay query/url/mode/section;
// limits, region, and fetch count are owned by local config.
export function createWebSearchTool() {
  const config = loadConfig();

  return defineTool({
    name: "web_search",
    label: "Web Search",
    description: "Search DuckDuckGo Lite or read URLs. Modes: search, structure, full, section.",
    promptSnippet:
      "Search DuckDuckGo Lite or read URLs. For multiple queries/URLs in one call, put each on its own line.",
    promptGuidelines: [
      "Use when external web info is needed.",
      "Use mode='structure' first for long pages, then mode='section'.",
      "Cite URLs from results.",
    ],
    parameters: Type.Object({
      query: Type.Optional(
        Type.String({ description: "Search query. Use newlines for multiple." }),
      ),
      url: Type.Optional(Type.String({ description: "URL to fetch. Use newlines for multiple." })),
      mode: Type.Optional(
        Type.String({ description: "Return mode: search, structure, full, section." }),
      ),
      section: Type.Optional(
        Type.String({ description: "Section heading, path, text, or index." }),
      ),
    }),
    renderCall(args, theme) {
      const count = normalizeTargets(args.url ?? args.query).length;
      const target = count > 1 ? `${count} targets` : (args.url ?? args.query ?? "web");
      const mode = args.mode ? ` · ${args.mode}` : "";
      return new Text(
        `${theme.fg("toolTitle", theme.bold("web_search"))}: ${theme.fg("accent", oneLine(target, 80))}${theme.fg("muted", mode)}`,
        0,
        0,
      );
    },
    async execute(_toolCallId, params: WebSearchParams, signal) {
      const maxResults = config.maxResults;
      const maxChars = config.maxChars;
      const timeoutMs = config.timeoutMs;
      const fetchTopN = config.fetchTopN;
      const mode = ["search", "structure", "full", "section"].includes(params.mode ?? "")
        ? params.mode!
        : "search";
      const fetchMode = mode === "search" ? "full" : mode;

      const queries = normalizeTargets(params.query);
      const urls = normalizeTargets(params.url);
      const label = [...urls, ...queries].join(" | ");

      try {
        if (urls.length > 0) {
          // Explicit URLs are independent, so fetch them concurrently. This lets the
          // model compare multiple sources with one tool call instead of serial calls.
          const pages = await Promise.all(
            urls.map((url) =>
              fetchPage(url, {
                mode: fetchMode,
                section: params.section,
                maxChars,
                timeoutMs,
                signal,
              }),
            ),
          );
          const results: SearchResult[] = pages.map((page) => ({
            title: page.url,
            url: page.url,
            snippet: "",
            page,
          }));
          return {
            content: [
              {
                type: "text",
                text: pages.map((page) => formatPage(page).join("\n")).join("\n\n---\n\n"),
              },
            ],
            details: { query: label, results },
          };
        }

        if (queries.length === 0) throw new Error("web_search requires either query or url.");

        // Multiple queries run in parallel and are rendered as separate result groups.
        const groups = await Promise.all(
          queries.map(async (query) => {
            const results = await duckDuckGoSearch(query, {
              maxResults,
              region: config.region,
              signal,
            });
            const shouldFetch = mode !== "search";
            if (shouldFetch && results.length > 0) {
              const pages = await Promise.all(
                results.slice(0, Math.min(fetchTopN, results.length)).map((result) =>
                  fetchPage(result.url, {
                    mode: fetchMode,
                    section: params.section,
                    maxChars,
                    timeoutMs,
                    signal,
                  }),
                ),
              );
              for (let i = 0; i < pages.length; i++) results[i]!.page = pages[i];
            }
            return { query, results, shouldFetch };
          }),
        );

        const allResults = groups.flatMap((group) => group.results);
        const text = groups
          .map((group) => formatResults(group.results, group.shouldFetch, group.query))
          .join("\n\n---\n\n");
        return {
          content: [{ type: "text", text }],
          details: { query: label, results: allResults },
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(`web_search failed: ${message}`);
      }
    },
  });
}

export default function registerWebSearch(pi: ExtensionAPI): void {
  pi.registerTool(createWebSearchTool());
}
