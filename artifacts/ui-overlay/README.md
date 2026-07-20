# Inline and `/agents` overlay verification

Verified against a fresh globally active `my-pi-setup` session with Terminal Control.

- `live.*`: live two-agent tool card and inline panel. The card shows role, scoped model, thinking, timeout, live status, duration, tokens, and cost without prompts or handles. The inline summary stays on one line and the agent rows use aligned columns.
- `viewer.*`: framed read-only `/agents` transcript with lightweight `>` user, `→ tool {args}`, `output:`, and assistant rendering. Header metadata and metrics align left/right; the viewport and controls remain fixed.
- `session.termctrl`: exact terminal interaction recording.

The batches and tree views were also exercised interactively: framed full-width layout, stable arrow selection, role/model/thinking/status/duration/token/cost details, and no user-facing handles or ordinals.

Final verification: 31/31 tests passed and TypeScript typecheck passed. All Terminal Control sessions were stopped.
