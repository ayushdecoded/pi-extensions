# Multi-account interactive verification

Run in isolated, freshly named 150×42 terminal sessions against Pi 0.84.0 with extension discovery disabled and only `src/index.ts` explicitly loaded. The isolated `PI_CODING_AGENT_DIR` contained synthetic API-key credentials and account metadata and was deleted afterward.

Evidence:

- `provider-picker.txt` — bare `/account` opens the provider-first overlay with Codex and OpenCode Go account counts.
- `codex-accounts.txt` / `opencode-accounts.txt` — account-stage rows show selection, login requirements, and the add action; the selected account is the initial cursor.
- `status.txt` — `/account status` reports provider-isolated account state.
- `manual-switch.txt` — normal keyboard navigation switches from Go Work to authenticated Go Spare and the footer immediately shows `opencode-go/Go Spare`.
- `persisted-restart.txt` / `persisted-picker.txt` — a fresh Pi process restores Go Spare as both the active footer account and selected picker row.
- `reset-unknown-final.txt` — an exhausted account with no reset timestamp renders only `exhausted`.
- `reset-known-final.txt` — a known same-day reset renders `exhausted · resets 3:29 AM`.
- `final-session.typescript`, `persisted-session.typescript`, and `reset-final-session.typescript` — raw `script(1)` PTY recordings of the switch, restart, and reset-display sessions.

The `termctrl` executable was not installed in this harness, so the available named tmux sessions plus raw PTY recordings were used to retain the same observable terminal evidence. All named sessions and isolated Pi processes were stopped, and the temporary agent directory was removed.
