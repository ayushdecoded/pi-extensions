import type { InlineExtension, ModelRegistry } from "@earendil-works/pi-coding-agent";
import type { Api, Model } from "@earendil-works/pi-ai";
import type { AgentRole, AgentsConfig } from "../config/agents.ts";
import type { RoleOverride } from "../config/model-overrides.ts";
import type { SubagentHeadingGenerator } from "../subagent-headings.ts";

export type Usage = {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  total: number;
  cost: number;
};

export const ZERO_USAGE: Usage = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  total: 0,
  cost: 0,
};

export type InvocationStatus = "queued" | "running" | "complete" | "failed" | "cancelled" | "interrupted";

export type AgentRecord = {
  handle: string;
  role: string;
  sessionFile: string;
  createdAt: number;
};

export type InvocationRecord = {
  id: string;
  batchId: string;
  /** Delegation tool call that created this invocation. Missing on historical entries. */
  callId?: string;
  requestIndex?: number;
  /** UI-only generated heading. Never sent to a model. */
  heading?: string;
  agent: string;
  role: string;
  task: string;
  followup: boolean;
  ordinal: number;
  parentInvocationId?: string;
  depth: number;
  status: InvocationStatus;
  queuedAt: number;
  startedAt?: number;
  finishedAt?: number;
  timeoutMinutes: number;
  usageBaseline?: Usage;
  usage: Usage;
  error?: string;
};

export type BatchRecord = {
  id: string;
  createdAt: number;
  /** True when launched detached and its result is delivered as a background follow-up message. */
  detached?: boolean;
};

export type DelegationCallRecord = {
  id: string;
  batchId: string;
  parentInvocationId?: string;
  createdAt: number;
  /** UI-only generated heading. Never sent to a model. */
  heading?: string;
};

export type RuntimeState = {
  agents: Map<string, AgentRecord>;
  invocations: Map<string, InvocationRecord>;
  batches: Map<string, BatchRecord>;
  delegationCalls: Map<string, DelegationCallRecord>;
  /** Monotonic revision for cached UI projections. Optional for compatibility with external state stubs. */
  revision?: number;
};

export type FreshRequest = {
  role: string;
  task: string;
  timeoutMinutes?: number;
};

export type FollowupDelivery = "queue" | "steer";

export type FollowupMessage = {
  message: string;
  delivery?: FollowupDelivery;
};

export type FollowupRequest = {
  agent: string;
  messages: FollowupMessage[];
  timeoutMinutes?: number;
};

export type SubagentRequest = FreshRequest | FollowupRequest;

export type FollowupReceipt = {
  id: string;
  agent: string;
  delivery: FollowupDelivery;
  status: "accepted" | "rejected";
  state: "queued" | "steering" | "consumed" | "rejected";
  message?: string;
};

export type FollowupBatchResult = {
  followups: FollowupReceipt[];
  /** Internal completion handle used only by queue-only background:false calls. */
  completion?: Promise<BatchResult>;
};

export type InvocationResult = {
  invocationId: string;
  agent: string;
  role: string;
  status: InvocationStatus;
  durationMs: number;
  output?: string;
  error?: string;
  usage: Usage;
};

export type BatchResult = {
  batchId: string;
  /** Results returned to the calling model (the direct agents in this call). */
  runs: InvocationResult[];
  /** All invocations in the delegation tree, for UI/accounting only. */
  allRuns: InvocationResult[];
  durationMs: number;
};

export type BackgroundBatchLaunch = {
  batchId: string;
  completion: Promise<BatchResult>;
};

/** Released to the synchronous caller when its foreground root batch is promoted to the background. */
export type PromotedBatchReceipt = {
  promoted: true;
  batchId: string;
  /** Agents still running detached in the promoted batch. */
  agentCount: number;
};

export function isPromotedReceipt(result: BatchResult | PromotedBatchReceipt): result is PromotedBatchReceipt {
  return (result as PromotedBatchReceipt).promoted === true;
}

/** Outcome of a promotion request against a foreground root batch. */
export type RootBatchPromotion =
  | { status: "promoted"; batchId: string; launch: BackgroundBatchLaunch }
  /** The batch settled before promotion; its full result already went to the synchronous caller. */
  | { status: "settled"; batchId: string }
  /** No promotable foreground root batch has this id (unknown, detached, or an already-promoted-and-settled batch). */
  | { status: "not-found"; batchId: string };

/** Manage an existing background batch through the tool's `background` parameter. */
export type ControlTarget =
  | { agent: string }
  | { batch: string }
  | { all: true };

export type ControlAction = "inspect" | "cancel";

export type ControlRequest = {
  action: ControlAction;
  target: ControlTarget;
};

export type InspectionPendingItem = {
  id: string;
  preview: string;
};

export type AgentInspection = {
  agent: string;
  role: string;
  status: InvocationStatus | "idle";
  taskPreview?: string;
  elapsedMs?: number;
  activity?: { tool?: string; detail?: string };
  lastMessage?: string;
  pendingSteering: InspectionPendingItem[];
  pendingQueue: InspectionPendingItem[];
};

export type BatchInspection = {
  batch: string;
  liveAgents: number;
  totalAgents: number;
  elapsedMs?: number;
  status: "running" | "settled" | "unknown";
};

export type InspectionResult = {
  action: "inspect";
  target: ControlTarget;
  agents: AgentInspection[];
  batches: BatchInspection[];
  truncated: boolean;
};

export type CancellationResult = {
  action: "cancel";
  target: ControlTarget;
  status: "cancelled" | "not-found";
  scope: "agent" | "batch" | "all";
  stopped?: number;
};

export type ControlResult = InspectionResult | CancellationResult;

export type BackgroundBatchReceipt =
  | { background: true; batchId: string; status: "started"; agentCount: number; followups?: FollowupReceipt[] };

export type SubagentToolResult = BatchResult | PromotedBatchReceipt | FollowupBatchResult | ControlResult | BackgroundBatchReceipt | (BatchResult & FollowupBatchResult);

export type InvocationContext = {
  batchId: string;
  callId?: string;
  parentInvocationId?: string;
  depth: number;
};

export type RuntimeOptions = {
  rootSessionId: string;
  rootSessionFile?: string;
  cwd: string;
  config: AgentsConfig;
  modelRegistry: ModelRegistry;
  reservedHandles?: Set<string>;
  appendEvent: (event: SubagentEvent) => void;
  generateHeadings?: SubagentHeadingGenerator;
  /** Shared account-routing extension injected into native child sessions. */
  accountExtension?: InlineExtension;
  /** Resolve a supported model onto the globally selected plan account. */
  routeAccountModel?: <TApi extends Api>(model: Model<TApi>) => Model<TApi>;
  /** Name of the active preset; roles resolve through it. Defaults to default_preset. */
  activeMode?: string;
  /** UI override for one role in a preset; applies model and thinking to freshly resolved roles. */
  roleOverride?: (preset: string | undefined, role: string) => RoleOverride | undefined;
  /** Root callback for detached queue results; nested runtimes intentionally omit delivery. */
  deliverQueuedBatch?: (launch: BackgroundBatchLaunch) => void;
};

export type SubagentEvent =
  | { type: "agent.created"; agent: AgentRecord }
  | { type: "batch.started"; batch: BatchRecord }
  | { type: "batch.promoted"; batchId: string; promotedAt: number }
  | { type: "delegation.started"; call: DelegationCallRecord }
  | {
      type: "delegation.headings";
      callId: string;
      callHeading: string;
      requestHeadings: Array<{ invocationId: string; heading: string }>;
    }
  | { type: "invocation.queued"; invocation: InvocationRecord }
  | { type: "invocation.running"; id: string; startedAt: number; usageBaseline: Usage }
  | {
      type: "invocation.finished";
      id: string;
      status: Exclude<InvocationStatus, "queued" | "running" | "interrupted">;
      finishedAt: number;
      usage: Usage;
      error?: string;
    }
  | { type: "invocation.interrupted"; id: string; finishedAt: number; usage: Usage; error: string };

export type ResolvedRequest = {
  role: AgentRole;
  agent?: AgentRecord;
  task: string;
  timeoutMinutes: number;
  followup: boolean;
};
