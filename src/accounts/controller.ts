import type {
  ExtensionAPI,
  ExtensionContext,
  InlineExtension,
} from "@earendil-works/pi-coding-agent";
import type { Api, AssistantMessage, Model, Provider } from "@earendil-works/pi-ai";
import { fetchCodexUsage } from "./codex-usage.ts";
import { AccountCoordinator, type AccountView } from "./coordinator.ts";
import { classifyFailure, type ProviderFailureDetails } from "./failure.ts";
import {
  PLAN_PROVIDERS,
  buildAliasProvider,
  canonicalProviderId,
  isSupportedPlanBase,
  providerIdForAccount,
  resolvePlanAccount,
  type PlanBaseProviderId,
} from "./providers.ts";
import { createAccountsStore } from "./store.ts";
import { DEFAULT_ACCOUNT_KEY, type SupportedProviderId } from "./types.ts";

const CONTINUATION = "The previous account reached its usage limit. Continue the current task from the existing state without repeating completed work.";
const HEALTHY_POLL_MS = 5 * 60_000;
const NEAR_RESET_POLL_MS = 30_000;
const NEAR_RESET_MS = 2 * 60_000;

type Attachment = {
  id: symbol;
  pi: ExtensionAPI;
  root: boolean;
  ctx?: ExtensionContext;
  lastAssistant?: AssistantMessage;
  lastResponse?: { providerId: string; status: number; headers: Record<string, string> };
  attempted: Set<string>;
};

export type AccountController = ReturnType<typeof createAccountController>;

export function createAccountController(rootPi: ExtensionAPI, options: { storePath?: string; fetch?: typeof fetch; now?: () => number } = {}) {
  const now = options.now ?? Date.now;
  const coordinator = new AccountCoordinator(createAccountsStore({ filePath: options.storePath }), now);
  const attachments = new Map<symbol, Attachment>();
  let rootAttachment: Attachment | undefined;
  let pollTimer: ReturnType<typeof setTimeout> | undefined;
  let polling = false;
  let disposed = false;
  const lastPolled = new Map<string, number>();
  const baseProviders = new Map<SupportedProviderId, Provider<any>>();

  const install = (pi: ExtensionAPI, root: boolean): Attachment => {
    const attachment: Attachment = { id: Symbol(root ? "account-root" : "account-child"), pi, root, attempted: new Set() };

    pi.on("session_start", async (_event, ctx) => {
      attachment.ctx = ctx;
      attachments.set(attachment.id, attachment);
      if (root) rootAttachment = attachment;
      try {
        rememberBaseProviders(ctx);
        await coordinator.initialize();
        syncAliases(attachment);
        await reloadAndReconcile(attachment);
        if (root) schedulePoll(0);
      } catch (error) {
        notify(attachment, error, "error");
      }
    });

    pi.on("before_agent_start", async (event, ctx) => {
      attachment.ctx = ctx;
      // SDK-created child sessions do not emit session_start. Attach on their
      // first real turn so concurrent children receive provider switches.
      attachments.set(attachment.id, attachment);
      rememberBaseProviders(ctx);
      if (event.prompt.trim() !== CONTINUATION) attachment.attempted.clear();
      try {
        await reloadAndReconcile(attachment);
      } catch (error) {
        notify(attachment, error, "error");
      }
    });

    pi.on("after_provider_response", (event, ctx) => {
      attachment.ctx = ctx;
      if (!ctx.model) return;
      attachment.lastResponse = {
        providerId: ctx.model.provider,
        status: event.status,
        headers: event.headers,
      };
    });

    pi.on("message_end", (event, ctx) => {
      attachment.ctx = ctx;
      if (event.message.role === "assistant") attachment.lastAssistant = event.message as AssistantMessage;
      if (root && ctx.model && canonicalProviderId(ctx.model.provider) === "openai-codex") schedulePoll(0);
    });

    pi.on("agent_settled", async (_event, ctx) => {
      attachment.ctx = ctx;
      let continuing = false;
      try {
        continuing = await handleSettled(attachment);
      } catch (error) {
        notify(attachment, error, "error");
      } finally {
        // Native SDK child sessions also do not emit session_shutdown. A
        // completed one-shot child must not remain retained by the controller.
        if (!root && !continuing) attachments.delete(attachment.id);
      }
    });

    pi.on("session_shutdown", () => {
      attachments.delete(attachment.id);
      if (rootAttachment === attachment) {
        rootAttachment = undefined;
        if (pollTimer) clearTimeout(pollTimer);
        pollTimer = undefined;
      }
    });
    return attachment;
  };

  const childExtension: InlineExtension = {
    name: "account-routing",
    hidden: true,
    factory: (pi) => {
      const attachment = install(pi, false);
      // Inline extension factories run while the child resource loader is
      // built, before createAgentSession returns. Register aliases here so a
      // routed initial model passes prompt auth preflight on its first turn.
      syncAliases(attachment);
    },
  };

  install(rootPi, true);

  function rememberBaseProviders(ctx: ExtensionContext): void {
    for (const base of coordinator.providerIds()) {
      const provider = ctx.modelRegistry.getProvider(base);
      if (provider) baseProviders.set(base, provider);
    }
  }

  function syncAliases(attachment: Attachment): void {
    for (const base of coordinator.providerIds()) {
      const provider = baseProviders.get(base);
      if (!provider) continue;
      for (const account of coordinator.accounts(base)) {
        if (account.id === DEFAULT_ACCOUNT_KEY) continue;
        attachment.pi.registerProvider(buildAliasProvider({
          base: provider,
          spec: PLAN_PROVIDERS[base],
          accountId: account.id,
          displayName: `${PLAN_PROVIDERS[base].label} · ${account.name}`,
        }));
      }
    }
  }

  async function reloadAndReconcile(attachment: Attachment): Promise<void> {
    await coordinator.reload();
    for (const item of attachments.values()) syncAliases(item);
    await reconcileAttachment(attachment);
  }

  async function reconcileAttachment(attachment: Attachment, baseOverride?: SupportedProviderId): Promise<boolean> {
    const ctx = attachment.ctx;
    if (!ctx?.model) return false;
    const base = canonicalProviderId(ctx.model.provider);
    if (!isSupportedPlanBase(base) || (baseOverride && base !== baseOverride)) return false;
    const selected = coordinator.selectedAccountId(base);
    const providerId = providerIdForAccount(base, selected);
    if (providerId === ctx.model.provider) return true;
    const target = ctx.modelRegistry.find(providerId, ctx.model.id);
    if (!target || !(await isProviderConfigured(ctx, providerId))) return false;
    if (await attachment.pi.setModel(target)) return true;
    // Native provider registration refreshes Pi's configured-model snapshot
    // asynchronously. Await an offline public registry refresh and retry so
    // root session_start does not leave the base/default account selected.
    await ctx.modelRegistry.refresh({ allowNetwork: false });
    return attachment.pi.setModel(target);
  }

  async function applySelection(base: SupportedProviderId): Promise<void> {
    await Promise.all([...attachments.values()].map((attachment) => reconcileAttachment(attachment, base)));
  }

  async function configuredAccounts(ctx: ExtensionContext, base: SupportedProviderId): Promise<Set<string>> {
    const configured = new Set<string>();
    for (const account of coordinator.accounts(base)) {
      if (await isProviderConfigured(ctx, providerIdForAccount(base, account.id))) configured.add(account.id);
    }
    return configured;
  }

  async function handleSettled(attachment: Attachment): Promise<boolean> {
    const message = attachment.lastAssistant;
    attachment.lastAssistant = undefined;
    if (!message || message.stopReason !== "error" || !attachment.ctx?.model) {
      if (message && message.stopReason !== "error") attachment.attempted.clear();
      return false;
    }
    // Attribute the failure to the provider that produced the assistant
    // message, not ctx.model, which another concurrent failover may have moved.
    const failedProvider = message.provider;
    const base = canonicalProviderId(failedProvider);
    if (!isSupportedPlanBase(base)) return false;
    const details: ProviderFailureDetails = {
      message: message.errorMessage,
      ...(attachment.lastResponse?.providerId === failedProvider
        ? { status: attachment.lastResponse.status, headers: attachment.lastResponse.headers }
        : {}),
    };
    attachment.lastResponse = undefined;
    const failure = classifyFailure(details, now());
    if (failure.kind !== "quota") return false;

    const failedAccount = accountIdForProvider(base, failedProvider);
    attachment.attempted.add(failedAccount);
    const configured = await configuredAccounts(attachment.ctx, base);
    for (const attempted of attachment.attempted) configured.delete(attempted);
    const resetAt = failure.retry?.resetAtMs ?? failure.retry?.retryAfterMs;
    const outcome = await coordinator.failover(base, failedAccount, configured, resetAt);
    if (!outcome.selectedAccountId) {
      notify(attachment, `All authenticated ${PLAN_PROVIDERS[base].label} accounts are exhausted.`, "warning");
      return false;
    }
    await applySelection(base);
    // followUp is safe if a user prompt races the async failover bookkeeping;
    // otherwise Pi starts the continuation immediately from agent_settled.
    attachment.pi.sendUserMessage(CONTINUATION, { deliverAs: "followUp" });
    return true;
  }

  function schedulePoll(delay: number): void {
    if (disposed || !rootAttachment) return;
    if (pollTimer) clearTimeout(pollTimer);
    pollTimer = setTimeout(() => void pollCodex(), Math.max(0, delay));
  }

  async function pollCodex(): Promise<void> {
    if (polling || disposed || !rootAttachment?.ctx) return;
    polling = true;
    try {
      const ctx = rootAttachment.ctx;
      const accounts = coordinator.accounts("openai-codex");
      const currentTime = now();
      let nextDelay = HEALTHY_POLL_MS;
      for (const account of accounts) {
        const resetAt = account.resetAt ? Date.parse(account.resetAt) : undefined;
        if (resetAt !== undefined && resetAt > currentTime) {
          nextDelay = Math.min(nextDelay, resetAt - currentTime <= NEAR_RESET_MS ? NEAR_RESET_POLL_MS : resetAt - currentTime);
        }
        const nearReset = resetAt !== undefined && resetAt - currentTime <= NEAR_RESET_MS;
        const pollInterval = nearReset ? NEAR_RESET_POLL_MS : HEALTHY_POLL_MS;
        const last = lastPolled.get(account.id);
        if (!account.selected && !account.exhausted && last !== undefined) continue;
        if (last !== undefined && currentTime - last < pollInterval) continue;
        lastPolled.set(account.id, currentTime);
        const providerId = providerIdForAccount("openai-codex", account.id);
        const model = modelForProvider(ctx, providerId);
        if (!model) continue;
        const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
        if (!auth.ok || !auth.apiKey) continue;
        try {
          const limits = await fetchCodexUsage({
            apiKey: auth.apiKey,
            headers: auth.headers,
            fetch: options.fetch,
            now: now(),
          });
          await coordinator.updateLimits("openai-codex", account.id, limits);
        } catch {
          // Quota display is advisory; request failures must not disrupt the agent.
        }
      }
      await applySelection("openai-codex");
      schedulePoll(nextDelay);
    } finally {
      polling = false;
    }
  }

  function modelForProvider(ctx: ExtensionContext, providerId: string): Model<any> | undefined {
    if (ctx.model && canonicalProviderId(ctx.model.provider) === canonicalProviderId(providerId)) {
      const same = ctx.modelRegistry.find(providerId, ctx.model.id);
      if (same) return same;
    }
    return ctx.modelRegistry.getAll().find((model) => model.provider === providerId);
  }

  async function isProviderConfigured(ctx: ExtensionContext, providerId: string): Promise<boolean> {
    try {
      return Boolean(await ctx.modelRegistry.getProviderAuth(providerId));
    } catch {
      return false;
    }
  }

  function accountIdForProvider(base: PlanBaseProviderId, providerId: string): string {
    if (providerId === base) return DEFAULT_ACCOUNT_KEY;
    return coordinator.accounts(base).find((account) => providerIdForAccount(base, account.id) === providerId)?.id
      ?? resolvePlanAccount(providerId).account;
  }

  function notify(attachment: Attachment, value: unknown, level: "info" | "warning" | "error"): void {
    if (!attachment.ctx?.hasUI) return;
    const message = value instanceof Error ? value.message : String(value);
    attachment.ctx.ui.notify(message, level);
  }

  async function select(provider: SupportedProviderId, accountId: string, ctx: ExtensionContext): Promise<void> {
    syncAliases(rootAttachment ?? { id: Symbol(), pi: rootPi, root: true, attempted: new Set() });
    const providerId = providerIdForAccount(provider, accountId);
    if (!(await isProviderConfigured(ctx, providerId))) {
      throw new Error(`${coordinator.profile(provider, accountId)?.name ?? accountId} is not logged in. Run /login ${providerId}.`);
    }
    await coordinator.selectAccount(provider, accountId);
    await applySelection(provider);
  }

  async function add(provider: SupportedProviderId, name: string): Promise<{ accountId: string; providerId: string }> {
    const accountId = await coordinator.addAccount(provider, name);
    for (const attachment of attachments.values()) syncAliases(attachment);
    return { accountId, providerId: providerIdForAccount(provider, accountId) };
  }

  async function remove(provider: SupportedProviderId, accountId: string, ctx: ExtensionContext): Promise<void> {
    const providerId = providerIdForAccount(provider, accountId);
    if (await isProviderConfigured(ctx, providerId)) {
      throw new Error(`Log out ${coordinator.profile(provider, accountId)?.name ?? accountId} with /logout before removing it.`);
    }
    await coordinator.removeAccount(provider, accountId);
    for (const attachment of attachments.values()) attachment.pi.unregisterProvider(providerId);
    await applySelection(provider);
  }

  return {
    coordinator,
    childExtension,
    select,
    add,
    remove,
    async rename(provider: SupportedProviderId, accountId: string, name: string): Promise<void> {
      await coordinator.renameAccount(provider, accountId, name);
      for (const attachment of attachments.values()) syncAliases(attachment);
    },
    accounts: (provider: SupportedProviderId): AccountView[] => coordinator.accounts(provider),
    providers: (): readonly SupportedProviderId[] => coordinator.providerIds(),
    selectedProviderId: (provider: SupportedProviderId): string => providerIdForAccount(provider, coordinator.selectedAccountId(provider)),
    routeModel<TApi extends Api>(model: Model<TApi>): Model<TApi> {
      const base = canonicalProviderId(model.provider);
      if (!isSupportedPlanBase(base)) return model;
      const provider = providerIdForAccount(base, coordinator.selectedAccountId(base));
      return provider === model.provider ? model : { ...model, provider };
    },
    providerIdForAccount: (provider: SupportedProviderId, accountId: string): string => providerIdForAccount(provider, accountId),
    isAuthenticated: (ctx: ExtensionContext, provider: SupportedProviderId, accountId: string): Promise<boolean> =>
      isProviderConfigured(ctx, providerIdForAccount(provider, accountId)),
    accountForProviderId: (providerId: string): AccountView | undefined => {
      const base = canonicalProviderId(providerId);
      if (!isSupportedPlanBase(base)) return undefined;
      return coordinator.accounts(base).find((account) => providerIdForAccount(base, account.id) === providerId);
    },
    async refresh(): Promise<void> {
      await coordinator.reload();
      for (const attachment of attachments.values()) syncAliases(attachment);
    },
    dispose(): void {
      disposed = true;
      if (pollTimer) clearTimeout(pollTimer);
      pollTimer = undefined;
    },
  };
}

export function isSupportedAccountProvider(value: string): value is SupportedProviderId {
  return value === "openai-codex" || value === "opencode-go";
}

export function providerDisplayName(provider: SupportedProviderId): string {
  return PLAN_PROVIDERS[provider].label;
}

export function formatReset(resetAt: string, now = new Date()): string {
  const date = new Date(resetAt);
  if (Number.isNaN(date.getTime())) return "";
  const sameDay = date.getFullYear() === now.getFullYear()
    && date.getMonth() === now.getMonth()
    && date.getDate() === now.getDate();
  return new Intl.DateTimeFormat(undefined, sameDay
    ? { hour: "numeric", minute: "2-digit" }
    : { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }).format(date);
}
