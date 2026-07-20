# `/agents` Markdown and responsiveness evidence

Verified in a fresh Pi 0.80.7 process with only `src/index.ts` explicitly loaded. The root session was isolated under `/tmp/pi-agents-markdown-e2e`; native child sessions used Pi's normal subagent session directory.

## End-to-end behavior

- `live-viewer.*` — settled Mason transcript rendered through Pi's native Markdown renderer. The source contains an H1, bold text, list, TypeScript fence, and Markdown table; the viewer shows styled prose, highlighted code, and a terminal table rather than raw Markdown markers.
- `narrow-viewer.*` — the same transcript at 58×24. Header metrics and controls reduce cleanly, content reflows, and every visible row remains inside the terminal width.
- `live-stream-final.*` — a real follow-up on `mason-1` streamed an 80-item Markdown list into the open viewer and remained usable through settlement.
- `session.termctrl` — exact terminal recording. Markers: `live-viewer`, `narrow-viewer`, `live-load-start`, and `live-stream-final`.
- `durable-evidence.json` — one persistent Mason handle, fresh invocation #1, follow-up invocation #2, both complete with native usage; child-session source confirms both Markdown headings, the source table, and item 80.

## Load measurements

`performance.json` uses a synthetic long transcript of 1,600 messages / 8,799 rendered rows at width 100:

- Cold native-Markdown render: **108.46 ms**.
- Warm unchanged render: **0.056 ms mean**, **0.057 ms p95**.
- Live-tail update with the historical prefix cached: **0.084 ms mean**, **0.116 ms p95**.
- Rebuilding the full transcript cold for each live update: **62.37 ms mean**.
- Measured cached-tail speedup over cold full rebuilding: **~741×**.
- Cold projection of 1,000 batches: **13.10 ms**; cached projection lookup: **0.000048 ms mean** across 10,000 calls.
- Cold transcript cache heap delta in this run: **+2.58 MiB**.

Whole-process `/proc` samples from the real Pi E2E (these include model/runtime/TUI work, so they are an upper bound rather than extension-only CPU):

- Settled parent with `/agents` closed: **0.0% of one core** over 10 s.
- Settled `/agents` tree: **0.0% of one core** over 10 s.
- Settled Markdown viewer: **0.20% of one core** over 10 s; RSS decreased slightly during the sample.
- Open viewer across a real sleep, Markdown stream, and settlement: **1.90% of one core average**, **23.97% peak 250 ms sample**; RSS increased **0.50 MiB**.

The dashboard caps transcript-triggered paints at 20 Hz, does not send token deltas to the compact panel, stops its one-second clock when all work settles, reuses the completed transcript prefix, memoizes batch projections, and caches footer accounting rather than replaying the full session on overlay paints.

## Automated verification

- `npm test` — **54/54 passed**.
- `npm run typecheck` — passed.
- Adversarial review checked real Pi `streamingMessage`, parallel `pendingToolCalls`, message-end persistence ordering, theme invalidation, width safety, timer disposal, and cache invalidation.
- The Terminal Control session was stopped; no test Pi process remained.
