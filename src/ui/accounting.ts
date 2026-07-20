import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { replayRuntimeState, sessionEntriesUsage } from "../runtime/state.ts";
import { ZERO_USAGE, type RuntimeState, type Usage } from "../runtime/types.ts";

export type FooterUsageTotals = {
  /** Native parent and child invocation usage reachable from the active leaf. */
  leaf: Usage;
  /** Native parent and child invocation usage in the complete persisted session tree. */
  tree: Usage;
};

export function footerUsageTotals(
  branch: readonly SessionEntry[],
  entries: readonly SessionEntry[],
  liveBranchState?: RuntimeState,
): FooterUsageTotals {
  const persistedTree = replayRuntimeState(entries);
  if (liveBranchState) overlayInvocations(persistedTree, liveBranchState);

  return {
    leaf: addUsage(
      sessionEntriesUsage(branch),
      invocationUsage(liveBranchState ?? replayRuntimeState(branch)),
    ),
    tree: addUsage(sessionEntriesUsage(entries), invocationUsage(persistedTree)),
  };
}

export function invocationUsage(state: RuntimeState): Usage {
  let total = { ...ZERO_USAGE };
  for (const invocation of state.invocations.values()) total = addUsage(total, invocation.usage);
  return total;
}

export function addUsage(left: Usage, right: Usage): Usage {
  const input = left.input + right.input;
  const output = left.output + right.output;
  const cacheRead = left.cacheRead + right.cacheRead;
  const cacheWrite = left.cacheWrite + right.cacheWrite;
  return {
    input,
    output,
    cacheRead,
    cacheWrite,
    total: input + output + cacheRead + cacheWrite,
    cost: left.cost + right.cost,
  };
}

function overlayInvocations(target: RuntimeState, source: RuntimeState): void {
  for (const [id, invocation] of source.invocations) target.invocations.set(id, invocation);
}
