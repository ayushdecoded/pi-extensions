# Role-scoped nested delegation

Verified with fresh globally configured Pi sessions.

- `forge-nested.*`: the parent tool card shows only `Forge` and the full user-facing delegation prompt. It does not duplicate model/thinking/timeout/status/token/cost data after completion. Forge successfully received its runtime-injected, Atlas-only subagent tool and returned `NESTED_ATLAS_OK` from the child.
- `nested-tree.*`: `/agents` shows Forge at depth 1 and its Atlas child at depth 2 with their delegation prompts and native accounting.
- `session-fixed.termctrl`: exact successful interaction recording.

An earlier pre-fix recording (`session.termctrl`) caught that Pi requires custom tool names in the selected-tools list. Runtime injection was corrected; YAML still uses only `delegates` as the authority.

Configuration is synchronized across project, bundled, and global `agents.yaml`: Mason/Atlas delegate to nobody; Forge/Vigil delegate only to Atlas. Runtime tests also verify forbidden roles and foreign-agent follow-ups are rejected.

Final verification: 35/35 tests passed and TypeScript typecheck passed. All Terminal Control sessions were stopped.
