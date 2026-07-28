import type {
  ExtensionAPI,
  ExtensionContext,
  SessionEntry,
  Theme,
  ThemeColor,
} from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { PROACTIVE_COMPACTION_CONTINUATION_TYPE } from "../proactive-compaction.ts";

export const PROMPT_DURATION_ENTRY_TYPE = "prompt-duration";
export const PROMPT_DURATION_MINIMUM_MS = 60_000;

export interface PromptDurationEntryData {
  version: 1;
  promptEntryId?: string;
  startedAt: number;
  completedAt: number;
  durationMs: number;
  reconstructed?: true;
}

export interface PromptDurationClock {
  now(): number;
  setInterval(callback: () => void, intervalMs: number): unknown;
  clearInterval(handle: unknown): void;
}

type ActivePrompt = {
  startedAt: number;
  promptTimestamp: number;
};

type DurationPresentation = {
  icon: string;
  liveLabel: string;
  completedLabel: (duration: string) => string;
  color: ThemeColor;
  ruleColor: ThemeColor;
  rule: string;
  ornate?: boolean;
};

const SYSTEM_CLOCK: PromptDurationClock = {
  now: () => Date.now(),
  setInterval: (callback, intervalMs) => setInterval(callback, intervalMs),
  clearInterval: (handle) => clearInterval(handle as ReturnType<typeof setInterval>),
};

export function registerPromptDuration(
  pi: ExtensionAPI,
  clock: PromptDurationClock = SYSTEM_CLOCK,
): void {
  const controller = new PromptDurationController(pi, clock);

  pi.registerEntryRenderer<PromptDurationEntryData>(
    PROMPT_DURATION_ENTRY_TYPE,
    (entry, _options, theme) => {
      const data = parseDurationData(entry.data);
      if (!data || data.durationMs < PROMPT_DURATION_MINIMUM_MS) return undefined;
      return new PromptDurationDivider(data.durationMs, theme);
    },
  );

  pi.on("session_start", (event, ctx) => controller.startSession(ctx, event.reason === "reload"));
  pi.on("message_start", (event, ctx) => {
    if (
      event.message.role !== "user" ||
      (event.message as { customType?: unknown }).customType === PROACTIVE_COMPACTION_CONTINUATION_TYPE
    ) return;
    controller.startPrompt(event.message.timestamp, ctx);
  });
  pi.on("agent_settled", (_event, ctx) => controller.settlePrompt(ctx));
  pi.on("session_shutdown", (_event, ctx) => controller.stopSession(ctx));
}

export class PromptDurationController {
  private active?: ActivePrompt;
  private ctx?: ExtensionContext;
  private interval?: unknown;

  constructor(
    private readonly pi: ExtensionAPI,
    private readonly clock: PromptDurationClock = SYSTEM_CLOCK,
  ) {}

  startSession(ctx: ExtensionContext, reconcile = false): void {
    this.clearLiveTimer();
    this.active = undefined;
    this.ctx = ctx;
    if (ctx.mode === "tui") ctx.ui.setWorkingMessage();
    if (reconcile) reconcileLatestPrompt(this.pi, ctx);
  }

  startPrompt(promptTimestamp: number, ctx: ExtensionContext): void {
    const now = this.clock.now();
    if (this.active) this.finishActive(ctx, now);

    const startedAt = validTimestamp(promptTimestamp) ? promptTimestamp : now;
    this.ctx = ctx;
    this.active = { startedAt, promptTimestamp: startedAt };
    this.startLiveTimer();
  }

  settlePrompt(ctx: ExtensionContext): void {
    if (this.active) this.finishActive(ctx, this.clock.now());
  }

  stopSession(ctx: ExtensionContext): void {
    this.clearLiveTimer();
    this.active = undefined;
    this.ctx = undefined;
    if (ctx.mode === "tui") ctx.ui.setWorkingMessage();
  }

  private finishActive(ctx: ExtensionContext, completedAt: number): void {
    const active = this.active;
    if (!active) return;

    this.active = undefined;
    this.clearLiveTimer();
    if (ctx.mode === "tui") ctx.ui.setWorkingMessage();

    const durationMs = Math.max(0, completedAt - active.startedAt);
    if (durationMs < PROMPT_DURATION_MINIMUM_MS) return;

    const branch = ctx.sessionManager.getBranch();
    const promptEntry = findPromptEntry(branch, active.promptTimestamp);
    if (hasDurationEntry(branch, promptEntry?.id, active.startedAt)) return;

    const data: PromptDurationEntryData = {
      version: 1,
      promptEntryId: promptEntry?.id,
      startedAt: active.startedAt,
      completedAt,
      durationMs,
    };
    this.pi.appendEntry<PromptDurationEntryData>(PROMPT_DURATION_ENTRY_TYPE, data);
  }

  private startLiveTimer(): void {
    this.clearLiveTimer();
    this.updateLiveTimer();
    if (!this.active || this.ctx?.mode !== "tui") return;

    this.interval = this.clock.setInterval(() => this.updateLiveTimer(), 1_000);
    const handle = this.interval as { unref?: () => void };
    handle.unref?.();
  }

  private clearLiveTimer(): void {
    if (this.interval !== undefined) this.clock.clearInterval(this.interval);
    this.interval = undefined;
  }

  private updateLiveTimer(): void {
    if (!this.active || this.ctx?.mode !== "tui") return;
    const durationMs = Math.max(0, this.clock.now() - this.active.startedAt);
    this.ctx.ui.setWorkingMessage(renderLiveDuration(durationMs, this.ctx.ui.theme));
  }
}

export function reconcileLatestPrompt(pi: ExtensionAPI, ctx: ExtensionContext): void {
  const branch = ctx.sessionManager.getBranch();
  const promptIndex = findLatestUserEntryIndex(branch);
  if (promptIndex < 0) return;

  const promptEntry = branch[promptIndex];
  if (!promptEntry || promptEntry.type !== "message" || promptEntry.message.role !== "user") return;
  const startedAt = validTimestamp(promptEntry.message.timestamp)
    ? promptEntry.message.timestamp
    : parseEntryTimestamp(promptEntry);
  if (startedAt === undefined || hasDurationEntry(branch, promptEntry.id, startedAt)) return;

  const completedAt = findCompletionTimestamp(branch, promptIndex + 1);
  if (completedAt === undefined) return;
  const durationMs = Math.max(0, completedAt - startedAt);
  if (durationMs < PROMPT_DURATION_MINIMUM_MS) return;

  pi.appendEntry<PromptDurationEntryData>(PROMPT_DURATION_ENTRY_TYPE, {
    version: 1,
    promptEntryId: promptEntry.id,
    startedAt,
    completedAt,
    durationMs,
    reconstructed: true,
  });
}

export function renderLiveDuration(durationMs: number, theme: Theme): string {
  const presentation = durationPresentation(durationMs);
  return [
    theme.fg(presentation.color, presentation.icon),
    theme.bold(theme.fg(presentation.color, presentation.liveLabel)),
    theme.fg("borderMuted", "·"),
    theme.fg("muted", formatPromptDuration(durationMs)),
  ].join(" ");
}

export function renderDurationDivider(durationMs: number, width: number, theme: Theme): string {
  if (width <= 0) return "";
  const presentation = durationPresentation(durationMs);
  const duration = formatPromptDuration(durationMs);
  const description = presentation.completedLabel(duration);
  const start = presentation.ornate ? "✦" : presentation.rule;
  const end = presentation.ornate ? " ✦" : "";
  const label = `${start} ${presentation.icon} ${description}${end}`;
  const styledLabel = theme.bold(theme.fg(presentation.color, label));
  const remaining = width - visibleWidth(label);
  if (remaining <= 1) return truncateToWidth(styledLabel, width, "");

  const tail = ` ${presentation.rule.repeat(remaining - 1)}`;
  return truncateToWidth(styledLabel + theme.fg(presentation.ruleColor, tail), width, "");
}

export function formatPromptDuration(durationMs: number): string {
  const seconds = Math.max(0, Math.floor(durationMs / 1_000));
  if (seconds < 60) return `${seconds}s`;

  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = seconds % 60;
  if (minutes < 60) return `${minutes}m ${remainingSeconds.toString().padStart(2, "0")}s`;

  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  return `${hours}h ${remainingMinutes.toString().padStart(2, "0")}m`;
}

export function durationPresentation(durationMs: number): DurationPresentation {
  if (durationMs < 5 * 60_000) {
    return {
      icon: "⚡",
      liveLabel: "Zipping",
      completedLabel: (duration) => `Zipped for ${duration}`,
      color: "accent",
      ruleColor: "borderMuted",
      rule: "─",
    };
  }
  if (durationMs < 15 * 60_000) {
    return {
      icon: "🛠",
      liveLabel: "Cooking",
      completedLabel: (duration) => `Cooked for ${duration}`,
      color: "success",
      ruleColor: "success",
      rule: "━",
    };
  }
  if (durationMs < 30 * 60_000) {
    return {
      icon: "🔥",
      liveLabel: "Forging",
      completedLabel: (duration) => `Forged for ${duration}`,
      color: "warning",
      ruleColor: "warning",
      rule: "━",
    };
  }
  if (durationMs < 60 * 60_000) {
    return {
      icon: "🧭",
      liveLabel: "Questing",
      completedLabel: (duration) => `Quest completed in ${duration}`,
      color: "thinkingMedium",
      ruleColor: "thinkingMedium",
      rule: "═",
    };
  }
  if (durationMs < 4 * 60 * 60_000) {
    return {
      icon: "🚀",
      liveLabel: "On an odyssey",
      completedLabel: (duration) => `Odyssey lasted ${duration}`,
      color: "thinkingHigh",
      ruleColor: "thinkingHigh",
      rule: "═",
    };
  }
  if (durationMs < 8 * 60 * 60_000) {
    return {
      icon: "🌌",
      liveLabel: "Bending spacetime",
      completedLabel: (duration) => `Bent spacetime for ${duration}`,
      color: "thinkingXhigh",
      ruleColor: "thinkingXhigh",
      rule: "━",
      ornate: true,
    };
  }
  return {
    icon: "🫠",
    liveLabel: "Lost in the sauce",
    completedLabel: (duration) => `Returned from the void after ${duration}`,
    color: "thinkingMax",
    ruleColor: "thinkingMax",
    rule: "━",
    ornate: true,
  };
}

class PromptDurationDivider implements Component {
  constructor(private readonly durationMs: number, private readonly theme: Theme) {}
  render(width: number): string[] {
    return width > 0 ? [renderDurationDivider(this.durationMs, width, this.theme)] : [];
  }
  invalidate(): void {}
}

function parseDurationData(value: unknown): PromptDurationEntryData | undefined {
  if (!value || typeof value !== "object") return undefined;
  const data = value as Partial<PromptDurationEntryData>;
  if (
    data.version !== 1 ||
    !validTimestamp(data.startedAt) ||
    !validTimestamp(data.completedAt) ||
    typeof data.durationMs !== "number" ||
    !Number.isFinite(data.durationMs) ||
    data.durationMs < 0
  ) return undefined;
  return data as PromptDurationEntryData;
}

function findPromptEntry(branch: readonly SessionEntry[], promptTimestamp: number): Extract<SessionEntry, { type: "message" }> | undefined {
  for (let index = branch.length - 1; index >= 0; index--) {
    const entry = branch[index];
    if (
      entry?.type === "message" &&
      entry.message.role === "user" &&
      entry.message.timestamp === promptTimestamp
    ) return entry;
  }
  return undefined;
}

function hasDurationEntry(branch: readonly SessionEntry[], promptEntryId: string | undefined, startedAt: number): boolean {
  return branch.some((entry) => {
    if (entry.type !== "custom" || entry.customType !== PROMPT_DURATION_ENTRY_TYPE) return false;
    const data = parseDurationData(entry.data);
    if (!data) return false;
    if (promptEntryId === undefined) return data.startedAt === startedAt;
    return data.promptEntryId === undefined ? data.startedAt === startedAt : data.promptEntryId === promptEntryId;
  });
}

function findLatestUserEntryIndex(branch: readonly SessionEntry[]): number {
  for (let index = branch.length - 1; index >= 0; index--) {
    const entry = branch[index];
    if (entry?.type === "message" && entry.message.role === "user") return index;
  }
  return -1;
}

function findCompletionTimestamp(branch: readonly SessionEntry[], startIndex: number): number | undefined {
  let completedAt: number | undefined;
  for (let index = startIndex; index < branch.length; index++) {
    const entry = branch[index];
    if (entry?.type !== "message") continue;
    if (entry.message.role !== "assistant" && entry.message.role !== "toolResult") continue;
    const timestamp = parseEntryTimestamp(entry);
    if (timestamp !== undefined) completedAt = timestamp;
  }
  return completedAt;
}

function parseEntryTimestamp(entry: { timestamp: string }): number | undefined {
  const timestamp = Date.parse(entry.timestamp);
  return validTimestamp(timestamp) ? timestamp : undefined;
}

function validTimestamp(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}
