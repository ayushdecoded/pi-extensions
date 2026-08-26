import assert from "node:assert/strict";
import { test } from "node:test";
import type { ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import type { TUI } from "@earendil-works/pi-tui";
import { AskComposer, type AskAnswer, type AskQuestion } from "../src/ask/composer.ts";

const theme = { fg: (_color: string, text: string) => text, bold: (text: string) => text } as unknown as Theme;
const tui = { requestRender() {} } as unknown as TUI;

function setup(question: AskQuestion, additional: AskQuestion[] = []) {
  let editor = "";
  const answers: AskAnswer[] = [];
  const widgets = new Map<string, unknown>();
  const pasted: string[] = [];
  const ctx = {
    ui: {
      getEditorText: () => editor,
      setEditorText: (text: string) => { editor = text; },
      pasteToEditor: (text: string) => { pasted.push(text); editor += text; },
      setWidget: (key: string, content: unknown) => widgets.set(key, content),
    },
  } as unknown as ExtensionContext;
  const composer = new AskComposer([question, ...additional], ctx, theme, "draft", undefined, (result) => answers.push(...result.answers));
  composer.attach(tui);
  return { composer, answers, getEditor: () => editor, setEditor: (text: string) => { editor = text; }, widgets, pasted };
}

test("composer picker selects a single option without opening a panel", () => {
  const { composer, answers } = setup({ question: "Database?", options: ["PostgreSQL", "SQLite"], multiple: false });
  composer.handleInput("\x1b[B");
  composer.handleInput("\r");
  assert.deepEqual(answers, []);
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
  assert.deepEqual(answers, []);
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
  assert.deepEqual(answers, []);
  composer.handleInput("\r");
  assert.deepEqual(answers, [{ index: 0, selected: ["eslint"], notes: { eslint: "must run first" } }]);
});

test("arrow navigation preserves answers and reviews skipped questions", () => {
  const { composer, answers } = setup(
    { question: "First?", options: ["a", "b"], multiple: false },
    [{ question: "Second?", options: ["c", "d"], multiple: false }],
  );
  composer.handleInput("\r");
  composer.handleInput("\x1b[C");
  composer.handleInput("\x1b[D");
  composer.handleInput("\x1b[C");
  composer.handleInput("\x1b[C");
  assert.deepEqual(answers, []);
  composer.handleInput("\r");
  assert.deepEqual(answers, []);
  composer.handleInput("\r");
  assert.deepEqual(answers, [{ index: 0, selected: ["a"], notes: {} }]);
});

test("review confirms before submitting unanswered questions", () => {
  const { composer, answers } = setup({ question: "First?", options: ["a", "b"], multiple: false }, [{ question: "Second?", options: ["c", "d"], multiple: false }]);
  composer.handleInput("\r");
  composer.handleInput("\x1b[C");
  composer.handleInput("\r");
  assert.deepEqual(answers, []);
  composer.handleInput("\x1b");
  composer.handleInput("\r");
  composer.handleInput("\r");
  assert.deepEqual(answers, [{ index: 0, selected: ["a"], notes: {} }, { index: 1, selected: ["c"], notes: {} }]);
});

test("escape on review returns to the questions instead of submitting; ctrl+c closes", () => {
  const { composer, answers } = setup(
    { question: "First?", options: ["a", "b"], multiple: false },
    [{ question: "Second?", options: ["c", "d"], multiple: false }],
  );
  composer.handleInput("\r"); // answer Q1
  composer.handleInput("\x1b[C"); // to review, all answered
  composer.handleInput("\x1b"); // esc must NOT submit
  assert.deepEqual(answers, []);
  composer.handleInput("2"); // change Q2 to "d", advances to review
  composer.handleInput("\x1b"); // esc again -> back to last question
  composer.handleInput("\x1b[D"); // arrow back to Q1
  composer.handleInput("2"); // change Q1 to "b", advances to review
  composer.handleInput("\x03"); // ctrl+c closes with final answers
  assert.deepEqual(answers, [{ index: 0, selected: ["b"], notes: {} }, { index: 1, selected: ["d"], notes: {} }]);
});

test("dictation hotkey is consumed by composer ask mode", () => {
  let started = 0;
  const { composer } = setup({ question: "Q?", options: ["a", "b"], multiple: false });
  const dictating = new AskComposer([{ question: "Q?", options: ["a", "b"], multiple: false }], {} as ExtensionContext, theme, "", () => { started += 1; }, () => {});
  dictating.handleInput("\x1b[114;6u");
  assert.equal(started, 1);
  assert.equal(composer.handleInput("x").consume, true);
});

test("typed single answer survives navigating away and back", () => {
  const { composer, getEditor, setEditor } = setup(
    { question: "Name?", options: ["a", "b"], multiple: false },
    [{ question: "Color?", options: ["red", "blue"], multiple: false }],
  );
  composer.handleInput("\t");
  composer.handleInput("\r");
  setEditor("my custom answer");
  composer.handleInput("\r"); // saves and advances
  composer.handleInput("\x1b[D"); // back to question 1
  const rendered = composer.render(100).join("\n");
  assert.match(rendered, /my custom answer/);
  assert.match(rendered, /✓ saved/);
  // re-editing prefills the previous text instead of starting blank
  composer.handleInput("\t");
  composer.handleInput("\r");
  assert.equal(getEditor(), "my custom answer");
});

test("picking an option after a typed answer replaces it", () => {
  const { composer, answers, setEditor } = setup(
    { question: "Name?", options: ["a", "b"], multiple: false },
    [{ question: "Color?", options: ["red", "blue"], multiple: false }],
  );
  composer.handleInput("\t");
  composer.handleInput("\r");
  setEditor("typed first");
  composer.handleInput("\r"); // commits typed answer, advances
  composer.handleInput("\x1b[D"); // back to question 1
  composer.handleInput("1"); // pick option "a" instead -> replaces typed answer, advances
  composer.handleInput("\r"); // pick "red"
  composer.handleInput("\r"); // submit review
  assert.deepEqual(answers, [
    { index: 0, selected: ["a"], notes: {} },
    { index: 1, selected: ["red"], notes: {} },
  ]);
});

test("dictation while idle seeds a fresh custom answer field", () => {
  const { composer, setEditor } = setup({ question: "Q?", options: ["a", "b"], multiple: false }, [{ question: "Q2?", options: ["c", "d"], multiple: false }]);
  // Simulate a transcript landing while the option picker is showing.
  composer.handleDictation("dictated reply");
  assert.match(composer.render(100).join("\n"), /Editing/);
  // Navigation must no longer be able to wipe it.
  composer.handleInput("\r"); // commit dictated answer, advance
  composer.handleInput("\x1b[D"); // back to question 1
  assert.match(composer.render(100).join("\n"), /dictated reply/);
  void setEditor;
});

test("dictation while editing appends at the cursor via pasteToEditor", () => {
  const { composer, pasted, setEditor } = setup({ question: "Q?", options: ["a", "b"], multiple: false });
  composer.handleInput("\t");
  composer.handleInput("\r"); // begin custom input
  setEditor("partial ");
  composer.handleDictation("and more");
  assert.deepEqual(pasted, ["and more"]);
});
