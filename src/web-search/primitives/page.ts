import * as path from "node:path";
import type { FetchedPage, PageSection } from "../types.ts";
import {
  filterSections,
  htmlToSections,
  sectionsWithBudget,
  textToSections,
  truncate,
} from "./html.ts";

export type RawPage = {
  requestedUrl: string;
  finalUrl: string;
  ok: boolean;
  status: number;
  contentType?: string;
  raw: string;
};

export function isHtmlPage(raw: string, contentType?: string): boolean {
  return contentType?.includes("html") || /<html|<body|<article|<p[\s>]/i.test(raw);
}

export function parseSections(page: RawPage): PageSection[] {
  if (isHtmlPage(page.raw, page.contentType)) return htmlToSections(page.raw);
  const fallbackHeading =
    path.basename(new URL(page.finalUrl || page.requestedUrl).pathname) || "Text";
  return textToSections(page.raw, fallbackHeading);
}

export function shapePage(
  page: RawPage,
  sections: PageSection[],
  options: { mode: string; section?: string; maxChars: number },
): FetchedPage {
  const base = {
    url: page.finalUrl,
    ok: page.ok,
    status: page.status,
    contentType: page.contentType,
  };

  if (options.mode === "structure") {
    return {
      ...base,
      mode: options.mode,
      sections: sections.map(({ text: _text, ...section }) => section),
    };
  }

  if (options.mode === "section") {
    const selected = filterSections(sections, options.section);
    const withText = selected.map((section) => {
      const { text, truncated } = truncate(section.text, options.maxChars);
      return { ...section, text, chars: section.text.length, truncated } as Omit<
        PageSection,
        "text"
      > & { text: string; truncated?: boolean };
    });
    return {
      ...base,
      mode: options.mode,
      sections: withText,
      truncated: withText.some((section) => section.truncated),
    };
  }

  const withText = sectionsWithBudget(sections, options.maxChars);
  return {
    ...base,
    mode: "full",
    sections: withText,
    truncated: withText.some((section) => section.truncated) || sections.length > withText.length,
  };
}
