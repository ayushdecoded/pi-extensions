/**
 * Behavioral tests for {@link createAccountController} (`src/accounts/controller.ts`)
 * using only public behavior: a fake ExtensionAPI/ExtensionContext/model-registry
 * surface, real pi-ai base providers (so `buildAliasProvider` receives genuine
 * model/auth plumbing), and temp on-disk account stores. No source files are
 * touched.
 *
 * Coverage:
 * - root/child extension `session_start` alias registration
 * - selected-account reconciliation via `setModel`
 * - same-provider propagation parent↔child and different-provider isolation
 * - settled quota failover with exactly one continuation and no fallback notification
 * - concurrent exhaustion deduplication across parent and child
 * - cross-process store reload on `before_agent_start`
 * - alias-aware selection/auth rejection and add/rename/remove with the
 *   native-auth removal guard
 * - Codex polling/reset updates with injected fetch and clock
 */
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Model, Provider } from "@earendil-works/pi-ai";
import { openaiCodexProvider } from "@earendil-works/pi-ai/providers/openai-codex";
import { opencodeGoProvider } from "@earendil-works/pi-ai/providers/opencode-go";
import { CODEX_USAGE_URL } from "../src/accounts/codex-usage.ts";
import { createAccountController, type AccountController } from "../src/accounts/controller.ts";
import { providerIdForAccount } from "../src/accounts/providers.ts";
import { DEFAULT_ACCOUNT_KEY, type AccountProfile, type AccountsFile } from "../src/accounts/types.ts";

const CONTINUATION = "The previous account reached its usage limit. Continue the current task from the existing state without repeating completed work.";
const NOW = 1_735_000_000_000;
const iso = (ms: number): string => new Date(ms).toISOString();

const CODEX = "openai-codex" as const;
const OPENCODE = "opencode-go" as const;
const CODX_BASE_MODEL = openaiCodexProvider().getModels()[0]!;
const OPENCODE_BASE_MODEL = opencodeGoProvider().getModels()[0]!;

let now = NOW;

// ---------------------------------------------------------------------------
// Fake pi surface: ExtensionAPI + ExtensionContext + model registry
// ---------------------------------------------------------------------------

type Handler = (event: any, ctx: ExtensionContext) => unknown;

/** Minimal model-registry double keyed by provider id with per-provider auth. */
class FakeRegistry {
  readonly providers = new Map<string, Provider<any>>();
  readonly refreshOptions: unknown[] = [];
  private readonly configured = new Map<string, string>(); // providerId -> api key

  registerProvider(provider: Provider<any>): void {
    this.providers.set(provider.id, provider);
  }
  unregisterProvider(providerId: string): void {
    this.providers.delete(providerId);
  }
  getAll(): Model<any>[] {
    return [...this.providers.values()].flatMap((provider) => [...provider.getModels()]);
  }
  find(providerId: string, modelId: string): Model<any> | undefined {
    return this.providers.get(providerId)?.getModels().find((model) => model.id === modelId);
  }
  getProvider(providerId: string): Provider<any> | undefined {
    return this.providers.get(providerId);
  }
  configure(providerId: string, apiKey = "test-key"): void {
    this.configured.set(providerId, apiKey);
  }
  forget(providerId: string): void {
    this.configured.delete(providerId);
  }
  async refresh(options?: unknown): Promise<unknown> {
    this.refreshOptions.push(options);
    return {};
  }
  async getProviderAuth(providerId: string): Promise<unknown> {
    const apiKey = this.configured.get(providerId);
    return apiKey === undefined ? undefined : { auth: { apiKey, headers: {} }, source: "test" };
  }
  async getApiKeyAndHeaders(model: Model<any>): Promise<{ ok: boolean; apiKey?: string; headers?: Record<string, string>; error?: string }> {
    const apiKey = this.configured.get(model.provider);
    return apiKey === undefined ? { ok: false, error: "not configured" } : { ok: true, apiKey, headers: {} };
  }
}

/** ExtensionAPI double: event handlers, provider registration, setModel, messaging. */
class FakePi {
  readonly handlers = new Map<string, Handler[]>();
  readonly registered = new Map<string, Provider<any>>();
  readonly setModelCalls: Array<{ model: Model<any>; previous: Model<any> | undefined }> = [];
  readonly userMessages: string[] = [];
  readonly userMessageOptions: unknown[] = [];
  readonly notifications: Array<{ message: string; level: "info" | "warning" | "error" }> = [];
  readonly session: { model: Model<any> | undefined } = { model: undefined };
  setModelFailures = 0;

  constructor(readonly registry: FakeRegistry) {}

  on(event: string, handler: Handler): void {
    const list = this.handlers.get(event) ?? [];
    list.push(handler);
    this.handlers.set(event, list);
  }
  registerProvider(provider: Provider<any>): void {
    this.registered.set(provider.id, provider);
    this.registry.registerProvider(provider);
  }
  unregisterProvider(providerId: string): void {
    this.registered.delete(providerId);
    this.registry.unregisterProvider(providerId);
  }
  async setModel(model: Model<any>): Promise<boolean> {
    this.setModelCalls.push({ model, previous: this.session.model });
    if (this.setModelFailures > 0) {
      this.setModelFailures -= 1;
      return false;
    }
    this.session.model = model;
    return true;
  }
  sendUserMessage(content: string, options?: unknown): void {
    this.userMessages.push(content);
    this.userMessageOptions.push(options);
  }
  makeCtx(): ExtensionContext {
    const pi = this;
    return {
      get model() {
        return pi.session.model;
      },
      set model(value: Model<any> | undefined) {
        pi.session.model = value;
      },
      modelRegistry: this.registry,
      hasUI: true,
      mode: "tui",
      cwd: "/tmp",
      ui: {
        notify: (message: string, level: "info" | "warning" | "error") => {
          pi.notifications.push({ message, level });
        },
      },
    } as unknown as ExtensionContext;
  }
  async emit(event: string, data: unknown): Promise<void> {
    for (const handler of [...(this.handlers.get(event) ?? [])]) {
      await handler(data, this.makeCtx());
    }
  }
}

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

type Env = {
  dir: string;
  storePath: string;
  controller: AccountController;
  registry: FakeRegistry;
  rootPi: FakePi;
  childPi: FakePi;
  fetchCalls: Array<{ url: string; headers: Record<string, string> }>;
  setPayload: (payload: unknown) => void;
  dispose: () => void;
};

const created: Array<Env> = [];

beforeEach(() => {
  now = NOW;
});

afterEach(async () => {
  for (const env of created.splice(0)) {
    env.dispose();
    await rm(env.dir, { recursive: true, force: true });
  }
});

async function makeEnv(options: { seed?: AccountsFile } = {}): Promise<Env> {
  const dir = await mkdtemp(join(tmpdir(), "accounts-controller-"));
  const storePath = join(dir, "accounts.json");
  if (options.seed) await writeFile(storePath, JSON.stringify(options.seed));
  const registry = new FakeRegistry();
  registry.registerProvider(openaiCodexProvider());
  registry.registerProvider(opencodeGoProvider());
  const rootPi = new FakePi(registry);
  const childPi = new FakePi(registry);
  const fetchCalls: Array<{ url: string; headers: Record<string, string> }> = [];
  let payload: unknown = new Error("network disabled in tests");

  const fetchFn = (async (url: unknown, init?: unknown) => {
    fetchCalls.push({
      url: String(url),
      headers: (init as { headers?: Record<string, string> } | undefined)?.headers ?? {},
    });
    if (payload instanceof Error) throw payload;
    return { ok: true, status: 200, json: async () => payload } as unknown as Response;
  }) as typeof fetch;

  const controller = createAccountController(rootPi as unknown as ExtensionAPI, {
    storePath,
    fetch: fetchFn,
    now: () => now,
  });
  controller.childExtension.factory(childPi as unknown as ExtensionAPI);

  const env: Env = {
    dir,
    storePath,
    controller,
    registry,
    rootPi,
    childPi,
    fetchCalls,
    setPayload: (next) => {
      payload = next;
    },
    dispose: () => controller.dispose(),
  };
  created.push(env);
  return env;
}

const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 10));

/** Fire `session_start` (draining the root's initial poll) with a starting model. */
async function startSession(env: Env, pi: FakePi, baseModel: Model<any>): Promise<void> {
  pi.session.model = baseModel;
  await pi.emit("session_start", { reason: "startup" });
  await flush();
}

/** Fire a settled quota failure: optional provider response, then message_end, then agent_settled. */
async function quotaFailure(
  env: Env,
  pi: FakePi,
  opts: { message?: string; response?: { status: number; headers: Record<string, string> } } = {},
): Promise<void> {
  if (opts.response) await pi.emit("after_provider_response", opts.response);
  await pi.emit("message_end", {
    message: {
      role: "assistant",
      provider: pi.session.model!.provider,
      model: pi.session.model!.id,
      stopReason: "error",
      errorMessage: opts.message ?? "Usage limit reached for your account",
      content: [],
      timestamp: now,
    },
  } as any);
  await flush(); // drain any codex poll scheduled by message_end
  await pi.emit("agent_settled", {});
  await flush();
}

// ---------------------------------------------------------------------------
// Seed helpers
// ---------------------------------------------------------------------------

function profile(name: string, overrides: Partial<AccountProfile> = {}): AccountProfile {
  return { name, createdAt: iso(NOW), updatedAt: iso(NOW), limits: [], ...overrides };
}

function codexSeed(selected: string, entries: Array<[string, AccountProfile]>): AccountsFile {
  const accounts: Record<string, AccountProfile> = { [DEFAULT_ACCOUNT_KEY]: profile("Canonical") };
  for (const [id, p] of entries) accounts[id] = p;
  return { version: 1, selected: { [CODEX]: selected }, accounts: { [CODEX]: accounts } };
}

// ---------------------------------------------------------------------------
// Alias registration on session_start
// ---------------------------------------------------------------------------

test("session_start registers plan aliases for every named account on root and child extension APIs", async () => {
  const env = await makeEnv();
  const { controller } = env;
  const alpha = await controller.add(CODEX, "Alpha");
  const beta = await controller.add(CODEX, "Beta");
  const gamma = await controller.add(OPENCODE, "Gamma");

  await env.rootPi.emit("session_start", { reason: "startup" });
  await env.childPi.emit("session_start", { reason: "startup" });
  await flush();

  for (const pi of [env.rootPi, env.childPi]) {
    assert.deepEqual(
      new Set(pi.registered.keys()),
      new Set([
        providerIdForAccount(CODEX, alpha.accountId),
        providerIdForAccount(CODEX, beta.accountId),
        providerIdForAccount(OPENCODE, gamma.accountId),
      ]),
    );
    const codexAlias = providerIdForAccount(CODEX, alpha.accountId);
    assert.match(codexAlias, /^plan:openai-codex:[0-9a-f]{16}$/);
    assert.equal(pi.registered.get(codexAlias)?.name, "Codex · Alpha");
    assert.equal(pi.registered.get(providerIdForAccount(CODEX, beta.accountId))?.name, "Codex · Beta");
    assert.equal(pi.registered.get(providerIdForAccount(OPENCODE, gamma.accountId))?.name, "OpenCode Go · Gamma");
  }
  // The canonical default account is never aliased.
  assert.equal(env.rootPi.registered.has(CODEX), false);
  assert.equal(env.childPi.registered.has(OPENCODE), false);
});

// ---------------------------------------------------------------------------
// Selected-account reconciliation via setModel
// ---------------------------------------------------------------------------

test("session_start reconciles the selected account through setModel on root and child", async () => {
  const env = await makeEnv({
    seed: codexSeed("acct-a", [
      ["acct-a", profile("Alpha")],
      ["acct-b", profile("Beta")],
    ]),
  });
  const aliasA = providerIdForAccount(CODEX, "acct-a");
  const aliasB = providerIdForAccount(CODEX, "acct-b");
  env.registry.configure(aliasA);
  env.registry.configure(aliasB);

  env.rootPi.session.model = CODX_BASE_MODEL;
  await env.rootPi.emit("session_start", { reason: "startup" });
  await flush();
  assert.equal(env.rootPi.session.model?.provider, aliasA);
  assert.equal(env.rootPi.session.model?.id, CODX_BASE_MODEL.id);
  assert.deepEqual(env.rootPi.setModelCalls.map((c) => c.model.provider), [aliasA]);

  await startSession(env, env.childPi, CODX_BASE_MODEL);
  assert.equal(env.childPi.session.model?.provider, aliasA);
  // The child's start re-syncs aliases but never disturbs the root session.
  assert.equal(env.rootPi.session.model?.provider, aliasA);
  assert.deepEqual(env.rootPi.setModelCalls.map((c) => c.model.provider), [aliasA]);
  assert.equal(env.rootPi.registered.has(aliasB), true);
});

test("session_start refreshes Pi's auth snapshot and retries a cold alias switch", async () => {
  const env = await makeEnv({ seed: codexSeed("acct-a", [["acct-a", profile("Alpha")]]) });
  const aliasA = providerIdForAccount(CODEX, "acct-a");
  env.registry.configure(aliasA);
  env.rootPi.session.model = CODX_BASE_MODEL;
  env.rootPi.setModelFailures = 1;

  await env.rootPi.emit("session_start", { reason: "startup" });
  await flush();

  assert.equal(env.rootPi.session.model?.provider, aliasA);
  assert.deepEqual(env.rootPi.setModelCalls.map((call) => call.model.provider), [aliasA, aliasA]);
  assert.deepEqual(env.registry.refreshOptions, [{ allowNetwork: false }]);
});

test("a native child routes its initial model and attaches without session_start", async () => {
  const env = await makeEnv({
    seed: codexSeed("acct-a", [
      ["acct-a", profile("Alpha")],
      ["acct-b", profile("Beta")],
    ]),
  });
  const aliasA = providerIdForAccount(CODEX, "acct-a");
  const aliasB = providerIdForAccount(CODEX, "acct-b");
  env.registry.configure(aliasA);
  env.registry.configure(aliasB);
  await startSession(env, env.rootPi, CODX_BASE_MODEL);

  // This mirrors SDK-created children: the inline factory runs while resources
  // load, the initial model is routed before createAgentSession, and only
  // before_agent_start is emitted.
  const child = new FakePi(env.registry);
  env.controller.childExtension.factory(child as unknown as ExtensionAPI);
  child.session.model = env.controller.routeModel(CODX_BASE_MODEL);
  assert.equal(child.registered.has(aliasA), true);
  assert.equal(child.registered.has(aliasB), true);
  assert.equal(child.session.model.provider, aliasA);
  await child.emit("before_agent_start", { prompt: "do work" });

  await env.controller.select(CODEX, "acct-b", env.rootPi.makeCtx());
  assert.equal(env.rootPi.session.model?.provider, aliasB);
  assert.equal(child.session.model.provider, aliasB);
});

test("routeModel changes only supported providers and preserves model ids", async () => {
  const env = await makeEnv({ seed: codexSeed("acct-a", [["acct-a", profile("Alpha")]]) });
  await startSession(env, env.rootPi, CODX_BASE_MODEL);
  const routed = env.controller.routeModel(CODX_BASE_MODEL);
  assert.equal(routed.provider, providerIdForAccount(CODEX, "acct-a"));
  assert.equal(routed.id, CODX_BASE_MODEL.id);
  const unrelated = { ...CODX_BASE_MODEL, provider: "anthropic" };
  assert.equal(env.controller.routeModel(unrelated), unrelated);
});

// ---------------------------------------------------------------------------
// Same-provider propagation / different-provider isolation
// ---------------------------------------------------------------------------

test("select propagates to parent and child attachments on the same provider", async () => {
  const env = await makeEnv({
    seed: codexSeed("acct-a", [
      ["acct-a", profile("Alpha")],
      ["acct-b", profile("Beta")],
    ]),
  });
  const aliasA = providerIdForAccount(CODEX, "acct-a");
  const aliasB = providerIdForAccount(CODEX, "acct-b");
  env.registry.configure(aliasA);
  env.registry.configure(aliasB);
  await startSession(env, env.rootPi, CODX_BASE_MODEL);
  await startSession(env, env.childPi, CODX_BASE_MODEL);
  assert.equal(env.rootPi.session.model?.provider, aliasA);
  assert.equal(env.childPi.session.model?.provider, aliasA);

  await env.controller.select(CODEX, "acct-b", env.rootPi.makeCtx());

  assert.equal(env.rootPi.session.model?.provider, aliasB);
  assert.equal(env.childPi.session.model?.provider, aliasB);
  assert.deepEqual(env.rootPi.setModelCalls.map((c) => c.model.provider), [aliasA, aliasB]);
  assert.deepEqual(env.childPi.setModelCalls.map((c) => c.model.provider), [aliasA, aliasB]);
  assert.equal(env.controller.selectedProviderId(CODEX), aliasB);
});

test("select on one provider never reconciles sessions on the other provider", async () => {
  const env = await makeEnv({
    seed: {
      version: 1,
      selected: { [CODEX]: "acct-a", [OPENCODE]: "acct-g1" },
      accounts: {
        [CODEX]: {
          [DEFAULT_ACCOUNT_KEY]: profile("Canonical"),
          "acct-a": profile("Alpha"),
          "acct-b": profile("Beta"),
        },
        [OPENCODE]: {
          [DEFAULT_ACCOUNT_KEY]: profile("Canonical"),
          "acct-g1": profile("Go One"),
          "acct-g2": profile("Go Two"),
        },
      },
    },
  });
  const aliasA = providerIdForAccount(CODEX, "acct-a");
  const aliasB = providerIdForAccount(CODEX, "acct-b");
  const aliasG1 = providerIdForAccount(OPENCODE, "acct-g1");
  const aliasG2 = providerIdForAccount(OPENCODE, "acct-g2");
  for (const id of [aliasA, aliasB, aliasG1, aliasG2]) env.registry.configure(id);

  await startSession(env, env.rootPi, CODX_BASE_MODEL); // root on codex
  await startSession(env, env.childPi, OPENCODE_BASE_MODEL); // child on opencode
  assert.equal(env.rootPi.session.model?.provider, aliasA);
  assert.equal(env.childPi.session.model?.provider, aliasG1);

  // Switching the opencode account touches only the child.
  await env.controller.select(OPENCODE, "acct-g2", env.childPi.makeCtx());
  assert.equal(env.childPi.session.model?.provider, aliasG2);
  assert.equal(env.rootPi.session.model?.provider, aliasA);
  assert.equal(env.rootPi.setModelCalls.length, 1);
  assert.equal(env.childPi.setModelCalls.length, 2);

  // Switching the codex account touches only the root.
  await env.controller.select(CODEX, "acct-b", env.rootPi.makeCtx());
  assert.equal(env.rootPi.session.model?.provider, aliasB);
  assert.equal(env.childPi.session.model?.provider, aliasG2);
  assert.equal(env.rootPi.setModelCalls.length, 2);
  assert.equal(env.childPi.setModelCalls.length, 2);
});

// ---------------------------------------------------------------------------
// Settled quota failover: exactly one continuation, no fallback notification
// ---------------------------------------------------------------------------

test("settled quota failure fails over to a healthy configured account with exactly one continuation", async () => {
  const env = await makeEnv({
    seed: codexSeed("acct-a", [
      ["acct-a", profile("Alpha")],
      ["acct-b", profile("Beta")],
      ["acct-c", profile("Gamma")],
    ]),
  });
  const aliasA = providerIdForAccount(CODEX, "acct-a");
  const aliasB = providerIdForAccount(CODEX, "acct-b");
  env.registry.configure(aliasA);
  env.registry.configure(aliasB); // default and acct-c deliberately unconfigured
  await startSession(env, env.rootPi, CODX_BASE_MODEL);
  assert.equal(env.rootPi.session.model?.provider, aliasA);

  await quotaFailure(env, env.rootPi, {
    response: { status: 429, headers: { "x-ratelimit-remaining": "0", "retry-after": "60" } },
  });

  assert.deepEqual(env.rootPi.userMessages, [CONTINUATION]);
  assert.deepEqual(env.rootPi.userMessageOptions, [{ deliverAs: "followUp" }]);
  assert.equal(env.rootPi.session.model?.provider, aliasB);
  assert.equal(env.controller.selectedProviderId(CODEX), aliasB);
  const a = env.controller.accounts(CODEX).find((acc) => acc.id === "acct-a");
  assert.equal(a?.exhausted, true);
  assert.equal(a?.resetAt, iso(now + 60_000)); // retry-after guidance honored
  assert.equal(env.controller.accounts(CODEX).find((acc) => acc.id === "acct-c")?.selected, false);

  // A second agent_settled without a fresh failure sends no second continuation.
  await env.rootPi.emit("agent_settled", {});
  assert.deepEqual(env.rootPi.userMessages, [CONTINUATION]);
});

test("quota failure with no healthy configured candidate warns and never continues", async () => {
  const env = await makeEnv({
    seed: codexSeed("acct-a", [["acct-a", profile("Alpha")]]),
  });
  const aliasA = providerIdForAccount(CODEX, "acct-a");
  env.registry.configure(aliasA); // only the exhausted account is configured
  await startSession(env, env.rootPi, CODX_BASE_MODEL);

  await quotaFailure(env, env.rootPi);

  assert.deepEqual(env.rootPi.userMessages, []);
  assert.ok(
    env.rootPi.notifications.some(
      (n) => n.level === "warning" && /All authenticated Codex accounts are exhausted/.test(n.message),
    ),
  );
  assert.equal(env.controller.selectedProviderId(CODEX), aliasA); // selection unchanged
  assert.equal(env.controller.accounts(CODEX).find((acc) => acc.id === "acct-a")?.exhausted, true);
});

// ---------------------------------------------------------------------------
// Concurrent exhaustion deduplication
// ---------------------------------------------------------------------------

test("concurrent quota failures across parent and child deduplicate the failover switch", async () => {
  const env = await makeEnv({
    seed: codexSeed("acct-a", [
      ["acct-a", profile("Alpha")],
      ["acct-b", profile("Beta")],
      ["acct-c", profile("Gamma")],
    ]),
  });
  const aliasA = providerIdForAccount(CODEX, "acct-a");
  const aliasB = providerIdForAccount(CODEX, "acct-b");
  for (const id of [aliasA, aliasB, providerIdForAccount(CODEX, "acct-c")]) env.registry.configure(id);
  await startSession(env, env.rootPi, CODX_BASE_MODEL);
  await startSession(env, env.childPi, CODX_BASE_MODEL);
  assert.equal(env.rootPi.session.model?.provider, aliasA);
  assert.equal(env.childPi.session.model?.provider, aliasA);

  // Both sessions observe the same exhausted assistant message.
  const failure = { role: "assistant", provider: aliasA, model: CODX_BASE_MODEL.id, stopReason: "error", errorMessage: "Usage limit reached for your account", content: [], timestamp: now };
  await env.rootPi.emit("message_end", { message: failure } as any);
  await env.childPi.emit("message_end", { message: failure } as any);
  await flush();
  await Promise.all([env.rootPi.emit("agent_settled", {}), env.childPi.emit("agent_settled", {})]);
  await flush();

  // One switch only: acct-a exhausted, acct-b selected, acct-c never selected.
  assert.equal(env.controller.selectedProviderId(CODEX), aliasB);
  assert.equal(env.controller.accounts(CODEX).find((acc) => acc.id === "acct-a")?.exhausted, true);
  assert.equal(env.controller.accounts(CODEX).find((acc) => acc.id === "acct-c")?.selected, false);
  assert.equal(env.controller.accounts(CODEX).find((acc) => acc.id === "acct-b")?.selected, true);
  // Exactly one continuation per session.
  assert.deepEqual(env.rootPi.userMessages, [CONTINUATION]);
  assert.deepEqual(env.childPi.userMessages, [CONTINUATION]);

  // On-disk state matches the coordinator view.
  const onDisk = JSON.parse(await readFile(env.storePath, "utf8")) as AccountsFile;
  assert.equal(onDisk.selected[CODEX], "acct-b");
});

// ---------------------------------------------------------------------------
// Cross-process reload on before_agent_start
// ---------------------------------------------------------------------------

test("before_agent_start reloads externally written store state and reconciles", async () => {
  const env = await makeEnv({
    seed: codexSeed("acct-a", [["acct-a", profile("Alpha")]]),
  });
  const aliasA = providerIdForAccount(CODEX, "acct-a");
  const aliasB = providerIdForAccount(CODEX, "acct-b");
  env.registry.configure(aliasA);
  env.registry.configure(aliasB);
  await startSession(env, env.rootPi, CODX_BASE_MODEL);
  await startSession(env, env.childPi, CODX_BASE_MODEL);
  assert.equal(env.rootPi.session.model?.provider, aliasA);
  assert.equal(env.childPi.registered.size, 1); // child aliases registered at its own session_start

  // Another process adds acct-b and selects it, bypassing this controller.
  await writeFile(
    env.storePath,
    JSON.stringify(
      codexSeed("acct-b", [
        ["acct-a", profile("Alpha")],
        ["acct-b", profile("Beta")],
      ]),
    ),
  );

  await env.rootPi.emit("before_agent_start", { prompt: "fix the bug", systemPrompt: "" });
  await flush();

  assert.equal(env.rootPi.registered.has(aliasB), true);
  assert.equal(env.childPi.registered.has(aliasB), true); // aliases re-synced on every attachment
  assert.equal(env.rootPi.session.model?.provider, aliasB);
  assert.equal(env.controller.selectedProviderId(CODEX), aliasB);
});

// ---------------------------------------------------------------------------
// Alias-aware selection and auth rejection
// ---------------------------------------------------------------------------

test("select rejects unconfigured and unknown accounts without changing selection", async () => {
  const env = await makeEnv({
    seed: codexSeed("acct-a", [
      ["acct-a", profile("Alpha")],
      ["acct-b", profile("Beta")],
    ]),
  });
  const aliasA = providerIdForAccount(CODEX, "acct-a");
  const aliasB = providerIdForAccount(CODEX, "acct-b");
  // Configure the *base* provider but NOT the aliases: alias auth is what counts.
  env.registry.configure(CODEX);
  await startSession(env, env.rootPi, CODX_BASE_MODEL);
  // Session stays on the base model because the selected account's alias is unauthenticated.
  assert.equal(env.rootPi.session.model?.provider, CODEX);
  assert.equal(env.rootPi.session.model?.id, CODX_BASE_MODEL.id);

  await assert.rejects(env.controller.select(CODEX, "acct-a", env.rootPi.makeCtx()), /not logged in/);
  await assert.rejects(env.controller.select(CODEX, "ghost", env.rootPi.makeCtx()), /not logged in/);
  assert.equal(env.controller.selectedProviderId(CODEX), aliasA); // selection unchanged
  assert.equal(env.rootPi.session.model?.provider, CODEX);

  // Once the alias is authenticated, select works and reconciles the session.
  env.registry.configure(aliasA);
  env.registry.configure(aliasB);
  await env.controller.select(CODEX, "acct-b", env.rootPi.makeCtx());
  assert.equal(env.rootPi.session.model?.provider, aliasB);
  assert.equal(env.controller.selectedProviderId(CODEX), aliasB);
});

// ---------------------------------------------------------------------------
// add / rename / remove with the native-auth removal guard
// ---------------------------------------------------------------------------

test("add registers aliases everywhere, rename refreshes names, remove is guarded by native auth", async () => {
  const env = await makeEnv({
    seed: codexSeed("acct-a", [["acct-a", profile("Alpha")]]),
  });
  await startSession(env, env.rootPi, CODX_BASE_MODEL);
  await startSession(env, env.childPi, CODX_BASE_MODEL);

  const { accountId, providerId } = await env.controller.add(CODEX, "Delta");
  assert.match(providerId, /^plan:openai-codex:[0-9a-f]{16}$/);
  for (const pi of [env.rootPi, env.childPi]) {
    assert.equal(pi.registered.get(providerId)?.name, "Codex · Delta");
  }

  await env.controller.rename(CODEX, accountId, "Delta Prime");
  for (const pi of [env.rootPi, env.childPi]) {
    assert.equal(pi.registered.get(providerId)?.name, "Codex · Delta Prime");
  }

  // Native (alias) auth still present → removal refused.
  env.registry.configure(providerId);
  await assert.rejects(
    env.controller.remove(CODEX, accountId, env.rootPi.makeCtx()),
    /Log out .* with \/logout before removing it/,
  );
  assert.ok(env.controller.accounts(CODEX).some((acc) => acc.id === accountId));
  assert.ok(env.rootPi.registered.has(providerId));

  // After logout (alias no longer configured), removal unregisters everywhere.
  env.registry.forget(providerId);
  await env.controller.remove(CODEX, accountId, env.rootPi.makeCtx());
  assert.ok(!env.controller.accounts(CODEX).some((acc) => acc.id === accountId));
  assert.equal(env.rootPi.registered.has(providerId), false);
  assert.equal(env.childPi.registered.has(providerId), false);
});

// ---------------------------------------------------------------------------
// before_agent_start attempted-set semantics
// ---------------------------------------------------------------------------

test("continuation prompts preserve the attempted set so a recovered account is not re-selected", async () => {
  const env = await makeEnv({
    seed: codexSeed("acct-a", [
      ["acct-a", profile("Alpha")],
      ["acct-b", profile("Beta")],
      ["acct-c", profile("Gamma")],
    ]),
  });
  const aliasA = providerIdForAccount(CODEX, "acct-a");
  const aliasB = providerIdForAccount(CODEX, "acct-b");
  const aliasC = providerIdForAccount(CODEX, "acct-c");
  for (const id of [aliasA, aliasB, aliasC]) env.registry.configure(id);
  await startSession(env, env.rootPi, CODX_BASE_MODEL);

  // acct-a fails with a short reset window.
  await quotaFailure(env, env.rootPi, { message: "Usage limit reached for your account; resets in 5 seconds." });
  assert.equal(env.rootPi.session.model?.provider, aliasB);
  assert.deepEqual(env.rootPi.userMessages, [CONTINUATION]);

  // The reset elapses: acct-a is healthy again.
  now += 6_000;

  // The continuation arrives — the attempted set is preserved.
  await env.rootPi.emit("before_agent_start", { prompt: CONTINUATION, systemPrompt: "" });
  await flush();

  // acct-b now fails too; acct-a is deliberately excluded even though it recovered.
  await quotaFailure(env, env.rootPi);
  assert.equal(env.controller.selectedProviderId(CODEX), aliasC);
  assert.deepEqual(env.rootPi.userMessages, [CONTINUATION, CONTINUATION]);
});

test("a fresh prompt clears the attempted set, allowing a recovered account to be re-selected", async () => {
  const env = await makeEnv({
    seed: codexSeed("acct-a", [
      ["acct-a", profile("Alpha")],
      ["acct-b", profile("Beta")],
      ["acct-c", profile("Gamma")],
    ]),
  });
  const aliasA = providerIdForAccount(CODEX, "acct-a");
  const aliasB = providerIdForAccount(CODEX, "acct-b");
  const aliasC = providerIdForAccount(CODEX, "acct-c");
  for (const id of [aliasA, aliasB, aliasC]) env.registry.configure(id);
  await startSession(env, env.rootPi, CODX_BASE_MODEL);

  await quotaFailure(env, env.rootPi, { message: "Usage limit reached for your account; resets in 5 seconds." });
  now += 6_000;

  // A normal prompt resets the attempted set.
  await env.rootPi.emit("before_agent_start", { prompt: "refactor the parser", systemPrompt: "" });
  await flush();

  await quotaFailure(env, env.rootPi);
  assert.equal(env.controller.selectedProviderId(CODEX), aliasA); // recovered account eligible again
});

// ---------------------------------------------------------------------------
// Codex polling with injected fetch and clock
// ---------------------------------------------------------------------------

test("codex polling fetches usage on the injected schedule and stores near-reset limits", async () => {
  // acct-a is selected AND exhausted with a profile-level reset ~90s out: the
  // near-reset cadence is driven by that profile resetAt, not window resets.
  const env = await makeEnv({
    seed: codexSeed("acct-a", [
      ["acct-a", profile("Alpha", { exhaustedAt: iso(NOW), resetAt: iso(NOW + 90_000) })],
    ]),
  });
  const aliasA = providerIdForAccount(CODEX, "acct-a");
  env.registry.configure(aliasA);

  env.setPayload({
    rate_limit: {
      primary: {
        used_percent: 100,
        limit_window_seconds: 3600,
        reset_at: Math.floor((now + 90_000) / 1000),
      },
    },
  });

  await startSession(env, env.rootPi, CODX_BASE_MODEL); // session_start schedules the first poll
  assert.equal(env.rootPi.session.model?.provider, aliasA);
  assert.equal(env.fetchCalls.length, 1);
  assert.equal(env.fetchCalls[0]?.url, CODEX_USAGE_URL);
  assert.ok((env.fetchCalls[0]?.headers["Authorization"] ?? "").startsWith("Bearer "));
  const a = env.controller.accounts(CODEX).find((acc) => acc.id === "acct-a");
  assert.equal(a?.limits[0]?.usedPercent, 100);
  assert.equal(a?.limits[0]?.resetAt, iso(now + 90_000));
  assert.equal(a?.exhausted, true); // 100% window keeps the profile-level exhaustion

  // Near-reset accounts poll every 30s: +31s triggers another fetch.
  env.setPayload({ rate_limit: { primary: { used_percent: 50, limit_window_seconds: 3600 } } });
  now += 31_000;
  await env.rootPi.emit("message_end", { message: { role: "assistant", stopReason: "stop", content: [], timestamp: now } } as any);
  await flush();
  assert.equal(env.fetchCalls.length, 2);
  const refreshed = env.controller.accounts(CODEX).find((acc) => acc.id === "acct-a");
  assert.equal(refreshed?.limits[0]?.usedPercent, 50);
  assert.equal(refreshed?.exhausted, false); // healthy window clears the exhaustion marker

  // Healthy limits push the interval to 5 minutes: +31s does NOT fetch...
  now += 31_000;
  await env.rootPi.emit("message_end", { message: { role: "assistant", stopReason: "stop", content: [], timestamp: now } } as any);
  await flush();
  assert.equal(env.fetchCalls.length, 2);

  // ...but +5min does.
  now += 5 * 60_000 + 1_000;
  await env.rootPi.emit("message_end", { message: { role: "assistant", stopReason: "stop", content: [], timestamp: now } } as any);
  await flush();
  assert.equal(env.fetchCalls.length, 3);
});

test("codex polling clears exhaustion markers when a reset window reports healthy usage", async () => {
  const env = await makeEnv({
    seed: codexSeed("acct-a", [
      ["acct-a", profile("Alpha", { exhaustedAt: iso(NOW), resetAt: iso(NOW + 60_000) })],
    ]),
  });
  const aliasA = providerIdForAccount(CODEX, "acct-a");
  env.registry.configure(aliasA);
  env.setPayload({ rate_limit: { primary: { used_percent: 40, limit_window_seconds: 3600 } } });

  await env.rootPi.emit("session_start", { reason: "startup" }); // no flush yet: poll is pending
  // The coordinator has loaded the seeded exhausted state before the poll runs.
  const a = env.controller.accounts(CODEX).find((acc) => acc.id === "acct-a");
  assert.equal(a?.exhausted, true);
  assert.equal(env.fetchCalls.length, 0);

  await flush(); // run the initial poll
  const refreshed = env.controller.accounts(CODEX).find((acc) => acc.id === "acct-a");
  assert.equal(refreshed?.exhausted, false);
  assert.equal(refreshed?.resetAt, undefined);
  assert.equal(refreshed?.limits[0]?.usedPercent, 40);
});
