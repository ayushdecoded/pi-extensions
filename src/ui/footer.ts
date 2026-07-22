import type { ExtensionAPI, ExtensionContext, SessionEntry, Theme, ThemeColor } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { SubagentRuntime } from "../runtime/runtime.ts";
import { footerUsageTotals } from "./accounting.ts";

export type FooterController = {
  install(ctx: ExtensionContext, runtime: SubagentRuntime): void;
  setCodexWeeklyRemaining(remaining: number | undefined): void;
  requestRender(accountingChanged?: boolean): void;
  dispose(): void;
};

export function createFooterController(pi: ExtensionAPI): FooterController {
  let render: (() => void) | undefined;
  let invalidateAccounting: (() => void) | undefined;
  let disposeRuntime: (() => void) | undefined;
  let codexWeeklyRemaining: number | undefined;

  return {
    install(ctx, runtime) {
      disposeRuntime?.();
      disposeRuntime = undefined;
      if (ctx.mode !== "tui") return;

      ctx.ui.setFooter((tui, theme, footerData) => {
        type Accounting = ReturnType<typeof footerUsageTotals> & { cacheHit: number | undefined };
        let accounting: Accounting | undefined;
        let runtimeRevision = runtime.state.revision;
        invalidateAccounting = () => { accounting = undefined; };
        render = () => tui.requestRender();
        const stopBranch = footerData.onBranchChange(() => {
          accounting = undefined;
          render?.();
        });
        const stopRuntime = runtime.subscribe(() => {
          if (runtime.state.revision !== runtimeRevision) {
            runtimeRevision = runtime.state.revision;
            accounting = undefined;
          }
          render?.();
        });
        disposeRuntime = stopRuntime;

        return {
          invalidate() {},
          dispose() {
            stopBranch();
            stopRuntime();
            if (disposeRuntime === stopRuntime) disposeRuntime = undefined;
            render = undefined;
            invalidateAccounting = undefined;
          },
          render(width: number): string[] {
            if (!accounting) {
              const branchEntries = ctx.sessionManager.getBranch();
              const allEntries = ctx.sessionManager.getEntries();
              accounting = {
                ...footerUsageTotals(branchEntries, allEntries, runtime.state),
                cacheHit: mainSessionCacheHit(allEntries),
              };
            }
            const totals = accounting;
            const branch = footerData.getGitBranch() ?? undefined;
            const segments = {
              branch: branchLabel(branch, theme),
              context: contextLabel(ctx, theme),
              tokens: tokenLabel(totals.leaf, totals.cacheHit, theme),
              costs: costLabel(totals.leaf.cost, totals.tree.cost, theme),
            };
            const right = modelLabel(ctx, pi.getThinkingLevel(), theme, codexWeeklyRemaining);
            return [responsiveLine(segments, right, width, theme)];
          },
        };
      });
    },
    setCodexWeeklyRemaining(remaining) {
      codexWeeklyRemaining = remaining;
      render?.();
    },
    requestRender(accountingChanged = false) {
      if (accountingChanged) invalidateAccounting?.();
      render?.();
    },
    dispose() {
      disposeRuntime?.();
      disposeRuntime = undefined;
      render = undefined;
      invalidateAccounting = undefined;
    },
  };
}

function branchLabel(branch: string | undefined, theme: Theme): string {
  return branch ? `${theme.fg("dim", "")} ${theme.fg("muted", branch)}` : "";
}

function contextLabel(ctx: ExtensionContext, theme: Theme): string {
  const usage = ctx.getContextUsage();
  if (!usage) return "";
  const percent = usage.percent === null ? undefined : Math.round(usage.percent);
  const text = `${percent === undefined ? "?" : percent}%/${formatCompactNumber(usage.contextWindow)}`;
  if (percent === undefined || percent <= 65) return theme.fg("muted", text);
  return theme.fg(percent > 75 ? "error" : "warning", text);
}

export function tokenLabel(usage: { input: number; output: number }, cacheHit: number | undefined, theme: Theme): string {
  return [
    theme.fg("muted", `↑${formatCompactNumber(usage.input)}`),
    theme.fg("muted", `↓${formatCompactNumber(usage.output)}`),
    cacheHit === undefined ? "" : theme.fg("muted", `CH${cacheHit.toFixed(1)}%`),
  ].filter(Boolean).join("  ");
}

export function mainSessionCacheHit(entries: readonly SessionEntry[]): number | undefined {
  let latest: number | undefined;
  let hasCacheUsage = false;
  for (const entry of entries) {
    if (entry.type !== "message" || entry.message.role !== "assistant") continue;
    const usage = entry.message.usage;
    if (usage.cacheRead > 0 || usage.cacheWrite > 0) hasCacheUsage = true;
    const promptTokens = usage.input + usage.cacheRead + usage.cacheWrite;
    if (promptTokens > 0) latest = usage.cacheRead / promptTokens * 100;
  }
  return hasCacheUsage ? latest : undefined;
}

export function costLabel(leaf: number, tree: number, theme: Theme): string {
  return [
    theme.fg(sessionCostColor(leaf), `↳ $${formatCost(leaf)}`),
    theme.fg(sessionCostColor(tree), `◆ $${formatCost(tree)}`),
  ].join("    ");
}

export function modelLabel(ctx: ExtensionContext, thinking: string, theme: Theme, codexWeeklyRemaining?: number): string {
  const provider = shortProvider(ctx.model?.provider ?? "");
  const model = shortModel(ctx.model?.id ?? "no-model");
  const providerLabel = provider === "codex"
    ? codexProviderLabel(codexWeeklyRemaining, theme)
    : provider ? theme.fg("dim", provider) : "";
  return [
    providerLabel,
    theme.bold(theme.fg("accent", model)),
    theme.fg(thinkingColor(thinking), thinking),
  ]
    .filter(Boolean)
    .join(theme.fg("borderMuted", "  ·  "));
}

function responsiveLine(
  segments: { branch: string; context: string; tokens: string; costs: string },
  right: string,
  width: number,
  theme: Theme,
): string {
  const separator = theme.fg("borderMuted", "  ·  ");
  let leftParts = [segments.branch, segments.context, segments.tokens, segments.costs].filter(Boolean);
  let left = leftParts.join(separator);

  // Branch and then context are the least important pieces on narrow terminals.
  for (const removable of [segments.branch, segments.context]) {
    if (visibleWidth(left) + visibleWidth(right) + 1 <= width || !removable) break;
    leftParts = leftParts.filter((part) => part !== removable);
    left = leftParts.join(separator);
  }
  return fit(left, right, width);
}

function fit(left: string, right: string, width: number): string {
  if (width <= 0) return "";
  const rightWidth = visibleWidth(right);
  if (rightWidth >= width) return truncateToWidth(right, width);
  const availableLeft = Math.max(0, width - rightWidth - 1);
  const fittedLeft = truncateToWidth(left, availableLeft);
  const padding = " ".repeat(Math.max(1, width - visibleWidth(fittedLeft) - rightWidth));
  return truncateToWidth(fittedLeft + padding + right, width);
}

function formatCompactNumber(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return "0";
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}k`;
  return String(Math.round(value));
}

function formatCost(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return "0.00";
  if (value >= 100) return value.toFixed(0);
  if (value >= 10) return value.toFixed(1);
  return value.toFixed(2);
}

export function sessionCostColor(value: number): "success" | "warning" | "error" | "muted" {
  if (value > 50) return "muted";
  if (value >= 25) return "error";
  if (value >= 15) return "warning";
  return "success";
}

function thinkingColor(thinking: string): ThemeColor {
  const key = thinking.toLowerCase();
  const colors: Record<string, ThemeColor> = {
    off: "thinkingOff", minimal: "thinkingMinimal", low: "thinkingLow", medium: "thinkingMedium",
    high: "thinkingHigh", xhigh: "thinkingXhigh", max: "thinkingMax",
  };
  return colors[key] ?? "muted";
}

function codexProviderLabel(remaining: number | undefined, theme: Theme): string {
  const text = `codex [${remaining === undefined ? "?" : `${Math.round(remaining)}%`}]`;
  if (remaining === undefined) return theme.fg("dim", text);
  if (remaining >= 60) return theme.fg("success", text);
  if (remaining >= 40) return theme.fg("warning", text);
  if (remaining >= 20) return `\x1b[38;5;208m${text}\x1b[39m`;
  return theme.fg("error", text);
}

function shortProvider(provider: string): string {
  return provider.replace(/^openai-codex$/, "codex").replace(/^openrouter$/, "or").replace(/^anthropic$/, "anth");
}

function shortModel(model: string): string {
  return model.replace(/-latest$/, "").replace(/-preview$/, "");
}
