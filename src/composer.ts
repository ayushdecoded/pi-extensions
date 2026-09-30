import { isAbsolute, relative, resolve, sep } from "node:path";
import {
  CustomEditor,
  type CustomEditorOptions,
  type ExtensionAPI,
  type ExtensionContext,
  type KeybindingsManager,
  type ModelRegistry,
  type ReadonlyFooterDataProvider,
  type SessionEntry,
  type Theme,
} from "@earendil-works/pi-coding-agent";
import {
  stripTerminalSequences,
  truncateToWidth,
  visibleWidth,
  type Component,
  type EditorTheme,
  type TUI,
} from "@earendil-works/pi-tui";
import { backgroundSubagentUsage } from "./subagents/accounting.ts";

/**
 * Native accounting contract (matches the built-in footer): every session entry that carries usage is
 * counted once. `summarizeEntries` additionally layers background subagent completion usage from
 * persisted state entries on top; `backgroundSubagentUsage` documents that narrow accounting scope.
 */
export interface UsageTotals {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cost: number;
}

export interface SessionUsageSummary {
  totals: UsageTotals;
  /** Cache hit rate of the latest assistant response, when its prompt was non-empty. */
  latestCacheHitRate: number | undefined;
}

export function emptyUsageTotals(): UsageTotals {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };
}

function addUsageToTotals(totals: UsageTotals, usage: { input: number; output: number; cacheRead: number; cacheWrite: number; cost: { total: number } }): void {
  totals.input += usage.input;
  totals.output += usage.output;
  totals.cacheRead += usage.cacheRead;
  totals.cacheWrite += usage.cacheWrite;
  totals.cost += usage.cost.total;
}

/**
 * Sum all session entries exactly like `FooterComponent.getSessionStats()`: usage entries, assistant
 * messages, tool results with usage, and compaction/branch-summary usage. Background subagent usage
 * from persisted state entries is then added on top of that native scan; the latest assistant prompt
 * (input + cacheRead + cacheWrite) alone defines the cache hit rate.
 */
export function summarizeEntries(entries: readonly SessionEntry[]): SessionUsageSummary {
  const totals = emptyUsageTotals();
  let latestCacheHitRate: number | undefined;
  for (const entry of entries) {
    if (entry.type === "usage") {
      addUsageToTotals(totals, entry.usage);
    } else if (entry.type === "message" && entry.message.role === "assistant") {
      addUsageToTotals(totals, entry.message.usage);
      const promptTokens = entry.message.usage.input + entry.message.usage.cacheRead + entry.message.usage.cacheWrite;
      latestCacheHitRate = promptTokens > 0 ? (entry.message.usage.cacheRead / promptTokens) * 100 : undefined;
    } else if (entry.type === "message" && entry.message.role === "toolResult" && entry.message.usage) {
      addUsageToTotals(totals, entry.message.usage);
    } else if ((entry.type === "branch_summary" || entry.type === "compaction") && entry.usage) {
      addUsageToTotals(totals, entry.usage);
    }
  }
  const background = backgroundSubagentUsage(entries);
  totals.input += background.input;
  totals.output += background.output;
  totals.cacheRead += background.cacheRead;
  totals.cacheWrite += background.cacheWrite;
  totals.cost += background.cost;
  return { totals, latestCacheHitRate };
}

/** Compact token counts, identical to the built-in footer formatter. */
export function formatTokens(count: number): string {
  if (count < 1000) return count.toString();
  if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
  if (count < 1000000) return `${Math.round(count / 1000)}k`;
  if (count < 10000000) return `${(count / 1000000).toFixed(1)}M`;
  return `${Math.round(count / 1000000)}M`;
}

/** Replace the home prefix with `~`, keeping the rest of the path intact. */
export function formatCwdForFooter(cwd: string, home: string | undefined): string {
  if (!home) return cwd;
  const resolvedCwd = resolve(cwd);
  const resolvedHome = resolve(home);
  const relativeToHome = relative(resolvedHome, resolvedCwd);
  const isInsideHome =
    relativeToHome === "" ||
    (relativeToHome !== ".." && !relativeToHome.startsWith(`..${sep}`) && !isAbsolute(relativeToHome));
  if (!isInsideHome) return cwd;
  return relativeToHome === "" ? "~" : `~${sep}${relativeToHome}`;
}

/** `16%/272k`, `?/272k` when the estimate is unknown, or undefined when no context window is known. */
export function formatContextLabel(
  usage: { percent: number | null; contextWindow: number } | undefined,
  modelContextWindow: number | undefined,
): string | undefined {
  const contextWindow = usage?.contextWindow ?? modelContextWindow;
  if (!contextWindow || contextWindow <= 0) return undefined;
  const percent = usage === undefined ? 0 : usage.percent;
  const percentLabel = percent === null ? "?" : `${Math.round(percent)}%`;
  return `${percentLabel}/${formatTokens(contextWindow)}`;
}

export function formatCacheHitRate(rate: number | undefined): string | undefined {
  return rate === undefined ? undefined : `CH${rate.toFixed(1)}%`;
}

/**
 * Subscription detection. Pi's built-in footer special-cases `kimi-coding` and otherwise checks the
 * provider OAuth profile via the model runtime. Extensions only receive the public `ModelRegistry`
 * facade, so this mirrors the native predicate through `getProvider()`/`isUsingOAuth()`.
 */
export function isUsingSubscription(
  model: ExtensionContext["model"],
  registry: Pick<ModelRegistry, "getProvider" | "isUsingOAuth">,
): boolean {
  if (!model) return false;
  if (model.provider === "kimi-coding") return true;
  try {
    const oauth = registry.getProvider(model.provider)?.auth?.oauth;
    return oauth?.isSubscription === true && registry.isUsingOAuth(model);
  } catch {
    return false;
  }
}

/**
 * Single-line left/right layout. The important left stats are never truncated to make room for the
 * right side: the right side is first shrunk, then dropped, before the left side is ellipsized.
 */
export function layoutFooterLine(left: string, right: string, width: number): string {
  if (width <= 0) return "";
  let leftText = left;
  let leftWidth = visibleWidth(leftText);
  if (leftWidth > width) {
    leftText = truncateToWidth(leftText, width, "...");
    leftWidth = visibleWidth(leftText);
  }
  if (!right) return leftText;
  let rightText = right;
  const minPadding = 2;
  const rightWidth = visibleWidth(rightText);
  if (leftWidth + minPadding + rightWidth <= width) {
    return leftText + " ".repeat(width - leftWidth - rightWidth) + rightText;
  }
  const availableForRight = width - leftWidth - minPadding;
  // A few clipped model-name characters are noise, not useful status.
  if (availableForRight >= 12) {
    rightText = truncateToWidth(rightText, availableForRight, "");
    const truncatedWidth = visibleWidth(rightText);
    return leftText + " ".repeat(Math.max(0, width - leftWidth - truncatedWidth)) + rightText;
  }
  return leftText;
}

/** The right side model label, including the provider only when it is ambiguous. */
export function buildFooterRight(
  model: ExtensionContext["model"],
  thinkingLevel: string | undefined,
  providerCount: number,
): { bare: string; providerPrefix: string | undefined } {
  const modelName = model?.id || "no-model";
  let right = modelName;
  if (model?.reasoning) {
    const level = thinkingLevel || "off";
    right = level === "off" ? `${modelName} • thinking off` : `${modelName} • ${level}`;
  }
  return {
    bare: right,
    providerPrefix: model && providerCount > 1 ? `(${model.provider})` : undefined,
  };
}

/** Drop the provider prefix before the model name when space is tight. */
export function selectFooterRight(
  leftWidth: number,
  width: number,
  bare: string,
  providerPrefix: string | undefined,
): string {
  if (!providerPrefix) return bare;
  const withProvider = `${providerPrefix} ${bare}`;
  return leftWidth + 2 + visibleWidth(withProvider) <= width ? withProvider : bare;
}

function homeDirectory(): string | undefined {
  return process.env.HOME || process.env.USERPROFILE;
}

/**
 * Insert a styled segment into the trailing dashes of a rendered border while preserving everything
 * before it (for example the native working/compaction/retry indicator). Falls back to the untouched
 * border when the removed tail is not plain dashes or the segment cannot fit.
 */
export function insertBorderLabel(base: string, segment: string, width: number): string {
  if (width <= 0) return base;
  const segmentWidth = visibleWidth(segment);
  if (segmentWidth <= 0 || segmentWidth > width) return base;
  const prefixWidth = width - segmentWidth;
  const plain = stripTerminalSequences(base);
  const tail = plain.slice(Math.max(0, plain.length - segmentWidth));
  if (tail.length < segmentWidth || !/^─+$/.test(tail)) return base;
  const prefix = prefixWidth > 0 ? truncateToWidth(base, prefixWidth, "") : "";
  const used = visibleWidth(prefix) + segmentWidth;
  return prefix + segment + " ".repeat(Math.max(0, width - used));
}

/**
 * Composer editor that renders context usage in the top border. Everything else (multiline editing,
 * autocomplete, paste, images, app shortcuts) is inherited untouched from `CustomEditor`; only
 * `renderTopBorder` is overridden and it always delegates to the native border first.
 */
export class ComposerEditor extends CustomEditor {
  private readonly getContext: () => ExtensionContext;

  constructor(
    tui: TUI,
    theme: EditorTheme,
    keybindings: KeybindingsManager,
    getContext: () => ExtensionContext,
    options?: CustomEditorOptions,
  ) {
    // `embedWorkingStatus` keeps the native working/compaction/retry indicator and the
    // `isWorkingStatusEditor` duck-type check in interactive mode.
    super(tui, theme, keybindings, { embedWorkingStatus: true, ...options });
    this.getContext = getContext;
  }

  protected renderTopBorder(width: number, hiddenLineCount: number): string {
    const base = super.renderTopBorder(width, hiddenLineCount);
    if (width <= 0) return base;
    let label: string | undefined;
    let theme: Theme;
    try {
      const ctx = this.getContext();
      label = formatContextLabel(ctx.getContextUsage(), ctx.model?.contextWindow);
      theme = ctx.ui.theme;
    } catch {
      return base;
    }
    if (!label) return base;
    const segment = `${this.borderColor("── ")}${theme.fg("muted", label)}${this.borderColor(" ──")}`;
    return insertBorderLabel(base, segment, width);
  }
}

interface ComposerStatsCache {
  sessionId: string;
  leafId: string | null;
  modelKey: string;
  summary: SessionUsageSummary;
}

function modelKey(ctx: ExtensionContext): string {
  return `${ctx.model?.provider ?? ""}/${ctx.model?.id ?? ""}`;
}

/**
 * The native footer caches on session/leaf/entry count because the scan is whole-session and renders
 * on every frame. Entries are append-only and appending always moves the leaf, so session + leaf +
 * model is enough to avoid a second scan on unchanged frames.
 */
export function createComposerFooter(
  context: ExtensionContext,
  tui: TUI,
  theme: Theme,
  footerData: ReadonlyFooterDataProvider,
): Component & { dispose(): void } {
  const unsubscribe = footerData.onBranchChange(() => tui.requestRender());
  let cache: ComposerStatsCache | undefined;

  const stats = (): SessionUsageSummary => {
    const sessionId = context.sessionManager.getSessionId();
    const leafId = context.sessionManager.getLeafId();
    const key = modelKey(context);
    if (cache && cache.sessionId === sessionId && cache.leafId === leafId && cache.modelKey === key) return cache.summary;
    const summary = summarizeEntries(context.sessionManager.getEntries());
    cache = { sessionId, leafId, modelKey: key, summary };
    return summary;
  };

  return {
    dispose: unsubscribe,
    invalidate() {
      // Stats are keyed by session/leaf/model, so a repaint is enough.
    },
    render(width: number): string[] {
      const summary = stats();
      const model = context.model;
      const branch = footerData.getGitBranch();
      const cwd = context.sessionManager.getCwd() || context.cwd;
      let left = formatCwdForFooter(cwd, homeDirectory());
      if (branch) left = `${left} (${branch})`;
      if (summary.totals.cacheRead > 0 || summary.totals.cacheWrite > 0) {
        const cacheLabel = formatCacheHitRate(summary.latestCacheHitRate);
        if (cacheLabel) left = `${left} ${cacheLabel}`;
      }
      const subscription = isUsingSubscription(model, context.modelRegistry);
      if (summary.totals.cost || subscription) {
        left = `${left} $${summary.totals.cost.toFixed(3)}${subscription ? " (sub)" : ""}`;
      }
      const { bare, providerPrefix } = buildFooterRight(model, context.thinkingLevel, footerData.getAvailableProviderCount());
      const right = selectFooterRight(visibleWidth(left), width, bare, providerPrefix);
      return [theme.fg("dim", layoutFooterLine(left, right, width))];
    },
  };
}

function installComposerUi(ctx: ExtensionContext): void {
  ctx.ui.setFooter((tui, theme, footerData) => createComposerFooter(ctx, tui, theme, footerData));
  ctx.ui.setEditorComponent((tui, theme, keybindings) => new ComposerEditor(tui, theme, keybindings, () => ctx));
}

function restoreComposerUi(ctx: ExtensionContext): void {
  try {
    ctx.ui.setFooter(undefined);
    ctx.ui.setEditorComponent(undefined);
  } catch {
    // UI may already be torn down during process shutdown.
  }
}

export default function composerExtension(pi: ExtensionAPI): void {
  pi.on("session_start", (_event, ctx) => {
    if (ctx.mode !== "tui") return;
    installComposerUi(ctx);
  });
  pi.on("session_shutdown", (_event, ctx) => {
    if (ctx.mode !== "tui") return;
    restoreComposerUi(ctx);
  });
}
