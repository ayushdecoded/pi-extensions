import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import {
  agentsModelOverridesPath,
  createAgentModelOverrideStore,
} from "../src/config/model-overrides.ts";

test("model and thinking overrides persist independently per config, preset, and role", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "pi-agent-models-"));
  const store = createAgentModelOverrideStore(home);
  assert.equal(agentsModelOverridesPath(home), path.join(home, ".config", "pi", "agents-model-overrides.json"));

  store.set("/a/agents.yaml", "light", "Atlas", { model: "provider/fast", thinking: "high" });
  store.set("/a/agents.yaml", "deep", "Atlas", { model: "provider/deep" });
  store.set("/a/agents.yaml", "light", "Vigil", { thinking: "max" });
  store.set("/b/agents.yaml", undefined, "Atlas", { model: "other/model" });

  const reopened = createAgentModelOverrideStore(home);
  assert.deepEqual(reopened.get("/a/agents.yaml", "light", "Atlas"), { model: "provider/fast", thinking: "high" });
  assert.deepEqual(reopened.get("/a/agents.yaml", "deep", "Atlas"), { model: "provider/deep" });
  assert.deepEqual(reopened.get("/a/agents.yaml", "light", "Vigil"), { thinking: "max" });
  assert.deepEqual(reopened.get("/b/agents.yaml", undefined, "Atlas"), { model: "other/model" });
  assert.equal(reopened.get("/b/agents.yaml", "light", "Atlas"), undefined);

  // Resetting one field keeps the other.
  store.set("/a/agents.yaml", "light", "Atlas", { model: undefined });
  assert.deepEqual(reopened.get("/a/agents.yaml", "light", "Atlas"), { thinking: "high" });
  store.set("/a/agents.yaml", "light", "Atlas", { thinking: undefined });
  assert.equal(reopened.get("/a/agents.yaml", "light", "Atlas"), undefined);
  assert.deepEqual(reopened.get("/a/agents.yaml", "light", "Vigil"), { thinking: "max" });

  // Removing a whole entry clears it without touching siblings.
  store.set("/a/agents.yaml", "light", "Vigil", undefined);
  assert.equal(reopened.get("/a/agents.yaml", "light", "Vigil"), undefined);
});

test("legacy string entries load as model-only overrides and merge with thinking", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "pi-agent-models-legacy-"));
  const file = agentsModelOverridesPath(home);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify({ "/a": { light: { Atlas: "provider/legacy" } } }));
  const store = createAgentModelOverrideStore(home);
  assert.deepEqual(store.get("/a", "light", "Atlas"), { model: "provider/legacy" });
  store.set("/a", "light", "Atlas", { thinking: "medium" });
  assert.deepEqual(store.get("/a", "light", "Atlas"), { model: "provider/legacy", thinking: "medium" });
});

test("malformed override entries are ignored and replaced safely", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "pi-agent-models-bad-"));
  const file = agentsModelOverridesPath(home);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify({
    "/a": "bad",
    "/b": {
      light: {
        Atlas: 42,
        Vigil: { model: "valid/model", thinking: "turbo" },
        Forge: "valid/model",
      },
    },
  }));
  const store = createAgentModelOverrideStore(home);
  assert.equal(store.get("/a", "light", "Atlas"), undefined);
  assert.equal(store.get("/b", "light", "Atlas"), undefined);
  assert.deepEqual(store.get("/b", "light", "Vigil"), { model: "valid/model" }, "invalid thinking is dropped");
  assert.deepEqual(store.get("/b", "light", "Forge"), { model: "valid/model" });
  assert.doesNotThrow(() => store.set("/a", "light", "Atlas", { model: "next/model" }));
  assert.deepEqual(store.get("/a", "light", "Atlas"), { model: "next/model" });
});
