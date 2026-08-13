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
  resolvePreset,
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
import { createActiveModeStore, resolveActiveMode } from "./config/mode.ts";
import { deliverBackgroundBatchResult } from "./background.ts";
import { createVisionHookHandler } from "./runtime/vision-hook.ts";
import { registerHandoffCommand } from "./handoff.ts";
import { registerAutoRename } from "./auto-rename.ts";
import { registerSaveMarkdown } from "./save-md.ts";
import { SubagentRuntime } from "./runtime/runtime.ts";
import { replayRuntimeState, SUBAGENT_ENTRY_TYPE } from "./runtime/state.ts";
import { registerThinkingShortcuts } from "./shortcuts.ts";
import { registerPackSystemPrompt } from "./system-prompt.ts";
import { createSubagentHeadingGenerator } from "./subagent-headings.ts";
import type { SubagentEvent } from "./runtime/types.ts";
import { createSubagentTool } from "./tool.ts";
import { AgentsDashboard } from "./ui/dashboard.ts";
import { createFooterController, contextLabelFor } from "./ui/footer.ts";
import { installHeader } from "./ui/header.ts";
import { AgentsPanel } from "./ui/panel.ts";
import { createEmojiAutocompleteProvider } from "./ui/emoji-autocomplete.ts";
import { FullPasteEditor } from "./ui/full-paste-editor.ts";
import { registerPromptDuration } from "./ui/prompt-duration.ts";
import { registerProactiveCompaction } from "./proactive-compaction.ts";
import { createPainterTool } from "./painter.ts";
import { createAccountController, type AccountController } from "./accounts/controller.ts";
import { registerAccountCommands } from "./accounts/commands.ts";
import { registerVoiceInput } from "./voice-input.ts";
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
  resolvePreset,
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
  let currentConfig: AgentsConfig | undefined;
  let registered = false;
  const activeModeStore = createActiveModeStore();
  const accounts = createAccountController(pi);
  const footer = createFooterController(pi, {
    accountName: (providerId) => {
      const account = accounts.accountForProviderId(providerId);
      return account?.id === "default" ? undefined : account?.name;
    },
  });
  const stopAccounts = accounts.coordinator.subscribe(() => {
    footer.setCodexWeeklyRemaining(codexWeeklyRemaining(accounts));
    footer.requestRender();
  });
  registerPackSystemPrompt(pi);
  registerThinkingShortcuts(pi);
  registerAccountCommands(pi, accounts);
  registerVoiceInput(pi, { codexProvider: () => accounts.selectedProviderId("openai-codex") });
  registerAutoRename(pi);
  registerSaveMarkdown(pi);
  registerHandoffCommand(pi);
  registerPromptDuration(pi);
  registerProactiveCompaction(pi);
  registerWebSearch(pi);
  pi.registerTool(createPainterTool({ codexProvider: () => accounts.selectedProviderId("openai-codex") }));

  // The main session's read tool also rides the vision hook: when the main model
  // is text-only and reads an image, the sidecar description is appended to the
  // read result so the transcript keeps the image while the model still gets a
  // description of it.
  pi.on("tool_result", createVisionHookHandler(() => ({
    sidecar: currentConfig?.defaults.image,
    promptFile: currentConfig?.defaults.imagePromptFile,
  }), undefined, accounts.childExtension, accounts.routeModel));

  const activate = async (ctx: ExtensionContext, config: AgentsConfig, activeMode?: string): Promise<void> => {
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
        activeMode,
        modelRegistry: ctx.modelRegistry,
        reservedHandles: new Set(allState.agents.keys()),
        appendEvent: (event: SubagentEvent) => pi.appendEntry(SUBAGENT_ENTRY_TYPE, event),
        generateHeadings: createSubagentHeadingGenerator(
          ctx.modelRegistry,
          () => accounts.selectedProviderId("openai-codex"),
        ),
        accountExtension: accounts.childExtension,
        routeAccountModel: accounts.routeModel,
      },
      activeState,
    );
    runtime.reconcileInterrupted();
    const sessionRuntime = runtime;
    installHeader(ctx, config, pi.getCommands(), sessionRuntime);
    if (ctx.mode === "tui") {
      ctx.ui.setWidget(WIDGET_KEY, (tui, theme) => new AgentsPanel(sessionRuntime, tui, theme));
      footer.install(ctx, sessionRuntime);
    }
  };

  /** Register or replace the root subagent tool with the active preset's role set. */
  const registerSubagentTool = (config: AgentsConfig): void => {
    pi.registerTool(
      createSubagentTool(
        config,
        (requests, signal, onProgress) => {
          if (!runtime) throw new Error("Subagent runtime is not available for this session.");
          return runtime.runRootBatch(requests, signal, onProgress);
        },
        {
          startBackgroundBatch: (requests) => {
            const owner = runtime;
            if (!owner) throw new Error("Subagent runtime is not available for this session.");
            const launch = owner.startRootBatch(requests);
            void deliverBackgroundBatchResult(
              launch,
              (message, options) => pi.sendMessage(message, options),
              () => runtime === owner,
            );
            return launch;
          },
        },
      ),
    );
  };

  /** Switch the active preset, persist it, and refresh the tool schema. */
  const switchMode = (ctx: ExtensionContext, name: string | undefined): void => {
    const active = runtime;
    if (!active) {
      ctx.ui.notify("Subagent runtime is unavailable for this session.", "warning");
      return;
    }
    if (active.options.config.presets.length === 0) {
      ctx.ui.notify("No agent presets are configured in agents.yaml.", "warning");
      return;
    }
    if (!name) {
      ctx.ui.notify(`Usage: /agent-mode ${active.options.config.presets.map((preset) => preset.name).join("|")}`, "warning");
      return;
    }
    try {
      const canonical = active.setActiveMode(name);
      activeModeStore.save(active.options.config.path, canonical);
      ctx.ui.notify(`Agents mode: ${canonical}`, "info");
      registerSubagentTool({ ...active.options.config, roles: [...active.activeRoles] });
    } catch (error) {
      ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
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

    currentConfig = config;
    const activeMode = resolveActiveMode(config, activeModeStore.load(config.path));

    if (ctx.mode === "tui") {
      ctx.ui.addAutocompleteProvider(createEmojiAutocompleteProvider);
      ctx.ui.setEditorComponent(
        (tui, theme, keybindings) =>
          new FullPasteEditor(
            tui,
            theme,
            keybindings,
            () => runtime?.activeMode,
            () => contextLabelFor(ctx.getContextUsage(), ctx.ui.theme),
          ),
      );
    }
    await activate(ctx, config, activeMode);
    footer.setCodexWeeklyRemaining(codexWeeklyRemaining(accounts));
    if (!registered) {
      registerSubagentTool({ ...config, roles: resolvePreset(config, activeMode).roles });
      registered = true;
    }
  });

  pi.on("session_tree", async (_event, ctx) => {
    const config = currentConfig;
    const activeMode = runtime?.activeMode;
    if (config) await activate(ctx, config, activeMode);
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

  pi.registerCommand("agent-mode", {
    description: "Switch the active agent preset for subagent roles",
    getArgumentCompletions: (prefix) =>
      (runtime?.options.config.presets ?? [])
        .filter((preset) => preset.name.toLowerCase().startsWith(prefix.toLowerCase()))
        .map((preset) => ({
          value: preset.name,
          label: preset.name,
          description: `Roles: ${preset.roleNames.join(", ")}`,
        })),
    handler: async (args, ctx) => {
      const active = runtime;
      if (!active) {
        ctx.ui.notify("Subagent runtime is unavailable for this session.", "warning");
        return;
      }
      const presets = active.options.config.presets;
      if (presets.length === 0) {
        ctx.ui.notify("No agent presets are configured in agents.yaml.", "warning");
        return;
      }
      let name = args.trim();
      if (!name && ctx.hasUI) {
        const selected = await ctx.ui.select("Agent preset", presets.map((preset) => preset.name));
        if (!selected) return;
        name = selected;
      }
      switchMode(ctx, name);
    },
  });

  pi.registerShortcut("ctrl+shift+s", {
    description: "Cycle agent preset",
    handler: (ctx) => {
      const active = runtime;
      if (!active) {
        ctx.ui.notify("Subagent runtime is unavailable for this session.", "warning");
        return;
      }
      const presets = active.options.config.presets;
      if (presets.length === 0) {
        ctx.ui.notify("No agent presets are configured in agents.yaml.", "warning");
        return;
      }
      const current = active.activeMode;
      const index = current ? presets.findIndex((preset) => preset.name.toLowerCase() === current.toLowerCase()) : -1;
      switchMode(ctx, presets[(index + 1) % presets.length]!.name);
    },
  });

  pi.on("message_end", () => {
    footer.requestRender(true);
  });
  pi.on("turn_start", () => footer.requestRender());
  pi.on("turn_end", () => footer.requestRender());
  pi.on("tool_execution_start", () => footer.requestRender());
  pi.on("tool_execution_end", () => footer.requestRender());
  pi.on("model_select", () => footer.requestRender());
  pi.on("thinking_level_select", () => footer.requestRender());

  pi.on("session_shutdown", async (event, ctx) => {
    ctx.ui.setWidget(WIDGET_KEY, undefined);
    ctx.ui.setFooter(undefined);
    ctx.ui.setHeader(undefined);
    if (event.reason === "quit") {
      accounts.dispose();
      stopAccounts();
    }
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

function codexWeeklyRemaining(accounts: AccountController): number | undefined {
  const selected = accounts.accounts("openai-codex").find((account) => account.selected);
  const weekly = selected?.limits.find((window) =>
    window.windowSeconds === 604_800 || window.name.toLowerCase().includes("week"),
  );
  return weekly?.usedPercent === undefined ? undefined : Math.max(0, Math.min(100, 100 - weekly.usedPercent));
}
