import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import type { AgentsConfig } from "./config/agents.ts";
import type {
  BackgroundBatchLaunch,
  BackgroundBatchManage,
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
  " Prefer background delegation: the call returns a receipt immediately and one aggregated follow-up arrives after every agent settles, so continue other work without polling. Pass background: false only when this turn must block on the results before doing anything else. To stop work early, pass background: {action: \"cancel\", batchId} with the receipt's batchId (stops the whole batch) or an agent handle such as forge-3 (stops just that agent) and omit agents; a final result is still delivered.";

/** Child delegations stay synchronous; the root session owns the background capability. */
const NESTED_DELIVERY_GUIDANCE =
  " Delegation is synchronous: the call waits and returns results inline when the batch settles. Background delegation is available only to the root session.";

export type SubagentExecutor = (requests: SubagentRequest[], signal?: AbortSignal, onProgress?: (result: BatchResult) => void) => Promise<BatchResult>;
export type BackgroundSubagentExecutor = (requests: SubagentRequest[]) => BackgroundBatchLaunch;
/** Stops a live root batch (batch id) or a single child agent (handle); returns the stopped scope, or undefined when nothing live matched. */
export type CancelBackgroundTarget = (target: string) => "batch" | "agent" | undefined;

export type SubagentToolOptions = {
  /** Root tools may detach a batch. Nested tools intentionally omit this capability. */
  startBackgroundBatch?: BackgroundSubagentExecutor;
  /** Root tools may stop a detached batch by its receipt batchId, or one agent by its handle. */
  cancelBackgroundTarget?: CancelBackgroundTarget;
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
  const agentsSchema = Type.Array(Type.Union([fresh, followup]), {
    minItems: 1,
    maxItems: 10,
    description: "Fresh agents and follow-ups to run concurrently in this call.",
  });
  const backgroundBoolean = Type.Boolean({
    description:
      "Defaults to true. Launch this batch and return immediately; one aggregate result is delivered after every run settles. Pass false to wait for results inline before continuing.",
  });
  const backgroundManage = Type.Object(
    {
      action: Type.Literal("cancel", { description: "Stop the batch, or only the agent named by batchId; a final result is delivered as a follow-up." }),
      batchId: Type.String({ minLength: 1, description: "Batch id from the launch receipt, or an agent handle (e.g. forge-3) to stop a single agent in a running batch." }),
    },
    { additionalProperties: false, description: "Stop a running background batch (by its receipt batch id) or a single agent in one (by its handle) instead of launching new work; omit agents." },
  );
  const backgroundParam = options.cancelBackgroundTarget
    ? Type.Optional(Type.Union([backgroundBoolean, backgroundManage], {
        description: "Background execution: true detaches, false waits inline, {action, batchId} stops a running batch or a single agent.",
      }))
    : Type.Optional(backgroundBoolean);
  const parameters = Type.Object(
    {
      ...(options.cancelBackgroundTarget ? { agents: Type.Optional(agentsSchema) } : { agents: agentsSchema }),
      ...(options.startBackgroundBatch ? { background: backgroundParam } : {}),
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
      const { agents = [] } = args as { agents?: SubagentRequest[] };
      const background = (args as { background?: boolean | BackgroundBatchManage }).background;
      if (background !== undefined && typeof background === "object") {
        return new Text(
          `${theme.fg("dim", "Subagent · bg ")}${theme.fg("text", `${background.action} ${background.batchId}`)}`,
          0,
          0,
        );
      }
      const detached = background === true || (background === undefined && backgroundCapable);
      const requests = agents;
      const blocks = requests.map((request) => {
        const role = "role" in request ? request.role : roleForHandle(request.agent, config);
        const resumed = "agent" in request ? ` ${theme.fg("accent", "↻")}` : "";
        return `${roleText(role, role, theme)}${resumed}\n${theme.fg("text", request.task.trim())}`;
      });
      if (requests.length === 1) {
        const [roleLine, ...promptLines] = blocks[0]!.split("\n");
        const prefix = detached ? "Subagent · background · " : "Subagent · ";
        return new Text(`${theme.fg("dim", prefix)}${roleLine}\n\n${promptLines.join("\n")}`, 0, 0);
      }
      const suffix = detached ? " · background" : "";
      return new Text(`${theme.fg("dim", `Subagents · ${requests.length}${suffix}`)}\n\n${blocks.join("\n\n")}`, 0, 0);
    },
    async execute(_toolCallId, params, signal) {
      const { agents = [] } = params as { agents?: SubagentRequest[] };
      const background = (params as { background?: boolean | BackgroundBatchManage }).background;
      if (background !== undefined && typeof background === "object") {
        if (!options.cancelBackgroundTarget) {
          throw new Error("Background batch management is available only in the root session.");
        }
        if (agents.length > 0) throw new Error("Pass either agents or a background action, not both.");
        const scope = options.cancelBackgroundTarget(background.batchId);
        const receipt: Extract<BackgroundBatchReceipt, { status: "cancelled" | "not-found" }> =
          scope === undefined
            ? { background: true, batchId: background.batchId, status: "not-found" }
            : { background: true, batchId: background.batchId, status: "cancelled", scope };
        return {
          content: [{ type: "text", text: formatCancelReceipt(receipt) }],
          details: receipt,
        };
      }
      const detached = background === true || (background === undefined && backgroundCapable);
      if (detached) {
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

export function formatBackgroundReceipt(receipt: Extract<BackgroundBatchReceipt, { status: "started" }>): string {
  const noun = receipt.agentCount === 1 ? "agent" : "agents";
  return `[Background subagents · ${receipt.batchId} · started]\n${receipt.agentCount} ${noun} launched. Results will be delivered automatically after every agent settles; continue other work without polling. To stop this batch, call subagent with background: {action: \"cancel\", batchId: \"${receipt.batchId}\"}.`;
}

export function formatCancelReceipt(receipt: Extract<BackgroundBatchReceipt, { status: "cancelled" | "not-found" }>): string {
  if (receipt.status === "cancelled") {
    const stopped = receipt.scope === "agent"
      ? `Agent ${receipt.batchId} was stopped; the rest of its batch keeps running.`
      : `Batch ${receipt.batchId} was stopped; every agent aborted.`;
    return `[Background subagents · ${receipt.batchId} · cancelled]\n${stopped} A final result is delivered as a follow-up when the batch settles.`;
  }
  return `[Background subagents · ${receipt.batchId} · not found]\nNo running batch with this id, or no live agent with this handle; it may have already settled. See the delivered results.`;
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
