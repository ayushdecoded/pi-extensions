import { readFile } from "node:fs/promises";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseDocument } from "yaml";
import { Type, type Static } from "typebox";
import { Value } from "typebox/value";
import { StringEnum } from "@earendil-works/pi-ai";
import { CONFIG_DIR_NAME, getAgentDir } from "@earendil-works/pi-coding-agent";

export const thinkingSchema = StringEnum(["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const);
export const modelSchema = Type.String({ minLength: 3, pattern: "^[^/\\s]+/[^\\s]+$", description: "provider/model-id; omitted means inherit" });
export const toolNames = ["read", "bash", "edit", "write", "grep", "find", "ls", "powershell", "web"] as const;
export const toolsSchema = Type.Array(StringEnum(toolNames), { uniqueItems: true });
const selection = { model: Type.Optional(modelSchema), thinking: Type.Optional(thinkingSchema) };
const schema = Type.Object({
  version: Type.Literal(1),
  defaults: Type.Optional(Type.Object(selection, { additionalProperties: false })),
  titling: Type.Optional(Type.Object({ model: modelSchema, thinking: thinkingSchema }, { additionalProperties: false })),
  agents: Type.Record(Type.String({ pattern: "^[A-Za-z][A-Za-z0-9_-]*$" }), Type.Object({
    description: Type.String({ minLength: 1 }),
    prompt: Type.String({ minLength: 1 }),
    tools: toolsSchema,
    ...selection,
  }, { additionalProperties: false })),
}, { additionalProperties: false });
export type Thinking = Static<typeof thinkingSchema>;
export type AgentConfig = {
  description: string; prompt: string; tools: string[]; model?: string; thinking?: Thinking;
};
export type Config = { path: string; agents: Record<string, AgentConfig>; defaults: { model?: string; thinking?: Thinking }; titling?: { model: string; thinking: Thinking } };
export const bundledConfig = fileURLToPath(new URL("../../resources/agents.yaml", import.meta.url));

export async function readConfig(path: string): Promise<Config> {
  const document = parseDocument(await readFile(path, "utf8"), { uniqueKeys: true });
  if (document.errors.length) throw new Error(`${path}: ${document.errors[0].message}`);
  const data: unknown = document.toJS();
  if (!Value.Check(schema, data)) {
    const error = [...Value.Errors(schema, data)][0];
    throw new Error(`${path}${error?.instancePath || "/"}: ${error?.message || "Invalid agent configuration"}`);
  }
  const agents: Config["agents"] = Object.create(null);
  for (const [name, role] of Object.entries(data.agents)) {
    if (["minimal", "custom", "__proto__", "constructor", "prototype"].includes(name)) {
      throw new Error(`${path}/agents/${name}: reserved agent name`);
    }
    const promptPath = resolve(dirname(path), role.prompt);
    const prompt = await readFile(promptPath, "utf8").catch(() => { throw new Error(`${path}/agents/${name}/prompt: cannot read ${promptPath}`); });
    if (!prompt.trim()) throw new Error(`${path}/agents/${name}/prompt: prompt is empty`);
    agents[name] = { ...role, prompt };
  }
  for (const name of ["Atlas", "Forge", "Vigil"]) {
    if (!agents[name]) throw new Error(`${path}/agents/${name}: required agent is missing`);
  }
  return { path, defaults: data.defaults ?? {}, agents, titling: data.titling };
}

// First existing config wins as a whole. Invalid files do not silently fall through.
export async function loadConfig(cwd: string, trusted: boolean, agentDir = getAgentDir()): Promise<Config> {
  const paths = [...(trusted ? [join(cwd, CONFIG_DIR_NAME, "agents.yaml")] : []), join(agentDir, "agents.yaml"), bundledConfig];
  for (const path of paths) {
    try { return await readConfig(path); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT" && path !== bundledConfig) continue;
      throw error;
    }
  }
  throw new Error("No agent configuration found");
}
