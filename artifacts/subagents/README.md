# Subagent UI verification

Tested Pi 0.99.2 in an isolated tmux server (`pi-subagents-qa`) at 110×36 and 52×30. Terminal Control is unavailable; these are text captures, not screenshots or Terminal Control evidence.

## Current widget and completion cards

`ui-fixture.ts` provides `/ui-seed`, `/ui-finish`, and `/ui-age`. It creates deterministic native-runtime jobs without model calls. Completions are display-only messages and do not wake a model. `/ui-age` places finished records one second before the two-minute expiry boundary, allowing the actual idle redraw behavior to be checked quickly.

Verified:
- Alt+M switches the expanded widget to exactly one line above the composer.
- Collapsed state and running handles survive `/reload`.
- Finished records display compact token counts (`4k tokens`).
- Completed-only widgets disappear at expiry without further keyboard input.
- Completion cards show a short result preview; Ctrl+O exposes the complete report and metadata.
- Native tool cards stay compact before and after `/reload`, rather than reverting to raw arguments/results. `create-transcript-fixture.ts` creates an offline native session with an assistant tool call and tool result to exercise transcript reconstruction.

Captures:
- `collapsed-wide.txt`, `collapsed-reload.txt`, `completed-collapsed.txt`
- `widget-narrow.txt`, `completion-narrow.txt`, `completion-wide.txt`, `completion-expanded.txt`
- `widget-expired.txt`
- `tool-before-reload.txt`, `tool-after-reload.txt`

## Historical captures

`panel-wide.txt`, `panel-narrow.txt`, `details-wide.txt`, `cancel-narrow.txt`, `widget-wide.txt`, `reload-live.txt`, and `startup.txt` document the earlier panel iteration. **The `/agents` panel has since been removed.** They are retained as historical evidence, not the current UI.

Automated tests additionally cover state retention, expiry boundaries, disposal, Unicode/narrow widths, native follow-ups, and title usage. The revised title prompt was also checked against the live configured Luna model: the formerly problematic follow-up produced `Recall extension entry points from prior task` instead of an answer/apology.
