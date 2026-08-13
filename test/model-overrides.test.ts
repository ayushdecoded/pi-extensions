import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import {
  agentsModelOverridesPath,
  createAgentModelOverrideStore,
} from "../src/config/model-overrides.ts";

test("model overrides persist independently per config, preset, and role", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "pi-agent-models-"));
  const store = createAgentModelOverrideStore(home);
  assert.equal(agentsModelOverridesPath(home), path.join(home, ".config", "pi", "agents-model-overrides.json"));

  store.set("/a/agents.yaml", "light", "Atlas", "provider/fast");
  store.set("/a/agents.yaml", "deep", "Atlas", "provider/deep");
  store.set("/a/agents.yaml", "light", "Vigil", "provider/review");
  store.set("/b/agents.yaml", undefined, "Atlas", "other/model");

  const reopened = createAgentModelOverrideStore(home);
  assert.equal(reopened.get("/a/agents.yaml", "light", "Atlas"), "provider/fast");
  assert.equal(reopened.get("/a/agents.yaml", "deep", "Atlas"), "provider/deep");
  assert.equal(reopened.get("/a/agents.yaml", "light", "Vigil"), "provider/review");
  assert.equal(reopened.get("/b/agents.yaml", undefined, "Atlas"), "other/model");
  assert.equal(reopened.get("/b/agents.yaml", "light", "Atlas"), undefined);

  store.set("/a/agents.yaml", "light", "Atlas", undefined);
  assert.equal(reopened.get("/a/agents.yaml", "light", "Atlas"), undefined);
  assert.equal(reopened.get("/a/agents.yaml", "light", "Vigil"), "provider/review");
});

test("malformed override entries are ignored and replaced safely", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "pi-agent-models-bad-"));
  const file = agentsModelOverridesPath(home);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify({ "/a": "bad", "/b": { light: { Atlas: 42, Vigil: "valid/model" } } }));
  const store = createAgentModelOverrideStore(home);
  assert.equal(store.get("/a", "light", "Atlas"), undefined);
  assert.equal(store.get("/b", "light", "Atlas"), undefined);
  assert.equal(store.get("/b", "light", "Vigil"), "valid/model");
  assert.doesNotThrow(() => store.set("/a", "light", "Atlas", "next/model"));
  assert.equal(store.get("/a", "light", "Atlas"), "next/model");
});
