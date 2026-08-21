import type { KeybindingsManager, Theme } from "@earendil-works/pi-coding-agent";
import type { Component, TUI } from "@earendil-works/pi-tui";
import { isKeyRelease, Key, matchesKey, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { agentModelLabel, THINKING_LEVELS, type AgentBackend, type ThinkingLevel } from "../config/agents.ts";

export type AgentConfigureScope = "session" | "project" | "global";

export type AgentModelRoleChoice = {
  name: string;
  model: string;
  thinking: string;
  configuredModel: string;
  configuredThinking: string;
  backend: AgentBackend;
  configuredBackend: AgentBackend;
  backendOptions: AgentBackend[];
};

export type AgentModelChoice = {
  provider: string;
  providerLabel: string;
  id: string;
  name: string;
  /** False when the provider has no configured credentials; the model still shows, marked. */
  available?: boolean;
};

/** One confirmed edit. Callers persist it immediately. */
export type AgentRoleConfigureChange =
  | { kind: "model"; model: string }
  | { kind: "thinking"; thinking: ThinkingLevel }
  | { kind: "backend"; backend: AgentBackend }
  | { kind: "reset-model" }
  | { kind: "reset-thinking" }
  | { kind: "reset-backend" };

export type AgentModelConfigureInput = {
  /** Active preset name. Shown in the header; persistence is scoped to it. */
  mode?: string;
  scope?: AgentConfigureScope;
  roles: AgentModelRoleChoice[];
  scopedModels: AgentModelChoice[];
  allModels: AgentModelChoice[];
};

type Stage = "roles" | "settings" | "providers" | "models" | "thinking" | "backends";
type Item =
  | { kind: "role"; role: AgentModelRoleChoice }
  | { kind: "setting"; setting: "model" | "thinking" | "backend" | "reset-model" | "reset-thinking" | "reset-backend" | "done" }
  | { kind: "provider"; provider: string; label: string }
  | { kind: "model"; choice: AgentModelChoice }
  | { kind: "thinking"; level: ThinkingLevel }
  | { kind: "backend"; backend: AgentBackend }
  | { kind: "save" }
  | { kind: "reload" };

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
  private readonly effective = new Map<string, { model: string; thinking: string; backend: AgentBackend }>();

  constructor(
    private readonly input: AgentModelConfigureInput,
    private readonly tui: TUI,
    private readonly theme: Theme,
    private readonly keybindings: KeybindingsManager,
    private readonly onChange: (role: string, change: AgentRoleConfigureChange) => void,
    private readonly done: () => void,
    private readonly onScopeChange: (scope: AgentConfigureScope) => void = () => {},
    private readonly onSaveAll: (scope: AgentConfigureScope) => void = () => {},
    private readonly onReload: () => void = () => {},
  ) {
    this.scope = input.scope ?? "session";
    for (const role of input.roles) this.effective.set(role.name, { model: role.model, thinking: role.thinking, backend: role.backend });
  }

  handleInput(data: string): void {
    if (isKeyRelease(data)) return;
    if (matchesKey(data, Key.ctrl("s")) || matchesKey(data, Key.left) || matchesKey(data, Key.right)) {
      const delta = matchesKey(data, Key.left) ? -1 : 1;
      this.cycleScope(delta);
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
      } else if (this.stage === "providers" || this.stage === "thinking" || this.stage === "backends") {
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
    } else if (/^[1-9]$/.test(data)) {
      // Digits type into the model filter above; elsewhere they jump + confirm.
      const target = Number(data) - 1;
      if (target < this.items().length) {
        this.index = target;
        this.confirm();
        this.tui.requestRender();
      }
      return;
    } else if (this.stage === "roles" && data === "r") {
      this.onReload();
      return;
    } else if (this.stage === "roles" || this.stage === "settings") {
      if (this.quickRoleAction(data)) return;
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
    const scopeBadge = this.theme.fg(this.scope === "session" ? "dim" : "warning", `scope: ${this.scope}`);
    const headerRight = [modePart ? this.theme.fg("dim", modePart) : undefined, scopeBadge, this.theme.fg("dim", `${scope} models`)].filter(Boolean).join(this.theme.fg("border", " · "));
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

  private cycleScope(delta: 1 | -1): void {
    const scopes: AgentConfigureScope[] = ["session", "project", "global"];
    this.scope = scopes[(scopes.indexOf(this.scope) + delta + scopes.length) % scopes.length]!;
    if (this.scope !== "session" && this.stage === "backends") {
      this.stage = "settings";
      this.index = 0;
    }
    this.onScopeChange(this.scope);
    this.tui.requestRender();
  }

  /** m/t/b act on the highlighted role straight from the roles list. */
  private quickRoleAction(data: string): boolean {
    const name = this.stage === "roles"
      ? this.items()[this.index]?.kind === "role" ? (this.items()[this.index] as { role: AgentModelRoleChoice }).role.name : undefined
      : this.role?.name;
    if (!name) return false;
    const role = this.input.roles.find((candidate) => candidate.name === name);
    if (!role) return false;
    if (data === "m") {
      this.role = role;
      this.stage = "providers";
    } else if (data === "t") {
      this.role = role;
      this.stage = "thinking";
      const current = this.effective.get(name)?.thinking ?? role.thinking;
      this.index = Math.max(0, THINKING_LEVELS.findIndex((level) => level === current));
    } else if (data === "b" && this.scope === "session" && role.backendOptions.length > 1) {
      this.role = role;
      this.stage = "backends";
      const current = this.effective.get(name)?.backend ?? role.backend;
      this.index = Math.max(0, role.backendOptions.findIndex((backend) => backend === current));
    } else {
      return false;
    }
    return true;
  }

  private items(): Item[] {
    if (this.stage === "roles") return [...this.input.roles.map((role) => ({ kind: "role", role }) as Item), { kind: "save" }, { kind: "reload" }];
    if (this.stage === "settings") {
      const role = this.role;
      if (!role) return [];
      const current = this.effective.get(role.name) ?? { model: role.model, thinking: role.thinking, backend: role.backend };
      const items: Item[] = [{ kind: "setting", setting: "model" }, { kind: "setting", setting: "thinking" }];
      if (this.scope === "session" && role.backendOptions.length > 1) items.push({ kind: "setting", setting: "backend" });
      if (current.model !== role.configuredModel) items.push({ kind: "setting", setting: "reset-model" });
      if (current.thinking !== role.configuredThinking) items.push({ kind: "setting", setting: "reset-thinking" });
      if (this.scope === "session" && current.backend !== role.configuredBackend) items.push({ kind: "setting", setting: "reset-backend" });
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
    if (this.stage === "backends") {
      return (this.role?.backendOptions ?? []).map((backend) => ({ kind: "backend", backend }));
    }
    const query = this.search.toLowerCase();
    return this.models()
      .filter((model) => model.provider === this.provider)
      .filter((model) => !query || `${model.name} ${model.id}`.toLowerCase().includes(query))
      .sort((left, right) => left.name.localeCompare(right.name))
      .map((choice) => ({ kind: "model", choice }));
  }

  private renderItem(item: Item, selected: boolean, width: number): string {
    const lead = `${selected ? this.theme.fg("accent", "▸") : " "} `;
    if (item.kind === "save") {
      return layoutRow(`${lead}${this.theme.fg("success", "💾")} ${this.theme.fg(selected ? "accent" : "text", "Save all roles")}`, this.theme.fg("dim", `→ ${this.scope}`), width);
    }
    if (item.kind === "reload") {
      return layoutRow(`${lead}${this.theme.fg(selected ? "accent" : "warning", "↻")} ${this.theme.fg(selected ? "accent" : "text", "Reload configs")}`, this.theme.fg("dim", "yaml + overrides"), width);
    }
    if (item.kind === "role") {
      const current = this.effective.get(item.role.name) ?? { model: item.role.model, thinking: item.role.thinking, backend: item.role.backend };
      const overridden = current.model !== item.role.configuredModel || current.thinking !== item.role.configuredThinking || current.backend !== item.role.configuredBackend;
      const dot = overridden ? `${this.theme.fg("warning", "●")} ` : "";
      const name = this.theme.fg(selected ? "accent" : "text", item.role.name);
      const right = `${current.backend} · ${agentModelLabel(current.model, current.backend)} · ${current.thinking}`;
      return layoutRow(`${lead}${dot}${name}`, this.theme.fg(overridden ? "accent" : "dim", right), width);
    }
    if (item.kind === "setting") {
      if (item.setting === "model") {
        const current = this.role ? this.effective.get(this.role.name)?.model ?? this.role.model : "";
        const backend = this.role ? this.effective.get(this.role.name)?.backend ?? this.role.backend : undefined;
        return layoutRow(`${lead}${this.theme.fg("text", "Model")}`, this.theme.fg("dim", agentModelLabel(current, backend)), width);
      }
      if (item.setting === "thinking") {
        const current = this.role ? this.effective.get(this.role.name)?.thinking ?? this.role.thinking : "";
        return layoutRow(`${lead}${this.theme.fg("text", "Thinking")}`, this.theme.fg("dim", current), width);
      }
      if (item.setting === "backend") {
        const current = this.role ? this.effective.get(this.role.name)?.backend ?? this.role.backend : "native";
        return layoutRow(`${lead}${this.theme.fg("text", "Backend")}`, this.theme.fg("dim", current), width);
      }
      if (item.setting === "reset-model") return `${lead}${this.theme.fg("accent", "↺")} ${this.theme.fg("text", "Reset model")}`;
      if (item.setting === "reset-thinking") return `${lead}${this.theme.fg("accent", "↺")} ${this.theme.fg("text", "Reset thinking")}`;
      if (item.setting === "reset-backend") return `${lead}${this.theme.fg("accent", "↺")} ${this.theme.fg("text", "Reset backend")}`;
      return `${lead}${this.theme.fg("success", "✓")} ${this.theme.fg("text", "Done")}`;
    }
    if (item.kind === "provider") {
      const count = this.models().filter((model) => model.provider === item.provider).length;
      return layoutRow(`${lead}${this.theme.fg("text", item.label)}`, this.theme.fg("dim", `${count} ${count === 1 ? "model" : "models"}`), width);
    }
    if (item.kind === "thinking") {
      const current = this.role ? this.effective.get(this.role.name)?.thinking : undefined;
      const chosen = item.level === current;
      return layoutRow(`${lead}${this.theme.fg(chosen ? "accent" : "text", item.level)}`, this.theme.fg(chosen ? "success" : "dim", chosen ? "✓ selected" : ""), width);
    }
    if (item.kind === "backend") {
      const current = this.role ? this.effective.get(this.role.name)?.backend : undefined;
      const chosen = item.backend === current;
      return layoutRow(`${lead}${this.theme.fg(chosen ? "accent" : "text", item.backend)}`, this.theme.fg(chosen ? "success" : "dim", chosen ? "✓ selected" : ""), width);
    }
    const current = this.role?.model === `${item.choice.provider}/${item.choice.id}`;
    const noAuth = item.choice.available === false;
    const right = current ? "✓ selected" : noAuth ? `${item.choice.id} · no auth` : item.choice.id;
    const rightColor = current ? "success" : noAuth ? "warning" : "dim";
    const nameColor = current ? "accent" : noAuth ? "dim" : "text";
    return layoutRow(`${lead}${this.theme.fg(nameColor, item.choice.name)}`, this.theme.fg(rightColor, right), width);
  }

  private confirm(): void {
    const item = this.items()[this.index];
    if (!item) return;
    if (item.kind === "save") {
      this.onSaveAll(this.scope);
      return;
    }
    if (item.kind === "reload") {
      this.onReload();
      return;
    }
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
      } else if (item.setting === "backend") {
        this.stage = "backends";
        const current = this.effective.get(role)?.backend ?? this.role!.backend;
        this.index = Math.max(0, (this.role?.backendOptions ?? []).findIndex((backend) => backend === current));
      } else if (item.setting === "reset-backend") {
        this.onChange(role, { kind: "reset-backend" });
        this.applyLocal(role, { kind: "reset-backend" });
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
    if (item.kind === "thinking") {
      const role = this.role?.name;
      if (!role) return;
      this.onChange(role, { kind: "thinking", thinking: item.level });
      this.applyLocal(role, { kind: "thinking", thinking: item.level });
      this.stage = "settings";
      this.index = 0;
      return;
    }
    const role = this.role?.name;
    if (!role) return;
    this.onChange(role, { kind: "backend", backend: item.backend });
    this.applyLocal(role, { kind: "backend", backend: item.backend });
    this.stage = "settings";
    this.index = 0;
  }

  private applyLocal(role: string, change: AgentRoleConfigureChange): void {
    const current = this.effective.get(role);
    if (!current) return;
    const configured = this.input.roles.find((candidate) => candidate.name === role);
    if (change.kind === "model") current.model = change.model;
    else if (change.kind === "thinking") current.thinking = change.thinking;
    else if (change.kind === "backend") current.backend = change.backend;
    else if (change.kind === "reset-model") current.model = configured?.configuredModel ?? current.model;
    else if (change.kind === "reset-thinking") current.thinking = configured?.configuredThinking ?? current.thinking;
    else if (change.kind === "reset-backend") current.backend = configured?.configuredBackend ?? current.backend;
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
    if (this.stage === "backends") return `backends · ${this.role?.name ?? "role"}`;
    return `models · ${this.models().find((model) => model.provider === this.provider)?.providerLabel ?? this.provider ?? "provider"}`;
  }

  private hint(): string {
    if (this.stage === "models") {
      const filter = this.search
        ? [this.hintSegment(`filter: ${this.search}`, "")]
        : [this.hintSegment("type", "to filter")];
      return [...filter, this.hintSegment("↑↓", "move"), this.hintSegment("↵", "select"), this.hintSegment("tab", this.all ? "scoped" : "all"), this.hintSegment("esc", "back")].join(this.theme.fg("border", " · "));
    }
    if (this.stage === "roles") {
      return [
        this.hintSegment("↑↓↵", "select"),
        this.hintSegment("1-9", "jump"),
        this.hintSegment("m/t", "quick edit"),
        this.hintSegment("←→", "scope"),
        this.hintSegment("r", "reload"),
        this.hintSegment("esc", "close"),
      ].join(this.theme.fg("border", " · "));
    }
    const segments = [this.hintSegment("↑↓", "move"), this.hintSegment("↵", "select"), this.hintSegment("←→", `scope: ${this.scope}`)];
    if (this.stage === "settings") {
      segments.push(this.hintSegment("m", "model"), this.hintSegment("t", "thinking"));
      if (this.scope === "session" && (this.role?.backendOptions.length ?? 0) > 1) segments.push(this.hintSegment("b", "backend"));
    }
    segments.push(this.hintSegment("esc", "back"));
    return segments.join(this.theme.fg("border", " · "));
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
  onChange: (role: string, change: AgentRoleConfigureChange) => void,
  onScopeChange: (scope: AgentConfigureScope) => void = () => {},
  onSaveAll: (scope: AgentConfigureScope) => void = () => {},
  onReload: () => void = () => {},
): Promise<void> {
  const hasBackendChoice = input.roles.some((role) => role.backendOptions.length > 1);
  if (ctx.mode !== "tui" || input.roles.length === 0 || (input.allModels.length === 0 && !hasBackendChoice)) return;
  await ctx.ui.custom(
    (tui: TUI, theme: Theme, keybindings: KeybindingsManager, done: () => void) =>
      new AgentModelConfigurePanel(input, tui, theme, keybindings, onChange, done, onScopeChange, onSaveAll, onReload),
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
