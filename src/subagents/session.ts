import { join } from "node:path";
import { createAgentSession, DefaultResourceLoader, getAgentDir, ModelRuntime, SessionManager, SettingsManager, truncateHead, type ToolDefinition, type SessionEntry } from "@earendil-works/pi-coding-agent";
import type { Config } from "./config.ts";
import { TITLE_PROMPT, parseTitle, fallbackTitle } from "./title.ts";
import { createWebTool } from "../web.ts";
import { createSubagentTool } from "./tool.ts";
import { addUsage, canDelegate, zeroUsage, type AgentRecord, type Child, type Report, type Subagents } from "./runtime.ts";

export function reportText(report: Report) {
  return `Subagent ${report.agent} (${report.handle}) ${report.status}.\n${report.text}\nSession: ${report.sessionFile ?? "not saved"}`;
}

export async function createChildSession(options: {
  cwd: string; config: () => Config; runtime: Subagents; record: AgentRecord;
  signal: AbortSignal; progress: (text: string) => void; modelRuntime?: ModelRuntime;
}): Promise<Child> {
  const { record, signal, runtime } = options;
  const modelRuntime = options.modelRuntime ?? await ModelRuntime.create({ signal });
  const slash = record.model.indexOf("/");
  const model = modelRuntime.getModel(record.model.slice(0, slash), record.model.slice(slash + 1));
  if (!model || !modelRuntime.hasConfiguredAuth(model.provider)) throw new Error(`Model unavailable or unauthenticated: ${record.model}`);
  // Explicit resource isolation prevents parent SYSTEM/APPEND_SYSTEM, skills and
  // global extensions from leaking into children or restoring delegation tools.
  const settings = SettingsManager.inMemory({ cacheWarming: "off" });
  const loader = new DefaultResourceLoader({
    cwd: options.cwd, agentDir: getAgentDir(), settingsManager: settings,
    noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
    systemPromptOverride: () => undefined,
    appendSystemPromptOverride: () => record.prompt ? [record.prompt] : [],
  });
  await loader.reload();
  signal.throwIfAborted();
  const manager = record.sessionFile
    ? SessionManager.open(record.sessionFile)
    : SessionManager.create(options.cwd, join(getAgentDir(), "sessions", "subagents", encodeURIComponent(runtime.root)));
  record.sessionFile = manager.getSessionFile();
  let session: Awaited<ReturnType<typeof createAgentSession>>["session"];
  const customTools: ToolDefinition[] = [createWebTool()];
  if (canDelegate(record)) customTools.push(createSubagentTool({
    runtime: () => runtime, config: options.config, owner: record.handle, parent: record,
    activeTools: () => session.getActiveToolNames(),
  }));
  ({ session } = await createAgentSession({
    cwd: options.cwd, modelRuntime, model, thinkingLevel: record.thinking,
    settingsManager: settings, resourceLoader: loader, sessionManager: manager,
    tools: [...record.tools, ...(canDelegate(record) ? ["subagent"] : [])],
    customTools,
  }));
  await session.bindExtensions({});
  const unsubscribe = session.subscribe(event => {
    if (event.type === "tool_execution_start") options.progress(event.toolName);
    if (event.type === "message_start" && event.message.role === "assistant") options.progress("thinking");
    if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") options.progress("writing response");
  });
  const abort = () => { void session.abort(); };
  signal.addEventListener("abort", abort, { once: true });
  let titleJob: Promise<void> = Promise.resolve();
  return {
    async prompt(task) {
      titleJob = title();
      await session.prompt(task, { expandPromptTemplates: false });
    },
    async waitForIdle() { await session.waitForIdle(); await titleJob; },
    async abort() { await session.abort(); await titleJob; },
    dispose() { signal.removeEventListener("abort", abort); unsubscribe(); session.dispose(); },
    output() {
      const text = session.getLastAssistantText() ?? "";
      const clipped = truncateHead(text, { maxBytes: 12000, maxLines: 150 });
      return clipped.content + (clipped.truncated ? `\n[Response clipped; full history: ${record.sessionFile}]` : "");
    },
    error() {
      const message = [...session.messages].reverse().find(message => message.role === "assistant");
      return message?.role === "assistant" && (message.stopReason === "error" || message.stopReason === "aborted")
        ? message.errorMessage || `Agent ${message.stopReason}` : undefined;
    },
    usage: () => entryUsage(manager.getEntries()),
    async deliver(report) {
      // Do not await a fresh model turn here: delivery must not hold the completed
      // Atlas handle busy while its parent considers a follow-up.
      void session.sendCustomMessage({ customType: "subagent-completion", content: reportText(report), display: true, details: report }, { triggerTurn: true, deliverAs: "followUp" }).catch(error => {
        record.activity = `Completion delivery error: ${String(error)}`; runtime.changed();
      });
    },
  };

  async function title() {
    const previous = parseTitle(record.title ?? "") ?? parseTitle(manager.getSessionName() ?? "");
    if (previous) { record.title = previous; runtime.changed(); return; }
    const settings = options.config().titling;
    record.title = fallbackTitle(record.task);
    runtime.changed();
    if (!settings) return;
    const controller = new AbortController();
    const stop = () => controller.abort();
    signal.addEventListener("abort", stop, { once: true });
    const timer = setTimeout(stop, 15000);
    if (signal.aborted) stop();
    try {
      const slash = settings.model.indexOf("/");
      const model = modelRuntime.getModel(settings.model.slice(0, slash), settings.model.slice(slash + 1));
      if (!model) throw new Error(`Unknown titling model: ${settings.model}`);
      const response = await modelRuntime.completeSimple(model, {
        systemPrompt: TITLE_PROMPT,
        messages: [{ role: "user", content: [{ type: "text", text: JSON.stringify({ task: record.task.slice(0, 8000) }) }], timestamp: Date.now() }],
      }, { reasoning: settings.thinking === "off" ? undefined : settings.thinking, maxTokens: 128, signal: controller.signal });
      manager.appendUsage("subagent-title", model.provider, model.id, response.usage);
      if (response.stopReason === "error" || response.stopReason === "aborted") throw new Error(response.errorMessage || response.stopReason);
      const text = response.content.filter(block => block.type === "text").map(block => block.text).join("").trim();
      const generated = parseTitle(text);
      if (!generated) throw new Error("Titling returned an answer or invalid label; using a short task label.");
      record.title = generated;
      record.titleError = undefined;
    } catch (error) {
      record.titleError = String(error); // Task execution does not fail because a cosmetic title failed.
    } finally {
      clearTimeout(timer); signal.removeEventListener("abort", stop);
      try { manager.appendSessionInfo(record.title!); }
      catch (error) { record.titleError = String(error); }
      runtime.save();
    }
  }
}

export function entryUsage(entries: readonly SessionEntry[]) {
  return entries.reduce((total, entry) => {
    const usage = entry.type === "message"
      ? (entry.message.role === "assistant" || entry.message.role === "toolResult" ? entry.message.usage : undefined)
      : "usage" in entry ? entry.usage : undefined;
    return usage ? addUsage(total, usage) : total;
  }, zeroUsage());
}
