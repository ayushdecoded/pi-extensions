import type { KeybindingsManager, Theme } from "@earendil-works/pi-coding-agent";
import type { Component, TUI } from "@earendil-works/pi-tui";
import { isKeyRelease, Key, matchesKey, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { THINKING_LEVELS, type ThinkingLevel } from "../config/agents.ts";

export type AgentConfigureScope = "session" | "project" | "global";

export type AgentModelRoleChoice = {
  name: string;
  model: string;
  thinking: string;
  configuredModel: string;
  configuredThinking: string;
};

export type AgentModelChoice = {
  provider: string;
  providerLabel: string;
  id: string;
  name: string;
};

/** One confirmed edit. Callers persist it immediately. */
export type AgentRoleConfigureChange =
  | { kind: "model"; model: string }
  | { kind: "thinking"; thinking: ThinkingLevel }
  | { kind: "reset-model" }
  | { kind: "reset-thinking" };

export type AgentModelConfigureInput = {
  /** Active preset name. Shown in the header; persistence is scoped to it. */
  mode?: string;
  scope?: AgentConfigureScope;
  roles: AgentModelRoleChoice[];
  scopedModels: AgentModelChoice[];
  allModels: AgentModelChoice[];
};

type Stage = "roles" | "settings" | "providers" | "models" | "thinking";
type Item =
  | { kind: "role"; role: AgentModelRoleChoice }
  | { kind: "setting"; setting: "model" | "thinking" | "reset-model" | "reset-thinking" | "done" }
  | { kind: "provider"; provider: string; label: string }
  | { kind: "model"; choice: AgentModelChoice }
  | { kind: "thinking"; level: ThinkingLevel };

const PANEL_WIDTH = 84;

/**
 * Role → settings → provider/model and thinking picker. Tab toggles Pi's
 * scoped models and all available models. Each confirmed edit is handed to the
 * onChange callback immediately, so the panel stays open for more changes.
 */
export class AgentModelConfigurePanel implements Component {
  private stage: Stage = "roles";
  private scope: AgentConfigureScope = "session";
  private index = 0;
  private role?: AgentModelRoleChoice;
  private provider?: string;
  private all = false;
  private search = "";
  private readonly effective = new Map<string, { model: string; thinking: string }>();

  constructor(
    private readonly input: AgentModelConfigureInput,
    private readonly tui: TUI,
    private readonly theme: Theme,
    private readonly keybindings: KeybindingsManager,
    private readonly onChange: (role: string, change: AgentRoleConfigureChange) => void,
    private readonly done: () => void,
    private readonly onScopeChange: (scope: AgentConfigureScope) => void = () => {},
  ) {
    this.scope = input.scope ?? "session";
    for (const role of input.roles) this.effective.set(role.name, { model: role.model, thinking: role.thinking });
  }

  handleInput(data: string): void {
    if (isKeyRelease(data)) return;
    if (matchesKey(data, Key.ctrl("s"))) {
      const scopes: AgentConfigureScope[] = ["session", "project", "global"];
      this.scope = scopes[(scopes.indexOf(this.scope) + 1) % scopes.length]!;
      this.onScopeChange(this.scope);
      this.tui.requestRender();
      return;
    }
    if (matchesKey(data, Key.tab)) {
      this.all = !this.all;
      this.reconcileScope();
      this.tui.requestRender();
      return;
    }
    if (this.cancelled(data)) {
      if (this.stage === "models") {
        this.stage = "providers";
        this.provider = undefined;
        this.search = "";
      } else if (this.stage === "providers" || this.stage === "thinking") {
        this.stage = "settings";
      } else if (this.stage === "settings") {
        this.stage = "roles";
        this.role = undefined;
      } else {
        this.done();
        return;
      }
      this.index = 0;
      this.tui.requestRender();
      return;
    }
    if (this.stage === "models") {
      if (matchesKey(data, Key.backspace) || matchesKey(data, Key.delete)) {
        this.search = this.search.slice(0, -1);
        this.index = 0;
        this.tui.requestRender();
        return;
      }
      if (/^[\x20-\x7e]$/.test(data)) {
        this.search += data;
        this.index = 0;
        this.tui.requestRender();
        return;
      }
    }

    const count = this.items().length;
    if (count === 0) return;
    if (this.keybindings.matches(data, "tui.select.up")) this.index = this.index === 0 ? count - 1 : this.index - 1;
    else if (this.keybindings.matches(data, "tui.select.down")) this.index = this.index === count - 1 ? 0 : this.index + 1;
    else if (this.keybindings.matches(data, "tui.select.pageUp")) this.index = 0;
    else if (this.keybindings.matches(data, "tui.select.pageDown")) this.index = count - 1;
    else if (this.keybindings.matches(data, "tui.select.confirm") || matchesKey(data, Key.enter)) this.confirm();
    else return;
    this.tui.requestRender();
  }

  render(width: number): string[] {
    const panelWidth = Math.max(1, Math.min(PANEL_WIDTH, width));
    const inner = Math.max(1, panelWidth - 2);
    const pad = inner >= 10 ? 2 : 0;
    const contentWidth = Math.max(1, inner - pad * 2);
    const items = this.items();
    // Four fixed padding lines surround the header, frame, and hint; keep the
    // body bounded so the padded panel still fits short terminals.
    const bodyHeight = Math.max(4, Math.min(10, this.tui.terminal.rows - 11));
    const start = windowStart(this.index, items.length, bodyHeight);
    const scope = this.scopeIsEffective() ? (this.all ? "all" : "scoped") : "all";
    const modePart = this.input.mode ? `mode: ${this.input.mode}` : undefined;
    const headerRight = [modePart, `scope: ${this.scope}`, `${scope} models`].filter(Boolean).join(" · ");
    const lines = [""];
    lines.push(joinSides(this.theme.fg("accent", "Configure subagents"), this.theme.fg("dim", headerRight), panelWidth));
    lines.push("");
    lines.push(frameTop(this.title(), inner, this.theme));
    for (let itemIndex = start; itemIndex < Math.min(items.length, start + bodyHeight); itemIndex += 1) {
      const row = `${this.theme.fg("border", "│")}${" ".repeat(pad)}${padLine(this.renderItem(items[itemIndex]!, itemIndex === this.index, contentWidth), contentWidth)}${" ".repeat(pad)}${this.theme.fg("border", "│")}`;
      lines.push(row);
    }
    while (lines.length < bodyHeight + 4) {
      lines.push(`${this.theme.fg("border", "│")}${" ".repeat(inner)}${this.theme.fg("border", "│")}`);
    }
    lines.push(`${this.theme.fg("border", "╰")}${this.theme.fg("border", "─").repeat(inner)}${this.theme.fg("border", "╯")}`);
    lines.push("");
    lines.push(`  ${this.theme.fg("dim", this.hint())}`);
    lines.push("");
    return lines.map((line) => truncateToWidth(line, panelWidth, ""));
  }

  invalidate(): void {}

  private items(): Item[] {
    if (this.stage === "roles") return this.input.roles.map((role) => ({ kind: "role", role }));
    if (this.stage === "settings") {
      const role = this.role;
      if (!role) return [];
      const current = this.effective.get(role.name) ?? { model: role.model, thinking: role.thinking };
      const items: Item[] = [{ kind: "setting", setting: "model" }, { kind: "setting", setting: "thinking" }];
      if (current.model !== role.configuredModel) items.push({ kind: "setting", setting: "reset-model" });
      if (current.thinking !== role.configuredThinking) items.push({ kind: "setting", setting: "reset-thinking" });
      items.push({ kind: "setting", setting: "done" });
      return items;
    }
    if (this.stage === "providers") {
      const providers: Array<{ provider: string; label: string }> = [];
      const seen = new Set<string>();
      for (const model of this.models()) {
        if (seen.has(model.provider)) continue;
        seen.add(model.provider);
        providers.push({ provider: model.provider, label: model.providerLabel });
      }
      providers.sort((left, right) => left.label.localeCompare(right.label));
      return providers.map((provider) => ({ kind: "provider", ...provider }));
    }
    if (this.stage === "thinking") {
      return THINKING_LEVELS.map((level) => ({ kind: "thinking", level }));
    }
    const query = this.search.toLowerCase();
    return this.models()
      .filter((model) => model.provider === this.provider)
      .filter((model) => !query || `${model.name} ${model.id}`.toLowerCase().includes(query))
      .sort((left, right) => left.name.localeCompare(right.name))
      .map((choice) => ({ kind: "model", choice }));
  }

  private renderItem(item: Item, selected: boolean, width: number): string {
    const lead = `${selected ? this.theme.fg("accent", "→") : " "} `;
    if (item.kind === "role") {
      const current = this.effective.get(item.role.name) ?? { model: item.role.model, thinking: item.role.thinking };
      const overridden = current.model !== item.role.configuredModel || current.thinking !== item.role.configuredThinking;
      const right = `${current.model.split("/").at(-1)} · ${current.thinking}`;
      return layoutRow(`${lead}${this.theme.fg("text", item.role.name)}`, this.theme.fg(overridden ? "accent" : "dim", right), width);
    }
    if (item.kind === "setting") {
      if (item.setting === "model") {
        const current = this.role ? this.effective.get(this.role.name)?.model ?? this.role.model : "";
        return layoutRow(`${lead}${this.theme.fg("text", "Model")}`, this.theme.fg("dim", current.split("/").at(-1) ?? current), width);
      }
      if (item.setting === "thinking") {
        const current = this.role ? this.effective.get(this.role.name)?.thinking ?? this.role.thinking : "";
        return layoutRow(`${lead}${this.theme.fg("text", "Thinking")}`, this.theme.fg("dim", current), width);
      }
      if (item.setting === "reset-model") return `${lead}${this.theme.fg("accent", "↺")} ${this.theme.fg("text", "Reset model")}`;
      if (item.setting === "reset-thinking") return `${lead}${this.theme.fg("accent", "↺")} ${this.theme.fg("text", "Reset thinking")}`;
      return `${lead}${this.theme.fg("success", "✓")} ${this.theme.fg("text", "Done")}`;
    }
    if (item.kind === "provider") {
      const count = this.models().filter((model) => model.provider === item.provider).length;
      return layoutRow(`${lead}${this.theme.fg("text", item.label)}`, this.theme.fg("dim", `${count} ${count === 1 ? "model" : "models"}`), width);
    }
    if (item.kind === "thinking") {
      const current = this.role ? this.effective.get(this.role.name)?.thinking : undefined;
      return layoutRow(`${lead}${this.theme.fg("text", item.level)}`, this.theme.fg(item.level === current ? "accent" : "dim", item.level === current ? "selected" : ""), width);
    }
    const current = this.role?.model === `${item.choice.provider}/${item.choice.id}`;
    return layoutRow(`${lead}${this.theme.fg("text", item.choice.name)}`, this.theme.fg(current ? "accent" : "dim", current ? "selected" : item.choice.id), width);
  }

  private confirm(): void {
    const item = this.items()[this.index];
    if (!item) return;
    if (item.kind === "role") {
      this.role = item.role;
      this.stage = "settings";
      this.index = 0;
      return;
    }
    if (item.kind === "setting") {
      const role = this.role?.name;
      if (!role) return;
      if (item.setting === "model") {
        this.stage = "providers";
        this.index = 0;
      } else if (item.setting === "thinking") {
        this.stage = "thinking";
        const current = this.effective.get(role)?.thinking ?? this.role!.thinking;
        this.index = Math.max(0, THINKING_LEVELS.findIndex((level) => level === current));
      } else if (item.setting === "reset-model") {
        this.onChange(role, { kind: "reset-model" });
        this.applyLocal(role, { kind: "reset-model" });
      } else if (item.setting === "reset-thinking") {
        this.onChange(role, { kind: "reset-thinking" });
        this.applyLocal(role, { kind: "reset-thinking" });
      } else {
        this.stage = "roles";
        this.role = undefined;
        this.index = 0;
      }
      return;
    }
    if (item.kind === "provider") {
      this.provider = item.provider;
      this.stage = "models";
      this.index = Math.max(0, this.items().findIndex((candidate) =>
        candidate.kind === "model" && this.role?.model === `${candidate.choice.provider}/${candidate.choice.id}`,
      ));
      return;
    }
    if (item.kind === "model") {
      const role = this.role?.name;
      if (!role) return;
      this.onChange(role, { kind: "model", model: `${item.choice.provider}/${item.choice.id}` });
      this.applyLocal(role, { kind: "model", model: `${item.choice.provider}/${item.choice.id}` });
      this.stage = "settings";
      this.index = 0;
      return;
    }
    const role = this.role?.name;
    if (!role) return;
    this.onChange(role, { kind: "thinking", thinking: item.level });
    this.applyLocal(role, { kind: "thinking", thinking: item.level });
    this.stage = "settings";
    this.index = 0;
  }

  private applyLocal(role: string, change: AgentRoleConfigureChange): void {
    const current = this.effective.get(role);
    if (!current) return;
    const configured = this.input.roles.find((candidate) => candidate.name === role);
    if (change.kind === "model") current.model = change.model;
    else if (change.kind === "thinking") current.thinking = change.thinking;
    else if (change.kind === "reset-model") current.model = configured?.configuredModel ?? current.model;
    else if (change.kind === "reset-thinking") current.thinking = configured?.configuredThinking ?? current.thinking;
  }

  private models(): AgentModelChoice[] {
    return this.all || !this.scopeIsEffective() ? this.input.allModels : this.input.scopedModels;
  }

  private scopeIsEffective(): boolean {
    return this.input.scopedModels.length > 0;
  }

  private reconcileScope(): void {
    this.index = 0;
    if (this.stage === "models" && !this.models().some((model) => model.provider === this.provider)) {
      this.stage = "providers";
      this.provider = undefined;
      this.search = "";
    }
  }

  private title(): string {
    if (this.stage === "roles") return "roles";
    if (this.stage === "settings") return `settings · ${this.role?.name ?? "role"}`;
    if (this.stage === "providers") return `providers · ${this.role?.name ?? "role"}`;
    if (this.stage === "thinking") return `thinking · ${this.role?.name ?? "role"}`;
    return `models · ${this.models().find((model) => model.provider === this.provider)?.providerLabel ?? this.provider ?? "provider"}`;
  }

  private hint(): string {
    const base = `↑↓ select · ↵ confirm · Ctrl+S scope: ${this.scope} · Tab ${this.all ? "scoped" : "all"} · esc ${this.stage === "roles" ? "cancel" : "back"}`;
    if (this.stage === "models") return `${this.search ? `filter: ${this.search} · ` : ""}${base}${this.search ? "" : " · type to filter"}`;
    if (this.stage === "settings") return `${base} · ↑↓ select · ↵ edit · esc back`;
    return base;
  }

  private cancelled(data: string): boolean {
    return this.keybindings.matches(data, "tui.select.cancel") || matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl("c"));
  }
}

export async function showAgentModelConfigure(
  ctx: { mode: string; ui: { custom: Function } },
  input: AgentModelConfigureInput,
  onChange: (role: string, change: AgentRoleConfigureChange) => void,
  onScopeChange: (scope: AgentConfigureScope) => void = () => {},
): Promise<void> {
  if (ctx.mode !== "tui" || input.roles.length === 0 || input.allModels.length === 0) return;
  await ctx.ui.custom(
    (tui: TUI, theme: Theme, keybindings: KeybindingsManager, done: () => void) =>
      new AgentModelConfigurePanel(input, tui, theme, keybindings, onChange, done, onScopeChange),
    { overlay: true, overlayOptions: { width: PANEL_WIDTH, minWidth: 30, maxHeight: "80%", anchor: "center", margin: 2 } },
  );
}

function frameTop(title: string, width: number, theme: Theme): string {
  const content = ` ${truncateToWidth(title, Math.max(1, width - 3), "…")} `;
  const rest = Math.max(0, width - visibleWidth(content));
  return `${theme.fg("border", "╭")}${theme.fg("border", "─").repeat(Math.floor(rest / 2))}${theme.fg("text", content)}${theme.fg("border", "─").repeat(Math.ceil(rest / 2))}${theme.fg("border", "╮")}`;
}

function layoutRow(left: string, right: string, width: number): string {
  const gap = width - visibleWidth(left) - visibleWidth(right);
  if (gap > 0) return `${left}${" ".repeat(gap)}${right}`;
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
