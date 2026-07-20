# Terminal Control E2E evidence

Run against Pi 0.80.7 with only `src/index.ts` explicitly loaded. Root sessions were isolated under `/tmp/pi-subagents-termctrl-e2e`; native child sessions were persisted under Pi's normal `~/.pi/agent/subagent-sessions/<root-session-id>/` directory.

## Key evidence

- `02-running.*` — two-agent parallel batch with Mason completed (`✓`) while Atlas remains active; live native tokens and cost shown.
- `03-complete.*` — completed batch collapsed in both tool result and persistent widget.
- `04-followup-running.*` — `atlas-1` shown as `↻ Atlas #2`, not a new agent identity.
- `06-dashboard.*` — `/agents` newest-first batch history.
- `07-followup-tree.*` — follow-up identity in the selected batch tree.
- `08-fullscreen.*` — complete read-only transcript for both calls in `atlas-1`.
- `09-readonly-input-ignored.txt` and `durable-evidence.json` — printable viewer input was ignored and never entered the child session.
- `10-returned-parent.*` — returning from fullscreen restores the parent UI and collapsed summaries.
- `11-nested-running.*` — live Forge → Atlas nested tree.
- `12-nested-child-complete-parent-running.*` — nested Atlas receives a tick while parent Forge continues.
- `13-nested-settled.*` — nested tree settles into one collapsed summary with combined native usage.
- `14-reopened.*` — parent session reopened with all summaries and accounting restored.
- `15-reopened-followup-running.*` / `16-reopened-followup-complete.*` — `mason-1` resumed after process restart as follow-up #2.
- `17-before-cancel.*` / `19-after-escape-cancel.*` — Pi Escape interruption aborts the native child, retains partial usage, and leaves the parent usable.
- `20-depth-limit.*` — depth-2 Mason reports `DEPTH_BLOCKED`; durable evidence confirms it made no `subagent` tool call.
- `21-live-fullscreen.*` — fullscreen read-only viewer attached while an agent's bash tool was active.
- `25-live-long-before-ctrl-c.*` / `26-ctrl-c-active-tree.*` — `Ctrl+C` exits the read-only viewer while the selected child remains active.
- `27-live-completed-in-viewer.*` — the same child later completes and updates in the viewer.
- `durable-evidence.json` — models, child session paths, invocation topology, follow-up ordinals, statuses, and native cost/token deltas.
- `session.termctrl` / `resumed.termctrl` — exact Terminal Control recordings.

## Observations

The first running panel exposed an incorrect root connector (`└─` on every root). `src/ui/panel.ts` was corrected to render `├─` for non-final roots and `└─` for the final root; subsequent nested evidence uses the corrected renderer.

Pi's visible key help defines Escape as the active-operation interrupt. `Ctrl+C` is clear/exit in the normal parent UI, while this extension consumes it only inside the read-only viewer to return to the tree without cancelling the child.

All Terminal Control sessions exited successfully and no test Pi process remained after cleanup.
