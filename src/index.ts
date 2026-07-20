import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  AGENTS_CONFIG_FILE_NAME,
  THINKING_LEVELS,
  agentsConfigPath,
  globalAgentsPath,
  loadAgentsConfig,
  packageAgentsPath,
  parseAgentsConfig,
  projectAgentsPath,
  validateAgentsConfig,
  validateAgentsFile,
} from "./config/agents.ts";
import type {
  AgentRole,
  AgentsConfig,
  AgentsConfigValidation,
  AgentsDefaults,
  LoadAgentsConfigOptions,
  ThinkingLevel,
} from "./config/agents.ts";
import { registerHandoffCommand } from "./handoff.ts";
import { registerAutoRename } from "./auto-rename.ts";
import { registerLongTaskNotifications } from "./long-task-notifications.ts";
import { SubagentRuntime } from "./runtime/runtime.ts";
import { replayRuntimeState, SUBAGENT_ENTRY_TYPE } from "./runtime/state.ts";
import { registerThinkingShortcuts } from "./shortcuts.ts";
import { registerPackSystemPrompt } from "./system-prompt.ts";
import { createSubagentHeadingGenerator } from "./subagent-headings.ts";
import type { SubagentEvent } from "./runtime/types.ts";
import { createSubagentTool } from "./tool.ts";
import { AgentsDashboard } from "./ui/dashboard.ts";
import { createFooterController } from "./ui/footer.ts";
import { installHeader } from "./ui/header.ts";
import { AgentsPanel } from "./ui/panel.ts";
import { FullPasteEditor } from "./ui/full-paste-editor.ts";
import { registerPromptDuration } from "./ui/prompt-duration.ts";
import { registerProactiveCompaction } from "./proactive-compaction.ts";
import registerWebSearch from "./web-search/index.ts";

const WIDGET_KEY = "pi-subagents";

export {
  AGENTS_CONFIG_FILE_NAME,
  THINKING_LEVELS,
  agentsConfigPath,
  globalAgentsPath,
  loadAgentsConfig,
  packageAgentsPath,
  parseAgentsConfig,
  projectAgentsPath,
  validateAgentsConfig,
  validateAgentsFile,
};
export type {
  AgentRole,
  AgentsConfig,
  AgentsConfigValidation,
  AgentsDefaults,
  LoadAgentsConfigOptions,
  ThinkingLevel,
};

export default function subagentExtension(pi: ExtensionAPI): void {
  let runtime: SubagentRuntime | undefined;
  let registered = false;
  const footer = createFooterController(pi);
  registerPackSystemPrompt(pi);
  registerThinkingShortcuts(pi);
  registerAutoRename(pi);
  registerHandoffCommand(pi);
  const notifyLongTask = registerLongTaskNotifications(pi);
  registerPromptDuration(pi, undefined, notifyLongTask);
  registerProactiveCompaction(pi);
  registerWebSearch(pi);

  const activate = async (ctx: ExtensionContext, config: AgentsConfig): Promise<void> => {
    const previous = runtime;
    runtime = undefined;
    await previous?.shutdown();

    const allState = replayRuntimeState(ctx.sessionManager.getEntries());
    const activeState = replayRuntimeState(ctx.sessionManager.getBranch());
    runtime = new SubagentRuntime(
      {
        rootSessionId: ctx.sessionManager.getSessionId(),
        rootSessionFile: ctx.sessionManager.getSessionFile(),
        cwd: ctx.cwd,
        config,
        modelRegistry: ctx.modelRegistry,
        reservedHandles: new Set(allState.agents.keys()),
        appendEvent: (event: SubagentEvent) => pi.appendEntry(SUBAGENT_ENTRY_TYPE, event),
        generateHeadings: createSubagentHeadingGenerator(ctx.modelRegistry),
      },
      activeState,
    );
    runtime.reconcileInterrupted();
    const sessionRuntime = runtime;
    if (ctx.mode === "tui") {
      ctx.ui.setWidget(WIDGET_KEY, (tui, theme) => new AgentsPanel(sessionRuntime, tui, theme));
      footer.install(ctx, sessionRuntime);
    }
  };

  pi.on("session_start", async (_event, ctx) => {
    let config: AgentsConfig;
    try {
      config = loadAgentsConfig({ cwd: ctx.cwd });
      if (config.path === projectAgentsPath(ctx.cwd) && !ctx.isProjectTrusted()) {
        throw new Error("Project agents.yaml is disabled because this project is not trusted.");
      }
    } catch (error) {
      notifyError(ctx, error);
      return;
    }

    installHeader(ctx, config);
    if (ctx.mode === "tui") {
      ctx.ui.setEditorComponent((tui, theme, keybindings) => new FullPasteEditor(tui, theme, keybindings));
    }
    await activate(ctx, config);
    if (!registered) {
      pi.registerTool(
        createSubagentTool(config, (requests, signal, onProgress) => {
          if (!runtime) throw new Error("Subagent runtime is not available for this session.");
          return runtime.runRootBatch(requests, signal, onProgress);
        }),
      );
      registered = true;
    }
  });

  pi.on("session_tree", async (_event, ctx) => {
    const config = runtime?.options.config;
    if (config) await activate(ctx, config);
  });

  pi.registerCommand("agents", {
    description: "Inspect subagent batches, trees, and transcripts",
    handler: async (_args, ctx) => {
      if (!runtime) {
        ctx.ui.notify("Subagent runtime is unavailable for this session.", "warning");
        return;
      }
      if (ctx.mode !== "tui") {
        ctx.ui.notify("The agents dashboard requires TUI mode.", "warning");
        return;
      }
      const selectedRuntime = runtime;
      await ctx.ui.custom<void>(
        (tui, theme, keybindings, done) => new AgentsDashboard(selectedRuntime, tui, theme, keybindings, done),
        {
          overlay: true,
          overlayOptions: { anchor: "top-left", width: "100%", maxHeight: "100%" },
        },
      );
    },
  });

  pi.on("message_end", () => footer.requestRender(true));
  pi.on("turn_start", () => footer.requestRender());
  pi.on("turn_end", () => footer.requestRender());
  pi.on("tool_execution_start", () => footer.requestRender());
  pi.on("tool_execution_end", () => footer.requestRender());
  pi.on("model_select", () => footer.requestRender());
  pi.on("thinking_level_select", () => footer.requestRender());

  pi.on("session_shutdown", async (_event, ctx) => {
    ctx.ui.setWidget(WIDGET_KEY, undefined);
    ctx.ui.setFooter(undefined);
    ctx.ui.setHeader(undefined);
    footer.dispose();
    const active = runtime;
    runtime = undefined;
    await active?.shutdown();
  });
}

function notifyError(ctx: ExtensionContext, error: unknown): void {
  if (!ctx.hasUI) return;
  const message = error instanceof Error ? error.message : String(error);
  ctx.ui.notify(`Subagent extension unavailable: ${message}`, "error");
}
