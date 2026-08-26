import type { ExtensionAPI, MessageRenderer, MessageRenderOptions, SessionEntry, Theme } from "@earendil-works/pi-coding-agent";
import { Box, Text } from "@earendil-works/pi-tui";
import type { BackgroundBatchLaunch, BatchResult } from "./runtime/types.ts";
import { formatBatchForModel } from "./tool.ts";

export const BACKGROUND_SUBAGENT_RESULT_TYPE = "pi-subagents-background-result";

type SendMessage = ExtensionAPI["sendMessage"];

/** Terminal statuses a settled background run can carry. */
export type BackgroundRunStatus = "complete" | "failed" | "cancelled" | "interrupted";

/** Compact per-run metadata attached to the rendered message. Outputs stay in content only. */
export type BackgroundBatchRunSummary = {
  role: string;
  agent: string;
  status: BackgroundRunStatus;
  error?: string;
};

export type BackgroundBatchResultDetails = {
  batchId: string;
  durationMs: number;
  runs: BackgroundBatchRunSummary[];
  error?: string;
};

/**
 * Batch ids whose result card already exists in the transcript. The persisted
 * custom message is the delivery ledger: it is written exactly when the host
 * consumes the follow-up, so a settled batch without a card here was queued
 * and lost (e.g. the turn was interrupted before the queue drained).
 */
export function deliveredBackgroundBatchIds(entries: readonly SessionEntry[]): Set<string> {
  const ids = new Set<string>();
  for (const entry of entries) {
    if (entry.type !== "custom_message" || entry.customType !== BACKGROUND_SUBAGENT_RESULT_TYPE) continue;
    const batchId = (entry.details as BackgroundBatchResultDetails | undefined)?.batchId;
    if (batchId) ids.add(batchId);
  }
  return ids;
}

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
  let details: BackgroundBatchResultDetails;
  try {
    const result = await launch.completion;
    if (!isActive()) return;
    content = formatBackgroundBatchResult(result);
    details = {
      batchId: result.batchId,
      durationMs: result.durationMs,
      runs: result.runs.map((run) => ({
        role: run.role,
        agent: run.agent,
        status: run.status as BackgroundRunStatus,
        ...(run.error === undefined ? {} : { error: run.error }),
      })),
    };
  } catch (error) {
    if (!isActive()) return;
    const message = error instanceof Error ? error.message : String(error);
    content = `[Background subagents · ${launch.batchId} · failed]\n${message}`;
    details = { batchId: launch.batchId, durationMs: 0, runs: [], error: message };
  }

  try {
    sendMessage(
      {
        customType: BACKGROUND_SUBAGENT_RESULT_TYPE,
        content,
        display: true,
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

/** Colored transcript card registered for {@link BACKGROUND_SUBAGENT_RESULT_TYPE}. */
export const renderBackgroundBatchMessage: MessageRenderer<BackgroundBatchResultDetails> = (
  message,
  options,
  theme,
) => {
  const box = new Box(options.outputPad, 1, (text) => theme.bg("customMessageBg", text));
  const lines: string[] = [];
  const details = message.details;
  if (!details) {
    lines.push(`${theme.fg("accent", "Background subagents")} ${theme.fg("dim", "· settled")}`);
  } else if (details.error !== undefined) {
    lines.push(`${theme.fg("error", "✗")} ${theme.fg("accent", "Background subagents")} ${theme.fg("error", "· failed")} ${theme.fg("dim", `· ${shortId(details.batchId)}`)}`);
    lines.push(theme.fg("dim", details.error));
  } else {
    const counts = { complete: 0, failed: 0, cancelled: 0, interrupted: 0 };
    for (const run of details.runs) counts[run.status] += 1;
    const summary = statusSummary(counts);
    lines.push(`${theme.fg("accent", "⟳ Background subagents")} ${theme.fg("dim", "· settled")} ${theme.fg("dim", `· ${shortId(details.batchId)}`)}`);
    lines.push(theme.fg("dim", `${details.runs.length} ${details.runs.length === 1 ? "agent" : "agents"}${summary ? ` · ${summary}` : ""}`));
    for (const run of details.runs) {
      const color = run.status === "complete" ? "success" : run.status === "failed" ? "error" : "warning";
      const error = run.error ? ` ${theme.fg("warning", `· ${run.error}`)}` : "";
      lines.push(`  ${theme.fg(color, statusGlyph(run.status))} ${theme.fg("text", run.role)} ${theme.fg("dim", `· ${run.agent} · ${run.status}`)}${error}`);
    }
  }
  if (options.expanded) appendColoredOutput(lines, message.content, theme);
  box.addChild(new Text(lines.join("\n"), 0, 0));
  return box;
};

function statusGlyph(status: BackgroundRunStatus): string {
  return status === "complete" ? "✓" : status === "failed" ? "✗" : status === "cancelled" ? "−" : "!";
}

function statusSummary(counts: Record<BackgroundRunStatus, number>): string {
  const parts: string[] = [];
  for (const status of ["complete", "failed", "cancelled", "interrupted"] as const) {
    if (counts[status] > 0) parts.push(`${counts[status]} ${status}`);
  }
  return parts.join(" · ");
}

function shortId(id: string): string {
  // Session-scoped counters (batch-1) fit whole; legacy UUIDs tail-slice.
  return id.length <= 20 ? id : id.slice(-8);
}

function appendColoredOutput(lines: string[], content: string | ReadonlyArray<{ type: string; text?: string }>, theme: Theme): void {
  const text = typeof content === "string" ? content : content.map((part) => part.text ?? "").join("\n");
  if (!text) return;
  lines.push("");
  lines.push(theme.fg("dim", "──────── outputs ────────"));
  lines.push(text);
}
