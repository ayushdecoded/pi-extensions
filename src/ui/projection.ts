import type { BatchRecord, DelegationCallRecord, InvocationRecord, RuntimeState, Usage } from "../runtime/types.ts";
import { ZERO_USAGE } from "../runtime/types.ts";

export type DelegationCallNode = {
  call: DelegationCallRecord;
  children: AgentNode[];
};

export type AgentNode = {
  invocation: InvocationRecord;
  children: AgentNode[];
  childCalls: DelegationCallNode[];
};

export type BatchView = {
  batch: BatchRecord;
  invocations: InvocationRecord[];
  roots: AgentNode[];
  active: boolean;
  failed: boolean;
  usage: Usage;
  startedAt: number;
  finishedAt?: number;
  roleCounts: Map<string, number>;
  rootCall?: DelegationCallRecord;
};

const projectionCache = new WeakMap<RuntimeState, { revision: number; views: BatchView[] }>();

export function projectBatches(state: RuntimeState): BatchView[] {
  if (state.revision !== undefined) {
    const cached = projectionCache.get(state);
    if (cached?.revision === state.revision) return cached.views;
  }

  const views: BatchView[] = [];
  for (const batch of state.batches.values()) {
    const invocations = [...state.invocations.values()]
      .filter((invocation) => invocation.batchId === batch.id)
      .sort((left, right) => left.queuedAt - right.queuedAt);
    if (invocations.length === 0) continue;

    const nodes = new Map<string, AgentNode>(
      invocations.map((invocation) => [invocation.id, { invocation, children: [], childCalls: [] }]),
    );
    const roots: AgentNode[] = [];
    for (const node of nodes.values()) {
      const parent = node.invocation.parentInvocationId ? nodes.get(node.invocation.parentInvocationId) : undefined;
      if (parent) parent.children.push(node);
      else roots.push(node);
    }

    const calls = [...(state.delegationCalls?.values() ?? [])]
      .filter((call) => call.batchId === batch.id)
      .sort((left, right) => left.createdAt - right.createdAt);
    for (const call of calls) {
      if (!call.parentInvocationId) continue;
      const parent = nodes.get(call.parentInvocationId);
      if (!parent) continue;
      const children = invocations
        .filter((invocation) => invocation.callId === call.id)
        .map((invocation) => nodes.get(invocation.id)!)
        .filter(Boolean);
      parent.childCalls.push({ call, children });
    }

    const usage = { ...ZERO_USAGE };
    const roleCounts = new Map<string, number>();
    let active = false;
    let failed = false;
    let finishedAt = 0;
    for (const invocation of invocations) {
      addUsage(usage, invocation.usage);
      roleCounts.set(invocation.role, (roleCounts.get(invocation.role) ?? 0) + 1);
      if (invocation.status === "queued" || invocation.status === "running") active = true;
      if (invocation.status === "failed" || invocation.status === "cancelled" || invocation.status === "interrupted") {
        failed = true;
      }
      finishedAt = Math.max(finishedAt, invocation.finishedAt ?? 0);
    }
    views.push({
      batch,
      invocations,
      roots,
      active,
      failed,
      usage,
      startedAt: Math.min(...invocations.map((invocation) => invocation.queuedAt)),
      ...(!active && finishedAt ? { finishedAt } : {}),
      roleCounts,
      ...(calls.find((call) => !call.parentInvocationId) ? { rootCall: calls.find((call) => !call.parentInvocationId) } : {}),
    });
  }

  const sorted = views.sort((left, right) => {
    if (left.active !== right.active) return left.active ? -1 : 1;
    return right.startedAt - left.startedAt;
  });
  if (state.revision !== undefined) projectionCache.set(state, { revision: state.revision, views: sorted });
  return sorted;
}

function addUsage(target: Usage, source: Usage): void {
  target.input += source.input;
  target.output += source.output;
  target.cacheRead += source.cacheRead;
  target.cacheWrite += source.cacheWrite;
  target.total += source.total;
  target.cost += source.cost;
}
