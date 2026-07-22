import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

const USAGE_URL = "https://chatgpt.com/backend-api/wham/usage";
const REFRESH_INTERVAL_MS = 5 * 60_000;

type LimitWindow = {
  used_percent?: number | string;
  usedPercent?: number | string;
  limit_window_seconds?: number;
  limitWindowSeconds?: number;
  window_seconds?: number;
  windowSeconds?: number;
};

export type CodexUsageController = {
  start(ctx: ExtensionContext, onUpdate: (remaining: number | undefined) => void): void;
  stop(): void;
  refresh(): Promise<void>;
};

export function createCodexUsageController(): CodexUsageController {
  let ctx: ExtensionContext | undefined;
  let timer: ReturnType<typeof setInterval> | undefined;
  let refreshing = false;
  let update: ((remaining: number | undefined) => void) | undefined;

  return {
    start(nextCtx, onUpdate) {
      this.stop();
      if (nextCtx.mode !== "tui") return;
      ctx = nextCtx;
      update = onUpdate;
      void this.refresh();
      timer = setInterval(() => void this.refresh(), REFRESH_INTERVAL_MS);
    },
    stop() {
      if (timer) clearInterval(timer);
      timer = undefined;
      ctx = undefined;
      update = undefined;
      refreshing = false;
    },
    async refresh() {
      if (!ctx || refreshing) return;
      refreshing = true;
      try {
        if (ctx.model?.provider !== "openai-codex") {
          update?.(undefined);
          return;
        }
        const authResult = await ctx.modelRegistry.getApiKeyAndHeaders(ctx.model);
        if (!authResult.ok) {
          update?.(undefined);
          return;
        }
        const apiKey = authResult.apiKey;
        if (!apiKey) {
          update?.(undefined);
          return;
        }

        const accountId = authResult.headers?.["ChatGPT-Account-ID"] ?? extractAccountId(apiKey);
        const headers: Record<string, string> = {
          Authorization: `Bearer ${apiKey}`,
          Accept: "application/json",
          "OpenAI-Beta": "codex-1",
          originator: "Pi",
        };
        if (typeof accountId === "string") headers["ChatGPT-Account-ID"] = accountId;

        const response = await fetch(USAGE_URL, { headers });
        if (!response.ok) throw new Error(`usage request failed: ${response.status}`);
        const payload = (await response.json()) as {
          rate_limit?: { secondary_window?: LimitWindow | null; secondary?: LimitWindow | null; primary_window?: LimitWindow | null; primary?: LimitWindow | null };
          rateLimits?: { secondary_window?: LimitWindow | null; secondary?: LimitWindow | null; primary_window?: LimitWindow | null; primary?: LimitWindow | null };
        };
        const rateLimit = payload.rate_limit ?? payload.rateLimits;
        const windows = [
          rateLimit?.primary_window,
          rateLimit?.secondary_window,
          rateLimit?.primary,
          rateLimit?.secondary,
        ];
        const weekly = windows.find((window) => window && windowLength(window) === 604_800);
        const rawUsed = weekly?.used_percent ?? weekly?.usedPercent;
        const used = typeof rawUsed === "string" ? Number(rawUsed) : rawUsed;
        update?.(typeof used === "number" && Number.isFinite(used) ? clamp(100 - used, 0, 100) : undefined);
      } catch {
        update?.(undefined);
      } finally {
        refreshing = false;
      }
    },
  };
}

function windowLength(window: LimitWindow): number | undefined {
  return window.limit_window_seconds ?? window.limitWindowSeconds ?? window.window_seconds ?? window.windowSeconds;
}

function extractAccountId(token: string): string | undefined {
  try {
    const payload = token.split(".")[1];
    if (!payload) return undefined;
    const decoded = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as {
      [key: string]: { chatgpt_account_id?: string } | undefined;
    };
    const accountId = decoded["https://api.openai.com/auth"]?.chatgpt_account_id;
    return typeof accountId === "string" && accountId ? accountId : undefined;
  } catch {
    return undefined;
  }
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
