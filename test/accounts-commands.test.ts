/**
 * Behavioral tests for the `/account` command (`src/accounts/commands.ts`)
 * driven against a fake AccountController and ExtensionContext.
 *
 * No source file is edited. The TUI panel path is exercised through a mocked
 * `ui.custom` that builds the real AccountSwitchPanel from the projection
 * (capturing the projection the command produced), while headless/RPC paths
 * run the handler directly. Coverage: bare `/account` and `/account switch`
 * TUI flows, headless switch with provider aliases, unauthenticated selection
 * prefilling native `/login`, add prefilling `/login`, rename/remove/status,
 * native logout-guard error propagation, provider parsing, quoted names, and
 * argument completions.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import type {
  ExtensionAPI,
  ExtensionCommandContext,
  KeybindingsManager,
  RegisteredCommand,
  Theme,
} from "@earendil-works/pi-coding-agent";
import { createSyntheticSourceInfo } from "@earendil-works/pi-coding-agent";
import { KeybindingsManager as PiTuiKeybindingsManager, TUI_KEYBINDINGS, type TUI } from "@earendil-works/pi-tui";
import { registerAccountCommands } from "../src/accounts/commands.ts";
import type { AccountController } from "../src/accounts/controller.ts";
import type { AccountView } from "../src/accounts/coordinator.ts";
import { AccountSwitchPanel, PANEL_WIDTH, type AccountSwitchResult } from "../src/accounts/panel.ts";
import { providerIdForAccount as planProviderIdForAccount } from "../src/accounts/providers.ts";
import type { SupportedProviderId } from "../src/accounts/types.ts";

const ENTER = "\r";

type Notify = { message: string; type: "info" | "warning" | "error" };

// ---------------------------------------------------------------------------
// Fake AccountController
// ---------------------------------------------------------------------------

type AccountSeed = {
  id: string;
  name: string;
  selected?: boolean;
  exhausted?: boolean;
  resetAt?: string;
};

const DEFAULT_DATA: Record<SupportedProviderId, AccountSeed[]> = {
  "openai-codex": [
    { id: "default", name: "Default", selected: true },
    { id: "acct-secondary", name: "Secondary" },
    { id: "acct-tertiary", name: "Tertiary", exhausted: true, resetAt: "2025-02-01T12:00:00.000Z" },
  ],
  "opencode-go": [{ id: "default", name: "Default", selected: true }],
};

class FakeController {
  readonly authenticated = new Map<string, boolean>();
  readonly selectCalls: Array<{ provider: SupportedProviderId; accountId: string }> = [];
  readonly addCalls: Array<{ provider: SupportedProviderId; name: string }> = [];
  readonly renameCalls: Array<{ provider: SupportedProviderId; accountId: string; name: string }> = [];
  readonly removeCalls: Array<{ provider: SupportedProviderId; accountId: string }> = [];
  refreshCount = 0;
  private addSequence = 0;

  constructor(private readonly data: Record<SupportedProviderId, AccountSeed[]>) {}

  readonly coordinator = {
    accountByName: (provider: SupportedProviderId, nameOrId: string): AccountView | undefined => {
      const target = nameOrId.toLowerCase();
      return this.accounts(provider).find(
        (account) => account.id === nameOrId || account.name.toLowerCase() === target,
      );
    },
  };

  async refresh(): Promise<void> {
    this.refreshCount += 1;
  }

  providers(): readonly SupportedProviderId[] {
    return Object.keys(this.data) as SupportedProviderId[];
  }

  accounts(provider: SupportedProviderId): AccountView[] {
    return (this.data[provider] ?? []).map((seed) => ({
      id: seed.id,
      provider,
      name: seed.name,
      selected: seed.selected ?? false,
      exhausted: seed.exhausted ?? false,
      ...(seed.resetAt !== undefined ? { resetAt: seed.resetAt } : {}),
      createdAt: "2025-01-01T00:00:00.000Z",
      updatedAt: "2025-01-01T00:00:00.000Z",
      limits: [],
    }));
  }

  providerIdForAccount(provider: SupportedProviderId, accountId: string): string {
    return planProviderIdForAccount(provider, accountId);
  }

  isAuthenticated(_ctx: ExtensionCommandContext, provider: SupportedProviderId, accountId: string): Promise<boolean> {
    return Promise.resolve(this.authenticated.get(`${provider}|${accountId}`) ?? false);
  }

  async select(provider: SupportedProviderId, accountId: string, _ctx: ExtensionCommandContext): Promise<void> {
    this.selectCalls.push({ provider, accountId });
  }

  async add(provider: SupportedProviderId, name: string): Promise<{ accountId: string; providerId: string }> {
    this.addCalls.push({ provider, name });
    this.addSequence += 1;
    const accountId = `acct-${this.addSequence}`;
    return { accountId, providerId: this.providerIdForAccount(provider, accountId) };
  }

  async rename(provider: SupportedProviderId, accountId: string, name: string): Promise<void> {
    this.renameCalls.push({ provider, accountId, name });
  }

  async remove(provider: SupportedProviderId, accountId: string, _ctx: ExtensionCommandContext): Promise<void> {
    this.removeCalls.push({ provider, accountId });
  }
}

function defaultFake(): FakeController {
  const fake = new FakeController(DEFAULT_DATA);
  fake.authenticated.set("openai-codex|default", true);
  fake.authenticated.set("openai-codex|acct-secondary", true);
  fake.authenticated.set("opencode-go|default", true);
  return fake;
}

/** Fake where the codex secondary account is not logged in. */
function unauthenticatedSecondaryFake(): FakeController {
  const fake = new FakeController(DEFAULT_DATA);
  fake.authenticated.set("openai-codex|default", true);
  fake.authenticated.set("openai-codex|acct-tertiary", true);
  fake.authenticated.set("opencode-go|default", true);
  return fake;
}

/** Fake used by the status test: one unauthenticated and one exhausted row. */
function statusFake(): FakeController {
  return unauthenticatedSecondaryFake();
}

// ---------------------------------------------------------------------------
// Fake ExtensionContext
// ---------------------------------------------------------------------------

interface FakeUi {
  notifications: Notify[];
  editorText: string;
  notify(message: string, type?: "info" | "warning" | "error"): void;
  setEditorText(text: string): void;
  custom: (factory: unknown, options?: unknown) => Promise<unknown>;
  select: (title: string, options: string[]) => Promise<string | undefined>;
  input: (title: string, placeholder?: string) => Promise<string | undefined>;
  confirm: (title: string, message: string) => Promise<boolean>;
}

function makeCtx(opts: {
  mode?: "tui" | "rpc";
  /** Return value for ui.select; calls are always recorded. */
  selectResult?: string | undefined;
  /** Return value for ui.input; calls are always recorded. */
  inputResult?: string | undefined;
  /** Return value for ui.confirm; calls are always recorded. */
  confirmResult?: boolean;
  /** Full replacement for ui.custom (TUI panel path). */
  custom?: (factory: unknown, options?: unknown) => Promise<unknown>;
} = {}): {
  ctx: ExtensionCommandContext;
  notifications: Notify[];
  getEditorText(): string;
  confirmCalls: Array<{ title: string; message: string }>;
  selectCalls: Array<{ title: string; options: string[] }>;
  inputCalls: Array<{ title: string; placeholder?: string }>;
} {
  const notifications: Notify[] = [];
  const confirmCalls: Array<{ title: string; message: string }> = [];
  const selectCalls: Array<{ title: string; options: string[] }> = [];
  const inputCalls: Array<{ title: string; placeholder?: string }> = [];
  const ui: FakeUi = {
    notifications,
    editorText: "",
    notify: (message, type = "info") => notifications.push({ message, type }),
    setEditorText: (text) => {
      ui.editorText = text;
    },
    custom: opts.custom ?? (async () => undefined),
    select: async (title, options) => {
      selectCalls.push({ title, options });
      return opts.selectResult;
    },
    input: async (title, placeholder) => {
      inputCalls.push({ title, placeholder });
      return opts.inputResult;
    },
    confirm: async (title, message) => {
      confirmCalls.push({ title, message });
      return opts.confirmResult ?? false;
    },
  };
  const ctx = { mode: opts.mode ?? "tui", hasUI: true, ui } as unknown as ExtensionCommandContext;
  return { ctx, notifications, getEditorText: () => ui.editorText, confirmCalls, selectCalls, inputCalls };
}

// ---------------------------------------------------------------------------
// Registration + invocation helpers
// ---------------------------------------------------------------------------

function registerAccount(fake: FakeController): RegisteredCommand {
  let registered: RegisteredCommand | undefined;
  const pi = {
    registerCommand: (name: string, options: Omit<RegisteredCommand, "name" | "sourceInfo">) => {
      registered = { name, sourceInfo: createSyntheticSourceInfo("test/accounts-commands.test.ts", { source: "test" }), ...options };
    },
  } as unknown as ExtensionAPI;
  registerAccountCommands(pi, fake as unknown as AccountController);
  if (!registered) throw new Error("registerAccountCommands did not register /account");
  return registered;
}

async function invoke(registered: RegisteredCommand, args: string, ctx: ExtensionCommandContext): Promise<void> {
  await registered.handler(args, ctx);
}

function errorMessages(notifications: Notify[]): string[] {
  return notifications.filter((n) => n.type === "error").map((n) => n.message);
}

function infoMessages(notifications: Notify[]): string[] {
  return notifications.filter((n) => n.type === "info").map((n) => n.message);
}

// ---------------------------------------------------------------------------
// TUI panel stubs (mirrors test/accounts-panel.test.ts)
// ---------------------------------------------------------------------------

const themeStub = { fg: (_color: string, text: string) => text } as unknown as Theme;
const tuiStub = { terminal: { rows: 24 }, requestRender: () => {} } as unknown as TUI;
const keybindingsStub = new PiTuiKeybindingsManager(TUI_KEYBINDINGS) as unknown as KeybindingsManager;

function buildPanel(factory: unknown, onResult: (result: AccountSwitchResult) => void): AccountSwitchPanel {
  const fn = factory as (
    tui: TUI,
    theme: Theme,
    keybindings: KeybindingsManager,
    done: (result: AccountSwitchResult) => void,
  ) => unknown;
  return fn(tuiStub, themeStub, keybindingsStub, onResult) as AccountSwitchPanel;
}

function plain(value: string): string {
  return value.replace(/\x1b\[[0-9;]*m/g, "");
}

// ---------------------------------------------------------------------------
// Bare /account and /account switch TUI paths (mocked ui.custom)
// ---------------------------------------------------------------------------

test("bare /account in TUI opens the switch panel built from live account data; cancel is a no-op", async () => {
  const fake = defaultFake();
  const registered = registerAccount(fake);
  let built: AccountSwitchPanel | undefined;
  let overlayOptions: unknown;
  const { ctx } = makeCtx({
    custom: async (factory, options) => {
      overlayOptions = options;
      built = buildPanel(factory, () => {});
      return undefined; // cancel
    },
  });

  await invoke(registered, "", ctx);

  assert.equal(fake.refreshCount, 1, "refresh runs before dispatch");
  assert.ok(built, "ui.custom built the panel from the projection");
  // The projection the command produced is inside the panel.
  const output = plain(built.render(58).join("\n"));
  assert.match(output, /Switch account/);
  assert.match(output, /Codex/);
  assert.match(output, /OpenCode Go/);
  assert.match(output, /3 accounts/);
  assert.match(output, /1 account/);
  assert.deepEqual(fake.selectCalls, [], "cancelling the panel selects nothing");
  assert.equal(fake.refreshCount, 1);
  // showAccountSwitch passes overlay options.
  const options = overlayOptions as { overlay?: boolean; overlayOptions?: { width?: number } };
  assert.equal(options.overlay, true);
  assert.equal(options.overlayOptions?.width, PANEL_WIDTH);
});

test("bare /account and /account switch both drive the panel; confirming selects the account", async () => {
  for (const args of ["", "switch"]) {
    const fake = defaultFake();
    const registered = registerAccount(fake);
    const { ctx, notifications } = makeCtx({
      custom: async (factory) => {
        let resolveDone!: (result: AccountSwitchResult) => void;
        const promise = new Promise<AccountSwitchResult>((resolve) => {
          resolveDone = resolve;
        });
        const panel = buildPanel(factory, resolveDone);
        // Enter opens the Codex account stage (selected account first),
        // Enter confirms it: { type: "select", provider: "openai-codex", accountId: "default" }.
        panel.handleInput(ENTER);
        panel.handleInput(ENTER);
        return promise;
      },
    });

    await invoke(registered, args, ctx);

    assert.deepEqual(fake.selectCalls, [{ provider: "openai-codex", accountId: "default" }]);
    assert.ok(infoMessages(notifications).includes("Codex account: Default"), "selection is announced");
  }
});

test("panel add action routes into addAccount which prompts for the name and prefills /login", async () => {
  const fake = defaultFake();
  const registered = registerAccount(fake);
  const { ctx, notifications, inputCalls, getEditorText } = makeCtx({
    custom: async (factory) => {
      let resolveDone!: (result: AccountSwitchResult) => void;
      const promise = new Promise<AccountSwitchResult>((resolve) => {
        resolveDone = resolve;
      });
      const panel = buildPanel(factory, resolveDone);
      // Enter opens Codex accounts; UP wraps to the trailing + Add account row; Enter confirms.
      panel.handleInput(ENTER);
      panel.handleInput("\x1b[A");
      panel.handleInput(ENTER);
      return promise;
    },
    inputResult: "Work",
  });

  await invoke(registered, "", ctx);

  assert.deepEqual(inputCalls, [{ title: "Codex account name", placeholder: "personal" }]);
  assert.deepEqual(fake.addCalls, [{ provider: "openai-codex", name: "Work" }]);
  assert.equal(getEditorText(), `/login ${planProviderIdForAccount("openai-codex", "acct-1")}`);
  assert.ok(
    infoMessages(notifications).includes("Account created. Press Enter to run Pi's native /login."),
    "add flow announces the native /login prefill",
  );
});

// ---------------------------------------------------------------------------
// Headless switch with provider aliases
// ---------------------------------------------------------------------------

test("headless /account switch selects by provider alias and account name", async () => {
  const fake = defaultFake();
  const registered = registerAccount(fake);
  const { ctx } = makeCtx({ mode: "rpc" });

  await invoke(registered, "switch codex acct-secondary", ctx);
  await invoke(registered, "switch opencode default", ctx);
  await invoke(registered, "switch go default", ctx);
  await invoke(registered, "Switch Codex Secondary", ctx);

  assert.deepEqual(fake.selectCalls, [
    { provider: "openai-codex", accountId: "acct-secondary" },
    { provider: "opencode-go", accountId: "default" },
    { provider: "opencode-go", accountId: "default" },
    { provider: "openai-codex", accountId: "acct-secondary" },
  ]);
  assert.equal(fake.refreshCount, 4, "every invocation refreshes first");
});

test("headless bare /account switch without arguments reports the TUI picker requirement", async () => {
  const fake = defaultFake();
  const registered = registerAccount(fake);
  const { ctx, notifications } = makeCtx({ mode: "rpc" });

  await invoke(registered, "", ctx);
  await invoke(registered, "switch", ctx);

  assert.deepEqual(fake.selectCalls, []);
  assert.deepEqual(errorMessages(notifications), [
    "Usage: /account switch <provider> <account> (the picker requires TUI mode).",
    "Usage: /account switch <provider> <account> (the picker requires TUI mode).",
  ]);
});

test("headless switch with an unknown account name notifies", async () => {
  const fake = defaultFake();
  const registered = registerAccount(fake);
  const { ctx, notifications } = makeCtx({ mode: "rpc" });

  await invoke(registered, "switch codex nope", ctx);

  assert.deepEqual(fake.selectCalls, []);
  assert.deepEqual(errorMessages(notifications), ["Unknown Codex account: nope."]);
});

// ---------------------------------------------------------------------------
// Unauthenticated selection prefills native /login
// ---------------------------------------------------------------------------

test("selecting an unauthenticated account prefills /login with its plan alias id", async () => {
  const fake = unauthenticatedSecondaryFake();
  const registered = registerAccount(fake);
  const { ctx, notifications, getEditorText } = makeCtx({ mode: "rpc" });

  await invoke(registered, "switch codex acct-secondary", ctx);

  assert.deepEqual(fake.selectCalls, [], "unauthenticated accounts are never selected");
  assert.equal(getEditorText(), `/login ${planProviderIdForAccount("openai-codex", "acct-secondary")}`);
  assert.ok(
    infoMessages(notifications).includes("Press Enter to log in Codex · Secondary."),
    "login hint names the provider and account",
  );
});

test("selecting an unauthenticated default account prefills /login with the base provider id", async () => {
  const fake = defaultFake();
  fake.authenticated.set("openai-codex|default", false);
  const registered = registerAccount(fake);
  const { ctx, getEditorText, notifications } = makeCtx({ mode: "rpc" });

  await invoke(registered, "switch codex default", ctx);

  assert.equal(getEditorText(), "/login openai-codex");
  assert.deepEqual(fake.selectCalls, []);
  assert.ok(infoMessages(notifications).includes("Press Enter to log in Codex · Default."));
});

// ---------------------------------------------------------------------------
// Add prefills native /login
// ---------------------------------------------------------------------------

test("headless /account add creates the account and prefills /login with the plan alias", async () => {
  const fake = defaultFake();
  const registered = registerAccount(fake);
  const { ctx, notifications, getEditorText } = makeCtx({ mode: "rpc" });

  await invoke(registered, "add codex \"Team Alpha\"", ctx);

  assert.deepEqual(fake.addCalls, [{ provider: "openai-codex", name: "Team Alpha" }]);
  assert.equal(getEditorText(), `/login ${planProviderIdForAccount("openai-codex", "acct-1")}`);
  assert.notEqual(getEditorText(), "/login openai-codex", "non-default account uses the plan alias id");
  assert.ok(infoMessages(notifications).includes("Account created. Press Enter to run Pi's native /login."));
});

test("quoted names with single or double quotes and unquoted multi-word names reach addAccount", async () => {
  const fake = defaultFake();
  const registered = registerAccount(fake);
  const { ctx } = makeCtx({ mode: "rpc" });

  await invoke(registered, "add opencode-go 'Team One'", ctx);
  await invoke(registered, "add codex \"Team Two\"", ctx);
  await invoke(registered, "add opencode-go Team Three", ctx);

  assert.deepEqual(fake.addCalls, [
    { provider: "opencode-go", name: "Team One" },
    { provider: "openai-codex", name: "Team Two" },
    { provider: "opencode-go", name: "Team Three" },
  ]);
});

test("headless /account add without a name reports usage", async () => {
  const fake = defaultFake();
  const registered = registerAccount(fake);
  const { ctx, notifications } = makeCtx({ mode: "rpc" });

  await invoke(registered, "add codex", ctx);

  assert.deepEqual(fake.addCalls, []);
  assert.deepEqual(errorMessages(notifications), ["Usage: /account add <provider> <name>."]);
});

test("TUI /account add with a provider prompts for the name", async () => {
  const fake = defaultFake();
  const registered = registerAccount(fake);
  const { ctx, inputCalls } = makeCtx({
    mode: "tui",
    inputResult: "Work",
  });

  await invoke(registered, "add codex", ctx);

  assert.deepEqual(inputCalls, [{ title: "Codex account name", placeholder: "personal" }]);
  assert.deepEqual(fake.addCalls, [{ provider: "openai-codex", name: "Work" }]);
});

test("TUI /account add without a provider picks one via ui.select", async () => {
  const fake = defaultFake();
  const registered = registerAccount(fake);
  const { ctx, selectCalls, getEditorText } = makeCtx({
    mode: "tui",
    selectResult: "OpenCode Go",
    inputResult: "Shared",
  });

  await invoke(registered, "add", ctx);

  assert.deepEqual(selectCalls, [{ title: "Plan provider", options: ["Codex", "OpenCode Go"] }]);
  assert.deepEqual(fake.addCalls, [{ provider: "opencode-go", name: "Shared" }]);
  assert.equal(getEditorText(), `/login ${planProviderIdForAccount("opencode-go", "acct-1")}`);
});

test("cancelling the provider picker or the name input aborts the add silently", async () => {
  const fake = defaultFake();
  const registered = registerAccount(fake);

  const picker = makeCtx({ mode: "tui" });
  await invoke(registered, "add", picker.ctx);
  assert.deepEqual(errorMessages(picker.notifications), ["Account creation cancelled."]);
  assert.deepEqual(fake.addCalls, []);

  const name = makeCtx({ mode: "tui" });
  await invoke(registered, "add codex", name.ctx);
  assert.deepEqual(name.notifications, [], "cancelled name input is a silent no-op");
  assert.deepEqual(fake.addCalls, []);
  assert.equal(name.getEditorText(), "");
});

// ---------------------------------------------------------------------------
// Rename / remove / status
// ---------------------------------------------------------------------------

test("/account rename resolves the account by name and applies the quoted new name", async () => {
  const fake = defaultFake();
  const registered = registerAccount(fake);
  const { ctx, notifications } = makeCtx({ mode: "rpc" });

  await invoke(registered, "rename codex secondary \"Team Beta\"", ctx);

  assert.deepEqual(fake.renameCalls, [{ provider: "openai-codex", accountId: "acct-secondary", name: "Team Beta" }]);
  assert.ok(infoMessages(notifications).includes("Renamed Codex account."));
});

test("/account rename accepts an account id and a single-word new name", async () => {
  const fake = defaultFake();
  const registered = registerAccount(fake);
  const { ctx } = makeCtx({ mode: "rpc" });

  await invoke(registered, "rename codex acct-secondary NewName", ctx);

  assert.deepEqual(fake.renameCalls, [{ provider: "openai-codex", accountId: "acct-secondary", name: "NewName" }]);
});

test("/account rename usage and unknown-account errors are notified", async () => {
  const fake = defaultFake();
  const registered = registerAccount(fake);
  const { ctx, notifications } = makeCtx({ mode: "rpc" });

  await invoke(registered, "rename codex secondary", ctx);
  await invoke(registered, "rename codex nope New", ctx);

  assert.deepEqual(fake.renameCalls, []);
  assert.deepEqual(errorMessages(notifications), [
    "Usage: /account rename <provider> <account> <new-name>.",
    "Unknown Codex account: nope.",
  ]);
});

test("TUI /account remove confirms before removing", async () => {
  const fake = defaultFake();
  const registered = registerAccount(fake);
  const { ctx, notifications, confirmCalls } = makeCtx({
    confirmResult: true,
  });

  await invoke(registered, "remove codex secondary", ctx);

  assert.deepEqual(confirmCalls, [{ title: "Remove account profile", message: "Codex · Secondary?" }]);
  assert.deepEqual(fake.removeCalls, [{ provider: "openai-codex", accountId: "acct-secondary" }]);
  assert.ok(infoMessages(notifications).includes("Removed Codex · Secondary."));
});

test("declining the TUI confirmation keeps the account", async () => {
  const fake = defaultFake();
  const registered = registerAccount(fake);
  const { ctx, notifications } = makeCtx({
    confirmResult: false,
  });

  await invoke(registered, "remove codex secondary", ctx);

  assert.deepEqual(fake.removeCalls, []);
  assert.equal(notifications.length, 0, "declined removal is silent");
});

test("headless /account remove skips the confirmation dialog", async () => {
  const fake = defaultFake();
  const registered = registerAccount(fake);
  const { ctx, confirmCalls } = makeCtx({ mode: "rpc" });

  await invoke(registered, "remove codex secondary", ctx);

  assert.deepEqual(confirmCalls, [], "no confirmation in headless mode");
  assert.deepEqual(fake.removeCalls, [{ provider: "openai-codex", accountId: "acct-secondary" }]);
});

test("/account remove resolves quoted multi-word account names", async () => {
  const fake = new FakeController({
    "openai-codex": [{ id: "acct-team", name: "Team Alpha" }],
    "opencode-go": [],
  });
  const registered = registerAccount(fake);
  const { ctx } = makeCtx({ mode: "rpc" });

  await invoke(registered, "remove codex \"Team Alpha\"", ctx);

  assert.deepEqual(fake.removeCalls, [{ provider: "openai-codex", accountId: "acct-team" }]);
});

test("native logout-guard errors from remove propagate to an error notification", async () => {
  const fake = defaultFake();
  fake.remove = async (_provider, _accountId, _ctx) => {
    throw new Error("Log out Secondary with /logout before removing it.");
  };
  const registered = registerAccount(fake);
  const { ctx, notifications } = makeCtx({ mode: "rpc" });

  await invoke(registered, "remove codex secondary", ctx);

  assert.deepEqual(errorMessages(notifications), ["Log out Secondary with /logout before removing it."]);
});

test("removing the default account surfaces the coordinator guard error", async () => {
  const fake = defaultFake();
  fake.remove = async (_provider, _accountId, _ctx) => {
    throw new Error("The default account cannot be removed.");
  };
  const registered = registerAccount(fake);
  const { ctx, notifications } = makeCtx({ mode: "rpc" });

  await invoke(registered, "remove codex default", ctx);

  assert.deepEqual(errorMessages(notifications), ["The default account cannot be removed."]);
});

test("/account status reports selected, login-required, and exhausted accounts per provider", async () => {
  const fake = statusFake();
  const registered = registerAccount(fake);
  const { ctx, notifications } = makeCtx({ mode: "rpc" });

  await invoke(registered, "status", ctx);

  assert.equal(notifications.length, 1);
  const info = notifications[0]!;
  assert.equal(info.type, "info");
  assert.ok(info.message.includes("Codex\n  Default — selected"), info.message);
  assert.ok(info.message.includes("Secondary — login required"), info.message);
  assert.ok(info.message.includes("Tertiary — exhausted"), info.message);
  assert.match(info.message, /resets \w{3} \d/, "exhausted accounts show a reset time");
  assert.ok(info.message.includes("OpenCode Go"), info.message);
  assert.ok(info.message.includes("  Default — selected"), info.message);
});

// ---------------------------------------------------------------------------
// Provider parsing and unknown subcommands
// ---------------------------------------------------------------------------

test("unsupported providers are rejected for every subcommand that takes one", async () => {
  const fake = defaultFake();
  const registered = registerAccount(fake);
  const { ctx, notifications } = makeCtx({ mode: "rpc" });

  await invoke(registered, "switch gemini foo", ctx);
  await invoke(registered, "add gemini x", ctx);
  await invoke(registered, "rename gemini a b", ctx);
  await invoke(registered, "remove gemini a", ctx);

  assert.deepEqual(errorMessages(notifications), [
    "Unsupported plan provider: gemini.",
    "Unsupported plan provider: gemini.",
    "Unsupported plan provider: gemini.",
    "Unsupported plan provider: gemini.",
  ]);
  assert.deepEqual(fake.selectCalls, []);
  assert.deepEqual(fake.addCalls, []);
  assert.deepEqual(fake.renameCalls, []);
  assert.deepEqual(fake.removeCalls, []);
});

test("unknown subcommands notify with the supported list", async () => {
  const fake = defaultFake();
  const registered = registerAccount(fake);
  const { ctx, notifications } = makeCtx();

  await invoke(registered, "bogus", ctx);

  assert.deepEqual(errorMessages(notifications), [
    "Unknown /account command: bogus. Use switch|status|add|rename|remove.",
  ]);
});

test("a provider alias in the bare position is treated as a subcommand, not as a switch target", async () => {
  const fake = defaultFake();
  const registered = registerAccount(fake);
  const { ctx, notifications } = makeCtx({ mode: "rpc" });

  await invoke(registered, "codex acct-secondary", ctx);

  assert.deepEqual(fake.selectCalls, []);
  assert.deepEqual(errorMessages(notifications), [
    "Unknown /account command: codex. Use switch|status|add|rename|remove.",
  ]);
});

// ---------------------------------------------------------------------------
// Completions
// ---------------------------------------------------------------------------

type Completions = (prefix: string) => ReturnType<NonNullable<RegisteredCommand["getArgumentCompletions"]>>;

function completionsOf(registered: RegisteredCommand): Completions {
  const fn = registered.getArgumentCompletions;
  if (!fn) throw new Error("/account did not register argument completions");
  return fn;
}

test("completions suggest the subcommands for a partial or empty first word", async () => {
  const fake = defaultFake();
  const registered = registerAccount(fake);
  const completions = completionsOf(registered);

  assert.deepEqual(await completions(""), [
    { value: "switch", label: "switch" },
    { value: "status", label: "status" },
    { value: "add", label: "add" },
    { value: "rename", label: "rename" },
    { value: "remove", label: "remove" },
  ]);
  assert.deepEqual(await completions("sw"), [{ value: "switch", label: "switch" }]);
  assert.deepEqual(await completions("st"), [{ value: "status", label: "status" }]);
});

test("completions suggest providers for the second word and null beyond it", async () => {
  const fake = defaultFake();
  const registered = registerAccount(fake);
  const completions = completionsOf(registered);

  assert.deepEqual(await completions("add "), [
    { value: "add openai-codex", label: "Codex" },
    { value: "add opencode-go", label: "OpenCode Go" },
  ]);
  assert.deepEqual(await completions("switch openc"), [{ value: "switch opencode-go", label: "OpenCode Go" }]);
  assert.deepEqual(await completions("add openai"), [{ value: "add openai-codex", label: "Codex" }]);
  assert.equal(await completions("add openai-codex Name"), null);
  assert.deepEqual(await completions("  switch "), [
    { value: "switch openai-codex", label: "Codex" },
    { value: "switch opencode-go", label: "OpenCode Go" },
  ]);
});

test("completions match friendly provider aliases and reject unknown subcommands", async () => {
  const fake = defaultFake();
  const registered = registerAccount(fake);
  const completions = completionsOf(registered);

  assert.deepEqual(await completions("switch codex"), [{ value: "switch openai-codex", label: "Codex" }]);
  assert.deepEqual(await completions("add go"), [{ value: "add opencode-go", label: "OpenCode Go" }]);
  assert.equal(await completions("bogus open"), null);
});
