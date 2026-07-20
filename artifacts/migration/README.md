# Global cutover verification

Verified with a fresh normal Pi 0.80.7 process after replacing the global `o-pi-um` package registration with the local `my-pi-setup` directory.

- `startup.*` — only `pi-internals`, `/create-skill`, `/handoff`, Herdr, Pi documentation integration, and the new pack are present. The new header/footer render without extension issues.
- `shortcuts.*` — the active model rotated from Sol to Terra with `Alt+Right`; directional thinking shortcuts were exercised immediately beforehand.
- `web-search.*` — the ported `web_search` tool performed a real DuckDuckGo search and returned citation-friendly results.
- `subagent.*` — the globally configured native Atlas agent completed successfully and footer accounting included its usage.
- `system-prompt.json` — the final prompt begins with the bundled collaborative-engineering-lead identity exactly once, retains cwd, and contains no `system-prompt-lean` duplicate.
- `global-cutover.termctrl` — exact Terminal Control recording.

All migration verification sessions were stopped. The previous global files are retained only in the inert backup reported during cutover; they are not discovered by Pi.
