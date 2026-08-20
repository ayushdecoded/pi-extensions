import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import {
  agentsConfigPath,
  loadAgentsConfig,
  parseAgentsConfig,
  projectAgentsPath,
  resolvePreset,
  validateAgentsFile,
} from "../src/config/agents.ts";

const yaml = `version: 1
defaults:
  maxDepth: 1
  concurrency: 2
  timeoutMinutes: 10
roles:
  Worker:
    description: Implement bounded changes
    model: openai-codex/gpt-5.6-luna
    thinking: xhigh
    prompt: agents/worker.md
    tools: [read, bash, edit, write]
`;

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "pi-extensions-agents-"));
  await mkdir(path.join(root, ".pi", "agents"), { recursive: true });
  await writeFile(path.join(root, ".pi", "agents", "worker.md"), "Worker prompt\n");
  await writeFile(path.join(root, ".pi", "agents", "atlas.md"), "Atlas prompt\n");
  return root;
}

test("loads project config and keeps the direct model ID", async () => {
  const cwd = await fixture();
  await writeFile(projectAgentsPath(cwd), yaml);

  const config = loadAgentsConfig({ cwd, homeDir: path.join(cwd, "unused-home") });
  assert.equal(config.version, 1);
  assert.equal(config.roles[0].model, "openai-codex/gpt-5.6-luna");
  assert.equal(config.roles[0].promptFile, path.join(cwd, ".pi", "agents", "worker.md"));
  assert.deepEqual(config.roles[0].delegates, []);
});

test("parses optional Devin backend choices without changing native defaults", async () => {
  const cwd = await fixture();
  const sourcePath = projectAgentsPath(cwd);
  const config = parseAgentsConfig({
    version: 1,
    defaults: { maxDepth: 1, concurrency: 2, timeoutMinutes: 10 },
    roles: {
      Forge: {
        description: "Implement bounded changes",
        model: "openai-codex/gpt-5.6-luna",
        thinking: "high",
        prompt: "agents/worker.md",
        tools: ["read"],
        backend: "native",
        backendOptions: ["native", "devin"],
      },
      Atlas: {
        description: "Research",
        model: "openai-codex/gpt-5.6-luna",
        thinking: "high",
        prompt: "agents/atlas.md",
        tools: ["read"],
      },
    },
  }, sourcePath);
  assert.equal(config.roles.find((role) => role.name === "Forge")?.backend, "native");
  assert.deepEqual(config.roles.find((role) => role.name === "Forge")?.backendOptions, ["native", "devin"]);
  assert.equal(config.roles.find((role) => role.name === "Atlas")?.backend, "native");
  assert.throws(
    () => parseAgentsConfig({
      version: 1,
      defaults: { maxDepth: 1, concurrency: 2, timeoutMinutes: 10 },
      roles: {
        Forge: {
          description: "Implement bounded changes",
          model: "openai-codex/gpt-5.6-luna",
          thinking: "high",
          prompt: "agents/worker.md",
          tools: ["read"],
          backend: "devin",
          backendOptions: ["native"],
        },
      },
    }, sourcePath),
    /must be listed in backendOptions/,
  );
});

test("canonicalizes delegate references and rejects invalid targets", async () => {
  const cwd = await fixture();
  const sourcePath = projectAgentsPath(cwd);
  const config = parseAgentsConfig(
    delegationConfig(["aTlAs"]),
    sourcePath,
  );

  assert.deepEqual(config.roles.map((role) => role.delegates), [["Atlas"], []]);
  assert.throws(
    () => parseAgentsConfig(delegationConfig(["atlas", "ATLAS"]), sourcePath),
    /case-insensitive duplicates/i,
  );
  assert.throws(
    () => parseAgentsConfig(delegationConfig(["missing"]), sourcePath),
    /Role Worker\.delegates references unknown role: missing\./,
  );
});

test("rejects subagent in tools and directs configs to delegates", async () => {
  const cwd = await fixture();
  await writeFile(
    projectAgentsPath(cwd),
    yaml.replace("tools: [read, bash, edit, write]", "tools: [read, bash, edit, write, subagent]"),
  );

  assert.throws(
    () => loadAgentsConfig({ cwd, homeDir: path.join(cwd, "unused-home") }),
    /Role Worker\.tools must not include subagent; use delegates instead\./,
  );
});

test("uses global config only when the project config is absent", async () => {
  const cwd = await fixture();
  const homeDir = await mkdtemp(path.join(os.tmpdir(), "pi-extensions-home-"));
  const globalFile = path.join(homeDir, ".config", "pi", "agents.yaml");
  await mkdir(path.join(homeDir, ".config", "pi", "agents"), { recursive: true });
  await writeFile(path.join(homeDir, ".config", "pi", "agents", "worker.md"), "Global Worker prompt\\n");
  await writeFile(globalFile, yaml);

  assert.equal(agentsConfigPath({ cwd, homeDir }), globalFile);
  assert.equal(loadAgentsConfig({ cwd, homeDir }).path, globalFile);

  await writeFile(projectAgentsPath(cwd), "version: 1\n");
  assert.equal(agentsConfigPath({ cwd, homeDir }), projectAgentsPath(cwd));
  assert.equal(validateAgentsFile({ cwd, homeDir }).ok, false);
});

test("uses bundled package defaults only when project and global configs are absent", async () => {
  const cwd = await fixture();
  const homeDir = await mkdtemp(path.join(os.tmpdir(), "pi-extensions-empty-home-"));

  const config = loadAgentsConfig({ cwd, homeDir });

  assert.match(config.path, /resources\/agents\.yaml$/);
  assert.deepEqual(config.roles.map((role) => role.name), ["Atlas", "Forge", "Vigil"]);
  assert.ok(config.roles.every((role) => role.promptFile.includes(`${path.sep}resources${path.sep}agents${path.sep}`)));
  const atlas = config.roles.find((role) => role.name === "Atlas");
  const forge = config.roles.find((role) => role.name === "Forge");
  const vigil = config.roles.find((role) => role.name === "Vigil");
  assert.deepEqual(atlas?.tools, ["read", "bash", "web_search"]);
  assert.match(atlas?.description ?? "", /focused fact-finding.*expected evidence/);
  assert.equal(forge?.model, "opencode-go/deepseek-v4-flash");
  assert.equal(forge?.thinking, "high");
  assert.deepEqual(forge?.tools, ["read", "bash", "edit", "write"]);
  assert.deepEqual(forge?.delegates, []);
  assert.equal(forge?.timeoutMinutes, 20);
  assert.match(forge?.description ?? "", /approved, bounded changes.*file or symbol ownership/s);
  assert.match(vigil?.description ?? "", /consequential architecture, designs, and implementation milestones/);
  assert.match(vigil?.description ?? "", /materially affect a decision or expose a meaningful risk/);
  assert.match(vigil?.description ?? "", /Not for routine checks or confirmation of completed work/);

  const light = config.presets.find((preset) => preset.name === "light");
  const deep = config.presets.find((preset) => preset.name === "deep");
  assert.equal(config.defaultPreset, "deep");
  assert.equal(config.defaults.image, "opencode-go/qwen3.7-plus");
  assert.match(config.defaults.imagePromptFile ?? "", /resources[\\/]agents[\\/]vision\.md$/);
  assert.deepEqual(light?.roleNames, ["Atlas", "Forge", "Vigil"]);
  assert.deepEqual(deep?.roleNames, ["Atlas", "Forge", "Vigil"]);
  assert.deepEqual(light?.overrides.get("Atlas"), { model: "opencode-go/deepseek-v4-flash", thinking: "high" });
  assert.deepEqual(light?.overrides.get("Forge"), { model: "opencode-go/deepseek-v4-flash", thinking: "high" });
  assert.deepEqual(light?.overrides.get("Vigil"), { model: "opencode-go/deepseek-v4-flash", thinking: "max" });
  assert.deepEqual(deep?.overrides.get("Atlas"), { model: "opencode-go/deepseek-v4-flash", thinking: "high" });
  assert.deepEqual(deep?.overrides.get("Forge"), { model: "opencode-go/deepseek-v4-flash", thinking: "high" });
  assert.deepEqual(deep?.overrides.get("Vigil"), { model: "openai-codex/gpt-5.6-sol", thinking: "high" });
});

test("presets select the active role set and override models, thinking, and prompts", async () => {
  const cwd = await fixture();
  await writeFile(path.join(cwd, ".pi", "agents", "atlas-light.md"), "Light Atlas prompt\n");
  const presetYaml = `version: 1
defaults:
  maxDepth: 1
  concurrency: 2
  timeoutMinutes: 10
default_preset: deep
roles:
  Atlas:
    description: Explore the repository
    model: openai-codex/gpt-5.6-luna
    thinking: medium
    prompt: agents/atlas.md
    tools: [read]
  Worker:
    description: Implement bounded changes
    model: openai-codex/gpt-5.6-luna
    thinking: medium
    prompt: agents/worker.md
    tools: [read, bash]
presets:
  light:
    roles: [Atlas, Worker]
    Atlas:
      model: opencode-go/deepseek-v4-flash
      thinking: high
      prompt: agents/atlas-light.md
    Worker:
      model: opencode-go/deepseek-v4-flash
      thinking: max
  deep:
    roles: [Atlas]
`;
  await writeFile(projectAgentsPath(cwd), presetYaml);

  const config = loadAgentsConfig({ cwd, homeDir: path.join(cwd, "unused-home") });
  assert.equal(config.defaultPreset, "deep");
  assert.deepEqual(config.presets.map((preset) => preset.name), ["light", "deep"]);

  const atlas = config.roles.find((role) => role.name === "Atlas")!;
  const light = resolvePreset(config, "light");
  assert.deepEqual(light.roles.map((role) => role.name), ["Atlas", "Worker"]);
  const lightAtlas = light.roles.find((role) => role.name === "Atlas")!;
  assert.equal(lightAtlas.model, "opencode-go/deepseek-v4-flash");
  assert.equal(lightAtlas.thinking, "high");
  assert.equal(lightAtlas.promptFile, path.join(cwd, ".pi", "agents", "atlas-light.md"));
  const lightWorker = light.roles.find((role) => role.name === "Worker")!;
  assert.equal(lightWorker.model, "opencode-go/deepseek-v4-flash");
  assert.equal(lightWorker.thinking, "max");

  // A preset activates a subset; roles without overrides keep their defaults.
  const deep = resolvePreset(config, "DEEP");
  assert.deepEqual(deep.roles.map((role) => role.name), ["Atlas"]);
  assert.equal(deep.roles[0]!.model, atlas.model);
  assert.equal(deep.roles[0]!.thinking, atlas.thinking);

  // No preset means the full role pool with defaults.
  assert.equal(resolvePreset(config, undefined).roles.length, config.roles.length);
  assert.throws(() => resolvePreset(config, "missing"), /Unknown agents preset: missing\./);
});

test("validates preset role lists, overrides, prompts, and default_preset", async () => {
  const cwd = await fixture();
  const sourcePath = projectAgentsPath(cwd);
  await writeFile(path.join(cwd, ".pi", "agents", "atlas-light.md"), "Light Atlas prompt\n");
  const base = {
    version: 1,
    defaults: { maxDepth: 1, concurrency: 2, timeoutMinutes: 10 },
    default_preset: "light",
    roles: {
      Worker: {
        description: "Implement bounded changes",
        model: "openai-codex/gpt-5.6-luna",
        thinking: "medium",
        prompt: "agents/worker.md",
        tools: ["read"],
      },
      Architect: {
        description: "Design the system",
        model: "openai-codex/gpt-5.6-sol",
        thinking: "high",
        prompt: "agents/atlas.md",
        tools: ["read", "bash"],
      },
    },
  };

  assert.throws(() => parseAgentsConfig({ ...base, presets: "light" }, sourcePath), /presets must be an object/);
  assert.throws(
    () => parseAgentsConfig({ ...base, presets: { light: [] } }, sourcePath),
    /Preset light must be an object/,
  );
  assert.throws(
    () => parseAgentsConfig({ ...base, presets: { light: { roles: ["Worker"], Missing: {} } } }, sourcePath),
    /Preset light references unknown role: Missing\./,
  );
  assert.throws(
    () => parseAgentsConfig({ ...base, presets: { light: { roles: ["Nope"] } } }, sourcePath),
    /Preset light\.roles references unknown role: Nope\./,
  );
  assert.throws(
    () => parseAgentsConfig({ ...base, presets: { light: { roles: ["Worker", "worker"] } } }, sourcePath),
    /Preset light\.roles must not contain duplicates: worker\./,
  );
  assert.throws(
    () => parseAgentsConfig({ ...base, presets: { light: { roles: [] } } }, sourcePath),
    /Preset light\.roles must be a non-empty array of role names\./,
  );
  assert.throws(
    () => parseAgentsConfig({ ...base, presets: { light: { roles: ["Worker"], Worker: { model: "no-slash" } } } }, sourcePath),
    /Preset light\.Worker\.model must be a direct provider\/model ID\./,
  );
  assert.throws(
    () => parseAgentsConfig({ ...base, presets: { light: { roles: ["Worker"], Worker: { thinking: "turbo" } } } }, sourcePath),
    /Preset light\.Worker\.thinking has an invalid value: turbo\./,
  );
  assert.throws(
    () => parseAgentsConfig({ ...base, presets: { light: { roles: ["Worker"], Worker: { timeoutMinutes: 5 } } } }, sourcePath),
    /Preset light\.Worker has unknown property: timeoutMinutes\./,
  );
  assert.throws(
    () =>
      parseAgentsConfig(
        { ...base, presets: { light: { roles: ["Worker"], Worker: { prompt: "agents/missing.md" } } } },
        sourcePath,
      ),
    /Preset light\.Worker\.prompt file not found or unreadable/,
  );
  assert.throws(
    () =>
      parseAgentsConfig(
        { ...base, presets: { light: { roles: ["Worker"], Worker: { model: "a/b" }, worker: { model: "c/d" } } } },
        sourcePath,
      ),
    /Preset light lists role Worker more than once\./,
  );
  assert.throws(
    () =>
      parseAgentsConfig({ ...base, presets: { light: { roles: ["Worker"], Architect: { model: "a/b" } } } }, sourcePath),
    /Preset light overrides role Architect but does not activate it in roles\./,
  );
  assert.throws(
    () =>
      parseAgentsConfig(
        { ...base, presets: { light: { roles: ["Worker"], Worker: {} }, Light: { roles: ["Worker"] } } },
        sourcePath,
      ),
    /Preset names must be unique: Light\./,
  );
  assert.throws(
    () => parseAgentsConfig({ ...base, default_preset: "nope", presets: { light: { roles: ["Worker"] } } }, sourcePath),
    /default_preset references unknown preset: nope\./,
  );
  assert.throws(
    () => parseAgentsConfig({ ...base, default_preset: undefined, presets: { light: { roles: ["Worker"] } } }, sourcePath),
    /presets requires default_preset at the root\./,
  );
  assert.throws(
    () => parseAgentsConfig({ ...base, default_preset: "light" }, sourcePath),
    /default_preset references unknown preset: light\./,
  );

  const parsed = parseAgentsConfig(
    {
      ...base,
      presets: {
        light: {
          roles: ["worker"],
          Worker: { model: "opencode-go/deepseek-v4-flash", thinking: "max", prompt: "agents/atlas-light.md" },
        },
      },
    },
    sourcePath,
  );
  assert.equal(parsed.defaultPreset, "light");
  assert.deepEqual(parsed.presets[0]!.roleNames, ["Worker"]);
  assert.deepEqual(parsed.presets[0]!.overrides.get("Worker"), {
    model: "opencode-go/deepseek-v4-flash",
    thinking: "max",
    prompt: "agents/atlas-light.md",
    promptFile: path.join(cwd, ".pi", "agents", "atlas-light.md"),
  });
});

test("resolves the vision sidecar and its prompt through preset, role, and defaults", async () => {
  const cwd = await fixture();
  for (const file of ["vision-default.md", "vision-role.md", "vision-preset.md"]) {
    await writeFile(path.join(cwd, ".pi", "agents", file), `${file} content\n`);
  }
  const configYaml = `version: 1
defaults:
  maxDepth: 1
  concurrency: 2
  timeoutMinutes: 10
  image: opencode-go/qwen3.7-plus
  imagePrompt: agents/vision-default.md
default_preset: deep
roles:
  Atlas:
    description: Explore the repository
    model: openai-codex/gpt-5.6-luna
    thinking: medium
    prompt: agents/atlas.md
    tools: [read]
    image: opencode-go/kimi-k2.7-code
    imagePrompt: agents/vision-role.md
  Worker:
    description: Implement bounded changes
    model: openai-codex/gpt-5.6-luna
    thinking: medium
    prompt: agents/worker.md
    tools: [read]
presets:
  light:
    roles: [Atlas]
    Atlas:
      image: opencode-go/grok-4.5
      imagePrompt: agents/vision-preset.md
  deep:
    roles: [Atlas, Worker]
`;
  await writeFile(projectAgentsPath(cwd), configYaml);
  const config = loadAgentsConfig({ cwd, homeDir: path.join(cwd, "unused-home") });

  assert.equal(config.defaults.image, "opencode-go/qwen3.7-plus");
  assert.equal(config.defaults.imagePromptFile, path.join(cwd, ".pi", "agents", "vision-default.md"));
  const atlas = config.roles.find((role) => role.name === "Atlas")!;
  const worker = config.roles.find((role) => role.name === "Worker")!;
  assert.equal(atlas.image, "opencode-go/kimi-k2.7-code");
  assert.equal(atlas.imagePromptFile, path.join(cwd, ".pi", "agents", "vision-role.md"));

  // Preset override wins for the roles it touches.
  const lightAtlas = resolvePreset(config, "light").roles[0]!;
  assert.equal(lightAtlas.image, "opencode-go/grok-4.5");
  assert.equal(lightAtlas.imagePromptFile, path.join(cwd, ".pi", "agents", "vision-preset.md"));

  // Unoverridden roles fall back to role then defaults, with the matching prompt file.
  const deepRoles = resolvePreset(config, "deep").roles;
  assert.equal(deepRoles.find((role) => role.name === "Atlas")!.image, "opencode-go/kimi-k2.7-code");
  assert.equal(
    deepRoles.find((role) => role.name === "Atlas")!.imagePromptFile,
    path.join(cwd, ".pi", "agents", "vision-role.md"),
  );
  assert.equal(deepRoles.find((role) => role.name === "Worker")!.image, "opencode-go/qwen3.7-plus");
  assert.equal(
    deepRoles.find((role) => role.name === "Worker")!.imagePromptFile,
    path.join(cwd, ".pi", "agents", "vision-default.md"),
  );

  // Without a preset, role-level values still fall back to the defaults.
  const noPreset = resolvePreset(config, undefined).roles;
  assert.equal(noPreset.find((role) => role.name === "Worker")!.image, "opencode-go/qwen3.7-plus");
  assert.equal(noPreset.find((role) => role.name === "Atlas")!.image, "opencode-go/kimi-k2.7-code");
});

test("validates vision sidecar model IDs and prompt file references", async () => {
  const cwd = await fixture();
  const sourcePath = projectAgentsPath(cwd);
  const base = {
    version: 1,
    defaults: { maxDepth: 1, concurrency: 2, timeoutMinutes: 10 },
    default_preset: "light",
    roles: {
      Worker: {
        description: "Implement bounded changes",
        model: "openai-codex/gpt-5.6-luna",
        thinking: "medium",
        prompt: "agents/worker.md",
        tools: ["read"],
      },
    },
    presets: { light: { roles: ["Worker"] } },
  };

  assert.throws(
    () => parseAgentsConfig({ ...base, defaults: { ...base.defaults, image: "no-slash" } }, sourcePath),
    /defaults\.image must be a direct provider\/model ID\./,
  );
  assert.throws(
    () =>
      parseAgentsConfig(
        { ...base, defaults: { ...base.defaults, imagePrompt: "agents/missing-vision.md" } },
        sourcePath,
      ),
    /defaults\.imagePrompt file not found or unreadable/,
  );
  assert.throws(
    () =>
      parseAgentsConfig(
        { ...base, roles: { Worker: { ...base.roles.Worker, image: "no-slash" } } },
        sourcePath,
      ),
    /Role Worker\.image must be a direct provider\/model ID\./,
  );
  assert.throws(
    () =>
      parseAgentsConfig(
        {
          ...base,
          presets: { light: { roles: ["Worker"], Worker: { image: "no-slash" } } },
        },
        sourcePath,
      ),
    /Preset light\.Worker\.image must be a direct provider\/model ID\./,
  );
  assert.throws(
    () =>
      parseAgentsConfig(
        {
          ...base,
          presets: { light: { roles: ["Worker"], Worker: { imagePrompt: "agents/nope.md" } } },
        },
        sourcePath,
      ),
    /Preset light\.Worker\.imagePrompt file not found or unreadable/,
  );
});

function delegationConfig(delegates: unknown): unknown {
  return {
    version: 1,
    defaults: { maxDepth: 1, concurrency: 2, timeoutMinutes: 10 },
    roles: {
      Worker: {
        description: "Implement bounded changes",
        model: "openai-codex/gpt-5.6-luna",
        thinking: "xhigh",
        prompt: "agents/worker.md",
        tools: ["read"],
        delegates,
      },
      Atlas: {
        description: "Explore the repository",
        model: "openai-codex/gpt-5.6-luna",
        thinking: "medium",
        prompt: "agents/atlas.md",
        tools: ["read"],
      },
    },
  };
}

test("rejects the old routes/systemPrompt schema", () => {
  assert.throws(
    () =>
      parseAgentsConfig(
        {
          defaults: { maxDepth: 1, concurrency: 1, timeoutMinutes: 1 },
          routes: { Worker: { model: "provider/model", thinking: "high" } },
          roles: {},
        },
        "agents.yaml",
      ),
    /unknown property: routes/,
  );
});
