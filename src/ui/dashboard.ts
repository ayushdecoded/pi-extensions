import { statSync } from "node:fs";
import type { KeybindingsManager, Theme, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { getMarkdownTheme, SessionManager } from "@earendil-works/pi-coding-agent";
import type { Component, TUI } from "@earendil-works/pi-tui";
import { isKeyRelease, Markdown, matchesKey, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { agentModelLabel } from "../config/agents.ts";
import type { RuntimeToolExecution, SubagentRuntime } from "../runtime/runtime.ts";
import type { InvocationRecord } from "../runtime/types.ts";
import { fitWithDotLeader, joinWithDotLeader } from "./leaders.ts";
import { costText, formatDuration, formatTokens, invocationDuration, statusColor, statusMarker } from "./panel.ts";
import { projectBatches, type AgentNode, type BatchView, type DelegationCallNode } from "./projection.ts";
import { roleText, stripLeadingRoleNames } from "./roles.ts";
import { NativeToolRenderer } from "./tool-renderer.ts";

type Mode = "tree" | "viewer";
type FlatNode = {
  invocation: InvocationRecord;
  treePrefix: string;
  callHeading?: string;
  callPrefix?: string;
};
const EMPTY_RUNNING_CALLS: ReadonlySet<string> = new Set();

function roleConfiguration(runtime: SubagentRuntime, roleName: string) {
  return runtime.activeRoles?.find((role) => role.name.toLowerCase() === roleName.toLowerCase())
    ?? runtime.options.config?.roles.find((role) => role.name.toLowerCase() === roleName.toLowerCase());
}

export class AgentsDashboard implements Component {
  private mode: Mode = "tree";
  private selectedInvocationId?: string;
  private selectedIndex = 0;
  private scroll = 0;
  private follow = true;
  private toolsExpanded = false;
  private readonly unsubscribe: () => void;
  private readonly unsubscribeTranscript: () => void;
  private renderTimer?: NodeJS.Timeout;
  private clock?: NodeJS.Timeout;
  private transcriptCache?: { file: string; modified: number; size: number; messages: unknown[] };
  private transcriptBodyCache?: { source: string; revision: string; running: string; expanded: boolean; width: number; lines: string[] };
  private readonly transcriptRenderer: TranscriptRenderer;

  constructor(
    private readonly runtime: SubagentRuntime,
    private readonly tui: TUI,
    private readonly theme: Theme,
    private readonly keybindings: KeybindingsManager,
    private readonly done: () => void,
  ) {
    this.transcriptRenderer = new TranscriptRenderer({
      tui,
      cwd: runtime.options.cwd,
      onInvalidate: () => {
        this.transcriptBodyCache = undefined;
      },
    });
    this.unsubscribe = runtime.subscribe(() => {
      this.syncClock();
      this.scheduleRender();
    });
    this.unsubscribeTranscript = runtime.subscribeTranscript?.((handle) => {
      if (handle === this.currentInvocation()?.agent) this.scheduleRender();
    }) ?? (() => {});
    this.syncClock();
  }

  handleInput(data: string): void {
    if (isKeyRelease(data)) return;
    if (this.keybindings.matches(data, "tui.select.cancel") || matchesKey(data, "escape") || matchesKey(data, "ctrl+c")) {
      if (this.mode === "viewer") {
        this.mode = "tree";
        this.scroll = 0;
        this.follow = true;
        this.transcriptRenderer.invalidate();
        this.transcriptBodyCache = undefined;
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

    const count = this.currentFlatTree().length;
    if (this.keybindings.matches(data, "tui.select.up") || data === "k") this.selectedIndex = Math.max(0, this.selectedIndex - 1);
    else if (this.keybindings.matches(data, "tui.select.down") || data === "j") this.selectedIndex = Math.min(Math.max(0, count - 1), this.selectedIndex + 1);
    else if (this.keybindings.matches(data, "tui.select.pageUp")) this.selectedIndex = Math.max(0, this.selectedIndex - Math.max(1, this.tui.terminal.rows - 8));
    else if (this.keybindings.matches(data, "tui.select.pageDown")) this.selectedIndex = Math.min(Math.max(0, count - 1), this.selectedIndex + Math.max(1, this.tui.terminal.rows - 8));
    else if (matchesKey(data, "home")) this.selectedIndex = 0;
    else if (matchesKey(data, "end")) this.selectedIndex = Math.max(0, count - 1);
    else if (this.keybindings.matches(data, "tui.select.confirm")) this.openSelected();
    if (this.mode === "tree") {
      this.selectedInvocationId = this.currentFlatTree()[this.selectedIndex]?.invocation.id;
    }
    this.tui.requestRender();
  }

  render(width: number): string[] {
    const height = Math.max(8, this.tui.terminal.rows - 2);
    const lines = this.mode === "viewer" ? this.renderViewer(width, height) : this.renderTree(width, height);
    return constrain(lines, width);
  }

  invalidate(): void {
    this.transcriptRenderer.invalidate();
    this.transcriptBodyCache = undefined;
  }

  dispose(): void {
    this.unsubscribe();
    this.unsubscribeTranscript();
    this.transcriptRenderer.dispose();
    if (this.renderTimer) clearTimeout(this.renderTimer);
    if (this.clock) clearInterval(this.clock);
  }

  private renderTree(width: number, height: number): string[] {
    const batches = projectBatches(this.runtime.state);
    const flat = batches.flatMap((batch) => flatten(batch.roots));
    this.selectedIndex = clampById(flat, this.selectedInvocationId, this.selectedIndex);
    this.selectedInvocationId = flat[this.selectedIndex]?.invocation.id;
    const now = Date.now();
    const displayRows: Array<{ line: string; invocationId?: string }> = [];

    for (const batch of batches) {
      if (displayRows.length) displayRows.push({ line: "" });
      displayRows.push({ line: ` ${batchLine(batch, now, this.theme)}` });
      const batchRows = flatten(batch.roots);
      for (const row of batchRows) {
        if (row.callHeading) {
          displayRows.push({
            line: `   ${row.callPrefix ?? ""}${this.theme.fg("dim", "›")} ${this.theme.fg("text", row.callHeading)}`,
          });
        }
        const invocation = row.invocation;
        const selected = invocation.id === this.selectedInvocationId;
        const marker = selected ? this.theme.fg("accent", "❯") : " ";
        const followup = invocation.followup ? ` ${this.theme.fg("accent", "↻")}` : "";
        const configured = roleConfiguration(this.runtime, invocation.role);
        const effectiveBackend = invocation.backend ?? this.runtime.state.agents.get(invocation.agent)?.backend ?? configured?.backend;
        const model = configured ? agentModelLabel(configured.model, effectiveBackend) : effectiveBackend === "devin" ? agentModelLabel("", effectiveBackend) : "?";
        const left = ` ${marker} ${row.treePrefix} ${statusMarker(invocation, this.theme)} ${roleText(invocation.role, invocation.role, this.theme)}${followup}`;
        const rightParts = [
          this.theme.fg(statusColor(invocation), invocation.status),
          ...(width >= 92 ? [this.theme.fg("dim", `${model} · ${configured?.thinking ?? "?"}`)] : []),
          this.theme.fg("muted", formatDuration(invocationDuration(invocation, now))),
          this.theme.fg("muted", formatTokens(invocation.usage.total)),
          costText(invocation.usage.cost, this.theme),
        ];
        const prompt = invocation.heading
          ? this.theme.fg("text", invocation.heading)
          : this.theme.fg("muted", sanitize(invocation.task).replace(/\s+/g, " ").trim());
        displayRows.push({
          line: joinThree(left, prompt, `${rightParts.join(this.theme.fg("dim", " · "))} `, width - 2, this.theme),
          invocationId: invocation.id,
        });
      }
    }

    const bodyHeight = Math.max(1, height - 4);
    const selectedDisplayIndex = Math.max(0, displayRows.findIndex((row) => row.invocationId === this.selectedInvocationId));
    const start = windowStart(selectedDisplayIndex, displayRows.length, bodyHeight);
    const rows = displayRows.slice(start, start + bodyHeight).map((row) => row.line);
    if (!rows.length) rows.push(this.theme.fg("dim", "  No subagents have run in this session."));
    return framedView(
      "Subagents",
      `${flat.length} ${flat.length === 1 ? "agent" : "agents"} · ${batches.length} ${batches.length === 1 ? "batch" : "batches"}`,
      "all delegation batches",
      rows,
      "↑↓ select agent · Enter inspect · Esc close",
      width,
      height,
      this.theme,
    );
  }

  private renderViewer(width: number, height: number): string[] {
    const invocation = this.currentInvocation();
    if (!invocation) {
      this.mode = "tree";
      return this.renderTree(width, height);
    }
    const agent = this.runtime.state.agents.get(invocation.agent);
    const source = agent ? this.messagesFor(agent.handle, agent.sessionFile) : {
      key: invocation.agent,
      revision: "0",
      messages: [],
      volatileTail: false,
      runningCalls: EMPTY_RUNNING_CALLS,
      stableMessages: undefined,
      liveTools: undefined,
      getToolDefinition: undefined,
    };
    const bodyHeight = Math.max(1, height - 5);
    const outerPadding = width >= 12 ? 1 : 0;
    const frameWidth = Math.max(1, width - outerPadding * 2);
    const frameInnerWidth = Math.max(0, frameWidth - 2);
    const horizontalPadding = frameInnerWidth >= 12 ? 2 : frameInnerWidth >= 4 ? 1 : 0;
    const bodyWidth = Math.max(1, frameInnerWidth - horizontalPadding * 2);
    let body = this.transcriptBodyCache;
    const running = source.runningCalls ? [...source.runningCalls].sort().join("|") : "inferred";
    if (!body || body.source !== source.key || body.revision !== source.revision || body.running !== running || body.expanded !== this.toolsExpanded || body.width !== bodyWidth) {
      body = {
        source: source.key,
        revision: source.revision,
        running,
        expanded: this.toolsExpanded,
        width: bodyWidth,
        lines: this.transcriptRenderer.render(source.messages, bodyWidth, this.theme, source.volatileTail, source.runningCalls, {
          source: source.key,
          revision: source.revision,
          stableMessages: source.stableMessages,
          liveTools: source.liveTools,
          getToolDefinition: source.getToolDefinition,
        }),
      };
      this.transcriptBodyCache = body;
    }
    const bodyLines = body.lines;
    const maxScroll = Math.max(0, bodyLines.length - bodyHeight);
    if (this.follow) this.scroll = maxScroll;
    this.scroll = Math.min(this.scroll, maxScroll);
    const followup = invocation.followup ? ` ${this.theme.fg("accent", "↻")}` : "";
    const configured = roleConfiguration(this.runtime, invocation.role);
    const effectiveBackend = invocation.backend ?? this.runtime.state.agents.get(invocation.agent)?.backend ?? configured?.backend;
    const model = configured ? agentModelLabel(configured.model, effectiveBackend) : effectiveBackend === "devin" ? agentModelLabel("", effectiveBackend) : "?";
    const role = `${roleText(invocation.role, invocation.role, this.theme)}${followup}`;
    const requestHeading = invocation.heading ?? compactTaskHeading(invocation.task);
    const titleRoom = Math.max(0, frameWidth - 4);
    const title = requestHeading ? this.theme.fg("text", truncateToWidth(requestHeading, titleRoom, "…")) : role;
    const margin = " ".repeat(outerPadding);
    const border = (value: string) => this.theme.fg("borderAccent", value);
    const top = `${margin}${centeredFrameTitle(title, frameWidth, border)}${margin}`;
    const left = bodyWidth >= 30 ? `${role}${this.theme.fg("dim", ` · ${model} · ${configured?.thinking ?? "?"}`)}` : "";
    const rightParts = bodyWidth >= 64
      ? [this.theme.fg(statusColor(invocation), invocation.status), formatDuration(invocationDuration(invocation, Date.now())), formatTokens(invocation.usage.total), costText(invocation.usage.cost, this.theme)]
      : bodyWidth >= 30 ? [this.theme.fg(statusColor(invocation), invocation.status), formatDuration(invocationDuration(invocation, Date.now()))]
      : [statusMarker(invocation, this.theme)];
    const right = rightParts.join(this.theme.fg("dim", " · "));
    const sidePadding = " ".repeat(horizontalPadding);
    const framedLine = (value: string) => `${margin}${border("│")}${sidePadding}${padLine(value, bodyWidth)}${sidePadding}${border("│")}${margin}`;
    const divider = `${margin}${border(`├${"─".repeat(frameInnerWidth)}┤`)}${margin}`;
    const bottom = `${margin}${border(`╰${"─".repeat(frameInnerWidth)}╯`)}${margin}`;
    const visible = bodyLines.slice(this.scroll, this.scroll + bodyHeight);
    const lines = [
      top,
      framedLine(joinSides(left, right, bodyWidth)),
      divider,
      ...visible.map(framedLine),
      ...Array.from({ length: Math.max(0, bodyHeight - visible.length) }, () => framedLine("")),
      bottom,
      truncateToWidth(`${" ".repeat(outerPadding + 1 + horizontalPadding)}${this.viewerHints(bodyWidth)}`, width),
    ];
    return fit(lines, height);
  }

  private handleViewerInput(data: string): void {
    const page = Math.max(1, this.tui.terminal.rows - 8);
    if (this.keybindings.matches(data, "app.tools.expand")) {
      this.toolsExpanded = !this.toolsExpanded;
      this.transcriptRenderer.setToolsExpanded(this.toolsExpanded);
      this.transcriptBodyCache = undefined;
    } else if (this.keybindings.matches(data, "tui.select.up") || data === "k") {
      this.scroll = Math.max(0, this.scroll - 1);
      this.follow = false;
    } else if (this.keybindings.matches(data, "tui.select.down") || data === "j") {
      this.scroll += 1;
      this.follow = false;
    } else if (this.keybindings.matches(data, "tui.select.pageUp")) {
      this.scroll = Math.max(0, this.scroll - page);
      this.follow = false;
    } else if (this.keybindings.matches(data, "tui.select.pageDown")) {
      this.scroll += page;
      this.follow = false;
    } else if (matchesKey(data, "home")) {
      this.scroll = 0;
      this.follow = false;
    } else if (matchesKey(data, "end") || data === "f") {
      this.follow = true;
    } else if (data === "[" || data === "]") {
      const flat = this.currentFlatTree();
      if (flat.length > 0) {
        const direction = data === "[" ? -1 : 1;
        this.selectedIndex = (this.selectedIndex + direction + flat.length) % flat.length;
        this.selectedInvocationId = flat[this.selectedIndex]!.invocation.id;
        this.scroll = 0;
        this.follow = true;
        this.transcriptCache = undefined;
        this.transcriptBodyCache = undefined;
      }
    }
    this.tui.requestRender();
  }

  private openSelected(): void {
    const row = this.currentFlatTree()[this.selectedIndex];
    if (!row) return;
    this.selectedInvocationId = row.invocation.id;
    this.scroll = 0;
    this.follow = true;
    this.transcriptCache = undefined;
    this.transcriptBodyCache = undefined;
    this.mode = "viewer";
  }

  private currentFlatTree(): FlatNode[] {
    return projectBatches(this.runtime.state).flatMap((batch) => flatten(batch.roots));
  }

  private currentInvocation(): InvocationRecord | undefined {
    return this.runtime.state.invocations.get(this.selectedInvocationId ?? "");
  }

  private messagesFor(handle: string, file: string): {
    key: string;
    revision: string;
    messages: readonly unknown[];
    volatileTail: boolean;
    runningCalls: ReadonlySet<string> | undefined;
    stableMessages: readonly unknown[] | undefined;
    liveTools: ReadonlyMap<string, RuntimeToolExecution> | undefined;
    getToolDefinition: ((toolCallId: string, toolName: string) => ToolDefinition | undefined) | undefined;
  } {
    const live = this.runtime.liveSessions.get(handle);
    if (live) {
      const streamingMessage = live.state.streamingMessage;
      const committedMessages = live.messages;
      const messages = streamingMessage ? [...committedMessages, streamingMessage] : committedMessages;
      const liveTools = this.runtime.toolExecutions?.get(handle);
      const currentToolCallIds = new Set(liveTools?.keys() ?? []);
      const streamingContent = (streamingMessage as any)?.role === "assistant" ? (streamingMessage as any).content : [];
      for (const part of streamingContent ?? []) if (part?.type === "toolCall" && typeof part.id === "string") currentToolCallIds.add(part.id);
      return {
        key: `live:${handle}`,
        revision: String(this.runtime.transcriptRevision?.(handle) ?? 0),
        messages,
        volatileTail: Boolean(streamingMessage),
        runningCalls: live.state.pendingToolCalls,
        stableMessages: committedMessages,
        liveTools,
        // Only calls observed in this live invocation may borrow its custom
        // definition; older calls in a resumed session remain historical fallback.
        getToolDefinition: (toolCallId, toolName) => currentToolCallIds.has(toolCallId) ? live.getToolDefinition(toolName) : undefined,
      };
    }
    const devin = this.runtime.devinTranscripts?.get(handle);
    if (devin) {
      return {
        key: `devin:${handle}`,
        revision: String(devin.revision),
        messages: devin.streamingMessage ? [...devin.messages, devin.streamingMessage] : devin.messages,
        volatileTail: Boolean(devin.streamingMessage),
        runningCalls: devin.pendingToolCalls,
        stableMessages: devin.messages,
        liveTools: undefined,
        getToolDefinition: undefined,
      };
    }
    try {
      const stat = statSync(file);
      const modified = stat.mtimeMs;
      const size = stat.size;
      if (this.transcriptCache?.file !== file || this.transcriptCache.modified !== modified || this.transcriptCache.size !== size) {
        const manager = SessionManager.open(file, undefined, this.runtime.options.cwd);
        const messages = manager.getEntries().filter((entry) => entry.type === "message").map((entry) => entry.message);
        this.transcriptCache = { file, modified, size, messages };
      }
      return {
        key: `file:${file}`,
        revision: `${modified}:${size}`,
        messages: this.transcriptCache.messages,
        volatileTail: false,
        runningCalls: EMPTY_RUNNING_CALLS,
        stableMessages: this.transcriptCache.messages,
        liveTools: undefined,
        getToolDefinition: undefined,
      };
    } catch {
      return {
        key: `file:${file}`,
        revision: "missing",
        messages: [],
        volatileTail: false,
        runningCalls: EMPTY_RUNNING_CALLS,
        stableMessages: undefined,
        liveTools: undefined,
        getToolDefinition: undefined,
      };
    }
  }

  private viewerHints(width: number): string {
    const following = this.follow ? " · following" : "";
    const expandKey = this.expandKeyLabel();
    const toolHint = `${expandKey ? `${expandKey} ` : ""}${this.toolsExpanded ? "collapse" : "expand"} tools`;
    const text = width >= 82
      ? `read-only · ↑↓/PgUp/PgDn scroll · End follow · ${toolHint} · Esc back${following}`
      : width >= 56 ? `↑↓/Pg scroll · End follow · ${toolHint} · Esc back${following}`
      : width >= 38 ? `↑↓/Pg scroll · End follow · Esc back${following}` : `↑↓ · End · Esc${this.follow ? " · follow" : ""}`;
    return this.theme.fg("dim", text);
  }

  private expandKeyLabel(): string {
    const config = (this.keybindings as KeybindingsManager & { getEffectiveConfig?: () => Record<string, unknown> }).getEffectiveConfig?.();
    const binding = config?.["app.tools.expand"];
    if (typeof binding === "string") return binding;
    if (Array.isArray(binding)) {
      const first = binding.find((item) => typeof item === "string");
      return typeof first === "string" ? first : "";
    }
    return "";
  }

  private syncClock(): void {
    const active = projectBatches(this.runtime.state).some((batch) => batch.active);
    if (active && !this.clock) this.clock = setInterval(() => this.tui.requestRender(), 1_000);
    if (!active && this.clock) {
      clearInterval(this.clock);
      this.clock = undefined;
    }
  }

  private scheduleRender(): void {
    if (this.renderTimer) return;
    this.renderTimer = setTimeout(() => {
      this.renderTimer = undefined;
      this.tui.requestRender();
    }, 50);
  }
}

function flatten(roots: AgentNode[]): FlatNode[] {
  type TreeEntry = { node: AgentNode } | { call: DelegationCallNode };
  const result: FlatNode[] = [];
  const descendants = (node: AgentNode): TreeEntry[] => {
    const grouped = new Set(node.childCalls.flatMap((call) => call.children.map((child) => child.invocation.id)));
    return [
      ...node.children.filter((child) => !grouped.has(child.invocation.id)).map((child) => ({ node: child } as const)),
      ...node.childCalls.map((call) => ({ call } as const)),
    ].sort((left, right) => {
      const leftTime = "node" in left ? left.node.invocation.queuedAt : left.call.call.createdAt;
      const rightTime = "node" in right ? right.node.invocation.queuedAt : right.call.call.createdAt;
      return leftTime - rightTime;
    });
  };
  const visit = (entries: TreeEntry[], prefix: string, hasFollowing = false) => {
    entries.forEach((entry, index) => {
      const follows = hasFollowing || index < entries.length - 1;
      const last = !follows;
      const connector = last ? "└─" : "├─";
      const childPrefix = `${prefix}${last ? "   " : "│  "}`;
      if ("node" in entry) {
        result.push({ invocation: entry.node.invocation, treePrefix: `${prefix}${connector}` });
        visit(descendants(entry.node), childPrefix);
        return;
      }
      const firstChildIndex = result.length;
      visit(entry.call.children.map((node) => ({ node })), prefix, follows);
      if (result[firstChildIndex]) {
        const rawHeading = entry.call.call.heading ?? "Delegated work";
        result[firstChildIndex]!.callHeading = stripLeadingRoleNames(
          rawHeading,
          entry.call.children.map((child) => child.invocation.role),
        );
        result[firstChildIndex]!.callPrefix = prefix;
      }
    });
  };
  visit(roots.map((node) => ({ node })), "");
  return result;
}

type CachedMessage = { width: number; completion: string; lines: string[] };
type CachedTranscript = {
  source: string;
  width: number;
  running: string;
  tools: string;
  expanded: boolean;
  messages: readonly unknown[];
  stableIdentity?: readonly unknown[];
  messageCount: number;
  lines: string[];
};

type TranscriptRendererOptions = {
  tui: TUI;
  cwd: string;
  onInvalidate?: () => void;
};

type TranscriptRenderContext = {
  source: string;
  revision: string;
  stableMessages?: readonly unknown[];
  liveTools?: ReadonlyMap<string, RuntimeToolExecution>;
  getToolDefinition?: (toolCallId: string, toolName: string) => ToolDefinition | undefined;
};

type ToolResultView = {
  message: any;
  index: number;
  version: number;
};

type TranscriptProjection = {
  results: Map<string, ToolResultView>;
  callIds: Set<string>;
};

type ProjectionCache = {
  source: string;
  identity: readonly unknown[];
  count: number;
  projection: TranscriptProjection;
};

const transcriptObjectVersions = new WeakMap<object, number>();
let nextTranscriptObjectVersion = 1;

export class TranscriptRenderer {
  private messageCache = new WeakMap<object, CachedMessage>();
  private stableCache?: CachedTranscript;
  private projectionCache?: ProjectionCache;
  private reconciledSource?: string;
  private reconciledIdentity?: readonly unknown[];
  private reconciledCount = -1;
  private readonly nativeTools?: NativeToolRenderer;
  private toolsExpanded = false;

  constructor(options?: TranscriptRendererOptions) {
    if (options) {
      this.nativeTools = new NativeToolRenderer(options.tui, options.cwd, () => {
        this.stableCache = undefined;
        options.onInvalidate?.();
      });
    }
  }

  setToolsExpanded(expanded: boolean): void {
    if (this.toolsExpanded === expanded) return;
    this.toolsExpanded = expanded;
    this.nativeTools?.setExpanded(expanded);
    this.stableCache = undefined;
  }

  invalidate(): void {
    this.messageCache = new WeakMap();
    this.stableCache = undefined;
    this.projectionCache = undefined;
    this.reconciledSource = undefined;
    this.reconciledIdentity = undefined;
    this.reconciledCount = -1;
    this.nativeTools?.invalidate();
  }

  dispose(): void {
    this.nativeTools?.dispose();
    this.messageCache = new WeakMap();
    this.stableCache = undefined;
    this.projectionCache = undefined;
    this.reconciledSource = undefined;
    this.reconciledIdentity = undefined;
    this.reconciledCount = -1;
  }

  render(
    messages: readonly unknown[],
    width: number,
    theme: Theme,
    volatileTail = false,
    liveRunningCalls?: ReadonlySet<string>,
    context?: TranscriptRenderContext,
  ): string[] {
    const safeWidth = Math.max(1, width);
    const runningCalls = liveRunningCalls ?? inferRunningCalls(messages);
    const running = [...runningCalls].sort().join("|");
    const source = context?.source ?? "lightweight";
    this.nativeTools?.setSource(source);
    const tools = liveToolSignature(context?.liveTools);
    const stableLength = volatileTail ? Math.max(0, messages.length - 1) : messages.length;
    const projection = this.projectTranscript(messages, stableLength, context);
    const stableIdentity = context?.stableMessages;
    const cached = this.stableCache;
    const samePrefix = stableIdentity
      ? cached?.stableIdentity === stableIdentity && cached.messageCount === stableLength
      : Boolean(cached && sameMessages(cached.messages, messages, stableLength));
    let stableLines: string[];
    if (cached?.source === source && cached.width === safeWidth && cached.running === running && cached.tools === tools &&
        cached.expanded === this.toolsExpanded && samePrefix) {
      stableLines = cached.lines;
    } else {
      stableLines = this.renderRange(messages, 0, stableLength, safeWidth, theme, runningCalls, projection, context, true);
      this.stableCache = {
        source,
        width: safeWidth,
        running,
        tools,
        expanded: this.toolsExpanded,
        messages: stableIdentity ?? messages.slice(0, stableLength),
        ...(stableIdentity ? { stableIdentity } : {}),
        messageCount: stableLength,
        lines: stableLines,
      };
    }

    const tailLines = volatileTail
      ? this.renderRange(messages, stableLength, messages.length, safeWidth, theme, runningCalls, projection, context, false)
      : [];
    const lines = stableLines.length && tailLines.length ? [...stableLines, "", ...tailLines] : stableLines.length ? stableLines : tailLines;
    if (this.nativeTools && (this.reconciledSource !== source || this.reconciledIdentity !== stableIdentity || this.reconciledCount !== stableLength)) {
      const preserve = new Set(context?.liveTools?.keys() ?? []);
      if (volatileTail) {
        const tail = messages.at(-1) as any;
        if (tail?.role === "assistant") {
          for (const part of tail.content ?? []) if (part?.type === "toolCall" && typeof part.id === "string") preserve.add(part.id);
        }
      }
      this.nativeTools.reconcile(projection.callIds, preserve);
      this.reconciledSource = source;
      this.reconciledIdentity = stableIdentity;
      this.reconciledCount = stableLength;
    }
    // Every message is width-constrained when first rendered. Avoid walking a large cached
    // transcript again on each streaming-tail update.
    return lines.length ? lines : constrain([theme.fg("dim", "No transcript entries yet.")], safeWidth);
  }

  private projectTranscript(
    messages: readonly unknown[],
    stableLength: number,
    context: TranscriptRenderContext | undefined,
  ): TranscriptProjection {
    const identity = context?.stableMessages;
    if (!identity) return projectTranscript(messages);
    const source = context.source;
    let cached = this.projectionCache;
    if (!cached || cached.source !== source || cached.identity !== identity || cached.count > stableLength) {
      cached = { source, identity, count: 0, projection: { results: new Map(), callIds: new Set() } };
      this.projectionCache = cached;
    }
    if (cached.count < stableLength) {
      projectTranscriptRange(identity, cached.count, stableLength, cached.projection);
      cached.count = stableLength;
    }
    return cached.projection;
  }

  private renderRange(
    messages: readonly unknown[],
    start: number,
    end: number,
    width: number,
    theme: Theme,
    runningCalls: ReadonlySet<string>,
    projection: TranscriptProjection,
    context: TranscriptRenderContext | undefined,
    cacheable: boolean,
  ): string[] {
    const lines: string[] = [];
    for (let index = start; index < end; index += 1) {
      const raw = messages[index];
      const message = raw as any;
      const completion = messageToolState(message, runningCalls, projection, context, this.nativeTools, this.toolsExpanded);
      const messageCached = cacheable && typeof raw === "object" && raw !== null ? this.messageCache.get(raw as object) : undefined;
      const rendered = messageCached?.width === width && messageCached.completion === completion
        ? messageCached.lines
        : renderTranscriptMessage(
            message,
            width,
            theme,
            runningCalls,
            projection,
            context,
            this.nativeTools,
            this.toolsExpanded,
            !cacheable,
          );
      if (cacheable && typeof raw === "object" && raw !== null && rendered !== messageCached?.lines) {
        this.messageCache.set(raw as object, { width, completion, lines: rendered });
      }
      if (rendered.length) lines.push(...rendered, "");
    }
    while (lines.at(-1) === "") lines.pop();
    return lines;
  }
}

function inferRunningCalls(messages: readonly unknown[]): ReadonlySet<string> {
  const completedCalls = new Set(messages.flatMap((raw: any) => raw?.role === "toolResult" && raw.toolCallId ? [raw.toolCallId] : []));
  return new Set(messages.flatMap((raw: any) =>
    raw?.role === "assistant" ? (raw.content ?? []).flatMap((part: any) => part?.type === "toolCall" && part.id && !completedCalls.has(part.id) ? [part.id] : []) : [],
  ));
}

function sameMessages(cached: readonly unknown[], current: readonly unknown[], length: number): boolean {
  if (cached.length !== length) return false;
  for (let index = 0; index < length; index += 1) if (cached[index] !== current[index]) return false;
  return true;
}

export function renderTranscript(messages: readonly unknown[], width: number, theme: Theme): string[] {
  return new TranscriptRenderer().render(messages, width, theme);
}

function renderTranscriptMessage(
  message: any,
  width: number,
  theme: Theme,
  runningCalls: ReadonlySet<string>,
  projection: TranscriptProjection,
  context: TranscriptRenderContext | undefined,
  nativeTools: NativeToolRenderer | undefined,
  expanded: boolean,
  volatile: boolean,
): string[] {
  const lines: string[] = [];
  if (message?.role === "user") {
    lines.push(...renderMarkdown(contentText(message.content), width, theme.fg("accent", "> "), { color: (text) => theme.fg("text", text) }));
  } else if (message?.role === "assistant") {
    for (let partIndex = 0; partIndex < (message.content ?? []).length; partIndex += 1) {
      const part = message.content[partIndex];
      if (part?.type === "text") {
        lines.push(...renderMarkdown(String(part.text ?? ""), width, "", { color: (text) => theme.fg("text", text) }));
      } else if (part?.type === "thinking") {
        lines.push(...renderMarkdown(String(part.thinking ?? part.text ?? ""), width, theme.fg("dim", "~ "), {
          color: (text) => theme.fg("muted", text),
          italic: true,
        }));
      } else if (part?.type === "toolCall") {
        const id = typeof part.id === "string" ? part.id : "";
        const name = typeof part.name === "string" ? part.name : "tool";
        const persisted = id ? projection.results.get(id) : undefined;
        const live = id ? context?.liveTools?.get(id) : undefined;
        const resultMessage = persisted?.message;
        const result = resultMessage
          ? normalizeResult(resultMessage)
          : live?.result ? normalizeResult(live.result) : undefined;
        const resultVersion = resultMessage
          ? `message:${persisted!.index}:${persisted!.version}`
          : live?.result ? `live:${live.revision}` : "none";
        const definition = id ? context?.getToolDefinition?.(id, name) : undefined;
        const running = Boolean(id && runningCalls.has(id));
        const nativeEligible = Boolean(
          nativeTools && id && nativeTools.canRender(name, definition) &&
          (nativeTools.isBuiltIn(name) || (definition && (live || volatile))),
        );
        const native = nativeEligible ? nativeTools!.render({
          id,
          name,
          args: live?.args ?? part.arguments ?? {},
          argsVersion: `${volatile ? context?.revision ?? "volatile" : "stable"}:${live?.revision ?? 0}:${partIndex}:${transcriptObjectVersion(part)}`,
          argsComplete: live?.argsComplete ?? !volatile,
          // Persisted messages do not retain execution timestamps. Only start
          // the native elapsed timer while a call is actually live; otherwise
          // replay would misleadingly report every historical Bash call as 0.0s.
          executionStarted: running || Boolean(live?.executionStarted && (live.isPartial || !live.result)),
          result,
          resultVersion,
          isPartial: resultMessage ? false : live?.isPartial ?? running,
          definition,
        }, width) : undefined;
        if (native) lines.push(...constrain(native, width));
        else lines.push(...renderFallbackTool(part, result, running, expanded, width, theme));
      }
    }
  } else if (message?.role === "toolResult") {
    if (message.toolCallId && projection.callIds.has(message.toolCallId)) return [];
    lines.push(...renderFallbackResult(normalizeResult(message), expanded, width, theme));
  }
  return constrain(lines, width);
}

function renderMarkdown(text: string, width: number, prefix: string, style: { color: (text: string) => string; italic?: boolean }): string[] {
  const clean = sanitize(text).trim();
  if (!clean) return [];
  const prefixWidth = visibleWidth(prefix);
  const markdown = new Markdown(clean, 0, 0, getMarkdownTheme(), style);
  return markdown.render(Math.max(1, width - prefixWidth)).map((line, index) =>
    `${index === 0 ? prefix : " ".repeat(prefixWidth)}${line.trimEnd()}`,
  );
}

function messageToolState(
  message: any,
  runningCalls: ReadonlySet<string>,
  projection: TranscriptProjection,
  context: TranscriptRenderContext | undefined,
  nativeTools: NativeToolRenderer | undefined,
  expanded: boolean,
): string {
  if (message?.role !== "assistant" || !Array.isArray(message.content)) return "";
  return message.content
    .filter((part: any) => part?.type === "toolCall")
    .map((part: any) => {
      const id = String(part.id ?? "");
      const name = String(part.name ?? "tool");
      const persisted = projection.results.get(id);
      const live = context?.liveTools?.get(id);
      const definition = context?.getToolDefinition?.(id, name);
      const provenance = nativeTools?.canRender(name, definition) &&
        (nativeTools.isBuiltIn(name) || Boolean(definition && live)) ? "native" : "fallback";
      return [
        id,
        runningCalls.has(id) ? "running" : "settled",
        persisted ? `message:${persisted.index}:${persisted.version}` : live?.result ? `live-result:${live.revision}` : "no-result",
        live ? `live:${live.revision}` : "historical",
        `${provenance}:${nativeTools?.revisionFor(id) ?? 0}`,
        expanded ? "expanded" : "collapsed",
        context?.source ?? "lightweight",
      ].join(":");
    })
    .join("|");
}

function projectTranscript(messages: readonly unknown[]): TranscriptProjection {
  const projection: TranscriptProjection = { results: new Map(), callIds: new Set() };
  projectTranscriptRange(messages, 0, messages.length, projection);
  return projection;
}

function projectTranscriptRange(
  messages: readonly unknown[],
  start: number,
  end: number,
  projection: TranscriptProjection,
): void {
  for (let index = start; index < end; index += 1) {
    const message = messages[index] as any;
    if (message?.role === "assistant" && Array.isArray(message.content)) {
      for (const part of message.content) if (part?.type === "toolCall" && typeof part.id === "string") projection.callIds.add(part.id);
    } else if (message?.role === "toolResult" && typeof message.toolCallId === "string") {
      projection.results.set(message.toolCallId, { message, index, version: transcriptObjectVersion(message) });
    }
  }
}

function transcriptObjectVersion(value: object): number {
  const existing = transcriptObjectVersions.get(value);
  if (existing !== undefined) return existing;
  const version = nextTranscriptObjectVersion++;
  transcriptObjectVersions.set(value, version);
  return version;
}

function liveToolSignature(tools: ReadonlyMap<string, RuntimeToolExecution> | undefined): string {
  if (!tools?.size) return "";
  return [...tools.values()]
    .map((tool) => `${tool.toolCallId}:${tool.revision}`)
    .sort()
    .join("|");
}

function normalizeResult(value: any): { content: Array<{ type: string; text?: string; data?: string; mimeType?: string }>; details?: unknown; isError: boolean } {
  const rawContent = value?.content;
  const content = typeof rawContent === "string"
    ? [{ type: "text", text: rawContent }]
    : Array.isArray(rawContent)
      ? rawContent.map((part: any) => part?.type === "image"
        ? { type: "image", data: part.data ?? part.source?.data, mimeType: part.mimeType ?? part.source?.mediaType }
        : { type: "text", text: String(part?.text ?? "") })
      : [];
  return {
    content,
    ...(value?.details === undefined ? {} : { details: value.details }),
    isError: Boolean(value?.isError),
  };
}

function renderFallbackTool(
  call: any,
  result: ReturnType<typeof normalizeResult> | undefined,
  running: boolean,
  expanded: boolean,
  width: number,
  theme: Theme,
): string[] {
  const name = sanitize(String(call?.name ?? "tool"));
  const preview = compactJson(call?.arguments, Math.max(80, width * 2));
  const runningText = running ? theme.fg("warning", " · running") : "";
  const lines = [truncateToWidth(`${theme.fg("muted", "→ ")}${theme.fg("toolTitle", name)}${preview !== "{}" ? theme.fg("dim", ` ${preview}`) : ""}${runningText}`, width, "")];
  if (expanded) {
    const pretty = safePrettyJson(call?.arguments);
    if (pretty && pretty !== "{}") for (const line of pretty.split("\n")) lines.push(truncateToWidth(theme.fg("dim", `  ${line}`), width, ""));
  }
  if (result) lines.push(...renderFallbackResult(result, expanded, width, theme));
  return lines;
}

function renderFallbackResult(
  result: ReturnType<typeof normalizeResult>,
  expanded: boolean,
  width: number,
  theme: Theme,
): string[] {
  const visible = expanded
    ? result.content.flatMap((part) => (part.type === "image" ? ["[image omitted in transcript viewer]"] : (part.text ?? "").split("\n")))
    : [firstVisibleResultLine(result.content, Math.max(256, width * 4))];
  const label = result.isError ? theme.fg("error", "  error: ") : theme.fg("dim", "  output: ");
  return visible.map((line, index) => truncateToWidth(`${index === 0 ? label : " ".repeat(visibleWidth(label))}${theme.fg("dim", sanitize(line))}`, width, ""));
}

function firstVisibleResultLine(content: Array<{ type: string; text?: string }>, maxChars: number): string {
  let remaining = maxChars;
  for (const part of content) {
    if (part.type === "image") return "[image omitted in transcript viewer]";
    const text = part.text ?? "";
    const limit = Math.min(text.length, remaining);
    let first = -1;
    let end = limit;
    for (let index = 0; index < limit; index += 1) {
      const char = text[index]!;
      if (char === "\n") {
        if (first >= 0) {
          end = index;
          break;
        }
        continue;
      }
      if (first < 0 && !/\s/.test(char)) first = index;
    }
    if (first >= 0) {
      const clipped = end === limit && limit < text.length;
      return `${sanitizeBounded(text.slice(first, end), maxChars)}${clipped ? "…" : ""}`;
    }
    remaining -= limit;
    if (remaining <= 0) return "…";
  }
  return "(no output)";
}

function contentText(content: unknown): string {
  if (typeof content === "string") return sanitize(content);
  if (!Array.isArray(content)) return "";
  return content.map((part) => (part?.type === "text" ? part.text : part?.type === "image" ? "[image]" : "")).join("\n");
}

function compactJson(value: unknown, maxChars: number): string {
  try {
    return boundedJson(value, Math.max(16, maxChars), 0, new WeakSet());
  } catch {
    return "[unserializable arguments]";
  }
}

function boundedJson(value: unknown, budget: number, depth: number, seen: WeakSet<object>): string {
  if (budget <= 1) return "…";
  if (typeof value === "string") {
    return JSON.stringify(sanitizeBounded(value, Math.max(1, budget - 2)));
  }
  if (typeof value === "number" || typeof value === "boolean" || value === null) return String(value);
  if (value === undefined) return "null";
  if (typeof value !== "object") return JSON.stringify(String(value));
  if (seen.has(value)) return '"[circular]"';
  if (depth >= 4) return '"…"';
  seen.add(value);
  const parts: string[] = [];
  let used = 2;
  const append = (text: string) => {
    const separator = parts.length ? 1 : 0;
    if (used + separator + text.length > budget) return false;
    parts.push(text);
    used += separator + text.length;
    return true;
  };
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length && index < 12; index += 1) {
      if (!append(boundedJson(value[index], Math.max(8, budget - used), depth + 1, seen))) break;
    }
    if (parts.length < value.length) append('"…"');
    seen.delete(value);
    return `[${parts.join(",")}]`;
  }
  let visited = 0;
  for (const key in value as Record<string, unknown>) {
    if (!Object.prototype.hasOwnProperty.call(value, key)) continue;
    if (visited++ >= 12) break;
    const keyText = JSON.stringify(sanitizeBounded(key, Math.min(64, Math.max(1, budget - used - 4))));
    const item = boundedJson((value as Record<string, unknown>)[key], Math.max(8, budget - used - keyText.length - 1), depth + 1, seen);
    if (!append(`${keyText}:${item}`)) break;
  }
  if (visited > parts.length) append('"…":"…"');
  seen.delete(value);
  return `{${parts.join(",")}}`;
}

function safePrettyJson(value: unknown): string {
  try {
    return JSON.stringify(sanitizeStructured(value), null, 2);
  } catch {
    return "[unserializable arguments]";
  }
}

function sanitizeStructured(value: unknown, seen = new WeakMap<object, unknown>()): unknown {
  if (typeof value === "string") return sanitize(value);
  if (!value || typeof value !== "object") return value;
  const cached = seen.get(value);
  if (cached !== undefined) return cached;
  if (Array.isArray(value)) {
    const copy: unknown[] = [];
    seen.set(value, copy);
    for (const item of value) copy.push(sanitizeStructured(item, seen));
    return copy;
  }
  const copy: Record<string, unknown> = {};
  seen.set(value, copy);
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) copy[key] = sanitizeStructured(item, seen);
  return copy;
}

function sanitizeBounded(value: string, maxChars: number): string {
  const limit = Math.max(0, maxChars);
  if (value.length <= limit) return sanitize(value);
  // Artificial terminators ensure a clipped OSC/DCS sequence cannot escape as
  // live terminal control data. Both added terminators are removed by sanitize.
  return `${sanitize(`${value.slice(0, limit)}\x07\x1b\\`)}…`;
}

function sanitize(value: string): string {
  return value
    .replace(/\x1B\][\s\S]*?(?:\x07|\x1B\\)/g, "")
    .replace(/\x1B[P^_X][\s\S]*?\x1B\\/g, "")
    .replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/\x1B[@-_]/g, "")
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "")
    .replace(/\t/g, "  ");
}

function batchLine(batch: BatchView, now: number, theme: Theme): string {
  const icon = theme.fg(batch.active ? "warning" : batch.failed ? "error" : "success", batch.active ? "◐" : batch.failed ? "!" : "✓");
  const roles = [...batch.roleCounts.entries()].map(([role, count]) => roleText(`${role}×${count}`, role, theme)).join("  ");
  const heading = batch.rootCall?.heading
    ? `  ${theme.fg("accent", stripLeadingRoleNames(batch.rootCall.heading, [...batch.roleCounts.keys()]))}`
    : "";
  return `${icon}${heading}  ${batch.invocations.length} ${batch.invocations.length === 1 ? "agent" : "agents"}  ${roles}  ·  ${formatTokens(batch.usage.total)}  ·  ${formatDuration((batch.finishedAt ?? now) - batch.startedAt)}  ·  ${costText(batch.usage.cost, theme)}`;
}

function framedView(
  heading: string,
  count: string,
  panelTitle: string,
  rows: string[],
  hints: string,
  width: number,
  height: number,
  theme: Theme,
): string[] {
  const innerWidth = Math.max(0, width - 2);
  const bodyHeight = Math.max(1, height - 4);
  const headingLine = joinSides(`  ${theme.fg("accent", heading)}`, `${theme.fg("muted", count)}  `, width);
  const title = innerWidth >= 4 ? ` ${truncateToWidth(panelTitle, Math.max(0, innerWidth - 3))} ` : "";
  const titleWidth = visibleWidth(title);
  const top = `${theme.fg("border", "╭")}${theme.fg("border", "─")}${title ? theme.fg("text", title) : ""}${theme.fg("border", "─".repeat(Math.max(0, innerWidth - 1 - titleWidth)))}${theme.fg("border", "╮")}`;
  const bottom = `${theme.fg("border", "╰")}${theme.fg("border", "─".repeat(innerWidth))}${theme.fg("border", "╯")}`;
  const divider = theme.fg("border", "│");
  const body = rows.slice(0, bodyHeight);
  while (body.length < bodyHeight) body.push("");
  return [
    headingLine,
    top,
    ...body.map((row) => `${divider}${padLine(row, innerWidth)}${divider}`),
    bottom,
    truncateToWidth(theme.fg("dim", `  ${hints}`), width),
  ].slice(0, height);
}

function centeredFrameTitle(title: string, width: number, border: (value: string) => string): string {
  const innerWidth = Math.max(0, width - 2);
  if (!title || innerWidth < 3) return border(`╭${"─".repeat(innerWidth)}╮`);
  const content = ` ${truncateToWidth(title, Math.max(1, innerWidth - 2), "…")} `;
  const remaining = Math.max(0, innerWidth - visibleWidth(content));
  const left = Math.floor(remaining / 2);
  const right = remaining - left;
  return `${border(`╭${"─".repeat(left)}`)}${content}${border(`${"─".repeat(right)}╮`)}`;
}

function compactTaskHeading(task: string): string {
  return sanitize(task).replace(/\s+/g, " ").trim().split(" ").filter(Boolean).slice(0, 6).join(" ");
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

function joinThree(left: string, middle: string, right: string, width: number, theme: Theme): string {
  const middleWidth = width - visibleWidth(left) - visibleWidth(right) - 4;
  if (!middle || middleWidth < 8) return joinWithDotLeader(left, right, width, theme);
  const clipped = truncateToWidth(middle, middleWidth, "…");
  return `${left}  ${fitWithDotLeader(clipped, middleWidth, theme)}  ${right}`;
}

function clamp(index: number, length: number): number {
  return Math.max(0, Math.min(index, Math.max(0, length - 1)));
}

function clampById(rows: FlatNode[], id: string | undefined, fallback: number): number {
  if (id) {
    const found = rows.findIndex((row) => row.invocation.id === id);
    if (found >= 0) return found;
  }
  return clamp(fallback, rows.length);
}

function windowStart(index: number, total: number, room: number): number {
  return Math.max(0, Math.min(index - Math.floor(room / 2), Math.max(0, total - room)));
}

function fit(lines: string[], height: number): string[] {
  if (lines.length > height) return lines.slice(0, height);
  return [...lines, ...Array.from({ length: height - lines.length }, () => "")];
}

function constrain(lines: string[], width: number): string[] {
  const safeWidth = Math.max(0, width);
  return lines.map((line) => visibleWidth(line) <= safeWidth ? line : truncateToWidth(line, safeWidth));
}
