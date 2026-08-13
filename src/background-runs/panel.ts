import type { KeybindingsManager, Theme } from "@earendil-works/pi-coding-agent";
import type { Component, TUI } from "@earendil-works/pi-tui";
import { isKeyRelease, matchesKey, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { BackgroundRunRecord, BackgroundRunStatus } from "./types.ts";
import type { BackgroundRunRegistry } from "./registry.ts";
import { formatDuration } from "../ui/panel.ts";
import { joinWithDotLeader } from "../ui/leaders.ts";

type Mode = "list" | "viewer";

/**
 * `/ps` overlay: list background runs with the usual movement controls, Enter to
 * inspect output, `x` to kill the selected run, Esc to close.
 */
export class ProcessesPanel implements Component {
  private mode: Mode = "list";
  private selectedIndex = 0;
  private scroll = 0;
  private viewerRunId?: string;
  private readonly unsubscribe: () => void;
  private timer?: NodeJS.Timeout;

  constructor(
    private readonly registry: BackgroundRunRegistry,
    private readonly tui: TUI,
    private readonly theme: Theme,
    private readonly keybindings: KeybindingsManager,
    private readonly done: () => void,
  ) {
    this.unsubscribe = registry.subscribe(() => {
      this.syncClock();
      this.tui.requestRender();
    });
    this.syncClock();
  }

  handleInput(data: string): void {
    if (isKeyRelease(data)) return;
    if (this.keybindings.matches(data, "tui.select.cancel") || matchesKey(data, "escape") || matchesKey(data, "ctrl+c")) {
      if (this.mode === "viewer") {
        this.mode = "list";
        this.scroll = 0;
        this.tui.requestRender();
      } else {
        this.done();
      }
      return;
    }
    if (this.mode === "viewer") {
      this.handleViewerInput(data);
      return;
    }
    const count = this.ordered().length;
    if (this.keybindings.matches(data, "tui.select.up") || data === "k") this.selectedIndex = Math.max(0, this.selectedIndex - 1);
    else if (this.keybindings.matches(data, "tui.select.down") || data === "j") this.selectedIndex = Math.min(Math.max(0, count - 1), this.selectedIndex + 1);
    else if (this.keybindings.matches(data, "tui.select.pageUp")) this.selectedIndex = Math.max(0, this.selectedIndex - Math.max(1, this.tui.terminal.rows - 8));
    else if (this.keybindings.matches(data, "tui.select.pageDown")) this.selectedIndex = Math.min(Math.max(0, count - 1), this.selectedIndex + Math.max(1, this.tui.terminal.rows - 8));
    else if (matchesKey(data, "home")) this.selectedIndex = 0;
    else if (matchesKey(data, "end")) this.selectedIndex = Math.max(0, count - 1);
    else if (this.keybindings.matches(data, "tui.select.confirm")) this.openSelected();
    else if (data === "x" || data === "X") this.killSelected();
    this.tui.requestRender();
  }

  render(width: number): string[] {
    const height = Math.max(8, this.tui.terminal.rows - 2);
    const lines = this.mode === "viewer" ? this.renderViewer(width, height) : this.renderList(width, height);
    return lines.map((line) => (visibleWidth(line) <= width ? line : truncateToWidth(line, width)));
  }

  invalidate(): void {}

  dispose(): void {
    this.unsubscribe();
    if (this.timer) clearTimeout(this.timer);
  }

  private renderList(width: number, height: number): string[] {
    const records = this.ordered();
    this.selectedIndex = clamp(this.selectedIndex, records.length);
    const now = Date.now();
    const rows = records.map((record, index) => this.listRow(record, index === this.selectedIndex, now, width - 2));
    // Recent first with a blank line between runs.
    const display: string[] = [];
    for (const row of rows) display.push(row, "");
    if (display.length) display.pop();
    const bodyHeight = Math.max(1, height - 4);
    const start = windowStart(this.selectedIndex * 2, display.length, bodyHeight);
    const body = display.slice(start, start + bodyHeight);
    if (!body.length) body.push(this.theme.fg("dim", "  No background runs yet. Launch one with bash({ background: true })."));
    while (body.length < bodyHeight) body.push("");
    const innerWidth = Math.max(0, width - 2);
    const count = `${records.length} ${records.length === 1 ? "run" : "runs"}`;
    return [
      joinSides(`  ${this.theme.fg("accent", "Background runs")}`, `${this.theme.fg("muted", count)}  `, width),
      frameTop("all background runs", innerWidth, this.theme),
      ...body.map((row) => `${this.theme.fg("border", "│")}${padLine(row, innerWidth)}${this.theme.fg("border", "│")}`),
      this.theme.fg("border", `╰${"─".repeat(innerWidth)}╯`),
      truncateToWidth(this.theme.fg("dim", "  ↑↓ select · Enter output · x kill · Esc close"), width),
    ].slice(0, height);
  }

  private listRow(record: BackgroundRunRecord, selected: boolean, now: number, width: number): string {
    const marker = selected ? this.theme.fg("accent", "❯") : " ";
    const glyph = this.theme.fg(statusColor(record.status), statusGlyph(record.status));
    const id = this.theme.fg("dim", shortId(record.id));
    const left = ` ${marker} ${glyph} ${id}`;
    // Detached runs are still alive after a reload, so they render like running
    // runs (bright, ◐) with a dim "untracked" tag; everything settled recedes
    // into muted text while its status icon keeps its color.
    const live = record.status === "running" || record.status === "detached";
    const label = record.status === "detached" ? "running" : record.status;
    const statusWord = live
      ? this.theme.fg(statusColor(record.status), label)
      : this.theme.fg("muted", record.status);
    const rightParts = [
      statusWord,
      ...(record.status === "detached" ? [this.theme.fg("dim", "untracked")] : []),
      this.theme.fg("muted", formatDuration((record.finishedAt ?? now) - record.startedAt)),
      ...(record.exitCode !== undefined && record.exitCode !== null ? [this.theme.fg("muted", `exit ${record.exitCode}`)] : []),
    ];
    const right = `${rightParts.join(this.theme.fg("dim", " · "))} `;
    const commandText = record.command.replace(/\s+/g, " ").trim();
    const command = live ? this.theme.fg("text", commandText) : this.theme.fg("muted", commandText);
    return joinWithDotLeader(`${left}  ${command}`, right, width, this.theme);
  }

  private renderViewer(width: number, height: number): string[] {
    const record = this.registry.get(this.viewerRunId ?? "");
    if (!record) {
      this.mode = "list";
      return this.renderList(width, height);
    }
    const now = Date.now();
    const logs = this.registry.logs(record.id);
    const outputLines = record.status === "detached"
      ? [this.theme.fg("dim", "Untracked after reload — output is no longer captured.")]
      : (logs?.tail ?? "(no output)").split("\n");
    const bodyHeight = Math.max(1, height - 6);
    const maxScroll = Math.max(0, outputLines.length - bodyHeight);
    this.scroll = Math.min(this.scroll, maxScroll);
    const body = outputLines.slice(this.scroll, this.scroll + bodyHeight);
    const innerWidth = Math.max(0, width - 2);
    const header = [
      joinSides(`  ${this.theme.fg("accent", `Background run · ${shortId(record.id)}`)}`, `${this.theme.fg("muted", formatDuration((record.finishedAt ?? now) - record.startedAt))}  `, width),
      frameTop(record.command, innerWidth, this.theme),
      `${this.theme.fg("border", "│")} ${this.theme.fg(statusColor(record.status), statusGlyph(record.status))} ${this.theme.fg("text", record.status)}${exitLabel(record, this.theme)}${record.error ? `  ${this.theme.fg("warning", record.error)}` : ""}  ${this.theme.fg("border", "│")}`,
      this.theme.fg("border", `├${"─".repeat(innerWidth)}┤`),
    ];
    const rows = body.map((line) => `${this.theme.fg("border", "│")} ${this.theme.fg("dim", line)}${" ".repeat(Math.max(0, innerWidth - 1 - visibleWidth(line)))}${this.theme.fg("border", "│")}`);
    while (rows.length < bodyHeight) rows.push(`${this.theme.fg("border", "│")}${" ".repeat(innerWidth)}${this.theme.fg("border", "│")}`);
    return [
      ...header,
      ...rows,
      this.theme.fg("border", `╰${"─".repeat(innerWidth)}╯`),
      truncateToWidth(this.theme.fg("dim", "  ↑↓ scroll · Esc back"), width),
    ].slice(0, height);
  }

  private handleViewerInput(data: string): void {
    const page = Math.max(1, this.tui.terminal.rows - 8);
    if (this.keybindings.matches(data, "tui.select.up") || data === "k") this.scroll = Math.max(0, this.scroll - 1);
    else if (this.keybindings.matches(data, "tui.select.down") || data === "j") this.scroll += 1;
    else if (this.keybindings.matches(data, "tui.select.pageUp")) this.scroll = Math.max(0, this.scroll - page);
    else if (this.keybindings.matches(data, "tui.select.pageDown")) this.scroll += page;
    else if (matchesKey(data, "home")) this.scroll = 0;
    else if (matchesKey(data, "end")) this.scroll = Number.MAX_SAFE_INTEGER;
    this.tui.requestRender();
  }

  private openSelected(): void {
    const record = this.ordered()[this.selectedIndex];
    if (!record) return;
    this.viewerRunId = record.id;
    this.scroll = 0;
    this.mode = "viewer";
    this.tui.requestRender();
  }

  private killSelected(): void {
    const record = this.ordered()[this.selectedIndex];
    if (!record || (record.status !== "running" && record.status !== "detached")) return;
    this.registry.kill(record.id);
    // The registry subscription re-renders the panel.
  }

  /** Recent runs first. */
  private ordered(): BackgroundRunRecord[] {
    return [...this.registry.list()].reverse();
  }

  private syncClock(): void {
    const active = this.registry.activeCount() > 0;
    if (active && !this.timer) this.timer = setInterval(() => this.tui.requestRender(), 1_000);
    if (!active && this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }
}

function statusColor(status: BackgroundRunStatus): "success" | "warning" | "error" | "dim" {
  switch (status) {
    case "complete": return "success";
    case "running":
    case "detached": return "warning";
    default: return "error";
  }
}

function statusGlyph(status: BackgroundRunStatus): string {
  switch (status) {
    case "running":
    case "detached": return "◐";
    case "complete": return "✓";
    case "cancelled": return "−";
    default: return "!";
  }
}

function exitLabel(record: BackgroundRunRecord, theme: Theme): string {
  if (record.exitCode === undefined || record.exitCode === null) return "";
  return `  ${theme.fg("muted", `exit ${record.exitCode}`)}`;
}

function shortId(id: string): string {
  return id.length > 8 ? id.slice(0, 8) : id;
}

function clamp(index: number, length: number): number {
  return Math.max(0, Math.min(index, Math.max(0, length - 1)));
}

function windowStart(index: number, total: number, room: number): number {
  return Math.max(0, Math.min(index - Math.floor(room / 2), Math.max(0, total - room)));
}

function padLine(value: string, width: number): string {
  const clipped = truncateToWidth(value, Math.max(0, width), "");
  return clipped + " ".repeat(Math.max(0, width - visibleWidth(clipped)));
}

function joinSides(left: string, right: string, width: number): string {
  const safeWidth = Math.max(0, width);
  if (!right) return truncateToWidth(left, safeWidth, "");
  const gap = safeWidth - visibleWidth(left) - visibleWidth(right);
  return gap >= 2 ? `${left}${" ".repeat(gap)}${right}` : truncateToWidth(left, safeWidth, "");
}

function frameTop(title: string, innerWidth: number, theme: Theme): string {
  const text = innerWidth >= 4 ? ` ${truncateToWidth(title, Math.max(0, innerWidth - 3))} ` : "";
  const titleWidth = visibleWidth(text);
  return `${theme.fg("border", "╭")}${theme.fg("border", "─")}${theme.fg("text", text)}${theme.fg("border", "─".repeat(Math.max(0, innerWidth - 1 - titleWidth)))}${theme.fg("border", "╮")}`;
}
