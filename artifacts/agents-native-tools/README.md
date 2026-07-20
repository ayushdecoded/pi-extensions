# `/agents` native tool-renderer evidence

Verified against Pi 0.80.7 using only `src/index.ts` as an explicitly loaded extension.

## End-to-end behavior

A fresh isolated parent session delegated to a real Mason child. The child used Pi's built-in `read` tool on `package.json`, then `bash`; a durable follow-up used a five-line Bash command.

A second isolated run delegated to Vigil and verified the padded transcript frame. `padded-vigil.*` shows the `Subagent · Vigil` title embedded in the top border, Vigil in its role color, one-column outer margins, and two-column inner horizontal padding. `padded-vigil.termctrl` is the corresponding terminal recording.

- `final-collapsed.*` — reopened durable child transcript with Pi-native collapsed `read` and `bash` rows. The viewer footer shows the configured `alt+o` tool key.
- `final-expanded-read.*` — the same durable transcript after sending configured `Alt+O`; Pi's native read renderer displays the syntax-highlighted `package.json` contents and the footer changes to “collapse tools”.
- `final-session.termctrl` — exact terminal recording of the final durable-session replay.
- `session.termctrl` — initial real Mason run and follow-up.

The replay intentionally does not invent historical Bash durations: Pi's persisted messages contain no execution timestamps, so historical output has no misleading `Took 0.0s` label.

## Rendering and lifecycle behavior

- Built-ins (`read`, `bash`, `edit`, `write`, `grep`, `find`, `ls`) use public `ToolExecutionComponent` rendering.
- Live custom tools use the child `AgentSession.getToolDefinition()` only for calls observed in the current invocation.
- Historical custom tools use a compact, sanitized fallback because custom renderer definitions are not persisted.
- Parallel results are paired back to tool-call source order.
- Runtime snapshots retain live arguments, partial results, final results, details, errors, and revisions.
- Images are replaced with a textual omission before reaching the native component, avoiding image decode/conversion work.
- Renderer invalidations escape the outer line cache; partial Bash timers are finalized when components are discarded.
- Same-source history replacement evicts obsolete components.

## Synthetic performance

`performance.json` measures native transcripts at width 100 using the real dashboard contract (`stableMessages` prefix identity and authoritative running-call sets).

| Fixture | Cold | Warm unchanged | Existing partial update | First live-tail insertion | Expand all |
|---|---:|---:|---:|---:|---:|
| 800 messages / 400 calls | 373.78 ms | 0.00056 ms | 0.507 ms | 0.668 ms | 538.52 ms |
| 1,600 messages / 800 calls | 671.22 ms | 0.00047 ms | 0.733 ms | 0.980 ms | 1,100.76 ms |

Values are medians. At 1,600 messages the collapsed cache added 9.37 MiB heap, expanded added 14.02 MiB, and only 0.48 MiB remained after disposal and forced GC.

Cold construction and expand-all scale linearly because each tool uses Pi's stateful native component. Warm and live-tail work remains sub-millisecond even for the 1,600-message stress fixture.

## Whole-process settled load

`settled-viewer-load-after-gc.json` samples the real Pi process with the durable native-tool viewer open for 10 seconds after startup GC settled:

- **0.0% of one core average and peak**
- **0.0 MiB RSS change**

`settled-viewer-load.json` retains the earlier startup/GC sample for transparency; its RSS fell by 77.8 MiB during deferred collection and is not steady-state viewer load.

## Automated verification

- `npm test` — **67/67 passed**.
- `npm run typecheck` — passed.
- Pi peer compatibility is constrained to `>=0.80.7 <0.81.0`, matching the public component API verified here.
