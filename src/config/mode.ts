import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentsConfig } from "./agents.ts";

export const AGENTS_MODE_FILE_NAME = "agents-mode.json";

/**
 * The active preset is stored per agents.yaml path in a single writable state
 * file, so every project keeps its own mode and bundled defaults never need a
 * writable directory.
 */
export function agentsModeStatePath(homeDir: string = os.homedir()): string {
  return path.join(homeDir, ".config", "pi", AGENTS_MODE_FILE_NAME);
}

export type ActiveModeStore = {
  load(configPath: string): string | undefined;
  save(configPath: string, mode: string | undefined): void;
};

export function createActiveModeStore(homeDir: string = os.homedir()): ActiveModeStore {
  const file = agentsModeStatePath(homeDir);
  return {
    load(configPath) {
      try {
        const data = JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown>;
        const value = data[configPath];
        return typeof value === "string" && value.length > 0 ? value : undefined;
      } catch {
        return undefined;
      }
    },
    save(configPath, mode) {
      let data: Record<string, string> = {};
      try {
        const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown>;
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
          data = parsed as Record<string, string>;
        }
      } catch {
        data = {};
      }
      if (mode === undefined) delete data[configPath];
      else data[configPath] = mode;
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`, "utf8");
    },
  };
}

/** The preset used before the user picks one: default_preset, else the first preset. */
export function defaultModeName(config: AgentsConfig): string | undefined {
  if (config.defaultPreset) return config.defaultPreset;
  return config.presets[0]?.name;
}

/** Persisted mode wins when it still exists in the config; otherwise the default. */
export function resolveActiveMode(config: AgentsConfig, persisted: string | undefined): string | undefined {
  if (persisted) {
    const match = config.presets.find((preset) => preset.name.toLowerCase() === persisted.toLowerCase());
    if (match) return match.name;
  }
  return defaultModeName(config);
}
