import type { ExtensionAPI, ExtensionContext, SessionEntry } from "@earendil-works/pi-coding-agent";
import { EMPTY_FINAL_REPROMPT } from "./runtime/runtime.ts";

/**
 * Root-session guard against silent empty completions (observed with
 * stealth/ox-alpha via OpenRouter): the model ends its turn with
 * stopReason "stop" or "length" but no text content at all. The agent loop
 * treats that as a finished turn and pi just goes idle mid-conversation.
 *
 * When the settled turn is empty, send one automatic continuation prompt so
 * the model picks its work back up. If the retry comes back empty too,
 * surface a visible warning instead of looping (or silently stalling). Native subagent sessions are
 * skipped — SubagentRuntime.runInvocation has the equivalent guard built in,
 * and double-firing would queue two recovery prompts.
 */
export function registerEmptyFinalGuard(pi: ExtensionAPI): void {
  // True while we are waiting for the turn triggered by our own follow-up.
  let awaitingRetry = false;

  pi.on("agent_settled", async (_event, ctx) => {
    try {
      const sessionFile = ctx.sessionManager?.getSessionFile();
      if (sessionFile?.includes("/subagent-sessions/")) return;

      const last = lastMessageEntry(ctx.sessionManager.getBranch());
      if (!last || last.message.role !== "assistant") return;

      const stopReason = last.message.stopReason;
      const text = contentText(last.message.content).trim();
      if (text !== "") {
        // A healthy response closes any open retry episode.
        awaitingRetry = false;
        return;
      }
      if (stopReason !== "stop" && stopReason !== "length") return;
      // The user typed again or another extension queued work: don't race it.
      if (ctx.hasPendingMessages()) return;

      if (awaitingRetry) {
        // Our previous follow-up also came back empty — give up visibly.
        awaitingRetry = false;
        notifyEmptyStall(ctx);
        return;
      }

      awaitingRetry = true;
      await pi.sendUserMessage(EMPTY_FINAL_REPROMPT, { deliverAs: "followUp" });
    } catch {
      // The guard must never take the session down; a missed retry only
      // reproduces today's status quo.
      awaitingRetry = false;
    }
  });
}

function notifyEmptyStall(ctx: ExtensionContext): void {
  try {
    ctx.ui.notify(
      "The model returned an empty response twice in a row. Send your prompt again to continue.",
      "warning",
    );
  } catch {
    // UI may be unavailable in headless modes; nothing else to do.
  }
}

/** Last message entry of any role, skipping custom/render-only entries. */
function lastMessageEntry(entries: readonly SessionEntry[]): (SessionEntry & { message: { role: string; stopReason?: string; content: unknown } }) | undefined {
  for (let index = entries.length - 1; index >= 0; index--) {
    const entry = entries[index];
    if (entry?.type === "message") return entry as never;
  }
  return undefined;
}

function contentText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((part): part is { type: "text"; text: string } =>
      typeof part === "object" && part !== null && (part as { type?: unknown }).type === "text" && typeof (part as { text?: unknown }).text === "string",
    )
    .map((part) => part.text)
    .join("\n");
}
