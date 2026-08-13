# UI Terminal Control evidence

Run against Pi 0.80.7 with extension discovery disabled and only `src/index.ts` explicitly loaded.

- `startup.*` — centered fresh-session header, native resource inventory, and zeroed custom footer.
- `thinking-cycle.*` — `Alt+.` changed thinking from `medium` to `high`; the footer updated immediately.
- `model-cycle.*` — `Alt+,` moved the scoped model from Sol to Terra; the footer updated immediately.
- `subagent-accounting.*` — a real Atlas invocation completed with native child usage; the footer combined parent and child input/output/cache-read tokens and cost.
- `tree-vs-leaf.*` — after navigating to the pre-run user leaf, leaf usage/cost reset to zero while complete-tree cost retained the abandoned branch (`↳$0.00 ◆$0.01`).
- `new-session-immediate.*` — `/new` immediately restored the centered header, resource inventory, and zeroed accounting without requiring a resize.
- `reload-running-before.*` — a background Atlas subagent mid-task (bash `sleep 25`) right before `/reload`.
- `reload-running-after.*` — the same agent still `running` after `/reload`, adopted by the reloaded extension instance.
- `reload-settled-after.*` — the aggregated `⟳ Background subagents · settled` card delivered post-reload with `✓ Atlas · atlas-1 · complete`, and the main agent's summary turn.

Reload survival was additionally verified at the event layer: the batch that crossed `/reload` recorded `invocation.finished … complete`, while a batch interrupted by `/tree` branch navigation recorded `invocation.finished … cancelled (Cancelled by the parent session.)`.

`current-ui.termctrl` and `new-check.termctrl` — exact Terminal Control recordings.

All Terminal Control sessions were stopped after capture.
