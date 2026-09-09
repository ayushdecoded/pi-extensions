import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { WebSearchSettings, WebSearchSettingsStore } from "./types.ts";

export function webSearchSettingsPath(homeDir: string = os.homedir()): string {
  return path.join(homeDir, ".config", "pi", "web-search.json");
}

export function createWebSearchSettingsStore(
  filePath: string = webSearchSettingsPath(),
): WebSearchSettingsStore {
  let cachedMtimeMs = -1;
  let cached: WebSearchSettings = {};
  let loadedOnce = false;
  return {
    load() {
      try {
        const mtimeMs = fs.statSync(filePath).mtimeMs;
        if (loadedOnce && mtimeMs === cachedMtimeMs) return cached;
        const parsed = JSON.parse(fs.readFileSync(filePath, "utf8")) as Record<string, unknown>;
        cached = typeof parsed.parallelApiKey === "string" && parsed.parallelApiKey.trim()
          ? { parallelApiKey: parsed.parallelApiKey.trim() }
          : {};
        cachedMtimeMs = mtimeMs;
        loadedOnce = true;
        return cached;
      } catch {
        // Missing file: return cached empty without retrying stat every call
        // once confirmed absent; a later save() invalidates the cache below.
        if (loadedOnce) return cached;
        loadedOnce = true;
        cached = {};
        cachedMtimeMs = -1;
        return cached;
      }
    },
    save(settings) {
      const directory = path.dirname(filePath);
      fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
      fs.chmodSync(directory, 0o700);
      fs.writeFileSync(filePath, `${JSON.stringify(settings, null, 2)}\n`, { mode: 0o600 });
      fs.chmodSync(filePath, 0o600);
      try {
        cachedMtimeMs = fs.statSync(filePath).mtimeMs;
      } catch {
        cachedMtimeMs = -1;
      }
      cached = { ...settings };
      loadedOnce = true;
    },
  };
}

export function loadWebSearchSettings(): WebSearchSettings {
  return createWebSearchSettingsStore().load();
}
