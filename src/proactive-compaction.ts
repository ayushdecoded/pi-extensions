import type { ExtensionAPI, ExtensionContext, SessionBeforeCompactEvent, TurnEndEvent } from "@earendil-works/pi-coding-agent";

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

  // Pi's configured reserve is token-based. Suppress its earlier threshold
  // compactions so the 85% policy remains correct for every model window.
  pi.on("session_before_compact", (event, ctx) => {
    if (event.reason !== "threshold") return;
    if (!shouldAllowThresholdCompaction(event, ctx)) return { cancel: true };
  });
}

export function shouldCompactActiveTurn(event: TurnEndEvent, ctx: ExtensionContext): boolean {
  if (event.toolResults.length === 0) return false;
  const percent = ctx.getContextUsage()?.percent;
  return percent !== null && percent !== undefined && percent >= COMPACTION_PERCENT;
}

export function shouldAllowThresholdCompaction(event: SessionBeforeCompactEvent, ctx: ExtensionContext): boolean {
  const contextWindow = ctx.model?.contextWindow;
  if (!contextWindow || contextWindow <= 0) return true;
  return event.preparation.tokensBefore / contextWindow * 100 >= COMPACTION_PERCENT;
}
