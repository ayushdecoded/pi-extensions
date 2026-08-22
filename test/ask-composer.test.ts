import assert from "node:assert/strict";
import { test } from "node:test";
import type { ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import type { TUI } from "@earendil-works/pi-tui";
import { AskComposer, type AskAnswer, type AskQuestion } from "../src/ask/composer.ts";

const theme = { fg: (_color: string, text: string) => text } as unknown as Theme;
const tui = { requestRender() {} } as unknown as TUI;

function setup(question: AskQuestion) {
  let editor = "";
  const answers: AskAnswer[] = [];
  const widgets = new Map<string, unknown>();
  const ctx = {
    ui: {
      getEditorText: () => editor,
      setEditorText: (text: string) => { editor = text; },
      setWidget: (key: string, content: unknown) => widgets.set(key, content),
    },
  } as unknown as ExtensionContext;
  const composer = new AskComposer([question], ctx, theme, "draft", undefined, (result) => answers.push(...result.answers));
  composer.attach(tui);
  return { composer, answers, getEditor: () => editor, setEditor: (text: string) => { editor = text; }, widgets };
}

test("composer picker selects a single option without opening a panel", () => {
  const { composer, answers } = setup({ question: "Database?", options: ["PostgreSQL", "SQLite"], multiple: false });
  composer.handleInput("\x1b[B");
  composer.handleInput("\r");
  assert.deepEqual(answers, [{ index: 0, selected: ["SQLite"], notes: {} }]);
});

test("custom answer uses the real composer editor", () => {
  const { composer, answers, getEditor, setEditor } = setup({ question: "Notes?", options: ["none", "many"], multiple: false });
  composer.handleInput("\t");
  composer.handleInput("\r");
  assert.equal(getEditor(), "");
  setEditor("typed in composer");
  assert.equal(getEditor(), "typed in composer");
  composer.handleInput("\r");
  assert.deepEqual(answers, [{ index: 0, selected: ["typed in composer"], notes: {} }]);
  assert.equal(getEditor(), "draft");
});

test("multi-select and shift-enter note stay in composer flow", () => {
  const { composer, answers, getEditor, setEditor } = setup({ question: "Tools?", options: ["eslint", "prettier"], multiple: true });
  composer.handleInput(" ");
  composer.handleInput("\n");
  setEditor("must run first");
  assert.equal(getEditor(), "must run first");
  composer.handleInput("\r");
  composer.handleInput("\r");
  assert.deepEqual(answers, [{ index: 0, selected: ["eslint"], notes: { eslint: "must run first" } }]);
});

test("dictation hotkey is consumed by composer ask mode", () => {
  let started = 0;
  const { composer } = setup({ question: "Q?", options: ["a", "b"], multiple: false });
  const dictating = new AskComposer([{ question: "Q?", options: ["a", "b"], multiple: false }], {} as ExtensionContext, theme, "", () => { started += 1; }, () => {});
  dictating.handleInput("\x1b[114;6u");
  assert.equal(started, 1);
  assert.equal(composer.handleInput("x").consume, true);
});
