# Web search tool API

```ts
web_search({
  query?: string,
  url?: string,
  mode?: "search" | "structure" | "full" | "section",
  section?: string,
})
```

Use either `query` or `url`.

## Search

```json
{ "query": "Playwright MCP", "mode": "search" }
```

Returns DuckDuckGo Lite results as Markdown links.

## Read a URL

```json
{ "url": "https://playwright.dev/mcp/introduction", "mode": "structure" }
```

Use `structure` first for long pages, then `section` for exact content.

## Read a section

```json
{
  "url": "https://playwright.dev/mcp/introduction",
  "mode": "section",
  "section": "2"
}
```

`section` can match:

- section index
- heading text
- heading path
- body text

## Multiple searches or URLs

Use newlines:

```json
{
  "query": "DuckDuckGo Lite\nPlaywright MCP",
  "mode": "search"
}
```

```json
{
  "url": "https://example.com\nhttps://playwright.dev",
  "mode": "structure"
}
```

## Modes

| Mode        | Meaning                       |
| ----------- | ----------------------------- |
| `search`    | Search results only           |
| `structure` | URL page outline only         |
| `full`      | Bounded page text by sections |
| `section`   | Exact matched section text    |

## Hidden policy

The model cannot set result count, output budget, timeout, region, or fetch depth through tool params. These are local defaults in `config.ts`.
