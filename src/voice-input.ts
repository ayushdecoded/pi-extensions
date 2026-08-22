import { spawn, type ChildProcess } from "node:child_process";
import { mkdir, open, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import type { ExtensionAPI, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import type { Component, TUI } from "@earendil-works/pi-tui";
import { truncateToWidth } from "@earendil-works/pi-tui";
import { codexAuth, codexAuthHeaders } from "./codex-auth.ts";
import { pasteDictated } from "./dictation-target.ts";
import { playerctlMediaPause, type MediaPause } from "./media-pause.ts";

const TRANSCRIBE_URL = "https://chatgpt.com/backend-api/transcribe";
const RECORD_DIR = join(tmpdir(), "pi-voice");
const ORIGINATOR = "Codex Desktop";
const USER_AGENT = "Codex Desktop/26.429.30905 (Linux; x64)";
const REQUEST_TIMEOUT_MS = 60_000;
const PREVIEW_LENGTH = 120;
const WIDGET_KEY = "voice-input";
/** Shared shortcut identity for voice input and composer ask mode. */
export const VOICE_INPUT_SHORTCUT = "ctrl+shift+r" as const;

const BAR_HEIGHTS = "▁▂▃▄▅▆▇█";
const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const HISTORY_SIZE = 16;
const SAMPLE_INTERVAL_MS = 100;
// Standard 44-byte PCM WAV header; audio data follows it.
const WAV_HEADER_BYTES = 44;
// Tail bytes sampled per tick (~21ms of 48kHz stereo s16).
const LEVEL_TAIL_BYTES = 4096;

export type VoiceIndicatorMode = "recording" | "transcribing";

/** Returns the current microphone level in 0..1 for a growing WAV file. */
export type LevelSource = (filePath: string) => Promise<number>;

export type VoiceIndicatorOptions = {
  tui: TUI;
  theme: Theme;
  mode: VoiceIndicatorMode;
  /** WAV path to sample while recording. Only used in recording mode. */
  filePath?: string;
  /** Level sampler; defaults to reading the PCM tail of the WAV file. */
  sample?: LevelSource;
  startedAt?: number;
};

/**
 * Widget shown above the prompt editor while voice input is active.
 *
 * - `recording`: pulsing REC dot, elapsed timer, and a waveform driven by the
 *   actual microphone level (sampled from the growing WAV file).
 * - `transcribing`: spinner animation shown after recording stops, until the
 *   transcript is pasted and the widget is removed.
 */
export class VoiceIndicator implements Component {
  private readonly timer: NodeJS.Timeout;
  private readonly startedAt: number;
  private readonly history: number[] = [];
  constructor(private readonly options: VoiceIndicatorOptions) {
    this.startedAt = options.startedAt ?? Date.now();
    this.timer = setInterval(() => void this.tick(), SAMPLE_INTERVAL_MS);
  }
  render(width: number): string[] {
    if (width < 16) return [];
    const now = Date.now();
    if (this.options.mode === "transcribing") {
      const frame = SPINNER[Math.floor(now / 100) % SPINNER.length]!;
      const label = `${this.options.theme.fg("accent", frame)} ${this.options.theme.fg("text", "Transcribing…")}`;
      return [truncateToWidth(label, Math.max(0, width))];
    }
    const elapsed = Math.max(0, Math.floor((now - this.startedAt) / 1000));
    const mm = String(Math.floor(elapsed / 60)).padStart(2, "0");
    const ss = String(elapsed % 60).padStart(2, "0");
    const blinking = Math.floor(now / 500) % 2 === 0;
    const dot = this.options.theme.fg(blinking ? "error" : "muted", "●");
    const barCount = Math.min(16, Math.max(4, Math.floor((width - 18) / 2)));
    const bars = this.history.length
      ? this.history.map((level) => bar(level)).join("")
      : BAR_HEIGHTS[0]!.repeat(barCount);
    const label = `${dot} ${this.options.theme.fg("text", "REC")} ${this.options.theme.fg("muted", `${mm}:${ss}`)}  ${bars}`;
    return [truncateToWidth(label, Math.max(0, width))];
  }
  invalidate(): void {}
  dispose(): void {
    clearInterval(this.timer);
  }
  /** Sample the current level and push it into the waveform history. Public for tests. */
  async refresh(): Promise<void> {
    if (this.options.mode !== "recording" || !this.options.filePath) return;
    const level = await (this.options.sample ?? sampleWavLevel)(this.options.filePath);
    this.history.push(level);
    if (this.history.length > HISTORY_SIZE) this.history.shift();
  }
  private async tick(): Promise<void> {
    await this.refresh();
    this.options.tui.requestRender();
  }
}

function bar(level: number): string {
  const index = Math.max(0, Math.min(BAR_HEIGHTS.length - 1, Math.round(level * (BAR_HEIGHTS.length - 1))));
  return BAR_HEIGHTS[index] ?? BAR_HEIGHTS[0]!;
}

/**
 * Default level source: reads the tail of the growing WAV file and maps the
 * PCM RMS to a 0..1 level on a decibel-ish curve (soft below -45 dB).
 */
export async function sampleWavLevel(filePath: string): Promise<number> {
  try {
    const { size } = await stat(filePath);
    const dataSize = Math.max(0, size - WAV_HEADER_BYTES);
    if (dataSize < 2) return 0;
    const tailBytes = Math.min(dataSize, LEVEL_TAIL_BYTES);
    const buffer = Buffer.alloc(tailBytes);
    const handle = await open(filePath, "r");
    try {
      await handle.read(buffer, 0, tailBytes, WAV_HEADER_BYTES + dataSize - tailBytes);
    } finally {
      await handle.close();
    }
    let sumSquares = 0;
    let count = 0;
    for (let i = 0; i + 1 < buffer.length; i += 2) {
      const sample = buffer.readInt16LE(i);
      sumSquares += sample * sample;
      count += 1;
    }
    if (count === 0) return 0;
    const rms = Math.sqrt(sumSquares / count);
    const db = 20 * Math.log10(Math.min(1, rms / 32768) + 1e-9);
    return Math.min(1, Math.max(0, (db + 45) / 35));
  } catch {
    return 0;
  }
}

export interface RecorderHandle {
  pid: number;
  /** Resolves once the recording process has fully exited (file flushed). */
  wait: () => Promise<void>;
}

export interface Recorder {
  start(filePath: string): RecorderHandle;
  stop(handle: RecorderHandle): Promise<void>;
}

/** Default recorder: PipeWire's pw-record writing a WAV file. */
export function pwRecordRecorder(): Recorder {
  return {
    start(filePath: string): RecorderHandle {
      const child: ChildProcess = spawn("pw-record", ["--container=wav", filePath], { stdio: "ignore" });
      return {
        pid: child.pid!,
        wait: () => new Promise((resolve) => {
          if (child.exitCode !== null || child.signalCode !== null) resolve();
          else child.once("exit", () => resolve());
        }),
      };
    },
    async stop(handle: RecorderHandle): Promise<void> {
      try {
        process.kill(handle.pid, "SIGTERM");
      } catch {
        // Process already gone.
      }
      await handle.wait();
    },
  };
}

export type VoiceInputDependencies = {
  fetch?: typeof fetch;
  recorder?: Recorder;
  recordDir?: string;
  /** Pauses MPRIS media while recording; defaults to playerctl. */
  mediaPause?: MediaPause;
  /** Selected Codex account provider; authentication still resolves through Pi. */
  codexProvider?: () => string;
};

export type VoiceToggleResult = "recording" | "transcribed" | "error";

export function createVoiceInput(dependencies: VoiceInputDependencies = {}) {
  const fetchImpl = dependencies.fetch ?? fetch;
  const recorder = dependencies.recorder ?? pwRecordRecorder();
  const recordDir = dependencies.recordDir ?? RECORD_DIR;
  const mediaPause = dependencies.mediaPause ?? playerctlMediaPause();
  let active: { handle: RecorderHandle; filePath: string; pausedPlayers: string[] } | null = null;

  /** Toggle: start recording, or stop and transcribe into the prompt editor. */
  async function toggle(ctx: ExtensionContext): Promise<VoiceToggleResult> {
    if (active) {
      const current = active;
      try {
        // The recording indicator is replaced by a transcribing animation
        // immediately; the widget itself stays until the text is pasted.
        if (ctx.mode === "tui") {
          ctx.ui.setWidget(WIDGET_KEY, (tui, theme) => new VoiceIndicator({ tui, theme, mode: "transcribing" }));
        }
        await recorder.stop(current.handle);
        // Resume media as soon as recording stops (not after transcription),
        // matching Omarchy's native dictation: pause only while recording.
        await mediaPause.resume(current.pausedPlayers);
        const audio = await readFile(current.filePath);
        const text = await transcribeAudio(audio, "audio/wav", ctx);
        if (text) {
          // Lands in the focused component's input when one registered a sink
          // (e.g. the ask panel); otherwise the prompt editor.
          pasteDictated(ctx, text);
          ctx.ui.notify(`🎙 ${preview(text)}`, "info");
        } else {
          ctx.ui.notify("Voice input caught no speech.", "warning");
        }
        return "transcribed";
      } catch (error) {
        ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
        return "error";
      } finally {
        if (ctx.mode === "tui") ctx.ui.setWidget(WIDGET_KEY, undefined);
        await rm(current.filePath, { force: true }).catch(() => undefined);
        await rm(join(recordDir, "pid"), { force: true }).catch(() => undefined);
        active = null;
      }
    }
    await mkdir(recordDir, { recursive: true });
    await killStaleRecorder(recordDir);
    const filePath = join(recordDir, `voice-${Date.now()}-${randomUUID().slice(0, 8)}.wav`);
    const handle = recorder.start(filePath);
    // Snapshot and pause currently-playing MPRIS players while the mic is live.
    const pausedPlayers = await mediaPause.pause();
    active = { handle, filePath, pausedPlayers };
    await writeFile(join(recordDir, "pid"), `${handle.pid}\n`, { flag: "wx" }).catch(() => undefined);
    if (ctx.mode === "tui") {
      ctx.ui.setWidget(WIDGET_KEY, (tui, theme) => new VoiceIndicator({ tui, theme, mode: "recording", filePath }));
    }
    return "recording";
  }

  /** Transcribe audio via the ChatGPT backend endpoint using the Codex login. */
  async function transcribeAudio(audio: Uint8Array, mimeType: string, ctx: ExtensionContext, language?: string): Promise<string> {
    const auth = await codexAuth(ctx, "Voice input", dependencies.codexProvider?.());
    const form = new FormData();
    form.append("file", new Blob([new Uint8Array(audio)], { type: mimeType }), "recording.wav");
    if (language) form.append("language", language);
    const response = await fetchImpl(TRANSCRIBE_URL, {
      method: "POST",
      headers: {
        ...codexAuthHeaders(auth.apiKey, auth.headers),
        "originator": ORIGINATOR,
        "User-Agent": USER_AGENT,
      },
      body: form,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!response.ok) throw new Error(await responseError(response));
    const payload = await response.json() as { text?: string };
    const text = payload.text?.trim();
    if (!text) throw new Error("Transcription returned no text.");
    return text;
  }

  return { toggle, transcribeAudio };
}

export function registerVoiceInput(pi: ExtensionAPI, dependencies: VoiceInputDependencies = {}): { toggle: (ctx: ExtensionContext) => Promise<VoiceToggleResult> } {
  const voice = createVoiceInput(dependencies);
  const toggle = (ctx: ExtensionContext) => void voice.toggle(ctx);
  pi.registerShortcut(VOICE_INPUT_SHORTCUT, {
    description: "Toggle voice input (record, then transcribe into the prompt)",
    handler: toggle,
  });
  pi.registerCommand("voice", {
    description: "Toggle voice input recording/transcription",
    handler: async (_args, ctx) => { await voice.toggle(ctx); },
  });
  return voice;
}

/** Kill a recorder left over from a previous Pi session (crashed mid-recording). */
async function killStaleRecorder(recordDir: string): Promise<void> {
  try {
    const pidText = await readFile(join(recordDir, "pid"), "utf8");
    const pid = Number.parseInt(pidText.trim(), 10);
    if (Number.isInteger(pid) && pid > 0) {
      try {
        process.kill(pid, "SIGTERM");
      } catch {
        // Process already gone.
      }
    }
  } catch {
    // No stale pidfile.
  }
}

async function responseError(response: Response): Promise<string> {
  let message = `Transcription request failed: ${response.status} ${response.statusText}`;
  try {
    const body = await response.json() as { error?: { message?: string; code?: string } };
    if (body.error?.message) message = body.error.message;
  } catch {
    // Keep the HTTP error.
  }
  return message;
}

function preview(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length <= PREVIEW_LENGTH ? flat : `${flat.slice(0, PREVIEW_LENGTH)}…`;
}
