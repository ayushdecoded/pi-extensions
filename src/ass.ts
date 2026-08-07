import { spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { complete } from "@earendil-works/pi-ai/compat";
import type { ExtensionAPI, ExtensionContext, SessionEntry } from "@earendil-works/pi-coding-agent";
import type { AssConfig } from "./config/agents.ts";
import { cleanTitleContext, formatConversation } from "./auto-rename.ts";
import { sessionEntriesUsage } from "./runtime/state.ts";

const MODEL_PROVIDER = "openai-codex";
const MODEL_ID = "gpt-5.3-codex-spark";
const WIDGET_KEY = "pi-ass";
const WIDGET_DURATION_MS = 15_000;
const REQUEST_TIMEOUT_MS = 30_000;
/** Runaway guard: spark is free, but a bug must not make ass talk forever. */
const MAX_FIRES_PER_SESSION = 60;
const DING_SAMPLE_RATE = 48_000;
const DING_FREQUENCY = 1046.5;
const DING_SECONDS = 0.35;
const DING_VOLUME = 0.5;

/** A short decaying sine "ding" (fundamental + octave shimmer) rendered as a mono 16-bit WAV. */
export function renderDingWav(
  frequency = DING_FREQUENCY,
  seconds = DING_SECONDS,
  sampleRate = DING_SAMPLE_RATE,
  volume = DING_VOLUME,
): Buffer {
  const count = Math.floor(seconds * sampleRate);
  const dataSize = count * 2;
  const buffer = Buffer.alloc(44 + dataSize);
  buffer.write("RIFF", 0);
  buffer.writeUInt32LE(36 + dataSize, 4);
  buffer.write("WAVE", 8);
  buffer.write("fmt ", 12);
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(1, 22);
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(sampleRate * 2, 28);
  buffer.writeUInt16LE(2, 32);
  buffer.writeUInt16LE(16, 34);
  buffer.write("data", 36);
  buffer.writeUInt32LE(dataSize, 40);
  for (let index = 0; index < count; index++) {
    const time = index / sampleRate;
    const envelope = Math.exp(-time * 5);
    const fundamental = Math.sin(2 * Math.PI * frequency * time);
    const harmonic = 0.4 * Math.sin(2 * Math.PI * frequency * 2 * time);
    const value = Math.max(-1, Math.min(1, (fundamental + harmonic) * envelope * volume));
    buffer.writeInt16LE(Math.round(value * 32767), 44 + index * 2);
  }
  return buffer;
}

/** The compaction-aware conversation: summary + user/assistant text, never tool calls. */
export function assStory(entries: readonly SessionEntry[]): string {
  return formatConversation(cleanTitleContext(entries));
}

export type AssStats = {
  cost: number;
  tokensIn: number;
  tokensOut: number;
  elapsedMin: number;
  contextPercent: number | null;
};

/** The full spark prompt: persona + conversation + one stats line. A prompt snippet, nothing more. */
export function buildAssPrompt(options: { persona: string; story: string; stats: AssStats }): string {
  const { persona, story, stats } = options;
  return [
    `You are ass (a successful shitposter). ${persona}`,
    "",
    "Make one joke. ONE short line. Never recap or narrate the session — no 'you did X', no lists, no progress reports. Pure comedy only. Include at least one emoji. If nothing is funny, return nothing.",
    "",
    "<conversation>",
    story,
    "</conversation>",
    "",
    `<stats> session: ${Math.round(stats.elapsedMin)} min · $${stats.cost.toFixed(2)} · ${stats.tokensIn.toLocaleString()} in / ${stats.tokensOut.toLocaleString()} out · context ${stats.contextPercent === null ? "?" : `${Math.round(stats.contextPercent)}%`} </stats>`,
  ].join("\n");
}

export type AssLineGenerator = (
  prompt: string,
  ctx: ExtensionContext,
  signal: AbortSignal,
) => Promise<string | undefined>;

type AssControllerOptions = {
  generateLine?: AssLineGenerator;
  widgetDurationMs?: number;
  timeoutMs?: number;
  /** Ding audio player; defaults to paplay. Injected for tests. */
  playDing?: () => void;
};

export class AssController {
  private ctx: ExtensionContext | undefined;
  private config: AssConfig = { enabled: false, persona: "", cadence: { userMessages: 3, minutes: 5 } };
  private enabled = false;
  private userMessages = 0;
  private userMessagesAtLastFire = 0;
  private fires = 0;
  private firing = false;
  private startedAt = 0;
  private abortController: AbortController | undefined;
  private widgetTimer: ReturnType<typeof setTimeout> | undefined;
  private idleTimer: ReturnType<typeof setTimeout> | undefined;
  private readonly generateLine: AssLineGenerator;
  private readonly widgetDurationMs: number;
  private readonly timeoutMs: number;
  private readonly playDing: () => void;

  constructor(options: AssControllerOptions = {}) {
    this.generateLine = options.generateLine ?? defaultGenerateLine;
    this.widgetDurationMs = options.widgetDurationMs ?? WIDGET_DURATION_MS;
    this.timeoutMs = options.timeoutMs ?? REQUEST_TIMEOUT_MS;
    this.playDing = options.playDing ?? defaultPlayDing;
  }

  start(ctx: ExtensionContext, config: AssConfig): void {
    this.stop(ctx);
    this.ctx = ctx;
    this.config = config;
    this.enabled = config.enabled && ctx.mode === "tui";
    this.startedAt = Date.now();
    this.fires = 0;
    this.userMessages = 0;
    this.userMessagesAtLastFire = 0;
    if (this.enabled) this.scheduleIdle();
  }

  stop(ctx?: ExtensionContext): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = undefined;
    if (this.widgetTimer) clearTimeout(this.widgetTimer);
    this.widgetTimer = undefined;
    this.abortController?.abort();
    this.abortController = undefined;
    this.firing = false;
    if (ctx && ctx.mode === "tui") ctx.ui.setWidget(WIDGET_KEY, undefined);
    this.ctx = undefined;
    this.enabled = false;
  }

  observeMessage(event: { message: { role: string } }): void {
    if (this.enabled && event.message.role === "user") this.userMessages++;
  }

  compacted(): void {
    if (!this.enabled) return;
    // The branch rewrote history; restart the message cadence from the current count.
    this.userMessagesAtLastFire = this.userMessages;
  }

  async settle(_event: unknown, ctx: ExtensionContext): Promise<void> {
    if (!this.enabled || ctx !== this.ctx) return;
    if (this.userMessages - this.userMessagesAtLastFire >= this.config.cadence.userMessages) {
      await this.fire();
    }
  }

  /** Bypasses the cadence gate for an explicit user request; still needs a story and a model. */
  async force(ctx: ExtensionContext): Promise<void> {
    if (!ctx || ctx.mode !== "tui") return;
    this.ctx = ctx;
    await this.fire(true);
  }

  setEnabled(enabled: boolean, ctx?: ExtensionContext): void {
    this.enabled = enabled;
    if (ctx?.hasUI) ctx.ui.notify(`ass (a successful shitposter): ${enabled ? "on" : "off"}`, "info");
    if (this.enabled) {
      this.scheduleIdle();
    } else {
      if (this.idleTimer) clearTimeout(this.idleTimer);
      this.idleTimer = undefined;
      this.abortController?.abort();
      this.abortController = undefined;
      this.firing = false;
    }
  }

  isEnabled(): boolean {
    return this.enabled;
  }

  private scheduleIdle(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => {
      this.idleTimer = undefined;
      void this.fire();
    }, this.config.cadence.minutes * 60_000);
  }

  private async fire(forced = false): Promise<void> {
    const ctx = this.ctx;
    if (!ctx || this.firing) return;
    if (!forced && !this.enabled) return;
    if (!forced && this.fires >= MAX_FIRES_PER_SESSION) return;

    const model = ctx.modelRegistry.find(MODEL_PROVIDER, MODEL_ID);
    if (!model) return;
    const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
    if (!auth.ok || !auth.apiKey) return;

    const entries = ctx.sessionManager.buildContextEntries();
    const story = assStory(entries);
    if (!story) return;

    const usage = sessionEntriesUsage(entries);
    const context = ctx.getContextUsage();
    const prompt = buildAssPrompt({
      persona: this.config.persona,
      story,
      stats: {
        cost: usage.cost,
        tokensIn: usage.input,
        tokensOut: usage.output,
        elapsedMin: (Date.now() - this.startedAt) / 60_000,
        contextPercent: context?.percent ?? null,
      },
    });

    this.firing = true;
    const controller = new AbortController();
    this.abortController = controller;
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const line = (await this.generateLine(prompt, ctx, controller.signal))?.trim();
      if (line && !controller.signal.aborted) {
        this.showWidget(line);
        this.playDing();
      }
    } catch {
      // The joke layer must never disturb the session. Silence.
    } finally {
      clearTimeout(timeout);
      if (this.abortController === controller) this.abortController = undefined;
      this.firing = false;
      // Every completed attempt settles the cadence, whether it produced a line or not.
      this.userMessagesAtLastFire = this.userMessages;
      this.fires++;
      this.scheduleIdle();
    }
  }

  private showWidget(line: string): void {
    const ctx = this.ctx;
    if (!ctx || ctx.mode !== "tui") return;
    // Raw model text, rendered by Pi's own widget path. No formatting machinery here.
    ctx.ui.setWidget(WIDGET_KEY, [line]);
    if (this.widgetTimer) clearTimeout(this.widgetTimer);
    this.widgetTimer = setTimeout(() => {
      this.widgetTimer = undefined;
      ctx.ui.setWidget(WIDGET_KEY, undefined);
    }, this.widgetDurationMs);
  }
}

async function defaultGenerateLine(prompt: string, ctx: ExtensionContext, signal: AbortSignal): Promise<string | undefined> {
  const model = ctx.modelRegistry.find(MODEL_PROVIDER, MODEL_ID);
  if (!model) return undefined;
  const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
  if (!auth.ok || !auth.apiKey || signal.aborted) return undefined;
  const response = await complete(
    model,
    {
      messages: [{ role: "user", content: [{ type: "text", text: prompt }], timestamp: Date.now() }],
    },
    { apiKey: auth.apiKey, headers: auth.headers, env: auth.env, signal },
  );
  return response.content
    .filter((part): part is { type: "text"; text: string } => part.type === "text")
    .map((part) => part.text)
    .join("\n");
}

function defaultPlayDing(): void {
  void ensureDingFile().then((file) => {
    if (!file) return;
    try {
      const child = spawn("paplay", [file], { stdio: "ignore" });
      const killer = setTimeout(() => child.kill(), 2_000);
      child.on("exit", () => clearTimeout(killer));
    } catch {
      // No sound is fine; silence is the fallback.
    }
  });
}

let cachedDingFile: string | undefined;
async function ensureDingFile(): Promise<string | undefined> {
  if (cachedDingFile) return cachedDingFile;
  try {
    const dir = join(tmpdir(), "pi-ass");
    await mkdir(dir, { recursive: true });
    cachedDingFile = join(dir, "ding.wav");
    await writeFile(cachedDingFile, renderDingWav());
    return cachedDingFile;
  } catch {
    return undefined;
  }
}

export function registerAss(pi: ExtensionAPI): AssController {
  const controller = new AssController();
  pi.on("message_end", (event, _ctx) => controller.observeMessage(event));
  pi.on("agent_settled", (_event, ctx) => {
    void controller.settle(_event, ctx);
  });
  pi.on("session_compact", () => controller.compacted());

  pi.registerCommand("ass", {
    description: "ass (a successful shitposter) — one-line commentary on your session",
    getArgumentCompletions: (prefix) =>
      ["say something", "on", "off"]
        .filter((candidate) => candidate.startsWith(prefix.toLowerCase()))
        .map((value) => ({ value, label: value })),
    handler: async (args, ctx) => {
      const argument = args.trim().toLowerCase();
      if (argument === "say something" || argument === "say") {
        await controller.force(ctx);
        return;
      }
      if (argument === "on") {
        controller.setEnabled(true, ctx);
        return;
      }
      if (argument === "off") {
        controller.setEnabled(false, ctx);
        return;
      }
      controller.setEnabled(!controller.isEnabled(), ctx);
    },
  });

  return controller;
}
