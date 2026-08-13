import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { BackgroundBatchLaunch, BatchResult } from "./runtime/types.ts";
import { formatBatchForModel } from "./tool.ts";

export const BACKGROUND_SUBAGENT_RESULT_TYPE = "pi-subagents-background-result";

type SendMessage = ExtensionAPI["sendMessage"];

/**
 * Deliver one hidden follow-up after a detached root batch settles. The active
 * runtime guard prevents an old branch or replaced session from receiving a
 * stale completion.
 */
export async function deliverBackgroundBatchResult(
  launch: BackgroundBatchLaunch,
  sendMessage: SendMessage,
  isActive: () => boolean,
): Promise<void> {
  let content: string;
  let details: { batchId: string; error?: string };
  try {
    const result = await launch.completion;
    if (!isActive()) return;
    content = formatBackgroundBatchResult(result);
    details = { batchId: result.batchId };
  } catch (error) {
    if (!isActive()) return;
    const message = error instanceof Error ? error.message : String(error);
    content = `[Background subagents · ${launch.batchId} · failed]\n${message}`;
    details = { batchId: launch.batchId, error: message };
  }

  try {
    sendMessage(
      {
        customType: BACKGROUND_SUBAGENT_RESULT_TYPE,
        content,
        display: false,
        details,
      },
      { triggerTurn: true, deliverAs: "followUp" },
    );
  } catch {
    // Session replacement can race the active-runtime check and invalidate Pi's
    // session-bound API. The replacement runtime must not receive stale work.
  }
}

export function formatBackgroundBatchResult(result: BatchResult): string {
  return `[Background subagents · ${result.batchId} · settled]\n${formatBatchForModel(result)}`;
}
