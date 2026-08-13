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

export type FollowupRequest = {
  agent: string;
  task: string;
  timeoutMinutes?: number;
};

export type SubagentRequest = FreshRequest | FollowupRequest;

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

/** Manage an existing background batch through the tool's `background` parameter. */
export type BackgroundBatchManage = {
  action: "cancel";
  batchId: string;
};

export type BackgroundBatchReceipt =
  | { background: true; batchId: string; status: "started"; agentCount: number }
  | { background: true; batchId: string; status: "cancelled" }
  | { background: true; batchId: string; status: "not-found" };

export type SubagentToolResult = BatchResult | BackgroundBatchReceipt;

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
  /** Persisted UI override (model and/or thinking) for one role in a preset, when configured. */
  roleOverride?: (preset: string | undefined, role: string) => RoleOverride | undefined;
};

export type SubagentEvent =
  | { type: "agent.created"; agent: AgentRecord }
  | { type: "batch.started"; batch: BatchRecord }
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
