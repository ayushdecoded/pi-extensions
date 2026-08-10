import { complete } from "@earendil-works/pi-ai/compat";
import type { ExtensionAPI, ExtensionContext, SessionEntry } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";

const MODEL_PROVIDER = "openai-codex";
const MODEL_ID = "gpt-5.3-codex-spark";
const WIDGET_KEY = "pi-auto-rename";
const COMMAND_WIDGET_KEY = "pi-auto-rename-command";
const WIDGET_DURATION_MS = 45_000;
const COMMAND_TIMEOUT_MS = 30_000;

type ConversationMessage = { role: "User" | "Assistant" | "Summary"; text: string };
type TitleGenerator = (transcript: string, ctx: ExtensionContext, signal: AbortSignal, instruction?: string) => Promise<string | undefined>;
const MAX_CONTEXT_PERCENT = 80;

/** Registers one ephemeral title generation attempt on a new chat's first prompt. */
export function registerAutoRename(pi: ExtensionAPI): void {
  const controller = new AutoRenameController(pi, generateTitle);
  const commandAbortControllers = new Set<AbortController>();
  let commandWidgetTimer: ReturnType<typeof setTimeout> | undefined;
  const commandFeedback = (
    ctx: ExtensionContext,
    message: string,
    tone: "accent" | "success" | "warning" | "error",
    level: "info" | "warning" | "error",
    durationMs = WIDGET_DURATION_MS,
  ): void => {
    if (ctx.mode !== "tui") {
      notify(ctx, message, level);
      return;
    }
    if (commandWidgetTimer) clearTimeout(commandWidgetTimer);
    commandWidgetTimer = undefined;
    ctx.ui.setWidget(COMMAND_WIDGET_KEY, (_tui, theme) => new Text(theme.fg(tone, message), 0, 0));
    if (durationMs > 0) {
      commandWidgetTimer = setTimeout(() => {
        commandWidgetTimer = undefined;
        ctx.ui.setWidget(COMMAND_WIDGET_KEY, undefined);
      }, durationMs);
    }
  };
  pi.on("session_start", (event, ctx) => controller.startSession(event.reason, ctx));
  pi.on("before_agent_start", (event, ctx) => { void controller.renameFromFirstPrompt(event.prompt, ctx); });
  pi.on("session_info_changed", (event) => controller.observeSessionName(event.name));
  pi.on("session_shutdown", (_event, ctx) => {
    for (const commandAbortController of commandAbortControllers) commandAbortController.abort();
    commandAbortControllers.clear();
    if (commandWidgetTimer) clearTimeout(commandWidgetTimer);
    commandWidgetTimer = undefined;
    ctx.ui.setWidget(COMMAND_WIDGET_KEY, undefined);
    controller.stopSession(ctx);
  });

  pi.registerCommand("auto-rename", {
    description: "Rename this session from its compaction-aware conversation context",
    handler: async (args, ctx) => {
      const usage = ctx.getContextUsage();
      if (!usage || usage.percent === null) {
        commandFeedback(ctx, "🧭 Rename needs one settled reply after compaction before it can read the context meter.", "warning", "warning");
        return;
      }
      if (usage.percent >= MAX_CONTEXT_PERCENT) {
        commandFeedback(ctx, `🧭 Too deep in the weeds: parent context is ${formatPercent(usage.percent)}. Rename is limited to under 80%.`, "warning", "warning");
        return;
      }

      const model = ctx.modelRegistry.find(MODEL_PROVIDER, MODEL_ID);
      if (!model) {
        commandFeedback(ctx, "⚡ Spark is unavailable to make a title right now.", "warning", "warning");
        return;
      }

      const transcript = formatConversation(cleanTitleContext(entriesSinceLastCompaction(ctx.sessionManager.getBranch())));
      if (!transcript) {
        commandFeedback(ctx, "📖 There is no conversation story for Spark to skim yet.", "warning", "warning");
        return;
      }
      const instruction = args.trim() || undefined;
      const titlePayloadPercent = estimateTokens(titleRequestText(transcript, instruction)) / model.contextWindow * 100;
      if (titlePayloadPercent >= MAX_CONTEXT_PERCENT) {
        commandFeedback(ctx, `📦 The distilled story is still too big for Spark (${formatPercent(titlePayloadPercent)}).`, "warning", "warning");
        return;
      }

      commandFeedback(ctx, "🪄 Spark is skimming the compacted story…", "accent", "info", 0);
      const abortController = new AbortController();
      commandAbortControllers.add(abortController);
      let timedOut = false;
      const timeout = setTimeout(() => {
        timedOut = true;
        abortController.abort();
      }, COMMAND_TIMEOUT_MS);
      try {
        const title = normalizeTitle(await generateTitle(transcript, ctx, abortController.signal, instruction));
        if (!title) {
          commandFeedback(ctx, "🪄 Spark came back titleless. Try /auto-rename with a focus hint.", "warning", "warning");
          return;
        }
        pi.setSessionName(title);
        commandFeedback(ctx, `🎉 Session renamed: ${title}`, "success", "info");
      } catch {
        commandFeedback(ctx, timedOut ? "📮 Spark's title card got lost in the mail after 30 seconds." : "💥 Spark hit a snag while naming this session.", "error", "error");
      } finally {
        clearTimeout(timeout);
        commandAbortControllers.delete(abortController);
      }
    },
  });
}

export class AutoRenameController {
  private enabled = false;
  private requested = false;
  private manualName = false;
  private applyingName = false;
  private abortController?: AbortController;
  private widgetTimer?: ReturnType<typeof setTimeout>;

  constructor(
    private readonly pi: Pick<ExtensionAPI, "getSessionName" | "setSessionName">,
    private readonly titleGenerator: TitleGenerator,
    private readonly widgetDurationMs = WIDGET_DURATION_MS,
  ) {}

  startSession(reason: "startup" | "reload" | "new" | "resume" | "fork", ctx: ExtensionContext): void {
    this.stopSession(ctx);
    // A blank startup is Pi's initial new chat. Pi records model/thinking changes
    // before extensions start, so only conversation messages determine blankness.
    // Resume/fork and non-empty startup sessions stay excluded to avoid retitling history.
    this.enabled = (reason === "new" || (reason === "startup" && cleanConversation(ctx.sessionManager.getBranch()).length === 0)) && !this.pi.getSessionName();
    this.manualName = Boolean(this.pi.getSessionName());
  }

  async renameFromFirstPrompt(prompt: string, ctx: ExtensionContext): Promise<void> {
    if (!this.enabled || this.requested || this.manualName || this.pi.getSessionName()) return;
    const text = prompt.trim();
    if (!text) return;
    this.requested = true;

    const transcript = formatConversation([{ role: "User", text }]);
    const controller = new AbortController();
    this.abortController = controller;
    try {
      const title = normalizeTitle(await this.titleGenerator(transcript, ctx, controller.signal));
      if (!title || controller.signal.aborted || this.manualName || this.pi.getSessionName()) return;

      this.applyingName = true;
      try {
        this.pi.setSessionName(title);
      } finally {
        this.applyingName = false;
      }
      this.showWidget(title, ctx);
    } catch {
      // Naming is best-effort and must never disturb the primary conversation.
    } finally {
      if (this.abortController === controller) this.abortController = undefined;
    }
  }

  observeSessionName(name: string | undefined): void {
    if (!this.applyingName && name) {
      this.manualName = true;
      this.abortController?.abort();
    }
  }

  stopSession(ctx: ExtensionContext): void {
    this.abortController?.abort();
    this.abortController = undefined;
    if (this.widgetTimer) clearTimeout(this.widgetTimer);
    this.widgetTimer = undefined;
    ctx.ui.setWidget(WIDGET_KEY, undefined);
    this.enabled = false;
    this.requested = false;
    this.manualName = false;
    this.applyingName = false;
  }

  private showWidget(title: string, ctx: ExtensionContext): void {
    if (ctx.mode !== "tui") return;
    ctx.ui.setWidget(WIDGET_KEY, [`✦ Renamed: ${title}`]);
    this.widgetTimer = setTimeout(() => {
      this.widgetTimer = undefined;
      ctx.ui.setWidget(WIDGET_KEY, undefined);
    }, this.widgetDurationMs);
  }
}

export function cleanConversation(entries: readonly SessionEntry[]): ConversationMessage[] {
  const messages: ConversationMessage[] = [];
  for (const entry of entries) {
    if (entry.type !== "message") continue;
    const message = entry.message;
    if (message.role === "user") {
      messages.push({ role: "User", text: contentText(message.content) });
    } else if (message.role === "assistant" && message.stopReason === "stop") {
      const text = contentText(message.content);
      if (text) messages.push({ role: "Assistant", text });
    }
  }
  return messages;
}

/** Keeps the latest compaction summary and everything recorded after it. */
export function entriesSinceLastCompaction(entries: readonly SessionEntry[]): readonly SessionEntry[] {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    if (entries[index]?.type === "compaction") return entries.slice(index);
  }
  return entries;
}

/** Builds the filtered conversation used for explicit, on-demand renaming. */
export function cleanTitleContext(entries: readonly SessionEntry[]): ConversationMessage[] {
  const messages: ConversationMessage[] = [];
  for (const entry of entries) {
    if (entry.type === "compaction" && entry.summary.trim()) {
      messages.push({ role: "Summary", text: entry.summary.trim() });
    } else if (entry.type === "message") {
      const message = entry.message;
      if (message.role === "user") {
        messages.push({ role: "User", text: contentText(message.content) });
      } else if (message.role === "assistant" && message.stopReason === "stop") {
        const text = contentText(message.content);
        if (text) messages.push({ role: "Assistant", text });
      }
    }
  }
  return messages;
}

export function formatConversation(messages: readonly ConversationMessage[]): string {
  return messages.map((message) => `${message.role}: ${message.text}`).join("\n\n");
}

export function normalizeTitle(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const title = value
    .replace(/[`*_#]/g, "")
    .replace(/[\r\n]+/g, " ")
    .replace(/^["'“”]+|["'“”]+$/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[.!?]+$/, "")
    .trim();
  const words = title.split(" ").filter(Boolean);
  return words.length >= 3 ? words.slice(0, 9).join(" ") : undefined;
}

async function generateTitle(transcript: string, ctx: ExtensionContext, signal: AbortSignal, instruction?: string): Promise<string | undefined> {
  const model = ctx.modelRegistry.find(MODEL_PROVIDER, MODEL_ID);
  if (!model) return undefined;
  const auth = await awaitWithAbort(ctx.modelRegistry.getApiKeyAndHeaders(model), signal);
  if (!auth.ok || !auth.apiKey || signal.aborted) return undefined;

  const response = await complete(
    model,
    {
      messages: [{
        role: "user",
        content: [{
          type: "text",
          text: titleRequestText(transcript, instruction),
        }],
        timestamp: Date.now(),
      }],
    },
    { apiKey: auth.apiKey, headers: auth.headers, env: auth.env, signal },
  );
  return response.content
    .filter((part): part is { type: "text"; text: string } => part.type === "text")
    .map((part) => part.text)
    .join("\n");
}

function awaitWithAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(new DOMException("Aborted", "AbortError"));
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(new DOMException("Aborted", "AbortError"));
    signal.addEventListener("abort", abort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", abort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", abort);
        reject(error);
      },
    );
  });
}

function titleRequestText(transcript: string, instruction?: string): string {
  return `Create a concise session title for this conversation. Return exactly one plain-text title of 6 to 9 words. Return nothing except the title: no quotes, markdown, labels, or ending punctuation.${instruction ? `\n\nTitle instruction: ${instruction}` : ""}\n\n<conversation>\n${transcript}\n</conversation>`;
}

function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

function formatPercent(value: number): string {
  return `${Math.round(value)}%`;
}

function notify(ctx: ExtensionContext, message: string, level: "info" | "warning" | "error"): void {
  if (ctx.hasUI) ctx.ui.notify(message, level);
}

function contentText(content: unknown): string {
  if (typeof content === "string") return content.trim();
  if (!Array.isArray(content)) return "";
  return content
    .filter((part): part is { type: "text"; text: string } =>
      typeof part === "object" && part !== null && (part as { type?: unknown }).type === "text" && typeof (part as { text?: unknown }).text === "string",
    )
    .map((part) => part.text)
    .join("\n")
    .trim();
}
