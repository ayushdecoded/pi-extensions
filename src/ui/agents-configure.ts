import type { KeybindingsManager, Theme } from "@earendil-works/pi-coding-agent";
import type { Component, TUI } from "@earendil-works/pi-tui";
import { isKeyRelease, Key, matchesKey, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

export type AgentModelRoleChoice = {
  name: string;
  model: string;
  configuredModel: string;
  thinking: string;
};

export type AgentModelChoice = {
  provider: string;
  providerLabel: string;
  id: string;
  name: string;
};

export type AgentModelConfigureResult =
  | { role: string; model: string }
  | { role: string; reset: true }
  | undefined;

export type AgentModelConfigureInput = {
  roles: AgentModelRoleChoice[];
  scopedModels: AgentModelChoice[];
  allModels: AgentModelChoice[];
};

type Stage = "roles" | "providers" | "models";
const PANEL_WIDTH = 84;

/** Role → provider → model picker. Tab toggles Pi's scoped models and all available models. */
export class AgentModelConfigurePanel implements Component {
  private stage: Stage = "roles";
  private index = 0;
  private role?: AgentModelRoleChoice;
  private provider?: string;
  private all = false;
  private search = "";

  constructor(
    private readonly input: AgentModelConfigureInput,
    private readonly tui: TUI,
    private readonly theme: Theme,
    private readonly keybindings: KeybindingsManager,
    private readonly done: (result: AgentModelConfigureResult) => void,
  ) {}

  handleInput(data: string): void {
    if (isKeyRelease(data)) return;
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
      } else if (this.stage === "providers") {
        this.stage = "roles";
        this.role = undefined;
      } else {
        this.done(undefined);
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
    const items = this.items();
    const bodyHeight = Math.max(4, Math.min(10, this.tui.terminal.rows - 7));
    const start = windowStart(this.index, items.length, bodyHeight);
    const scope = this.scopeIsEffective() ? (this.all ? "all" : "scoped") : "all";
    const title = this.stage === "roles" ? "roles" : this.stage === "providers" ? `providers · ${this.role?.name ?? "role"}` : `models · ${this.providerLabel()}`;
    const lines = [joinSides(this.theme.fg("accent", "Configure subagents"), this.theme.fg("dim", `${scope} models`), panelWidth)];
    lines.push(frameTop(title, inner, this.theme));
    for (let itemIndex = start; itemIndex < Math.min(items.length, start + bodyHeight); itemIndex += 1) {
      lines.push(`${this.theme.fg("border", "│")}${padLine(this.renderItem(items[itemIndex]!, itemIndex === this.index, inner), inner)}${this.theme.fg("border", "│")}`);
    }
    while (lines.length < bodyHeight + 2) lines.push(`${this.theme.fg("border", "│")}${" ".repeat(inner)}${this.theme.fg("border", "│")}`);
    lines.push(`${this.theme.fg("border", "╰")}${this.theme.fg("border", "─").repeat(inner)}${this.theme.fg("border", "╯")}`);
    const search = this.stage === "models" && this.search ? ` · filter: ${this.search}` : "";
    lines.push(`  ${this.theme.fg("dim", `↑↓ select · ↵ confirm · Tab ${this.all ? "scoped" : "all"} · esc ${this.stage === "roles" ? "cancel" : "back"}${search}`)}`);
    return lines.map((line) => truncateToWidth(line, panelWidth, ""));
  }

  invalidate(): void {}

  private items(): Array<AgentModelRoleChoice | AgentModelChoice | { reset: true } | { provider: string; label: string }> {
    if (this.stage === "roles") return this.input.roles;
    if (this.stage === "providers") {
      const providers: Array<{ provider: string; label: string }> = [];
      const seen = new Set<string>();
      for (const model of this.models()) {
        if (seen.has(model.provider)) continue;
        seen.add(model.provider);
        providers.push({ provider: model.provider, label: model.providerLabel });
      }
      providers.sort((left, right) => left.label.localeCompare(right.label));
      return [...(this.role && this.role.model !== this.role.configuredModel ? [{ reset: true as const }] : []), ...providers];
    }
    const query = this.search.toLowerCase();
    return this.models()
      .filter((model) => model.provider === this.provider)
      .filter((model) => !query || `${model.name} ${model.id}`.toLowerCase().includes(query))
      .sort((left, right) => left.name.localeCompare(right.name));
  }

  private renderItem(item: ReturnType<AgentModelConfigurePanel["items"]>[number], selected: boolean, width: number): string {
    const lead = `${selected ? this.theme.fg("accent", "→") : " "} `;
    if ("configuredModel" in item) {
      const right = `${item.model.split("/").at(-1)} · ${item.thinking}`;
      return layoutRow(`${lead}${this.theme.fg("text", item.name)}`, this.theme.fg(item.model === item.configuredModel ? "dim" : "accent", right), width);
    }
    if ("reset" in item) return `${lead}${this.theme.fg("accent", "↺")} ${this.theme.fg("text", "Reset to configured model")}`;
    if ("label" in item) {
      const count = this.models().filter((model) => model.provider === item.provider).length;
      return layoutRow(`${lead}${this.theme.fg("text", item.label)}`, this.theme.fg("dim", `${count} ${count === 1 ? "model" : "models"}`), width);
    }
    const current = this.role?.model === `${item.provider}/${item.id}`;
    return layoutRow(`${lead}${this.theme.fg("text", item.name)}`, this.theme.fg(current ? "accent" : "dim", current ? "selected" : item.id), width);
  }

  private confirm(): void {
    const item = this.items()[this.index];
    if (!item) return;
    if (this.stage === "roles" && "configuredModel" in item) {
      this.role = item;
      this.stage = "providers";
      this.index = 0;
      return;
    }
    if (this.stage === "providers") {
      if ("reset" in item) {
        if (this.role) this.done({ role: this.role.name, reset: true });
        return;
      }
      if ("label" in item) {
        this.provider = item.provider;
        this.stage = "models";
        this.index = Math.max(0, this.items().findIndex((model) => "id" in model && this.role?.model === `${model.provider}/${model.id}`));
      }
      return;
    }
    if ("id" in item && this.role) this.done({ role: this.role.name, model: `${item.provider}/${item.id}` });
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

  private providerLabel(): string {
    return this.models().find((model) => model.provider === this.provider)?.providerLabel ?? this.provider ?? "provider";
  }

  private cancelled(data: string): boolean {
    return this.keybindings.matches(data, "tui.select.cancel") || matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl("c"));
  }
}

export async function showAgentModelConfigure(
  ctx: { mode: string; ui: { custom: Function } },
  input: AgentModelConfigureInput,
): Promise<AgentModelConfigureResult> {
  if (ctx.mode !== "tui" || input.roles.length === 0 || input.allModels.length === 0) return undefined;
  return ctx.ui.custom(
    (tui: TUI, theme: Theme, keybindings: KeybindingsManager, done: (result: AgentModelConfigureResult) => void) =>
      new AgentModelConfigurePanel(input, tui, theme, keybindings, done),
    { overlay: true, overlayOptions: { width: PANEL_WIDTH, minWidth: 28, maxHeight: "80%", anchor: "center", margin: 1 } },
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
