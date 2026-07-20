import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { ToolExecutionComponent } from "@earendil-works/pi-coding-agent";
import type { TUI } from "@earendil-works/pi-tui";

const BUILT_IN_TOOL_NAMES = new Set(["read", "bash", "edit", "write", "grep", "find", "ls"]);
const OMITTED_IMAGE_TEXT = "[image omitted in transcript viewer]";

type DisplayResult = {
  content: Array<{ type: string; text?: string; data?: string; mimeType?: string }>;
  details?: unknown;
  isError: boolean;
};

export type NativeToolView = {
  id: string;
  name: string;
  args: unknown;
  argsVersion: string;
  argsComplete: boolean;
  executionStarted: boolean;
  result?: DisplayResult;
  resultVersion: string;
  isPartial: boolean;
  definition?: ToolDefinition;
};

type NativeEntry = {
  component: ToolExecutionComponent;
  toolName: string;
  definition?: ToolDefinition;
  argsVersion: string;
  argsComplete: boolean;
  executionStarted: boolean;
  resultVersion: string;
  result?: DisplayResult;
  isPartial: boolean;
  renderRevision: number;
  rendered?: { width: number; state: string; lines: string[] };
};

/**
 * Small public-API adapter around Pi's version-sensitive native tool component.
 * Instances are scoped to one selected transcript and keep only the latest state
 * and rendered lines for each tool call.
 */
export class NativeToolRenderer {
  private source?: string;
  private expanded = false;
  private readonly entries = new Map<string, NativeEntry>();
  private readonly synchronizing = new Set<string>();

  constructor(
    private readonly tui: TUI,
    private readonly cwd: string,
    private readonly onInvalidate: (toolCallId: string) => void,
  ) {}

  setSource(source: string): void {
    if (this.source === source) return;
    this.clear();
    this.source = source;
  }

  setExpanded(expanded: boolean): void {
    if (this.expanded === expanded) return;
    this.expanded = expanded;
    for (const [id, entry] of this.entries) {
      this.withSynchronization(id, () => entry.component.setExpanded(expanded));
      entry.rendered = undefined;
    }
  }

  isBuiltIn(name: string): boolean {
    return BUILT_IN_TOOL_NAMES.has(name);
  }

  canRender(name: string, definition?: ToolDefinition): boolean {
    return this.isBuiltIn(name) || definition !== undefined;
  }

  revisionFor(id: string): number {
    return this.entries.get(id)?.renderRevision ?? 0;
  }

  reconcile(visibleCallIds: ReadonlySet<string>, preserveCallIds?: ReadonlySet<string>): void {
    for (const [id, entry] of this.entries) {
      if (visibleCallIds.has(id) || preserveCallIds?.has(id)) continue;
      this.discard(id, entry);
      this.entries.delete(id);
    }
  }

  render(view: NativeToolView, width: number): string[] | undefined {
    if (!this.canRender(view.name, view.definition)) return undefined;
    let entry = this.entries.get(view.id);
    if (entry && (entry.toolName !== view.name || entry.definition !== view.definition)) {
      this.discard(view.id, entry);
      this.entries.delete(view.id);
      entry = undefined;
    }
    if (!entry) {
      try {
        const component = new ToolExecutionComponent(
          sanitize(view.name),
          view.id,
          sanitizeValue(view.args),
          { showImages: false },
          view.definition,
          this.componentTui(view.id),
          this.cwd,
        );
        component.setExpanded(this.expanded);
        entry = {
          component,
          toolName: view.name,
          definition: view.definition,
          argsVersion: view.argsVersion,
          argsComplete: false,
          executionStarted: false,
          resultVersion: "",
          isPartial: true,
          renderRevision: 0,
        };
        this.entries.set(view.id, entry);
      } catch {
        return undefined;
      }
    }

    this.withSynchronization(view.id, () => {
      if (entry!.argsVersion !== view.argsVersion) {
        entry!.component.updateArgs(sanitizeValue(view.args));
        entry!.argsVersion = view.argsVersion;
        entry!.rendered = undefined;
      }
      if (view.executionStarted && !entry!.executionStarted) {
        entry!.component.markExecutionStarted();
        entry!.executionStarted = true;
        entry!.rendered = undefined;
      }
      if (view.argsComplete && !entry!.argsComplete) {
        entry!.component.setArgsComplete();
        entry!.argsComplete = true;
        entry!.rendered = undefined;
      }
      if (entry!.resultVersion !== view.resultVersion || entry!.isPartial !== view.isPartial) {
        const result = view.result ? sanitizeResult(view.result) : { content: [], isError: false };
        entry!.component.updateResult(result, view.isPartial);
        entry!.result = result;
        entry!.resultVersion = view.resultVersion;
        entry!.isPartial = view.isPartial;
        entry!.rendered = undefined;
      }
    });

    const safeWidth = Math.max(1, width);
    const state = `${entry.argsVersion}|${entry.argsComplete ? 1 : 0}|${entry.executionStarted ? 1 : 0}|${entry.resultVersion}|${entry.isPartial ? 1 : 0}|${this.expanded ? 1 : 0}|${entry.renderRevision}`;
    if (entry.rendered?.width === safeWidth && entry.rendered.state === state) return entry.rendered.lines;
    try {
      const lines = entry.component.render(safeWidth);
      entry.rendered = { width: safeWidth, state, lines };
      return lines;
    } catch {
      return undefined;
    }
  }

  invalidate(): void {
    this.clear();
    this.source = undefined;
  }

  dispose(): void {
    this.clear();
    this.source = undefined;
  }

  private componentTui(toolCallId: string): TUI {
    return new Proxy(this.tui, {
      get: (target, property, receiver) => {
        if (property !== "requestRender") return Reflect.get(target, property, receiver);
        return () => {
          if (this.synchronizing.has(toolCallId)) return;
          const entry = this.entries.get(toolCallId);
          if (entry) {
            entry.renderRevision += 1;
            entry.rendered = undefined;
          }
          this.onInvalidate(toolCallId);
          this.tui.requestRender();
        };
      },
    });
  }

  private withSynchronization(id: string, update: () => void): void {
    this.synchronizing.add(id);
    try {
      update();
    } finally {
      this.synchronizing.delete(id);
    }
  }

  private clear(): void {
    for (const [id, entry] of this.entries) this.discard(id, entry);
    this.entries.clear();
  }

  private discard(id: string, entry: NativeEntry): void {
    if (!entry.isPartial || !entry.result) return;
    // Bash's native partial renderer owns a one-second elapsed-time interval.
    // Delivering a final state before dropping the component clears that timer.
    this.withSynchronization(id, () => entry.component.updateResult(entry.result!, false));
  }
}

function sanitizeResult(result: DisplayResult): DisplayResult {
  return {
    content: result.content.map((part) => part.type === "image"
      ? { type: "text", text: OMITTED_IMAGE_TEXT }
      : { ...part, ...(typeof part.text === "string" ? { text: sanitize(part.text) } : {}) }),
    details: sanitizeValue(result.details),
    isError: result.isError,
  };
}

function sanitizeValue<T>(value: T, seen = new WeakMap<object, unknown>()): T {
  if (typeof value === "string") return sanitize(value) as T;
  if (!value || typeof value !== "object") return value;
  const cached = seen.get(value as object);
  if (cached !== undefined) return cached as T;
  if (Array.isArray(value)) {
    const copy: unknown[] = [];
    seen.set(value, copy);
    for (const item of value) copy.push(sanitizeValue(item, seen));
    return copy as T;
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return value;
  const copy: Record<string, unknown> = {};
  seen.set(value as object, copy);
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) copy[key] = sanitizeValue(item, seen);
  return copy as T;
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
