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
  assert.deepEqual(config.roles.map((role) => role.name), ["Atlas", "Vigil"]);
  assert.ok(config.roles.every((role) => role.promptFile.includes(`${path.sep}resources${path.sep}agents${path.sep}`)));
  const atlas = config.roles.find((role) => role.name === "Atlas");
  const vigil = config.roles.find((role) => role.name === "Vigil");
  assert.deepEqual(atlas?.tools, ["read", "bash", "web_search"]);
  assert.match(atlas?.description ?? "", /codebase and web research.*durable facts/);
  assert.match(vigil?.description ?? "", /consequential designs and implementation milestones/);
  assert.match(vigil?.description ?? "", /materially affect a decision or reveal a meaningful risk/);
  assert.match(vigil?.description ?? "", /routine, directly verifiable work or merely to confirm completed work/);
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
