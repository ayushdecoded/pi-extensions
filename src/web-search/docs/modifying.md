# Modifying web search

Keep the tool small: `query`, `url`, `mode`, `section`.

## Rules

- Do not add result-count, timeout, region, or max-character tool params.
- Use newline-separated strings for multi-search/multi-fetch.
- Keep output Markdown and citation-friendly.
- Keep fetching, parsing, shaping, and formatting separate.

## Change public API

Edit:

```text
index.ts
types.ts
```

The schema should stay easy for models. Prefer local policy in `config.ts` over new tool params.

## Change search/fetch behavior

Edit:

```text
primitives/fetch.ts
```

Responsibilities:

- DuckDuckGo Lite request
- DuckDuckGo result parsing
- URL fetch
- timeout and parent abort forwarding

`fetchRawPage()` owns network cancellation. Keep the comments around `AbortController`; it exists because `fetch` has no native timeout and Pi may cancel the tool call.

## Change parsing or section behavior

Edit:

```text
primitives/html.ts
primitives/page.ts
```

Responsibilities:

- `html.ts`: clean HTML/text, extract headings, split into sections, filter sections.
- `page.ts`: detect HTML/text, parse sections, shape `structure`/`section`/`full` results.

If malformed JS/MDX leaks into output, update the noise filtering in `html.ts`.

## Change output format

Edit:

```text
primitives/format.ts
```

Output should remain Markdown:

```md
## Search: query

1. [Title](https://url)
   - Snippet
```

```md
## Page: https://url

- Status: OK, HTTP 200
- Mode: full
```

## Change limits/defaults

Edit:

```text
config.ts
```

Current defaults:

```text
maxResults: 5
maxChars: 12000
timeoutMs: 10000
fetchTopN: 1
region: undefined
```

## Checks

```text
npm run check
```

Smoke test patterns:

```text
query: DuckDuckGo Lite
query: DuckDuckGo Lite\nPlaywright MCP
url: https://example.com, mode: structure
```
