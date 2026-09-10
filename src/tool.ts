import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import type { AgentsConfig } from "./config/agents.ts";
import {
  isPromotedReceipt,
  type BackgroundBatchLaunch,
  type BackgroundBatchReceipt,
  type BatchResult,
  type ControlRequest,
  type ControlResult,
  type FollowupBatchResult,
  type FollowupRequest,
  type PromotedBatchReceipt,
  type SubagentRequest,
  type SubagentToolResult,
} from "./runtime/types.ts";
import { roleText } from "./ui/roles.ts";

const BASE_TOOL_DESCRIPTION =
  "Delegate only bounded, verifiable work when specialization, independent judgment, or independent parallelism justifies coordination. Keep routine execution, inspection, directly verifiable validation, small tasks, and repeated discovery in the main session; do not delegate merely for confirmation or extra confidence. Fresh agents have no context. Include the objective, evidence, paths and symbols, completed work, decisions and rationale, constraints, boundaries, expected result, and stop condition. For parallel calls, share baseline context and assign distinct responsibilities; duplicate only for intentional verification. Resume useful contexts and integrate results yourself.";

/** Root delegations detach by default: continue working, results arrive as one follow-up. */
const ROOT_DELIVERY_GUIDANCE =
  " Prefer background delegation: the call returns a receipt immediately and one aggregated follow-up arrives after every agent settles, so continue other work without polling. Pass background: false only when this turn must block on the results before doing anything else. Use action: inspect or action: cancel with one current-session target when you need bounded status or cancellation; action calls cannot launch work.";

/** Child delegations stay synchronous; the root session owns the background capability. */
const NESTED_DELIVERY_GUIDANCE =
  " Delegation is synchronous: the call waits and returns results inline when the batch settles. Follow-ups may continue existing agents this child spawned; inspect or cancel only agents and batches owned by this child. Background delegation is available only to the root session.";
const CONTROL_GUIDANCE =
  " Controls are read-only inspect or explicit cancel actions. Targets are mutually exclusive current-session agent, batch, or all; inspection never interrupts work, steers a child, starts a turn, or consumes completion delivery.";

export type SubagentExecutor = (requests: SubagentRequest[], signal?: AbortSignal, onProgress?: (result: BatchResult) => void) => Promise<BatchResult | PromotedBatchReceipt>;
export type BackgroundSubagentExecutor = (requests: SubagentRequest[]) => BackgroundBatchLaunch;
/** Stops a live root batch (batch id) or a single child agent (handle); returns the stopped scope, or undefined when nothing live matched. */
export type ControlActionExecutor = (request: ControlRequest) => ControlResult;

export type SubagentToolOptions = {
  /** Validate the complete submission before any fresh launch or follow-up acceptance. */
  validateRequests?: (requests: SubagentRequest[]) => void;
  /** Accept follow-up control messages and return immediate receipts plus an optional completion handle. */
  submitFollowups?: (requests: FollowupRequest[], detached?: boolean) => FollowupBatchResult;
  /** Root tools may detach a batch. Nested tools intentionally omit this capability. */
  startBackgroundBatch?: BackgroundSubagentExecutor;
  /** Root and nested tools may inspect or cancel only targets allowed by their runtime owner. */
  controlAction?: ControlActionExecutor;
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
  const roleSchema = roleNames.length > 0
    ? Type.Union(roleNames.map((name) => Type.Literal(name)), { description: roleDescription })
    : undefined;
  const timeout = Type.Optional(
    Type.Union([
      Type.Literal(-1, { description: "No timeout." }),
      Type.Integer({ minimum: 1, description: "Positive minute override." }),
    ], {
      description: "Minutes; omit for default, -1 for no timeout, or use a positive integer.",
    }),
  );
  const nonBlankText = (description: string) => Type.String({
    minLength: 1,
    pattern: "\\S",
    description,
  });
  const fresh = roleSchema
    ? Type.Object(
        {
          role: roleSchema,
          task: nonBlankText("Context, objective, result, and stop condition; must contain non-whitespace text."),
          timeoutMinutes: timeout,
        },
        { additionalProperties: false },
      )
    : undefined;
  const followup = Type.Object(
    {
      agent: Type.String({
        minLength: 1,
        description: "Session-local handle of an existing agent whose context should be continued.",
      }),
      messages: Type.Array(Type.Object({
        message: nonBlankText("New context, objective, result, and stop condition for this agent's context; must contain non-whitespace text."),
        delivery: Type.Optional(Type.Union([
          Type.Literal("queue", { description: "Run in FIFO order after current work; default." }),
          Type.Literal("steer", { description: "Deliver at the next safe boundary during current work." }),
        ])),
      }, { additionalProperties: false }), { minItems: 1, maxItems: 10 }),
      timeoutMinutes: timeout,
    },
    { additionalProperties: false },
  );
  const agentsSchema = fresh
    ? Type.Array(Type.Union([fresh, followup]), {
        minItems: 1,
        maxItems: 10,
        description: "Fresh agents and follow-ups to run concurrently in this call.",
      })
    : undefined;
  const backgroundBoolean = Type.Boolean({
    description:
      "Defaults to true. Launch this batch and return immediately; one aggregate result is delivered after every run settles. Pass false to wait for results inline before continuing.",
  });
  const backgroundParam = Type.Optional(backgroundBoolean);
  const targetSchema = Type.Union([
    Type.Object({ agent: Type.String({ minLength: 1 }) }, { additionalProperties: false }),
    Type.Object({ batch: Type.String({ minLength: 1 }) }, { additionalProperties: false }),
    Type.Object({ all: Type.Literal(true) }, { additionalProperties: false }),
  ], { description: "One mutually exclusive current-session agent, batch, or all target." });
  const actionSchema = Type.Object({
    action: Type.Union([
      Type.Literal("inspect", { description: "Read a bounded runtime snapshot without interrupting work." }),
      Type.Literal("cancel", { description: "Cancel the selected live scope." }),
    ]),
    target: targetSchema,
  }, { additionalProperties: false });
  const launchSchema = roleNames.length > 0
    ? Type.Object({
        agents: agentsSchema!,
        ...(options.startBackgroundBatch ? { background: backgroundParam } : {}),
      }, { additionalProperties: false })
    : undefined;
  // When every role is disabled, a root tool remains available only for
  // inspect/cancel controls. Do not expose an impossible fresh-launch schema
  // (or a fake string role) to the model.
  const parameters = launchSchema
    ? options.controlAction ? Type.Union([launchSchema, actionSchema]) : launchSchema
    : actionSchema;

  const backgroundCapable = options.startBackgroundBatch !== undefined;
  return {
    name: "subagent",
    label: "Subagents",
    description: BASE_TOOL_DESCRIPTION + (backgroundCapable ? ROOT_DELIVERY_GUIDANCE : NESTED_DELIVERY_GUIDANCE) + (options.controlAction ? CONTROL_GUIDANCE : ""),
    parameters,
    executionMode: "sequential",
    renderCall(args, theme) {
      const { agents = [] } = args as { agents?: SubagentRequest[] };
      const action = (args as Partial<ControlRequest>).action;
      const target = (args as Partial<ControlRequest>).target;
      const background = (args as { background?: boolean }).background;
      if (action !== undefined) {
        return new Text(`${theme.fg("dim", `Subagent · ${action} `)}${theme.fg("text", formatTarget(target))}`, 0, 0);
      }
      const detached = background === true || (background === undefined && backgroundCapable);
      const requests = agents;
      const blocks = requests.map((request) => {
        const role = "role" in request ? request.role : roleForHandle(request.agent, config);
        const resumed = "agent" in request ? ` ${theme.fg("accent", "↻")}` : "";
        const prompt = "role" in request
          ? request.task.trim()
          : request.messages.map((item) => `[${item.delivery ?? "queue"}] ${item.message.trim()}`).join("\n");
        return `${roleText(role, role, theme)}${resumed}\n${theme.fg("text", prompt)}`;
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
      const action = (params as Partial<ControlRequest>).action;
      const target = (params as Partial<ControlRequest>).target;
      const background = (params as { background?: boolean }).background;
      if (action !== undefined || target !== undefined) {
        if (!options.controlAction) throw new Error("Inspection and cancellation are unavailable in this session.");
        if (action !== "inspect" && action !== "cancel") throw new Error("action must be inspect or cancel.");
        if (!target || !isControlTarget(target)) throw new Error("action requires exactly one agent, batch, or all target.");
        if (agents.length > 0 || background !== undefined) throw new Error("Action calls cannot contain agents or background.");
        const result = options.controlAction({ action, target });
        return { content: [{ type: "text", text: formatControlResult(result) }], details: result };
      }
      const followups = agents.filter(isFollowupRequest);
      if (background === false && followups.some((request) => request.messages.some((item) => item.delivery === "steer"))) {
        throw new Error("background:false cannot be combined with steering follow-ups; use background:true or omit background.");
      }
      options.validateRequests?.(agents);
      const freshAgents = agents.filter((request): request is Exclude<SubagentRequest, FollowupRequest> => !isFollowupRequest(request));
      const detached = background === true || (background === undefined && backgroundCapable);
      const queueDetached = backgroundCapable && (background !== false || freshAgents.length > 0);
      const followupResult = followups.length > 0
        ? options.submitFollowups?.(followups, queueDetached) ?? (() => { throw new Error("Follow-up control is unavailable in this session."); })()
        : undefined;
      const publicFollowups = followupResult ? { followups: followupResult.followups } : undefined;
      const queueOnlyWait = background === false && freshAgents.length === 0 && followups.length > 0 &&
        followups.every((request) => request.messages.every((item) => (item.delivery ?? "queue") === "queue"));
      if (freshAgents.length === 0) {
        if (queueOnlyWait && followupResult?.completion) {
          const settled = await followupResult.completion;
          return {
            content: [{ type: "text", text: `${formatFollowupReceipts(followupResult)}\n\n${formatBatchForModel(settled)}` }],
            details: { ...settled, ...publicFollowups },
          };
        }
        const result = publicFollowups ?? { followups: [] };
        return { content: [{ type: "text", text: formatFollowupReceipts(result) }], details: result };
      }
      if (detached) {
        if (!options.startBackgroundBatch) throw new Error("Background subagents are available only in the root session.");
        signal?.throwIfAborted();
        const launch = options.startBackgroundBatch(freshAgents);
        const receipt: BackgroundBatchReceipt = {
          background: true,
          batchId: launch.batchId,
          status: "started",
          agentCount: freshAgents.length,
          ...(followupResult ? { followups: followupResult.followups } : {}),
        };
        return {
          content: [{ type: "text", text: `${followupResult ? `${formatFollowupReceipts(followupResult)}\n\n` : ""}${formatBackgroundReceipt(receipt)}` }],
          details: receipt,
        };
      }
      const result = await executeBatch(freshAgents, signal);
      if (isPromotedReceipt(result)) {
        return {
          content: [{ type: "text", text: formatPromotedReceipt(result) }],
          details: result,
        };
      }
      const details = publicFollowups ? { ...result, ...publicFollowups } : result;
      return {
        content: [{ type: "text", text: `${followupResult ? `${formatFollowupReceipts(followupResult)}\n\n` : ""}${formatBatchForModel(result)}` }],
        details,
      };
    },
    renderResult() {
      return new Text("", 0, 0);
    },
  };
}

function isFollowupRequest(request: SubagentRequest): request is FollowupRequest {
  return "messages" in request;
}

function formatFollowupReceipts(result: FollowupBatchResult): string {
  return result.followups.map((receipt) =>
    `[Follow-up ${receipt.id} · ${receipt.agent} · ${receipt.delivery} · ${receipt.status}/${receipt.state}]${receipt.message ? `\n${receipt.message}` : ""}`,
  ).join("\n");
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
  return `[Background subagents · ${receipt.batchId} · started]\n${receipt.agentCount} ${noun} launched. Results will be delivered automatically after every agent settles; continue other work without polling. To stop this batch, call subagent with action: "cancel", target: {batch: "${receipt.batchId}"}.`;
}

function isControlTarget(value: unknown): value is ControlRequest["target"] {
  if (!value || typeof value !== "object") return false;
  const keys = Object.keys(value);
  return keys.length === 1 && (keys[0] === "agent" || keys[0] === "batch" || keys[0] === "all") &&
    (keys[0] === "all" ? (value as { all?: unknown }).all === true : typeof (value as { agent?: unknown; batch?: unknown })[keys[0] as "agent" | "batch"] === "string");
}

function formatTarget(target: ControlRequest["target"] | undefined): string {
  if (!target) return "invalid target";
  if ("all" in target) return "all";
  if ("agent" in target) return `agent ${target.agent}`;
  return `batch ${target.batch}`;
}

function formatControlResult(result: ControlResult): string {
  if (result.action === "cancel") {
    return `[Subagents · cancel · ${formatTarget(result.target)} · ${result.status}]${result.stopped === undefined ? "" : `\nStopped ${result.stopped} scope(s).`}`;
  }
  const elapsed = (ms: number | undefined) => ms === undefined ? "" : ` · elapsed=${(ms / 60_000).toFixed(1)}m`;
  const agents = result.agents.map((agent) => {
    const lines = [`${agent.agent} · ${agent.role} · ${agent.status}${elapsed(agent.elapsedMs)}`];
    if (agent.taskPreview) lines.push(`task: ${agent.taskPreview}`);
    const activity = [agent.activity?.tool, agent.activity?.detail].filter(Boolean).join(" · ");
    if (activity) lines.push(`activity: ${activity}`);
    if (agent.lastMessage) lines.push(`last_message: ${agent.lastMessage}`);
    const pending = [
      ...agent.pendingSteering.map((item) => `steer ${item.id}: ${item.preview}`),
      ...agent.pendingQueue.map((item) => `queue ${item.id}: ${item.preview}`),
    ];
    if (pending.length) lines.push(`pending: ${pending.join("; ")}`);
    return lines.join("\n");
  });
  const batches = result.batches.map((batch) => `${batch.batch} · ${batch.status}${elapsed(batch.elapsedMs)} · ${batch.liveAgents}/${batch.totalAgents} live`);
  return `[Subagents · inspect · ${formatTarget(result.target)}]\n${[...agents, ...batches].join("\n") || "No accessible live work."}${result.truncated ? "\n(truncated to bounded inspection limits)" : ""}`;
}

export function formatPromotedReceipt(receipt: PromotedBatchReceipt): string {
  return `[Subagents · ${receipt.batchId} · promoted]\n${receipt.agentCount} agent${receipt.agentCount === 1 ? "" : "s"} continue in the background; one aggregate completion will be delivered automatically.`;
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
