import { type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { bundledConfig, loadConfig, readConfig, type Config } from "./config.ts";
import { STATE_TYPE, Subagents, type Snapshot, type Report } from "./runtime.ts";
import { displayTitle } from "./title.ts";
import { createChildSession, reportText } from "./session.ts";
import { createSubagentTool } from "./tool.ts";
import { installWidget, renderCompletion } from "./ui.ts";

// /reload recreates extension closures, not the process. Retain only the owned
// service; detach all parent APIs during the gap and rebind them on session_start.
// No monkeypatches, global timers, subprocesses, or serialized SDK objects.
type Live = { runtime: Subagents; config: Config; cwd: string };
const key = Symbol.for("pi-extensions/subagents/v1");
const globals = globalThis as typeof globalThis & { [key]?: Map<string, Live> };
const live = globals[key] ??= new Map<string, Live>();

export default async function subagentsExtension(pi: ExtensionAPI) {
  // Register a renderable tool during factory load, before session_start. Pi rebuilds chat
  // ToolExecutionComponents on /reload before session_start, so a tool registered only in
  // session_start would leave those components without renderers and dump raw JSON. The
  // bootstrap tool reads config/runtime/owner lazily; start() replaces it with the
  // session-selected config schema.
  const bundled = await readConfig(bundledConfig);
  let current: Live | undefined;
  const requireCurrent = () => {
    if (!current) throw new Error("Subagents are not ready; check agents.yaml and run /reload.");
    return current;
  };
  pi.registerTool(createSubagentTool({
    runtime: () => requireCurrent().runtime,
    config: () => current?.config ?? bundled,
    get owner() { return requireCurrent().runtime.root; },
    activeTools: () => pi.getActiveTools(),
  }));
  const register = () => {
    const entry = requireCurrent();
    pi.registerTool(createSubagentTool({
      runtime: () => entry.runtime, config: () => entry.config,
      owner: entry.runtime.root, activeTools: () => pi.getActiveTools(),
    }));
  };
  async function start(ctx: ExtensionContext) {
    const root = ctx.sessionManager.getSessionId();
    let entry = live.get(root);
    try {
      const config = await loadConfig(ctx.cwd, ctx.isProjectTrusted());
      if (entry) entry.config = config;
      else {
        const snapshotEntry = [...ctx.sessionManager.getBranch()].reverse().find(item => item.type === "custom" && item.customType === STATE_TYPE);
        const snapshot = snapshotEntry?.type === "custom" ? snapshotEntry.data as Snapshot : undefined;
        if (snapshot && (snapshot.version !== 1 || !Array.isArray(snapshot.records) || !Array.isArray(snapshot.pending))) throw new Error("Invalid saved subagent state.");
        const runtime = new Subagents(root, (record, signal, progress) => createChildSession({
          cwd: ctx.cwd, config: () => entry!.config, runtime: entry!.runtime, record, signal, progress,
        }), snapshot);
        entry = { runtime, config, cwd: ctx.cwd };
        live.set(root, entry);
      }
    } catch (error) {
      ctx.ui.notify(`Subagents config: ${String(error)}${entry ? " (keeping previous valid config)" : ""}`, "error");
      if (!entry) return;
    }
    current = entry;
    // New invocations use new module code after reload; existing sessions keep
    // their own resource loader, prompt and execution settings.
    const bound = entry;
    const cwd = ctx.cwd;
    entry.runtime.createChild = (record, signal, progress) => createChildSession({ cwd, config: () => bound.config, runtime: bound.runtime, record, signal, progress });
    entry.runtime.widgetCollapsed ??= false;
    entry.runtime.attach({
      save: snapshot => pi.appendEntry(STATE_TYPE, { ...snapshot, widgetCollapsed: bound.runtime.widgetCollapsed }),
      deliver: report => {
        // A runtime retained from an earlier reload may still emit reports without a title.
        const record = bound.runtime.records.get(report.handle);
        const details = { ...report, title: report.title ?? (record ? displayTitle(record) : undefined) };
        pi.sendMessage({ customType: "subagent-completion", content: reportText(report), display: true, details }, { triggerTurn: true, deliverAs: "followUp" });
      },
    });
    register();
    installWidget(ctx, entry.runtime);
  }
  pi.on("session_start", (_event, ctx) => start(ctx));
  pi.on("session_shutdown", async (event, ctx) => {
    if (!current) return;
    ctx.ui.setWidget("subagents", undefined);
    if (event.reason === "reload") {
      current.runtime.save();
      current.runtime.detach();
    } else {
      await current.runtime.close();
      live.delete(current.runtime.root);
    }
    current = undefined;
  });
  pi.on("session_tree", async (_event, ctx) => {
    // Work from an abandoned branch must not wake a different conversation.
    if (current) {
      current.runtime.detach();
      await current.runtime.close();
      live.delete(current.runtime.root);
      current = undefined;
    }
    await start(ctx);
  });
  pi.registerMessageRenderer<Report>("subagent-completion", (message, options, theme) => {
    const record = message.details && current?.runtime.records.get(message.details.handle);
    const details = message.details && { ...message.details, title: message.details.title ?? (record ? displayTitle(record) : undefined) };
    return renderCompletion({ ...message, details }, options, theme);
  });
  pi.registerShortcut("alt+m", {
    description: "Collapse or expand the agents widget",
    handler: ctx => {
      if (ctx.mode !== "tui" || !current) return;
      current.runtime.widgetCollapsed = !current.runtime.widgetCollapsed;
      current.runtime.save();
    },
  });
}
