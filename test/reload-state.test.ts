import assert from "node:assert/strict";
import { test } from "node:test";
import { migrateRuntimeForReload, SubagentRuntime } from "../src/runtime/runtime.ts";

const RELOAD_STATE_KEY = "__piSubagentsReloadState__";

/**
 * `/reload` re-imports the extension module but keeps the process alive, so the
 * handoff state lives on globalThis and outlives the module instance that
 * created it. A state created by an older extension version lacks fields added
 * since; `reloadState()` must backfill them or adopters crash reading undefined.
 * This test reproduces that crash scenario (a partial pre-field state) and pins
 * the backfill.
 */
test("reloadState backfills fields missing from a state an older instance created", async () => {
  const oldState = {
    detachedRuntimes: new Map(),
    detachedEventBuffer: new Map(),
    sessionRuntimes: new Map(),
    sessionSenders: new Map(),
    bufferedFollowUps: [],
    backgroundRunRegistries: new Map(),
    backgroundRunSenders: new Map(),
  };
  (globalThis as Record<string, unknown>)[RELOAD_STATE_KEY] = oldState;
  try {
    // A fresh module instance adopts the pre-existing global state.
    const mod = await import(`../src/index.ts?reload-state-test=${Date.now()}`);
    const state = mod.reloadState();
    assert.ok(state.minimizedPanels instanceof Set, "minimizedPanels is backfilled");
    assert.equal(state.minimizedPanels.size, 0);
    assert.equal(state.backgroundRunSenders, oldState.backgroundRunSenders, "existing fields are preserved");
  } finally {
    delete (globalThis as Record<string, unknown>)[RELOAD_STATE_KEY];
  }
});

test("reload migration upgrades a live legacy runtime without replacing core references", () => {
  const runtime = new (SubagentRuntime as any)({
    rootSessionId: "reload-root",
    cwd: "/tmp",
    config: {
      path: "/tmp/agents.yaml",
      version: 1,
      defaults: { maxDepth: 2, concurrency: 2, timeoutMinutes: 10 },
      roles: [{
        name: "Atlas",
        description: "Test role",
        model: "openai-codex/test",
        thinking: "off",
        promptPath: "agents/atlas.md",
        promptFile: "/tmp/atlas.md",
        tools: [],
        delegates: [],
      }],
      presets: [],
    },
    modelRegistry: {},
    appendEvent: () => {},
  });
  const state = runtime.state;
  const options = runtime.options;
  const scheduler = runtime.scheduler;
  const liveSessions = runtime.liveSessions;
  const batchCancels = (runtime as any).batchCancels;
  const agentCancels = (runtime as any).agentCancels;
  for (const key of [
    "promotableBatches", "disabledRoleNames", "liveDelegationRefreshers",
    "followupTasks", "followupQueues", "followupDrain", "followupCounter", "followupGroups",
  ]) delete runtime[key];
  state.agents.set("atlas-1", { handle: "atlas-1", role: "Atlas", sessionFile: "/tmp/atlas", createdAt: 1 });
  Object.setPrototypeOf(runtime, {
    record: (SubagentRuntime.prototype as any).record,
    runBatch: (SubagentRuntime.prototype as any).runBatch,
  });

  const migrated = migrateRuntimeForReload(runtime);
  assert.doesNotThrow(() => migrated.validateSubmission([{ role: "Atlas", task: "validate after upgrade" }]));
  const inspection = migrated.controlAction({ action: "inspect", target: { all: true } });
  assert.equal(inspection.action, "inspect");
  assert.equal(inspection.agents[0]?.agent, "atlas-1");
  assert.equal(migrated.state, state, "legacy state reference is retained");
  assert.equal(migrated.options, options, "legacy options reference is retained");
  assert.equal(migrated.scheduler, scheduler, "legacy scheduler reference is retained");
  assert.equal(migrated.liveSessions, liveSessions, "live sessions reference is retained");
  assert.equal((migrated as any).batchCancels, batchCancels, "cancellation map is retained");
  assert.equal((migrated as any).agentCancels, agentCancels, "agent cancellation map is retained");
  assert.ok((migrated as any).followupTasks instanceof Map);
  assert.ok((migrated as any).followupQueues instanceof Map);
  assert.ok((migrated as any).disabledRoleNames instanceof Set);
});

test("reload migration rejects an incompatible new collection without partial mutation", () => {
  const runtime = new (SubagentRuntime as any)({
    rootSessionId: "reload-invalid",
    cwd: "/tmp",
    config: { path: "/tmp/agents.yaml", version: 1, defaults: { maxDepth: 1, concurrency: 1, timeoutMinutes: 10 }, roles: [], presets: [] },
    modelRegistry: {},
    appendEvent: () => {},
  });
  const state = runtime.state;
  const batchCancels = runtime.batchCancels;
  const invalidQueues = { active: "must not be replaced" };
  runtime.followupQueues = invalidQueues;
  delete runtime.followupTasks;
  const originalPrototype = Object.getPrototypeOf(runtime);

  assert.throws(() => migrateRuntimeForReload(runtime), /followupQueues/);
  assert.equal(runtime.followupQueues, invalidQueues, "the incompatible collection is untouched");
  assert.equal(runtime.followupTasks, undefined, "missing fields are not backfilled before validation finishes");
  assert.equal(runtime.state, state, "core state is untouched");
  assert.equal(runtime.batchCancels, batchCancels, "cancellation state is untouched");
  assert.equal(Object.getPrototypeOf(runtime), originalPrototype, "prototype is untouched");
});

test("reload migration rejects malformed legacy core references", () => {
  const makeRuntime = () => new (SubagentRuntime as any)({
    rootSessionId: "reload-core-invalid",
    cwd: "/tmp",
    config: { path: "/tmp/agents.yaml", version: 1, defaults: { maxDepth: 1, concurrency: 1, timeoutMinutes: 10 }, roles: [], presets: [] },
    modelRegistry: {},
    appendEvent: () => {},
  });
  for (const [field, value] of [
    ["options", null], ["state", null], ["scheduler", null], ["record", "not a function"], ["runBatch", {}],
  ] as const) {
    const candidate = makeRuntime();
    const originalFollowupTasks = candidate.followupTasks;
    (candidate as any)[field] = value;
    assert.throws(() => migrateRuntimeForReload(candidate), new RegExp(field));
    assert.equal(candidate.followupTasks, originalFollowupTasks, `${field} failure does not mutate new collections`);
  }
});

test("reloadState creates a complete state on first load", async () => {
  delete (globalThis as Record<string, unknown>)[RELOAD_STATE_KEY];
  const mod = await import(`../src/index.ts?reload-state-first=${Date.now()}`);
  const state = mod.reloadState();
  assert.ok(state.minimizedPanels instanceof Set);
  assert.ok(state.sessionRuntimes instanceof Map);
  delete (globalThis as Record<string, unknown>)[RELOAD_STATE_KEY];
});
