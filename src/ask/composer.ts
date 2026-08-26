import type { ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import type { Component, TUI } from "@earendil-works/pi-tui";
import { isKeyRelease, Key, matchesKey, truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { setDictationSink } from "../dictation-target.ts";
import { VOICE_INPUT_SHORTCUT } from "../voice-input.ts";

export type AskQuestion = { question: string; options: string[]; multiple: boolean };
export type AskAnswer = { index: number; selected: string[]; notes: Record<string, string> };
export type AskComposerResult = { answers: AskAnswer[] };

type InputMode = "other" | "note" | undefined;
type QuestionState = { cursor: number; checked: Set<number>; notes: Map<number, string>; customText?: string; customChecked: boolean };
const WIDGET_KEY = "ask-composer";
const DICTATE_KEY = VOICE_INPUT_SHORTCUT;

/** Ask interaction rendered above, and typed answers entered in, the normal composer. */
export class AskComposer implements Component {
  private questionIndex = 0;
  private cursor = 0;
  private inputMode: InputMode;
  private noteTarget = -1;
  private readonly states = new Map<number, QuestionState>();
  private readonly answers = new Map<number, AskAnswer>();
  private reviewing = false;
  private confirming = false;
  private settled = false;
  private tui?: TUI;

  constructor(
    private readonly questions: AskQuestion[], private readonly ctx: ExtensionContext, private readonly theme: Theme,
    private readonly originalEditorText: string, private readonly onDictate: (() => void) | undefined,
    private readonly done: (result: AskComposerResult) => void,
  ) {}

  attach(tui: TUI): void { this.tui = tui; }
  dismiss(): void { this.settle(); }
  dispose(): void {}
  invalidate(): void {}

  render(width: number): string[] {
    const t = this.theme;
    if (this.reviewing) return this.renderReview(width);
    const q = this.questions[this.questionIndex];
    if (!q) return [];
    const lines: string[] = [];
    const headingPrefix = `  ${t.fg("accent", "ASK")} ${t.fg("muted", `${this.questionIndex + 1}/${this.questions.length}`)}  `;
    const headingWidth = Math.max(10, width - visibleWidth(headingPrefix));
    const wrappedQuestion = wrapTextWithAnsi(t.bold(t.fg("text", q.question)), headingWidth);
    lines.push(`${headingPrefix}${wrappedQuestion[0] ?? ""}`);
    const continuationIndent = " ".repeat(visibleWidth(headingPrefix));
    for (const line of wrappedQuestion.slice(1)) lines.push(`${continuationIndent}${line}`);
    lines.push(this.inputMode
      ? `  ${t.fg("accent", "Editing")} ${t.fg("dim", this.inputMode === "note" ? `extend “${q.options[this.noteTarget]}”` : "write your own answer")} ${t.fg("borderMuted", "· composer below")}`
      : `  ${t.fg("dim", q.multiple ? "Choose one or more" : "Choose one")}`);
    const saved = this.answers.get(this.questionIndex);
    if (saved && !this.inputMode) {
      lines.push(truncateToWidth(`  ${t.fg("success", "✓ saved")} ${t.fg("borderMuted", "·")} ${t.fg("success", saved.selected.join(", "))}`, width, "…"));
    }
    lines.push(`  ${t.fg("borderMuted", "─".repeat(Math.max(8, Math.min(56, width - 4))))}`);
    for (let i = 0; i < q.options.length; i += 1) {
      const selected = q.multiple ? this.currentState().checked.has(i) : this.cursor === i;
      const lead = this.cursor === i ? t.fg("accent", "›") : " ";
      const mark = q.multiple ? (selected ? t.fg("success", "[x]") : t.fg("dim", "[ ]")) : (selected ? t.fg("success", "●") : t.fg("dim", "○"));
      lines.push(truncateToWidth(` ${lead} ${t.fg("muted", `${i + 1}`.padStart(2, " "))} ${mark} ${t.fg(selected ? "accent" : "text", q.options[i]!)}`, width, "…"));
      const note = this.currentState().notes.get(i);
      if (note) lines.push(truncateToWidth(`             ${t.fg("borderMuted", "└─")} ${t.fg("dim", note)}`, width, "…"));
    }
    const state = this.currentState();
    const other = state.customText === undefined ? "Write your own…" : `"${state.customText}"`;
    lines.push(truncateToWidth(` ${this.cursor === q.options.length ? t.fg("accent", "›") : " "} ${t.fg("muted", " o")} ${state.customChecked ? t.fg("success", "[x]") : t.fg("dim", "✎")} ${t.fg(state.customChecked ? "text" : "dim", other)}`, width, "…"));
    const hint = this.inputMode ? `${t.fg("accent", "↵")} save · ${t.fg("accent", "esc")} cancel` : `${t.fg("accent", "←→")} questions · ${t.fg("accent", "↑↓")} move · ${q.multiple ? `${t.fg("accent", "space")} toggle · ` : ""}${t.fg("accent", "↵")} answer · ${t.fg("accent", "⇧↵")} extend · ${t.fg("accent", "esc")} dismiss`;
    lines.push(`  ${t.fg("muted", hint)}`);
    return lines;
  }

  private renderReview(width: number): string[] {
    const t = this.theme;
    const unanswered = this.questions.length - this.answers.size;
    const divider = `  ${t.fg("borderMuted", "─".repeat(Math.max(8, Math.min(56, width - 4))))}`;
    const lines = [
      `  ${t.fg("accent", "ASK")} ${t.bold(t.fg("text", "Review your decisions"))}`,
      `  ${t.fg("muted", `${this.answers.size}/${this.questions.length} answered${unanswered ? ` · ${unanswered} unanswered` : ""}`)}`,
      divider,
    ];
    for (const [index, q] of this.questions.entries()) {
      const answer = this.answers.get(index);
      const marker = answer ? t.fg("success", "✓") : t.fg("dim", "—");
      lines.push(truncateToWidth(` ${marker} ${t.fg("muted", `${index + 1}.`)} ${t.fg("text", q.question)}`, width, "…"));
      lines.push(truncateToWidth(`    ${answer ? t.fg("accent", answer.selected.join(" · ")) : t.fg("dim", "Unanswered")}`, width, "…"));
      if (answer) for (const [value, note] of Object.entries(answer.notes)) lines.push(truncateToWidth(`      ${t.fg("dim", `${value}: ${note}`)}`, width, "…"));
    }
    if (this.confirming) {
      lines.push(divider);
      lines.push(`  ${t.fg("warning", `Submit with ${unanswered} unanswered ${unanswered === 1 ? "question" : "questions"}?`)}`);
      lines.push(`  ${t.fg("muted", `${t.fg("accent", "↵")} submit anyway · ${t.fg("accent", "esc")} answer unanswered`)}`);
    } else {
      lines.push(`  ${t.fg("muted", `${t.fg("accent", "↵")} submit · ${t.fg("accent", "esc")} edit · ${t.fg("accent", "ctrl+c")} close`)}`);
    }
    return lines;
  }

  handleInput(data: string): { consume: boolean } {
    if (isKeyRelease(data)) return { consume: true };
    if (this.onDictate && matchesKey(data, DICTATE_KEY)) { this.onDictate(); return { consume: true }; }
    if (this.reviewing) {
      if (this.confirming) {
        if (matchesKey(data, Key.enter)) this.settle();
        else if (matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl("c"))) this.focusQuestion(this.firstIncompleteIndex());
      } else if (matchesKey(data, Key.enter)) {
        if (this.answers.size < this.questions.length) { this.confirming = true; this.renderNow(); }
        else this.settle();
      } else if (matchesKey(data, Key.escape)) this.focusQuestion(this.firstIncompleteIndex());
      else if (matchesKey(data, Key.ctrl("c"))) this.settle();
      return { consume: true };
    }
    const q = this.questions[this.questionIndex];
    if (!q) return { consume: true };
    if (this.inputMode) {
      if (matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl("c"))) this.cancelInput();
      else if (matchesKey(data, Key.enter)) this.commitInput();
      return { consume: matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl("c")) || matchesKey(data, Key.enter) };
    }
    if (matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl("c"))) { this.settle(); return { consume: true }; }
    if (matchesKey(data, Key.left)) { this.navigate(-1); return { consume: true }; }
    if (matchesKey(data, Key.right)) { if (this.questionIndex === this.questions.length - 1) this.showReview(); else this.navigate(1); return { consume: true }; }
    const last = q.options.length;
    if (matchesKey(data, Key.shift("enter")) || matchesKey(data, Key.ctrl("j"))) { this.beginInput(this.cursor === last ? "other" : "note", this.cursor); return { consume: true }; }
    if (matchesKey(data, Key.tab)) { this.cursor = last; this.renderNow(); return { consume: true }; }
    if (matchesKey(data, Key.up)) { this.cursor = (this.cursor - 1 + last + 1) % (last + 1); this.renderNow(); return { consume: true }; }
    if (matchesKey(data, Key.down)) { this.cursor = (this.cursor + 1) % (last + 1); this.renderNow(); return { consume: true }; }
    if (/^[1-9]$/.test(data) && Number(data) - 1 < last) { this.activate(Number(data) - 1); return { consume: true }; }
    if (matchesKey(data, Key.space)) { this.activate(this.cursor); return { consume: true }; }
    if (matchesKey(data, Key.enter)) {
      if (this.cursor === last) { if (q.multiple && this.currentState().customChecked) this.submitChecked(); else this.beginInput("other"); }
      else if (q.multiple) this.submitChecked(); else this.choose(this.cursor);
      return { consume: true };
    }
    return { consume: true };
  }

  private currentState(): QuestionState {
    let state = this.states.get(this.questionIndex);
    if (!state) { state = { cursor: 0, checked: new Set(), notes: new Map(), customChecked: false }; this.states.set(this.questionIndex, state); }
    return state;
  }
  private navigate(delta: number): void {
    this.states.set(this.questionIndex, { ...this.currentState(), cursor: this.cursor, checked: new Set(this.currentState().checked), notes: new Map(this.currentState().notes) });
    this.focusQuestion(Math.max(0, Math.min(this.questions.length - 1, this.questionIndex + delta)));
  }
  private focusQuestion(index: number): void {
    this.questionIndex = index;
    this.reviewing = false;
    this.confirming = false;
    const state = this.currentState(); this.cursor = state.cursor; this.inputMode = undefined;
    this.ctx.ui.setEditorText(""); this.renderNow();
  }
  private activate(index: number): void {
    const q = this.questions[this.questionIndex]!; const state = this.currentState();
    if (index === q.options.length) { this.beginInput("other"); return; }
    if (q.multiple) { if (state.checked.has(index)) state.checked.delete(index); else state.checked.add(index); this.renderNow(); } else this.choose(index);
  }
  private choose(index: number): void {
    const state = this.currentState();
    state.cursor = index;
    state.customChecked = false; // picking an option replaces a previously typed answer
    this.pushAnswer([this.questions[this.questionIndex]!.options[index]!]);
    this.advance();
  }
  private submitChecked(): void { const q = this.questions[this.questionIndex]!; const state = this.currentState(); const selected = [...state.checked].sort((a, b) => a - b).map((i) => q.options[i]!); if (state.customChecked && state.customText) selected.push(state.customText); if (selected.length) { this.pushAnswer(selected); this.advance(); } }
  private beginInput(mode: "other" | "note", target = -1, seed?: string): void {
    this.inputMode = mode; this.noteTarget = target;
    const fallback = mode === "note" ? this.currentState().notes.get(target) ?? "" : this.currentState().customText ?? "";
    this.ctx.ui.setEditorText(seed !== undefined ? seed : fallback);
    this.renderNow();
  }
  private commitInput(): void {
    const text = this.ctx.ui.getEditorText().trim(); this.ctx.ui.setEditorText(""); if (!text) { this.inputMode = undefined; this.renderNow(); return; }
    const state = this.currentState();
    if (this.inputMode === "note") {
      state.notes.set(this.noteTarget, text);
      const answer = this.answers.get(this.questionIndex);
      const option = this.questions[this.questionIndex]!.options[this.noteTarget];
      if (answer && option !== undefined) answer.notes[option] = text;
      this.inputMode = undefined; this.renderNow(); return;
    }
    const q = this.questions[this.questionIndex]!;
    // Both modes persist the typed answer in question state so it survives
    // navigating away and back; single mode additionally commits right away.
    state.customText = text; state.customChecked = true;
    if (q.multiple) { this.cursor = q.options.length; this.inputMode = undefined; this.renderNow(); } else { this.pushAnswer([text]); this.advance(); }
  }

  /** A dictated transcript arrived: land it in managed state, never loose in the editor. */
  handleDictation(text: string): void {
    if (this.reviewing || !this.questions[this.questionIndex]) return;
    if (this.inputMode) {
      // Already editing (question field or note): insert at the editor cursor.
      this.ctx.ui.pasteToEditor(text);
    } else {
      // Open a custom answer seeded with the transcript so later navigation
      // cannot silently wipe it.
      this.beginInput("other", -1, text);
    }
    this.renderNow();
  }
  private cancelInput(): void { this.ctx.ui.setEditorText(""); this.inputMode = undefined; this.renderNow(); }
  private pushAnswer(selected: string[]): void { const state = this.currentState(); const q = this.questions[this.questionIndex]!; const notes: Record<string, string> = {}; for (const [i, note] of state.notes) if (q.options[i] !== undefined) notes[q.options[i]!] = note; this.answers.set(this.questionIndex, { index: this.questionIndex, selected, notes }); }
  private advance(): void { this.questionIndex += 1; if (this.questionIndex >= this.questions.length) { this.showReview(); return; } const state = this.currentState(); this.cursor = state.cursor; this.inputMode = undefined; this.ctx.ui.setEditorText(""); this.renderNow(); }
  private showReview(): void { this.reviewing = true; this.inputMode = undefined; this.ctx.ui.setEditorText(""); this.renderNow(); }
  /** Esc-from-review lands here: first unanswered question, else the last one. */
  private firstIncompleteIndex(): number {
    const firstUnanswered = this.questions.findIndex((_question, index) => !this.answers.has(index));
    return firstUnanswered >= 0 ? firstUnanswered : this.questions.length - 1;
  }
  private settle(): void { if (this.settled) return; this.settled = true; this.ctx.ui.setEditorText(this.originalEditorText); this.ctx.ui.setWidget(WIDGET_KEY, undefined); this.done({ answers: [...this.answers.values()].sort((a, b) => a.index - b.index) }); }
  private renderNow(): void { this.tui?.requestRender(); }
}

export async function askInComposer(ctx: ExtensionContext, questions: AskQuestion[], signal: AbortSignal | undefined, onDictate?: () => void): Promise<AskComposerResult> {
  const originalText = ctx.ui.getEditorText(); let controller: AskComposer | undefined; let unsubscribeInput: (() => void) | undefined;
  // Transcripts must land in managed ask state, not loose in the editor.
  setDictationSink((text) => controller?.handleDictation(text));
  const result = new Promise<AskComposerResult>((resolve) => { ctx.ui.setWidget(WIDGET_KEY, (tui, theme) => { controller = new AskComposer(questions, ctx, theme, originalText, onDictate, resolve); controller.attach(tui); unsubscribeInput = ctx.ui.onTerminalInput((data) => controller!.handleInput(data)); return controller; }, { placement: "aboveEditor" }); });
  const abort = () => controller?.dismiss?.(); signal?.addEventListener("abort", abort, { once: true }); await result; signal?.removeEventListener("abort", abort); unsubscribeInput?.(); setDictationSink(undefined); return await result;
}
