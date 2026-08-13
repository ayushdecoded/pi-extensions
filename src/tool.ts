import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import type { AgentsConfig } from "./config/agents.ts";
import type {
  BackgroundBatchLaunch,
  BackgroundBatchReceipt,
  BatchResult,
  SubagentRequest,
  SubagentToolResult,
} from "./runtime/types.ts";
import { roleText } from "./ui/roles.ts";

const BASE_TOOL_DESCRIPTION =
  "Delegate only bounded, verifiable work when specialization, independent judgment, or independent parallelism justifies coordination. Keep routine execution, inspection, directly verifiable validation, small tasks, and repeated discovery in the main session; do not delegate merely for confirmation or extra confidence. Fresh agents have no context. Include the objective, evidence, paths and symbols, completed work, decisions and rationale, constraints, boundaries, expected result, and stop condition. For parallel calls, share baseline context and assign distinct responsibilities; duplicate only for intentional verification. Resume useful contexts and integrate results yourself.";

/** Root delegations detach by default: continue working, results arrive as one follow-up. */
const ROOT_DELIVERY_GUIDANCE =
  " Prefer background delegation: the call returns a receipt immediately and one aggregated follow-up arrives after every agent settles, so continue other work without polling. Pass background: false only when this turn must block on the results before doing anything else.";

/** Child delegations stay synchronous; the root session owns the background capability. */
const NESTED_DELIVERY_GUIDANCE =
  " Delegation is synchronous: the call waits and returns results inline when the batch settles. Background delegation is available only to the root session.";

export type SubagentExecutor = (requests: SubagentRequest[], signal?: AbortSignal, onProgress?: (result: BatchResult) => void) => Promise<BatchResult>;
export type BackgroundSubagentExecutor = (requests: SubagentRequest[]) => BackgroundBatchLaunch;

export type SubagentToolOptions = {
  /** Root tools may detach a batch. Nested tools intentionally omit this capability. */
  startBackgroundBatch?: BackgroundSubagentExecutor;
};

export function createSubagentTool(
  config: AgentsConfig,
  executeBatch: SubagentExecutor,
  options: SubagentToolOptions = {},
): ToolDefinition<any, SubagentToolResult> {
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
      ...(options.startBackgroundBatch
        ? {
            background: Type.Optional(Type.Boolean({
              description:
                "Defaults to true. Launch this batch and return immediately; one aggregate result is delivered after every run settles. Pass false to wait for results inline before continuing.",
            })),
          }
        : {}),
    },
    { additionalProperties: false },
  );

  const backgroundCapable = options.startBackgroundBatch !== undefined;
  return {
    name: "subagent",
    label: "Subagents",
    description: BASE_TOOL_DESCRIPTION + (backgroundCapable ? ROOT_DELIVERY_GUIDANCE : NESTED_DELIVERY_GUIDANCE),
    parameters,
    executionMode: "sequential",
    renderCall(args, theme) {
      const { agents: requests = [] } = args as { agents?: SubagentRequest[] };
      const background = (args as { background?: boolean }).background ?? backgroundCapable;
      const blocks = requests.map((request) => {
        const role = "role" in request ? request.role : roleForHandle(request.agent, config);
        const resumed = "agent" in request ? ` ${theme.fg("accent", "↻")}` : "";
        return `${roleText(role, role, theme)}${resumed}\n${theme.fg("text", request.task.trim())}`;
      });
      if (requests.length === 1) {
        const [roleLine, ...promptLines] = blocks[0]!.split("\n");
        const prefix = background ? "Subagent · background · " : "Subagent · ";
        return new Text(`${theme.fg("dim", prefix)}${roleLine}\n\n${promptLines.join("\n")}`, 0, 0);
      }
      const suffix = background ? " · background" : "";
      return new Text(`${theme.fg("dim", `Subagents · ${requests.length}${suffix}`)}\n\n${blocks.join("\n\n")}`, 0, 0);
    },
    async execute(_toolCallId, params, signal) {
      const { agents } = params as { agents: SubagentRequest[] };
      const background = (params as { background?: boolean }).background ?? backgroundCapable;
      if (background) {
        if (!options.startBackgroundBatch) throw new Error("Background subagents are available only in the root session.");
        signal?.throwIfAborted();
        const launch = options.startBackgroundBatch(agents);
        const receipt: BackgroundBatchReceipt = {
          background: true,
          batchId: launch.batchId,
          status: "started",
          agentCount: agents.length,
        };
        return {
          content: [{ type: "text", text: formatBackgroundReceipt(receipt) }],
          details: receipt,
        };
      }
      const result = await executeBatch(agents, signal);
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

export function formatBackgroundReceipt(receipt: BackgroundBatchReceipt): string {
  const noun = receipt.agentCount === 1 ? "agent" : "agents";
  return `[Background subagents · ${receipt.batchId} · started]\n${receipt.agentCount} ${noun} launched. Results will be delivered automatically after every agent settles; continue other work without polling.`;
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
