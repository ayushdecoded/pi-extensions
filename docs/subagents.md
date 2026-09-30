# Subagents

One `subagent` tool, native persistent Pi sessions, and a collapsible live widget. No subprocess agents, separate panel, or custom agent loop.

## Launch and follow up

```ts
// Background is the default. Each completion independently wakes this parent.
subagent({ agents: [
  { agent: "Atlas", task: "Trace authentication; report source locations." },
  { agent: "Vigil", task: "Review this design. Goals: ... Constraints: ... Rationale: ..." },
] });

subagent({ agents: [{ handle: "atlas-...", task: "Now check refresh-token expiry." }] });

// Wait instead of returning immediately.
subagent({ background: false, agents: [
  { agent: "Forge", task: "Implement the approved change in file X. Acceptance: ..." },
] });

// No role prompt; inherits the spawning agent's model, thinking, and tools.
subagent({ agents: [{ agent: "minimal", task: "Check this hypothesis: ..." }] });

// Parent-defined role, optionally with its own model, reasoning, and tools.
subagent({ agents: [{
  agent: "custom", prompt: "You investigate database query performance.",
  task: "Explain this slow query ...", tools: ["read", "bash"],
  model: "opencode-go/deepseek-v4.1-flash", thinking: "high",
}] });

subagent({ action: "status" });
subagent({ action: "status", handles: ["atlas-..."] });
subagent({ action: "cancel", handles: ["forge-..."] });
```

A call accepts up to 16 agents. Separate calls may also run concurrently. A background launch group is not a completion barrier. A synchronous call waits for its requested agents. Busy handles reject follow-ups rather than queueing ambiguous concurrent edits to a conversation.

Background completions use Pi's follow-up delivery: an idle parent wakes immediately; a busy parent receives the result at its next safe follow-up boundary, without overlapping model runs. Cancelling the parent's current turn does not implicitly cancel already-launched background work. Use the tool's `cancel` action. Cancelling a synchronous tool call cancels its children.

## Delegation boundaries

- Main → any named agent, minimal, or custom (depth 1).
- Depth-1 **Forge and Vigil** → **Atlas only** (depth 2).
- Atlas, minimal, custom, other named agents, and every depth-2 agent → no delegation tool.

The nested schema exposes only Atlas and omits ad hoc configuration fields. Runtime ownership and depth checks enforce the same boundary. A child cannot inspect, follow up, or cancel another parent's handles. Follow-ups cannot change identity, depth, prompt, model, or tools.

Forge/Vigil stay alive until their own background Atlas work and ensuing continuation settle. Atlas reports to its immediate parent, not to an unrelated open session.

This is a tool-level boundary, **not an OS sandbox**. Agents share a working directory. Bash can run arbitrary programs; provide non-overlapping file ownership and treat read-only roles as instructions, not filesystem isolation.

## Configuration

Select the first existing file, without merging:

1. `<cwd>/.pi/agents.yaml` (trusted projects only)
2. `~/.pi/agent/agents.yaml` (or the configured Pi agent directory)
3. Bundled `resources/agents.yaml`

Prompt paths resolve relative to the selected YAML file. Atlas, Forge, and Vigil are required; more named agents can be added. `minimal` and `custom` are reserved built-in modes. Unknown fields, invalid models' syntax, duplicate keys, missing prompts, and unsupported tools are rejected. Model availability/authentication is checked when opening a child.

Defaults currently shipped:

| Agent | Model | Reasoning |
|---|---|---|
| Atlas | `openai-codex/gpt-6-luna` | high |
| Forge | `opencode-go/deepseek-v4.1-flash` | high |
| Vigil | `openai-codex/gpt-6-astra` | high |
| Task titles | `openai-codex/gpt-6-luna` | low |

```yaml
version: 1
defaults: {} # Optional model and thinking defaults for named agents
titling:
  model: openai-codex/gpt-6-luna
  thinking: low
agents:
  Atlas:
    description: Read-only researcher
    model: openai-codex/gpt-6-luna
    thinking: high
    prompt: agents/atlas.md
    tools: [read, bash, web]
  # Also define Forge and Vigil; see resources/agents.yaml.
```

Omitted named-agent model/thinking fields use `defaults`, then the spawning agent. Minimal always inherits directly, ignoring named-agent defaults. Custom agents inherit unless explicitly overridden. Omit `titling` to disable generated titles; a short task label is the fallback. The title model receives task text as quoted data, not a task to execute. Answers, apologies, multiline output, and overlong labels are rejected. Titles stay stable across follow-ups and are restored from native session metadata without another title request. Title failures don't fail the task, and title requests are bounded by a 15-second cancellation deadline.

Child tool support: `read`, `bash`, `edit`, `write`, `grep`, `find`, `ls`, `powershell`, and this package's `web`. `subagent` is injected solely by delegation policy. Inheriting an unsupported third-party tool fails explicitly; we do not copy a stale parent tool closure into a reload-independent session. Child sessions do not load parent/global extension bundles, skills, `SYSTEM.md`, `APPEND_SYSTEM.md`, or context files. Minimal therefore receives Pi's native prompt with its selected tools, not a hidden copy of the parent's identity.

Atlas, Forge, and Vigil's role prompt files were restored byte-for-byte from commit `a7c47b2`. The new YAML is not a migration of the old presets/settings system.

## Reload and persistence

- `/reload` validates configuration for **new agents**. Invalid config retains the last valid config. There is no `/agents` command.
- `/reload` replaces extension code but retains live child sessions in-process, queues completions during the handoff, and rebinds delivery to the refreshed parent extension. Pi itself requires the parent to be idle before `/reload`.
- Existing handles retain their original prompt/model/thinking/tools. In-flight sessions retain their loaded code. New invocations use refreshed session-factory code.
- Native child sessions live under the Pi agent directory's `sessions/subagents/<parent-id>/`. Parent custom entries persist handle metadata and pending root reports.
- Process restart cannot preserve running JavaScript. Unfinished handles restore as `interrupted`; follow up explicitly. Native session files preserve any recorded progress.
- Quit, session switch, and tree navigation cancel owned active work. A fork starts a separate handle scope; it doesn't silently share writable child sessions with its source parent.
- Delivery is not a cross-process exactly-once queue: a crash between sending a completion and recording its removal can replay a pending report.

## TUI

The widget above the composer shows running agents and agents finished within the last two minutes, including nested Atlas tasks. Finished rows expire automatically even while idle; when no entries qualify, the entire widget disappears. This only affects row visibility—handles and session history remain available. The summary's done/stopped counts cover the whole session, not just the last two minutes. Token counts use compact labels such as `4k tokens` and `1.2M tokens`.

**Alt+M** toggles between the expanded rows and exactly one summary line. The preference survives reload and session resume.

Completion cards show the agent, task title, and a short result preview. Expanding tool output (Ctrl+O by default) reveals the full result, handle, session path, and usage. This is display-only: the parent model still receives the complete report and metadata.

Background tool results are explicitly launch receipts; the widget carries live status. Use the `subagent` tool's `status`, `cancel`, and follow-up operations for control. Generated titles replace raw task text when available. Rendering clips by terminal display columns and supports narrow layouts and Unicode.

## Usage and verification

Synchronous tool results return native `usage`, which Pi already counts. The composer footer adds completed background-run usage from persisted subagent state, once per run ID. Repeated snapshots and follow-ups do not duplicate charges; nested background usage is rolled into its root report rather than added separately. Recorded earlier background runs are included after reload. Failed/cancelled runs retain any reported partial usage. Titling usage is persisted through native `appendUsage()` in the child session and included in the run's usage.

This is a custom-footer aggregate: Pi's public extension API does not expose parent `appendUsage()`, so native parent usage entries and built-in session-stat APIs are left unchanged. No synthetic assistant charges are injected. Cache hit rate and context usage still describe the parent request only. Background totals update when a run finishes; a hard crash before its report is persisted can leave usage available only in the child session.

`npm run typecheck` and `npm test` cover config, permissions, independent completion, cancellation, reload adoption, prompt isolation, native follow-up persistence, titles, and terminal widths. Model calls in tests use a fake provider.

Interactive evidence is in `artifacts/subagents/`. Terminal Control was unavailable on this machine; these checks used isolated tmux sessions and text captures, not Terminal Control or paid model runs.
