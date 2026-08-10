import { complete } from "@earendil-works/pi-ai/compat";
import type { ModelRegistry } from "@earendil-works/pi-coding-agent";
import { stripLeadingRoleNames } from "./ui/roles.ts";

const MODEL_PROVIDER = "openai-codex";
const MODEL_ID = "gpt-5.3-codex-spark";
const MAX_WORDS = 6;

export type SubagentHeadingInput = { role: string; task: string };
export type SubagentHeadings = { call: string; requests: string[] };
export type SubagentHeadingGenerator = (
  requests: readonly SubagentHeadingInput[],
  signal: AbortSignal,
) => Promise<SubagentHeadings | undefined>;

export function createSubagentHeadingGenerator(
  modelRegistry: ModelRegistry,
  codexProvider: () => string = () => MODEL_PROVIDER,
): SubagentHeadingGenerator {
  return async (requests, signal) => {
    const model = modelRegistry.find(codexProvider(), MODEL_ID) ?? modelRegistry.find(MODEL_PROVIDER, MODEL_ID);
    if (!model) return undefined;
    const auth = await modelRegistry.getApiKeyAndHeaders(model);
    if (!auth.ok || !auth.apiKey || signal.aborted) return undefined;

    const response = await complete(
      model,
      {
        messages: [{
          role: "user",
          content: [{
            type: "text",
            text: [
              "Create concise UI headings for this subagent delegation call.",
              "Return JSON only with this exact shape:",
              '{"call":"up to 6 words","requests":["up to 6 words per request"]}',
              "The requests array must preserve input order and length.",
              "Describe the work; do not judge progress or results.",
              "Do not include agent role names in the call heading.",
              "No markdown, quotes inside headings, or ending punctuation.",
              "",
              JSON.stringify(requests),
            ].join("\n"),
          }],
          timestamp: Date.now(),
        }],
      },
      { apiKey: auth.apiKey, headers: auth.headers, env: auth.env, maxTokens: 256, signal },
    );

    const text = response.content
      .filter((part): part is { type: "text"; text: string } => part.type === "text")
      .map((part) => part.text)
      .join("\n");
    const headings = parseSubagentHeadings(text, requests.length);
    return headings ? {
      ...headings,
      call: stripLeadingRoleNames(headings.call, requests.map((request) => request.role)),
    } : undefined;
  };
}

export function parseSubagentHeadings(text: string, requestCount: number): SubagentHeadings | undefined {
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) return undefined;
  try {
    const value = JSON.parse(match[0]) as { call?: unknown; requests?: unknown };
    const call = normalizeHeading(value.call);
    if (!call || !Array.isArray(value.requests)) return undefined;
    const rawRequests = value.requests as unknown[];
    const requests = Array.from({ length: requestCount }, (_, index) => normalizeHeading(rawRequests[index]));
    if (requests.some((heading) => !heading)) return undefined;
    return { call, requests: requests as string[] };
  } catch {
    return undefined;
  }
}

export function normalizeHeading(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const clean = value
    .replace(/\x1B\][\s\S]*?(?:\x07|\x1B\\)/g, "")
    .replace(/\x1B[P^_X][\s\S]*?\x1B\\/g, "")
    .replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/[\u0000-\u001F\u007F]/g, " ")
    .replace(/[`*_#]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[.!?]+$/, "")
    .trim();
  const words = clean.split(" ").filter(Boolean);
  return words.length ? words.slice(0, MAX_WORDS).join(" ") : undefined;
}
