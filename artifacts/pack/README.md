# Local extension-pack verification

The repository directory was registered with `pi install /absolute/path/to/pi-extensions` under an isolated temporary Pi configuration. No real user settings or global package registrations were changed.

- `local-installed-startup.*` — Pi 0.80.7 started normally from the isolated settings entry, discovered `package.json`, imported `src/index.ts`, exposed `/handoff`, and rendered the custom header/footer. Bundled agent fallback initialization produced no error.
- `system-prompt-evidence.json` — a temporary observer inspected `ctx.getSystemPrompt()` at `agent_start`. The final effective prompt started with the bundled collaborative-engineering-lead prompt, contained that identity exactly once, and retained the working directory.
- `local-package.termctrl` — exact Terminal Control recording of the local directory package startup.

This repository is the extension pack. No `.tgz`, copied installation, or generated distributable is required.
