import type { FetchedPage, SearchResult } from "../types.ts";
import { compactText } from "./html.ts";

// Text output is optimized for agent context: structured headings, explicit URLs,
// and bounded page excerpts rather than raw HTML dumps.
export function oneLine(value: string, max = 280): string {
  const text = value.replace(/\s+/g, " ").trim();
  return text.length <= max ? text : `${text.slice(0, max - 1).trim()}…`;
}

export function formatPage(page: FetchedPage): string[] {
  const mode = page.mode ?? "full";
  const status = page.ok
    ? `OK${page.status !== undefined ? `, HTTP ${page.status}` : ""}`
    : `FAILED${page.status !== undefined ? `, HTTP ${page.status}` : ""}`;
  const lines = [
    `## Page: ${page.url}`,
    "",
    `- Status: ${status}`,
    `- Mode: ${mode}${page.truncated ? ", truncated" : ""}`,
  ];

  if (!page.ok) {
    lines.push("", `**Fetch error:** ${page.error ?? `HTTP ${page.status}`}.`);
    return lines;
  }

  if (page.sections && mode === "structure") {
    lines.push("", `### Outline (${page.sections.length} sections)`);
    if (page.sections.length === 0) lines.push("- No headings found.");
    for (const section of page.sections) {
      const indent = "  ".repeat(Math.max(0, section.level - 1));
      lines.push(`${indent}- [${section.index}] ${section.heading} (${section.chars} chars)`);
    }
    return lines;
  }

  if (mode === "section" && page.sections) {
    lines.push("", `### Matched sections: ${page.sections.length}`);
    if (page.sections.length === 0) {
      lines.push(
        "",
        "> Tip: use `mode=structure` first, then pass a section index or heading path.",
      );
      return lines;
    }
    for (const [i, section] of page.sections.entries()) {
      if (i > 0) lines.push("", "---");
      lines.push("", `### Section [${section.index}]: ${section.heading}`);
      if (section.path !== section.heading) lines.push(`- Path: ${section.path}`);
      lines.push(`- Length: ${section.chars} chars`);
      if (section.text) lines.push("", compactText(section.text));
    }
    return lines;
  }

  if (page.sections?.length) {
    lines.push(
      "",
      `### Outline preview (${Math.min(page.sections.length, 20)} of ${page.sections.length})`,
    );
    for (const section of page.sections.slice(0, 20)) {
      const indent = "  ".repeat(Math.max(0, section.level - 1));
      lines.push(`${indent}- [${section.index}] ${section.heading} (${section.chars} chars)`);
    }
    if (page.sections.length > 20)
      lines.push(
        `- ... ${page.sections.length - 20} more. Use \`mode=structure\` for the full outline.`,
      );
    if (page.sections.some((section) => section.text)) {
      lines.push("", "### Sections");
      for (const section of page.sections) {
        if (!section.text) continue;
        lines.push("", `#### Section [${section.index}]: ${section.heading}`);
        if (section.path !== section.heading) lines.push(`- Path: ${section.path}`);
        lines.push(`- Length: ${section.chars} chars${section.truncated ? ", excerpt" : ""}`);
        lines.push("", compactText(section.text));
      }
      lines.push(
        "",
        "> Tip: use `mode=structure`, then `mode=section` with an index/heading for exact section text.",
      );
      return lines;
    }
  }
  if (page.text) lines.push("", "### Text", "", compactText(page.text));
  return lines;
}

export function formatResults(
  results: SearchResult[],
  includeFetched: boolean,
  query?: string,
): string {
  const lines: string[] = [];
  if (query) {
    lines.push(`## Search: ${query}`, "");
    lines.push(results.length ? `- Results: ${results.length}` : "- No DuckDuckGo results found.");
    lines.push("");
  }
  for (const [index, result] of results.entries()) {
    lines.push(`${index + 1}. [${result.title}](${result.url})`);
    if (result.snippet) lines.push(`   - ${oneLine(result.snippet)}`);
    if (includeFetched && result.page) lines.push("", ...formatPage(result.page));
    if (index < results.length - 1) lines.push("");
  }
  return lines.join("\n").trim();
}
