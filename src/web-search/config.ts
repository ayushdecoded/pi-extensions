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
  return {
    load() {
      try {
        const parsed = JSON.parse(fs.readFileSync(filePath, "utf8")) as Record<string, unknown>;
        return typeof parsed.parallelApiKey === "string" && parsed.parallelApiKey.trim()
          ? { parallelApiKey: parsed.parallelApiKey.trim() }
          : {};
      } catch {
        return {};
      }
    },
    save(settings) {
      const directory = path.dirname(filePath);
      fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
      fs.chmodSync(directory, 0o700);
      fs.writeFileSync(filePath, `${JSON.stringify(settings, null, 2)}\n`, { mode: 0o600 });
      fs.chmodSync(filePath, 0o600);
    },
  };
}

export function loadWebSearchSettings(): WebSearchSettings {
  return createWebSearchSettingsStore().load();
}
