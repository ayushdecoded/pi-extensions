import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { ZERO_USAGE } from "./types.ts";
import type { RuntimeState, SubagentEvent, Usage } from "./types.ts";

export const SUBAGENT_ENTRY_TYPE = "pi-subagents";

export function emptyRuntimeState(): RuntimeState {
  return { agents: new Map(), invocations: new Map(), batches: new Map(), delegationCalls: new Map(), revision: 0 };
}

export function advanceStateRevision(state: RuntimeState): void {
  state.revision = (state.revision ?? 0) + 1;
}

export function replayRuntimeState(entries: readonly SessionEntry[]): RuntimeState {
  const state = emptyRuntimeState();
  for (const entry of entries) {
    if (entry.type !== "custom" || entry.customType !== SUBAGENT_ENTRY_TYPE || !isSubagentEvent(entry.data)) continue;
    applyEvent(state, entry.data);
  }
  return state;
}

export function replaySessionState(session: { getEntries(): SessionEntry[] }): RuntimeState {
  return replayRuntimeState(session.getEntries());
}

export function applyEvent(state: RuntimeState, event: SubagentEvent): void {
  let changed = false;
  switch (event.type) {
    case "agent.created":
      state.agents.set(event.agent.handle, event.agent);
      changed = true;
      break;
    case "agent.backend-session": {
      const agent = state.agents.get(event.handle);
      if (agent) {
        agent.backendSessionId = event.sessionId;
        changed = true;
      }
      break;
    }
    case "batch.started":
      state.batches.set(event.batch.id, event.batch);
      changed = true;
      break;
    case "delegation.started":
      state.delegationCalls.set(event.call.id, event.call);
      changed = true;
      break;
    case "delegation.headings": {
      const call = state.delegationCalls.get(event.callId);
      if (call) {
        call.heading = event.callHeading;
        changed = true;
      }
      for (const item of event.requestHeadings) {
        const invocation = state.invocations.get(item.invocationId);
        if (invocation) {
          invocation.heading = item.heading;
          changed = true;
        }
      }
      break;
    }
    case "invocation.queued":
      state.invocations.set(event.invocation.id, event.invocation);
      changed = true;
      break;
    case "invocation.running": {
      const invocation = state.invocations.get(event.id);
      if (invocation) {
        Object.assign(invocation, {
          status: "running" as const,
          startedAt: event.startedAt,
          usageBaseline: event.usageBaseline,
        });
        changed = true;
      }
      break;
    }
    case "invocation.finished": {
      const invocation = state.invocations.get(event.id);
      if (invocation) {
        Object.assign(invocation, {
          status: event.status,
          finishedAt: event.finishedAt,
          usage: event.usage,
          ...(event.error === undefined ? {} : { error: event.error }),
        });
        changed = true;
      }
      break;
    }
    case "invocation.interrupted": {
      const invocation = state.invocations.get(event.id);
      if (invocation) {
        Object.assign(invocation, {
          status: "interrupted" as const,
          finishedAt: event.finishedAt,
          usage: event.usage,
          error: event.error,
        });
        changed = true;
      }
      break;
    }
  }
  if (changed) advanceStateRevision(state);
}

export function sessionEntriesUsage(entries: readonly SessionEntry[]): Usage {
  const usage = { ...ZERO_USAGE };
  for (const entry of entries) {
    if (entry.type !== "message" || entry.message.role !== "assistant") continue;
    usage.input += entry.message.usage.input;
    usage.output += entry.message.usage.output;
    usage.cacheRead += entry.message.usage.cacheRead;
    usage.cacheWrite += entry.message.usage.cacheWrite;
    usage.cost += entry.message.usage.cost.total;
  }
  usage.total = usage.input + usage.output + usage.cacheRead + usage.cacheWrite;
  return usage;
}

export function usageDelta(after: Usage, before: Usage): Usage {
  return {
    input: Math.max(0, after.input - before.input),
    output: Math.max(0, after.output - before.output),
    cacheRead: Math.max(0, after.cacheRead - before.cacheRead),
    cacheWrite: Math.max(0, after.cacheWrite - before.cacheWrite),
    total: Math.max(0, after.total - before.total),
    cost: Math.max(0, after.cost - before.cost),
  };
}

function isSubagentEvent(value: unknown): value is SubagentEvent {
  if (!value || typeof value !== "object") return false;
  const type = (value as { type?: unknown }).type;
  return (
    type === "agent.created" ||
    type === "agent.backend-session" ||
    type === "batch.started" ||
    type === "delegation.started" ||
    type === "delegation.headings" ||
    type === "invocation.queued" ||
    type === "invocation.running" ||
    type === "invocation.finished" ||
    type === "invocation.interrupted"
  );
}
