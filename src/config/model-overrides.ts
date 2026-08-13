import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export const AGENTS_MODEL_OVERRIDES_FILE_NAME = "agents-model-overrides.json";
const NO_PRESET = "$default";

type OverrideFile = Record<string, Record<string, Record<string, string>>>;

export type AgentModelOverrideStore = {
  get(configPath: string, preset: string | undefined, role: string): string | undefined;
  set(configPath: string, preset: string | undefined, role: string, model: string | undefined): void;
};

export function agentsModelOverridesPath(homeDir: string = os.homedir()): string {
  return path.join(homeDir, ".config", "pi", AGENTS_MODEL_OVERRIDES_FILE_NAME);
}

/** Persist model choices per complete config, preset, and canonical role name. */
export function createAgentModelOverrideStore(homeDir: string = os.homedir()): AgentModelOverrideStore {
  const file = agentsModelOverridesPath(homeDir);
  return {
    get(configPath, preset, role) {
      const data = readOverrides(file);
      return data[configPath]?.[scopeKey(preset)]?.[role];
    },
    set(configPath, preset, role, model) {
      const data = readOverrides(file);
      const scope = scopeKey(preset);
      if (model === undefined) {
        delete data[configPath]?.[scope]?.[role];
        if (Object.keys(data[configPath]?.[scope] ?? {}).length === 0) delete data[configPath]?.[scope];
        if (Object.keys(data[configPath] ?? {}).length === 0) delete data[configPath];
      } else {
        data[configPath] ??= {};
        data[configPath]![scope] ??= {};
        data[configPath]![scope]![role] = model;
      }
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`, "utf8");
    },
  };
}

function scopeKey(preset: string | undefined): string {
  return preset ?? NO_PRESET;
}

function readOverrides(file: string): OverrideFile {
  try {
    const value = JSON.parse(fs.readFileSync(file, "utf8")) as unknown;
    if (!isRecord(value)) return {};
    const result: OverrideFile = {};
    for (const [configPath, scopes] of Object.entries(value)) {
      if (!isRecord(scopes)) continue;
      for (const [scope, roles] of Object.entries(scopes)) {
        if (!isRecord(roles)) continue;
        for (const [role, model] of Object.entries(roles)) {
          if (typeof model !== "string" || !/^\S+\/\S+$/.test(model)) continue;
          result[configPath] ??= {};
          result[configPath]![scope] ??= {};
          result[configPath]![scope]![role] = model;
        }
      }
    }
    return result;
  } catch {
    return {};
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
