import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import type { AgentsConfig } from "./config/agents.ts";
import type { BatchResult, SubagentRequest } from "./runtime/types.ts";
import { roleText } from "./ui/roles.ts";

const TOOL_DESCRIPTION =
  "Use subagents only for well-scoped, verifiable work when a separate context justifies its coordination cost: substantial bounded execution, specialization, independent judgment, or genuinely independent parallel work. Keep routine execution, inspection, and directly verifiable validation in the main session; do not delegate merely for confirmation or extra confidence. Do not delegate small tasks, reflexive exploration, or fragments that would repeat the same discovery. Treat each fresh agent as an empty slate with no knowledge of your conversation, prior work, decisions, or sibling results. Give it high-quality instructions and high-quality context so it can act without rediscovery: the objective, established evidence and relevant paths or symbols, completed work, decisions and rationale, constraints, boundaries, expected result, and an explicit stop condition defining when to return. For multiple agents, provide the shared baseline and distinct responsibilities; duplicate work only for intentional independent verification. Resume an agent when its context remains useful, and coordinate and integrate all results yourself.";

export type SubagentExecutor = (requests: SubagentRequest[], signal?: AbortSignal, onProgress?: (result: BatchResult) => void) => Promise<BatchResult>;

export function createSubagentTool(config: AgentsConfig, executeBatch: SubagentExecutor): ToolDefinition<any, BatchResult> {
  const roleNames = config.roles.map((role) => role.name);
  const roleDescription = [
    "Configured role for a fresh agent.",
    ...config.roles.map((role) => `${role.name} — ${role.description}`),
  ].join("\n");
  const roleSchema = Type.Union(roleNames.map((name) => Type.Literal(name)), { description: roleDescription });
  const timeout = Type.Optional(
    Type.Integer({
      minimum: -1,
      description:
        "Omit for the configured default; use a positive number of minutes to override it, or -1 for no timeout.",
    }),
  );
  const fresh = Type.Object(
    {
      role: roleSchema,
      task: Type.String({
        minLength: 1,
        description: "Self-contained durable context, bounded objective, expected result, and explicit stop condition.",
      }),
      timeoutMinutes: timeout,
    },
    { additionalProperties: false },
  );
  const followup = Type.Object(
    {
      agent: Type.String({
        minLength: 1,
        description: "Session-local handle of an existing agent whose context should be continued.",
      }),
      task: Type.String({
        minLength: 1,
        description: "Relevant new context, bounded objective, expected result, and explicit stop condition for this follow-up.",
      }),
      timeoutMinutes: timeout,
    },
    { additionalProperties: false },
  );
  const parameters = Type.Object(
    {
      agents: Type.Array(Type.Union([fresh, followup]), {
        minItems: 1,
        maxItems: 10,
        description: "Fresh agents and follow-ups to run concurrently in this call.",
      }),
    },
    { additionalProperties: false },
  );

  return {
    name: "subagent",
    label: "Subagents",
    description: TOOL_DESCRIPTION,
    parameters,
    executionMode: "sequential",
    renderCall(args, theme) {
      const requests = (args as { agents?: SubagentRequest[] }).agents ?? [];
      const blocks = requests.map((request) => {
        const role = "role" in request ? request.role : roleForHandle(request.agent, config);
        const resumed = "agent" in request ? ` ${theme.fg("accent", "↻")}` : "";
        return `${roleText(role, role, theme)}${resumed}\n${theme.fg("text", request.task.trim())}`;
      });
      if (requests.length === 1) {
        const [roleLine, ...promptLines] = blocks[0]!.split("\n");
        return new Text(`${theme.fg("dim", "Subagent · ")}${roleLine}\n\n${promptLines.join("\n")}`, 0, 0);
      }
      return new Text(`${theme.fg("dim", `Subagents · ${requests.length}`)}\n\n${blocks.join("\n\n")}`, 0, 0);
    },
    async execute(_toolCallId, params, signal) {
      const result = await executeBatch((params as { agents: SubagentRequest[] }).agents, signal);
      return {
        content: [{ type: "text", text: formatBatchForModel(result) }],
        details: result,
      };
    },
    renderResult() {
      return new Text("", 0, 0);
    },
  };
}

function roleForHandle(handle: string, config: AgentsConfig): string {
  const normalized = handle.toLowerCase();
  for (const role of config.roles) {
    const slug = role.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "agent";
    if (normalized === slug || normalized.startsWith(`${slug}-`)) return role.name;
  }
  return "Agent";
}

export function formatBatchForModel(result: BatchResult): string {
  return result.runs
    .map((run) => {
      const heading = `[${run.role} · ${run.agent} · ${run.status}]`;
      if (run.output && run.error) return `${heading}\n${run.output}\n\nError: ${run.error}`;
      if (run.output) return `${heading}\n${run.output}`;
      return `${heading}\n${run.error ?? "No output."}`;
    })
    .join("\n\n");
}
