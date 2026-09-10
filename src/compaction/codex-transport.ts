import type { ProviderHeaders, Api, Model, ThinkingLevel, Usage } from "@earendil-works/pi-ai";
import { calculateCost } from "@earendil-works/pi-ai";
import { codexAuthHeaders } from "../codex-auth.ts";
import type { convertResponsesMessages, convertResponsesTools } from "@earendil-works/pi-ai/api/openai-responses-shared";

/** The opaque artifact returned by the Codex compaction endpoint. */
export interface CodexCompactionArtifact {
  type: "compaction";
  id?: string;
  encrypted_content: string;
}

export type CodexResponsesInput = ReturnType<typeof convertResponsesMessages>;
export type CodexResponsesTools = ReturnType<typeof convertResponsesTools>;

export interface CodexCompactionOptions {
  model: Model<Api>;
  apiKey: string;
  headers?: ProviderHeaders;
  input: CodexResponsesInput;
  tools?: CodexResponsesTools;
  instructions: string;
  signal?: AbortSignal;
  thinking?: ThinkingLevel | "none";
  timeoutMs?: number;
  fetch?: typeof fetch;
}

export interface CodexCompactionResult {
  artifact: CodexCompactionArtifact;
  usage: Usage;
}

const DEFAULT_TIMEOUT_MS = 180_000;
const MAX_BYTES = 16 * 1024 * 1024;
const CODEX_API = "openai-codex-responses";

class CodexCompactionError extends Error {}

/**
 * Request one stateless Codex compaction. This deliberately has no retry or
 * fallback behavior: callers decide whether and when to use native compaction.
 */
export async function requestCodexCompaction(
  options: CodexCompactionOptions,
): Promise<CodexCompactionResult> {
  if (options.model.api !== CODEX_API) {
    throw new Error("Codex compaction requires the openai-codex-responses API");
  }
  if (typeof options.apiKey !== "string" || options.apiKey.length === 0) {
    throw new Error("Codex compaction requires an API key");
  }

  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  if (!Number.isFinite(timeoutMs) || timeoutMs < 0) {
    throw new Error("Codex compaction timeoutMs must be a finite non-negative number");
  }

  const url = resolveCodexResponsesUrl(options.model.baseUrl);
  const effort = resolveThinking(options.model, options.thinking);
  const body: Record<string, unknown> = {
    model: options.model.id,
    store: false,
    stream: true,
    input: [...options.input, { type: "compaction_trigger" }],
    instructions: options.instructions,
    include: ["reasoning.encrypted_content"],
    reasoning: { effort, summary: "auto" },
  };
  if (options.tools !== undefined) body.tools = options.tools;

  let bodyJson: string;
  try {
    bodyJson = JSON.stringify(body);
  } catch {
    throw new Error("Codex compaction request could not be encoded");
  }

  const controller = new AbortController();
  let timedOut = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const forwardAbort = (): void => controller.abort();
  if (options.signal?.aborted) forwardAbort();
  else options.signal?.addEventListener("abort", forwardAbort, { once: true });
  if (timeoutMs > 0) {
    timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, Math.floor(timeoutMs));
  }

  let rejectAbort: (reason?: unknown) => void = () => undefined;
  const abortPromise = new Promise<never>((_resolve, reject) => {
    rejectAbort = reject;
    controller.signal.addEventListener("abort", () => rejectAbort(new Error("aborted")), { once: true });
  });

  const fetchFn = options.fetch ?? fetch;
  try {
    if (controller.signal.aborted) throw new Error("aborted");
    const response = await Promise.race([
      Promise.resolve().then(() => fetchFn(url, {
        method: "POST",
        headers: {
          ...codexAuthHeaders(options.apiKey, options.headers),
          Accept: "text/event-stream",
          "Content-Type": "application/json",
          "OpenAI-Beta": "responses=experimental",
          originator: "pi",
          "User-Agent": "pi",
        },
        body: bodyJson,
        signal: controller.signal,
      })),
      abortPromise,
    ]);

    if (response.status < 200 || response.status >= 300) {
      throw new CodexCompactionError(`Codex compaction request failed: HTTP ${response.status}`);
    }
    if (!response.body) {
      throw new CodexCompactionError("Codex compaction response had no body");
    }

    const parsed = await readCodexSse(response.body, controller.signal, abortPromise);
    if (controller.signal.aborted) throw new Error("aborted");
    if (parsed.terminalCount === 0) {
      throw new CodexCompactionError("Codex compaction stream had no successful terminal event");
    }
    if (parsed.terminalCount !== 1) {
      throw new CodexCompactionError("Codex compaction stream had multiple terminal events");
    }
    if (parsed.status !== "completed") {
      throw new CodexCompactionError("Codex compaction response was not completed");
    }
    if (parsed.artifacts.length !== 1) {
      throw new CodexCompactionError("Codex compaction stream did not contain exactly one artifact");
    }

    const usage = usageFromResponse(parsed.usage, options.model);
    return { artifact: parsed.artifacts[0], usage };
  } catch (error) {
    if (timedOut) throw new Error(`Codex compaction request timed out after ${Math.floor(timeoutMs)}ms`);
    if (options.signal?.aborted) throw new Error("Codex compaction request was aborted");
    if (error instanceof CodexCompactionError) throw error;
    throw new Error("Codex compaction request failed");
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    options.signal?.removeEventListener("abort", forwardAbort);
    rejectAbort = () => undefined;
    controller.abort();
  }
}

interface ParsedSse {
  artifacts: CodexCompactionArtifact[];
  terminalCount: number;
  status?: string;
  usage?: unknown;
}

async function readCodexSse(
  body: ReadableStream<Uint8Array>,
  signal: AbortSignal,
  abortPromise: Promise<never>,
): Promise<ParsedSse> {
  const reader = body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let buffer = "";
  let totalBytes = 0;
  const parsed: ParsedSse = { artifacts: [], terminalCount: 0 };
  const artifacts = new Map<string, CodexCompactionArtifact>();
  // A terminal response commonly repeats the artifact emitted by the done
  // event. That copy is valid; two done events are a malformed stream and
  // must not be hidden by map de-duplication.
  const doneArtifacts = new Set<string>();

  const consume = (frame: string): void => {
    if (byteLength(frame) > MAX_BYTES) {
      throw new CodexCompactionError("Codex compaction SSE event exceeded the size limit");
    }
    const data = frame
      .split("\n")
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).startsWith(" ") ? line.slice(6) : line.slice(5))
      .join("\n");
    if (data === "" || data === "[DONE]") return;

    let event: unknown;
    try {
      event = JSON.parse(data);
    } catch {
      throw new CodexCompactionError("Codex compaction SSE event was not valid JSON");
    }
    if (!isRecord(event) || typeof event.type !== "string") {
      throw new CodexCompactionError("Codex compaction SSE event was malformed");
    }

    if (event.type === "error" || event.type === "response.failed" || event.type === "response.incomplete") {
      throw new CodexCompactionError("Codex compaction stream failed");
    }
    if (event.type === "response.output_item.done") {
      addArtifact(event.item, artifacts, doneArtifacts);
    }
    if (event.type === "response.completed" || event.type === "response.done") {
      parsed.terminalCount += 1;
      if (parsed.terminalCount > 1) {
        throw new CodexCompactionError("Codex compaction stream had multiple terminal events");
      }
      const response = event.response;
      if (!isRecord(response)) {
        throw new CodexCompactionError("Codex compaction terminal event was malformed");
      }
      if (typeof response.status !== "string") {
        throw new CodexCompactionError("Codex compaction terminal event had no status");
      }
      parsed.status = response.status;
      parsed.usage = response.usage;
      addResponseArtifacts(response.output, artifacts);
    }
  };

  const read = async (): Promise<ReadableStreamReadResult<Uint8Array>> =>
    Promise.race([reader.read(), abortPromise]);

  const onAbort = (): void => {
    void reader.cancel().catch(() => undefined);
  };
  signal.addEventListener("abort", onAbort, { once: true });
  try {
    while (true) {
      if (signal.aborted) throw new Error("aborted");
      const next = await read();
      if (next.done) break;
      totalBytes += next.value.byteLength;
      if (totalBytes > MAX_BYTES) {
        throw new CodexCompactionError("Codex compaction response exceeded the size limit");
      }
      try {
        buffer += decoder.decode(next.value, { stream: true });
      } catch {
        throw new CodexCompactionError("Codex compaction response was not valid UTF-8");
      }
      buffer = buffer.replace(/\r\n/g, "\n");
      let boundary = buffer.indexOf("\n\n");
      while (boundary >= 0) {
        consume(buffer.slice(0, boundary));
        buffer = buffer.slice(boundary + 2);
        boundary = buffer.indexOf("\n\n");
      }
      if (byteLength(buffer) > MAX_BYTES) {
        throw new CodexCompactionError("Codex compaction SSE event exceeded the size limit");
      }
    }

    try {
      buffer += decoder.decode();
    } catch {
      throw new CodexCompactionError("Codex compaction response was not valid UTF-8");
    }
    buffer = buffer.replace(/\r\n/g, "\n");
    if (buffer.length > 0) consume(buffer);
  } finally {
    signal.removeEventListener("abort", onAbort);
    await cancelReader(reader);
    reader.releaseLock();
  }

  parsed.artifacts = [...artifacts.values()];
  return parsed;
}

function addResponseArtifacts(value: unknown, artifacts: Map<string, CodexCompactionArtifact>): void {
  if (value === undefined) return;
  if (!Array.isArray(value)) throw new CodexCompactionError("Codex compaction response output was malformed");
  for (const item of value) addArtifact(item, artifacts);
}

function addArtifact(value: unknown, artifacts: Map<string, CodexCompactionArtifact>, doneArtifacts?: Set<string>): void {
  if (!isRecord(value) || value.type !== "compaction") return;
  if (typeof value.encrypted_content !== "string" || value.encrypted_content.length === 0) {
    throw new CodexCompactionError("Codex compaction artifact was empty or malformed");
  }
  if (value.id !== undefined && value.id !== null && typeof value.id !== "string") {
    throw new CodexCompactionError("Codex compaction artifact was malformed");
  }
  const artifact: CodexCompactionArtifact = {
    type: "compaction",
    ...(typeof value.id === "string" ? { id: value.id } : {}),
    encrypted_content: value.encrypted_content,
  };
  const key = `${artifact.id ?? ""}\u0000${artifact.encrypted_content}`;
  if (doneArtifacts) {
    if (doneArtifacts.has(key)) {
      throw new CodexCompactionError("Codex compaction stream repeated a done artifact");
    }
    doneArtifacts.add(key);
  }
  artifacts.set(key, artifact);
}

async function cancelReader(reader: ReadableStreamDefaultReader<Uint8Array>): Promise<void> {
  // A broken/custom body stream must not make cancellation wait forever after
  // the request has already been failed or aborted.
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, 250);
    (timer as unknown as { unref?: () => void }).unref?.();
  });
  try {
    await Promise.race([
      Promise.resolve().then(() => reader.cancel()).then(() => undefined, () => undefined),
      timeout,
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function usageFromResponse(value: unknown, model: Model<Api>): Usage {
  if (!isRecord(value)) throw new CodexCompactionError("Codex compaction response had no usage");
  const inputTokens = requiredNumber(value, "input_tokens");
  const outputTokens = requiredNumber(value, "output_tokens");
  const totalTokens = requiredNumber(value, "total_tokens");
  const inputDetails = optionalRecord(value.input_tokens_details, "input_tokens_details");
  const outputDetails = optionalRecord(value.output_tokens_details, "output_tokens_details");
  const cacheRead = optionalNumber(inputDetails, "cached_tokens");
  const cacheWrite = optionalNumber(inputDetails, "cache_write_tokens");
  const reasoning = optionalNumber(outputDetails, "reasoning_tokens");
  if (cacheRead + cacheWrite > inputTokens || totalTokens !== inputTokens + outputTokens) {
    throw new CodexCompactionError("Codex compaction usage totals were inconsistent");
  }
  const usage: Usage = {
    input: inputTokens - cacheRead - cacheWrite,
    output: outputTokens,
    cacheRead,
    cacheWrite,
    reasoning,
    totalTokens,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
  try {
    calculateCost(model, usage);
  } catch {
    throw new CodexCompactionError("Codex compaction usage pricing was invalid");
  }
  validateUsage(usage);
  return usage;
}

function validateUsage(usage: Usage): void {
  const values = [
    usage.input,
    usage.output,
    usage.cacheRead,
    usage.cacheWrite,
    usage.reasoning ?? 0,
    usage.totalTokens,
    usage.cost.input,
    usage.cost.output,
    usage.cost.cacheRead,
    usage.cost.cacheWrite,
    usage.cost.total,
  ];
  if (values.some((value) => !Number.isFinite(value) || value < 0)) {
    throw new CodexCompactionError("Codex compaction usage contained invalid numbers");
  }
}

function requiredNumber(record: Record<string, unknown>, key: string): number {
  const value = record[key];
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new CodexCompactionError("Codex compaction usage contained invalid numbers");
  }
  return value;
}

function optionalRecord(value: unknown, key: string): Record<string, unknown> | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) throw new CodexCompactionError(`Codex compaction usage field ${key} was malformed`);
  return value;
}

function optionalNumber(record: Record<string, unknown> | undefined, key: string): number {
  const value = record?.[key];
  if (value === undefined) return 0;
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new CodexCompactionError("Codex compaction usage contained invalid numbers");
  }
  return value;
}

function resolveThinking(model: Model<Api>, thinking: ThinkingLevel | "none" | undefined): string {
  if (thinking === "none") return "none";
  if (thinking !== undefined) return model.thinkingLevelMap?.[thinking] ?? thinking;
  return model.thinkingLevelMap?.low ?? "low";
}

function resolveCodexResponsesUrl(baseUrl: string): string {
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    throw new Error("Codex compaction model baseUrl was invalid");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("Codex compaction model baseUrl must use HTTP or HTTPS");
  }
  const path = url.pathname.replace(/\/+$/, "");
  if (path.endsWith("/codex/responses")) url.pathname = path;
  else if (path.endsWith("/codex")) url.pathname = `${path}/responses`;
  else url.pathname = `${path}/codex/responses`;
  url.search = "";
  url.hash = "";
  return url.toString();
}

function byteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
