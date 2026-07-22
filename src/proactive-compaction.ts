import type { ExtensionAPI, ExtensionContext, TurnEndEvent } from "@earendil-works/pi-coding-agent";

export const COMPACTION_PERCENT = 85;
const CONTINUATION_TYPE = "proactive-compaction-continuation";
const CONTINUATION_INSTRUCTION = "Continue the active task from the compacted context. Do not stop merely because compaction occurred; complete the work that was in progress.";

/**
 * Enforces the context budget at safe turn boundaries. Pi's public compact API
 * aborts the active run, so this queues one hidden continuation after compaction
 * rather than trying to interrupt a streamed response.
 */
export function registerProactiveCompaction(pi: ExtensionAPI): void {
  let compacting = false;

  pi.on("turn_end", (event, ctx) => {
    if (compacting || !shouldCompactActiveTurn(event, ctx)) return;
    compacting = true;
    ctx.compact({
      onComplete: () => {
        compacting = false;
        pi.sendMessage(
          { customType: CONTINUATION_TYPE, content: CONTINUATION_INSTRUCTION, display: false },
          { triggerTurn: true, deliverAs: "followUp" },
        );
      },
      onError: () => { compacting = false; },
    });
  });

  // This extension owns threshold scheduling. Letting Pi's native threshold
  // compaction proceed at 85% races the ctx.compact() call above: both can
  // prepare the same context, then either compact twice or make one fail.
  // Manual compaction and overflow recovery remain native Pi behavior.
  pi.on("session_before_compact", (event) => {
    if (event.reason === "threshold") return { cancel: true };
  });
}

export function shouldCompactActiveTurn(event: TurnEndEvent, ctx: ExtensionContext): boolean {
  if (event.toolResults.length === 0) return false;
  const percent = ctx.getContextUsage()?.percent;
  return percent !== null && percent !== undefined && percent >= COMPACTION_PERCENT;
}
