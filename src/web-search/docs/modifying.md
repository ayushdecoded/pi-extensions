# Modifying web search

The extension exposes one Parallel-backed `web_search` tool and one
`/web-search` API-key configuration command.

## Public API

```text
objective: string
search_queries: string[3]
```

The objective must be self-contained. Each query should contain the key entity
or topic, use three to six words, and vary names, synonyms, or angles. Queries
must not be sentences, instructions, or `site:` expressions.

## Behavior

`index.ts` owns validation, the `parallel-web` SDK call, output formatting, and
the command. Search uses `basic` mode and passes the consuming model ID. Do not
add advanced result limits unless a product requirement justifies restricting
Parallel's retrieval; bound tool output locally instead.

The API key is stored at `~/.config/pi/web-search.json` with mode `0600`.
`PARALLEL_API_KEY` is accepted as a fallback.

## Checks

```text
npm run typecheck
npm test
```

A live smoke test requires configuring a key with `/web-search` or setting
`PARALLEL_API_KEY`.
