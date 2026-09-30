import assert from "node:assert/strict";
import test from "node:test";
import {
  type ExtensionAPI,
  type ExtensionContext,
  type KeybindingsManager,
  type ReadonlyFooterDataProvider,
  type SessionEntry,
  type Theme,
} from "@earendil-works/pi-coding-agent";
import {
  KeybindingsManager as TuiKeybindingsManager,
  setKeybindings,
  stripTerminalSequences,
  TUI_KEYBINDINGS,
  visibleWidth,
  type EditorTheme,
  type TUI,
} from "@earendil-works/pi-tui";
import composerExtension, {
  buildFooterRight,
  ComposerEditor,
  createComposerFooter,
  formatCacheHitRate,
  formatContextLabel,
  formatCwdForFooter,
  formatTokens,
  insertBorderLabel,
  isUsingSubscription,
  layoutFooterLine,
  selectFooterRight,
  summarizeEntries,
} from "../src/composer.ts";

// A stateless theme keeps width assertions independent of terminal color probing.
const theme = {
  fg: (_color: string, text: string) => text,
  bold: (text: string) => text,
} as Theme;

const editorTheme = {
  borderColor: (text: string) => text,
  selectList: {
    selectedPrefix: (text: string) => text,
    selectedText: (text: string) => text,
    description: (text: string) => text,
    scrollInfo: (text: string) => text,
    noMatch: (text: string) => text,
  },
} as unknown as EditorTheme;

const tui = { terminal: { rows: 24 }, requestRender() {} } as unknown as TUI;

function makeUsage(input: number, output: number, cacheRead: number, cacheWrite: number, total: number) {
  return {
    input,
    output,
    cacheRead,
    cacheWrite,
    totalTokens: input + output + cacheRead + cacheWrite,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total },
  };
}

let entryId = 0;
function entry(extra: Record<string, unknown>): SessionEntry {
  entryId += 1;
  return { id: `e${entryId}`, parentId: null, timestamp: "2025-01-01T00:00:00.000Z", ...extra } as unknown as SessionEntry;
}

function assistant(usage: ReturnType<typeof makeUsage>): SessionEntry {
  return entry({ type: "message", message: { role: "assistant", usage } });
}

function toolResult(usage: ReturnType<typeof makeUsage>): SessionEntry {
  return entry({ type: "message", message: { role: "toolResult", usage } });
}

function fakeContext(overrides: Record<string, unknown> = {}): ExtensionContext {
  return {
    cwd: "/srv/app",
    model: undefined,
    thinkingLevel: undefined,
    sessionManager: {
      getSessionId: () => "session",
      getLeafId: () => "leaf",
      getCwd: () => "/srv/app",
      getEntries: () => [],
    },
    modelRegistry: { getProvider: () => undefined, isUsingOAuth: () => false },
    ui: { theme },
    ...overrides,
  } as unknown as ExtensionContext;
}

function fakeFooterData(overrides: Partial<ReadonlyFooterDataProvider> = {}): ReadonlyFooterDataProvider {
  return {
    getGitBranch: () => "main",
    getExtensionStatuses: () => new Map(),
    getAvailableProviderCount: () => 1,
    onBranchChange: () => () => {},
    ...overrides,
  } as ReadonlyFooterDataProvider;
}

test("summarizeEntries counts every usage-bearing entry exactly once", () => {
  const entries: SessionEntry[] = [
    entry({ type: "usage", kind: "cache_warm", provider: "anthropic", model: "claude", usage: makeUsage(1, 2, 3, 4, 0.5) }),
    assistant(makeUsage(100, 10, 900, 0, 1)),
    toolResult(makeUsage(5, 6, 7, 8, 0.25)),
    entry({ type: "compaction", summary: "", firstKeptEntryId: "x", tokensBefore: 0, usage: makeUsage(9, 10, 11, 12, 0.125) }),
    entry({ type: "branch_summary", fromId: "x", summary: "", usage: makeUsage(13, 14, 15, 16, 0.0625) }),
    entry({ type: "custom", customType: "note", data: { any: true } }),
  ];
  const { totals, latestCacheHitRate } = summarizeEntries(entries);
  assert.deepEqual(totals, {
    input: 1 + 100 + 5 + 9 + 13,
    output: 2 + 10 + 6 + 10 + 14,
    cacheRead: 3 + 900 + 7 + 11 + 15,
    cacheWrite: 4 + 0 + 8 + 12 + 16,
    cost: 0.5 + 1 + 0.25 + 0.125 + 0.0625,
  });
  assert.equal(latestCacheHitRate, (900 / 1000) * 100);
});

test("summarizeEntries uses the latest assistant prompt and handles empty prompts", () => {
  const empty = assistant(makeUsage(0, 0, 0, 0, 0.1)); // zero prompt tokens -> undefined
  const first = assistant(makeUsage(100, 0, 0, 0, 0.1)); // 0%
  const second = assistant(makeUsage(1, 0, 1, 0, 0.2)); // 50%
  const third = assistant(makeUsage(1, 0, 3, 0, 0.3)); // 75%
  // A usage entry after the latest assistant must not clobber the rate.
  const trailing = entry({ type: "usage", kind: "cache_warm", provider: "anthropic", model: "claude", usage: makeUsage(0, 0, 0, 0, 0.4) });
  assert.equal(summarizeEntries([first, second]).latestCacheHitRate, 50);
  assert.equal(summarizeEntries([empty]).latestCacheHitRate, undefined);
  assert.equal(summarizeEntries([first, second, third, trailing]).latestCacheHitRate, 75);
});

test("formatTokens matches the native footer boundaries", () => {
  assert.equal(formatTokens(0), "0");
  assert.equal(formatTokens(999), "999");
  assert.equal(formatTokens(1000), "1.0k");
  assert.equal(formatTokens(9999), "10.0k");
  assert.equal(formatTokens(10000), "10k");
  assert.equal(formatTokens(272000), "272k");
  assert.equal(formatTokens(1250000), "1.3M");
});

test("formatCwdForFooter hides only the home prefix", () => {
  assert.equal(formatCwdForFooter("/home/me/projects/app", "/home/me"), `~${"/projects/app"}`);
  assert.equal(formatCwdForFooter("/home/me", "/home/me"), "~");
  assert.equal(formatCwdForFooter("/srv/app", "/home/me"), "/srv/app");
  assert.equal(formatCwdForFooter("/home/other/app", "/home/me"), "/home/other/app");
  assert.equal(formatCwdForFooter("/srv/app", undefined), "/srv/app");
});

test("formatContextLabel mirrors the native context window display", () => {
  assert.equal(formatContextLabel({ percent: 16.4, contextWindow: 272000 }, undefined), "16%/272k");
  assert.equal(formatContextLabel({ percent: null, contextWindow: 272000 }, undefined), "?/272k");
  assert.equal(formatContextLabel(undefined, 272000), "0%/272k");
  assert.equal(formatContextLabel(undefined, undefined), undefined);
  assert.equal(formatContextLabel({ percent: 12, contextWindow: 0 }, undefined), undefined);
});

test("formatCacheHitRate renders and omits the CH label", () => {
  assert.equal(formatCacheHitRate(98.83), "CH98.8%");
  assert.equal(formatCacheHitRate(0), "CH0.0%");
  assert.equal(formatCacheHitRate(undefined), undefined);
});

test("isUsingSubscription keeps the kimi-coding special case and OAuth subscription rule", () => {
  const model = { provider: "anthropic" } as ExtensionContext["model"];
  const kimi = { provider: "kimi-coding" } as ExtensionContext["model"];
  const subscribing = {
    getProvider: () => ({ auth: { oauth: { isSubscription: true } } }),
    isUsingOAuth: () => true,
  } as unknown as Parameters<typeof isUsingSubscription>[1];
  const oauthOnly = {
    getProvider: () => ({ auth: { oauth: { isSubscription: true } } }),
    isUsingOAuth: () => false,
  } as unknown as Parameters<typeof isUsingSubscription>[1];
  const keyProvider = {
    getProvider: () => ({ auth: { apiKey: {} } }),
    isUsingOAuth: () => true,
  } as unknown as Parameters<typeof isUsingSubscription>[1];

  assert.equal(isUsingSubscription(kimi, keyProvider), true);
  assert.equal(isUsingSubscription(model, subscribing), true);
  assert.equal(isUsingSubscription(model, oauthOnly), false);
  assert.equal(isUsingSubscription(model, keyProvider), false);
  assert.equal(isUsingSubscription(undefined, subscribing), false);
});

test("layoutFooterLine keeps left stats and drops or truncates the right side first", () => {
  const left = "proj (main) CH98.8% $53.422 (sub)";
  const right = "(anthropic) claude • high";

  const wide = layoutFooterLine(left, right, 120);
  assert.equal(visibleWidth(wide), 120);
  assert.ok(wide.startsWith(left), wide);
  assert.ok(wide.endsWith(right), wide);

  const medium = layoutFooterLine(left, right, 48);
  assert.ok(visibleWidth(medium) <= 48, medium);
  assert.ok(stripTerminalSequences(medium).startsWith(left), medium);
  assert.notEqual(stripTerminalSequences(medium).slice(left.length + 2), right);

  const cramped = layoutFooterLine(left, right, left.length + 1);
  assert.equal(stripTerminalSequences(cramped), left);
  assert.equal(layoutFooterLine(left, right, left.length + 5), left, "hide tiny model-name fragments");

  const tiny = layoutFooterLine(left, right, 10);
  assert.ok(visibleWidth(tiny) <= 10, tiny);
  assert.ok(stripTerminalSequences(tiny).endsWith("..."), tiny);

  assert.equal(layoutFooterLine(left, "", 40), left);
  assert.equal(layoutFooterLine(left, right, 0), "");
});

test("selectFooterRight drops the provider prefix before the model name", () => {
  const bare = "claude • high";
  const withProvider = selectFooterRight(20, 120, bare, "(anthropic)");
  assert.equal(withProvider, "(anthropic) claude • high");
  assert.equal(selectFooterRight(20, 30, bare, "(anthropic)"), bare);
  assert.equal(selectFooterRight(20, 120, bare, undefined), bare);
});

test("buildFooterRight adds thinking only for reasoning models", () => {
  const model = { id: "claude", provider: "anthropic", reasoning: true } as ExtensionContext["model"];
  const plain = { id: "haiku", provider: "anthropic", reasoning: false } as ExtensionContext["model"];
  assert.deepEqual(buildFooterRight(model, "high", 2), { bare: "claude • high", providerPrefix: "(anthropic)" });
  assert.deepEqual(buildFooterRight(model, "off", 1), { bare: "claude • thinking off", providerPrefix: undefined });
  assert.deepEqual(buildFooterRight(plain, "high", 1), { bare: "haiku", providerPrefix: undefined });
  assert.deepEqual(buildFooterRight(undefined, undefined, 1), { bare: "no-model", providerPrefix: undefined });
});

test("insertBorderLabel adds context to the border tail and preserves the native working text", () => {
  const plainBorder = "─".repeat(20);
  const inserted = insertBorderLabel(plainBorder, "── 16%/272k ──", 20);
  assert.equal(visibleWidth(inserted), 20);
  assert.ok(inserted.includes("16%/272k"), inserted);

  const working = "── ⠋ working " + "─".repeat(40 - visibleWidth("── ⠋ working "));
  const withWorking = insertBorderLabel(working, "── 16%/272k ──", 40);
  assert.equal(visibleWidth(withWorking), 40);
  assert.ok(withWorking.includes("working"), withWorking);
  assert.ok(withWorking.includes("16%/272k"), withWorking);
  assert.ok(withWorking.startsWith("── ⠋ working "), withWorking);
});

test("insertBorderLabel leaves non-dash tails and too-narrow borders untouched", () => {
  const label = "── 16%/272k ──";
  const noTail = "── status text";
  assert.equal(insertBorderLabel(noTail, label, visibleWidth(noTail)), noTail);
  const narrow = "────";
  assert.equal(insertBorderLabel(narrow, label, 4), narrow);
  assert.equal(insertBorderLabel("", label, 0), "");
});

test("insertBorderLabel and layoutFooterLine stay width-safe with ANSI and wide unicode", () => {
  const red = (text: string) => `\x1b[31m${text}\x1b[0m`;
  const base = red("─".repeat(30));
  const segment = `${red("── ")}16%/272k${red(" ──")}`;
  const out = insertBorderLabel(base, segment, 30);
  assert.equal(visibleWidth(out), 30);
  assert.ok(out.includes("16%/272k"), out);

  const left = "~/프로젝트/日本語";
  const right = "claude • 思考 high";
  for (const width of [3, 12, 30, 60]) {
    const line = layoutFooterLine(left, right, width);
    assert.ok(visibleWidth(line) <= width, `${width}: ${line}`);
  }
});

function makeEditor(context: ExtensionContext): ComposerEditor {
  const keybindings = new TuiKeybindingsManager(TUI_KEYBINDINGS);
  setKeybindings(keybindings);
  return new ComposerEditor(tui, editorTheme, keybindings as unknown as KeybindingsManager, () => context);
}

function editorContext(usage: { percent: number | null; contextWindow: number } | undefined): ExtensionContext {
  return fakeContext({
    model: { id: "claude", provider: "anthropic", reasoning: true, contextWindow: 272000 },
    getContextUsage: () => usage,
  });
}

test("ComposerEditor renders context on the top border without erasing working status", () => {
  const editor = makeEditor(editorContext({ percent: 16.4, contextWindow: 272000 }));
  editor.setWorkingStatusIndicator({ renderInBorder: () => "⠋ working", renderSpinnerInBorder: () => "⠋" } as never);
  const lines = editor.render(40);
  assert.ok(lines[0]?.includes("working"), lines[0]);
  assert.ok(lines[0]?.includes("16%/272k"), lines[0]);
  for (const line of lines) assert.ok(visibleWidth(line) <= 40, line);
});

test("ComposerEditor preserves multiline editing, text input, and the native bottom border", () => {
  const editor = makeEditor(editorContext({ percent: 50, contextWindow: 272000 }));
  editor.setText("first line\nsecond line");
  const lines = editor.render(40);
  assert.equal(lines.length, 4, lines.join("\n"));
  assert.ok(lines[1]?.includes("first line"), lines[1]);
  assert.ok(lines[2]?.includes("second line"), lines[2]);
  assert.equal(lines[lines.length - 1], "─".repeat(40));

  const typing = makeEditor(editorContext(undefined));
  typing.handleInput("h");
  typing.handleInput("i");
  assert.equal(typing.getText(), "hi");
});

test("ComposerEditor keeps native autocomplete rendering", async () => {
  const editor = makeEditor(editorContext({ percent: 12, contextWindow: 272000 }));
  editor.setAutocompleteProvider({
    getSuggestions: async () => ({ items: [{ value: "alpha", label: "alpha" }, { value: "beta", label: "beta" }], prefix: "" }),
    applyCompletion: (lines, cursorLine, cursorCol) => ({ lines, cursorLine, cursorCol }),
    shouldTriggerFileCompletion: () => true,
  });
  editor.handleInput("\t");
  for (let i = 0; i < 5; i += 1) await new Promise((resolve) => setImmediate(resolve));
  const lines = editor.render(40);
  assert.ok(lines.some((line) => line.includes("alpha")), lines.join("\n"));
});

test("createComposerFooter caches the whole-session scan and reports native cost", () => {
  let scans = 0;
  const entries: SessionEntry[] = [
    assistant(makeUsage(100, 10, 900, 0, 1.5)),
    toolResult(makeUsage(5, 5, 0, 0, 0.25)),
  ];
  const ctx = fakeContext({
    model: { id: "claude", provider: "anthropic", reasoning: true, contextWindow: 272000 },
    thinkingLevel: "high",
    sessionManager: {
      getSessionId: () => "session",
      getLeafId: () => "leaf",
      getCwd: () => "/srv/app",
      getEntries: () => {
        scans += 1;
        return entries;
      },
    },
  });
  const footer = createComposerFooter(ctx, tui, theme, fakeFooterData({ getAvailableProviderCount: () => 2 }));
  const first = footer.render(120)[0] ?? "";
  const second = footer.render(120)[0] ?? "";
  assert.equal(scans, 1);
  assert.equal(first, second);
  assert.ok(first.startsWith("/srv/app (main) CH90.0% $1.750"), first);
  assert.ok(first.endsWith("(anthropic) claude • high"), first);
  footer.dispose();
});

test("createComposerFooter drops the right side before the left stats on narrow terminals", () => {
  const entries: SessionEntry[] = [assistant(makeUsage(100, 10, 900, 0, 1.5))];
  const ctx = fakeContext({
    model: { id: "claude", provider: "anthropic", reasoning: true, contextWindow: 272000 },
    sessionManager: {
      getSessionId: () => "session",
      getLeafId: () => "leaf",
      getCwd: () => "/srv/app",
      getEntries: () => entries,
    },
  });
  const footer = createComposerFooter(ctx, tui, theme, fakeFooterData({ getAvailableProviderCount: () => 2 }));
  for (const width of [1, 8, 16, 24, 40, 80]) {
    const line = footer.render(width)[0] ?? "";
    assert.ok(visibleWidth(line) <= width, `${width}: ${line}`);
  }
  const narrow = footer.render(30)[0] ?? "";
  assert.ok(narrow.includes("$1.500"), narrow);
  assert.ok(!narrow.includes("claude"), narrow);
});

test("createComposerFooter reports subscription cost and omits empty cache labels", () => {
  const ctx = fakeContext({
    model: { id: "claude", provider: "anthropic", reasoning: true, contextWindow: 272000 },
    sessionManager: {
      getSessionId: () => "session",
      getLeafId: () => "leaf",
      getCwd: () => "/srv/app",
      getEntries: () => [],
    },
    modelRegistry: {
      getProvider: () => ({ auth: { oauth: { isSubscription: true } } }),
      isUsingOAuth: () => true,
    },
  });
  const footer = createComposerFooter(ctx, tui, theme, fakeFooterData({ getAvailableProviderCount: () => 1 }));
  const line = footer.render(120)[0] ?? "";
  assert.ok(line.includes("$0.000 (sub)"), line);
  assert.ok(!line.includes("CH"), line);
  footer.dispose();
});

test("composerExtension installs the footer and editor on session_start and restores them on shutdown", () => {
  const handlers = new Map<string, (...args: unknown[]) => void>();
  const pi = {
    on: (event: string, handler: (...args: unknown[]) => void) => {
      handlers.set(event, handler);
      return () => handlers.delete(event);
    },
  } as unknown as ExtensionAPI;
  const calls: string[] = [];
  const ctx = fakeContext({
    mode: "tui",
    ui: {
      theme,
      setFooter: () => calls.push("footer"),
      setEditorComponent: () => calls.push("editor"),
    },
  });
  composerExtension(pi);
  handlers.get("session_start")?.({}, ctx);
  assert.deepEqual(calls, ["footer", "editor"]);
  handlers.get("session_shutdown")?.({}, ctx);
  assert.deepEqual(calls, ["footer", "editor", "footer", "editor"]);
});
