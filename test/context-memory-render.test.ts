import assert from "node:assert/strict";
import { test } from "node:test";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import { renderMemoryCall, renderMemoryResult } from "../src/context-memory/render.ts";

const theme = {
  fg: (color: string, text: string) => `\x1b[${color === "success" ? "32" : color === "accent" ? "35" : "37"}m${text}\x1b[0m`,
  bold: (text: string) => `\x1b[1m${text}\x1b[0m`,
} as unknown as Theme;
const match = { entryId: "837445d8", kind: "user", timestamp: "2026-09-07T06:10:19.592Z",
  excerpt: "they are not using embeddings.\nnow lets build this out.\n\nwe dont want to overcomplicate things. share the newer design" };
const plain = (lines: string[]) => lines.map(stripTerminalSequences).join("\n");

test("search results show readable excerpts and expand without leaking JSON into the UI", () => {
  const output = JSON.stringify({ matches: Array.from({ length: 5 }, (_, i) => ({ ...match, entryId: `entry-${i}` })), nextBefore: "entry-4" });
  for (const width of [36, 80, 120]) {
    const call = renderMemoryCall({ action: "search", query: "overcomplicate things" }, theme).render(width);
    assert.match(plain(call), /Context memory/);
    const collapsed = renderMemoryResult(output, false, false, false, theme).render(width);
    const expanded = renderMemoryResult(output, true, false, false, theme).render(width);
    for (const line of [...call, ...collapsed, ...expanded]) assert.ok(visibleWidth(line) <= width, `overflow at ${width}: ${line}`);
    assert.match(plain(collapsed), /5 matches · current branch/);
    assert.match(plain(collapsed), /\+ 2 more matches/);
    assert.match(plain(expanded), /entry-4/);
    assert.match(plain(expanded), /2026-09-07/);
    assert.doesNotMatch(plain(collapsed), /"matches"|"entryId"|\\n/);
    assert.ok(expanded.length > collapsed.length);
  }
});

test("notes and reads have bounded previews, clear empty/save states, and complete expanded text", () => {
  const text = Array.from({ length: 20 }, (_, i) => `Decision ${i}: preserve evidence.`).join("\n");
  const notes = JSON.stringify({ text, maxCharacters: 6000 });
  const collapsed = plain(renderMemoryResult(notes, false, false, false, theme).render(80));
  assert.match(collapsed, /Working note/);
  assert.doesNotMatch(collapsed, /Decision 19/);
  assert.match(collapsed, /expand tool output/);
  assert.match(plain(renderMemoryResult(notes, true, false, false, theme).render(80)), /Decision 19/);
  const read = JSON.stringify({ ...match, text, nextOffset: 8000, previousEntryId: "before", nextEntryId: "after" });
  const expanded = plain(renderMemoryResult(read, true, false, false, theme).render(80));
  assert.match(expanded, /next read page/);
  assert.match(expanded, /← before/);
  assert.match(expanded, /after →/);
  for (const [data, expected] of [
    [{ saved: true, characters: 1260 }, /✓ Working note saved · 1,260 characters/],
    [{ saved: true, characters: 0 }, /Working note cleared/],
    [{ text: "", maxCharacters: 6000 }, /No working note yet/],
    [{ matches: [], nextBefore: null }, /No matching history/],
  ] as const) assert.match(plain(renderMemoryResult(JSON.stringify(data), false, false, false, theme).render(80)), expected);
});

test("list calls and results show bounded readable pages, cursors, and empty states", () => {
  const entries = Array.from({ length: 4 }, (_, i) => ({
    entryId: `list-entry-${i}`,
    kind: i === 0 ? "pi-bg-run-result" : "assistant",
    timestamp: `2026-09-0${7 - i}T06:10:19.592Z`,
    excerpt: i === 0 ? "safe preview\nwith an escaped control \x1b[2J" : `history excerpt ${i}`,
  }));
  const output = JSON.stringify({ entries, nextBefore: "list-entry-3" });
  const call = plain(renderMemoryCall({ action: "list", before: "list-entry-3" }, theme).render(36));
  assert.match(call, /Context memory · list history/);
  assert.match(call, /before list-entry-3/);
  const collapsed = plain(renderMemoryResult(output, false, false, false, theme).render(36));
  const expanded = plain(renderMemoryResult(output, true, false, false, theme).render(36));
  assert.match(collapsed, /4 entries · current branch/);
  assert.match(collapsed, /\+ 1 more entries/);
  assert.match(collapsed, /next\s+list page/);
  assert.match(expanded, /list-entry-3/);
  assert.match(expanded, /2026-09-04/);
  assert.doesNotMatch(expanded, /\x1b\[2J|\\u001b/);
  assert.match(plain(renderMemoryResult(JSON.stringify({ entries: [], nextBefore: null }), false, false, false, theme).render(36)), /No readable history/);
  for (const width of [20, 36, 80]) {
    for (const rendered of [renderMemoryCall({ action: "list", before: "cursor" }, theme), renderMemoryResult(output, false, false, false, theme), renderMemoryResult(output, true, false, false, theme)]) {
      for (const line of rendered.render(width)) assert.ok(visibleWidth(line) <= width, `overflow at ${width}: ${line}`);
    }
  }
});

test("expanded search results expose the original read offset", () => {
  const output = JSON.stringify({ matches: [{ ...match, readOffset: 240 }], nextBefore: null });
  const collapsed = plain(renderMemoryResult(output, false, false, false, theme).render(80));
  const expanded = plain(renderMemoryResult(output, true, false, false, theme).render(80));
  assert.doesNotMatch(collapsed, /read offset/);
  assert.match(expanded, /read offset 240/);
});

test("errors, partial calls and terminal control content render safely", () => {
  assert.match(plain(renderMemoryResult("Could not persist notes", false, false, true, theme).render(80)), /Could not persist notes/);
  assert.match(plain(renderMemoryResult("", false, true, false, theme).render(80)), /Working/);
  assert.match(plain(renderMemoryCall({}, theme).render(80)), /Context memory/);
  const malicious = "Visible\x1b[2J\x1b]0;injected title\x07\r\x00 text";
  const result = renderMemoryResult(JSON.stringify({ text: malicious }), true, false, false, theme).render(80).join("\n");
  assert.doesNotMatch(result, /\x1b\[2J|injected title|\x00|\r/);
  assert.match(stripTerminalSequences(result), /Visible text/);
});

test("reference-based calls and off-branch results are visibly distinguished", () => {
  assert.match(plain(renderMemoryCall({ action: "edit", ref: "notes", edits: [] }, theme).render(80)), /edit note/);
  assert.match(plain(renderMemoryCall({ action: "read", ref: "history-ref" }, theme).render(80)), /history-ref/);
  const result = { matches: [{ ...match, entryId: undefined, ref: "discarded-ref", offBranch: true }], scope: "session", nextBefore: null };
  for (const expanded of [false, true]) {
    const output = plain(renderMemoryResult(JSON.stringify(result), expanded, false, false, theme).render(80));
    assert.match(output, /all branches/);
    assert.match(output, /discarded-ref ·.*off-branch/);
  }
  assert.match(plain(renderMemoryResult(JSON.stringify({ ref: "notes", text: "Keep evidence" }), false, false, false, theme).render(80)), /Working note/);
  const read = { ref: "discarded-ref", text: "Discarded idea", offBranch: true, previousRef: "ancestor", kind: "user" };
  const output = plain(renderMemoryResult(JSON.stringify(read), true, false, false, theme).render(80));
  assert.match(output, /off-branch/);
  assert.match(output, /← ancestor/);
});
