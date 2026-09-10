import assert from "node:assert/strict";
import { mkdtemp, rm, rename } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { SessionManager, type ExtensionAPI, type ExtensionContext, type ContextEvent,
  type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { compactionNotes, historyText, latestNotes, listHistory, MAX_NOTES_CHARS, NOTES_ENTRY_TYPE, readHistory,
  registerContextMemory, searchHistory, editNotes, type ContextMemoryAction } from "../src/context-memory/index.ts";

const usage = { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
function assistant(manager: SessionManager) {
  return manager.appendMessage({ role: "assistant", content: [{ type: "text", text: "Investigating." }],
    api: "openai-codex-responses", provider: "openai-codex", model: "fixture", stopReason: "stop", usage, timestamp: 1 });
}

function harness(manager: SessionManager) {
  // Extension API is the boundary under test; storage and branch behavior use the real SDK.
  let tool: ToolDefinition<ReturnType<typeof Type.Unknown>>;
  let context: (event: ContextEvent, ctx: ExtensionContext) => { messages: ContextEvent["messages"] } | void;
  const pi = {
    registerTool(value: typeof tool) { tool = value; },
    on(name: string, handler: typeof context) { if (name === "context") context = handler; },
    appendEntry(type: string, data: unknown) { manager.appendCustomEntry(type, data); },
  } as unknown as ExtensionAPI;
  registerContextMemory(pi);
  const ctx = { sessionManager: manager } as unknown as ExtensionContext;
  return {
    async call(args: ContextMemoryAction) {
      const result = await tool.execute("call", args, new AbortController().signal, undefined, ctx);
      assert.equal(result.content[0]?.type, "text");
      return result.content[0]?.type === "text" ? JSON.parse(result.content[0].text) : undefined;
    },
    context() { return context!({ type: "context", messages: manager.buildSessionContext().messages }, ctx)?.messages; },
  };
}

test("notes and original evidence survive compaction/reload, stay stable within a window, and follow branches", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-memory-"));
  try {
    const manager = SessionManager.create(dir, dir);
    const root = manager.appendMessage({ role: "user", content: "Diagnose authentication", timestamp: 1 });
    assistant(manager);
    const evidence = manager.appendMessage({ role: "toolResult", toolCallId: "test", toolName: "bash",
      content: [{ type: "text", text: "FAILED auth.test: expected 200, received 401" }], isError: false, timestamp: 2 });
    const h = harness(manager);
    await h.call({ action: "edit", ref: "notes", edits: [{ oldText: "", newText: `Cookie fix failed; see ${evidence}. Next: inspect token refresh.` }] });
    const branchPoint = manager.getLeafId()!;
    manager.appendCompaction("Investigating auth", root, 1000);
    const first = h.context();
    assert.match(JSON.stringify(first?.[0]), /Cookie fix failed/);
    await h.call({ action: "edit", ref: "notes", edits: [{ oldText: `Cookie fix failed; see ${evidence}. Next: inspect token refresh.`, newText: "Refresh fixed; verify expiry." }] });
    assert.deepEqual(h.context()?.[0], first?.[0], "note edits do not rewrite the window prefix");
    assert.equal((await h.call({ action: "read", ref: "notes" })).text, "Refresh fixed; verify expiry.");
    const found = await h.call({ action: "search", query: "RECEIVED 401" });
    assert.equal(found.matches[0].ref, evidence);
    assert.match((await h.call({ action: "read", ref: evidence })).text, /expected 200/);

    const reloaded = SessionManager.open(manager.getSessionFile()!, dir, dir);
    assert.deepEqual(harness(reloaded).context()?.[0], first?.[0]);
    assert.equal(latestNotes(reloaded.getBranch()), "Refresh fixed; verify expiry.");
    reloaded.branch(branchPoint);
    assert.match(latestNotes(reloaded.getBranch()), /Cookie fix failed/);
    assert.equal(compactionNotes(reloaded.getBranch()), undefined, "no future boundary leaks into an older branch");
    const alternate = harness(reloaded);
    await alternate.call({ action: "edit", ref: "notes", edits: [{ oldText: `Cookie fix failed; see ${evidence}. Next: inspect token refresh.`, newText: "Alternate: inspect proxy." }] });
    reloaded.appendCompaction("Alternate work", root, 1000);
    assert.match(JSON.stringify(alternate.context()?.[0]), /Alternate: inspect proxy/);
    assert.doesNotMatch(JSON.stringify(alternate.context()), /Refresh fixed/);
    await alternate.call({ action: "edit", ref: "notes", edits: [{ oldText: "Alternate: inspect proxy.", newText: "" }] });
    reloaded.appendCompaction("Cleared notes", root, 1000);
    assert.equal(compactionNotes(reloaded.getBranch()), undefined);
    assert.equal((await alternate.call({ action: "read", ref: "notes" })).text, "");
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("history is bounded, paginated, branch-local, and excludes reasoning and memory recursion", () => {
  const manager = SessionManager.inMemory();
  assert.deepEqual(listHistory(manager.getBranch()), { entries: [], nextBefore: null });
  const root = assistant(manager);
  const ids = Array.from({ length: 12 }, (_, i) => manager.appendMessage({ role: "user", content: `needle ${i}`, timestamp: i }));
  const first = searchHistory(manager.getBranch(), "NEEDLE");
  assert.equal(first.matches.length, 8);
  const second = searchHistory(manager.getBranch(), "needle", first.nextBefore!);
  assert.equal(second.matches.length, 4);
  assert.equal(new Set([...first.matches, ...second.matches].map((m) => m.ref)).size, 12);
  const lateText = "x".repeat(12_000) + "Late-needle target";
  const lateEntry = manager.appendMessage({ role: "user", content: lateText, timestamp: 1 });
  const lateMatch = searchHistory(manager.getBranch(), "LATE-NEEDLE").matches[0]!;
  assert.equal(lateMatch.ref, lateEntry);
  assert.equal(lateMatch.readOffset, 11_900);
  assert.match(readHistory(manager.getBranch(), lateEntry, lateMatch.readOffset).text, /Late-needle target/);

  const large = manager.appendMessage({ role: "user", content: "x".repeat(17_000), timestamp: 1 });
  let page = readHistory(manager.getBranch(), large);
  let text = page.text;
  while (page.nextOffset !== null) { page = readHistory(manager.getBranch(), large, page.nextOffset); text += page.text; }
  assert.equal(text.length, 17_000);
  assert.equal(page.previousRef, lateEntry);
  assert.equal(readHistory(manager.getBranch(), lateEntry).nextRef, large);
  assert.throws(() => readHistory(manager.getBranch(), large, -1));

  const listedPages = [];
  let before: string | undefined;
  do {
    const listed = listHistory(manager.getBranch(), before);
    listedPages.push(listed);
    before = listed.nextBefore ?? undefined;
  } while (before);
  assert.equal(listedPages[0]!.entries[0]!.ref, large);
  assert.equal(listedPages[0]!.entries[0]!.excerpt.length, 400);
  assert.deepEqual(listedPages.map((page) => page.entries.length), [8, 7]);
  assert.deepEqual(listedPages.flatMap((page) => page.entries.map((entry) => entry.ref)),
    [large, lateEntry, ...[...ids].reverse(), root]);

  const unicodeManager = SessionManager.inMemory();
  const unicodeEntry = unicodeManager.appendMessage({ role: "user",
    content: "x".repeat(200) + "İ" + "y".repeat(200) + "TARGET", timestamp: 1 });
  const unicodeMatch = searchHistory(unicodeManager.getBranch(), "TARGET").matches[0]!;
  assert.equal(unicodeMatch.readOffset, 301, "read offsets stay in original text coordinates after case folding");
  assert.match(readHistory(unicodeManager.getBranch(), unicodeEntry, unicodeMatch.readOffset).text, /TARGET/);

  manager.appendCustomEntry(NOTES_ENTRY_TYPE, { version: 1, text: "secret-note" });
  const internal = manager.appendMessage({ role: "toolResult", toolCallId: "memory", toolName: "context_memory",
    content: [{ type: "text", text: "secret retrieved evidence" }], isError: false, timestamp: 1 });
  assert.equal(historyText(manager.getEntry(internal)!), undefined);
  const reasoning = manager.appendMessage({ role: "assistant", content: [{ type: "thinking", thinking: "secret reasoning" }],
    api: "openai-codex-responses", provider: "openai-codex", model: "fixture", stopReason: "stop", usage, timestamp: 1 });
  assert.equal(historyText(manager.getEntry(reasoning)!), undefined);
  assert.equal(searchHistory(manager.getBranch(), "secret").matches.length, 0);
  const afterExcluded = listHistory(manager.getBranch());
  assert.ok(afterExcluded.entries.every((entry) => entry.ref !== internal && !entry.excerpt.includes("secret")));
  manager.branch(root);
  assert.deepEqual(listHistory(manager.getBranch()).entries.map((entry) => entry.ref), [root]);
  assert.equal(searchHistory(manager.getBranch(), "needle").matches.length, 0);
  assert.throws(() => readHistory(manager.getBranch(), large), /selected history|this session/);
  assert.throws(() => searchHistory(manager.getBranch(), "needle", ids[0]), /selected history|this session/);
  assert.throws(() => listHistory(manager.getBranch(), ids[0]), /selected history|this session/);
  assert.throws(() => listHistory(manager.getBranch(), "missing-entry"), /selected history|this session/);
  assert.deepEqual(listHistory(manager.getBranch(), root), { entries: [], nextBefore: null });
});

test("child session notes are independent, persist for follow-ups, and failed writes do not become working state", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-memory-child-"));
  try {
    const parent = SessionManager.create(dir, dir);
    assistant(parent);
    await harness(parent).call({ action: "edit", ref: "notes", edits: [{ oldText: "", newText: "Parent work" }] });
    const child = SessionManager.create(dir, dir, { parentSession: parent.getSessionFile() });
    assistant(child);
    const h = harness(child);
    assert.equal((await h.call({ action: "read", ref: "notes" })).text, "");
    await h.call({ action: "edit", ref: "notes", edits: [{ oldText: "", newText: "Child work" }] });
    assert.equal(latestNotes(parent.getBranch()), "Parent work");
    const resumed = SessionManager.open(child.getSessionFile()!, dir, dir);
    assert.equal((await harness(resumed).call({ action: "read", ref: "notes" })).text, "Child work");
    await assert.rejects(h.call({ action: "edit", ref: "notes", edits: [{ oldText: "", newText: "x".repeat(MAX_NOTES_CHARS + 1) }] }));
    const file = child.getSessionFile()!;
    // Existing path but not appendable as a file: exercises SDK's in-memory-before-disk failure.
    await rename(file, `${file}.saved`);
    const { mkdir } = await import("node:fs/promises");
    await mkdir(file);
    await assert.rejects(h.call({ action: "edit", ref: "notes", edits: [{ oldText: "", newText: "Must not become working state" }] }));
    assert.equal((await h.call({ action: "read", ref: "notes" })).text, "Child work");
    await assert.rejects(harness(SessionManager.inMemory()).call({ action: "edit", ref: "notes", edits: [{ oldText: "", newText: "Cannot persist" }] }), /persisted session/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("exact edits use original coordinates, reject ambiguous/overlapping matches, and enforce the final budget", () => {
  assert.equal(editNotes("goal\nnext", [
    { oldText: "next", newText: "goal" },
    { oldText: "goal", newText: "done" },
    { oldText: "", newText: "\nevidence" },
    { oldText: "", newText: ": entry" },
  ]), "done\ngoal\nevidence: entry");
  assert.equal(editNotes("a".repeat(MAX_NOTES_CHARS), [
    { oldText: "", newText: "b".repeat(MAX_NOTES_CHARS) },
    { oldText: "a".repeat(MAX_NOTES_CHARS), newText: "" },
  ]), "b".repeat(MAX_NOTES_CHARS), "budget applies to the final note, not intermediate edits");
  assert.throws(() => editNotes("aaaa", [{ oldText: "aaa", newText: "b" }]), /ambiguous/);
  assert.throws(() => editNotes("abcdef", [
    { oldText: "abc", newText: "" }, { oldText: "cde", newText: "" },
  ]), /overlap/);
  assert.throws(() => editNotes("abc", [
    { oldText: "abc", newText: "" }, { oldText: "abc", newText: "x" },
  ]), /overlap/);
  assert.throws(() => editNotes("abc", [{ oldText: "ABC", newText: "" }]), /not found/);
  assert.throws(() => editNotes("abc", []), /between 1 and 32/);
  assert.throws(() => editNotes("a".repeat(MAX_NOTES_CHARS), [{ oldText: "", newText: "b" }]), /must not exceed/);
});

test("tool searches all branches once, reads off-branch ancestry, and edits only the active note atomically", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-memory-edits-"));
  try {
    const manager = SessionManager.create(dir, dir);
    const root = manager.appendMessage({ role: "user", content: "needle shared", timestamp: 1 });
    assistant(manager);
    // Original on-disk format must remain readable without migrating history.
    manager.appendCustomEntry(NOTES_ENTRY_TYPE, { version: 1, text: "Goal: auth\nNext: cookies" });
    const fork = manager.getLeafId()!;
    const discarded = manager.appendMessage({ role: "user", content: "needle discarded", timestamp: 2 });
    const h = harness(manager);
    await h.call({ action: "edit", ref: "notes", edits: [{ oldText: "cookies", newText: "proxy" }] });
    const discardedNote = manager.getLeafId()!;
    manager.branch(fork);
    const current = manager.appendMessage({ role: "user", content: "needle current", timestamp: 3 });
    let page = await h.call({ action: "search", query: "needle" });
    assert.equal(page.scope, "session");
    assert.deepEqual(page.matches.map((match: { ref: string; offBranch: boolean }) => [match.ref, match.offBranch]), [
      [current, false], [discarded, true], [root, false],
    ]);
    const offBranch = await h.call({ action: "read", ref: discarded });
    assert.equal(offBranch.offBranch, true);
    assert.notEqual(offBranch.previousRef, current, "read ancestry never uses neighboring append-order branches");
    assert.equal(offBranch.nextRef, null, "an off-branch leaf cannot continue onto the active branch");
    assert.equal((await h.call({ action: "read", ref: offBranch.previousRef })).nextRef, null, "forks do not arbitrarily choose a continuation");
    assert.equal((await h.call({ action: "read", ref: root })).offBranch, false);
    assert.equal((await h.call({ action: "list" })).entries.some((entry: { ref: string }) => entry.ref === discarded), false);
    assert.equal((await h.call({ action: "read", ref: "notes" })).text, "Goal: auth\nNext: cookies");
    const before = manager.getLeafId();
    await assert.rejects(h.call({ action: "edit", ref: "notes", edits: [
      { oldText: "cookies", newText: "refresh" }, { oldText: "missing", newText: "bad" },
    ] }), /not found/);
    assert.equal(manager.getLeafId(), before, "failed batches never persist partial changes");
    await assert.rejects(h.call({ action: "edit", ref: discarded, edits: [{ oldText: "", newText: "bad" }] } as unknown as ContextMemoryAction), /immutable/);
    const saved = await h.call({ action: "edit", ref: "notes", edits: [
      { oldText: "Next: cookies", newText: "" }, { oldText: "", newText: "Next: refresh" },
    ] });
    assert.deepEqual(saved, { saved: true, characters: "Goal: auth\nNext: refresh".length });
    const reloaded = SessionManager.open(manager.getSessionFile()!, dir, dir);
    assert.equal(latestNotes(reloaded.getBranch()), "Goal: auth\nNext: refresh");
    reloaded.branch(discardedNote);
    assert.equal(latestNotes(reloaded.getBranch()), "Goal: auth\nNext: proxy");
    const child = SessionManager.create(dir, dir, { parentSession: manager.getSessionFile() });
    assert.equal((await harness(child).call({ action: "search", query: "needle" })).matches.length, 0);
    await assert.rejects(harness(child).call({ action: "read", ref: discarded }), /this session/);
    // Pagination can continue from an off-branch result without pulling the tree into context.
    page = await h.call({ action: "search", query: "needle", before: discarded });
    assert.deepEqual(page.matches.map((match: { ref: string }) => match.ref), [root]);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
