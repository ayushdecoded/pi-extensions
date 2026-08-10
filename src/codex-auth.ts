import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { ProviderHeaders } from "@earendil-works/pi-ai";
import { canonicalProviderId } from "./accounts/providers.ts";

/**
 * Shared ChatGPT/Codex OAuth helpers for pack features that call OpenAI's
 * backend-api endpoints using the active Codex login (the same credential
 * painter uses for image generation).
 */

/** Resolve the ChatGPT access token and account headers for the selected Codex login. */
export async function codexAuth(
  ctx: ExtensionContext,
  feature = "This feature",
  preferredProviderId?: string,
): Promise<{ apiKey: string; headers?: ProviderHeaders }> {
  const model = ctx.model && canonicalProviderId(ctx.model.provider) === "openai-codex"
    ? ctx.model
    : preferredProviderId
      ? ctx.modelRegistry.getAll().find((candidate) => candidate.provider === preferredProviderId)
      : ctx.modelRegistry.getAll().find((candidate) => canonicalProviderId(candidate.provider) === "openai-codex");
  if (!model) throw new Error(`${feature} requires an OpenAI Codex login. Select an openai-codex model and sign in first.`);
  const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
  if (!auth.ok || !auth.apiKey) throw new Error(`${feature} could not access Codex OAuth credentials${auth.ok ? "." : `: ${auth.error}`}`);
  return { apiKey: auth.apiKey, headers: auth.headers };
}

/**
 * Base headers for ChatGPT backend-api calls: Bearer token, JSON accept,
 * provider-supplied account headers, and a ChatGPT-Account-ID derived from
 * the JWT when the provider did not supply one. Consumers add their own
 * endpoint-specific headers (originator, User-Agent, ...).
 */
export function codexAuthHeaders(apiKey: string, authHeaders: ProviderHeaders | undefined): Record<string, string> {
  const headers: Record<string, string> = {
    "Authorization": `Bearer ${apiKey}`,
    "Accept": "application/json",
  };
  // Null values are header-deletion markers: drop them rather than sending
  // them to fetch (which would serialize null as the literal string "null").
  for (const [name, value] of Object.entries(authHeaders ?? {})) {
    if (value !== null) headers[name] = value;
  }
  if (!header(headers, "ChatGPT-Account-ID")) {
    const accountId = accountIdFromToken(apiKey);
    if (accountId) headers["ChatGPT-Account-ID"] = accountId;
  }
  return headers;
}

function header(headers: Record<string, string>, name: string): string | undefined {
  const target = name.toLowerCase();
  return Object.entries(headers).find(([key]) => key.toLowerCase() === target)?.[1];
}

function accountIdFromToken(token: string): string | undefined {
  try {
    const payload = token.split(".")[1];
    if (!payload) return undefined;
    const decoded = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as Record<string, { chatgpt_account_id?: string } | undefined>;
    return decoded["https://api.openai.com/auth"]?.chatgpt_account_id;
  } catch {
    return undefined;
  }
}
