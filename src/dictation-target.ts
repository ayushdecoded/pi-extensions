/**
 * Where dictated (transcribed) text lands. While a modal component such as the
 * ask panel owns keyboard focus, extension shortcuts wired to the default
 * editor cannot fire and pasteToEditor() would target a hidden editor — so the
 * focused component registers a sink here and triggers dictation itself.
 */
export type DictationSink = (text: string) => void;

let sink: DictationSink | undefined;

export function setDictationSink(next: DictationSink | undefined): void {
  sink = next;
}

export function getDictationSink(): DictationSink | undefined {
  return sink;
}

/** Paste dictated text into the active sink, or the prompt editor as a fallback. */
export function pasteDictated(ctx: { ui: { pasteToEditor(text: string): void } }, text: string): void {
  const target = sink;
  if (target) target(text);
  else ctx.ui.pasteToEditor(text);
}
