import { getMarkdownTheme, keyHint, type ExtensionContext, type Theme, type ToolDefinition, type MessageRenderer } from "@earendil-works/pi-coding-agent";
import { Markdown, Text, truncateToWidth, visibleWidth, type Component, type TUI } from "@earendil-works/pi-tui";
import type { AgentRecord, Report, Subagents } from "./runtime.ts";
import { displayTitle, parseTitle } from "./title.ts";

const clean = (text: string) => text.replace(/[\x00-\x1f\x7f-\x9f]/g, " ");
const seconds = (record: AgentRecord) => {
  const value = Math.max(0, Math.floor(((record.finishedAt ?? Date.now()) - (record.startedAt ?? Date.now())) / 1000));
  return value < 60 ? `${value}s` : `${Math.floor(value / 60)}m ${value % 60}s`;
};
const color = (record: Pick<AgentRecord, "status">) => record.status === "running" ? "warning" : record.status === "completed" ? "success" : "error";
const icon = (record: Pick<AgentRecord, "status">) => record.status === "running" ? "●" : record.status === "completed" ? "✓" : "×";
const fit = (text: string, width: number) => truncateToWidth(text, Math.max(0, width));
// Compact token counts: exact below 1,000, then one decimal for larger thousands and
// millions without a trailing ".0" (4102 -> "4k tokens", 1200000 -> "1.2M tokens").
export function formatTokens(total: number): string {
  const value = Number.isFinite(total) ? Math.max(0, Math.floor(total)) : 0;
  if (value < 1_000) return `${value} tokens`;
  const units = [
    { limit: 1_000_000, divisor: 1_000, suffix: "k" },
    { limit: 1_000_000_000, divisor: 1_000_000, suffix: "M" },
    { limit: Infinity, divisor: 1_000_000_000, suffix: "B" },
  ];
  for (let index = 0; index < units.length; index++) {
    const { limit, divisor, suffix } = units[index];
    if (value >= limit) continue;
    // Single-digit thousands round to a whole "k" so 4,102 reads as "4k".
    const scaled = divisor === 1_000 && value < 10_000
      ? Math.round(value / divisor)
      : Math.round((value / divisor) * 10) / 10;
    // Rounding across a unit boundary (999,950 -> 1,000k) rolls into the next unit.
    if (scaled >= limit / divisor && index + 1 < units.length) continue;
    return `${Number.isInteger(scaled) ? scaled : scaled.toFixed(1)}${suffix} tokens`;
  }
  return `${value} tokens`;
}
function orderedRecords(runtime: Subagents) {
  const all = [...runtime.records.values()];
  return all.filter(record => record.owner === runtime.root).flatMap(record => [record, ...all.filter(child => child.owner === record.handle)]);
}

// Finished rows linger briefly so a just-finished agent is still readable, then the
// widget forgets them (the runtime records and handles remain untouched).
export const FINISHED_TTL_MS = 120_000;
function isWidgetEligible(record: AgentRecord, now: number): boolean {
  return record.status === "running" || (record.finishedAt !== undefined && now - record.finishedAt < FINISHED_TTL_MS);
}
export function hasWidgetContent(runtime: Subagents, now = Date.now()): boolean {
  return orderedRecords(runtime).some(record => isWidgetEligible(record, now));
}

export function agentRows(record: AgentRecord, theme: Theme, width: number): string[] {
  const indent = record.depth === 2 ? "  ↳ " : "";
  const label = `  ${indent}${theme.fg(color(record), icon(record))} ${theme.fg("accent", record.agent)}`;
  const right = `${record.status} · ${seconds(record)}`;
  const title = displayTitle(record);
  const header = width >= 55
    ? `${fit(`${label}  ${title}`, width - visibleWidth(right) - 3)}${" ".repeat(Math.max(2, width - visibleWidth(fit(`${label}  ${title}`, width - visibleWidth(right) - 3)) - visibleWidth(right)))}${theme.fg("dim", right)}`
    : `${label}  ${theme.fg("dim", right)}`;
  const detail = record.activity || (record.report ? `${formatTokens(record.report.usage.totalTokens)} · $${record.report.usage.cost.total.toFixed(3)}` : record.status);
  return [fit(header, width), fit(`    ${indent}${theme.fg("muted", width >= 55 ? clean(detail) : title)}`, width)];
}

export function widgetLines(runtime: Subagents, theme: Theme, width: number, now = Date.now()): string[] {
  const all = orderedRecords(runtime);
  // Visibility and rows are limited to running/recent rows; the summary reflects the whole session.
  const eligible = all.filter(record => isWidgetEligible(record, now));
  if (!eligible.length) return [];
  const running = all.filter(record => record.status === "running");
  const completed = all.filter(record => record.status === "completed").length;
  const stopped = all.length - running.length - completed;
  const summary = `AGENTS  ${running.length} running · ${completed} done${stopped ? ` · ${stopped} stopped` : ""}`;
  const hint = runtime.widgetCollapsed ? "Alt+M expand" : "Alt+M collapse";
  const heading = fit(theme.fg("muted", `${summary}   ${hint}`), width);
  if (runtime.widgetCollapsed) return [heading];
  // Finished rows never displace running work; nested rows keep their "↳" even when an ancestor expired.
  const ordered = [...eligible.filter(record => record.status === "running"), ...eligible.filter(record => record.status !== "running")];
  const visible = ordered.slice(0, 5);
  const hidden = ordered.length - visible.length;
  return ["", heading, "", ...visible.flatMap(record => agentRows(record, theme, width)),
    ...(hidden > 0 ? [fit(theme.fg("dim", `  +${hidden} more`), width)] : []), ""];
}

export function installWidget(ctx: ExtensionContext, runtime: Subagents) {
  if (ctx.mode !== "tui") return;
  ctx.ui.setWidget("subagents", (tui, theme) => new LiveView(tui, runtime, width => widgetLines(runtime, theme, width)), { placement: "aboveEditor" });
}
class LiveView implements Component {
  private unsubscribe: () => void;
  private timer: ReturnType<typeof setInterval>;
  private hadContent = true;
  constructor(tui: TUI, runtime: Subagents, private draw: (width: number) => string[]) {
    this.unsubscribe = runtime.subscribe(() => tui.requestRender());
    // Keep ticking after jobs stop so recently finished rows can expire on their own;
    // once the widget is empty (and no work runs) the loop goes quiet until a change wakes it.
    this.timer = setInterval(() => {
      const content = hasWidgetContent(runtime);
      if (runtime.jobs.size || content || this.hadContent) tui.requestRender();
      this.hadContent = content;
    }, 1000);
  }
  render(width: number) { return this.draw(width); }
  invalidate() {}
  dispose() { clearInterval(this.timer); this.unsubscribe(); }
}

// Presentation only: the complete report and session path still reach the model.
export const renderCompletion: MessageRenderer<Report> = (message, { expanded, outputPad }, theme) => {
  const report = message.details;
  if (!report || typeof report.text !== "string" || typeof report.agent !== "string") {
    return new Text(typeof message.content === "string" ? message.content : "Agent completed", outputPad, 0);
  }
  const title = parseTitle(report.title ?? "");
  const heading = `${theme.fg(color(report), icon(report))} ${theme.fg("accent", theme.bold(report.agent))}${title ? `  ${title}` : ""}  ${theme.fg("dim", report.status)}`;
  const body = new Markdown(report.text, 0, 0, getMarkdownTheme());
  return {
    render(width) {
      const padding = Math.min(outputPad, Math.max(0, Math.floor((width - 1) / 2)));
      const innerWidth = Math.max(1, width - padding * 2);
      const rendered = body.render(innerWidth);
      const lines = [fit(heading, innerWidth), "", ...(expanded ? rendered : rendered.slice(0, 6))];
      if (!expanded) lines.push("", fit(theme.fg("dim", keyHint("app.tools.expand", "details")), innerWidth));
      else lines.push("", ...new Text(theme.fg("dim", [
        `Handle: ${report.handle}`, `Session: ${report.sessionFile ?? "not saved"}`,
        `${formatTokens(report.usage.totalTokens)} · $${report.usage.cost.total.toFixed(3)}`,
      ].join("\n")), 0, 0).render(innerWidth));
      return lines.map(line => fit(" ".repeat(padding) + line, width));
    }, invalidate() { body.invalidate(); },
  };
};

export const renderCall: NonNullable<ToolDefinition["renderCall"]> = (args, theme) => {
  const input = args as { action?: string; agents?: { agent?: string; handle?: string }[]; background?: boolean };
  const names = input.agents?.map(item => item.agent || "follow-up").join(", ") || input.action || "status";
  return new Text(`${theme.fg("toolTitle", theme.bold("Agents"))}  ${clean(names)}${input.agents ? theme.fg("dim", input.background === false ? " · waiting" : " · background") : ""}`, 0, 0);
};
export const renderResult: NonNullable<ToolDefinition["renderResult"]> = (result, { expanded, isPartial }, theme) => {
  const data = result.details as { agents?: AgentRecord[]; background?: boolean } | undefined;
  if (!data?.agents) return new Text(result.content.map(block => block.type === "text" ? block.text : "").join("\n"), 0, 0);
  return {
    render(width) {
      const rows = data.background
        ? [fit(theme.fg("muted", `Launched ${data.agents!.length} in background · completions arrive individually`), width)]
        : data.agents!.flatMap(record => agentRows(record, theme, width));
      if (expanded) for (const record of data.agents!) {
        rows.push(fit(theme.fg("dim", `    ${record.handle}`), width));
        if (record.report) rows.push(...new Markdown(record.report.text, 1, 0, getMarkdownTheme()).render(width));
      }
      if (isPartial) rows.push(fit(theme.fg("dim", "  Running…"), width));
      return rows.map(line => fit(line, width));
    }, invalidate() {},
  };
};
