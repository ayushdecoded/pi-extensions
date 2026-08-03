import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import type { AgentsConfig } from "./config/agents.ts";
import type { BatchResult, SubagentRequest } from "./runtime/types.ts";
import { roleText } from "./ui/roles.ts";

const TOOL_DESCRIPTION =
  "Delegate only bounded, verifiable work when specialization, independent judgment, or independent parallelism justifies coordination. Keep routine execution, inspection, directly verifiable validation, small tasks, and repeated discovery in the main session; do not delegate merely for confirmation or extra confidence. Fresh agents have no context. Include the objective, evidence, paths and symbols, completed work, decisions and rationale, constraints, boundaries, expected result, and stop condition. For parallel calls, share baseline context and assign distinct responsibilities; duplicate only for intentional verification. Resume useful contexts and integrate results yourself.";

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
        "Minutes; omit for default, -1 for no timeout.",
    }),
  );
  const fresh = Type.Object(
    {
      role: roleSchema,
      task: Type.String({
        minLength: 1,
        description: "Context, objective, result, and stop condition.",
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
        description: "New context, objective, result, and stop condition.",
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
