# Web search architecture

The web search extension exposes one `web_search` tool for DuckDuckGo Lite search and URL reading.

## Layout

```text
index.ts              extension registration, tool schema, multi-target orchestration
types.ts              params, config, search result, fetched page shapes
config.ts             local defaults for limits and fetch policy

primitives/
  fetch.ts            DuckDuckGo Lite search, URL fetch, timeout/abort control
  page.ts             raw page -> sections -> shaped FetchedPage
  html.ts             HTML/text cleanup, heading extraction, section filtering
  format.ts           Markdown output for model context
```

## Flow

Search:

```text
web_search query
  -> index.ts splits newline-separated queries
  -> fetch.ts queries DuckDuckGo Lite in parallel
  -> format.ts renders Markdown result lists
```

URL read:

```text
web_search url
  -> index.ts splits newline-separated URLs
  -> fetch.ts fetches URLs in parallel
  -> page.ts parses and shapes pages by mode
  -> html.ts extracts text/sections
  -> format.ts renders Markdown pages
```

## Modes

```text
search      DuckDuckGo result list only
structure   page outline/headings only
full        bounded page text grouped by sections
section     selected section text by index/heading/path/text match
```

## Multi-target input

Multiple queries or URLs are passed as newline-separated strings:

```json
{ "query": "DuckDuckGo Lite\nPlaywright MCP", "mode": "search" }
```

```json
{ "url": "https://example.com\nhttps://playwright.dev", "mode": "structure" }
```

Each target is processed concurrently and rendered as a separate Markdown block separated by `---`.

## Output

Tool output is Markdown for model readability and citation:

```md
## Search: DuckDuckGo Lite

- Results: 5

1. [Title](https://example.com)
   - Snippet
```

Fetched pages use:

```md
## Page: https://example.com

- Status: OK, HTTP 200
- Mode: structure

### Outline

- [0] Heading (123 chars)
```
