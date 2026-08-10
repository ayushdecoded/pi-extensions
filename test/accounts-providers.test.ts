import assert from "node:assert/strict";
import { test } from "node:test";
import type { Api, Context, Model, Provider } from "@earendil-works/pi-ai";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import { openaiCodexProvider } from "@earendil-works/pi-ai/providers/openai-codex";
import { opencodeGoProvider } from "@earendil-works/pi-ai/providers/opencode-go";
import {
  ALIAS_ID_PATTERN,
  DEFAULT_ACCOUNT_ID,
  PLAN_BASE_PROVIDER_IDS,
  PLAN_PROVIDERS,
  aliasAccountDiscriminator,
  aliasProviderId,
  aliasProviderName,
  buildAliasProvider,
  canonicalProviderId,
  isPlanAliasId,
  isSupportedPlanBase,
  planBaseProviderId,
  resolvePlanAccount,
} from "../src/accounts/providers.ts";
import type { PlanProviderSpec } from "../src/accounts/providers.ts";

test("supported plan-provider specs cover both base providers", () => {
  assert.deepEqual([...PLAN_BASE_PROVIDER_IDS].sort(), ["openai-codex", "opencode-go"]);
  assert.deepEqual(Object.keys(PLAN_PROVIDERS).sort(), ["openai-codex", "opencode-go"]);
  assert.equal(PLAN_PROVIDERS["openai-codex"].base, "openai-codex");
  assert.equal(PLAN_PROVIDERS["opencode-go"].base, "opencode-go");
  assert.ok(PLAN_PROVIDERS["openai-codex"].label.length > 0);
  assert.ok(PLAN_PROVIDERS["opencode-go"].label.length > 0);
  assert.equal(isSupportedPlanBase("openai-codex"), true);
  assert.equal(isSupportedPlanBase("opencode-go"), true);
  assert.equal(isSupportedPlanBase("anthropic"), false);
});

test("alias ids are stable, collision-resistant, and derived from the account id", () => {
  const codex = PLAN_PROVIDERS["openai-codex"];
  const a = aliasProviderId(codex, "acct-uuid-1");
  const b = aliasProviderId(codex, "acct-uuid-1");
  const c = aliasProviderId(codex, "acct-uuid-2");
  assert.equal(a, b); // stable per account
  assert.notEqual(a, c); // distinct accounts diverge
  assert.match(a, ALIAS_ID_PATTERN);
  assert.equal(planBaseProviderId(a), "openai-codex");
  const go = PLAN_PROVIDERS["opencode-go"];
  assert.notEqual(aliasProviderId(codex, "x"), aliasProviderId(go, "x"));
  // default account is stable and explicit
  const d = aliasProviderId(codex);
  assert.equal(d, aliasProviderId(codex, DEFAULT_ACCOUNT_ID));
  assert.equal(d, aliasProviderId(codex));
});

test("alias id helpers recognize aliases and map them back to the base provider", () => {
  const alias = aliasProviderId(PLAN_PROVIDERS["openai-codex"], "acct-1");
  assert.equal(isPlanAliasId(alias), true);
  assert.equal(planBaseProviderId(alias), "openai-codex");
  assert.equal(aliasAccountDiscriminator(alias), alias.split(":")[2]);
  assert.equal(canonicalProviderId(alias), "openai-codex");
  assert.equal(canonicalProviderId("openai-codex"), "openai-codex");
  assert.equal(canonicalProviderId("opencode-go"), "opencode-go");
  assert.equal(canonicalProviderId("anthropic"), "anthropic");
  // base ids are not aliases
  assert.equal(isPlanAliasId("openai-codex"), false);
  assert.equal(isPlanAliasId("opencode-go"), false);
  assert.equal(planBaseProviderId("openai-codex"), undefined);
  // structural recognition tolerates future bases; mapping stays structural
  assert.equal(isPlanAliasId("plan:anthropic:abcdef0123456789"), true);
  assert.equal(planBaseProviderId("plan:anthropic:abcdef0123456789"), "anthropic");
  // malformed ids are rejected
  assert.equal(isPlanAliasId("plan:openai-codex:xyz"), false);
  assert.equal(isPlanAliasId("plan:openai-codex"), false);
  assert.equal(isPlanAliasId("plan::abcdef0123456789"), false);
  assert.equal(isPlanAliasId(""), false);
});

test("resolvePlanAccount returns the canonical base and default account", () => {
  assert.deepEqual(resolvePlanAccount("openai-codex"), { canonical: "openai-codex", account: DEFAULT_ACCOUNT_ID });
  assert.deepEqual(resolvePlanAccount("opencode-go"), { canonical: "opencode-go", account: DEFAULT_ACCOUNT_ID });
  const alias = aliasProviderId(PLAN_PROVIDERS["opencode-go"], "go-42");
  assert.deepEqual(resolvePlanAccount(alias), { canonical: "opencode-go", account: aliasAccountDiscriminator(alias) });
  assert.deepEqual(resolvePlanAccount("mystery-provider"), { canonical: "mystery-provider", account: DEFAULT_ACCOUNT_ID });
});

function assertAliasIdentity(base: Provider<Api>, spec: PlanProviderSpec, accountId: string) {
  const alias = buildAliasProvider({ base, spec, accountId });
  assert.equal(alias.id, aliasProviderId(spec, accountId));
  assert.equal(alias.name, aliasProviderName(spec, accountId));
  // auth identity: the alias shares the base provider's auth object
  assert.equal(alias.auth, base.auth);
  const aliasModels = alias.getModels();
  const baseModels = base.getModels();
  assert.equal(aliasModels.length, baseModels.length);
  for (const model of aliasModels) {
    assert.equal(model.provider, alias.id); // remapped to the alias
    const baseModel = baseModels.find((m) => m.id === model.id);
    assert.ok(baseModel, `base model missing: ${model.id}`);
    assert.equal(model.api, baseModel.api);
    assert.equal(model.name, baseModel.name);
    assert.equal(model.baseUrl, baseModel.baseUrl);
    assert.equal(model.contextWindow, baseModel.contextWindow);
    assert.equal(model.maxTokens, baseModel.maxTokens);
    assert.equal(model.reasoning, baseModel.reasoning);
    assert.deepEqual(model.cost, baseModel.cost);
  }
  for (const baseModel of baseModels) {
    assert.ok(aliasModels.some((m) => m.id === baseModel.id), `alias missing base model: ${baseModel.id}`);
  }
  // delegation identity: stream, deferred, refresh, filter are the base's own
  assert.equal(alias.stream, base.stream);
  assert.equal(alias.streamSimple, base.streamSimple);
  assert.equal(alias.fetchDeferred, base.fetchDeferred);
  assert.equal(alias.cancelDeferred, base.cancelDeferred);
  assert.equal(alias.filterModels, base.filterModels);
  assert.equal(alias.refreshModels, base.refreshModels);
  assert.equal(alias.baseUrl, base.baseUrl);
  return alias;
}

test("openai-codex alias remaps models and reuses base auth/stream identity", () => {
  assertAliasIdentity(openaiCodexProvider(), PLAN_PROVIDERS["openai-codex"], "acct-codex-1");
});

test("opencode-go alias remaps models and reuses base auth/stream identity", () => {
  assertAliasIdentity(opencodeGoProvider(), PLAN_PROVIDERS["opencode-go"], "acct-go-1");
});

test("alias streaming delegates to the base provider with the alias model", () => {
  const base = openaiCodexProvider();
  const calls: Array<{ model: Model<Api>; context: Context; options?: unknown }> = [];
  const fake = createAssistantMessageEventStream();
  (base as unknown as { stream: unknown }).stream = (model: Model<Api>, context: Context, options?: unknown) => {
    calls.push({ model, context, options });
    return fake;
  };
  // streamSimple delegates too — install both stubs before building the alias
  const simpleCalls: Model<Api>[] = [];
  (base as unknown as { streamSimple: unknown }).streamSimple = (m: Model<Api>, _context: Context, _options?: unknown) => {
    simpleCalls.push(m);
    return createAssistantMessageEventStream();
  };
  const alias = buildAliasProvider({ base, spec: PLAN_PROVIDERS["openai-codex"], accountId: "acct-delegate" });
  assert.equal(alias.stream, base.stream); // real delegation identity
  const model = alias.getModels()[0];
  const context: Context = { messages: [] };
  const options = { maxTokens: 100 };
  const stream = alias.stream(model, context, options);
  assert.equal(stream, fake);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].model, model); // the remapped alias model, same object
  assert.equal(calls[0].model.provider, alias.id);
  assert.equal(calls[0].context, context);
  assert.deepEqual(calls[0].options, options);

  alias.streamSimple(model, context);
  assert.equal(simpleCalls.length, 1);
  assert.equal(simpleCalls[0].provider, alias.id);
});

test("alias copies deferred, refresh, and filter capabilities from the base", () => {
  const base = opencodeGoProvider();
  assert.equal(base.fetchDeferred, undefined); // built-in static providers expose none today
  const fetchSpy = () => createAssistantMessageEventStream();
  const cancelSpy = async () => undefined;
  const filterSpy = (models: readonly Model<Api>[]) => models;
  const refreshSpy = async () => undefined;
  (base as unknown as { fetchDeferred: unknown }).fetchDeferred = fetchSpy;
  (base as unknown as { cancelDeferred: unknown }).cancelDeferred = cancelSpy;
  (base as unknown as { filterModels: unknown }).filterModels = filterSpy;
  (base as unknown as { refreshModels: unknown }).refreshModels = refreshSpy;
  const alias = buildAliasProvider({ base, spec: PLAN_PROVIDERS["opencode-go"], accountId: "acct-go-2" });
  assert.equal(alias.fetchDeferred, fetchSpy);
  assert.equal(alias.cancelDeferred, cancelSpy);
  assert.equal(alias.filterModels, filterSpy);
  assert.equal(alias.refreshModels, refreshSpy);
});

test("buildAliasProvider rejects a base that does not match the spec", () => {
  const base = openaiCodexProvider();
  assert.throws(
    () => buildAliasProvider({ base, spec: PLAN_PROVIDERS["opencode-go"], accountId: "acct" }),
    /base mismatch/,
  );
});

test("display name and alias id can be overridden explicitly", () => {
  const alias = buildAliasProvider({
    base: openaiCodexProvider(),
    spec: PLAN_PROVIDERS["openai-codex"],
    accountId: "acct-override",
    displayName: "Work ChatGPT",
    aliasId: "plan:openai-codex:0123456789abcdef",
  });
  assert.equal(alias.id, "plan:openai-codex:0123456789abcdef");
  assert.equal(alias.name, "Work ChatGPT");
  assert.equal(alias.getModels()[0].provider, alias.id);
});

test("aliases built without an account id use the stable default account", () => {
  const a = buildAliasProvider({ base: openaiCodexProvider(), spec: PLAN_PROVIDERS["openai-codex"] });
  const b = buildAliasProvider({ base: openaiCodexProvider(), spec: PLAN_PROVIDERS["openai-codex"] });
  assert.equal(a.id, b.id);
  assert.equal(a.id, aliasProviderId(PLAN_PROVIDERS["openai-codex"]));
  assert.equal(a.name, PLAN_PROVIDERS["openai-codex"].label);
});
