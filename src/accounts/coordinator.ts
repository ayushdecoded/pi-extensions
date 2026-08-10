import { randomUUID } from "node:crypto";
import type { AccountsStore } from "./store.ts";
import {
  DEFAULT_ACCOUNT_KEY,
  SUPPORTED_PROVIDERS,
  defaultAccountsFile,
  type AccountProfile,
  type AccountsFile,
  type LimitWindow,
  type SupportedProviderId,
} from "./types.ts";

export type AccountView = AccountProfile & {
  id: string;
  provider: SupportedProviderId;
  selected: boolean;
  exhausted: boolean;
};

export type FailoverResult = {
  provider: SupportedProviderId;
  exhaustedAccountId: string;
  selectedAccountId?: string;
  changed: boolean;
};

export class AccountCoordinator {
  private state: AccountsFile = defaultAccountsFile();
  private initialized?: Promise<void>;
  private mutation = Promise.resolve();
  private readonly listeners = new Set<() => void>();

  constructor(private readonly store: AccountsStore, private readonly now: () => number = Date.now) {}

  initialize(): Promise<void> {
    this.initialized ??= this.store.read().then((state) => { this.replace(state); });
    return this.initialized;
  }

  async reload(): Promise<boolean> {
    await this.initialize();
    const next = await this.store.read();
    if (JSON.stringify(next) === JSON.stringify(this.state)) return false;
    this.replace(next);
    return true;
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  snapshot(): AccountsFile {
    return structuredClone(this.state);
  }

  accounts(provider: SupportedProviderId): AccountView[] {
    const state = withProviderDefaults(this.state, provider, this.now());
    const selected = state.selected[provider] ?? DEFAULT_ACCOUNT_KEY;
    return Object.entries(state.accounts[provider] ?? {}).map(([id, profile]) => ({
      id,
      provider,
      ...structuredClone(profile),
      selected: id === selected,
      exhausted: isProfileExhausted(profile, this.now()),
    }));
  }

  selectedAccountId(provider: SupportedProviderId): string {
    const selected = this.state.selected[provider] ?? DEFAULT_ACCOUNT_KEY;
    return this.profile(provider, selected) ? selected : DEFAULT_ACCOUNT_KEY;
  }

  profile(provider: SupportedProviderId, accountId: string): AccountProfile | undefined {
    if (accountId === DEFAULT_ACCOUNT_KEY && !this.state.accounts[provider]?.[accountId]) {
      return defaultProfile(this.now());
    }
    const profile = this.state.accounts[provider]?.[accountId];
    return profile ? structuredClone(profile) : undefined;
  }

  async addAccount(provider: SupportedProviderId, name: string): Promise<string> {
    const clean = validateName(name);
    let accountId = "";
    await this.mutate((state) => {
      ensureProvider(state, provider, this.now());
      const duplicate = Object.values(state.accounts[provider]!).some(
        (profile) => profile.name.toLowerCase() === clean.toLowerCase(),
      );
      if (duplicate) throw new Error(`${provider} already has an account named ${clean}.`);
      accountId = randomUUID();
      state.accounts[provider]![accountId] = newProfile(clean, this.now());
      return state;
    });
    return accountId;
  }

  async renameAccount(provider: SupportedProviderId, accountId: string, name: string): Promise<void> {
    const clean = validateName(name);
    await this.mutate((state) => {
      ensureProvider(state, provider, this.now());
      const profile = state.accounts[provider]![accountId];
      if (!profile) throw new Error(`Unknown ${provider} account: ${accountId}.`);
      const duplicate = Object.entries(state.accounts[provider]!).some(
        ([id, candidate]) => id !== accountId && candidate.name.toLowerCase() === clean.toLowerCase(),
      );
      if (duplicate) throw new Error(`${provider} already has an account named ${clean}.`);
      profile.name = clean;
      profile.updatedAt = iso(this.now());
      return state;
    });
  }

  async removeAccount(provider: SupportedProviderId, accountId: string): Promise<void> {
    if (accountId === DEFAULT_ACCOUNT_KEY) throw new Error("The default account cannot be removed.");
    await this.mutate((state) => {
      ensureProvider(state, provider, this.now());
      if (!state.accounts[provider]![accountId]) throw new Error(`Unknown ${provider} account: ${accountId}.`);
      delete state.accounts[provider]![accountId];
      if (state.selected[provider] === accountId) state.selected[provider] = DEFAULT_ACCOUNT_KEY;
      return state;
    });
  }

  async selectAccount(provider: SupportedProviderId, accountId: string): Promise<void> {
    await this.mutate((state) => {
      ensureProvider(state, provider, this.now());
      if (!state.accounts[provider]![accountId]) throw new Error(`Unknown ${provider} account: ${accountId}.`);
      state.selected[provider] = accountId;
      return state;
    });
  }

  async updateLimits(provider: SupportedProviderId, accountId: string, limits: LimitWindow[]): Promise<void> {
    await this.mutate((state) => {
      ensureProvider(state, provider, this.now());
      const profile = state.accounts[provider]![accountId];
      if (!profile) return state;
      profile.limits = structuredClone(limits);
      profile.updatedAt = iso(this.now());
      if (limits.length > 0 && limits.every((window) => window.usedPercent === undefined || window.usedPercent < 100)) {
        delete profile.exhaustedAt;
        delete profile.resetAt;
      } else if (profile.exhaustedAt) {
        const blockingResets = limits
          .filter((window) => window.usedPercent !== undefined && window.usedPercent >= 100 && window.resetAt)
          .map((window) => Date.parse(window.resetAt!))
          .filter(Number.isFinite);
        if (blockingResets.length > 0) profile.resetAt = iso(Math.max(...blockingResets));
        else delete profile.resetAt;
      }
      return state;
    });
  }

  async clearExhaustion(provider: SupportedProviderId, accountId: string): Promise<void> {
    await this.mutate((state) => {
      ensureProvider(state, provider, this.now());
      const profile = state.accounts[provider]![accountId];
      if (!profile) return state;
      delete profile.exhaustedAt;
      delete profile.resetAt;
      profile.updatedAt = iso(this.now());
      return state;
    });
  }

  async failover(
    provider: SupportedProviderId,
    exhaustedAccountId: string,
    configuredAccountIds: ReadonlySet<string>,
    resetAtMs?: number,
  ): Promise<FailoverResult> {
    let result: FailoverResult = { provider, exhaustedAccountId, changed: false };
    await this.mutate((state) => {
      ensureProvider(state, provider, this.now());
      const profiles = state.accounts[provider]!;
      const exhausted = profiles[exhaustedAccountId];
      if (exhausted) {
        exhausted.exhaustedAt = iso(this.now());
        exhausted.updatedAt = iso(this.now());
        if (resetAtMs !== undefined && Number.isFinite(resetAtMs) && resetAtMs > this.now()) {
          exhausted.resetAt = iso(resetAtMs);
        } else {
          delete exhausted.resetAt;
        }
      }

      const current = state.selected[provider] ?? DEFAULT_ACCOUNT_KEY;
      if (
        current !== exhaustedAccountId
        && configuredAccountIds.has(current)
        && profiles[current]
        && !isProfileExhausted(profiles[current]!, this.now())
      ) {
        result = { provider, exhaustedAccountId, selectedAccountId: current, changed: false };
        return state;
      }

      const next = Object.keys(profiles).find((accountId) => {
        if (accountId === exhaustedAccountId || !configuredAccountIds.has(accountId)) return false;
        return !isProfileExhausted(profiles[accountId]!, this.now());
      });
      if (next) {
        state.selected[provider] = next;
        result = { provider, exhaustedAccountId, selectedAccountId: next, changed: next !== current };
      } else {
        result = { provider, exhaustedAccountId, changed: false };
      }
      return state;
    });
    return result;
  }

  accountByName(provider: SupportedProviderId, nameOrId: string): AccountView | undefined {
    const target = nameOrId.toLowerCase();
    return this.accounts(provider).find((account) => account.id === nameOrId || account.name.toLowerCase() === target);
  }

  providerIds(): readonly SupportedProviderId[] {
    return SUPPORTED_PROVIDERS;
  }

  private async mutate(update: (state: AccountsFile) => AccountsFile): Promise<void> {
    await this.initialize();
    const run = this.mutation.then(async () => {
      const next = await this.store.mutate((latest) => update(structuredClone(latest)));
      this.replace(next);
    });
    this.mutation = run.catch(() => {});
    await run;
  }

  private replace(state: AccountsFile): void {
    this.state = state;
    for (const listener of this.listeners) listener();
  }
}

export function isProfileExhausted(profile: AccountProfile, now = Date.now()): boolean {
  if (!profile.exhaustedAt) return false;
  if (!profile.resetAt) return true;
  return Date.parse(profile.resetAt) > now;
}

function withProviderDefaults(state: AccountsFile, provider: SupportedProviderId, now: number): AccountsFile {
  const clone = structuredClone(state);
  ensureProvider(clone, provider, now);
  return clone;
}

function ensureProvider(state: AccountsFile, provider: SupportedProviderId, now: number): void {
  state.accounts[provider] ??= {};
  state.accounts[provider]![DEFAULT_ACCOUNT_KEY] ??= defaultProfile(now);
  state.selected[provider] ??= DEFAULT_ACCOUNT_KEY;
}

function defaultProfile(now: number): AccountProfile {
  return newProfile("default", now);
}

function newProfile(name: string, now: number): AccountProfile {
  const timestamp = iso(now);
  return { name, createdAt: timestamp, updatedAt: timestamp, limits: [] };
}

function validateName(name: string): string {
  const clean = name.trim();
  if (!clean) throw new Error("Account name cannot be empty.");
  if (clean.length > 60) throw new Error("Account name must be at most 60 characters.");
  return clean;
}

function iso(value: number): string {
  return new Date(value).toISOString();
}
