import type { FetchedPage, SearchResult } from "../types.ts";
import { decodeEntities, stripHtml } from "./html.ts";
import { parseSections, shapePage, type RawPage } from "./page.ts";

// Network primitives: DuckDuckGo Lite search plus plain URL fetching. Parsing and
// mode shaping live in page/html primitives; this file owns network behavior.

export function resolveDuckDuckGoUrl(href: string): string {
  let decoded = decodeEntities(href.trim());
  if (decoded.startsWith("//")) decoded = `https:${decoded}`;
  try {
    const url = new URL(decoded);
    const uddg = url.searchParams.get("uddg");
    if (uddg) return uddg;
    return url.toString();
  } catch {
    return decoded;
  }
}

function attr(attrs: string, name: string): string {
  return attrs.match(new RegExp(`${name}=["']([^"']+)["']`, "i"))?.[1] ?? "";
}

export function parseLiteResults(html: string, maxResults: number): SearchResult[] {
  const rows = html.split(/<a\s+/i).slice(1);
  const results: SearchResult[] = [];
  const seen = new Set<string>();

  for (const row of rows) {
    if (results.length >= maxResults) break;
    if (!/class=["'][^"']*result-link/i.test(row)) continue;

    const attrs = row.slice(0, row.indexOf(">"));
    const titleHtml = row.slice(row.indexOf(">") + 1, row.search(/<\/a>/i));
    const url = resolveDuckDuckGoUrl(attr(attrs, "href"));
    if (!url || seen.has(url)) continue;

    const snippetHtml = row.match(/class=["']result-snippet["'][^>]*>([\s\S]*?)<\/td>/i)?.[1] ?? "";
    seen.add(url);
    results.push({ title: stripHtml(titleHtml), url, snippet: stripHtml(snippetHtml) });
  }

  return results.filter((result) => result.title && result.url);
}

export async function duckDuckGoSearch(
  query: string,
  options: { maxResults: number; region?: string; signal?: AbortSignal },
): Promise<SearchResult[]> {
  const url = new URL("https://lite.duckduckgo.com/lite/");
  url.searchParams.set("q", query);
  if (options.region) url.searchParams.set("kl", options.region);
  const response = await fetch(url, {
    signal: options.signal,
    headers: {
      "user-agent": "Mozilla/5.0 (compatible; pi-duckduckgo-search/1.2)",
      accept: "text/html,application/xhtml+xml",
    },
  });
  if (!response.ok) throw new Error(`DuckDuckGo returned HTTP ${response.status}`);
  return parseLiteResults(await response.text(), options.maxResults);
}

async function fetchRawPage(
  url: string,
  options: { timeoutMs: number; signal?: AbortSignal },
): Promise<RawPage> {
  // We create our own controller because fetch has no native timeout option.
  // This controller is cancelled by either our timeout or Pi's parent tool signal.
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(new Error("fetch timeout")), options.timeoutMs);
  const abortFromParent = () => controller.abort(options.signal?.reason);
  try {
    // Forward Pi/user cancellation into the actual fetch. Without this, cancelled
    // tool calls could keep a network request alive until the site responds.
    if (options.signal?.aborted) abortFromParent();
    else options.signal?.addEventListener("abort", abortFromParent, { once: true });

    const response = await fetch(url, {
      signal: controller.signal,
      redirect: "follow",
      headers: {
        "user-agent": "Mozilla/5.0 (compatible; pi-web-search-fetch/1.1)",
        accept: "text/html,text/plain,application/xhtml+xml;q=0.9,*/*;q=0.2",
      },
    });
    return {
      requestedUrl: url,
      finalUrl: response.url || url,
      ok: response.ok,
      status: response.status,
      contentType: response.headers.get("content-type") ?? undefined,
      raw: await response.text(),
    };
  } finally {
    clearTimeout(timeout);
    options.signal?.removeEventListener("abort", abortFromParent);
  }
}

export async function fetchPage(
  url: string,
  options: {
    mode: string;
    section?: string;
    maxChars: number;
    timeoutMs: number;
    signal?: AbortSignal;
  },
): Promise<FetchedPage> {
  try {
    const raw = await fetchRawPage(url, options);
    const sections = parseSections(raw);
    return shapePage(raw, sections, options);
  } catch (error) {
    return {
      url,
      ok: false,
      error: error instanceof Error ? error.message : String(error),
      mode: options.mode,
    };
  }
}
