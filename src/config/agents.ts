import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";

export const AGENTS_CONFIG_FILE_NAME = "agents.yaml";
export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
export const AGENT_BACKENDS = ["native", "devin"] as const;
export const DEVIN_MODEL_LABEL = "SWE-1.7 Max";

export type ThinkingLevel = (typeof THINKING_LEVELS)[number];
export type AgentBackend = (typeof AGENT_BACKENDS)[number];

/** Human-facing model label for the backend currently executing a role. */
export function agentModelLabel(model: string, backend?: AgentBackend): string {
  return backend === "devin" ? DEVIN_MODEL_LABEL : model.split("/").at(-1) ?? model;
}

export type AgentsDefaults = {
  maxDepth: number;
  concurrency: number;
  timeoutMinutes: number;
  /** Default vision sidecar used when a role model cannot see images. */
  image?: string;
  /** Default vision sidecar instruction file; falls back to the built-in prompt. */
  imagePrompt?: string;
  imagePromptFile?: string;
};

export type AgentRole = {
  name: string;
  description: string;
  model: string;
  thinking: ThinkingLevel;
  promptPath: string;
  promptFile: string;
  tools: string[];
  delegates: string[];
  skills?: string[];
  timeoutMinutes?: number;
  /** Execution backend for this role. Defaults to Pi's native runtime. */
  backend?: AgentBackend;
  /** Backends exposed by the configuration panel for this role. */
  backendOptions?: AgentBackend[];
  /** Vision sidecar for this role when its model is text-only. */
  image?: string;
  /** Role-specific vision sidecar instruction file. */
  imagePrompt?: string;
  imagePromptFile?: string;
};

/** Optional per-role model/thinking/prompt/image override inside a named preset. */
export type AgentPresetOverride = {
  model?: string;
  thinking?: ThinkingLevel;
  /** Relative prompt path; the resolver also carries the resolved absolute file. */
  prompt?: string;
  promptFile?: string;
  /** Vision sidecar override for this role in this preset. */
  image?: string;
  /** Vision sidecar instruction file override for this preset. */
  imagePrompt?: string;
  imagePromptFile?: string;
};

/** A named mode that selects which roles are active and overrides their runtime settings. */
export type AgentPreset = {
  name: string;
  /** Canonical names of the roles this preset activates, in listed order. */
  roleNames: string[];
  /** Canonical role name to override. */
  overrides: Map<string, AgentPresetOverride>;
};

export type AgentsConfig = {
  path: string;
  version: 1;
  defaults: AgentsDefaults;
  /** Canonical name of the preset used when the user has not chosen one. */
  defaultPreset?: string;
  roles: AgentRole[];
  presets: AgentPreset[];
};

export type AgentsConfigValidation = {
  ok: boolean;
  errors: string[];
};

export type LoadAgentsConfigOptions = {
  cwd?: string;
  homeDir?: string;
  /** Override the bundled fallback path, primarily for isolated verification. */
  packagePath?: string;
};

const ROOT_KEYS = ["version", "defaults", "roles", "presets", "default_preset"];
const DEFAULT_KEYS = ["maxDepth", "concurrency", "timeoutMinutes", "image", "imagePrompt"];
const ROLE_KEYS = [
  "description",
  "model",
  "thinking",
  "prompt",
  "tools",
  "delegates",
  "skills",
  "timeoutMinutes",
  "backend",
  "backendOptions",
  "image",
  "imagePrompt",
];
const PRESET_KEYS = ["model", "thinking", "prompt", "image", "imagePrompt"];

const BUNDLED_AGENTS_PATH = fileURLToPath(new URL("../../resources/agents.yaml", import.meta.url));

/** The project file wins completely, then global config, then the package defaults. */
export function projectAgentsPath(cwd: string = process.cwd()): string {
  return path.join(cwd, ".pi", AGENTS_CONFIG_FILE_NAME);
}

export function globalAgentsPath(homeDir: string = os.homedir()): string {
  return path.join(homeDir, ".config", "pi", AGENTS_CONFIG_FILE_NAME);
}

export function packageAgentsPath(packagePath?: string): string {
  return packagePath ?? BUNDLED_AGENTS_PATH;
}

export function agentsConfigPath(options: LoadAgentsConfigOptions = {}): string {
  const project = projectAgentsPath(options.cwd);
  if (fs.existsSync(project)) return project;

  const global = globalAgentsPath(options.homeDir);
  if (fs.existsSync(global)) return global;

  return packageAgentsPath(options.packagePath);
}

/** Load one complete config, without merging project, global, or package sources. */
export function loadAgentsConfig(options: LoadAgentsConfigOptions = {}): AgentsConfig {
  const file = agentsConfigPath(options);

  let source: string;
  try {
    source = fs.readFileSync(file, "utf8");
  } catch (error) {
    throw new Error(`Cannot read ${file}: ${errorMessage(error)}`);
  }

  let value: unknown;
  try {
    value = parseYaml(source, { prettyErrors: true, strict: true });
  } catch (error) {
    throw new Error(`Invalid YAML in ${file}: ${errorMessage(error)}`);
  }

  return parseAgentsConfig(value, file);
}

/** Parse and strictly validate the locked v1 schema. */
export function parseAgentsConfig(value: unknown, sourcePath: string): AgentsConfig {
  if (!isRecord(value)) throw new Error("agents.yaml must contain a YAML object.");
  assertOnlyKeys(value, ROOT_KEYS, "agents.yaml");

  if (value.version !== 1) throw new Error("agents.yaml version must be exactly 1.");

  const defaults = parseDefaults(value.defaults, sourcePath);
  const roles = parseRoles(value.roles, sourcePath);
  const presets = parsePresets(value.presets, roles, sourcePath);
  const defaultPreset = parseDefaultPreset(value.default_preset, presets);
  return { path: sourcePath, version: 1, defaults, roles, presets, ...(defaultPreset === undefined ? {} : { defaultPreset }) };
}

/** Return diagnostics without throwing, useful for a config-check command or tests. */
export function validateAgentsConfig(value: unknown, sourcePath = "agents.yaml"): AgentsConfigValidation {
  try {
    parseAgentsConfig(value, sourcePath);
    return { ok: true, errors: [] };
  } catch (error) {
    return { ok: false, errors: [errorMessage(error)] };
  }
}

/** Validate whichever supported file would be selected, preserving file priority. */
export function validateAgentsFile(options: LoadAgentsConfigOptions = {}): {
  exists: boolean;
  path?: string;
  ok: boolean;
  errors: string[];
} {
  const file = agentsConfigPath(options);
  try {
    loadAgentsConfig(options);
    return { exists: true, path: file, ok: true, errors: [] };
  } catch (error) {
    return { exists: true, path: file, ok: false, errors: [errorMessage(error)] };
  }
}

function parseDefaults(value: unknown, sourcePath: string): AgentsDefaults {
  if (!isRecord(value)) throw new Error("defaults must be an object.");
  assertOnlyKeys(value, DEFAULT_KEYS, "defaults");
  const imagePrompt =
    value.imagePrompt === undefined ? undefined : promptRef(value.imagePrompt, "defaults.imagePrompt", sourcePath);
  return {
    maxDepth: nonNegativeInteger(value.maxDepth, "defaults.maxDepth"),
    concurrency: positiveInteger(value.concurrency, "defaults.concurrency"),
    timeoutMinutes: positiveInteger(value.timeoutMinutes, "defaults.timeoutMinutes"),
    ...(value.image === undefined ? {} : { image: providerModelId(value.image, "defaults.image") }),
    ...(imagePrompt === undefined
      ? {}
      : { imagePrompt: imagePrompt.path, imagePromptFile: imagePrompt.file }),
  };
}

function parsePresets(value: unknown, roles: AgentRole[], sourcePath: string): AgentPreset[] {
  if (value === undefined) return [];
  if (!isRecord(value)) throw new Error("presets must be an object.");

  const names = new Map<string, string>();
  const result: AgentPreset[] = [];
  for (const [name, presetValue] of Object.entries(value)) {
    if (!nonEmpty(name)) throw new Error("Preset names must not be blank.");
    const key = name.toLowerCase();
    if (names.has(key)) throw new Error(`Preset names must be unique: ${name}.`);
    names.set(key, name);
    if (!isRecord(presetValue)) throw new Error(`Preset ${name} must be an object.`);

    const roleNames = parsePresetRoleNames(presetValue.roles, name, roles);
    const overrides = new Map<string, AgentPresetOverride>();
    for (const [roleName, overrideValue] of Object.entries(presetValue)) {
      if (roleName === "roles") continue;
      const role = roles.find((candidate) => candidate.name.toLowerCase() === roleName.toLowerCase());
      if (!role) throw new Error(`Preset ${name} references unknown role: ${roleName}.`);
      if (overrides.has(role.name)) throw new Error(`Preset ${name} lists role ${role.name} more than once.`);
      if (!isRecord(overrideValue)) throw new Error(`Preset ${name}.${roleName} must be an object.`);
      assertOnlyKeys(overrideValue, PRESET_KEYS, `Preset ${name}.${roleName}`);
      overrides.set(role.name, parsePresetOverride(overrideValue, name, roleName, sourcePath));
    }

    const active = new Set(roleNames);
    for (const roleName of overrides.keys()) {
      if (!active.has(roleName)) {
        throw new Error(`Preset ${name} overrides role ${roleName} but does not activate it in roles.`);
      }
    }

    result.push({ name, roleNames, overrides });
  }
  return result;
}

function parsePresetRoleNames(value: unknown, presetName: string, roles: AgentRole[]): string[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error(`Preset ${presetName}.roles must be a non-empty array of role names.`);
  }
  const canonical = new Map(roles.map((role) => [role.name.toLowerCase(), role.name]));
  const seen = new Set<string>();
  const result: string[] = [];
  for (const item of value) {
    if (!nonEmpty(item)) throw new Error(`Preset ${presetName}.roles must contain non-empty strings.`);
    const target = canonical.get(item.toLowerCase());
    if (!target) throw new Error(`Preset ${presetName}.roles references unknown role: ${item}.`);
    if (seen.has(target)) throw new Error(`Preset ${presetName}.roles must not contain duplicates: ${item}.`);
    seen.add(target);
    result.push(target);
  }
  return result;
}

function parsePresetOverride(
  value: Record<string, unknown>,
  presetName: string,
  roleName: string,
  sourcePath: string,
): AgentPresetOverride {
  const override: AgentPresetOverride = {};
  if (value.model !== undefined) {
    const model = nonEmptyString(value.model, `Preset ${presetName}.${roleName}.model`);
    if (!/^\S+\/\S+$/.test(model)) {
      throw new Error(`Preset ${presetName}.${roleName}.model must be a direct provider/model ID.`);
    }
    override.model = model;
  }
  if (value.thinking !== undefined) {
    const thinking = nonEmptyString(value.thinking, `Preset ${presetName}.${roleName}.thinking`);
    if (!THINKING_LEVELS.includes(thinking as ThinkingLevel)) {
      throw new Error(`Preset ${presetName}.${roleName}.thinking has an invalid value: ${thinking}.`);
    }
    override.thinking = thinking as ThinkingLevel;
  }
  if (value.image !== undefined) {
    override.image = providerModelId(value.image, `Preset ${presetName}.${roleName}.image`);
  }
  if (value.imagePrompt !== undefined) {
    const ref = promptRef(value.imagePrompt, `Preset ${presetName}.${roleName}.imagePrompt`, sourcePath);
    override.imagePrompt = ref.path;
    override.imagePromptFile = ref.file;
  }
  if (value.prompt !== undefined) {
    const prompt = nonEmptyString(value.prompt, `Preset ${presetName}.${roleName}.prompt`);
    if (path.isAbsolute(prompt) || prompt.split(/[\\/]/).includes("..")) {
      throw new Error(`Preset ${presetName}.${roleName}.prompt must be a relative path inside .pi.`);
    }
    const promptFile = path.resolve(path.dirname(sourcePath), prompt);
    try {
      fs.accessSync(promptFile, fs.constants.R_OK);
    } catch {
      throw new Error(`Preset ${presetName}.${roleName}.prompt file not found or unreadable: ${promptFile}`);
    }
    override.prompt = prompt;
    override.promptFile = promptFile;
  }
  return override;
}

function parseDefaultPreset(value: unknown, presets: AgentPreset[]): string | undefined {
  if (value === undefined) {
    if (presets.length > 0) throw new Error("presets requires default_preset at the root.");
    return undefined;
  }
  const name = nonEmptyString(value, "default_preset");
  const match = presets.find((preset) => preset.name.toLowerCase() === name.toLowerCase());
  if (!match) throw new Error(`default_preset references unknown preset: ${name}.`);
  return match.name;
}

/** Resolve the roles a preset activates, with overrides applied. Roles without a preset keep their own defaults. */
export function resolvePreset(config: AgentsConfig, presetName?: string): { preset?: AgentPreset; roles: AgentRole[] } {
  const preset = presetName ? resolvePresetOrThrow(config, presetName) : undefined;
  const source = preset
    ? preset.roleNames.map((name) => {
        const role = config.roles.find((candidate) => candidate.name === name);
        if (!role) throw new Error(`Preset ${preset.name} activates unknown role: ${name}.`);
        return role;
      })
    : config.roles;
  const roles = source.map((role) => {
    const override = preset?.overrides.get(role.name);
    const image = override?.image ?? role.image ?? config.defaults.image;
    const imagePrompt = override?.imagePrompt ?? role.imagePrompt ?? config.defaults.imagePrompt;
    const imagePromptFile = override?.imagePromptFile ?? role.imagePromptFile ?? config.defaults.imagePromptFile;
    const resolved: AgentRole = {
      ...role,
      ...(image === undefined ? {} : { image }),
      ...(imagePrompt === undefined
        ? {}
        : { imagePrompt, ...(imagePromptFile === undefined ? {} : { imagePromptFile }) }),
    };
    if (!override) return resolved;
    return {
      ...resolved,
      ...(override.model === undefined ? {} : { model: override.model }),
      ...(override.thinking === undefined ? {} : { thinking: override.thinking }),
      ...(override.prompt === undefined ? {} : { promptPath: override.prompt, promptFile: override.promptFile }),
    };
  });
  return { preset, roles };
}

function resolvePresetOrThrow(config: AgentsConfig, presetName: string): AgentPreset {
  const preset = config.presets.find((candidate) => candidate.name.toLowerCase() === presetName.toLowerCase());
  if (!preset) throw new Error(`Unknown agents preset: ${presetName}.`);
  return preset;
}

function parseRoles(value: unknown, sourcePath: string): AgentRole[] {
  if (!isRecord(value)) throw new Error("roles must be an object.");
  const roles = Object.entries(value).map(([name, role]) => parseRole(name, role, sourcePath));
  if (roles.length === 0) throw new Error("roles must contain at least one role.");

  const names = new Map<string, string>();
  for (const role of roles) {
    const key = role.name.toLowerCase();
    if (names.has(key)) throw new Error(`Role names must be unique: ${role.name}.`);
    names.set(key, role.name);
  }

  return roles.map((role) => ({
    ...role,
    delegates: role.delegates.map((delegate) => {
      const canonical = names.get(delegate.toLowerCase());
      if (canonical === undefined) {
        throw new Error(`Role ${role.name}.delegates references unknown role: ${delegate}.`);
      }
      return canonical;
    }),
  }));
}

function parseRole(name: string, value: unknown, sourcePath: string): AgentRole {
  if (!nonEmpty(name)) throw new Error("Role names must not be blank.");
  if (!isRecord(value)) throw new Error(`Role ${name} must be an object.`);
  assertOnlyKeys(value, ROLE_KEYS, `Role ${name}`);

  const description = nonEmptyString(value.description, `Role ${name}.description`);
  const model = nonEmptyString(value.model, `Role ${name}.model`);
  if (!/^\S+\/\S+$/.test(model)) {
    throw new Error(`Role ${name}.model must be a direct provider/model ID.`);
  }

  const thinking = nonEmptyString(value.thinking, `Role ${name}.thinking`);
  if (!THINKING_LEVELS.includes(thinking as ThinkingLevel)) {
    throw new Error(`Role ${name}.thinking has an invalid value: ${thinking}.`);
  }

  const promptPath = nonEmptyString(value.prompt, `Role ${name}.prompt`);
  if (path.isAbsolute(promptPath) || promptPath.split(/[\\/]/).includes("..")) {
    throw new Error(`Role ${name}.prompt must be a relative path inside .pi.`);
  }
  const promptFile = path.resolve(path.dirname(sourcePath), promptPath);
  try {
    fs.accessSync(promptFile, fs.constants.R_OK);
  } catch {
    throw new Error(`Role ${name}.prompt file not found or unreadable: ${promptFile}`);
  }

  const tools = stringArray(value.tools, `Role ${name}.tools`, true);
  if (tools.includes("subagent")) {
    throw new Error(`Role ${name}.tools must not include subagent; use delegates instead.`);
  }
  const delegates =
    value.delegates === undefined
      ? []
      : stringArray(value.delegates, `Role ${name}.delegates`, false, true);
  const skills = value.skills === undefined ? undefined : stringArray(value.skills, `Role ${name}.skills`, false);
  const timeoutMinutes =
    value.timeoutMinutes === undefined
      ? undefined
      : positiveInteger(value.timeoutMinutes, `Role ${name}.timeoutMinutes`);
  const backend = value.backend === undefined ? "native" : agentBackend(value.backend, `Role ${name}.backend`);
  const backendOptions = value.backendOptions === undefined
    ? undefined
    : backendArray(value.backendOptions, `Role ${name}.backendOptions`);
  if (backendOptions && !backendOptions.includes(backend)) {
    throw new Error(`Role ${name}.backend must be listed in backendOptions.`);
  }
  const image = value.image === undefined ? undefined : providerModelId(value.image, `Role ${name}.image`);
  const imagePrompt =
    value.imagePrompt === undefined ? undefined : promptRef(value.imagePrompt, `Role ${name}.imagePrompt`, sourcePath);

  return {
    name,
    description,
    model,
    thinking: thinking as ThinkingLevel,
    promptPath,
    promptFile,
    tools,
    delegates,
    backend,
    ...(backendOptions === undefined ? {} : { backendOptions }),
    ...(skills === undefined ? {} : { skills }),
    ...(timeoutMinutes === undefined ? {} : { timeoutMinutes }),
    ...(image === undefined ? {} : { image }),
    ...(imagePrompt === undefined
      ? {}
      : { imagePrompt: imagePrompt.path, imagePromptFile: imagePrompt.file }),
  };
}

function stringArray(value: unknown, label: string, required: boolean, caseInsensitiveDuplicates = false): string[] {
  if (!Array.isArray(value) || (required && value.length === 0)) {
    throw new Error(`${label} must be a non-empty array of strings.`);
  }
  const result: string[] = [];
  const seen = new Set<string>();
  for (const item of value) {
    if (!nonEmpty(item)) throw new Error(`${label} must contain non-empty strings.`);
    const key = caseInsensitiveDuplicates ? item.toLowerCase() : item;
    if (seen.has(key)) {
      const qualifier = caseInsensitiveDuplicates ? "case-insensitive " : "";
      throw new Error(`${label} must not contain ${qualifier}duplicates: ${item}.`);
    }
    seen.add(key);
    result.push(item);
  }
  return result;
}

function agentBackend(value: unknown, label: string): AgentBackend {
  if (typeof value !== "string" || !AGENT_BACKENDS.includes(value as AgentBackend)) {
    throw new Error(`${label} must be one of: ${AGENT_BACKENDS.join(", ")}.`);
  }
  return value as AgentBackend;
}

function backendArray(value: unknown, label: string): AgentBackend[] {
  if (!Array.isArray(value) || value.length === 0) throw new Error(`${label} must be a non-empty array.`);
  const result = value.map((item) => agentBackend(item, label));
  if (new Set(result).size !== result.length) throw new Error(`${label} must not contain duplicates.`);
  return result;
}

function providerModelId(value: unknown, label: string): string {
  const id = nonEmptyString(value, label);
  if (!/^\S+\/\S+$/.test(id)) throw new Error(`${label} must be a direct provider/model ID.`);
  return id;
}

/** Resolve a relative prompt reference against the config file and require it to exist. */
function promptRef(value: unknown, label: string, sourcePath: string): { path: string; file: string } {
  const relative = nonEmptyString(value, label);
  if (path.isAbsolute(relative) || relative.split(/[\\/]/).includes("..")) {
    throw new Error(`${label} must be a relative path inside .pi.`);
  }
  const file = path.resolve(path.dirname(sourcePath), relative);
  try {
    fs.accessSync(file, fs.constants.R_OK);
  } catch {
    throw new Error(`${label} file not found or unreadable: ${file}`);
  }
  return { path: relative, file };
}

function positiveInteger(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${label} must be a positive integer.`);
  }
  return value;
}

function nonNegativeInteger(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${label} must be a non-negative integer.`);
  }
  return value;
}

function assertOnlyKeys(value: Record<string, unknown>, allowed: readonly string[], label: string): void {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) throw new Error(`${label} has unknown property: ${key}.`);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonEmpty(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function nonEmptyString(value: unknown, label: string): string {
  if (!nonEmpty(value)) throw new Error(`${label} must be a non-empty string.`);
  return value;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
