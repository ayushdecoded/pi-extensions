import assert from "node:assert/strict";
import { test } from "node:test";

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

test("reloadState creates a complete state on first load", async () => {
  delete (globalThis as Record<string, unknown>)[RELOAD_STATE_KEY];
  const mod = await import(`../src/index.ts?reload-state-first=${Date.now()}`);
  const state = mod.reloadState();
  assert.ok(state.minimizedPanels instanceof Set);
  assert.ok(state.sessionRuntimes instanceof Map);
  delete (globalThis as Record<string, unknown>)[RELOAD_STATE_KEY];
});
