---
name: agent-system-design
description: Design and maintain this repository's agent roles, prompts, descriptions, models, tools, delegation, and prompt propagation. Use when creating, reviewing, or changing the main agent or any subagent.
---

# Agent System Design

Use this skill for maintaining the agent system in this repository. Do not use it for ordinary delegation during software work; the `subagent` tool already governs that.

## Start from the intended behavior

Inspect the current prompt, selected configuration, relevant runtime, tests, and active overrides before asking questions. Understand what the agent is for, what it must not do, what context it receives, what authority it has, and what it must return.

Discuss behavior with the user one point at a time. Separate stable role behavior from task-specific instructions. Compare the current and proposed behavior plainly, preserve wording the user locks, and do not make major changes before the final design is approved.

Trust capable models with routine mechanics. A system prompt should establish identity, intent, judgment, authority, and reporting—not explain obvious tool usage or anticipate every edge case. Every sentence should materially change behavior. Remove repetition across identity, role prompt, role description, task guidance, and tool description.

## Keep each layer responsible for one thing

- The main prompt defines how Pi collaborates, reasons, communicates, and reaches approval.
- A role prompt defines stable behavior specific to that role.
- A role description tells the orchestrator when to use the role, what context it needs, and what work does not belong there.
- A delegated task supplies the objective, current facts, relevant files, decisions, constraints, implementation or review contract, expected result, and stop condition needed for that invocation.
- The `subagent` tool contains only guidance common to every role. Do not move role-specific context requirements into it.

Fresh agents are empty slates. Keep approved implementation in the main session. Give Vigil the intent, goals, non-goals, and decision rationale. Give Atlas a focused question and enough known context to avoid rediscovery; do not burden it with implementation context it cannot use.

Principles should demonstrate how to think without becoming a checklist or the boundary of the agent's judgment. Keep useful engineering principles, but remove essays that restate the same invariant across many cases.

## Design prompts and capabilities together

Prompt claims must match actual capabilities. Check the configured model, thinking level, tools, delegates, and skills. A semantic boundary such as "read-only" is not technically enforced when `bash` is available, so pair it with an explicit no-file-change instruction. A custom tool named in `agents.yaml` must also be injected into child sessions by the runtime.

The main prompt replaces Pi's native prompt. Role prompts are appended to Pi's native prompt, so measure their effective context accordingly and avoid repeating native guidance.

When creating a role, settle its purpose first, then its stable behavior, authority boundary, reporting contract, description, model, thinking level, tools, delegates, and timeout. Prefer the smallest role that has a distinct responsibility.

## Sources and precedence

Resolve paths relative to this skill directory:

- Main prompt: `../../../resources/SYSTEM.md`
- Bundled role prompts: `../../../resources/agents/*.md`
- Bundled role configuration: `../../../resources/agents.yaml`
- Development role prompts: `../../agents/*.md`
- Development role configuration: `../../agents.yaml`
- Runtime and tool integration: `../../../src/runtime/`, `../../../src/tool.ts`, and `../../../src/web-search/`
- Synchronization tests: `../../../test/system-prompt.test.ts` and `../../../test/agents.test.ts`

Agent configurations are selected whole, never merged:

```text
project .pi/agents.yaml
          ↓ otherwise
global ~/.config/pi/agents.yaml
          ↓ otherwise
bundled resources/agents.yaml
```

Prompt paths are relative to the selected configuration. Inspect active project and global overrides before claiming a change has propagated. Update external copies only when the user asks. Do not rewrite historical backups or unrelated test fixtures as though they were active configuration.

## Implement and verify approved changes

Update bundled and development copies together. Keep descriptions, prompts, tools, and runtime behavior consistent. Update documentation and tests that encode the changed contract.

Run the full tests and typecheck. Parse changed YAML, verify referenced prompt files exist, and compare mirrored files byte-for-byte. If prompt size changed, report words and characters and, when a tokenizer is available, report tokens with the tokenizer named. Token count is evidence about bloat, not the goal; preserve intent and useful principles.

For custom child-agent tools, verify both configuration and runtime injection. For model or config propagation, enumerate active `agents.yaml` files and report which were updated, skipped, or intentionally preserved.

The bundled main prompt is read when the extension loads and cached for the process. Model, thinking, tool, and description changes also require resource reload. Tell the user to run `/reload` or restart Pi; already-running agents keep the prompt and model they started with.

Finish by reporting the files changed, synchronization state, verification results, effective prompt sizes when relevant, and any active override that still carries an older contract.
