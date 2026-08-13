# My Pi Setup

A self-contained Pi package with a main-agent identity, persistent native subagents, role prompts, `/handoff`, `/create-skill`, web search, and integrated accounting/UI. It uses Pi's in-process SDK and native session statistics throughout.

## Runtime

- No tmux, subprocesses, RPC, or detached workers.
- Child agents use `createAgentSession()` and persistent `SessionManager` sessions.
- Concurrency is shared across the complete delegation tree.
- Agents share the working directory; concurrent implementation tasks need non-overlapping file or symbol ownership.
- `delegates` controls role-scoped nesting. A child sees a `subagent` tool only when its role allows targets and the global depth limit has not been reached.
- Nested tool schemas expose only allowed roles, and follow-ups are limited to allowed agents spawned by that delegator.
- At maximum depth, children are created without the `subagent` tool.
- Handles are scoped to the root parent session: `atlas-1`, `forge-1`, `vigil-1`, and so on.
- Reopening the parent session restores handles, history, accounting, and child transcripts.

## Main prompt

The extension supplies `resources/SYSTEM.md` through `before_agent_start` when Pi has no explicit project or global `SYSTEM.md`. Pi emits that event for every submitted agent run and resets absent overrides, so the package caches one assembled replacement per base-prompt configuration and returns the same replacement each time. It is never cumulatively appended.

Explicit `SYSTEM.md` files remain an escape hatch and win over the package. APPEND_SYSTEM content, project context, loaded skills, and the working directory are preserved in the assembled prompt. Child agents do not load the full parent extension; they receive only their isolated role prompt, allowed skills, vision hook, and the inline account-routing hook described below.

## Configuration

One complete agent configuration is selected in this order:

1. `<cwd>/.pi/agents.yaml`
2. `~/.config/pi/agents.yaml`
3. `resources/agents.yaml` bundled with this package

Files are never merged. Only the version 1 schema is supported.

```yaml
version: 1
defaults:
  maxDepth: 2
  concurrency: 10
  timeoutMinutes: 10
  image: opencode-go/qwen3.7-plus
  imagePrompt: agents/vision.md
default_preset: deep
roles:
  Atlas:
    description: Read-only explorer for codebase and web research
    model: opencode-go/deepseek-v4-flash
    thinking: high
    prompt: agents/atlas.md
    tools: [read, bash, web_search]
    delegates: []
    skills: []
    timeoutMinutes: 10
  Forge:
    description: Implementation agent for approved, bounded changes
    model: opencode-go/deepseek-v4-flash
    thinking: high
    prompt: agents/forge.md
    tools: [read, bash, edit, write]
    delegates: []
    skills: []
    timeoutMinutes: 20
presets:
  light:
    roles: [Atlas, Forge, Vigil]
    Atlas:
      model: opencode-go/deepseek-v4-flash
      thinking: high
    Forge:
      model: opencode-go/deepseek-v4-flash
      thinking: high
    Vigil:
      model: opencode-go/deepseek-v4-flash
      thinking: max
```

`roles` is the pool of role definitions; `presets` pick which roles are active and can override a role's `model`, `thinking`, `prompt`, `image`, or `imagePrompt` per preset. `default_preset` names the preset used when none is chosen, so everything stays in sync with the same file. Configurations without `presets` keep the classic behavior: every role is active with its own defaults.

### Vision sidecar

When a text-only role model reads an image file, the `read` result keeps the image bytes (so the transcript still shows the image) and appends a description from the configured `image` sidecar model (resolves preset → role → `defaults`; `imagePrompt` points to the instruction file, default `agents/vision.md`, falling back to the built-in prompt). The role model never sees a new tool — it calls the normal `read` — and the sidecar usage rides the tool result, so per-invocation accounting stays truthful. Models that support images get the raw image as usual and the sidecar never runs. When no sidecar is configured, a text note is appended instead.

### Switching presets

The active preset starts from `default_preset` (or the last selected one, persisted in `~/.config/pi/agents-mode.json` per config path). Use `/agent-mode` (with argument completion, or a picker when run bare) to choose a preset, or `Ctrl+Shift+S` to cycle through them. Switching takes effect immediately for new subagent calls and re-renders the header (role models + `mode:` label) and footer (`◆ mode`).

Use `/agents configure` to choose a model and thinking level for each role. The overlay opens on the roles list (header shows the active mode, so edits are scoped to it), then per role: settings → Model (provider → model, with `Tab` toggling Pi's session-scoped models and all available models, and typing to filter) or Thinking (all seven levels). Each confirmed edit applies immediately to new invocations, leaves running agents unchanged, and persists in `~/.config/pi/agents-model-overrides.json` per `agents.yaml` path, active preset, and role. Named plan-account aliases are deduplicated to their canonical provider, so `/account` continues to select the account used. Reset restores the field declared by the active preset without rewriting `agents.yaml`.

Prompt paths are relative to the selected `agents.yaml`. Project configuration is rejected when Pi does not trust the project. `subagent` is not listed in `tools`; the runtime adds a filtered tool automatically when `delegates` is non-empty.

## Tool

Fresh agents:

```ts
subagent({
  agents: [{ role: "Atlas", task: "Map session ownership." }],
});

subagent({
  agents: [{ role: "Forge", task: "Implement the approved parser change in src/parser.ts and its tests; preserve the public API and run the parser test suite." }],
});
```

Follow-up:

```ts
subagent({
  agents: [{ agent: "atlas-1", task: "Recheck against the implementation." }],
});
```

Independent array items execute concurrently. `timeoutMinutes` may be omitted to use the role-specific or global default, set to any positive integer to override that default, or set to `-1` for no timeout. Configured timeout values are defaults, not maximum limits.

Root-session delegations are **background by default**: the call returns a batch receipt immediately and one aggregated follow-up arrives after every agent settles, so the main agent continues other work without polling. Pass `background: false` only when this turn must block on the results before doing anything else:

```ts
subagent({
  agents: [
    { role: "Atlas", task: "Map the existing API and return evidence." },
    { role: "Vigil", task: "Review the approved design risks." },
  ],
}); // detached; results arrive later

subagent({
  background: false,
  agents: [{ role: "Forge", task: "Implement the change and wait inline for the result." }],
});
```

After every requested agent has settled—including failures, timeouts, and cancellations—the extension delivers one aggregated follow-up to the main session and triggers a turn when idle. A compact transcript card marks the result (`⟳ Background subagents · settled`) with one colored line per agent; expand it to read the full outputs the model received. Nested child-agent tools do not expose `background`; their delegations remain synchronous, including when the root batch itself is running in the background.

## Session transfer and prompt commands

Use `/handoff [optional next goal]` to transfer the recorded work into a fresh parent-linked session. The command runs a normal main-agent summary turn with the existing tools and subagent orchestration available, waits for it to settle, and opens the generated chronological handoff for review. Accepting the review creates the new session and places the edited handoff in its editor; it is never submitted automatically. With no argument, the handoff continues the current work from its present state. For unusually large, compacted, or incomplete histories, the agent may use read-only Atlas subagents to inspect the saved session history.

Use `/create-skill [request]` for an evidence-driven interview followed by creation of a concise project-local Pi skill. Use `/save-md` to save the latest completed assistant response as Markdown in the gitignored `AgentDocs/` directory, with a Spark-generated filename.

## Experimental: plan accounts (enabled by default)

Named accounts are supported for the `openai-codex` and `opencode-go` plan providers. This feature is experimental but currently enabled by default; there is no opt-in flag. Pi still owns every credential, OAuth flow, refresh, request, and retry: the extension registers native provider aliases and uses Pi's existing `/login` and `/logout` commands. Account metadata contains display names, selection, quota windows, and timestamps only; it is stored globally in `~/.pi/agent/accounts.json` (or the active Pi agent directory) with no tokens or API keys.

- `/account` or `/account switch` opens a provider-first TUI picker.
- `/account status` lists both providers and marks selected, login-required, and exhausted accounts.
- `/account add codex Work` creates a named account and prefills native `/login` for its alias.
- `/account switch codex Work` switches without a picker and works in print/RPC-style command execution.
- `/account rename codex Work Personal` changes only the display name.
- `/account remove codex Work` removes metadata after that alias has been logged out with native `/logout`.

Provider arguments accept `codex`, `openai-codex`, `opencode`, `go`, or `opencode-go`. One account is selected globally per provider. Parent sessions, native subagents, vision sidecars, painter, voice transcription, headings, and footer labels all resolve through that selection. A quota failure can move only to another authenticated account of the same provider; it never crosses from Codex to OpenCode Go or vice versa. A child failover updates a parent only when the parent uses that same provider, then continues the interrupted task without replaying its original prompt.

Codex quota windows are polled through the authenticated native Codex provider after turns, periodically, and near known reset times. OpenCode Go quota state comes only from provider response headers/errors. The UI says `exhausted` when reset timing is unknown and adds `resets …` only when the provider supplied a usable reset instant.

## Voice input

`Ctrl+Shift+R` (or `/voice`) toggles voice input: the first press starts recording the microphone via `pw-record`, the second stops and transcribes the clip into the prompt editor. While recording, a widget above the editor shows a pulsing REC dot, an elapsed timer, and a waveform that responds to the actual microphone level (sampled from the growing WAV file). On the second press the widget switches to a transcribing spinner; when the transcript arrives it is pasted into the input box with a preview notification and the widget disappears. The footer status text is not used — the widget is the indicator.

Mirroring Omarchy's native Voxtype dictation (`pause_media`), MPRIS media players (Spotify, etc.) are paused automatically while recording and resumed as soon as recording stops, before transcription. The media pause is backed by `playerctl` and degrades to a no-op if it is missing or no players are active.

Transcription reuses the active Codex/ChatGPT login — the same OAuth credential the `painter` tool uses — via the `src/codex-auth.ts` shared helper. Audio is posted to the ChatGPT backend `transcribe` endpoint (`https://chatgpt.com/backend-api/transcribe`), so no API key or per-minute billing is involved; your ChatGPT plan's voice allowance applies. Like `backend-api/codex/images`, this is the endpoint the Codex desktop app uses and is not a stable public API — OpenAI can change it, which would need a follow-up here.

Requires a `pw-record` (PipeWire) on the machine and an `openai-codex` model signed in. Recordings are written to a temp dir (`$TMPDIR/pi-voice`) and deleted after transcription; a stale pidfile kills a recorder left over from a crashed session.

## Web search

The `web_search` tool searches DuckDuckGo Lite and reads URLs without a browser dependency. Its public inputs remain deliberately small: `query`, `url`, `mode`, and `section`. Result count, output budget, timeout, region, and fetch depth are local policy rather than model-controlled parameters.

## UI

- A centered Pi header keeps fresh sessions clean while Pi's native resource inventory remains visible.
- The footer shows aggregated active-leaf input (`↑`) and output (`↓`), plus the latest Pi-native main-session cache hit rate (`CH`). Child usage never affects `CH`; aggregate cache token counts are not displayed.
- Footer cost uses separately spaced `↳` for the active leaf and `◆` for the complete persisted session tree; both include native parent and nested subagent invocation usage exactly once. Provider, model, and thinking level are distinctly themed.
- The pack binds `Alt+.` / `Alt+,` to increase/decrease thinking. Host keybindings use `Alt+M` to rotate forward through scoped models.
- Pi's native working row shows a playful, once-per-second user-perceived timer for the active prompt. Completed prompts lasting at least one minute leave a responsive, duration-themed divider in the transcript without entering LLM context; queued prompts retain their original submission time.
- Active tool-loop tasks compact at 85% context only at a completed turn boundary, then receive a hidden continuation message after compaction. Native threshold compaction below 85% is deferred per model window; manual and overflow compaction remain untouched.
- The above-editor widget shows only the newest batch; all earlier batches collapse into one `/agents` history link. Agent rows show role, status, elapsed time, tokens, cost, and current activity without exposing invocation prompts, handles, or invocation numbers.
- Nested agents render as a spaced, responsive tree. Atlas, Forge, and Vigil have consistent role colors; costs use green below $2, yellow below $7, and red from $7.
- Follow-ups retain the same handle and display `↻` with their invocation number. Subagent tool calls show a prompt-free request roster, and results always show prompt-free per-invocation duration, token, and cost metrics.
- `/agents` opens aligned batch history and nested agent trees plus a fullscreen read-only transcript viewer using Pi-native user, assistant, markdown, and thinking presentation.
- The viewer never sends messages or cancellation commands to child agents.

## Extension pack

This repository is the pack. Its `package.json` Pi manifest imports `src/index.ts` as the extension and `.pi/prompts` as prompt templates; role and system prompts plus web-search implementation are bundled internal resources. The project-local `terminal-control` skill is intentionally outside the manifest.

Pi can load the directory temporarily or register it as a local package:

```bash
pi --extension /absolute/path/to/pi-extensions
pi install /absolute/path/to/pi-extensions
```

A local-path install stores the path in Pi settings; it does not copy or archive the repository. Do not activate this pack alongside another extension that registers `subagent`. Installing or removing it changes settings for future starts/reloads, so perform the eventual global cutover only after active Pi tasks have stopped.

## Development

```bash
npm test
npm run typecheck
```

Isolated extension invocation:

```bash
pi --no-extensions --extension ./src/index.ts --approve
```

The project-local `terminal-control` skill under `.pi/skills/` documents interactive verification. Retained UI evidence is indexed in `artifacts/ui/README.md`.
