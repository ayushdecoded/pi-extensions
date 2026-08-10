/**
 * Provider-first account switch overlay.
 *
 * Two-stage selection: pick a provider, then pick one of its accounts or
 * "Add account". Escape on the account stage returns to the provider stage;
 * Escape on the provider stage cancels. The overlay is compact (around
 * {@link PANEL_WIDTH} columns) and height-bounded, and the terminal/overlay
 * clamp it on narrow terminals.
 *
 * The panel only selects: it performs no mutations, logins, input dialogs, or
 * commands. Pure projection/formatting helpers are exported so rendering and
 * navigation can be tested deterministically without a live TUI.
 */
import type { ExtensionContext, KeybindingsManager, Theme } from "@earendil-works/pi-coding-agent";
import type { Component, TUI } from "@earendil-works/pi-tui";
import { isKeyRelease, Key, matchesKey, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

/** One account in the projection passed to {@link showAccountSwitch}. */
export interface AccountSwitchAccount {
  id: string;
  name: string;
  selected: boolean;
  authenticated: boolean;
  exhausted: boolean;
  /** ISO timestamp of the next quota reset; when absent the row omits reset text. */
  resetAt?: string;
}

/** One provider in the projection passed to {@link showAccountSwitch}. */
export interface AccountSwitchProvider {
  id: string;
  label: string;
  accounts: AccountSwitchAccount[];
}

/** Result of a completed switch interaction. */
export type AccountSwitchResult =
  | { type: "select"; provider: string; accountId: string }
  | { type: "add"; provider: string }
  | undefined;

/** Options accepted by {@link showAccountSwitch} (deterministic in tests). */
export interface AccountSwitchOptions {
  /** Current-time source used for reset formatting. Defaults to `new Date`. */
  now?: () => Date;
  /** Intl locale for reset formatting. Defaults to the system locale. */
  locale?: string;
  /** IANA timezone for reset formatting. Defaults to the system timezone. */
  timeZone?: string;
}

/** Compact overlay width in columns; overlays clamp it on narrow terminals. */
export const PANEL_WIDTH = 76;

/** Pure projection of one account row, without theme/ANSI. */
export interface AccountRowView {
  id: string;
  name: string;
  /** Status words: any subset of "selected", "login required", "exhausted". */
  statuses: string[];
  /** `resets <local time>` when resetAt is present and parseable, else "". */
  reset: string;
}

/** Pure projection of one provider row, without theme/ANSI. */
export interface ProviderRowView {
  id: string;
  label: string;
  accountCount: number;
  accountLabel: string;
}

/**
 * Format an ISO reset timestamp as a local date/time. Same calendar day as
 * `now` yields time only; other days yield a short date plus time. Invalid
 * timestamps return "".
 */
export function formatResetTime(resetAt: string, now: Date = new Date(), locale?: string, timeZone?: string): string {
  const date = new Date(resetAt);
  if (Number.isNaN(date.getTime())) return "";
  const sameDay =
    date.getFullYear() === now.getFullYear()
    && date.getMonth() === now.getMonth()
    && date.getDate() === now.getDate();
  return new Intl.DateTimeFormat(locale, sameDay
    ? { hour: "numeric", minute: "2-digit", ...(timeZone ? { timeZone } : {}) }
    : { month: "short", day: "numeric", hour: "numeric", minute: "2-digit", ...(timeZone ? { timeZone } : {}) }).format(date);
}

/**
 * The `resets <formatted local date/time>` suffix appended to an account row.
 * Returns "" unless resetAt exists and formats successfully.
 */
export function resetText(resetAt: string | undefined, now: Date = new Date(), locale?: string, timeZone?: string): string {
  if (!resetAt) return "";
  const formatted = formatResetTime(resetAt, now, locale, timeZone);
  return formatted ? `resets ${formatted}` : "";
}

/**
 * Status words shown on an account row: "selected", "login required" for
 * unauthenticated accounts, and "exhausted". Never invents placeholders such
 * as "unavailable" or "cooling".
 */
export function accountStatusTokens(
  account: Pick<AccountSwitchAccount, "selected" | "authenticated" | "exhausted">,
): string[] {
  const tokens: string[] = [];
  if (account.selected) tokens.push("selected");
  if (!account.authenticated) tokens.push("login required");
  if (account.exhausted) tokens.push("exhausted");
  return tokens;
}

/** Singular/plural account count label, e.g. "1 account", "3 accounts". */
export function accountCountLabel(count: number): string {
  return `${count} ${count === 1 ? "account" : "accounts"}`;
}

/** Pure row projection for one provider's account list. */
export function projectAccountRows(
  provider: AccountSwitchProvider,
  now: Date = new Date(),
  locale?: string,
  timeZone?: string,
): AccountRowView[] {
  return provider.accounts.map((account) => ({
    id: account.id,
    name: account.name,
    statuses: accountStatusTokens(account),
    reset: resetText(account.resetAt, now, locale, timeZone),
  }));
}

/** Pure row projection for the provider list. */
export function projectProviderRows(providers: AccountSwitchProvider[]): ProviderRowView[] {
  return providers.map((provider) => ({
    id: provider.id,
    label: provider.label,
    accountCount: provider.accounts.length,
    accountLabel: accountCountLabel(provider.accounts.length),
  }));
}

type Stage = "providers" | "accounts";
type RowItem =
  | { kind: "provider"; provider: AccountSwitchProvider }
  | { kind: "account"; provider: AccountSwitchProvider; account: AccountSwitchAccount }
  | { kind: "add"; provider: AccountSwitchProvider };
type RowView = ProviderRowView | AccountRowView;

/**
 * Overlay component backing {@link showAccountSwitch}. Exported so navigation
 * and rendering can be driven deterministically in tests.
 */
export class AccountSwitchPanel implements Component {
  private stage: Stage = "providers";
  private selectedProvider?: AccountSwitchProvider;
  private index = 0;
  private readonly now: () => Date;
  private readonly locale?: string;
  private readonly timeZone?: string;

  constructor(
    private readonly providers: AccountSwitchProvider[],
    private readonly tui: TUI,
    private readonly theme: Theme,
    private readonly keybindings: KeybindingsManager,
    private readonly done: (result: AccountSwitchResult) => void,
    options: AccountSwitchOptions = {},
  ) {
    this.now = options.now ?? (() => new Date());
    this.locale = options.locale;
    this.timeZone = options.timeZone;
  }

  handleInput(data: string): void {
    if (isKeyRelease(data)) return;
    if (
      this.keybindings.matches(data, "tui.select.cancel")
      || matchesKey(data, Key.escape)
      || matchesKey(data, Key.ctrl("c"))
    ) {
      if (this.stage === "accounts") {
        this.stage = "providers";
        this.selectedProvider = undefined;
        this.index = 0;
      } else {
        this.done(undefined);
        return;
      }
      this.tui.requestRender();
      return;
    }

    const count = this.currentItems().length;
    if (count === 0) {
      if (this.keybindings.matches(data, "tui.select.confirm") || matchesKey(data, Key.enter)) this.done(undefined);
      return;
    }
    if (this.keybindings.matches(data, "tui.select.up")) {
      this.index = this.index === 0 ? count - 1 : this.index - 1;
    } else if (this.keybindings.matches(data, "tui.select.down")) {
      this.index = this.index === count - 1 ? 0 : this.index + 1;
    } else if (this.keybindings.matches(data, "tui.select.pageUp")) {
      this.index = 0;
    } else if (this.keybindings.matches(data, "tui.select.pageDown")) {
      this.index = count - 1;
    } else if (this.keybindings.matches(data, "tui.select.confirm") || matchesKey(data, Key.enter)) {
      this.confirm();
      return;
    } else {
      return;
    }
    this.tui.requestRender();
  }

  render(width: number): string[] {
    const panelWidth = Math.max(1, Math.min(width, PANEL_WIDTH));
    const innerWidth = Math.max(1, panelWidth - 2);
    const items = this.currentItems();
    const views = this.currentRowViews();
    const bodyHeight = this.bodyHeight();
    const start = windowStart(this.index, items.length, bodyHeight);
    const lines: string[] = [];

    const count = this.stage === "providers" ? this.providers.length : this.selectedProvider?.accounts.length ?? 0;
    const noun = this.stage === "providers" ? "provider" : "account";
    lines.push(joinSides(this.theme.fg("accent", "Switch account"), this.theme.fg("dim", `${count} ${noun}${count === 1 ? "" : "s"}`), panelWidth));

    const title = this.stage === "providers" ? "providers" : `accounts · ${this.selectedProvider?.label ?? "provider"}`;
    lines.push(this.frameTop(title, innerWidth));

    for (let i = start; i < Math.min(items.length, start + bodyHeight); i++) {
      lines.push(`${this.theme.fg("border", "│")}${padLine(this.renderRow(items[i]!, views[i], i === this.index, innerWidth), innerWidth)}${this.theme.fg("border", "│")}`);
    }
    while (lines.length < bodyHeight + 2) {
      lines.push(`${this.theme.fg("border", "│")}${" ".repeat(innerWidth)}${this.theme.fg("border", "│")}`);
    }
    lines.push(this.frameBottom(innerWidth));
    lines.push(`  ${this.theme.fg("dim", this.stage === "accounts" ? "↑↓ select · ↵ confirm · esc back" : "↑↓ select · ↵ confirm · esc cancel")}`);
    return constrain(lines, panelWidth);
  }

  invalidate(): void {
    // No cached rendering state.
  }

  private currentItems(): RowItem[] {
    if (this.stage === "providers") {
      return this.providers.map((provider) => ({ kind: "provider", provider }) as const);
    }
    const provider = this.selectedProvider;
    if (!provider) return [];
    return [
      ...provider.accounts.map((account) => ({ kind: "account", provider, account }) as const),
      { kind: "add", provider },
    ];
  }

  private currentRowViews(): Array<RowView | undefined> {
    if (this.stage === "providers") return projectProviderRows(this.providers);
    const provider = this.selectedProvider;
    if (!provider) return [];
    return [...projectAccountRows(provider, this.now(), this.locale, this.timeZone), undefined];
  }

  private confirm(): void {
    const items = this.currentItems();
    const item = items[this.index];
    if (!item) return;
    if (item.kind === "provider") {
      this.stage = "accounts";
      this.selectedProvider = item.provider;
      this.index = initialAccountIndex(item.provider);
      this.tui.requestRender();
      return;
    }
    const provider = this.selectedProvider;
    if (!provider) return;
    if (item.kind === "add") {
      this.done({ type: "add", provider: provider.id });
      return;
    }
    this.done({ type: "select", provider: provider.id, accountId: item.account.id });
  }

  private renderRow(item: RowItem, view: RowView | undefined, isSelected: boolean, width: number): string {
    const cursor = isSelected ? this.theme.fg("accent", "→") : " ";
    const lead = `${cursor} `;
    if (item.kind === "provider" && view) {
      const row = view as ProviderRowView;
      const label = truncateToWidth(this.theme.fg("text", row.label), Math.max(4, width - visibleWidth(row.accountLabel) - 6));
      return layoutRow(`${lead}${label}`, this.theme.fg("dim", row.accountLabel), width);
    }
    if (item.kind === "account" && view) {
      const row = view as AccountRowView;
      const name = truncateToWidth(this.theme.fg("text", row.name), Math.max(4, width - 16));
      const parts = accountRowStatuses(row, this.theme);
      return layoutRow(`${lead}${name}`, parts.length ? parts.join(this.theme.fg("dim", " · ")) : "", width);
    }
    if (item.kind === "add") {
      return `${lead}${this.theme.fg("accent", "+")} ${this.theme.fg("text", "Add account")}`;
    }
    return lead;
  }

  private frameTop(title: string, innerWidth: number): string {
    const border = this.theme.fg("border", "─");
    if (innerWidth < 4) {
      return `${this.theme.fg("border", "╭")}${border.repeat(Math.max(0, innerWidth))}${this.theme.fg("border", "╮")}`;
    }
    const content = ` ${truncateToWidth(title, Math.max(1, innerWidth - 3), "…")} `;
    const remaining = Math.max(0, innerWidth - visibleWidth(content));
    const left = Math.floor(remaining / 2);
    const right = remaining - left;
    return `${this.theme.fg("border", "╭")}${border.repeat(left)}${this.theme.fg("text", content)}${border.repeat(right)}${this.theme.fg("border", "╮")}`;
  }

  private frameBottom(innerWidth: number): string {
    return `${this.theme.fg("border", "╰")}${this.theme.fg("border", "─").repeat(innerWidth)}${this.theme.fg("border", "╯")}`;
  }

  private bodyHeight(): number {
    return Math.max(3, Math.min(8, this.tui.terminal.rows - 6));
  }
}

/**
 * Show the provider-first account switch overlay. Returns the chosen action,
 * or undefined when cancelled or when no providers exist / TUI is unavailable.
 */
export async function showAccountSwitch(
  ctx: ExtensionContext,
  providers: AccountSwitchProvider[],
  options: AccountSwitchOptions = {},
): Promise<AccountSwitchResult> {
  if (ctx.mode !== "tui" || providers.length === 0) return undefined;
  return ctx.ui.custom<AccountSwitchResult>(
    (tui, theme, keybindings, done) =>
      new AccountSwitchPanel(providers, tui, theme, keybindings, done, options),
    {
      overlay: true,
      overlayOptions: {
        width: PANEL_WIDTH,
        minWidth: 24,
        maxHeight: "75%",
        anchor: "center",
        margin: 1,
      },
    },
  );
}

/** Index of the currently-selected account in the accounts stage list. */
function initialAccountIndex(provider: AccountSwitchProvider): number {
  const index = provider.accounts.findIndex((account) => account.selected);
  return index >= 0 ? index : 0;
}

/** Status + reset cluster for an account row, colored by state. */
function accountRowStatuses(row: AccountRowView, theme: Theme): string[] {
  const parts: string[] = [];
  for (const token of row.statuses) {
    const color = token === "selected" ? "accent" : token === "exhausted" ? "error" : "warning";
    parts.push(theme.fg(color, token));
  }
  if (row.reset) parts.push(theme.fg("dim", row.reset));
  return parts;
}

/** Lay out left content with a right-aligned suffix inside `width`. */
function layoutRow(left: string, right: string, width: number): string {
  if (!right) return truncateToWidth(left, Math.max(0, width));
  const leftWidth = visibleWidth(left);
  const rightWidth = visibleWidth(right);
  const gap = width - leftWidth - rightWidth;
  if (gap >= 1) return `${left}${" ".repeat(gap)}${right}`;
  // Tight fit: keep a minimal name and truncate the status cluster instead.
  const nameWidth = Math.min(10, leftWidth);
  const rightBudget = width - nameWidth - 1;
  if (rightBudget < 4) return truncateToWidth(left, Math.max(0, width));
  return `${truncateToWidth(left, nameWidth)} ${truncateToWidth(right, rightBudget, "…")}`;
}

function padLine(value: string, width: number): string {
  const clipped = truncateToWidth(value, Math.max(0, width), "");
  return clipped + " ".repeat(Math.max(0, width - visibleWidth(clipped)));
}

function joinSides(left: string, right: string, width: number): string {
  if (!right) return truncateToWidth(left, Math.max(0, width), "");
  const gap = width - visibleWidth(left) - visibleWidth(right);
  return gap >= 2 ? `${left}${" ".repeat(gap)}${right}` : truncateToWidth(left, Math.max(0, width), "");
}

function windowStart(index: number, total: number, room: number): number {
  return Math.max(0, Math.min(index - Math.floor(room / 2), Math.max(0, total - room)));
}

function constrain(lines: string[], width: number): string[] {
  return lines.map((line) => (visibleWidth(line) <= width ? line : truncateToWidth(line, width)));
}
