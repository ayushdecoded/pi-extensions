import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import type { AgentsConfig } from "../src/config/agents.ts";
import {
  agentsModeStatePath,
  createActiveModeStore,
  defaultModeName,
  resolveActiveMode,
} from "../src/config/mode.ts";

function config(presets: string[], defaultPreset?: string): AgentsConfig {
  return {
    path: "/proj/.pi/agents.yaml",
    version: 1,
    defaults: { maxDepth: 1, concurrency: 2, timeoutMinutes: 10 },
    ...(defaultPreset === undefined ? {} : { defaultPreset }),
    roles: [
      {
        name: "Atlas",
        description: "Explore",
        model: "provider/a",
        thinking: "medium",
        promptPath: "agents/atlas.md",
        promptFile: "/proj/.pi/agents/atlas.md",
        tools: ["read"],
        delegates: [],
      },
    ],
    presets: presets.map((name) => ({ name, roleNames: ["Atlas"], overrides: new Map() })),
  };
}

test("active mode store persists per config path and survives reads", async () => {
  const homeDir = await mkdtemp(path.join(os.tmpdir(), "pi-mode-"));
  const store = createActiveModeStore(homeDir);
  assert.equal(agentsModeStatePath(homeDir), path.join(homeDir, ".config", "pi", "agents-mode.json"));

  assert.equal(store.load("/a/agents.yaml"), undefined);
  store.save("/a/agents.yaml", "light");
  store.save("/b/agents.yaml", "deep");
  assert.equal(store.load("/a/agents.yaml"), "light");
  assert.equal(store.load("/b/agents.yaml"), "deep");
  assert.equal(store.load("/c/agents.yaml"), undefined);

  // A second store instance sees the same state (file-backed).
  assert.equal(createActiveModeStore(homeDir).load("/a/agents.yaml"), "light");

  store.save("/a/agents.yaml", undefined);
  assert.equal(createActiveModeStore(homeDir).load("/a/agents.yaml"), undefined);
});

test("resolveActiveMode prefers the persisted preset when it still exists", () => {
  const cfg = config(["light", "deep"], "deep");
  assert.equal(resolveActiveMode(cfg, "light"), "light");
  assert.equal(resolveActiveMode(cfg, "LIGHT"), "light");
  assert.equal(resolveActiveMode(cfg, "gone"), "deep");
  assert.equal(resolveActiveMode(cfg, undefined), "deep");
  assert.equal(defaultModeName(cfg), "deep");
});

test("resolveActiveMode falls back to the first preset without default_preset", () => {
  const cfg = config(["light", "deep"]);
  assert.equal(defaultModeName(cfg), "light");
  assert.equal(resolveActiveMode(cfg, undefined), "light");
  assert.equal(resolveActiveMode(cfg, "deep"), "deep");
  assert.equal(resolveActiveMode(config([]), undefined), undefined);
});
