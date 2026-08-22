import type { ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import type { Component, TUI } from "@earendil-works/pi-tui";
import { isKeyRelease, Key, matchesKey, truncateToWidth } from "@earendil-works/pi-tui";
import { VOICE_INPUT_SHORTCUT } from "../voice-input.ts";

export type AskQuestion = { question: string; options: string[]; multiple: boolean };
export type AskAnswer = { index: number; selected: string[]; notes: Record<string, string> };
export type AskComposerResult = { answers: AskAnswer[] };

const WIDGET_KEY = "ask-composer";
const DICTATE_KEY = VOICE_INPUT_SHORTCUT;

type InputMode = "other" | "note" | undefined;

/** Ask interaction rendered above, and typed answers entered in, the normal composer. */
export class AskComposer implements Component {
  private questionIndex = 0;
  private cursor = 0;
  private inputMode: InputMode;
  private noteTarget = -1;
  private readonly checked = new Set<number>();
  private readonly notes = new Map<number, string>();
  private customText: string | undefined;
  private customChecked = false;
  private readonly answers: AskAnswer[] = [];
  private settled = false;
  private tui?: TUI;

  constructor(
    private readonly questions: AskQuestion[],
    private readonly ctx: ExtensionContext,
    private readonly theme: Theme,
    private readonly originalEditorText: string,
    private readonly onDictate: (() => void) | undefined,
    private readonly done: (result: AskComposerResult) => void,
  ) {}

  attach(tui: TUI): void { this.tui = tui; }
  dismiss(): void { this.settle(); }
  dispose(): void {}
  invalidate(): void {}

  render(width: number): string[] {
    const q = this.questions[this.questionIndex];
    if (!q) return [];
    const t = this.theme;
    const lines: string[] = [];
    const counter = t.fg("muted", `${this.questionIndex + 1}/${this.questions.length}`);
    lines.push(`  ${t.fg("accent", "ASK")} ${counter}  ${t.bold(t.fg("text", q.question))}`);
    if (this.inputMode) {
      const target = this.inputMode === "note" ? `extend “${q.options[this.noteTarget]}”` : "write your own answer";
      lines.push(`  ${t.fg("accent", "Editing")} ${t.fg("dim", target)} ${t.fg("borderMuted", "· composer below")}`);
    } else {
      lines.push(`  ${t.fg("dim", q.multiple ? "Choose one or more" : "Choose one")}`);
    }
    lines.push(`  ${t.fg("borderMuted", "─".repeat(Math.max(8, Math.min(56, width - 4))))}`);
    for (let i = 0; i < q.options.length; i += 1) {
      const selected = q.multiple ? this.checked.has(i) : this.cursor === i;
      const lead = this.cursor === i ? t.fg("accent", "›") : " ";
      const number = t.fg("muted", `${i + 1}`.padStart(2, " "));
      const mark = q.multiple ? (selected ? t.fg("success", "[x]") : t.fg("dim", "[ ]")) : (selected ? t.fg("success", "●") : t.fg("dim", "○"));
      const label = t.fg(selected ? "accent" : "text", q.options[i]!);
      lines.push(truncateToWidth(` ${lead} ${number} ${mark} ${label}`, width, "…"));
      const note = this.notes.get(i);
      if (note) lines.push(truncateToWidth(`             ${t.fg("borderMuted", "└─")} ${t.fg("dim", note)}`, width, "…"));
    }
    const other = this.customText === undefined ? "Write your own…" : `"${this.customText}"`;
    const otherLead = this.cursor === q.options.length ? t.fg("accent", "›") : " ";
    const otherMark = this.customChecked ? t.fg("success", "[x]") : t.fg("dim", "✎");
    lines.push(truncateToWidth(` ${otherLead} ${t.fg("muted", " o")} ${otherMark} ${t.fg(this.customChecked ? "text" : "dim", other)}`, width, "…"));
    const hint = this.inputMode
      ? `${t.fg("accent", "↵")} save · ${t.fg("accent", "esc")} cancel${this.onDictate ? ` · ${t.fg("accent", "dictate")}` : ""}`
      : `${t.fg("accent", "↑↓")} move · ${q.multiple ? `${t.fg("accent", "space")} toggle · ` : ""}${t.fg("accent", "↵")} submit · ${t.fg("accent", "⇧↵")} extend · ${t.fg("accent", "esc")} dismiss`;
    lines.push(`  ${t.fg("muted", hint)}`);
    return lines;
  }

  handleInput(data: string): { consume: boolean } {
    if (isKeyRelease(data)) return { consume: true };
    if (this.onDictate && matchesKey(data, DICTATE_KEY)) {
      this.onDictate();
      return { consume: true };
    }
    const q = this.questions[this.questionIndex];
    if (!q) return { consume: true };

    if (this.inputMode) {
      if (matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl("c"))) {
        this.cancelInput();
        return { consume: true };
      }
      if (matchesKey(data, Key.enter)) {
        this.commitInput();
        return { consume: true };
      }
      // Let the real composer editor receive printable input, including paste.
      return { consume: false };
    }

    if (matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl("c"))) { this.settle(); return { consume: true }; }
    const last = q.options.length;
    if (matchesKey(data, Key.shift("enter")) || matchesKey(data, Key.ctrl("j"))) {
      if (this.cursor === last) this.beginInput("other");
      else this.beginInput("note", this.cursor);
      return { consume: true };
    }
    if (matchesKey(data, Key.tab)) { this.cursor = last; this.renderNow(); return { consume: true }; }
    if (matchesKey(data, Key.up)) { this.cursor = (this.cursor - 1 + last + 1) % (last + 1); this.renderNow(); return { consume: true }; }
    if (matchesKey(data, Key.down)) { this.cursor = (this.cursor + 1) % (last + 1); this.renderNow(); return { consume: true }; }
    if (/^[1-9]$/.test(data) && Number(data) - 1 < last) { this.activate(Number(data) - 1); return { consume: true }; }
    if (matchesKey(data, Key.space)) { this.activate(this.cursor); return { consume: true }; }
    if (matchesKey(data, Key.enter)) {
      if (this.cursor === last) {
        if (q.multiple && this.customChecked) this.submitChecked();
        else this.beginInput("other");
      } else if (q.multiple) this.submitChecked();
      else this.choose(this.cursor);
      return { consume: true };
    }
    return { consume: true };
  }

  private activate(index: number): void {
    const q = this.questions[this.questionIndex]!;
    if (index === q.options.length) { this.beginInput("other"); return; }
    if (q.multiple) {
      if (this.checked.has(index)) this.checked.delete(index); else this.checked.add(index);
      this.renderNow();
    } else this.choose(index);
  }

  private choose(index: number): void { this.pushAnswer([this.questions[this.questionIndex]!.options[index]!]); this.advance(); }

  private submitChecked(): void {
    const q = this.questions[this.questionIndex]!;
    const selected = [...this.checked].sort((a, b) => a - b).map((i) => q.options[i]!);
    if (this.customChecked && this.customText) selected.push(this.customText);
    if (selected.length > 0) { this.pushAnswer(selected); this.advance(); }
  }

  private beginInput(mode: "other" | "note", target = -1): void {
    this.inputMode = mode;
    this.noteTarget = target;
    this.ctx.ui.setEditorText(mode === "note" ? this.notes.get(target) ?? "" : "");
    this.renderNow();
  }

  private commitInput(): void {
    const text = this.ctx.ui.getEditorText().trim();
    this.ctx.ui.setEditorText("");
    if (!text) { this.inputMode = undefined; this.renderNow(); return; }
    if (this.inputMode === "note") {
      this.notes.set(this.noteTarget, text);
      this.inputMode = undefined;
      this.renderNow();
      return;
    }
    const q = this.questions[this.questionIndex]!;
    if (q.multiple) {
      this.customText = text;
      this.customChecked = true;
      this.cursor = q.options.length;
      this.inputMode = undefined;
      this.renderNow();
    } else {
      this.pushAnswer([text]);
      this.advance();
    }
  }

  private cancelInput(): void { this.ctx.ui.setEditorText(""); this.inputMode = undefined; this.renderNow(); }

  private pushAnswer(selected: string[]): void {
    const q = this.questions[this.questionIndex]!;
    const notes: Record<string, string> = {};
    for (const [index, note] of this.notes) if (q.options[index] !== undefined) notes[q.options[index]!] = note;
    this.answers.push({ index: this.questionIndex, selected, notes });
  }

  private advance(): void {
    this.questionIndex += 1;
    if (this.questionIndex >= this.questions.length) { this.settle(); return; }
    this.cursor = 0; this.checked.clear(); this.notes.clear(); this.customText = undefined; this.customChecked = false; this.inputMode = undefined;
    this.ctx.ui.setEditorText("");
    this.renderNow();
  }

  private settle(): void {
    if (this.settled) return;
    this.settled = true;
    this.ctx.ui.setEditorText(this.originalEditorText);
    this.ctx.ui.setWidget(WIDGET_KEY, undefined);
    this.done({ answers: [...this.answers] });
  }

  private renderNow(): void { this.tui?.requestRender(); }
}

export async function askInComposer(
  ctx: ExtensionContext,
  questions: AskQuestion[],
  signal: AbortSignal | undefined,
  onDictate?: () => void,
): Promise<AskComposerResult> {
  const originalText = ctx.ui.getEditorText();
  let controller: AskComposer | undefined;
  let unsubscribeInput: (() => void) | undefined;
  const result = new Promise<AskComposerResult>((resolve) => {
    ctx.ui.setWidget(WIDGET_KEY, (tui, theme) => {
      controller = new AskComposer(questions, ctx, theme, originalText, onDictate, resolve);
      controller.attach(tui);
      unsubscribeInput = ctx.ui.onTerminalInput((data) => controller!.handleInput(data));
      return controller;
    }, { placement: "aboveEditor" });
  });
  const abort = () => controller?.dismiss?.();
  signal?.addEventListener("abort", abort, { once: true });
  await result;
  signal?.removeEventListener("abort", abort);
  unsubscribeInput?.();
  return await result;
}
