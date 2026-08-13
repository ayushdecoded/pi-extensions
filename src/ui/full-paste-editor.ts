import { CustomEditor, type KeybindingsManager } from "@earendil-works/pi-coding-agent";
import { visibleWidth, type EditorTheme, type TUI } from "@earendil-works/pi-tui";
import { getEmojiInlineReplacement } from "./emoji-autocomplete.ts";

const PASTE_START = "\x1b[200~";
const PASTE_END = "\x1b[201~";

/**
 * Render the composer's top border: left `45%/200k`, middle `⏳2` when background
 * runs are active, right `◆ mode ◇`, dashes filling the middle. Runs drop first
 * when narrow, then context.
 */
export function composerBorder(
  width: number,
  mode: string | undefined,
  context: string,
  runs: string,
  borderColor: (text: string) => string,
): string {
  const dash = borderColor("─");
  const left = context;
  const middle = runs;
  const right = mode ? borderColor(` ◆ ${mode} ◇`) : "";
  const leftWidth = visibleWidth(left);
  const middleWidth = visibleWidth(middle);
  const rightWidth = visibleWidth(right);
  if (left && middle && right && leftWidth + middleWidth + rightWidth + 4 > width) {
    return composerBorder(width, mode, context, "", borderColor);
  }
  if (left && right && leftWidth + rightWidth + 2 > width) {
    return composerBorder(width, mode, "", "", borderColor);
  }
  if (!left && !middle && rightWidth >= width) return borderColor(`◆ ${mode} ◇`.slice(0, width));
  const fill = Math.max(0, width - leftWidth - middleWidth - rightWidth);
  return `${left}${middle}${dash.repeat(fill)}${right}`;
}

/**
 * The stock editor stores large bracketed pastes behind an atomic marker.
 * Keep the terminal's paste framing, but insert the payload as ordinary text
 * so it remains directly editable. Also renders the active agent preset and
 * background-run count on the composer's top border.
 */
export class FullPasteEditor extends CustomEditor {
  private fullPasteBuffer = "";
  private fullPasteActive = false;
  private readonly getMode: (() => string | undefined) | undefined;
  private readonly getContext: (() => string) | undefined;
  private readonly getRuns: (() => string) | undefined;

  constructor(
    tui: TUI,
    theme: EditorTheme,
    keybindings: KeybindingsManager,
    getMode?: () => string | undefined,
    getContext?: () => string,
    getRuns?: () => string,
  ) {
    super(tui, theme, keybindings);
    this.getMode = getMode;
    this.getContext = getContext;
    this.getRuns = getRuns;
  }

  override render(width: number): string[] {
    const lines = super.render(width);
    if (lines.length === 0 || lines[0] === undefined) return lines;
    const mode = this.getMode?.();
    const context = this.getContext?.() ?? "";
    const runs = this.getRuns?.() ?? "";
    if (!mode && !context && !runs) return lines;
    lines[0] = composerBorder(width, mode, context, runs, this.borderColor);
    return lines;
  }

  override handleInput(data: string): void {
    if (data === ":" && this.replaceCompletedEmojiShortcode()) return;

    if (this.fullPasteActive) {
      this.consumePasteData(data);
      return;
    }

    const start = data.indexOf(PASTE_START);
    if (start === -1) {
      super.handleInput(data);
      return;
    }

    // Preserve any ordinary input that arrived before the bracketed paste.
    if (start > 0) super.handleInput(data.slice(0, start));
    this.fullPasteActive = true;
    this.fullPasteBuffer = "";
    this.consumePasteData(data.slice(start + PASTE_START.length));
  }

  /**
   * Keep the stock composer and its cursor state intact: remove the already
   * typed shortcode, then insert the emoji through its normal edit path.
   */
  private replaceCompletedEmojiShortcode(): boolean {
    const { line, col } = this.getCursor();
    const textBeforeCursor = (this.getLines()[line] ?? "").slice(0, col);
    const replacement = getEmojiInlineReplacement(`${textBeforeCursor}:`);
    if (!replacement) return false;

    // A visible completion menu owns Escape, so this only dismisses that menu;
    // it cannot interrupt Pi while an emoji shortcode is being completed.
    if (this.isShowingAutocomplete()) super.handleInput("\x1b");
    for (let index = 0; index < replacement.replaceLen - 1; index++) super.handleInput("\x7f");
    super.handleInput(replacement.insert);
    return true;
  }

  private consumePasteData(data: string): void {
    this.fullPasteBuffer += data;
    const end = this.fullPasteBuffer.indexOf(PASTE_END);
    if (end === -1) return;

    const pastedText = this.fullPasteBuffer.slice(0, end);
    const remaining = this.fullPasteBuffer.slice(end + PASTE_END.length);
    this.fullPasteBuffer = "";
    this.fullPasteActive = false;

    if (pastedText) {
      // Match the stock editor's control-character filtering while deliberately
      // skipping its large-paste marker path.
      const decoded = pastedText.replace(/\x1b\[(\d+);5u/g, (_match, code: string) => {
        const cp = Number(code);
        if (cp >= 97 && cp <= 122) return String.fromCharCode(cp - 96);
        if (cp >= 65 && cp <= 90) return String.fromCharCode(cp - 64);
        return _match;
      });
      const clean = decoded
        .replace(/\r\n/g, "\n")
        .replace(/\r/g, "\n")
        .replace(/\t/g, "    ")
        .split("")
        .filter((char) => char === "\n" || char.charCodeAt(0) >= 32)
        .join("");
      this.insertTextAtCursor(clean);
    }

    // A terminal may deliver more input in the same chunk after the paste.
    if (remaining) this.handleInput(remaining);
  }
}
