import type { MessageRenderer } from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Box, Text } from "@earendil-works/pi-tui";
import type { BackgroundRunSettledResult } from "./types.ts";
import { formatDuration } from "../ui/panel.ts";

export const BACKGROUND_RUN_RESULT_TYPE = "pi-bg-run-result";

export type BackgroundRunResultDetails = {
  runId: string;
  command: string;
  status: string;
  exitCode?: number | null;
  error?: string;
  durationMs: number;
  fullOutputPath?: string;
};

type SendMessage = ExtensionAPI["sendMessage"];

/**
 * Deliver one hidden follow-up after a detached run settles. A stale session API
 * (after reload or session replacement) throws and is swallowed: the process was
 * intentionally left running, so there is nothing to clean up.
 */
export function deliverBackgroundRunResult(result: BackgroundRunSettledResult, sendMessage: SendMessage): void {
  const details: BackgroundRunResultDetails = {
    runId: result.runId,
    command: result.command,
    status: result.status,
    ...(result.exitCode === undefined ? {} : { exitCode: result.exitCode }),
    ...(result.error === undefined ? {} : { error: result.error }),
    durationMs: result.durationMs,
    ...(result.fullOutputPath === undefined ? {} : { fullOutputPath: result.fullOutputPath }),
  };
  try {
    sendMessage(
      { customType: BACKGROUND_RUN_RESULT_TYPE, content: formatBackgroundRunResult(result), display: true, details },
      { triggerTurn: true, deliverAs: "followUp" },
    );
  } catch {
    // Session replacement or reload invalidated this extension's API.
  }
}

export function formatBackgroundRunResult(result: BackgroundRunSettledResult): string {
  const hasExit = result.exitCode !== undefined && result.exitCode !== null;
  const status = result.status === "complete" || (result.status === "failed" && hasExit)
    ? `exited ${result.exitCode}`
    : result.status;
  const duration = formatDuration(result.durationMs);
  const output = result.output.trimEnd();
  const error = result.error ? `\n${result.error}` : "";
  const full = result.fullOutputPath ? `\n\n[Full output: ${result.fullOutputPath}]` : "";
  return `[Background run · ${result.runId} · ${status} · ${duration}]\n$ ${result.command}\n${output ? output : "(no output)"}${error}${full}`;
}

/** Colored transcript card registered for {@link BACKGROUND_RUN_RESULT_TYPE}. */
export const renderBackgroundRunMessage: MessageRenderer<BackgroundRunResultDetails> = (message, options, theme) => {
  const box = new Box(options.outputPad, 1, (text) => theme.bg("customMessageBg", text));
  const lines: string[] = [];
  const details = message.details;
  if (!details) {
    lines.push(`${theme.fg("accent", "Background run")} ${theme.fg("dim", "· settled")}`);
  } else {
    const glyphColor = details.status === "complete" ? "success" : details.status === "failed" ? "error" : "warning";
    const settledWord = details.status === "cancelled" ? "cancelled" : "settled";
    lines.push(`${theme.fg("accent", "⟳ Background run")} ${theme.fg("dim", `· ${settledWord}`)} ${theme.fg("dim", `· ${shortId(details.runId)}`)}`);
    const outcome =
      details.status === "complete"
        ? `exited ${details.exitCode}`
        : details.status === "failed" && details.exitCode !== undefined && details.exitCode !== null
          ? `exited ${details.exitCode}`
          : details.status;
    lines.push(`  ${theme.fg(glyphColor, statusGlyph(details.status))} ${theme.fg("text", outcome)} ${theme.fg("dim", `· ${formatDuration(details.durationMs)}`)}`);
    if (details.error) lines.push(`  ${theme.fg("warning", details.error)}`);
    if (details.command) lines.push(`  ${theme.fg("dim", `$ ${details.command}`)}`);
  }
  if (options.expanded) appendOutput(lines, message.content, theme);
  box.addChild(new Text(lines.join("\n"), 0, 0));
  return box;
};

function statusGlyph(status: string): string {
  return status === "complete" ? "✓" : status === "failed" ? "✗" : status === "cancelled" ? "−" : "!";
}

function shortId(id: string): string {
  return id.length > 8 ? id.slice(0, 8) : id;
}

function appendOutput(lines: string[], content: string | ReadonlyArray<{ type: string; text?: string }>, theme: { fg(color: string, text: string): string }): void {
  const text = typeof content === "string" ? content : content.map((part) => part.text ?? "").join("\n");
  if (!text) return;
  lines.push("");
  lines.push(theme.fg("dim", "──────── output ────────"));
  lines.push(text);
}
