import { execFile } from "node:child_process";
import { complete } from "@earendil-works/pi-ai/compat";
import type { ExtensionAPI, ExtensionContext, SessionEntry } from "@earendil-works/pi-coding-agent";
import type { PromptDurationEntryData, PromptDurationListener } from "./ui/prompt-duration.ts";
import { formatPromptDuration } from "./ui/prompt-duration.ts";

const MODEL_PROVIDER = "openai-codex";
const MODEL_ID = "gpt-5.3-codex-spark";
const MAX_REQUEST_TOKENS = 96_000;
const MAX_CONTEXT_PERCENT = 75;
const LABEL_TIMEOUT_MS = 20_000;

type CompletionStatus = "completed" | "needs-input" | "blocked" | "failed";
export type CompletionLabel = { status: CompletionStatus; summary: string };
export type CompletionLabelGenerator = (
  source: string,
  ctx: ExtensionContext,
  signal: AbortSignal,
) => Promise<CompletionLabel | undefined>;
export type DesktopNotifier = (title: string, body: string) => void;

const STATUS_PRESENTATION: Record<CompletionStatus, {
  icon: string;
  title: string;
  tone: "info" | "warning" | "error";
}> = {
  completed: { icon: "✓", title: "Completed", tone: "info" },
  "needs-input": { icon: "?", title: "Needs input", tone: "warning" },
  blocked: { icon: "!", title: "Blocked", tone: "warning" },
  failed: { icon: "✗", title: "Failed", tone: "error" },
};

/** Registers best-effort, UI-only notifications for long prompt completions. */
export function registerLongTaskNotifications(
  pi: ExtensionAPI,
  labelGenerator: CompletionLabelGenerator = generateCompletionLabel,
  desktopNotifier: DesktopNotifier = notifyDesktop,
): PromptDurationListener {
  const active = new Set<AbortController>();

  pi.on("agent_start", () => {
    for (const controller of active) controller.abort();
    active.clear();
  });
  pi.on("session_shutdown", () => {
    for (const controller of active) controller.abort();
    active.clear();
  });

  return (duration, ctx) => {
    if (ctx.mode !== "tui") return;
    const controller = new AbortController();
    active.add(controller);

    void createNotification(duration, ctx, controller.signal, labelGenerator)
      .then((notification) => {
        if (!notification || controller.signal.aborted) return;
        ctx.ui.notify(notification.message, notification.tone);
        try {
          desktopNotifier(notification.title, notification.body);
        } catch {
          // Desktop delivery depends on terminal support and must remain best-effort.
        }
      })
      .catch(() => {
        if (controller.signal.aborted) return;
        const fallback = fallbackNotification(duration);
        ctx.ui.notify(fallback.message, fallback.tone);
        try {
          desktopNotifier(fallback.title, fallback.body);
        } catch {
          // The in-terminal notification has already succeeded.
        }
      })
      .finally(() => active.delete(controller));
  };
}

async function createNotification(
  duration: PromptDurationEntryData,
  ctx: ExtensionContext,
  signal: AbortSignal,
  labelGenerator: CompletionLabelGenerator,
): Promise<NotificationPresentation | undefined> {
  const source = completionSource(ctx.sessionManager.getBranch(), duration.promptEntryId);
  const label = source ? await generateLabelWithTimeout(source, ctx, signal, labelGenerator) : undefined;
  if (signal.aborted) return undefined;
  return label ? notificationPresentation(duration, label) : fallbackNotification(duration);
}

type NotificationPresentation = {
  title: string;
  body: string;
  message: string;
  tone: "info" | "warning" | "error";
};

export function notificationPresentation(
  duration: Pick<PromptDurationEntryData, "durationMs">,
  label: CompletionLabel,
): NotificationPresentation {
  const status = STATUS_PRESENTATION[label.status];
  const elapsed = formatPromptDuration(duration.durationMs);
  const summary = sanitizeNotificationText(label.summary) || "Pi finished and is ready for input";
  return {
    title: `Pi · ${status.title}`,
    body: `${summary} · ${elapsed}`,
    message: `${status.icon} ${summary} (${elapsed})`,
    tone: status.tone,
  };
}

function fallbackNotification(duration: Pick<PromptDurationEntryData, "durationMs">): NotificationPresentation {
  return notificationPresentation(duration, {
    status: "completed",
    summary: "Pi finished and is ready for input",
  });
}

export function completionSource(entries: readonly SessionEntry[], promptEntryId?: string): string | undefined {
  let promptIndex = -1;
  if (promptEntryId) promptIndex = entries.findIndex((entry) => entry.id === promptEntryId);
  if (promptIndex < 0) {
    for (let index = entries.length - 1; index >= 0; index--) {
      const entry = entries[index];
      if (entry?.type === "message" && entry.message.role === "user") {
        promptIndex = index;
        break;
      }
    }
  }

  const prompt = entries[promptIndex];
  if (!prompt || prompt.type !== "message" || prompt.message.role !== "user") return undefined;
  const transcript = formatCompletionEntries(entries.slice(promptIndex));
  return transcript || undefined;
}

export function parseCompletionLabel(text: string): CompletionLabel | undefined {
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) return undefined;
  try {
    const value = JSON.parse(match[0]) as { status?: unknown; summary?: unknown };
    if (
      value.status !== "completed" &&
      value.status !== "needs-input" &&
      value.status !== "blocked" &&
      value.status !== "failed"
    ) return undefined;
    if (typeof value.summary !== "string") return undefined;
    const summary = normalizeSummary(value.summary);
    return summary ? { status: value.status, summary } : undefined;
  } catch {
    return undefined;
  }
}

export function sanitizeNotificationText(value: string): string {
  return value
    .replace(/[\u0000-\u001F\u007F-\u009F]/g, " ")
    .replace(/[;\\]/g, ",")
    .replace(/\s+/g, " ")
    .trim();
}

export function desktopNotificationSequences(title: string, body: string, kitty: boolean): string[] {
  const safeTitle = sanitizeNotificationText(title);
  const safeBody = sanitizeNotificationText(body);
  if (kitty) {
    return [
      `\x1b]99;i=pi-long-task:d=0;${safeTitle}\x1b\\`,
      `\x1b]99;i=pi-long-task:p=body;${safeBody}\x1b\\`,
    ];
  }
  return [`\x1b]777;notify;${safeTitle};${safeBody}\x07`];
}

function notifyDesktop(title: string, body: string): void {
  const safeTitle = sanitizeNotificationText(title);
  const safeBody = sanitizeNotificationText(body);
  if (process.platform === "linux") {
    execFile("notify-send", desktopNotificationArguments(safeTitle, safeBody), (error) => {
      if (error) writeDesktopSequences(safeTitle, safeBody);
    });
    return;
  }
  writeDesktopSequences(safeTitle, safeBody);
}

export function desktopNotificationArguments(title: string, body: string): string[] {
  return [
    "--app-name=Pi",
    "--urgency=critical",
    "--expire-time=15000",
    "--",
    sanitizeNotificationText(title),
    sanitizeNotificationText(body),
  ];
}

function writeDesktopSequences(title: string, body: string): void {
  for (const sequence of desktopNotificationSequences(title, body, Boolean(process.env.KITTY_WINDOW_ID))) {
    process.stdout.write(sequence);
  }
}

async function generateLabelWithTimeout(
  source: string,
  ctx: ExtensionContext,
  parentSignal: AbortSignal,
  labelGenerator: CompletionLabelGenerator,
): Promise<CompletionLabel | undefined> {
  const controller = new AbortController();
  const abort = () => controller.abort();
  parentSignal.addEventListener("abort", abort, { once: true });
  const timeout = setTimeout(() => controller.abort(), LABEL_TIMEOUT_MS);
  const handle = timeout as { unref?: () => void };
  handle.unref?.();
  try {
    return await labelGenerator(source, ctx, controller.signal);
  } catch {
    return undefined;
  } finally {
    clearTimeout(timeout);
    parentSignal.removeEventListener("abort", abort);
  }
}

async function generateCompletionLabel(
  source: string,
  ctx: ExtensionContext,
  signal: AbortSignal,
): Promise<CompletionLabel | undefined> {
  const model = ctx.modelRegistry.find(MODEL_PROVIDER, MODEL_ID);
  if (!model) return undefined;
  const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
  if (!auth.ok || !auth.apiKey || signal.aborted) return undefined;

  const request = completionRequest(source, model.contextWindow);
  const response = await complete(
    model,
    {
      messages: [{
        role: "user",
        content: [{ type: "text", text: request }],
        timestamp: Date.now(),
      }],
    },
    { apiKey: auth.apiKey, headers: auth.headers, env: auth.env, maxTokens: 128, signal },
  );
  const text = response.content
    .filter((part): part is { type: "text"; text: string } => part.type === "text")
    .map((part) => part.text)
    .join("\n");
  return parseCompletionLabel(text);
}

function normalizeSummary(value: string): string | undefined {
  const clean = sanitizeNotificationText(value)
    .replace(/[`*_#]/g, "")
    .replace(/[.!?]+$/, "")
    .trim();
  const words = clean.split(" ").filter(Boolean);
  return words.length ? words.slice(0, 12).join(" ") : undefined;
}

type ToolCallRecord = { id: string; name: string; args: unknown };
type ToolResultRecord = { name: string; content: unknown; details: unknown; isError: boolean };

function formatCompletionEntries(entries: readonly SessionEntry[]): string {
  const lines: string[] = [];
  const calls = new Map<string, ToolCallRecord>();
  const summarizedCalls = new Set<string>();
  for (const entry of entries) {
    if (entry.type !== "message") continue;
    const message = entry.message;
    if (message.role === "user") {
      const text = contentText(message.content);
      if (text) lines.push(`User: ${text}`);
      continue;
    }
    if (message.role === "assistant") {
      if (message.stopReason === "stop") {
        const text = contentText(message.content);
        if (text) lines.push(`Assistant: ${text}`);
      }
      if (Array.isArray(message.content)) {
        for (const part of message.content) {
          if (!part || typeof part !== "object" || (part as { type?: unknown }).type !== "toolCall") continue;
          const call = part as { id?: unknown; name?: unknown; arguments?: unknown };
          if (typeof call.id !== "string") continue;
          calls.set(call.id, {
            id: call.id,
            name: typeof call.name === "string" ? call.name : "unknown",
            args: call.arguments,
          });
        }
      }
      continue;
    }
    if (message.role === "toolResult") {
      const id = typeof message.toolCallId === "string" ? message.toolCallId : "";
      const name = typeof message.toolName === "string" ? message.toolName : calls.get(id)?.name ?? "unknown";
      lines.push(summarizeToolCall(calls.get(id) ?? { id, name, args: undefined }, {
        name,
        content: message.content,
        details: message.details,
        isError: Boolean(message.isError),
      }));
      if (id) summarizedCalls.add(id);
    }
  }
  for (const call of calls.values()) {
    if (!summarizedCalls.has(call.id)) lines.push(`Tool ${call.name} did not return a result\n${summarizeToolIntent(call.name, call.args)}`);
  }
  return lines.join("\n\n");
}

function summarizeToolCall(call: ToolCallRecord, result: ToolResultRecord): string {
  const status = result.isError ? "failed" : "succeeded";
  const output = contentText(result.content);
  const outputLines = nonEmptyLines(output);
  const details = objectRecord(result.details);
  const truncation = truncationNote(details);
  const header = `Tool ${call.name} ${status}`;
  const args = objectRecord(call.args);

  switch (call.name) {
    case "bash":
      return joinSummary([
        header,
        `Command: ${compactText(stringValue(args.command) || "[unknown]", 1_000)}`,
        outputStats(output, outputLines),
        outputLines.length ? `Final output:\n${sampleEnd(outputLines, 3)}` : "No text output",
        truncation,
      ]);
    case "read":
      return joinSummary([
        header,
        `Read: ${stringValue(args.path) || "[unknown path]"}${lineRange(args)}`,
        outputStats(output, outputLines),
        truncation,
      ]);
    case "write": {
      const content = stringValue(args.content);
      return joinSummary([
        header,
        `Wrote: ${stringValue(args.path) || "[unknown path]"}`,
        content ? `Input: ${content.length.toLocaleString()} characters, ${content.split("\n").length.toLocaleString()} lines` : undefined,
      ]);
    }
    case "edit": {
      const edits = Array.isArray(args.edits) ? args.edits.length : undefined;
      const changedLine = numberValue(details.firstChangedLine);
      return joinSummary([
        header,
        `Edited: ${stringValue(args.path) || "[unknown path]"}`,
        edits === undefined ? undefined : `Replacements: ${edits}`,
        changedLine === undefined ? undefined : `First changed line: ${changedLine}`,
      ]);
    }
    case "grep":
      return joinSummary([
        header,
        `Search: ${quote(stringValue(args.pattern) || "[unknown]")} in ${stringValue(args.path) || "."}${stringValue(args.glob) ? ` matching ${quote(stringValue(args.glob))}` : ""}`,
        outputStats(output, outputLines, "matches"),
        outputLines.length ? `Sample matches:\n${sampleEdges(outputLines, 3)}` : "No matches returned",
        truncation,
      ]);
    case "find":
      return joinSummary([
        header,
        `Find: ${quote(stringValue(args.pattern) || "[unknown]")} in ${stringValue(args.path) || "."}`,
        outputStats(output, outputLines, "paths"),
        outputLines.length ? `Sample paths:\n${sampleEdges(outputLines, 3)}` : "No paths returned",
        truncation,
      ]);
    case "ls":
      return joinSummary([
        header,
        `Listed: ${stringValue(args.path) || "."}`,
        outputStats(output, outputLines, "entries"),
        outputLines.length ? `Sample entries:\n${sampleEdges(outputLines, 3)}` : "No entries returned",
        truncation,
      ]);
    default:
      return joinSummary([
        header,
        summarizeToolIntent(call.name, call.args),
        outputStats(output, outputLines),
        outputLines.length ? `Output sample:\n${sampleEdges(outputLines, 3)}` : "No text output",
        truncation,
      ]);
  }
}

function summarizeToolIntent(name: string, args: unknown): string {
  const value = safeJson(args);
  return value === "{}" || value === "null" ? `Call: ${name}` : `Arguments: ${compactText(value, 1_000)}`;
}

function completionRequest(source: string, contextWindow: number): string {
  const instructions = [
    "Create a concise completion notification for this coding task.",
    "Return JSON only with this exact shape:",
    '{"status":"completed|needs-input|blocked|failed","summary":"up to 12 words"}',
    "Classify the final state from the assistant response and tool execution evidence.",
    "Use needs-input only when the response asks the user to choose, clarify, or approve.",
    "Use blocked only when the response or tools explicitly show that a dependency or required information prevents progress.",
    "Use failed only when the response or tools explicitly show failed work or verification without a usable completion.",
    "Otherwise classify the task as completed.",
    "Describe the concrete task outcome. No markdown or ending punctuation.",
  ].join("\n");
  const maxTokens = Math.min(MAX_REQUEST_TOKENS, Math.floor(contextWindow * MAX_CONTEXT_PERCENT / 100));
  const maxChars = Math.max(0, maxTokens * 4 - instructions.length - 2);
  return `${instructions}\n\n${fitTimeline(source, maxChars)}`;
}

function fitTimeline(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value;
  const marker = "\n\n[task timeline truncated]\n\n";
  if (maxChars <= marker.length) return value.slice(-maxChars);
  const available = maxChars - marker.length;
  const beginningLength = Math.floor(available / 3);
  return `${value.slice(0, beginningLength)}${marker}${value.slice(-(available - beginningLength))}`;
}

function joinSummary(parts: Array<string | undefined>): string {
  return parts.filter((part): part is string => Boolean(part)).join("\n");
}

function outputStats(output: string, lines: readonly string[], noun = "non-empty lines"): string {
  return `Returned: ${lines.length.toLocaleString()} ${noun}, ${output.length.toLocaleString()} characters`;
}

function nonEmptyLines(value: string): string[] {
  return value.split("\n").map((line) => line.trim()).filter(Boolean);
}

function sampleEnd(lines: readonly string[], count: number): string {
  return lines.slice(-count).map((line) => compactText(line, 500)).join("\n");
}

function sampleEdges(lines: readonly string[], count: number): string {
  if (lines.length <= count * 2) return lines.map((line) => compactText(line, 500)).join("\n");
  return [
    ...lines.slice(0, count).map((line) => compactText(line, 500)),
    `… ${lines.length - count * 2} omitted …`,
    ...lines.slice(-count).map((line) => compactText(line, 500)),
  ].join("\n");
}

function compactText(value: string, maxChars: number): string {
  const clean = value.replace(/\s+/g, " ").trim();
  return clean.length <= maxChars ? clean : `${clean.slice(0, maxChars - 1)}…`;
}

function lineRange(args: Record<string, unknown>): string {
  const offset = numberValue(args.offset);
  const limit = numberValue(args.limit);
  if (offset === undefined && limit === undefined) return "";
  const start = offset ?? 1;
  return limit === undefined ? ` from line ${start}` : ` lines ${start}-${start + Math.max(0, limit - 1)}`;
}

function truncationNote(details: Record<string, unknown>): string | undefined {
  const truncation = objectRecord(details.truncation);
  if (!truncation.truncated) return undefined;
  const outputLines = numberValue(truncation.outputLines);
  const totalLines = numberValue(truncation.totalLines);
  if (outputLines !== undefined && totalLines !== undefined) return `Tool output truncated: ${outputLines} of ${totalLines} lines returned`;
  return "Tool output was truncated";
}

function objectRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function quote(value: string): string {
  return JSON.stringify(value);
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value) ?? "null";
  } catch {
    return "[unserializable arguments]";
  }
}

function contentText(content: unknown): string {
  if (typeof content === "string") return content.trim();
  if (!Array.isArray(content)) return "";
  return content
    .filter((part): part is { type: "text"; text: string } =>
      typeof part === "object" && part !== null && (part as { type?: unknown }).type === "text" && typeof (part as { text?: unknown }).text === "string",
    )
    .map((part) => part.text)
    .join("\n")
    .trim();
}
