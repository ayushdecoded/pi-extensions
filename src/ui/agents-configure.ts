import type { KeybindingsManager, Theme } from "@earendil-works/pi-coding-agent";
import type { Component, TUI } from "@earendil-works/pi-tui";
import { isKeyRelease, Key, matchesKey, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { THINKING_LEVELS, type ThinkingLevel } from "../config/agents.ts";

export type AgentConfigureScope = "session" | "project" | "global";
const SCOPES: readonly AgentConfigureScope[] = ["session", "project", "global"];

/** Display state for one role. The host owns this data; the panel only renders it. */
export type AgentRoleConfigState = {
  name: string;
  /** Session-only enablement: disabled roles block future dispatch; running roles finish. */
  enabled: boolean;
  /** Effective model/thinking (persisted defaults plus overrides, resolved by the host). */
  model: string;
  thinking: string;
  /** Persisted baseline; fields that differ from it offer an explicit reset row. */
  configuredModel: string;
  configuredThinking: string;
};

export type AgentModelChoice = {
  provider: string;
  providerLabel: string;
  id: string;
  name: string;
  /** False when the provider has no configured credentials; the model still shows, marked. */
  available?: boolean;
};

export type AgentModelConfigureInput = {
  /** Active preset name. Shown in the header; persistence is scoped to it. */
  mode?: string;
  scope?: AgentConfigureScope;
  roles: AgentRoleConfigState[];
  scopedModels: AgentModelChoice[];
  allModels: AgentModelChoice[];
};

/** One confirmed edit. The host persists it and answers the next `refresh()`. */
export type AgentRoleConfigureChange =
  | { kind: "enabled"; enabled: boolean }
  | { kind: "model"; model: string }
  | { kind: "thinking"; thinking: ThinkingLevel }
  | { kind: "reset-model" }
  | { kind: "reset-thinking" };

/** Outcome of a host action. A non-empty `error` stays visible in the panel. */
export type AgentConfigureResult = { error?: string };

/**
 * Typed callback contract between the panel and the host.
 * The host owns all configuration state: the panel never keeps a local copy,
 * it calls `refresh()` after every applied change, save, or reload.
 */
export type AgentConfigureCallbacks = {
  /** Current configuration state; consulted after every successful action. */
  refresh: () => AgentModelConfigureInput;
  /** Apply one confirmed edit. Return `{ error }` to surface a visible failure; state stays host-owned. */
  onChange: (role: string, change: AgentRoleConfigureChange) => AgentConfigureResult | void | Promise<AgentConfigureResult | void>;
  /** The user switched the scope the panel edits and saves into. */
  onScopeChange?: (scope: AgentConfigureScope) => void;
  /** Explicit "save as defaults" for every role at the given scope. */
  onSaveDefaults?: (scope: AgentConfigureScope) => AgentConfigureResult | void | Promise<AgentConfigureResult | void>;
  /** Re-read agents.yaml plus model overrides. Errors are displayed; the prior state is kept. */
  onReload?: () => AgentConfigureResult | void | Promise<AgentConfigureResult | void>;
};

type RolesItem = { kind: "role"; role: AgentRoleConfigState } | { kind: "save" } | { kind: "reload" };
type SettingsItem =
  | { kind: "enabled" }
  | { kind: "model" }
  | { kind: "thinking" }
  | { kind: "reset-model" }
  | { kind: "reset-thinking" }
  | { kind: "back" };
type PickerItem = { kind: "pick-model"; choice: AgentModelChoice } | { kind: "pick-thinking"; level: ThinkingLevel };
type Item = RolesItem | SettingsItem | PickerItem;
type Region = "roles" | "settings" | "picker";

const MAX_PANEL_WIDTH = 104;
/** Two-pane (role list beside settings) needs at least this much width; below it the panel drills down. */
const WIDE_MIN_WIDTH = 96;
const ROW_PAD = 2;

/**
 * Role list plus a focused settings pane. On wide terminals both are visible at
 * once (Tab moves between them); on narrow terminals the panel drills down with
 * Escape walking back. Model/thinking picks and the explicit reload flow all
 * re-read host state via `callbacks.refresh()`, so the panel never edits from a
 * stale construction snapshot.
 */
export class AgentModelConfigurePanel implements Component {
  private input: AgentModelConfigureInput;
  private scope: AgentConfigureScope;
  private stage: "roles" | "settings" = "roles";
  private focus: Region = "roles";
  private role?: string;
  private picker: "model" | "thinking" | undefined;
  private rolesIndex = 0;
  private settingsIndex = 0;
  private pickerIndex = 0;
  private search = "";
  private all = false;
  private error?: string;
  private pending = false;
  private finished = false;
  private lastWidth = 0;

  constructor(
    input: AgentModelConfigureInput,
    private readonly tui: TUI,
    private readonly theme: Theme,
    private readonly keybindings: KeybindingsManager,
    private readonly callbacks: AgentConfigureCallbacks,
    private readonly done: () => void,
  ) {
    this.input = input;
    this.scope = input.scope ?? "session";
  }

  handleInput(data: string): void {
    if (isKeyRelease(data) || this.pending) return;
    if (matchesKey(data, Key.ctrl("s")) || matchesKey(data, Key.left) || matchesKey(data, Key.right)) {
      this.cycleScope(matchesKey(data, Key.left) ? -1 : 1);
      return;
    }
    const wide = this.isWide();
    const region = this.region();
    if (this.cancelled(data)) {
      this.escape(wide);
      return;
    }
    if (region === "picker" && this.picker === "model") {
      if (matchesKey(data, Key.backspace) || matchesKey(data, Key.delete)) {
        this.search = this.search.slice(0, -1);
        this.pickerIndex = 0;
        this.tui.requestRender();
        return;
      }
      if (/^[\x20-\x7e]$/.test(data)) {
        this.search += data;
        this.pickerIndex = 0;
        this.tui.requestRender();
        return;
      }
    }
    if (matchesKey(data, Key.tab)) {
      if (region === "picker" && this.picker === "model") {
        this.all = !this.all;
        this.pickerIndex = 0;
      } else if (wide && this.role) {
        this.focus = this.focus === "roles" ? "settings" : "roles";
      } else {
        return;
      }
      this.tui.requestRender();
      return;
    }
    if (region === "roles") {
      if (data === "r") {
        void this.reload();
        return;
      }
      if (data === "m" || data === "t") {
        const item = this.rolesItems()[this.rolesIndex];
        if (item?.kind !== "role") return;
        this.selectRole(item.role.name);
        this.openPicker(data === "m" ? "model" : "thinking");
        this.tui.requestRender();
        return;
      }
      if (/^[1-9]$/.test(data)) {
        const role = this.input.roles[Number(data) - 1];
        if (!role) return;
        this.rolesIndex = Number(data) - 1;
        this.selectRole(role.name);
        this.tui.requestRender();
        return;
      }
    }
    if (region === "settings" && data === " ") {
      const item = this.settingsItems()[this.settingsIndex];
      if (item?.kind === "enabled") this.confirm();
      return;
    }

    const count = this.itemsFor(region).length;
    if (count === 0) return;
    if (this.keybindings.matches(data, "tui.select.up")) this.shiftCursor(region, -1);
    else if (this.keybindings.matches(data, "tui.select.down")) this.shiftCursor(region, 1);
    else if (this.keybindings.matches(data, "tui.select.pageUp")) this.setCursor(region, 0);
    else if (this.keybindings.matches(data, "tui.select.pageDown")) this.setCursor(region, count - 1);
    else if (this.keybindings.matches(data, "tui.select.confirm") || matchesKey(data, Key.enter)) {
      this.confirm();
    } else return;
    this.tui.requestRender();
  }

  render(width: number): string[] {
    const panelWidth = Math.max(1, Math.min(MAX_PANEL_WIDTH, width));
    this.lastWidth = panelWidth;
    const inner = Math.max(1, panelWidth - 2);
    const bodyHeight = Math.max(4, Math.min(12, this.tui.terminal.rows - 11));
    const lines: string[] = [""];
    const headerRight = [
      this.input.mode ? this.theme.fg("dim", `mode: ${this.input.mode}`) : undefined,
      this.theme.fg("dim", `${this.input.roles.length} roles`),
    ].filter(Boolean).join(this.theme.fg("border", " · "));
    lines.push(joinSides(this.theme.fg("accent", "Configure subagents"), headerRight, panelWidth));
    if (this.error) {
      lines.push(`  ${this.theme.fg("error", "⚠")} ${this.theme.fg("error", truncateToWidth(this.error, Math.max(1, panelWidth - 6), "…"))}`);
    }
    if (panelWidth >= WIDE_MIN_WIDTH) {
      lines.push(...this.renderWide(inner, bodyHeight));
    } else {
      lines.push(...this.renderNarrow(inner, bodyHeight));
    }
    lines.push("");
    lines.push(`  ${this.theme.fg("dim", this.hint())}`);
    lines.push("");
    return lines.map((line) => truncateToWidth(line, panelWidth, ""));
  }

  invalidate(): void {}

  // ----- layout -----

  private renderNarrow(inner: number, bodyHeight: number): string[] {
    const lines = [frameTop(this.title(), inner, this.theme)];
    if (this.picker === "model") {
      lines.push(frameRow(this.filterLine(inner - ROW_PAD * 2), inner, this.theme));
    } else if (this.picker !== "thinking") {
      lines.push(frameRow(this.scopeLine(), inner, this.theme));
    }
    const region = this.region();
    const items = this.itemsFor(region);
    const cursor = this.cursorFor(region);
    const room = Math.max(1, bodyHeight - lines.length + 1);
    const start = windowStart(cursor, items.length, room);
    for (let i = start; i < Math.min(items.length, start + room); i += 1) {
      lines.push(frameRow(this.renderItem(items[i]!, i === cursor, inner - ROW_PAD * 2), inner, this.theme));
    }
    while (lines.length < bodyHeight + 1) lines.push(frameRow("", inner, this.theme));
    lines.push(frameBottom(inner, this.theme));
    return lines;
  }

  private renderWide(inner: number, bodyHeight: number): string[] {
    const usable = Math.max(2, inner - 2);
    const leftWidth = Math.max(20, Math.floor(usable / 2));
    const rightWidth = Math.max(20, usable - leftWidth);
    const left = this.renderRolesColumn(leftWidth, bodyHeight);
    const right = this.renderSettingsColumn(rightWidth, bodyHeight);
    return left.map((line, i) => `${line}  ${right[i] ?? ""}`);
  }

  private renderRolesColumn(width: number, bodyHeight: number): string[] {
    const inner = Math.max(1, width - 2);
    const lines = [frameTop("roles", inner, this.theme, this.region() === "roles")];
    lines.push(frameRow(this.scopeLine(), inner, this.theme));
    const items = this.rolesItems();
    const room = Math.max(1, bodyHeight - lines.length + 1);
    const start = windowStart(this.rolesIndex, items.length, room);
    for (let i = start; i < Math.min(items.length, start + room); i += 1) {
      lines.push(frameRow(this.renderItem(items[i]!, i === this.rolesIndex && this.region() === "roles", inner - 2), inner, this.theme));
    }
    while (lines.length < bodyHeight + 1) lines.push(frameRow("", inner, this.theme));
    lines.push(frameBottom(inner, this.theme));
    return lines;
  }

  private renderSettingsColumn(width: number, bodyHeight: number): string[] {
    const inner = Math.max(1, width - 2);
    const region = this.region();
    const focused = region === "settings" || region === "picker";
    const lines = [frameTop(this.settingsTitle(), inner, this.theme, focused)];
    if (!this.role) {
      const placeholder = truncateToWidth("Select a role to configure its model and thinking.", Math.max(1, inner - 2));
      lines.push(frameRow(this.theme.fg("dim", placeholder), inner, this.theme));
    } else {
      if (this.picker === "model") lines.push(frameRow(this.filterLine(inner - 2), inner, this.theme));
      const items = region === "picker" ? this.pickerItems() : this.settingsItems();
      const cursor = region === "picker" ? this.pickerIndex : this.settingsIndex;
      const room = Math.max(1, bodyHeight - lines.length + 1);
      const start = windowStart(cursor, items.length, room);
      for (let i = start; i < Math.min(items.length, start + room); i += 1) {
        lines.push(frameRow(this.renderItem(items[i]!, i === cursor && focused, inner - 2), inner, this.theme));
      }
    }
    while (lines.length < bodyHeight + 1) lines.push(frameRow("", inner, this.theme));
    lines.push(frameBottom(inner, this.theme));
    return lines;
  }

  /** The filter field shown above the model picker's scrolling rows. */
  private filterLine(width: number): string {
    return this.search
      ? `${this.theme.fg("text", "filter:")} ${this.theme.fg("accent", truncateToWidth(this.search, Math.max(1, width - 8), "…"))}`
      : this.theme.fg("dim", "type to filter");
  }

  private scopeLine(): string {
    const segments = SCOPES.map((scope) => scope === this.scope
      ? this.theme.fg("accent", `▸${scope}◂`)
      : this.theme.fg("dim", scope));
    return `${this.theme.fg("text", "Scope")} ${segments.join(this.theme.fg("border", " · "))}`;
  }

  private renderItem(item: Item, selected: boolean, width: number): string {
    const lead = selected ? `${this.theme.fg("accent", "▸")} ` : "  ";
    if (item.kind === "role") {
      const disabled = !item.role.enabled;
      const overridden = item.role.model !== item.role.configuredModel || item.role.thinking !== item.role.configuredThinking;
      const dot = disabled ? `${this.theme.fg("dim", "○")} ` : overridden ? `${this.theme.fg("warning", "●")} ` : "";
      const name = this.theme.fg(disabled ? "dim" : selected ? "accent" : "text", item.role.name);
      const right = disabled
        ? this.theme.fg("warning", "disabled")
        : this.theme.fg(overridden ? "accent" : "dim", `${shortModel(item.role.model)} · ${item.role.thinking}`);
      return layoutRow(`${lead}${dot}${name}`, right, width);
    }
    if (item.kind === "save") {
      return layoutRow(`${lead}${this.theme.fg("success", "💾")} ${this.theme.fg(selected ? "accent" : "text", "Save defaults")}`, this.theme.fg("dim", `${this.scope} · all roles`), width);
    }
    if (item.kind === "reload") {
      return layoutRow(`${lead}${this.theme.fg(selected ? "accent" : "warning", "↻")} ${this.theme.fg(selected ? "accent" : "text", "Reload configs")}`, this.theme.fg("dim", "clears session overrides"), width);
    }
    if (item.kind === "enabled") {
      const role = this.selectedRole();
      const on = role?.enabled ?? true;
      const right = on ? this.theme.fg("success", "on") : this.theme.fg("warning", "off · blocks new work");
      return layoutRow(`${lead}${this.theme.fg("text", "Enabled · session")}`, right, width);
    }
    if (item.kind === "model") {
      const current = this.selectedRole()?.model ?? "";
      return layoutRow(`${lead}${this.theme.fg("text", "Model")}`, this.theme.fg("dim", shortModel(current)), width);
    }
    if (item.kind === "thinking") {
      const current = this.selectedRole()?.thinking ?? "";
      return layoutRow(`${lead}${this.theme.fg("text", "Thinking")}`, this.theme.fg("dim", current), width);
    }
    if (item.kind === "reset-model") {
      return layoutRow(`${lead}${this.theme.fg("accent", "↺")} ${this.theme.fg("text", "Reset model")}`, this.theme.fg("dim", `→ ${shortModel(this.selectedRole()?.configuredModel ?? "")}`), width);
    }
    if (item.kind === "reset-thinking") {
      return layoutRow(`${lead}${this.theme.fg("accent", "↺")} ${this.theme.fg("text", "Reset thinking")}`, this.theme.fg("dim", `→ ${this.selectedRole()?.configuredThinking ?? ""}`), width);
    }
    if (item.kind === "back") {
      return `${lead}${this.theme.fg("success", "✓")} ${this.theme.fg("text", "Done")}`;
    }
    if (item.kind === "pick-thinking") {
      const current = this.selectedRole()?.thinking;
      const chosen = item.level === current;
      return layoutRow(`${lead}${this.theme.fg(chosen ? "accent" : "text", item.level)}`, this.theme.fg(chosen ? "success" : "dim", chosen ? "✓ current" : ""), width);
    }
    const current = this.selectedRole()?.model === `${item.choice.provider}/${item.choice.id}`;
    const noAuth = item.choice.available === false;
    const right = current ? "✓ current" : noAuth ? `${item.choice.id} · no auth` : item.choice.id;
    const rightColor = current ? "success" : noAuth ? "warning" : "dim";
    const nameColor = current ? "accent" : noAuth ? "dim" : "text";
    return layoutRow(`${lead}${this.theme.fg(nameColor, item.choice.name)}`, this.theme.fg(rightColor, right), width);
  }

  // ----- items & cursors -----

  private rolesItems(): RolesItem[] {
    return [
      ...this.input.roles.map((role) => ({ kind: "role", role }) as RolesItem),
      { kind: "save" },
      { kind: "reload" },
    ];
  }

  private settingsItems(): SettingsItem[] {
    const role = this.selectedRole();
    if (!role) return [];
    const items: SettingsItem[] = [{ kind: "enabled" }, { kind: "model" }, { kind: "thinking" }];
    if (role.model !== role.configuredModel) items.push({ kind: "reset-model" });
    if (role.thinking !== role.configuredThinking) items.push({ kind: "reset-thinking" });
    items.push({ kind: "back" });
    return items;
  }

  private pickerItems(): PickerItem[] {
    if (this.picker === "thinking") {
      return THINKING_LEVELS.map((level) => ({ kind: "pick-thinking", level }) as PickerItem);
    }
    if (this.picker !== "model") return [];
    const query = this.search.toLowerCase();
    return (this.all || this.input.scopedModels.length === 0 ? this.input.allModels : this.input.scopedModels)
      .filter((model) => !query || `${model.providerLabel} ${model.provider}/${model.id} ${model.name}`.toLowerCase().includes(query))
      .sort((left, right) => left.providerLabel.localeCompare(right.providerLabel) || left.name.localeCompare(right.name))
      .map((choice) => ({ kind: "pick-model", choice }) as PickerItem);
  }

  private itemsFor(region: Region): Item[] {
    if (region === "roles") return this.rolesItems();
    if (region === "settings") return this.settingsItems();
    return this.pickerItems();
  }

  private cursorFor(region: Region): number {
    if (region === "roles") return this.rolesIndex;
    if (region === "settings") return this.settingsIndex;
    return this.pickerIndex;
  }

  private setCursor(region: Region, value: number): void {
    if (region === "roles") this.rolesIndex = value;
    else if (region === "settings") this.settingsIndex = value;
    else this.pickerIndex = value;
  }

  private shiftCursor(region: Region, delta: 1 | -1): void {
    const count = this.itemsFor(region).length;
    if (count === 0) return;
    const current = this.cursorFor(region);
    this.setCursor(region, (current + delta + count) % count);
  }

  private region(): Region {
    if (this.picker) return "picker";
    return this.isWide() ? this.focus : this.stage;
  }

  private isWide(): boolean {
    return this.lastWidth >= WIDE_MIN_WIDTH;
  }

  private selectedRole(): AgentRoleConfigState | undefined {
    return this.input.roles.find((role) => role.name === this.role);
  }

  // ----- actions -----

  private confirm(): void {
    const region = this.region();
    if (region === "roles") {
      const item = this.rolesItems()[this.rolesIndex];
      if (!item) return;
      if (item.kind === "role") this.selectRole(item.role.name);
      else if (item.kind === "save") void this.save();
      else void this.reload();
      return;
    }
    if (region === "settings") {
      const item = this.settingsItems()[this.settingsIndex];
      const role = this.role;
      if (!item || !role) return;
      if (item.kind === "enabled") {
        const current = this.selectedRole();
        if (current) this.emit(role, { kind: "enabled", enabled: !current.enabled });
      } else if (item.kind === "model") {
        this.openPicker("model");
      } else if (item.kind === "thinking") {
        this.openPicker("thinking");
      } else if (item.kind === "reset-model") {
        this.emit(role, { kind: "reset-model" });
      } else if (item.kind === "reset-thinking") {
        this.emit(role, { kind: "reset-thinking" });
      } else {
        this.backToRoles();
      }
      return;
    }
    const item = this.pickerItems()[this.pickerIndex];
    const role = this.role;
    if (!item || !role) return;
    if (item.kind === "pick-model") {
      this.emit(role, { kind: "model", model: `${item.choice.provider}/${item.choice.id}` });
      this.closePicker();
    } else {
      this.emit(role, { kind: "thinking", thinking: item.level });
      this.closePicker();
    }
  }

  private escape(wide: boolean): void {
    if (this.picker) {
      this.closePicker();
    } else if (wide && this.focus === "settings") {
      this.focus = "roles";
    } else if (this.stage === "settings") {
      this.backToRoles();
    } else {
      if (!this.finished) {
        this.finished = true;
        this.done();
      }
      return;
    }
    this.tui.requestRender();
  }

  private selectRole(name: string): void {
    this.role = name;
    this.stage = "settings";
    this.focus = "settings";
    this.settingsIndex = 0;
    this.picker = undefined;
    this.search = "";
  }

  private backToRoles(): void {
    this.role = undefined;
    this.stage = "roles";
    this.focus = "roles";
    this.settingsIndex = 0;
    this.picker = undefined;
    this.search = "";
  }

  private openPicker(kind: "model" | "thinking"): void {
    this.picker = kind;
    this.search = "";
    const role = this.selectedRole();
    if (kind === "thinking") {
      this.pickerIndex = Math.max(0, THINKING_LEVELS.findIndex((level) => level === role?.thinking));
      return;
    }
    this.pickerIndex = Math.max(0, this.pickerItems().findIndex((item) =>
      item.kind === "pick-model" && role?.model === `${item.choice.provider}/${item.choice.id}`,
    ));
  }

  private closePicker(): void {
    this.picker = undefined;
    this.search = "";
    this.pickerIndex = 0;
    this.focus = "settings";
  }

  private cycleScope(delta: 1 | -1): void {
    this.scope = SCOPES[(SCOPES.indexOf(this.scope) + delta + SCOPES.length) % SCOPES.length]!;
    this.callbacks.onScopeChange?.(this.scope);
    this.pickerIndex = clampIndex(this.pickerIndex, this.pickerItems().length);
    this.tui.requestRender();
  }

  private emit(role: string, change: AgentRoleConfigureChange): void {
    void this.run(() => this.callbacks.onChange(role, change));
  }

  private save(): void {
    void this.run(() => this.callbacks.onSaveDefaults?.(this.scope) ?? {});
  }

  private reload(): void {
    void this.run(() => this.callbacks.onReload?.() ?? {});
  }

  /**
   * Run a host action, then re-read host state. Sync results settle
   * synchronously; promise results engage the pending guard. A returned (or
   * thrown) error is displayed and stays visible; the working state is left
   * untouched until an action succeeds.
   */
  private run(action: () => AgentConfigureResult | void | Promise<AgentConfigureResult | void>): void {
    let result: AgentConfigureResult | void | Promise<AgentConfigureResult | void>;
    try {
      result = action();
    } catch (error) {
      this.settleError(error);
      return;
    }
    if (result instanceof Promise) {
      this.pending = true;
      this.tui.requestRender();
      void result.then((outcome) => this.settle(outcome), (error) => this.settleError(error));
      return;
    }
    this.settle(result);
  }

  private settle(result: AgentConfigureResult | void): void {
    this.pending = false;
    if (result && typeof result === "object" && typeof result.error === "string") {
      this.error = result.error;
    } else {
      this.error = undefined;
      this.adopt(this.callbacks.refresh());
    }
    this.tui.requestRender();
  }

  private settleError(error: unknown): void {
    this.error = error instanceof Error ? error.message : String(error);
    this.pending = false;
    this.tui.requestRender();
  }

  /** Replace the panel's view with fresh host state, keeping the selection stable. */
  private adopt(fresh: AgentModelConfigureInput): void {
    this.input = fresh;
    if (fresh.scope) this.scope = fresh.scope;
    if (this.role && !fresh.roles.some((role) => role.name === this.role)) {
      this.role = undefined;
      this.stage = "roles";
      this.focus = "roles";
      this.settingsIndex = 0;
    }
    this.rolesIndex = clampIndex(this.rolesIndex, this.rolesItems().length);
    this.settingsIndex = clampIndex(this.settingsIndex, this.settingsItems().length);
    this.pickerIndex = clampIndex(this.pickerIndex, this.pickerItems().length);
  }

  // ----- chrome -----

  private title(): string {
    if (this.stage === "roles") return "roles";
    if (this.picker === "model") return `models · ${this.role ?? "role"}`;
    if (this.picker === "thinking") return `thinking · ${this.role ?? "role"}`;
    return `settings · ${this.role ?? "role"}`;
  }

  private settingsTitle(): string {
    if (!this.role) return "settings";
    if (this.picker === "model") return `models · ${this.role}`;
    if (this.picker === "thinking") return `thinking · ${this.role}`;
    return `settings · ${this.role}`;
  }

  private hint(): string {
    if (this.pending) return this.theme.fg("warning", "working…");
    const region = this.region();
    const required: string[] = region === "roles"
      ? [this.hintSegment("↑↓", ""), this.hintSegment("↵", "open")]
      : [this.hintSegment("↑↓", ""), this.hintSegment("↵", "select")];
    const optional: string[] = region === "roles"
      ? [this.hintSegment("1-9", "jump"), this.hintSegment("m/t", "quick edit")]
      : region === "settings"
        ? [this.hintSegment("space", "toggle")]
        : this.picker === "model"
          ? [this.hintSegment("type", "filter"), this.hintSegment("tab", this.all ? "scoped" : "all")]
          : [];
    optional.push(this.hintSegment("←→", `scope: ${this.scope}`));
    if (this.isWide() && !this.picker) optional.push(this.hintSegment("tab", "pane"));
    // Keep navigation, confirmation, and back/close visible at narrow widths;
    // optional context hints are admitted only when they fit as a whole.
    const back = this.hintSegment("esc", this.stage === "roles" ? "close" : "back");
    const separator = this.theme.fg("border", " · ");
    const segments = [...required];
    const fits = (candidate: string): boolean => visibleWidth([...segments, candidate].join(separator)) <= Math.max(20, this.lastWidth - 2);
    for (const candidate of optional) if (fits(candidate)) segments.push(candidate);
    while (!fits(back) && segments.length > required.length) segments.pop();
    if (fits(back)) segments.push(back);
    else segments.push(this.hintSegment("esc", ""));
    return segments.join(separator);
  }

  private hintSegment(key: string, label: string): string {
    return label ? `${this.theme.fg("accent", key)} ${this.theme.fg("dim", label)}` : this.theme.fg("accent", key);
  }

  private cancelled(data: string): boolean {
    return this.keybindings.matches(data, "tui.select.cancel") || matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl("c"));
  }
}

export async function showAgentModelConfigure(
  ctx: { mode: string; ui: { custom: Function } },
  input: AgentModelConfigureInput,
  callbacks: AgentConfigureCallbacks,
): Promise<void> {
  if (ctx.mode !== "tui" || input.roles.length === 0 || input.allModels.length === 0) return;
  await ctx.ui.custom(
    (tui: TUI, theme: Theme, keybindings: KeybindingsManager, done: () => void) =>
      new AgentModelConfigurePanel(input, tui, theme, keybindings, callbacks, done),
    { overlay: true, overlayOptions: { width: "92%", minWidth: 30, maxHeight: "80%", anchor: "center", margin: 2 } },
  );
}

function shortModel(model: string): string {
  return model.split("/").at(-1) ?? model;
}

function clampIndex(index: number, count: number): number {
  if (count === 0) return 0;
  return Math.max(0, Math.min(index, count - 1));
}

function frameTop(title: string, width: number, theme: Theme, focused = true): string {
  const content = ` ${truncateToWidth(title, Math.max(1, width - 3), "…")} `;
  const rest = Math.max(0, width - visibleWidth(content));
  const stroke = focused ? "text" : "dim";
  return `${theme.fg("border", "╭")}${theme.fg("border", "─").repeat(Math.floor(rest / 2))}${theme.fg(stroke, content)}${theme.fg("border", "─").repeat(Math.ceil(rest / 2))}${theme.fg("border", "╮")}`;
}

function frameBottom(width: number, theme: Theme): string {
  return `${theme.fg("border", "╰")}${theme.fg("border", "─").repeat(width)}${theme.fg("border", "╯")}`;
}

function frameRow(content: string, inner: number, theme: Theme): string {
  return `${theme.fg("border", "│")}${padLine(content, inner)}${theme.fg("border", "│")}`;
}

function layoutRow(left: string, right: string, width: number): string {
  const gap = width - visibleWidth(left) - visibleWidth(right);
  if (gap > 0) return `${left}${" ".repeat(gap)}${right}`;
  // Tight fit: keep the value on the right and clip the label instead.
  if (visibleWidth(right) < width) {
    return `${truncateToWidth(left, width - visibleWidth(right) - 1, "…")} ${right}`;
  }
  return truncateToWidth(left, width, "");
}

function padLine(value: string, width: number): string {
  const clipped = truncateToWidth(value, width, "");
  return clipped + " ".repeat(Math.max(0, width - visibleWidth(clipped)));
}

function joinSides(left: string, right: string, width: number): string {
  const gap = width - visibleWidth(left) - visibleWidth(right);
  return gap >= 2 ? `${left}${" ".repeat(gap)}${right}` : truncateToWidth(left, width, "");
}

function windowStart(index: number, total: number, room: number): number {
  return Math.max(0, Math.min(index - Math.floor(room / 2), Math.max(0, total - room)));
}
