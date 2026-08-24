import type { ExtensionAPI, ExtensionContext, SessionEntry, Theme } from "@earendil-works/pi-coding-agent";
import {
  AGENT_BACKENDS,
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
  AgentBackend,
  AgentRole,
  AgentsConfig,
  AgentsConfigValidation,
  AgentsDefaults,
  LoadAgentsConfigOptions,
  ThinkingLevel,
} from "./config/agents.ts";
import { createActiveModeStore, resolveActiveMode } from "./config/mode.ts";
import { createAgentModelOverrideStore, projectAgentsModelOverridesPath } from "./config/model-overrides.ts";
import {
  BACKGROUND_SUBAGENT_RESULT_TYPE,
  deliverBackgroundBatchResult,
  renderBackgroundBatchMessage,
} from "./background.ts";
import {
  BACKGROUND_RUN_RESULT_TYPE,
  deliverBackgroundRunResult,
  renderBackgroundRunMessage,
} from "./background-runs/message.ts";
import { createBackgroundBashTool } from "./background-runs/bash.ts";
import { ProcessesPanel } from "./background-runs/panel.ts";
import {
  BACKGROUND_RUNS_ENTRY_TYPE,
  BackgroundRunRegistry,
  reconcileBackgroundRuns,
} from "./background-runs/registry.ts";
import { createVisionHookHandler } from "./runtime/vision-hook.ts";
import { registerEmptyFinalGuard } from "./empty-final-guard.ts";
import { registerHandoffCommand } from "./handoff.ts";
import { registerAutoRename } from "./auto-rename.ts";
import { registerSaveMarkdown } from "./save-md.ts";
import { SubagentRuntime } from "./runtime/runtime.ts";
import { replayRuntimeState, SUBAGENT_ENTRY_TYPE } from "./runtime/state.ts";
import { registerThinkingShortcuts } from "./shortcuts.ts";
import type { TUI } from "@earendil-works/pi-tui";
import { registerPackSystemPrompt } from "./system-prompt.ts";
import { createSubagentHeadingGenerator } from "./subagent-headings.ts";
import type { SubagentEvent } from "./runtime/types.ts";
import { createSubagentTool } from "./tool.ts";
import { AgentsDashboard } from "./ui/dashboard.ts";
import {
  showAgentModelConfigure,
  type AgentConfigureScope,
  type AgentModelChoice,
  type AgentRoleConfigureChange,
} from "./ui/agents-configure.ts";
import { createFooterController, contextLabelFor } from "./ui/footer.ts";
import { installHeader } from "./ui/header.ts";
import { AgentsPanel } from "./ui/panel.ts";
import { BREAKDOWN_MESSAGE_TYPE, registerBreakdownCommand } from "./ui/breakdown.ts";
import { createEmojiAutocompleteProvider } from "./ui/emoji-autocomplete.ts";
import { FullPasteEditor } from "./ui/full-paste-editor.ts";
import { registerPromptDuration } from "./ui/prompt-duration.ts";
import { registerProactiveCompaction } from "./proactive-compaction.ts";
import { createPainterTool } from "./painter.ts";
import { createAccountController, type AccountController } from "./accounts/controller.ts";
import { registerAccountCommands } from "./accounts/commands.ts";
import { registerVoiceInput } from "./voice-input.ts";
import { createAskTool } from "./ask/index.ts";
import registerWebSearch from "./web-search/index.ts";
import { canonicalProviderId } from "./accounts/providers.ts";

const WIDGET_KEY = "pi-subagents";

/**
 * Reload survival. `/reload` re-imports this extension module (the loader
 * clears its cache), so module-level state is wiped — but the process and the
 * in-flight child sessions survive. The handoff registries therefore live on
 * `globalThis`, keyed by root session id, so the reloaded module instance can
 * adopt the runtime (and route settled follow-ups) that the old instance left
 * running.
 */
const RELOAD_STATE_KEY = "__piSubagentsReloadState__";

type ReloadState = {
  /** Runtimes handed off by a session reload, awaiting adoption by the next session_start. */
  detachedRuntimes: Map<string, SubagentRuntime>;
  /** Events recorded while a runtime was detached between reload and adoption. */
  detachedEventBuffer: Map<string, SubagentEvent[]>;
  /** The current runtime per root session id, for background-result routing. */
  sessionRuntimes: Map<string, SubagentRuntime>;
  /** The live extension sendMessage per root session id, resolved at settle time. */
  sessionSenders: Map<string, ExtensionAPI["sendMessage"]>;
  /** Follow-ups produced while a session was between reload and adoption. */
  bufferedFollowUps: Array<{
    sessionId: string;
    message: Parameters<ExtensionAPI["sendMessage"]>[0];
    options?: Parameters<ExtensionAPI["sendMessage"]>[1];
  }>;
  /** Per-session background-run registries, so detached processes stay tracked across reload. */
  backgroundRunRegistries: Map<string, BackgroundRunRegistry>;
  /** The live extension sendMessage per root session id, resolved at run settle time. */
  backgroundRunSenders: Map<string, ExtensionAPI["sendMessage"]>;
  /** Session ids whose composer agents panel is minimized to one summary line. */
  minimizedPanels: Set<string>;
};

function reloadState(): ReloadState {
  const global = globalThis as unknown as { [RELOAD_STATE_KEY]?: ReloadState };
  let state = global[RELOAD_STATE_KEY];
  if (!state) {
    state = {
      detachedRuntimes: new Map(),
      detachedEventBuffer: new Map(),
      sessionRuntimes: new Map(),
      sessionSenders: new Map(),
      bufferedFollowUps: [],
      backgroundRunRegistries: new Map(),
      backgroundRunSenders: new Map(),
      minimizedPanels: new Set(),
    };
    global[RELOAD_STATE_KEY] = state;
  }
  // A reload adopts the state an older extension instance created, which may
  // lack fields added since. Backfill so consumers never read undefined.
  state.minimizedPanels ??= new Set();
  return state;
}

export {
  AGENT_BACKENDS,
  AGENTS_CONFIG_FILE_NAME,
  THINKING_LEVELS,
  agentsConfigPath,
  globalAgentsPath,
  loadAgentsConfig,
  packageAgentsPath,
  parseAgentsConfig,
  projectAgentsPath,
  reloadState,
  resolvePreset,
  validateAgentsConfig,
  validateAgentsFile,
};
export type {
  AgentBackend,
  AgentRole,
  AgentsConfig,
  AgentsConfigValidation,
  AgentsDefaults,
  LoadAgentsConfigOptions,
  ThinkingLevel,
};

export default function subagentExtension(pi: ExtensionAPI): void {
  const reload = reloadState();
  // Closure-local aliases of the process-global handoff registries: each
  // reloaded module instance sees the same Map/array objects.
  const { detachedRuntimes, detachedEventBuffer, sessionRuntimes, sessionSenders, bufferedFollowUps, backgroundRunRegistries, backgroundRunSenders, minimizedPanels } = reload;
  let runtime: SubagentRuntime | undefined;
  let currentConfig: AgentsConfig | undefined;
  let registered = false;
  const activeModeStore = createActiveModeStore();
  const modelOverrideStore = createAgentModelOverrideStore(undefined, undefined, "$global");
  let projectOverrideStore = createAgentModelOverrideStore(undefined, projectAgentsModelOverridesPath(), "$project");
  let sessionOverrides = new Map<string, { model?: string; thinking?: ThinkingLevel; backend?: AgentBackend }>();
  let configureScope: AgentConfigureScope = "session";
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
  registerEmptyFinalGuard(pi);

  // Background terminal runs: detached processes launched through the bash tool,
  // tracked per session, killed on quit (left running on reload), listed via /ps.
  let composerTui: TUI | undefined;
  let backgroundRuns: BackgroundRunRegistry | undefined;
  /** Per-session setters that collapse/restore the composer agents panel. */
  const panelMinimizeSetters = new Map<string, (minimized: boolean) => void>();

  /** Collapse or restore the composer agents panel for this session. */
  const setAgentsPanelMinimized = (ctx: ExtensionContext, minimized: boolean): void => {
    const set = panelMinimizeSetters.get(ctx.sessionManager.getSessionId());
    if (!set) {
      ctx.ui.notify("The agents panel is only available in TUI mode.", "warning");
      return;
    }
    set(minimized);
    ctx.ui.notify(minimized ? "Agents panel minimized (alt+m to expand)" : "Agents panel expanded (alt+m to minimize)", "info");
  };

  /**
   * The registry for this session. A reload re-imports this module, so the
   * registry lives in the global reload state: the reloaded instance adopts the
   * existing one (with its live process handlers) and re-points persistence at
   * its own session API. The settle listener is registered once, at creation,
   * and resolves the session's live sender at settle time.
   */
  const getBackgroundRuns = (sessionId: string, entries: readonly SessionEntry[]): BackgroundRunRegistry => {
    let registry = backgroundRunRegistries.get(sessionId);
    if (!registry) {
      registry = new BackgroundRunRegistry({
        appendEvent: (event) => pi.appendEntry(BACKGROUND_RUNS_ENTRY_TYPE, event),
      });
      registry.seed(reconcileBackgroundRuns(entries));
      registry.onSettled((result) => {
        deliverBackgroundRunResult(result, (message, options) => backgroundRunSenders.get(sessionId)?.(message, options));
      });
      backgroundRunRegistries.set(sessionId, registry);
    } else {
      registry.rebindAppendEvent((event) => pi.appendEntry(BACKGROUND_RUNS_ENTRY_TYPE, event));
    }
    registry.subscribe(() => composerTui?.requestRender());
    return registry;
  };
  pi.registerMessageRenderer(BACKGROUND_RUN_RESULT_TYPE, renderBackgroundRunMessage);

  pi.registerMessageRenderer(BACKGROUND_SUBAGENT_RESULT_TYPE, renderBackgroundBatchMessage);
  registerThinkingShortcuts(pi);
  registerAccountCommands(pi, accounts);
  const voice = registerVoiceInput(pi, { codexProvider: () => accounts.selectedProviderId("openai-codex") });
  registerAutoRename(pi);
  registerSaveMarkdown(pi);
  registerHandoffCommand(pi);
  registerBreakdownCommand(pi);
  registerPromptDuration(pi);
  registerProactiveCompaction(pi);
  registerWebSearch(pi);
  pi.registerTool(createPainterTool({ codexProvider: () => accounts.selectedProviderId("openai-codex") }));
  // Dictation rides the same voice pipeline: while the ask dialog owns focus,
  // its hotkey triggers a toggle and transcripts land in the focused input.
  pi.registerTool(createAskTool({
    herdrEvents: pi.events,
    startDictation: (ctx) => {
      voice.toggle(ctx).catch((error) => ctx.ui.notify(error instanceof Error ? error.message : String(error), "error"));
    },
  }));

  // The main session's read tool also rides the vision hook: when the main model
  // is text-only and reads an image, the sidecar description is appended to the
  // read result so the transcript keeps the image while the model still gets a
  // description of it.
  pi.on("tool_result", createVisionHookHandler(() => ({
    sidecar: currentConfig?.defaults.image,
    promptFile: currentConfig?.defaults.imagePromptFile,
  }), undefined, accounts.childExtension, accounts.routeModel));

  const activate = async (ctx: ExtensionContext, config: AgentsConfig, activeMode?: string): Promise<void> => {
    const sessionId = ctx.sessionManager.getSessionId();
    // Background batches and runs may settle after this session_start; route
    // their follow-ups through the live extension API for this session.
    sessionSenders.set(sessionId, (message, options) => pi.sendMessage(message, options));
    backgroundRunSenders.set(sessionId, (message, options) => pi.sendMessage(message, options));
    // Deliver follow-ups that settled during the reload gap through this API.
    for (let index = bufferedFollowUps.length - 1; index >= 0; index -= 1) {
      const followUp = bufferedFollowUps[index]!;
      if (followUp.sessionId !== sessionId) continue;
      bufferedFollowUps.splice(index, 1);
      try {
        pi.sendMessage(followUp.message, followUp.options);
      } catch {
        // Best-effort; the settled state stays visible in /ps or /agents.
      }
    }

    const previous = runtime;
    runtime = undefined;

    let next: SubagentRuntime;
    const adopted = detachedRuntimes.get(sessionId);
    if (adopted) {
      // A reload handed this runtime off with its child sessions still running.
      // Adopt it: persist events recorded during the handoff gap, re-point the
      // extension-bound hooks at this live instance, and realign with the
      // freshly loaded config (a preset may have been renamed or removed).
      detachedRuntimes.delete(sessionId);
      const buffered = detachedEventBuffer.get(sessionId) ?? [];
      detachedEventBuffer.delete(sessionId);
      adopted.rebindForReload({
        config,
        appendEvent: (event: SubagentEvent) => pi.appendEntry(SUBAGENT_ENTRY_TYPE, event),
        generateHeadings: createSubagentHeadingGenerator(
          ctx.modelRegistry,
          () => accounts.selectedProviderId("openai-codex"),
        ),
        accountExtension: accounts.childExtension,
        routeAccountModel: accounts.routeModel,
        modelRegistry: ctx.modelRegistry,
        roleOverride: (preset, role) => {
          const key = `${preset ?? "$default"}\u0000${role}`;
          const global = modelOverrideStore.get(config.path, preset, role);
          const project = projectOverrideStore.get(config.path, preset, role);
          const session = sessionOverrides.get(key);
          if (!global && !project && !session) return undefined;
          return { ...global, ...project, ...session };
        },
      });
      try {
        adopted.setActiveMode(activeMode);
      } catch {
        adopted.setActiveMode(undefined);
      }
      adopted.refreshRoles();
      // Reload resets the provider registry; rebuild the shared model runtime
      // so new child sessions resolve the freshly registered providers.
      adopted.resetModelRuntime();
      for (const event of buffered) {
        try {
          pi.appendEntry(SUBAGENT_ENTRY_TYPE, event);
        } catch {
          // Best-effort persistence; the in-memory state already includes these.
        }
      }
      next = adopted;
    } else {
      await previous?.shutdown();

      const allState = replayRuntimeState(ctx.sessionManager.getEntries());
      const activeState = replayRuntimeState(ctx.sessionManager.getBranch());
      projectOverrideStore = createAgentModelOverrideStore(undefined, projectAgentsModelOverridesPath(ctx.cwd), "$project");
      sessionOverrides = new Map();
      next = new SubagentRuntime(
        {
          rootSessionId: sessionId,
          rootSessionFile: ctx.sessionManager.getSessionFile(),
          cwd: ctx.cwd,
          config,
          activeMode,
          roleOverride: (preset, role) => {
            const key = `${preset ?? "$default"}\u0000${role}`;
            const global = modelOverrideStore.get(config.path, preset, role);
            const project = projectOverrideStore.get(config.path, preset, role);
            const session = sessionOverrides.get(key);
            if (!global && !project && !session) return undefined;
            return { ...global, ...project, ...session };
          },
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
      next.reconcileInterrupted();
    }

    runtime = next;
    sessionRuntimes.set(sessionId, next);
    installHeader(ctx, config, pi.getCommands(), next);
    if (ctx.mode === "tui") {
      const sessionId = next.options.rootSessionId;
      ctx.ui.setWidget(WIDGET_KEY, (tui, theme) => {
        const panel = new AgentsPanel(next, tui, theme, () => minimizedPanels.has(sessionId));
        panelMinimizeSetters.set(sessionId, (minimized) => {
          if (minimized) minimizedPanels.add(sessionId);
          else minimizedPanels.delete(sessionId);
          tui.requestRender();
        });
        return panel;
      });
      footer.install(ctx, next);
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
            const sessionId = owner.options.rootSessionId;
            void deliverBackgroundBatchResult(
              launch,
              (message, options) => sessionSenders.get(sessionId)?.(message, options),
              // True as long as this session's current runtime is the one that
              // owns the batch — including when a reload adopts the same object.
              () => sessionRuntimes.get(sessionId) === owner,
            );
            return launch;
          },
          cancelBackgroundTarget: (target) => {
            const owner = runtime;
            if (!owner) throw new Error("Subagent runtime is not available for this session.");
            return owner.cancelRootTarget(target);
          },
        },
      ),
    );
  };

  /** Replace the built-in bash tool with the background-capable wrapper for this session's cwd. */
  const registerBackgroundBashTool = (cwd: string): void => {
    if (!backgroundRuns) return;
    pi.registerTool(createBackgroundBashTool({ cwd, registry: backgroundRuns }));
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
    backgroundRuns = getBackgroundRuns(ctx.sessionManager.getSessionId(), ctx.sessionManager.getEntries());
    const activeMode = resolveActiveMode(config, activeModeStore.load(config.path));

    if (ctx.mode === "tui") {
      ctx.ui.addAutocompleteProvider(createEmojiAutocompleteProvider);
      ctx.ui.setEditorComponent(
        (tui, theme, keybindings) => {
          composerTui = tui;
          return new FullPasteEditor(
            tui,
            theme,
            keybindings,
            () => runtime?.activeMode,
            () => contextLabelFor(ctx.getContextUsage(), ctx.ui.theme),
            () => backgroundRunsLabel(backgroundRuns, ctx.ui.theme),
          );
        },
      );
    }
    await activate(ctx, config, activeMode);
    registerBackgroundBashTool(ctx.cwd);
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

  pi.registerShortcut("alt+m", {
    description: "Minimize or expand the agents panel",
    handler: (ctx) => {
      const sessionId = ctx.sessionManager.getSessionId();
      const set = panelMinimizeSetters.get(sessionId);
      if (!set) {
        ctx.ui.notify("The agents panel is only available in TUI mode.", "warning");
        return;
      }
      set(!minimizedPanels.has(sessionId));
      ctx.ui.notify(minimizedPanels.has(sessionId) ? "Agents panel minimized" : "Agents panel expanded", "info");
    },
  });

  pi.registerCommand("agents", {
    description: "Inspect subagent runs or configure role models",
    getArgumentCompletions: (prefix) => {
      const normalized = prefix.trim().toLowerCase();
      const options = [
        { value: "configure", label: "configure", description: "Choose models for subagent roles" },
        { value: "minimize", label: "minimize", description: "Collapse the agents panel to one summary line" },
        { value: "expand", label: "expand", description: "Restore the full agents panel" },
      ];
      const matches = options.filter((option) => option.value.startsWith(normalized));
      return matches.length ? matches : null;
    },
    handler: async (args, ctx) => {
      const active = runtime;
      if (!active) {
        ctx.ui.notify("Subagent runtime is unavailable for this session.", "warning");
        return;
      }
      const command = args.trim().toLowerCase();
      if (command === "minimize" || command === "expand") {
        setAgentsPanelMinimized(ctx, command === "minimize");
        return;
      }
      if (command === "configure") {
        if (ctx.mode !== "tui") {
          ctx.ui.notify("The agents model picker requires TUI mode.", "warning");
          return;
        }
        const configured = resolvePreset(active.options.config, active.activeMode).roles;
        const mode = active.activeMode;
        const configPath = active.options.config.path;
        const applyChange = (roleName: string, change: AgentRoleConfigureChange): void => {
          const role = configured.find((candidate) => candidate.name === roleName);
          if (!role) return;
          const key = `${mode ?? "$default"}\u0000${role.name}`;
          if (configureScope === "session") {
            const previous = sessionOverrides.get(key) ?? {};
            const next = { ...previous };
            if (change.kind === "model") next.model = change.model;
            else if (change.kind === "thinking") next.thinking = change.thinking;
            else if (change.kind === "backend") next.backend = change.backend;
            else if (change.kind === "reset-model") delete next.model;
            else if (change.kind === "reset-thinking") delete next.thinking;
            else if (change.kind === "reset-backend") delete next.backend;
            if (Object.keys(next).length) sessionOverrides.set(key, next); else sessionOverrides.delete(key);
          } else {
            const store = configureScope === "project" ? projectOverrideStore : modelOverrideStore;
            switch (change.kind) {
              case "model": store.set(configPath, mode, role.name, { model: change.model }); break;
              case "thinking": store.set(configPath, mode, role.name, { thinking: change.thinking }); break;
              case "reset-model": store.set(configPath, mode, role.name, { model: undefined }); break;
              case "reset-thinking": store.set(configPath, mode, role.name, { thinking: undefined }); break;
              case "backend":
              case "reset-backend":
                throw new Error("Backend selection is session-scoped.");
            }
          }
          active.refreshRoles();
          ctx.ui.notify(`${role.name} ${describeConfigureChange(change)}`, "info");
        };
        await showAgentModelConfigure(
          ctx,
          {
            mode,
            scope: configureScope,
            roles: active.activeRoles.map((role) => {
              const base = configured.find((candidate) => candidate.name === role.name);
              return {
                name: role.name,
                model: role.model,
                thinking: role.thinking,
                configuredModel: base?.model ?? role.model,
                configuredThinking: base?.thinking ?? role.thinking,
                backend: role.backend ?? "native",
                configuredBackend: base?.backend ?? role.backend ?? "native",
                backendOptions: role.backendOptions ?? [role.backend ?? "native"],
              };
            }),
            scopedModels: projectAgentModels(ctx.scopedModels.map((item) => item.model), ctx),
            allModels: projectAgentModels(ctx.modelRegistry.getAll(), ctx),
          },
          applyChange,
          (scope) => { configureScope = scope; },
          (scope) => {
            let saved = 0;
            for (const role of active.activeRoles) {
              if (!configured.some((candidate) => candidate.name === role.name)) continue;
              if (scope === "session") {
                sessionOverrides.set(`${mode ?? "$default"}\u0000${role.name}`, { model: role.model, thinking: role.thinking });
              } else {
                const store = scope === "project" ? projectOverrideStore : modelOverrideStore;
                store.set(configPath, mode, role.name, { model: role.model, thinking: role.thinking });
              }
              saved += 1;
            }
            active.refreshRoles();
            ctx.ui.notify(`Saved ${saved} role${saved === 1 ? "" : "s"} to ${scope} config`, "info");
          },
          () => {
            try {
              const fresh = loadAgentsConfig({ cwd: ctx.cwd });
              if (fresh.path === projectAgentsPath(ctx.cwd) && !ctx.isProjectTrusted()) {
                throw new Error("Project agents.yaml is disabled because this project is not trusted.");
              }
              currentConfig = fresh;
              active.rebindForReload({ config: fresh });
              const mode = active.activeMode;
              try {
                active.setActiveMode(mode);
              } catch {
                active.setActiveMode(undefined);
              }
              // Pick up models.json/auth edits too; in-flight children keep theirs.
              active.resetModelRuntime();
              active.refreshRoles();
              ctx.ui.notify(`Reloaded configs from ${fresh.path}`, "info");
            } catch (error) {
              notifyError(ctx, error);
            }
          },
        );
        return;
      }
      if (command) {
        ctx.ui.notify("Usage: /agents [configure|minimize|expand]", "warning");
        return;
      }
      if (ctx.mode !== "tui") {
        ctx.ui.notify("The agents dashboard requires TUI mode.", "warning");
        return;
      }
      await ctx.ui.custom<void>(
        (tui, theme, keybindings, done) => new AgentsDashboard(active, tui, theme, keybindings, done),
        {
          overlay: true,
          overlayOptions: { anchor: "top-left", width: "100%", maxHeight: "100%" },
        },
      );
    },
  });

  pi.registerCommand("ps", {
    description: "Inspect background terminal runs (x kills the selected run)",
    handler: async (_args, ctx) => {
      if (!backgroundRuns) {
        ctx.ui.notify("Background runs are not available for this session.", "warning");
        return;
      }
      if (ctx.mode !== "tui") {
        ctx.ui.notify("The background runs panel requires TUI mode.", "warning");
        return;
      }
      await ctx.ui.custom<void>(
        (tui, theme, keybindings, done) => new ProcessesPanel(backgroundRuns!, tui, theme, keybindings, done),
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
      backgroundRuns?.shutdown();
    }
    footer.dispose();
    const active = runtime;
    runtime = undefined;
    if (event.reason === "reload" && active) {
      // Reload keeps the process alive and re-invokes this extension. Hand the
      // runtime off with its child sessions still running and buffer recorded
      // events and follow-ups until the next session_start adopts it.
      const sessionId = active.options.rootSessionId;
      const buffer: SubagentEvent[] = [];
      detachedEventBuffer.set(sessionId, buffer);
      active.rebindForReload({ appendEvent: (event: SubagentEvent) => buffer.push(event) });
      // A batch or run settling during the reload gap must still report: hold
      // its follow-up until the adopting instance drains it in activate().
      sessionSenders.set(sessionId, (message, options) => {
        bufferedFollowUps.push({ sessionId, message, options });
      });
      backgroundRunSenders.set(sessionId, (message, options) => {
        bufferedFollowUps.push({ sessionId, message, options });
      });
      detachedRuntimes.set(sessionId, active);
      return;
    }
    const sessionId = ctx.sessionManager.getSessionId();
    sessionRuntimes.delete(sessionId);
    sessionSenders.delete(sessionId);
    backgroundRunSenders.delete(sessionId);
    panelMinimizeSetters.delete(sessionId);
    minimizedPanels.delete(sessionId);
    for (let index = bufferedFollowUps.length - 1; index >= 0; index -= 1) {
      if (bufferedFollowUps[index]!.sessionId === sessionId) bufferedFollowUps.splice(index, 1);
    }
    await active?.shutdown();
  });
}

function notifyError(ctx: ExtensionContext, error: unknown): void {
  if (!ctx.hasUI) return;
  const message = error instanceof Error ? error.message : String(error);
  ctx.ui.notify(`Subagent extension unavailable: ${message}`, "error");
}

/** Composer border label for active background runs; empty when none are running. */
function backgroundRunsLabel(registry: BackgroundRunRegistry | undefined, theme: Theme): string {
  if (!registry) return "";
  const count = registry.activeCount();
  return count > 0 ? theme.fg("warning", ` ⏳${count}`) : "";
}

function describeConfigureChange(change: AgentRoleConfigureChange): string {
  switch (change.kind) {
    case "model": return `model: ${change.model}`;
    case "thinking": return `thinking: ${change.thinking}`;
    case "reset-model": return "model reset to configured";
    case "reset-thinking": return "thinking reset to configured";
    case "backend": return `backend: ${change.backend}`;
    case "reset-backend": return "backend reset to configured";
  }
}

function codexWeeklyRemaining(accounts: AccountController): number | undefined {
  const selected = accounts.accounts("openai-codex").find((account) => account.selected);
  const weekly = selected?.limits.find((window) =>
    window.windowSeconds === 604_800 || window.name.toLowerCase().includes("week"),
  );
  return weekly?.usedPercent === undefined ? undefined : Math.max(0, Math.min(100, 100 - weekly.usedPercent));
}

/** Canonicalize named-account aliases and remove duplicate provider/model rows. */
function projectAgentModels(
  models: ReadonlyArray<{ provider: string; id: string; name: string }>,
  ctx: ExtensionContext,
): AgentModelChoice[] {
  const available = new Set(
    ctx.modelRegistry.getAvailable().map((model) => `${canonicalProviderId(model.provider)}/${model.id}`),
  );
  const choices = new Map<string, AgentModelChoice>();
  for (const model of models) {
    const provider = canonicalProviderId(model.provider);
    const key = `${provider}/${model.id}`;
    if (choices.has(key)) continue;
    choices.set(key, {
      provider,
      providerLabel: ctx.modelRegistry.getProviderDisplayName(provider),
      id: model.id,
      name: model.name || model.id,
      ...(available.has(key) ? {} : { available: false }),
    });
  }
  return [...choices.values()];
}
