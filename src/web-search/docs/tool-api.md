# Web search tool API

```ts
web_search({
  objective: string,
  search_queries: [string, string, string],
})
```

`objective` is a concise, self-contained research goal. `search_queries` must
contain exactly three diverse keyword queries of three to six words, each
including the key entity or topic. Do not use sentences, instructions, or
`site:` operators.

The tool uses Parallel Search in `basic` mode and returns ranked results with
citation URLs, titles, publish dates when available, and LLM-optimized excerpts.
Run `/web-search` to securely store a Parallel API key, or set
`PARALLEL_API_KEY`.
