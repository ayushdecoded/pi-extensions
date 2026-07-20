---
name: terminal-control
description: Verify interactive terminal behavior with Terminal Control and retain useful evidence.
---

# Terminal Control

Use Terminal Control to exercise terminal applications as a user would and verify observable behavior, not merely process exit.

## Verification workflow

Start a fresh, clearly named session with the intended working directory, dimensions, command, model, and environment. Keep fixtures isolated and tasks bounded.

Drive the application through normal input. Prefer waiting for a meaningful visible state over fixed sleeps. Inspect the current screen as the interaction progresses, especially before sending state-dependent keys.

Verify the outcome at the layers that matter:

- the terminal shows the expected state and remains usable,
- resulting files, sessions, journals, or records contain the expected data,
- configured models and tools were actually used,
- failures and cleanup behave as expected.

Save screenshots or logs at meaningful transitions such as selection, running, approval, completion, failure, and reopened history. Evidence should demonstrate the behavior under test rather than merely show that the application launched.

Treat timeouts and unexpected screens as evidence. Inspect session status, visible output, retained logs, and durable artifacts before retrying. Do not repeat an unchanged interaction or report success from backend state alone when the UI is part of the contract.

Stop every session when verification is complete and confirm no child terminal sessions remain.

Use `termctrl --help` and command-specific help for the current interface instead of relying on memorized flags.
