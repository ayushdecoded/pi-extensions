import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { AccountController } from "./controller.ts";
import { isSupportedAccountProvider, providerDisplayName } from "./controller.ts";
import { showAccountSwitch, type AccountSwitchProvider } from "./panel.ts";
import type { SupportedProviderId } from "./types.ts";

const SUBCOMMANDS = ["switch", "status", "add", "rename", "remove"] as const;

export function registerAccountCommands(pi: ExtensionAPI, accounts: AccountController): void {
  pi.registerCommand("account", {
    description: "Experimental: switch and manage named plan accounts",
    getArgumentCompletions: (prefix) => completions(prefix, accounts),
    handler: async (args, ctx) => {
      try {
        await accounts.refresh();
        const words = splitArgs(args);
        const command = (words.shift()?.toLowerCase() || "switch") as string;
        if (command === "switch") await switchAccount(words, ctx, accounts);
        else if (command === "status") await showStatus(ctx, accounts);
        else if (command === "add") await addAccount(words, ctx, accounts);
        else if (command === "rename") await renameAccount(words, ctx, accounts);
        else if (command === "remove") await removeAccount(words, ctx, accounts);
        else throw new Error(`Unknown /account command: ${command}. Use ${SUBCOMMANDS.join("|")}.`);
      } catch (error) {
        ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
      }
    },
  });
}

async function switchAccount(words: string[], ctx: ExtensionContext, accounts: AccountController): Promise<void> {
  if (words.length >= 2) {
    const provider = parseProvider(words[0]!);
    const account = requireAccount(accounts, provider, words.slice(1).join(" "));
    await selectOrLogin(ctx, accounts, provider, account.id);
    return;
  }
  if (ctx.mode !== "tui") {
    throw new Error("Usage: /account switch <provider> <account> (the picker requires TUI mode)." );
  }
  const projection = await panelProjection(ctx, accounts);
  const result = await showAccountSwitch(ctx, projection);
  if (!result) return;
  const provider = parseProvider(result.provider);
  if (result.type === "add") {
    await addAccount([provider], ctx, accounts);
    return;
  }
  await selectOrLogin(ctx, accounts, provider, result.accountId);
}

async function selectOrLogin(
  ctx: ExtensionContext,
  accounts: AccountController,
  provider: SupportedProviderId,
  accountId: string,
): Promise<void> {
  const account = accounts.accounts(provider).find((candidate) => candidate.id === accountId);
  if (!account) throw new Error(`Unknown ${providerDisplayName(provider)} account: ${accountId}.`);
  const providerId = accounts.providerIdForAccount(provider, accountId);
  if (!(await accounts.isAuthenticated(ctx, provider, accountId))) {
    ctx.ui.setEditorText(`/login ${providerId}`);
    ctx.ui.notify(`Press Enter to log in ${providerDisplayName(provider)} · ${account.name}.`, "info");
    return;
  }
  await accounts.select(provider, accountId, ctx);
  ctx.ui.notify(`${providerDisplayName(provider)} account: ${account.name}`, "info");
}

async function addAccount(words: string[], ctx: ExtensionContext, accounts: AccountController): Promise<void> {
  let provider: SupportedProviderId;
  let name: string;
  if (words.length >= 2) {
    provider = parseProvider(words[0]!);
    name = words.slice(1).join(" ");
  } else {
    if (ctx.mode !== "tui") throw new Error("Usage: /account add <provider> <name>.");
    provider = words[0] ? parseProvider(words[0]) : await pickProvider(ctx, accounts);
    const input = await ctx.ui.input(`${providerDisplayName(provider)} account name`, "personal");
    if (!input) return;
    name = input;
  }
  const created = await accounts.add(provider, name);
  ctx.ui.setEditorText(`/login ${created.providerId}`);
  ctx.ui.notify(`Account created. Press Enter to run Pi's native /login.`, "info");
}

async function renameAccount(words: string[], ctx: ExtensionContext, accounts: AccountController): Promise<void> {
  if (words.length < 3) throw new Error("Usage: /account rename <provider> <account> <new-name>.");
  const provider = parseProvider(words[0]!);
  const account = requireAccount(accounts, provider, words[1]!);
  await accounts.rename(provider, account.id, words.slice(2).join(" "));
  ctx.ui.notify(`Renamed ${providerDisplayName(provider)} account.`, "info");
}

async function removeAccount(words: string[], ctx: ExtensionContext, accounts: AccountController): Promise<void> {
  if (words.length < 2) throw new Error("Usage: /account remove <provider> <account>.");
  const provider = parseProvider(words[0]!);
  const account = requireAccount(accounts, provider, words.slice(1).join(" "));
  if (ctx.mode === "tui") {
    const confirmed = await ctx.ui.confirm("Remove account profile", `${providerDisplayName(provider)} · ${account.name}?`);
    if (!confirmed) return;
  }
  await accounts.remove(provider, account.id, ctx);
  ctx.ui.notify(`Removed ${providerDisplayName(provider)} · ${account.name}.`, "info");
}

async function showStatus(ctx: ExtensionContext, accounts: AccountController): Promise<void> {
  const lines: string[] = [];
  for (const provider of accounts.providers()) {
    lines.push(providerDisplayName(provider));
    for (const account of accounts.accounts(provider)) {
      const authenticated = await accounts.isAuthenticated(ctx, provider, account.id);
      const reset = account.exhausted && account.resetAt ? ` · resets ${formatLocal(account.resetAt)}` : "";
      const states = [account.selected ? "selected" : "", authenticated ? "" : "login required", account.exhausted ? "exhausted" : ""]
        .filter(Boolean).join(" · ");
      lines.push(`  ${account.name}${states ? ` — ${states}` : ""}${reset}`);
    }
  }
  ctx.ui.notify(lines.join("\n"), "info");
}

async function panelProjection(ctx: ExtensionContext, accounts: AccountController): Promise<AccountSwitchProvider[]> {
  return Promise.all(accounts.providers().map(async (provider) => ({
    id: provider,
    label: providerDisplayName(provider),
    accounts: await Promise.all(accounts.accounts(provider).map(async (account) => ({
      id: account.id,
      name: account.name,
      selected: account.selected,
      authenticated: await accounts.isAuthenticated(ctx, provider, account.id),
      exhausted: account.exhausted,
      ...(account.resetAt ? { resetAt: account.resetAt } : {}),
    }))),
  })));
}

async function pickProvider(ctx: ExtensionContext, accounts: AccountController): Promise<SupportedProviderId> {
  const providers = accounts.providers();
  const selected = await ctx.ui.select("Plan provider", providers.map(providerDisplayName));
  const provider = providers.find((candidate) => providerDisplayName(candidate) === selected);
  if (!provider) throw new Error("Account creation cancelled.");
  return provider;
}

function requireAccount(accounts: AccountController, provider: SupportedProviderId, nameOrId: string) {
  const account = accounts.coordinator.accountByName(provider, nameOrId);
  if (!account) throw new Error(`Unknown ${providerDisplayName(provider)} account: ${nameOrId}.`);
  return account;
}

function parseProvider(value: string): SupportedProviderId {
  const key = value.toLowerCase();
  const normalized = key === "codex" ? "openai-codex" : key === "opencode" || key === "go" ? "opencode-go" : key;
  if (!isSupportedAccountProvider(normalized)) throw new Error(`Unsupported plan provider: ${value}.`);
  return normalized;
}

function splitArgs(input: string): string[] {
  const words: string[] = [];
  const pattern = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(input)) !== null) words.push(match[1] ?? match[2] ?? match[3]!);
  return words;
}

function completions(prefix: string, accounts: AccountController) {
  const words = prefix.trimStart().split(/\s+/);
  if (words.length <= 1) {
    return SUBCOMMANDS.filter((command) => command.startsWith(words[0]?.toLowerCase() ?? ""))
      .map((command) => ({ value: command, label: command }));
  }
  if (words.length === 2) {
    if (!SUBCOMMANDS.includes(words[0]!.toLowerCase() as (typeof SUBCOMMANDS)[number])) return null;
    const providerPrefix = words[1]!.toLowerCase();
    return accounts.providers().filter((provider) =>
      provider.startsWith(providerPrefix) || providerAliases(provider).some((alias) => alias.startsWith(providerPrefix)),
    ).map((provider) => ({ value: `${words[0]} ${provider}`, label: providerDisplayName(provider) }));
  }
  return null;
}

function providerAliases(provider: SupportedProviderId): string[] {
  return provider === "openai-codex" ? ["codex"] : ["opencode", "go"];
}

function formatLocal(value: string): string {
  const date = new Date(value);
  return new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }).format(date);
}
