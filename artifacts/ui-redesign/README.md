# Subagent UI redesign evidence

Verified in a fresh normal Pi 0.80.7 session using the globally active local `my-pi-setup` package.

- `active-panel.*` — three live agents with prompt-free, aligned role/status/time/token/cost/activity rows.
- `followup-panel.*` — resumed Atlas displayed only as `Atlas ↻`; exactly one newest batch is visible and the previous batch is collapsed into the `/agents` history line.
- `viewer.*` / `mason-viewer.*` — native-themed user and assistant transcript rendering plus distinct tool call, arguments, result, role, status, and cost colors.
- `tree-navigation.*` — arrow selection remains on the selected invocation after render; this recording follows a Terminal Control-discovered state synchronization fix.
- `session.termctrl` — exact interaction recording.

The footer evidence in these captures shows aggregate parent+child input/output and costs, main-session-only native `CH` cache hit rate, spaced leaf/tree costs, and separated provider/model/thinking presentation.

All Terminal Control sessions were stopped after verification.
