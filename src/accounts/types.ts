/**
 * On-disk metadata foundation for multi-account provider coordination.
 *
 * The file is versioned and stored at `<agentDir>/accounts.json` by default.
 * It holds provider account profiles, per-provider selected account ids, and
 * provider limit windows. It never holds secrets — credentials belong in
 * auth.json.
 *
 * The canonical/default account of a provider is stored under the map key
 * `"default"`; there is no `isDefault` field. Optional reset timestamps
 * (`resetAt`, `exhaustedAt`) are omitted when unknown, and the UI omits them
 * rather than guessing.
 */

/** Current on-disk schema version. Bump only together with a migration path. */
export const ACCOUNTS_FILE_VERSION = 1 as const;

/** File name used under the agent directory. */
export const ACCOUNTS_FILE_NAME = "accounts.json";

/**
 * Provider ids the coordinator understands today. Storage types accept any
 * string so forward-compatible providers keep working, but this list is the
 * supported surface the coordinator should treat as known.
 */
export const SUPPORTED_PROVIDERS = ["openai-codex", "opencode-go"] as const;
export type SupportedProviderId = (typeof SUPPORTED_PROVIDERS)[number];

/** Key under which a provider's canonical/default account is stored. */
export const DEFAULT_ACCOUNT_KEY = "default";

/** Free-form provider identifier used as a map key. */
export type ProviderId = string;

/** Free-form account identifier used as a map key. */
export type AccountId = string;

/** One provider limit window for an account. */
export interface LimitWindow {
  /** Stable identifier for this window (e.g. "primary", "secondary"). */
  name: string;
  /** Percent of the window consumed, 0..100, when known. */
  usedPercent?: number;
  /** Length of the window in seconds, when known. */
  windowSeconds?: number;
  /** ISO timestamp of the next reset, when known; missing means the UI omits it. */
  resetAt?: string;
  /** ISO timestamp of the last update to this window. */
  updatedAt: string;
}

/** Non-secret metadata for one account on a provider. */
export interface AccountProfile {
  /** Mutable display name; never a secret. */
  name: string;
  /** ISO timestamp of when the account was first seen. */
  createdAt: string;
  /** ISO timestamp of the last update to this profile. */
  updatedAt: string;
  /** ISO timestamp of when the account became quota-exhausted, when known. */
  exhaustedAt?: string;
  /** ISO timestamp of the next reset, when known; missing means the UI omits it. */
  resetAt?: string;
  /** Zero or more provider limit windows for this account. */
  limits: LimitWindow[];
}

/** Versioned on-disk shape of accounts.json. */
export interface AccountsFile {
  /** Schema version; must equal {@link ACCOUNTS_FILE_VERSION}. */
  version: 1;
  /** Per-provider selected account id. */
  selected: Record<ProviderId, AccountId>;
  /** Account profiles keyed by provider, then by account id. */
  accounts: Record<ProviderId, Record<AccountId, AccountProfile>>;
}

/** Result of parsing/validating an accounts file. */
export type AccountsFileResult = Result<AccountsFile>;

type Result<T> = { ok: true; value: T } | { ok: false; error: Error };
type LimitWindowResult = Result<LimitWindow>;
type AccountProfileResult = Result<AccountProfile>;

/** A fresh, empty accounts file. */
export function defaultAccountsFile(): AccountsFile {
  return { version: ACCOUNTS_FILE_VERSION, selected: {}, accounts: {} };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isDateString(value: unknown): value is string {
  return typeof value === "string" && !Number.isNaN(Date.parse(value));
}

/** Object keys that would be unsafe to rebuild into a plain object. */
function isUnsafeKey(key: string): boolean {
  return key === "__proto__" || key === "constructor" || key === "prototype";
}

function fail(path: string, message: string): { ok: false; error: Error } {
  return { ok: false, error: new Error(`${path}: ${message}`) };
}

function validateLimitWindow(value: unknown, path: string): LimitWindowResult {
  if (!isRecord(value)) return fail(path, "must be an object");
  const { name, usedPercent, windowSeconds, resetAt, updatedAt } = value;
  if (typeof name !== "string" || name.length === 0) return fail(path, "name must be a non-empty string");
  if (usedPercent !== undefined) {
    if (typeof usedPercent !== "number" || !Number.isFinite(usedPercent) || usedPercent < 0 || usedPercent > 100)
      return fail(path, "usedPercent must be a finite number between 0 and 100");
  }
  if (windowSeconds !== undefined) {
    if (typeof windowSeconds !== "number" || !Number.isFinite(windowSeconds) || windowSeconds <= 0)
      return fail(path, "windowSeconds must be a positive finite number");
  }
  if (resetAt !== undefined && !isDateString(resetAt))
    return fail(path, "resetAt must be an ISO date string when present");
  if (!isDateString(updatedAt)) return fail(path, "updatedAt must be an ISO date string");
  return {
    ok: true,
    value: {
      name,
      ...(usedPercent === undefined ? {} : { usedPercent }),
      ...(windowSeconds === undefined ? {} : { windowSeconds }),
      ...(resetAt === undefined ? {} : { resetAt }),
      updatedAt,
    },
  };
}

function validateAccountProfile(value: unknown, path: string): AccountProfileResult {
  if (!isRecord(value)) return fail(path, "must be an object");
  const { name, createdAt, updatedAt, exhaustedAt, resetAt, limits } = value;
  if (typeof name !== "string" || name.length === 0) return fail(path, "name must be a non-empty string");
  if (!isDateString(createdAt)) return fail(path, "createdAt must be an ISO date string");
  if (!isDateString(updatedAt)) return fail(path, "updatedAt must be an ISO date string");
  if (exhaustedAt !== undefined && !isDateString(exhaustedAt))
    return fail(path, "exhaustedAt must be an ISO date string when present");
  if (resetAt !== undefined && !isDateString(resetAt))
    return fail(path, "resetAt must be an ISO date string when present");
  if (!Array.isArray(limits)) return fail(path, "limits must be an array of zero or more limit windows");
  const validatedLimits: LimitWindow[] = [];
  for (const [index, window] of limits.entries()) {
    const w = validateLimitWindow(window, `${path}.limits[${index}]`);
    if (!w.ok) return w;
    validatedLimits.push(w.value);
  }
  return {
    ok: true,
    value: {
      name,
      createdAt,
      updatedAt,
      ...(exhaustedAt === undefined ? {} : { exhaustedAt }),
      ...(resetAt === undefined ? {} : { resetAt }),
      limits: validatedLimits,
    },
  };
}

/**
 * Validate an unknown value as an {@link AccountsFile} without touching disk.
 *
 * Strict: every known field is type-checked (percentages finite 0..100,
 * durations positive, timestamps parseable), unknown fields are dropped, and
 * unsafe object keys (`__proto__` and friends) are rejected.
 */
export function validateAccountsFile(value: unknown): AccountsFileResult {
  if (!isRecord(value)) return fail("accounts file", "must be a JSON object");
  if (value.version !== ACCOUNTS_FILE_VERSION) {
    return fail(
      "version",
      `unsupported version ${JSON.stringify(value.version)}; expected ${ACCOUNTS_FILE_VERSION}`,
    );
  }
  if (!("selected" in value) || !isRecord(value.selected))
    return fail("selected", "must be an object mapping provider id to account id");
  const selected: Record<ProviderId, AccountId> = {};
  for (const [provider, accountId] of Object.entries(value.selected)) {
    if (isUnsafeKey(provider)) return fail(`selected.${provider}`, "is not an allowed key");
    if (typeof accountId !== "string" || accountId.length === 0)
      return fail(`selected.${provider}`, "must be a non-empty account id string");
    selected[provider] = accountId;
  }
  if (!("accounts" in value) || !isRecord(value.accounts))
    return fail("accounts", "must be an object mapping provider id to account map");
  const accounts: Record<ProviderId, Record<AccountId, AccountProfile>> = {};
  for (const [provider, byAccount] of Object.entries(value.accounts)) {
    if (isUnsafeKey(provider)) return fail(`accounts.${provider}`, "is not an allowed key");
    if (!isRecord(byAccount)) return fail(`accounts.${provider}`, "must be an object mapping account id to profile");
    const providerAccounts: Record<AccountId, AccountProfile> = {};
    for (const [accountId, profile] of Object.entries(byAccount)) {
      if (isUnsafeKey(accountId)) return fail(`accounts.${provider}.${accountId}`, "is not an allowed key");
      if (accountId.length === 0) return fail(`accounts.${provider}`, "account id must be a non-empty string");
      const p = validateAccountProfile(profile, `accounts.${provider}.${accountId}`);
      if (!p.ok) return p;
      providerAccounts[accountId] = p.value;
    }
    accounts[provider] = providerAccounts;
  }
  return { ok: true, value: { version: ACCOUNTS_FILE_VERSION, selected, accounts } };
}

/** Parse a raw JSON string into an {@link AccountsFile} with strict validation. */
export function parseAccountsFile(raw: string): AccountsFileResult {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch (err) {
    return { ok: false, error: new Error(`invalid JSON: ${err instanceof Error ? err.message : String(err)}`) };
  }
  return validateAccountsFile(value);
}
