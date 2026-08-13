import type { Theme, ThemeColor } from "@earendil-works/pi-coding-agent";
import type { Component, TUI } from "@earendil-works/pi-tui";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { SubagentRuntime } from "../runtime/runtime.ts";
import type { InvocationRecord } from "../runtime/types.ts";
import { fitWithDotLeader } from "./leaders.ts";
import { projectBatches, type AgentNode, type BatchView, type DelegationCallNode } from "./projection.ts";
import { roleText, stripLeadingRoleNames } from "./roles.ts";

export class AgentsPanel implements Component {
  private readonly unsubscribe: () => void;
  private timer?: NodeJS.Timeout;
  constructor(
    private readonly runtime: SubagentRuntime,
    private readonly tui: TUI,
    private readonly theme: Theme,
    private readonly isMinimized: () => boolean = () => false,
  ) {
    this.unsubscribe = runtime.subscribe(() => tui.requestRender());
    this.syncTimer();
  }
  render(width: number): string[] {
    const now = Date.now();
    this.syncTimer(now);
    return renderPanel(this.runtime, this.theme, width, now, this.isMinimized());
  }
  invalidate(): void {}
  dispose(): void { this.unsubscribe(); if (this.timer) clearInterval(this.timer); }
  private syncTimer(now = Date.now()): void {
    const latest = projectBatches(this.runtime.state)[0];
    const recent = Boolean(latest && (latest.active || now - (latest.finishedAt ?? latest.startedAt) < 45_000));
    if (recent && !this.timer) this.timer = setInterval(() => this.tui.requestRender(), 1_000);
    if (!recent && this.timer) { clearInterval(this.timer); this.timer = undefined; }
  }
}

export function renderPanel(runtime: SubagentRuntime, theme: Theme, width: number, now: number, minimized = false): string[] {
  const batches = projectBatches(runtime.state);
  if (!batches.length) return [];
  const [latest] = batches;
  if (!latest) return [];
  const showLatest = latest.active || now - (latest.finishedAt ?? latest.startedAt) < 45_000;
  if (minimized) return showLatest ? renderBatchSummary(latest, theme, now, width) : [];
  const lines = showLatest ? renderBatchSummary(latest, theme, now, width) : [];
  if (latest.active) {
    latest.roots.forEach((root, index) => renderNode(lines, root, runtime, theme, width, now, "", index === latest.roots.length - 1));
  }
  if (lines.length) lines.push("");
  lines.push(theme.fg("dim", "See all agent batches in /agents"));
  return lines.map((line) => visibleWidth(line) <= Math.max(0, width) ? line : truncateToWidth(line, Math.max(0, width)));
}

function renderBatchSummary(batch: BatchView, theme: Theme, now: number, width: number): string[] {
  const status = batch.active ? theme.fg("warning", "◐") : batch.failed ? theme.fg("error", "!") : theme.fg("success", "✓");
  const roles = [...batch.roleCounts.entries()].map(([role, count]) => roleText(`${role}×${count}`, role, theme)).join(" · ");
  const heading = batch.rootCall?.heading
    ? theme.fg("accent", stripLeadingRoleNames(batch.rootCall.heading, [...batch.roleCounts.keys()]))
    : "";
  const agentCount = `${batch.invocations.length} ${batch.invocations.length === 1 ? "agent" : "agents"}`;
  const identity = width >= 64 && heading
    ? `Agents ${status}  ${heading}  ${agentCount}  ${roles}`
    : width >= 48 ? `Agents ${status}  ${agentCount}  ${roles}` : `Agents ${status}  ${batch.invocations.length}`;
  const totals = width >= 72
    ? `${formatTokens(batch.usage.total)}  ·  ${formatDuration((batch.finishedAt ?? now) - batch.startedAt)}  ·  ${costText(batch.usage.cost, theme)}`
    : width >= 38 ? `${formatDuration((batch.finishedAt ?? now) - batch.startedAt)}  ·  ${costText(batch.usage.cost, theme)}` : "";
  return [joinSides(identity, totals, width)];
}

function renderNode(lines: string[], node: AgentNode, runtime: SubagentRuntime, theme: Theme, width: number, now: number, prefix: string, last: boolean): void {
  const item = node.invocation;
  const connector = last ? "└─" : "├─";
  const followup = item.followup ? ` ${theme.fg("accent", "↻")}` : "";
  const runtimeActivity = runtime.activities.get(item.id);
  const detail = runtimeActivity?.tool
    ? `${runtimeActivity.tool}${(runtimeActivity.toolCount ?? 1) > 1 ? ` +${runtimeActivity.toolCount! - 1}` : ""}`
    : runtimeActivity?.detail;
  const elapsed = formatDuration((item.finishedAt ?? now) - (item.startedAt ?? item.queuedAt));
  const treeRole = `${prefix}${connector} ${statusMarker(item, theme)} ${roleText(`${item.role}${followup ? " ↻" : ""}`, item.role, theme)}`;
  const status = theme.fg(statusColor(item), item.status);
  const activityLabel = detail ?? (item.status === "running" ? "working" : item.status === "queued" ? "waiting" : "");
  const heading = item.heading ? theme.fg("text", item.heading) : "";
  const metrics = width >= 72
    ? `${fit(elapsed, 6, "right")}  ${fit(formatTokens(item.usage.total), 9, "right")}  ${fit(costText(item.usage.cost, theme), 8, "right")}`
    : width >= 52 ? `${fit(elapsed, 6, "right")}  ${fit(formatTokens(item.usage.total), 9, "right")}` : fit(elapsed, 6, "right");
  const leftWidth = Math.max(8, Math.min(28, Math.floor(width * 0.3)));
  const statusWidth = 11;
  const workWidth = Math.max(0, width - leftWidth - statusWidth - visibleWidth(metrics) - 6);
  let work = "";
  if (workWidth >= 8) {
    if (heading && activityLabel) {
      const headingWidth = Math.max(8, Math.min(42, Math.floor(workWidth * 0.65)));
      work = fitWithDotLeader(`${fit(heading, headingWidth)}  ${activityLabel}`, workWidth, theme);
    } else {
      work = fitWithDotLeader(heading || activityLabel, workWidth, theme);
    }
  }
  const row = `${fit(treeRole, leftWidth)}  ${fit(status, statusWidth)}  ${work ? `${work}  ` : ""}${metrics}`;
  lines.push(truncateToWidth(row, width));
  const childPrefix = `${prefix}${last ? "   " : "│  "}`;
  const descendants = descendantRows(node);
  descendants.forEach((descendant, index) => {
    const isLast = index === descendants.length - 1;
    if ("call" in descendant) renderCallNode(lines, descendant.call, runtime, theme, width, now, childPrefix, isLast);
    else renderNode(lines, descendant.node, runtime, theme, width, now, childPrefix, isLast);
  });
}

function renderCallNode(lines: string[], call: DelegationCallNode, runtime: SubagentRuntime, theme: Theme, width: number, now: number, prefix: string, last: boolean): void {
  const rawHeading = call.call.heading ?? "Delegated work";
  const heading = stripLeadingRoleNames(rawHeading, call.children.map((child) => child.invocation.role));
  lines.push(truncateToWidth(`${prefix}${theme.fg("dim", "›")} ${theme.fg("text", heading)}`, width));
  call.children.forEach((child, index) =>
    renderNode(lines, child, runtime, theme, width, now, prefix, last && index === call.children.length - 1));
}

function descendantRows(node: AgentNode): Array<{ node: AgentNode } | { call: DelegationCallNode }> {
  const grouped = new Set(node.childCalls.flatMap((call) => call.children.map((child) => child.invocation.id)));
  return [
    ...node.children.filter((child) => !grouped.has(child.invocation.id)).map((child) => ({ node: child } as const)),
    ...node.childCalls.map((call) => ({ call } as const)),
  ].sort((left, right) => {
    const leftTime = "node" in left ? left.node.invocation.queuedAt : left.call.call.createdAt;
    const rightTime = "node" in right ? right.node.invocation.queuedAt : right.call.call.createdAt;
    return leftTime - rightTime;
  });
}

export function costColor(cost: number): ThemeColor { return cost < 2 ? "success" : cost < 7 ? "warning" : "error"; }
export function costText(cost: number, theme: Theme): string { return theme.fg(costColor(cost), formatCost(cost)); }
export function invocationDuration(item: InvocationRecord, now: number): number { return (item.finishedAt ?? now) - (item.startedAt ?? item.queuedAt); }
export function statusColor(item: InvocationRecord): ThemeColor { return item.status === "complete" ? "success" : item.status === "running" ? "warning" : item.status === "queued" ? "dim" : "error"; }
export function statusMarker(item: InvocationRecord, theme: Theme): string {
  const icon = item.status === "queued" ? "◌" : item.status === "running" ? "◐" : item.status === "complete" ? "✓" : item.status === "cancelled" ? "×" : "!";
  return theme.fg(statusColor(item), icon);
}
export function formatTokens(tokens: number): string { if (tokens < 1_000) return `${Math.round(tokens)} tok`; if (tokens < 1_000_000) return `${(tokens / 1_000).toFixed(tokens < 10_000 ? 1 : 0)}k tok`; return `${(tokens / 1_000_000).toFixed(1)}m tok`; }
export function formatCost(cost: number): string { return `$${cost.toFixed(3)}`; }
export function formatDuration(milliseconds: number): string { const seconds = Math.max(0, Math.floor(milliseconds / 1_000)); if (seconds < 60) return `${seconds}s`; const minutes = Math.floor(seconds / 60); const remaining = seconds % 60; if (minutes < 60) return `${minutes}m${remaining.toString().padStart(2, "0")}s`; return `${Math.floor(minutes / 60)}h${(minutes % 60).toString().padStart(2, "0")}m`; }

function fit(value: string, width: number, align: "left" | "right" = "left"): string {
  const clipped = truncateToWidth(value, Math.max(0, width));
  const padding = " ".repeat(Math.max(0, width - visibleWidth(clipped)));
  return align === "right" ? padding + clipped : clipped + padding;
}

function joinSides(left: string, right: string, width: number): string {
  if (!right) return truncateToWidth(left, width);
  const gap = width - visibleWidth(left) - visibleWidth(right);
  return gap >= 2 ? `${left}${" ".repeat(gap)}${right}` : truncateToWidth(left, width);
}
