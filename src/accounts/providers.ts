/**
 * Plan-provider aliases: supported plan specs, alias id helpers, and a native
 * Provider alias builder.
 *
 * A plan alias is a pi `Provider` with a new provider id and display name whose
 * models are remapped to that alias, while every runtime behavior — auth,
 * streaming, deferred responses, model refresh, and model filtering — is
 * reused from the built-in base provider. No OAuth flow, credential store, or
 * HTTP transport is implemented here: the alias shares the base provider's
 * `auth` object and exposes the base provider's own stream/deferred methods
 * directly, so requests are dispatched exactly as the built-in provider would.
 *
 * Alias ids are stable and collision-resistant: `plan:<base>:<sha256(accountId)`
 * first 16 hex chars>. The account id is supplied externally (for example the
 * ChatGPT account id from the Codex JWT) and is never reversed from an alias.
 */
import { createHash } from "node:crypto";
import type { Api, Model, Provider } from "@earendil-works/pi-ai";

/** Namespace marker embedded in every plan alias provider id. */
export const PLAN_NAMESPACE = "plan";

/**
 * Stable account id used when no external account id is supplied. Aliases
 * built for the default account are deterministic and share one provider id.
 */
export const DEFAULT_ACCOUNT_ID = "default";

/**
 * Alias provider id shape: `plan:<base>:<16 hex chars>`. The suffix is a
 * truncated sha256 of the stable account id, so ids are collision-resistant
 * while remaining parseable.
 */
export const ALIAS_ID_PATTERN = /^plan:([a-z0-9-]+):([0-9a-f]{16})$/;

/**
 * Built-in base provider ids supported as plan aliases. Kept in sync with the
 * coordinator's `SUPPORTED_PROVIDERS` in `./types.ts`.
 */
export type PlanBaseProviderId = "openai-codex" | "opencode-go";

/** Spec for one supported plan provider. */
export interface PlanProviderSpec {
  /** Built-in provider id this plan aliases. */
  base: PlanBaseProviderId;
  /** Human display label used as the alias display-name prefix. */
  label: string;
}

/** Supported plan-provider specs. */
export const PLAN_PROVIDERS: Readonly<Record<PlanBaseProviderId, PlanProviderSpec>> = {
  "openai-codex": { base: "openai-codex", label: "Codex" },
  "opencode-go": { base: "opencode-go", label: "OpenCode Go" },
};

/** Supported base provider ids, in declaration order. */
export const PLAN_BASE_PROVIDER_IDS: readonly PlanBaseProviderId[] = ["openai-codex", "opencode-go"];

/** True when `base` names a supported plan base provider. */
export function isSupportedPlanBase(base: string): base is PlanBaseProviderId {
  return base === "openai-codex" || base === "opencode-go";
}

/** True when `providerId` is structurally a plan alias id. */
export function isPlanAliasId(providerId: string): boolean {
  return ALIAS_ID_PATTERN.test(providerId);
}

/** Base provider id embedded in an alias id; undefined when not an alias. */
export function planBaseProviderId(providerId: string): string | undefined {
  const match = ALIAS_ID_PATTERN.exec(providerId);
  return match ? match[1] : undefined;
}

/** Stable account discriminator embedded in an alias id. */
export function aliasAccountDiscriminator(providerId: string): string | undefined {
  const match = ALIAS_ID_PATTERN.exec(providerId);
  return match ? match[2] : undefined;
}

/** Canonical provider id: alias ids resolve to their base, others unchanged. */
export function canonicalProviderId(providerId: string): string {
  return planBaseProviderId(providerId) ?? providerId;
}

/** Resolved account identity for a provider id. */
export interface PlanAccount {
  /** Canonical (base) provider id. */
  canonical: string;
  /** Stable account discriminator, or `DEFAULT_ACCOUNT_ID` for base providers. */
  account: string;
}

/**
 * Map any provider id to its canonical provider and account. Base provider
 * ids and unknown providers resolve to the default account; aliases resolve
 * to their base provider and embedded account discriminator.
 */
export function resolvePlanAccount(providerId: string): PlanAccount {
  const base = planBaseProviderId(providerId);
  if (base === undefined) return { canonical: providerId, account: DEFAULT_ACCOUNT_ID };
  return { canonical: base, account: aliasAccountDiscriminator(providerId) ?? DEFAULT_ACCOUNT_ID };
}

/**
 * Stable, collision-resistant alias provider id derived from an externally
 * supplied stable account id. Deterministic: the same (spec, accountId) pair
 * always yields the same id, and distinct account ids yield distinct ids.
 */
export function aliasProviderId(spec: PlanProviderSpec, accountId: string = DEFAULT_ACCOUNT_ID): string {
  return `${PLAN_NAMESPACE}:${spec.base}:${accountHash(accountId)}`;
}

/** Default display name for an alias of `spec` for `accountId`. */
export function aliasProviderName(spec: PlanProviderSpec, accountId: string = DEFAULT_ACCOUNT_ID): string {
  return accountId === DEFAULT_ACCOUNT_ID ? spec.label : `${spec.label} · ${accountHash(accountId).slice(0, 8)}`;
}

/** Provider id used by one account; the default account keeps Pi's canonical provider id. */
export function providerIdForAccount(base: PlanBaseProviderId, accountId: string): string {
  return accountId === DEFAULT_ACCOUNT_ID ? base : aliasProviderId(PLAN_PROVIDERS[base], accountId);
}

function accountHash(accountId: string): string {
  return createHash("sha256").update(accountId, "utf8").digest("hex").slice(0, 16);
}

/** Inputs for {@link buildAliasProvider}. */
export interface BuildAliasProviderInput<TApi extends Api> {
  /** Base provider instance from a built-in factory. Must match `spec.base`. */
  base: Provider<TApi>;
  /** Plan spec the alias implements. */
  spec: PlanProviderSpec;
  /** Stable external account id; drives the alias id and display name. */
  accountId?: string;
  /** Explicit display name override. Defaults to {@link aliasProviderName}. */
  displayName?: string;
  /** Explicit alias id override. Defaults to {@link aliasProviderId}. */
  aliasId?: string;
}

/**
 * Build a native Provider alias of `base` under a new provider id/name.
 *
 * Models returned by the alias are remapped to the alias id (same ids, apis,
 * base urls, costs, and compat); `auth` is the base provider's auth object
 * (identity shared), and stream, streamSimple, deferred, refresh, and filter
 * behavior are the base provider's own functions — no custom OAuth, credential
 * store, or transport is introduced.
 *
 * Throws when `base.id` does not match `spec.base`.
 */
export function buildAliasProvider<TApi extends Api>(input: BuildAliasProviderInput<TApi>): Provider<TApi> {
  const { base, spec, accountId, displayName, aliasId } = input;
  if (base.id !== spec.base) {
    throw new Error(`Plan alias base mismatch: base provider id "${base.id}" does not match spec base "${spec.base}"`);
  }
  const id = aliasId ?? aliasProviderId(spec, accountId);
  const name = displayName ?? aliasProviderName(spec, accountId);
  const remap = (model: Model<TApi>): Model<TApi> => ({ ...model, provider: id });
  return {
    id,
    name,
    auth: base.auth,
    // Live remap: dynamic base model refreshes are reflected on every read.
    getModels: () => base.getModels().map(remap),
    stream: base.stream,
    streamSimple: base.streamSimple,
    ...(base.baseUrl !== undefined ? { baseUrl: base.baseUrl } : {}),
    ...(base.headers !== undefined ? { headers: base.headers } : {}),
    ...(base.filterModels !== undefined ? { filterModels: base.filterModels } : {}),
    ...(base.refreshModels !== undefined ? { refreshModels: base.refreshModels } : {}),
    ...(base.fetchDeferred !== undefined ? { fetchDeferred: base.fetchDeferred } : {}),
    ...(base.cancelDeferred !== undefined ? { cancelDeferred: base.cancelDeferred } : {}),
  };
}
