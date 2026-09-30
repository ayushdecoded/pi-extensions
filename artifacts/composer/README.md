# Composer UI verification

Pi 0.99.2 was tested through isolated tmux at 110×36 and 52×30. Terminal Control is unavailable; captures are text evidence, not screenshots.

`create-session.ts` writes a native offline transcript with deterministic usage: CH98.8%, $53.422 cost, and approximately 16% of a 272k context window. These are fixture values, not real spending. `ui-fixture.ts` registers an in-process fake provider; it never makes network/model calls. Submitting a prompt starts a cancellable fake stream to exercise Pi's native working indicator. `/ui-multiline` seeds native multiline editor text.

Verified:
- One footer row with project, branch, cache hit rate, and native cost; model/thinking on the right when space permits.
- Context usage embedded in the top composer border.
- Native working indicator coexists with the context label (`working.txt`).
- Autocomplete remains below the editor without replacing its border (`autocomplete.txt`).
- Native multiline text (`multiline.txt`).
- Alt+M subagent widget collapse above the composer (`widget-collapsed.txt`).
- Layout and editor/widget behavior survive `/reload`.
- Narrow layouts omit tiny model-name fragments instead of adding another footer row.

`wide.txt` shows deterministic initial usage. After aborting the fake response, native cache-hit behavior omits the latest empty prompt's cache rate in subsequent captures. Subscription detection is covered by automated tests rather than fake provider authentication.

Background-cost integration: `background-costs.txt` and `background-costs-reload.txt` show $53.422 native fixture cost plus $0.040 from four agents (one nested) = **$53.462**, unchanged after reload. Nested work is included once via Forge, and CH remains 98.8%. All amounts are synthetic fixture usage. Automated tests also cover distinct follow-ups, malformed state, cancelled work, and synchronous/native deduplication.

The session-total widget regression is captured separately in `../subagents/session-totals.txt`: expired finished rows are gone, while the summary preserves `4 done` alongside four new running agents.
