import type { PageSection } from "../types.ts";

// Lightweight HTML/text extraction. We avoid DOM dependencies so the tool works in
// the Pi extension runtime without a browser or jsdom.

type HeadingHit = {
  level: number;
  heading: string;
  start: number;
  end: number;
};

function isNoiseLine(line: string): boolean {
  // Some modern docs ship MDX/React source in the rendered HTML. Drop obvious
  // component/script boilerplate while preserving normal prose and API snippets.
  return (
    /^export\s+(const|function|default)\b/.test(line) ||
    /^import\s+.+\s+from\s+['"]/.test(line) ||
    /^return\s+<\w/.test(line) ||
    /^<\/?(div|span|table|tbody|thead|tr|td|th)\b/.test(line) ||
    /^\{[a-zA-Z_$][\w$]*\s*&&/.test(line) ||
    /className=|React\.createElement|__NEXT_DATA__|window\.__/.test(line)
  );
}

export function compactText(value: string): string {
  return value
    .replace(/\r/g, "")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line) => !isNoiseLine(line))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function decodeEntities(value: string): string {
  return value
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x27;/g, "'")
    .replace(/&#x2F;/g, "/")
    .replace(/&#(\d+);/g, (_m, code) => String.fromCharCode(Number(code)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_m, code) => String.fromCharCode(parseInt(code, 16)));
}

export function stripHtml(value: string): string {
  return decodeEntities(value.replace(/<[^>]*>/g, " "))
    .replace(/\s+/g, " ")
    .trim();
}

export function cleanHtml(html: string): string {
  return html
    .replace(/<script\b[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[\s\S]*?<\/style>/gi, " ")
    .replace(/<noscript\b[\s\S]*?<\/noscript>/gi, " ")
    .replace(/<svg\b[\s\S]*?<\/svg>/gi, " ")
    .replace(/<head\b[\s\S]*?<\/head>/gi, " ");
}

export function htmlToText(html: string): string {
  const withBreaks = cleanHtml(html)
    .replace(
      /<\/(p|div|section|article|main|header|footer|li|ul|ol|h[1-6]|blockquote|pre|tr)>/gi,
      "\n",
    )
    .replace(/<br\s*\/?>/gi, "\n");
  return compactText(stripHtml(withBreaks));
}

export function truncate(value: string, maxChars: number): { text: string; truncated: boolean } {
  if (value.length <= maxChars) return { text: value, truncated: false };
  return {
    text: `${value.slice(0, Math.max(0, maxChars)).trim()}\n\n[TRUNCATED at ${maxChars} chars]`,
    truncated: true,
  };
}

export function extractTitle(html: string): string {
  const h1 = html.match(/<h1\b[^>]*>([\s\S]*?)<\/h1>/i)?.[1];
  if (h1) return stripHtml(h1);
  const title = html.match(/<title\b[^>]*>([\s\S]*?)<\/title>/i)?.[1];
  return title ? stripHtml(title) : "Page";
}

function sectionPath(
  stack: Array<{ level: number; heading: string }>,
  current: HeadingHit,
): string {
  while (stack.length && stack[stack.length - 1]!.level >= current.level) stack.pop();
  stack.push({ level: current.level, heading: current.heading });
  return stack.map((entry) => entry.heading).join(" > ");
}

function sectionsFromHeadings(
  source: string,
  headings: HeadingHit[],
  bodyText: (start: number, end: number) => string,
  fallbackHeading: string,
): PageSection[] {
  if (headings.length === 0) {
    const text = bodyText(0, source.length);
    return [
      {
        index: 0,
        level: 1,
        heading: fallbackHeading,
        path: fallbackHeading,
        text,
        chars: text.length,
      },
    ];
  }

  const stack: Array<{ level: number; heading: string }> = [];
  return headings.map((current, index) => {
    const next = headings[index + 1];
    const text = bodyText(current.end, next?.start ?? source.length);
    return {
      index,
      level: current.level,
      heading: current.heading,
      path: sectionPath(stack, current),
      text,
      chars: text.length,
    };
  });
}

function htmlHeadings(source: string): HeadingHit[] {
  const headings: HeadingHit[] = [];
  const headingPattern = /<h([1-6])\b[^>]*>([\s\S]*?)<\/h\1>/gi;
  let match: RegExpExecArray | null;
  while ((match = headingPattern.exec(source))) {
    const heading = stripHtml(match[2] ?? "");
    if (heading) {
      headings.push({
        level: Number(match[1]),
        heading,
        start: match.index,
        end: match.index + match[0].length,
      });
    }
  }
  return headings;
}

function markdownHeadings(lines: string[]): HeadingHit[] {
  const headings: HeadingHit[] = [];
  let offset = 0;
  for (const line of lines) {
    const match = line.match(/^(#{1,6})\s+(.+)$/);
    if (match) {
      headings.push({
        level: match[1]!.length,
        heading: match[2]!.trim(),
        start: offset,
        end: offset + line.length,
      });
    }
    offset += line.length + 1;
  }
  return headings;
}

export function htmlToSections(html: string): PageSection[] {
  const source = cleanHtml(html);
  return sectionsFromHeadings(
    source,
    htmlHeadings(source),
    (start, end) => htmlToText(source.slice(start, end)),
    extractTitle(source),
  );
}

export function textToSections(text: string, fallbackHeading = "Text"): PageSection[] {
  const normalized = text.replace(/\r/g, "");
  const lines = normalized.split("\n");
  return sectionsFromHeadings(
    normalized,
    markdownHeadings(lines),
    (start, end) => compactText(normalized.slice(start, end)),
    fallbackHeading,
  );
}

export function sectionsWithBudget(
  sections: PageSection[],
  maxChars: number,
): Array<Omit<PageSection, "text"> & { text: string; truncated?: boolean }> {
  const nonEmpty = sections.filter((section) => section.text.trim());
  const budget = Math.max(800, maxChars);
  const perSection = Math.max(350, Math.floor(budget / Math.max(1, Math.min(nonEmpty.length, 12))));
  let used = 0;
  const output: Array<Omit<PageSection, "text"> & { text: string; truncated?: boolean }> = [];
  for (const section of nonEmpty) {
    if (used >= budget) break;
    const remaining = budget - used;
    const { text, truncated } = truncate(section.text, Math.min(perSection, remaining));
    output.push({ ...section, text, chars: section.text.length, truncated });
    used += text.length;
  }
  return output;
}

export function filterSections(sections: PageSection[], selector?: string): PageSection[] {
  const q = selector?.trim().toLowerCase();
  if (!q) return sections;
  const asIndex = Number(q);
  if (Number.isInteger(asIndex)) return sections.filter((section) => section.index === asIndex);
  return sections.filter(
    (section) =>
      section.heading.toLowerCase().includes(q) ||
      section.path.toLowerCase().includes(q) ||
      section.text.toLowerCase().includes(q),
  );
}
