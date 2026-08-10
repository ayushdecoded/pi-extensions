/**
 * Deterministic tests for the provider-first account switch panel
 * (`src/accounts/panel.ts`): pure projection/formatting helpers, stage
 * navigation and cancel semantics, and width-safe rendering.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import type { ExtensionContext, KeybindingsManager, Theme } from "@earendil-works/pi-coding-agent";
import type { TUI } from "@earendil-works/pi-tui";
import { KeybindingsManager as PiTuiKeybindingsManager, TUI_KEYBINDINGS, visibleWidth } from "@earendil-works/pi-tui";
import {
  AccountSwitchPanel,
  accountCountLabel,
  accountStatusTokens,
  formatResetTime,
  projectAccountRows,
  projectProviderRows,
  resetText,
  showAccountSwitch,
  type AccountSwitchProvider,
  type AccountSwitchResult,
} from "../src/accounts/panel.ts";

const NOW = new Date("2025-01-15T12:00:00Z");
const LOCALE = "en-US";
const TIME_ZONE = "UTC";

const ENTER = "\r";
const ESCAPE = "\x1b";
const UP = "\x1b[A";
const DOWN = "\x1b[B";
const CTRL_C = "\x03";

const codex: AccountSwitchProvider = {
  id: "openai-codex",
  label: "Codex",
  accounts: [
    { id: "default", name: "Default", selected: true, authenticated: true, exhausted: false, resetAt: "2025-01-15T14:30:00Z" },
    { id: "acct-2", name: "Secondary", selected: false, authenticated: false, exhausted: false },
    { id: "acct-3", name: "Tertiary", selected: false, authenticated: true, exhausted: true, resetAt: "2025-01-20T14:30:00Z" },
  ],
};

const opencode: AccountSwitchProvider = {
  id: "opencode-go",
  label: "OpenCode Go",
  accounts: [{ id: "default", name: "Default", selected: true, authenticated: true, exhausted: false }],
};

const providers = [codex, opencode];

const theme = { fg: (_color: string, text: string) => text } as unknown as Theme;
const tui = { terminal: { rows: 24 }, requestRender: () => {} } as unknown as TUI;
const keybindings = new PiTuiKeybindingsManager(TUI_KEYBINDINGS) as unknown as KeybindingsManager;

function makePanel(
  list: AccountSwitchProvider[],
  onResult: (result: AccountSwitchResult) => void,
): AccountSwitchPanel {
  return new AccountSwitchPanel(list, tui, theme, keybindings, onResult, {
    now: () => NOW,
    locale: LOCALE,
    timeZone: TIME_ZONE,
  });
}

function plain(value: string): string {
  return value.replace(/\x1b\[[0-9;]*m/g, "");
}

function renderText(panel: AccountSwitchPanel, width = 58): string {
  return panel.render(width).map(plain).join("\n");
}

test("formatResetTime formats same-day times and other-day dates in the injected timezone", () => {
  assert.equal(formatResetTime("2025-01-15T14:30:00Z", NOW, LOCALE, TIME_ZONE), "2:30 PM");
  assert.equal(formatResetTime("2025-01-20T14:30:00Z", NOW, LOCALE, TIME_ZONE), "Jan 20, 2:30 PM");
  assert.equal(formatResetTime("not-a-date", NOW, LOCALE, TIME_ZONE), "");
});

test("resetText only renders resets when resetAt exists and parses", () => {
  assert.equal(resetText(undefined, NOW, LOCALE, TIME_ZONE), "");
  assert.equal(resetText("2025-01-15T14:30:00Z", NOW, LOCALE, TIME_ZONE), "resets 2:30 PM");
  assert.equal(resetText("garbage", NOW, LOCALE, TIME_ZONE), "");
});

test("accountStatusTokens shows selected, login required, and exhausted exactly when they apply", () => {
  assert.deepEqual(accountStatusTokens({ selected: true, authenticated: true, exhausted: false }), ["selected"]);
  assert.deepEqual(accountStatusTokens({ selected: false, authenticated: false, exhausted: false }), ["login required"]);
  assert.deepEqual(accountStatusTokens({ selected: false, authenticated: true, exhausted: true }), ["exhausted"]);
  assert.deepEqual(accountStatusTokens({ selected: true, authenticated: false, exhausted: true }), ["selected", "login required", "exhausted"]);
  assert.deepEqual(accountStatusTokens({ selected: false, authenticated: true, exhausted: false }), []);
});

test("accountCountLabel pluralizes account counts", () => {
  assert.equal(accountCountLabel(1), "1 account");
  assert.equal(accountCountLabel(3), "3 accounts");
});

test("projectAccountRows preserves order and attaches statuses and reset text", () => {
  const rows = projectAccountRows(codex, NOW, LOCALE, TIME_ZONE);
  assert.deepEqual(
    rows.map((row) => [row.id, row.statuses, row.reset]),
    [
      ["default", ["selected"], "resets 2:30 PM"],
      ["acct-2", ["login required"], ""],
      ["acct-3", ["exhausted"], "resets Jan 20, 2:30 PM"],
    ],
  );
});

test("projectProviderRows reports account counts", () => {
  assert.deepEqual(projectProviderRows(providers), [
    { id: "openai-codex", label: "Codex", accountCount: 3, accountLabel: "3 accounts" },
    { id: "opencode-go", label: "OpenCode Go", accountCount: 1, accountLabel: "1 account" },
  ]);
});

test("provider stage lists providers; Enter opens the account stage with the selected account first", () => {
  const results: AccountSwitchResult[] = [];
  const panel = makePanel(providers, (value) => results.push(value));

  let output = renderText(panel);
  assert.match(output, /Switch account/);
  assert.match(output, /→ Codex/);
  assert.match(output, /OpenCode Go/);
  assert.match(output, /3 accounts/);
  assert.match(output, /1 account/);
  assert.doesNotMatch(output, /Add account/);

  panel.handleInput(ENTER);
  output = renderText(panel);
  assert.match(output, /accounts · Codex/);
  assert.match(output, /Add account/);
  assert.doesNotMatch(output, /OpenCode Go/);

  // Initial cursor sits on the selected account, so Enter picks it directly.
  panel.handleInput(ENTER);
  assert.deepEqual(results, [{ type: "select", provider: "openai-codex", accountId: "default" }]);
});

test("Enter on an account returns select with the provider and account id", () => {
  const results: AccountSwitchResult[] = [];
  const panel = makePanel(providers, (value) => results.push(value));

  panel.handleInput(ENTER); // Codex
  panel.handleInput(DOWN); // Secondary
  panel.handleInput(DOWN); // Tertiary
  panel.handleInput(ENTER);
  assert.deepEqual(results, [{ type: "select", provider: "openai-codex", accountId: "acct-3" }]);
});

test("Enter on + Add account returns the add action for the current provider", () => {
  const results: AccountSwitchResult[] = [];
  const panel = makePanel([codex], (value) => results.push(value));

  panel.handleInput(ENTER); // Codex
  panel.handleInput(UP); // wrap to the trailing add row
  panel.handleInput(ENTER);
  assert.deepEqual(results, [{ type: "add", provider: "openai-codex" }]);
});

test("Escape on the account stage returns to providers; Escape again cancels", () => {
  const results: AccountSwitchResult[] = [];
  const panel = makePanel(providers, (value) => results.push(value));

  panel.handleInput(ENTER); // Codex -> accounts
  assert.match(renderText(panel), /Add account/);

  panel.handleInput(ESCAPE); // back to providers
  const output = renderText(panel);
  assert.match(output, /OpenCode Go/);
  assert.doesNotMatch(output, /Add account/);
  assert.deepEqual(results, []);

  panel.handleInput(ESCAPE); // cancel
  assert.deepEqual(results, [undefined] as AccountSwitchResult[]);
});

test("Escape and ctrl+c cancel from the provider stage", () => {
  const results: AccountSwitchResult[] = [];
  const panel = makePanel(providers, (value) => results.push(value));
  panel.handleInput(CTRL_C);
  assert.deepEqual(results, [undefined] as AccountSwitchResult[]);

  const again = makePanel(providers, (value) => results.push(value));
  again.handleInput(ESCAPE);
  assert.deepEqual(results, [undefined, undefined] as AccountSwitchResult[]);
});

test("the initial account-stage cursor lands on the selected account, not index zero", () => {
  const results: AccountSwitchResult[] = [];
  const selectedSecond: AccountSwitchProvider = {
    id: "p",
    label: "P",
    accounts: [
      { id: "a", name: "A", selected: false, authenticated: true, exhausted: false },
      { id: "b", name: "B", selected: true, authenticated: true, exhausted: false },
    ],
  };
  const panel = makePanel([selectedSecond], (value) => results.push(value));
  panel.handleInput(ENTER);
  panel.handleInput(ENTER);
  assert.deepEqual(results, [{ type: "select", provider: "p", accountId: "b" }]);
});

test("account rows show selected/login required/exhausted and resets only when resetAt exists", () => {
  const panel = makePanel(providers, () => {});
  panel.handleInput(ENTER); // Codex accounts
  const output = renderText(panel);

  assert.match(output, /Default\s+selected · resets 2:30 PM/);
  assert.match(output, /Secondary\s+login required/);
  assert.match(output, /Tertiary\s+exhausted · resets Jan 20, 2:30 PM/);
  // The unauthenticated account has no resetAt, so no reset text appears on it.
  assert.doesNotMatch(output, /login required[^\n]*resets/);
  assert.doesNotMatch(output, /unavailable|cooling/i);

  // Accounts without resetAt never render a resets suffix.
  const noReset: AccountSwitchProvider = {
    id: "p",
    label: "P",
    accounts: [{ id: "a", name: "Plain", selected: true, authenticated: true, exhausted: false }],
  };
  const plainPanel = makePanel([noReset], () => {});
  plainPanel.handleInput(ENTER);
  assert.doesNotMatch(renderText(plainPanel), /resets/);
});

test("rendering is width-safe on narrow and wide terminals", () => {
  const panel = makePanel(providers, () => {});
  panel.handleInput(ENTER); // accounts stage with statuses
  for (const width of [20, 30, 40, 58, 80]) {
    const lines = panel.render(width);
    assert.ok(lines.length > 0);
    for (const line of lines) {
      assert.ok(visibleWidth(line) <= width, `line exceeds ${width}: ${JSON.stringify(plain(line))}`);
    }
  }
});

test("showAccountSwitch requires TUI mode and a non-empty provider list", async () => {
  const rpcCtx = { mode: "rpc" } as unknown as ExtensionContext;
  assert.equal(await showAccountSwitch(rpcCtx, providers), undefined);
  const tuiCtx = { mode: "tui" } as unknown as ExtensionContext;
  assert.equal(await showAccountSwitch(tuiCtx, []), undefined);
});
