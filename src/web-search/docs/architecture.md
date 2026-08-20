# Web search architecture

The extension exposes one Parallel-backed `web_search` tool and one
`/web-search` command for securely storing its API key.

## Flow

```text
/web-search
  -> paste Parallel API key
  -> store with restrictive permissions

web_search({ objective, search_queries })
  -> terminal card shows the three queries
  -> one Parallel Search API request
  -> ranked URLs, titles, dates, and LLM-optimized excerpts
  -> excerpts remain model-visible and are hidden from the terminal UI
```

## Authentication

The Parallel API key pasted through `/web-search` is stored at
`~/.config/pi/web-search.json` with restrictive file permissions.
`PARALLEL_API_KEY` is also accepted as a fallback.

## Search semantics

The objective is a self-contained natural-language research goal. Exactly three
diverse keyword queries of three to six words are supplied with it, following
Parallel's tool-calling best practices. Search uses `basic` mode and identifies
the consuming model so Parallel can optimize its excerpts. Provider defaults
control retrieval breadth; the returned tool content is capped locally.
