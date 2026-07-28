# My Pi Setup

A self-contained Pi package with a main-agent identity, persistent native subagents, role prompts, `/handoff`, `/create-skill`, web search, and integrated accounting/UI. It uses Pi's in-process SDK and native session statistics throughout.

## Runtime

- No tmux, subprocesses, RPC, or detached workers.
- Child agents use `createAgentSession()` and persistent `SessionManager` sessions.
- Concurrency is shared across the complete delegation tree.
- `delegates` controls role-scoped nesting. A child sees a `subagent` tool only when its role allows targets and the global depth limit has not been reached.
- Nested tool schemas expose only allowed roles, and follow-ups are limited to allowed agents spawned by that delegator.
- At maximum depth, children are created without the `subagent` tool.
- Handles are scoped to the root parent session: `atlas-1`, `vigil-1`, and so on.
- Reopening the parent session restores handles, history, accounting, and child transcripts.

## Main prompt

The extension supplies `resources/SYSTEM.md` through `before_agent_start` when Pi has no explicit project or global `SYSTEM.md`. Pi emits that event for every submitted agent run and resets absent overrides, so the package caches one assembled replacement per base-prompt configuration and returns the same replacement each time. It is never cumulatively appended.

Explicit `SYSTEM.md` files remain an escape hatch and win over the package. APPEND_SYSTEM content, project context, loaded skills, and the working directory are preserved in the assembled prompt. Child agents do not load the parent extension; they continue to receive only their isolated role prompt and allowed skills.

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
roles:
  Atlas:
    description: Read-only explorer for codebase and web research
    model: openai-codex/gpt-5.6-luna
    thinking: medium
    prompt: agents/atlas.md
    tools: [read, bash, web_search]
    delegates: []
    skills: []
    timeoutMinutes: 10
```

Prompt paths are relative to the selected `agents.yaml`. Project configuration is rejected when Pi does not trust the project. `subagent` is not listed in `tools`; the runtime adds a filtered tool automatically when `delegates` is non-empty.

## Tool

Fresh agent:

```ts
subagent({
  agents: [{ role: "Atlas", task: "Map session ownership." }],
});
```

Follow-up:

```ts
subagent({
  agents: [{ agent: "atlas-1", task: "Recheck against the implementation." }],
});
```

Independent array items execute concurrently. `timeoutMinutes` may be omitted to use the role-specific or global default, set to any positive integer to override that default, or set to `-1` for no timeout. Configured timeout values are defaults, not maximum limits.

## Session transfer and prompt commands

Use `/handoff [optional next goal]` to transfer the recorded work into a fresh parent-linked session. The command runs a normal main-agent summary turn with the existing tools and subagent orchestration available, waits for it to settle, and opens the generated chronological handoff for review. Accepting the review creates the new session and places the edited handoff in its editor; it is never submitted automatically. With no argument, the handoff continues the current work from its present state. For unusually large, compacted, or incomplete histories, the agent may use read-only Atlas subagents to inspect the saved session history.

Use `/create-skill [request]` for an evidence-driven interview followed by creation of a concise project-local Pi skill. Use `/save-md` to save the latest completed assistant response as Markdown in the gitignored `AgentDocs/` directory, with a Spark-generated filename.

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
- Nested agents render as a spaced, responsive tree. Atlas and Vigil have consistent role colors; costs use green below $2, yellow below $7, and red from $7.
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
