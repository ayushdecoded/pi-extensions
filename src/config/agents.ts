import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";

export const AGENTS_CONFIG_FILE_NAME = "agents.yaml";
export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh"] as const;

export type ThinkingLevel = (typeof THINKING_LEVELS)[number];

export type AgentsDefaults = {
  maxDepth: number;
  concurrency: number;
  timeoutMinutes: number;
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
};

export type AgentsConfig = {
  path: string;
  version: 1;
  defaults: AgentsDefaults;
  roles: AgentRole[];
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

const ROOT_KEYS = ["version", "defaults", "roles"];
const DEFAULT_KEYS = ["maxDepth", "concurrency", "timeoutMinutes"];
const ROLE_KEYS = [
  "description",
  "model",
  "thinking",
  "prompt",
  "tools",
  "delegates",
  "skills",
  "timeoutMinutes",
];

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

  const defaults = parseDefaults(value.defaults);
  const roles = parseRoles(value.roles, sourcePath);
  return { path: sourcePath, version: 1, defaults, roles };
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

function parseDefaults(value: unknown): AgentsDefaults {
  if (!isRecord(value)) throw new Error("defaults must be an object.");
  assertOnlyKeys(value, DEFAULT_KEYS, "defaults");
  return {
    maxDepth: nonNegativeInteger(value.maxDepth, "defaults.maxDepth"),
    concurrency: positiveInteger(value.concurrency, "defaults.concurrency"),
    timeoutMinutes: positiveInteger(value.timeoutMinutes, "defaults.timeoutMinutes"),
  };
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

  return {
    name,
    description,
    model,
    thinking: thinking as ThinkingLevel,
    promptPath,
    promptFile,
    tools,
    delegates,
    ...(skills === undefined ? {} : { skills }),
    ...(timeoutMinutes === undefined ? {} : { timeoutMinutes }),
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
