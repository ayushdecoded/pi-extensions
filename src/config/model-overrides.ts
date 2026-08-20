import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { THINKING_LEVELS, type AgentBackend, type ThinkingLevel } from "./agents.ts";

export const AGENTS_MODEL_OVERRIDES_FILE_NAME = "agents-model-overrides.json";
const NO_PRESET = "$default";

/** One role's persisted UI override: model and/or thinking. Omitted fields keep the preset value. */
export type RoleOverride = {
  model?: string;
  thinking?: ThinkingLevel;
};

/** Session-only execution override; backend is never persisted to disk. */
export type SessionRoleOverride = RoleOverride & {
  backend?: AgentBackend;
};

// File shape: { [configPath]: { [scope]: { [role]: string | { model?, thinking? } } } }
// String values are legacy model-only entries; objects carry model and/or thinking.
type ScopeMap = Record<string, unknown>;
type OverrideFile = Record<string, Record<string, ScopeMap>>;

export type AgentModelOverrideStore = {
  get(configPath: string, preset: string | undefined, role: string): RoleOverride | undefined;
  /** Merge a partial override; `undefined` removes the role entry entirely. */
  set(configPath: string, preset: string | undefined, role: string, override: Partial<RoleOverride> | undefined): void;
};

export function agentsModelOverridesPath(homeDir: string = os.homedir()): string {
  return path.join(homeDir, ".config", "pi", AGENTS_MODEL_OVERRIDES_FILE_NAME);
}

/** Persist model/thinking choices per complete config, preset, and canonical role name. */
export function projectAgentsModelOverridesPath(cwd: string = process.cwd()): string {
  return path.join(cwd, ".pi", AGENTS_MODEL_OVERRIDES_FILE_NAME);
}

export function createAgentModelOverrideStore(
  homeDir: string = os.homedir(),
  filePath?: string,
  storageKey?: string,
): AgentModelOverrideStore {
  const file = filePath ?? agentsModelOverridesPath(homeDir);
  return {
    get(configPath, preset, role) {
      const data = readOverrides(file);
      const key = storageKey ?? configPath;
      return parseRoleOverride(data[key]?.[scopeKey(preset)]?.[role])
        ?? (storageKey === undefined ? undefined : parseRoleOverride(data[configPath]?.[scopeKey(preset)]?.[role]));
    },
    set(configPath, preset, role, override) {
      const data = readOverrides(file);
      const key = storageKey ?? configPath;
      const scope = scopeKey(preset);
      if (override === undefined) {
        delete data[key]?.[scope]?.[role];
        if (storageKey !== undefined) delete data[configPath]?.[scope]?.[role];
      } else {
        const previous = parseRoleOverride(data[key]?.[scope]?.[role])
          ?? (storageKey === undefined ? undefined : parseRoleOverride(data[configPath]?.[scope]?.[role]))
          ?? {};
        const next: RoleOverride = {};
        // An explicitly-present key with `undefined` drops that field; an absent
        // key keeps the previous value (partial merge).
        if ("model" in override) {
          if (override.model !== undefined) next.model = override.model;
        } else if (previous.model !== undefined) {
          next.model = previous.model;
        }
        if ("thinking" in override) {
          if (override.thinking !== undefined) next.thinking = override.thinking;
        } else if (previous.thinking !== undefined) {
          next.thinking = previous.thinking;
        }
        if (Object.keys(next).length === 0) {
          delete data[key]?.[scope]?.[role];
          if (storageKey !== undefined) delete data[configPath]?.[scope]?.[role];
        } else {
          data[key] ??= {};
          data[key]![scope] ??= {};
          data[key]![scope]![role] = next;
        }
      }
      prune(data);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`, "utf8");
    },
  };
}

function scopeKey(preset: string | undefined): string {
  return preset ?? NO_PRESET;
}

function parseRoleOverride(value: unknown): RoleOverride | undefined {
  if (typeof value === "string") return /^\S+\/\S+$/.test(value) ? { model: value } : undefined;
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const result: RoleOverride = {};
  if (typeof record.model === "string" && /^\S+\/\S+$/.test(record.model)) result.model = record.model;
  if (typeof record.thinking === "string" && (THINKING_LEVELS as readonly string[]).includes(record.thinking)) {
    result.thinking = record.thinking as ThinkingLevel;
  }
  return Object.keys(result).length > 0 ? result : undefined;
}

function readOverrides(file: string): OverrideFile {
  try {
    const value = JSON.parse(fs.readFileSync(file, "utf8")) as unknown;
    return sanitize(value);
  } catch {
    return {};
  }
}

/** Keep only structurally valid entries so a corrupt file can never poison writes. */
function sanitize(value: unknown): OverrideFile {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const result: OverrideFile = {};
  for (const [configPath, scopes] of Object.entries(value)) {
    if (!scopes || typeof scopes !== "object" || Array.isArray(scopes)) continue;
    for (const [scope, roles] of Object.entries(scopes)) {
      if (!roles || typeof roles !== "object" || Array.isArray(roles)) continue;
      for (const [role, entry] of Object.entries(roles)) {
        if (parseRoleOverride(entry) === undefined) continue;
        result[configPath] ??= {};
        result[configPath]![scope] ??= {};
        result[configPath]![scope]![role] = entry;
      }
    }
  }
  return result;
}

function prune(data: OverrideFile): void {
  for (const configPath of Object.keys(data)) {
    for (const scope of Object.keys(data[configPath] ?? {})) {
      if (Object.keys(data[configPath]![scope] ?? {}).length === 0) delete data[configPath]![scope];
    }
    if (Object.keys(data[configPath] ?? {}).length === 0) delete data[configPath];
  }
}
