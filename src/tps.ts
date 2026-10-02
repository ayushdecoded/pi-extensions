import { CustomEditor, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";

/**
 * Live estimates divide streamed characters by this constant because providers report
 * no per-chunk token counts. The exact provider count replaces it at message_end,
 * where `usage.output` already includes reasoning tokens.
 */
export const CHARS_PER_TOKEN = 4;

/** Give the stream a moment to settle so a tiny early sample cannot flash a wild ratio. */
export const WARMUP_MS = 250;

export function formatTps(tokens: number, elapsedMs: number): string | undefined {
  if (!(tokens > 0) || !(elapsedMs > 0)) return undefined;
  return `${Math.round(tokens / (elapsedMs / 1000))} tok/s`;
}

type Indicator = Parameters<CustomEditor["setWorkingStatusIndicator"]>[0];

/**
 * Pins the tokens-per-second reading to the editor's top border, right aligned and
 * without a spinner, and keeps the last exact value on screen after the stream ends.
 * Retry, compaction, and branch-summary notices keep their normal border rendering.
 */
export class TpsEditor extends CustomEditor {
  private tps: string | undefined;
  private indicator: Indicator;

  setTps(text: string | undefined): void {
    if (this.tps === text) return;
    this.tps = text;
    this.tui.requestRender();
  }

  setWorkingStatusIndicator(indicator: Indicator): void {
    this.indicator = indicator;
    super.setWorkingStatusIndicator(indicator);
  }

  protected renderTopBorder(width: number, hiddenLineCount: number): string {
    const kind = this.indicator?.kind;
    if (!this.tps || hiddenLineCount > 0 || width <= 0 || (kind !== undefined && kind !== "working")) {
      return super.renderTopBorder(width, hiddenLineCount);
    }
    const text = this.tps;
    const remaining = width - visibleWidth(text) - 4;
    if (remaining < 0) return super.renderTopBorder(width, hiddenLineCount);
    return this.borderColor("─".repeat(remaining)) + " " + text + this.borderColor(" ──");
  }
}

export default function tpsExtension(pi: ExtensionAPI) {
  let editor: TpsEditor | undefined;
  let startedAt: number | undefined;
  let chars = 0;

  const show = (text: string) => editor?.setTps(text);

  pi.on("session_start", (_event, ctx) => {
    if (ctx.mode !== "tui") return;
    ctx.ui.setEditorComponent((tui, theme, keybindings) => {
      editor = new TpsEditor(tui, theme, keybindings, { embedWorkingStatus: true });
      return editor;
    });
  });

  pi.on("message_start", (event) => {
    if (event.message.role !== "assistant") return;
    startedAt = Date.now();
    chars = 0;
  });

  pi.on("message_update", (event) => {
    if (event.message.role !== "assistant") return;
    // A reload mid-stream starts timing from the first update we see.
    if (startedAt === undefined) {
      startedAt = Date.now();
      chars = 0;
    }
    const update = event.assistantMessageEvent;
    if (update.type === "text_delta" || update.type === "thinking_delta" || update.type === "toolcall_delta") {
      chars += update.delta.length;
    }
    const elapsed = Date.now() - startedAt;
    if (elapsed < WARMUP_MS) return;
    const live = formatTps(chars / CHARS_PER_TOKEN, elapsed);
    if (live) show(live);
  });

  pi.on("message_end", (event) => {
    if (event.message.role !== "assistant" || startedAt === undefined) return;
    const elapsed = Date.now() - startedAt;
    startedAt = undefined;
    const exact = formatTps(event.message.usage.output, elapsed) ?? formatTps(chars / CHARS_PER_TOKEN, elapsed);
    if (exact) show(exact);
  });
}
