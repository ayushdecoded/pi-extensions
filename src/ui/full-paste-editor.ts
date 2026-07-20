import { CustomEditor, type KeybindingsManager } from "@earendil-works/pi-coding-agent";
import type { EditorTheme, TUI } from "@earendil-works/pi-tui";

const PASTE_START = "\x1b[200~";
const PASTE_END = "\x1b[201~";

/**
 * The stock editor stores large bracketed pastes behind an atomic marker.
 * Keep the terminal's paste framing, but insert the payload as ordinary text
 * so it remains directly editable.
 */
export class FullPasteEditor extends CustomEditor {
  private fullPasteBuffer = "";
  private fullPasteActive = false;

  constructor(tui: TUI, theme: EditorTheme, keybindings: KeybindingsManager) {
    super(tui, theme, keybindings);
  }

  override handleInput(data: string): void {
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
