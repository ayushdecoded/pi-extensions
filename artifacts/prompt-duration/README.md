# Prompt duration UI evidence

Verified with Terminal Control against Pi 0.80.7 using `--no-extensions --extension ./src/index.ts --approve`.

- `live.*` — a real model turn running `sleep 12`; Pi's native working row updates as `⚡ Zipping · 5s` while the terminal remains responsive.
- `divider-wide.*` — the durable custom-entry renderer at 110 columns for an 8h 21m fixture: `✦ 🫠 Returned from the void after 8h 21m ✦` with a full-width themed rule.
- `divider-narrow.*` — the same persisted renderer after resizing to 48 columns; output remains width-safe and readable.
- `session.termctrl` and `divider.termctrl` — exact Terminal Control recordings for the live and divider checks.

The real 32-second turn intentionally left no completed divider because production policy renders completed durations only from one minute. Backfill, threshold, deduplication, and every style band are covered in `test/prompt-duration.test.ts`.

All Terminal Control sessions were stopped after capture, and the temporary divider command fixture was removed.
