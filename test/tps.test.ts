import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionAPI, ExtensionContext, KeybindingsManager } from "@earendil-works/pi-coding-agent";
import type { EditorTheme, TUI } from "@earendil-works/pi-tui";
import tpsExtension, { CHARS_PER_TOKEN, TpsEditor, WARMUP_MS, formatTps } from "../src/tps.ts";

type Handler = (event: any, ctx: ExtensionContext) => void;
type EditorFactory = (tui: TUI, theme: EditorTheme, keybindings: KeybindingsManager) => TpsEditor;

const start = { message: { role: "assistant" } };
const end = (output: number) => ({ message: { role: "assistant", usage: { output } } });
const delta = (type: string, text: string) => ({ message: { role: "assistant" }, assistantMessageEvent: { type, delta: text } });

function harness(mode = "tui") {
  const handlers = new Map<string, Handler>();
  let editor: TpsEditor | undefined;
  const tui = { requestRender: () => {}, terminal: { rows: 24 } } as unknown as TUI;
  const theme = { borderColor: (text: string) => text, selectList: {} } as unknown as EditorTheme;
  const pi = {
    on: (name: string, handler: Handler) => {
      handlers.set(name, handler);
      return () => {};
    },
  } as unknown as ExtensionAPI;
  tpsExtension(pi);
  const ctx = {
    mode,
    ui: {
      setEditorComponent: (factory: EditorFactory) => { editor = factory(tui, theme, {} as KeybindingsManager); },
    },
  } as unknown as ExtensionContext;
  return {
    emit: (name: string, event: Record<string, unknown> = {}) => handlers.get(name)!(event, ctx),
    editor: () => editor,
    top: (width = 40) => editor!.render(width)[0],
  };
}

/** Pin Date.now so the rate is deterministic without sleeping. */
function clock<T>(from: number, run: (setNow: (value: number) => void) => T): T {
  const real = Date.now;
  let now = from;
  Date.now = () => now;
  try {
    return run((value) => { now = value; });
  } finally {
    Date.now = real;
  }
}

test("formatTps rejects empty or zero-length samples", () => {
  assert.equal(formatTps(0, 1000), undefined);
  assert.equal(formatTps(10, 0), undefined);
  assert.equal(formatTps(10, -5), undefined);
  assert.equal(formatTps(100, 1000), "100 tok/s");
  assert.equal(formatTps(1573, 10_000), "157 tok/s", "rounded to a whole number");
});

test("live estimate renders right on the border, then persists as the exact value", () => {
  clock(1_000, setNow => {
    const h = harness();
    h.emit("session_start");
    assert.ok(h.editor() instanceof TpsEditor);
    h.emit("message_start", start);

    setNow(1_500);
    h.emit("message_update", delta("text_delta", "x".repeat(4 * 100)));
    assert.equal(h.top(), "─".repeat(27) + " 200 tok/s ──", "100 estimated tokens over 0.5s");
    assert.equal(h.top().includes("⠋"), false, "no spinner in the readout");

    setNow(1_600);
    h.emit("message_end", end(90));
    assert.equal(h.top(), "─".repeat(27) + " 150 tok/s ──", "exact output over the whole stream");

    // The exact reading stays put for later unrelated events.
    h.emit("message_start", { message: { role: "user" } });
    assert.equal(h.top(), "─".repeat(27) + " 150 tok/s ──");
  });
});

test("warm-up suppresses the first samples", () => {
  clock(1_000, setNow => {
    const h = harness();
    h.emit("session_start");
    h.emit("message_start", start);
    setNow(1_000 + WARMUP_MS - 1);
    h.emit("message_update", delta("text_delta", "x".repeat(400)));
    assert.equal(h.top().includes("tok/s"), false);
  });
});

test("thinking and tool-call deltas count too", () => {
  clock(1_000, setNow => {
    const h = harness();
    h.emit("session_start");
    h.emit("message_start", start);
    setNow(2_000);
    h.emit("message_update", delta("thinking_delta", "x".repeat(200)));
    h.emit("message_update", delta("toolcall_delta", "x".repeat(400)));
    h.emit("message_update", delta("text_delta", "x".repeat(200)));
    assert.match(h.top(), /200 tok\/s/);
    assert.equal(CHARS_PER_TOKEN, 4);
  });
});

test("falls back to the streamed estimate when the provider reports no output", () => {
  clock(1_000, setNow => {
    const h = harness();
    h.emit("session_start");
    h.emit("message_start", start);
    setNow(1_500);
    h.emit("message_update", delta("text_delta", "x".repeat(400)));
    setNow(2_000);
    h.emit("message_end", end(0));
    assert.match(h.top(), /100 tok\/s/);
  });
});

test("retry and compaction notices keep the border instead of the rate", () => {
  clock(1_000, () => {
    const h = harness();
    h.emit("session_start");
    h.editor()!.setTps("50.0 tok/s");
    h.editor()!.setWorkingStatusIndicator({
      kind: "retry",
      renderInBorder: () => "Retrying in 3s",
      renderSpinnerInBorder: () => "!",
    } as never);
    assert.equal(h.top().includes("Retrying in 3s"), true);
    assert.equal(h.top().includes("tok/s"), false);
  });
});

test("non-TUI modes register no editor and never throw", () => {
  clock(1_000, setNow => {
    const h = harness("json");
    h.emit("session_start");
    assert.equal(h.editor(), undefined);
    h.emit("message_start", start);
    setNow(1_500);
    h.emit("message_update", delta("text_delta", "x".repeat(400)));
    h.emit("message_end", end(100));
  });
});
