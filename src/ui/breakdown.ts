import type { ExtensionAPI, ExtensionContext, KeybindingsManager, SessionEntry, Theme, ThemeColor } from "@earendil-works/pi-coding-agent";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { isKeyRelease, matchesKey, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { Component, TUI } from "@earendil-works/pi-tui";
import { canonicalProviderId } from "../accounts/providers.ts";
import { replayRuntimeState } from "../runtime/state.ts";
import { costColor } from "./panel.ts";

export const BREAKDOWN_MESSAGE_TYPE = "pi-subagents-breakdown";

/** Aggregated usage for one provider/model across a set of session entries. */
export type ModelShare = {
  provider: string;
  model: string;
  /** Assistant messages attributed to this model. */
  calls: number;
  /** input + output + cacheRead + cacheWrite. */
  tokens: number;
  input: number;
  output: number;
  /** cacheRead + cacheWrite. */
  cache: number;
  cost: number;
};

export type BreakdownRow = ModelShare & {
  /** Percent of total session cost, 0-100. */
  costShare: number;
  /** Percent of total session tokens, 0-100. */
  tokenShare: number;
};

export type BreakdownDetails = {
  rows: BreakdownRow[];
  totals: { calls: number; tokens: number; input: number; output: number; cache: number; cost: number };
};

const BAR_WIDTH = 30;

/**
 * Sum assistant-message usage per model. Only assistant messages carry a
 * provider/model; compaction and tool-result usage are intentionally excluded,
 * matching the footer's session-usage accounting.
 */
export function collectModelShares(entries: readonly SessionEntry[]): Map<string, ModelShare> {
  const shares = new Map<string, ModelShare>();
  for (const entry of entries) {
    if (entry.type !== "message" || entry.message.role !== "assistant") continue;
    const usage = entry.message.usage;
    if (!usage) continue;
    const provider = canonicalProviderId(entry.message.provider ?? "");
    const model = entry.message.model || "unknown";
    const key = `${provider}/${model}`;
    let share = shares.get(key);
    if (!share) {
      share = { provider, model, calls: 0, tokens: 0, input: 0, output: 0, cache: 0, cost: 0 };
      shares.set(key, share);
    }
    const tokens = usage.input + usage.output + usage.cacheRead + usage.cacheWrite;
    share.calls += 1;
    share.tokens += tokens;
    share.input += usage.input;
    share.output += usage.output;
    share.cache += usage.cacheRead + usage.cacheWrite;
    share.cost += usage.cost?.total ?? 0;
  }
  return shares;
}

/** Combine several per-source share maps into one, summing overlapping models. */
export function mergeModelShares(...maps: ReadonlyArray<Map<string, ModelShare>>): Map<string, ModelShare> {
  const merged = new Map<string, ModelShare>();
  for (const map of maps) {
    for (const [key, share] of map) {
      const existing = merged.get(key);
      if (!existing) {
        merged.set(key, { ...share });
        continue;
      }
      existing.calls += share.calls;
      existing.tokens += share.tokens;
      existing.input += share.input;
      existing.output += share.output;
      existing.cache += share.cache;
      existing.cost += share.cost;
    }
  }
  return merged;
}

/** Sort shares by cost (then tokens) and compute totals plus per-model shares. */
export function buildBreakdownDetails(shares: ReadonlyMap<string, ModelShare>): BreakdownDetails {
  const rows = [...shares.values()].sort((left, right) =>
    right.cost !== left.cost ? right.cost - left.cost : right.tokens - left.tokens,
  );
  const totals = { calls: 0, tokens: 0, input: 0, output: 0, cache: 0, cost: 0 };
  for (const row of rows) {
    totals.calls += row.calls;
    totals.tokens += row.tokens;
    totals.input += row.input;
    totals.output += row.output;
    totals.cache += row.cache;
    totals.cost += row.cost;
  }
  const detailed: BreakdownRow[] = rows.map((row) => ({
    ...row,
    costShare: totals.cost > 0 ? (row.cost / totals.cost) * 100 : 0,
    tokenShare: totals.tokens > 0 ? (row.tokens / totals.tokens) * 100 : 0,
  }));
  return { rows: detailed, totals };
}

/** Sum usage from every persisted subagent session file reachable from the entries. */
export function collectChildSessionShares(entries: readonly SessionEntry[], ctx: Pick<ExtensionContext, "cwd">): Map<string, ModelShare> {
  let merged = new Map<string, ModelShare>();
  const seen = new Set<string>();
  for (const agent of replayRuntimeState(entries).agents.values()) {
    if (seen.has(agent.sessionFile)) continue;
    seen.add(agent.sessionFile);
    try {
      const manager = SessionManager.open(agent.sessionFile, undefined, ctx.cwd);
      merged = mergeModelShares(merged, collectModelShares(manager.getEntries()));
    } catch {
      // The child session may have been cleaned up; its recorded usage is gone.
    }
  }
  return merged;
}

/**
 * `/breakdown` pane: per-model cost and token shares as aligned ASCII bars.
 * Opens as a full-height overlay in TUI mode; non-TUI modes get the same chart
 * as a plain-text transcript message.
 */
export function registerBreakdownCommand(pi: ExtensionAPI): void {
  pi.registerCommand("breakdown", {
    description: "Show per-model cost and token shares for this session",
    handler: async (_args, ctx) => {
      const entries = ctx.sessionManager.getEntries();
      const details = buildBreakdownDetails(
        mergeModelShares(collectModelShares(entries), collectChildSessionShares(entries, ctx)),
      );
      if (details.rows.length === 0) {
        ctx.ui.notify("No model usage recorded for this session yet.", "info");
        return;
      }
      if (ctx.mode === "tui") {
        await ctx.ui.custom<void>(
          (tui, theme, keybindings, done) => new BreakdownPanel(details, tui, theme, keybindings, done),
          { overlay: true, overlayOptions: { anchor: "top-left", width: "100%", maxHeight: "100%" } },
        );
        return;
      }
      pi.sendMessage<BreakdownDetails>(
        { customType: BREAKDOWN_MESSAGE_TYPE, content: formatBreakdownContent(details), display: true, details },
        { triggerTurn: false },
      );
    },
  });
}

/** Read-only scrollable pane rendering the model breakdown. */
export class BreakdownPanel implements Component {
  private scroll = 0;

  constructor(
    private readonly details: BreakdownDetails,
    private readonly tui: TUI,
    private readonly theme: Theme,
    private readonly keybindings: KeybindingsManager,
    private readonly done: () => void,
  ) {}

  handleInput(data: string): void {
    if (isKeyRelease(data)) return;
    if (this.keybindings.matches(data, "tui.select.cancel") || matchesKey(data, "escape") || matchesKey(data, "ctrl+c")) {
      this.done();
      return;
    }
    const bodyHeight = this.bodyHeight();
    const lineCount = this.lines().length;
    const maxScroll = Math.max(0, lineCount - bodyHeight);
    const page = Math.max(1, this.tui.terminal.rows - 8);
    if (this.keybindings.matches(data, "tui.select.up") || data === "k") this.scroll = Math.max(0, this.scroll - 1);
    else if (this.keybindings.matches(data, "tui.select.down") || data === "j") this.scroll = Math.min(maxScroll, this.scroll + 1);
    else if (this.keybindings.matches(data, "tui.select.pageUp")) this.scroll = Math.max(0, this.scroll - page);
    else if (this.keybindings.matches(data, "tui.select.pageDown")) this.scroll = Math.min(maxScroll, this.scroll + page);
    else if (matchesKey(data, "home")) this.scroll = 0;
    else if (matchesKey(data, "end")) this.scroll = maxScroll;
    this.tui.requestRender();
  }

  render(width: number): string[] {
    const height = Math.max(8, this.tui.terminal.rows - 2);
    const safeWidth = Math.max(1, width);
    const header = this.renderHeader(safeWidth);
    const footer = this.renderFooter(safeWidth);
    const all = this.lines();
    const bodyHeight = this.bodyHeight();
    const maxScroll = Math.max(0, all.length - bodyHeight);
    this.scroll = Math.min(this.scroll, maxScroll);
    const body = all.slice(this.scroll, this.scroll + bodyHeight);
    const lines = [...header, ...body.map((line) => truncateToWidth(line, safeWidth, ""))];
    while (lines.length < height - 1) lines.push("");
    lines.push(footer);
    return lines.map((line) => (visibleWidth(line) <= safeWidth ? line : truncateToWidth(line, safeWidth)));
  }

  invalidate(): void {}

  dispose(): void {}

  private renderHeader(width: number): string[] {
    const totals = this.details.totals;
    const title = `${this.theme.fg("accent", "Cost & tokens by model")} ${this.theme.fg("dim", "· whole session")}`;
    const right = `${this.theme.fg("muted", `${compactTokens(totals.tokens)} tokens`)} ${this.theme.fg("dim", "·")} ${this.theme.fg(sessionCostColor(totals.cost), formatCost(totals.cost))}`;
    return [
      `  ${joinSides(title, right, Math.max(0, width - 4))}  `,
      this.theme.fg("borderMuted", `  ${"─".repeat(Math.max(1, width - 4))}  `),
      "",
    ];
  }

  private renderFooter(width: number): string {
    const total = this.details.totals;
    const hint = this.theme.fg("dim", "↑↓ scroll · Esc close");
    const right = `${this.theme.fg("muted", "TOTAL")} ${plural(total.calls, "call")} · ${this.theme.fg("text", `${compactTokens(total.tokens)} tokens`)} · ${this.theme.fg("muted", formatCost(total.cost))}`;
    return `  ${joinSides(hint, right, Math.max(0, width - 4))}  `;
  }

  /** One blank-separated block of lines per model, in render order. */
  private lines(): string[] {
    const lines: string[] = [];
    for (const [index, row] of this.details.rows.entries()) {
      if (index > 0) lines.push("");
      lines.push(...this.modelBlock(row, index + 1));
    }
    return lines;
  }

  private modelBlock(row: BreakdownRow, rank: number): string[] {
    const theme = this.theme;
    const model = `${theme.fg("dim", `${row.provider}/`)}${theme.bold(theme.fg("accent", row.model))}`;
    const header = `  ${theme.fg("dim", `${rank}.`)}  ${padRight(model, 38)}${theme.fg("dim", `· ${plural(row.calls, "call")}`)}`;
    return [
      header,
      this.metricLine("cost", bar(row.costShare, costColor(row.cost), "dim", theme), theme.fg(costColor(row.cost), formatCost(row.cost)), row.costShare, ""),
      this.metricLine("tokens", bar(row.tokenShare, "accent", "dim", theme), theme.fg("text", compactTokens(row.tokens)), row.tokenShare, `${theme.fg("dim", `↑${compactTokens(row.input)} ↓${compactTokens(row.output)} ⚡${compactTokens(row.cache)}`)}`),
    ];
  }

  private metricLine(label: string, barText: string, value: string, share: number, trailing: string): string {
    const theme = this.theme;
    const labelText = theme.fg("muted", padRight(label, 7));
    const pct = theme.fg("dim", padLeft(`${share.toFixed(1)}%`, 6));
    const base = `  ${labelText}  ${barText}  ${padLeft(value, 9)}  ${pct}`;
    return trailing ? `${base}   ${trailing}` : base;
  }

  private bodyHeight(): number {
    const height = Math.max(8, this.tui.terminal.rows - 2);
    return Math.max(1, height - 4);
  }
}

/** Plain-text ASCII chart used as the non-TUI fallback message content. */
export function formatBreakdownContent(details: BreakdownDetails): string {
  const lines: string[] = [];
  lines.push("Cost & tokens by model · whole session");
  lines.push("─".repeat(64));
  for (const [index, row] of details.rows.entries()) {
    lines.push(`${index + 1}. ${row.provider}/${row.model} ${" ".repeat(Math.max(1, 34 - visibleWidth(`${row.provider}/${row.model}`)))}· ${plural(row.calls, "call")}`);
    lines.push(`   cost    ${asciiBar(row.costShare)}  ${padLeft(formatCost(row.cost), 9)}  ${padLeft(`${row.costShare.toFixed(1)}%`, 6)}`);
    lines.push(
      `   tokens  ${asciiBar(row.tokenShare)}  ${padLeft(compactTokens(row.tokens), 9)}  ${padLeft(`${row.tokenShare.toFixed(1)}%`, 6)}   ↑${compactTokens(row.input)} ↓${compactTokens(row.output)} ⚡${compactTokens(row.cache)}`,
    );
  }
  lines.push("─".repeat(64));
  lines.push(
    `total    ${padLeft(compactTokens(details.totals.tokens), 9)}  ${padLeft(formatCost(details.totals.cost), 9)}   ${plural(details.totals.calls, "call")}`,
  );
  return lines.join("\n");
}

function bar(share: number, fill: ThemeColor, empty: ThemeColor, theme: Theme): string {
  const filled = Math.round((share / 100) * BAR_WIDTH);
  return theme.fg(fill, "█".repeat(filled)) + theme.fg(empty, "░".repeat(BAR_WIDTH - filled));
}

function asciiBar(share: number): string {
  const filled = Math.round((share / 100) * BAR_WIDTH);
  return "█".repeat(filled) + "░".repeat(BAR_WIDTH - filled);
}

function compactTokens(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return "0";
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}k`;
  return String(Math.round(value));
}

function formatCost(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return "$0.00";
  if (value >= 100) return `$${value.toFixed(0)}`;
  if (value >= 10) return `$${value.toFixed(1)}`;
  return `$${value.toFixed(2)}`;
}

function sessionCostColor(value: number): ThemeColor {
  return value < 2 ? "success" : value < 7 ? "warning" : "error";
}

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

function padLeft(value: string, width: number): string {
  return " ".repeat(Math.max(0, width - visibleWidth(value))) + value;
}

function padRight(value: string, width: number): string {
  const clipped = truncateToWidth(value, Math.max(0, width), "");
  return clipped + " ".repeat(Math.max(0, width - visibleWidth(clipped)));
}

function joinSides(left: string, right: string, width: number): string {
  const safeWidth = Math.max(0, width);
  if (!right) return truncateToWidth(left, safeWidth, "");
  const gap = safeWidth - visibleWidth(left) - visibleWidth(right);
  return gap >= 2 ? `${left}${" ".repeat(gap)}${right}` : truncateToWidth(left, safeWidth, "");
}
