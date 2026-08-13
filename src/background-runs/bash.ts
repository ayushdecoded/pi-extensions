import type {
  AgentToolResult,
  AgentToolUpdateCallback,
  ExtensionContext,
  Theme,
  ToolDefinition,
  ToolRenderResultOptions,
} from "@earendil-works/pi-coding-agent";
import { createBashToolDefinition } from "@earendil-works/pi-coding-agent";
import { Text, type Component } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import type { BackgroundRunRegistry } from "./registry.ts";
import type { BackgroundManageRequest, BackgroundBashParams } from "./types.ts";
import { formatDuration } from "../ui/panel.ts";

/** Structural stand-in for the runtime's ToolRenderContext (not re-exported by the package). */
type RenderContext = {
  args: unknown;
  toolCallId: string;
  invalidate: () => void;
  lastComponent: Component | undefined;
  state: any;
  cwd: string;
  executionStarted: boolean;
  argsComplete: boolean;
  isPartial: boolean;
  expanded: boolean;
  showImages: boolean;
  isError: boolean;
};

const MANAGE_ACTIONS = Type.Union(
  [Type.Literal("status"), Type.Literal("logs"), Type.Literal("kill")],
  { description: "status: state and elapsed time · logs: tail of the run output · kill: terminate the process tree" },
);

const BACKGROUND_PARAM = Type.Union(
  [
    Type.Literal(true, { description: "Launch the command as a background run and keep working; results are delivered as a follow-up message when it settles." }),
    Type.Object(
      {
        action: MANAGE_ACTIONS,
        runId: Type.String({ minLength: 1, description: "Run id from the launch receipt (r_...)." }),
      },
      { additionalProperties: false, description: "Manage an existing background run instead of executing a command." },
    ),
  ],
  { description: "Background execution: true launches detached; {action, runId} manages a running run." },
);

export type BackgroundBashToolOptions = {
  /** Working directory for foreground calls (session cwd at registration time). */
  cwd: string;
  registry: BackgroundRunRegistry;
};

/**
 * Thin wrapper over the built-in bash tool. Foreground calls delegate to the
 * built-in definition untouched; `background: true` launches a detached run and
 * `background: {action, runId}` manages one. One tool, one schema.
 */
export function createBackgroundBashTool(options: BackgroundBashToolOptions): ToolDefinition<any, any, any> {
  const builtin = createBashToolDefinition(options.cwd);
  // The built-in definition's parameter/render types are narrower than ours
  // (we widen the schema with `background`); cast once so delegation stays clean.
  const builtinExecute = builtin.execute as (
    toolCallId: string,
    params: { command: string; timeout?: number },
    signal: AbortSignal | undefined,
    onUpdate: AgentToolUpdateCallback<unknown> | undefined,
    ctx: ExtensionContext,
  ) => Promise<AgentToolResult<any>>;
  const builtinRenderCall = builtin.renderCall as (args: unknown, theme: Theme, context: RenderContext) => Component;
  const builtinRenderResult = builtin.renderResult as (
    result: AgentToolResult<any>,
    options: ToolRenderResultOptions,
    theme: Theme,
    context: RenderContext,
  ) => Component;

  const parameters = Type.Object(
    {
      command: Type.Optional(Type.String({ description: "Bash command to execute" })),
      timeout: Type.Optional(Type.Number({ description: "Timeout in seconds (optional, no default timeout)" })),
      background: Type.Optional(BACKGROUND_PARAM),
    },
    { additionalProperties: false },
  );

  return {
    name: "bash",
    label: "bash",
    description:
      "Execute a bash command in the current working directory. Returns stdout and stderr. Output is truncated to last 200 lines or 50KB (whichever is hit first). If truncated, full output is saved to a temp file. Optionally provide a timeout in seconds. " +
      "Pass background: true to launch the command detached and continue working; a follow-up message with the tail output is delivered when it settles, and the receipt includes the run id. " +
      "Manage a background run with background: {action: \"status\" | \"logs\" | \"kill\", runId}. status reports state and elapsed time, logs returns the tail of the run output, kill terminates the process tree.",
    promptSnippet: builtin.promptSnippet,
    promptGuidelines: builtin.promptGuidelines,
    parameters,
    execute: async (
      toolCallId: string,
      params: BackgroundBashParams,
      signal: AbortSignal | undefined,
      onUpdate: AgentToolUpdateCallback<unknown> | undefined,
      ctx: ExtensionContext,
    ): Promise<AgentToolResult<any>> => {
      const { command, timeout, background } = params;
      if (background !== undefined && typeof background === "object") {
        return manageRun(options.registry, background);
      }
      if (background === true) {
        if (!command) throw new Error("background: true requires a command to launch.");
        const record = options.registry.launch(command, ctx.cwd, { timeoutSeconds: timeout });
        return {
          content: [{ type: "text", text: formatLaunchReceipt(record) }],
          details: { background: true, runId: record.id, status: "started" as const },
        };
      }
      if (!command) throw new Error("command is required.");
      return builtinExecute(toolCallId, { command, timeout }, signal, onUpdate, ctx);
    },
    renderCall(args, theme, context) {
      const bg = (args as BackgroundBashParams).background;
      if (bg !== undefined && typeof bg === "object") {
        if (context.executionStarted && context.state.startedAt === undefined) {
          context.state.startedAt = Date.now();
          context.state.endedAt = undefined;
        }
        const text = (context.lastComponent ?? new Text("", 0, 0)) as Text;
        text.setText(theme.fg("toolTitle", theme.bold(`$ bg ${bg.action} ${bg.runId}`)));
        return text;
      }
      return builtinRenderCall(args, theme, context);
    },
    renderResult(result, options, theme, context) {
      return builtinRenderResult(result, options, theme, context);
    },
  };
}

function manageRun(registry: BackgroundRunRegistry, request: BackgroundManageRequest): AgentToolResult<any> {
  const { action, runId } = request;
  const record = registry.get(runId);
  if (!record) throw new Error(`Unknown background run: ${runId}`);
  switch (action) {
    case "status":
      return textResult(formatStatus(record));
    case "logs": {
      const logs = registry.logs(runId);
      const output = logs?.tail.trimEnd();
      const full = logs?.file ? `\n\n[Full output: ${logs.file}]` : "";
      return textResult(`[Background run · ${runId} · ${record.status}]\n${output ? output : "(no output yet)"}${full}`);
    }
    case "kill": {
      const updated = registry.kill(runId);
      return textResult(
        updated && updated.status === "cancelled"
          ? `[Background run · ${runId} · killed]`
          : `[Background run · ${runId} · not running (${updated?.status ?? "gone"})]`,
      );
    }
  }
}

function textResult(text: string): AgentToolResult<any> {
  return { content: [{ type: "text", text }], details: {} };
}

function formatLaunchReceipt(record: { id: string; command: string }): string {
  return [
    `[Background run · ${record.id} · started]`,
    `$ ${record.command}`,
    `Manage with bash({ background: { action: "status" | "logs" | "kill", runId: "${record.id}" } }).`,
  ].join("\n");
}

function formatStatus(record: { id: string; command: string; status: string; startedAt: number; finishedAt?: number; exitCode?: number | null; error?: string }): string {
  const elapsed = formatDuration((record.finishedAt ?? Date.now()) - record.startedAt);
  const exit = record.exitCode !== undefined && record.exitCode !== null ? ` · exit ${record.exitCode}` : "";
  const error = record.error ? `\n${record.error}` : "";
  return `[Background run · ${record.id} · ${record.status} · ${elapsed}${exit}]\n$ ${record.command}${error}`;
}
