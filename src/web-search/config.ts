import type { WebSearchConfig } from "./types.ts";

// Local policy, not model-controlled. Keep this tiny and deterministic.
export const DEFAULT_CONFIG: Required<Omit<WebSearchConfig, "region">> &
  Pick<WebSearchConfig, "region"> = {
  maxResults: 5,
  maxChars: 12000,
  timeoutMs: 10000,
  fetchTopN: 1,
  region: undefined,
};

export function loadConfig(): typeof DEFAULT_CONFIG {
  return DEFAULT_CONFIG;
}
