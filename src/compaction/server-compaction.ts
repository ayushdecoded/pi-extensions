import { createHash, randomUUID } from "node:crypto";
import {
  buildContextEntries, compact, convertToLlm, generateSummaryWithUsage, serializeConversation,
  sessionEntryToContextMessages,
  type CompactionEntry, type ContextEvent, type ExtensionAPI, type ExtensionContext,
  type SessionBeforeCompactEvent, type SessionEntry,
} from "@earendil-works/pi-coding-agent";
import type { Api, Model, ProviderHeaders, Usage } from "@earendil-works/pi-ai";
import { convertResponsesMessages, convertResponsesTools } from "@earendil-works/pi-ai/api/openai-responses-shared";
import { canonicalProviderId } from "../accounts/providers.ts";
import { codexAuthHeaders } from "../codex-auth.ts";
import { requestCodexCompaction, type CodexCompactionArtifact, type CodexResponsesInput } from "./codex-transport.ts";
import { COMPACTION_FALLBACK_TYPE } from "./accounting.ts";
import { logCompactionDiagnostic } from "./diagnostics.ts";
import { PROACTIVE_COMPACTION_CONTINUATION_TYPE } from "../proactive-compaction.ts";

export const SERVER_COMPACTION_TYPE = "codex-server-compaction";
export { COMPACTION_FALLBACK_TYPE } from "./accounting.ts";
const REJECTED_CHECKPOINT_TYPE = "codex-compaction-rejected";
type Preparation = SessionBeforeCompactEvent["preparation"];
type AgentMessage = ContextEvent["messages"][number];
type RequestAuth = { apiKey: string; headers?: ProviderHeaders; baseUrl?: string; env?: Record<string, string> };
type ServerDetails = {
  type: typeof SERVER_COMPACTION_TYPE;
  version: 1;
  provider: string;
  model: string;
  baseUrl: string;
  account: string;
  artifact: CodexCompactionArtifact;
  /** References, not transcript copies: originals remain in Pi's append-only session. */
  sourceEntryIds: string[];
  /** Client-authored user entries retained alongside the opaque artifact by Codex v2. */
  retainedEntryIds: string[];
  /** Ordered source references, with snapshots for materialized/inherited summaries. */
  retainedItems: RetainedItem[];
  previousCompactionId?: string;
  reserveTokens: number;
  customInstructions?: string;
  readFiles: string[];
  modifiedFiles: string[];
};
type Fallback = { checkpointId: string; summary: string; usage: Usage };
type RetainedItem = { entryId: string; text?: string };
const RESERVED_SUMMARY_RE = /^\[Codex server checkpoint [^\]\r\n]+\](?:\n|$)/;
const COMPACTION_MARKER_PREFIX = "The conversation history before this point was compacted into the following summary:\n\n<summary>\n";
const COMPACTION_MARKER_SUFFIX = "\n</summary>";
export interface ServerCompactionDependencies {
  remote?: typeof requestCodexCompaction;
  summarize?: typeof generateSummaryWithUsage;
  nativeCompact?: typeof compact;
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function strings(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}
function retainedItems(value: unknown): value is RetainedItem[] {
  return Array.isArray(value) && value.every((item) => record(item) && typeof item.entryId === "string" && item.entryId.length > 0 &&
    (item.text === undefined || (typeof item.text === "string" && item.text.length > 0)));
}
function isServerEntry(entry: SessionEntry): entry is CompactionEntry<ServerDetails> {
  return entry.type === "compaction" && record(entry.details) && entry.details.type === SERVER_COMPACTION_TYPE;
}
function isReservedCheckpointSummary(entry: SessionEntry): entry is CompactionEntry {
  return entry.type === "compaction" && typeof entry.summary === "string" && RESERVED_SUMMARY_RE.test(entry.summary);
}
function isReservedCheckpointMarker(value: string): boolean {
  if (!value.startsWith(COMPACTION_MARKER_PREFIX) || !value.endsWith(COMPACTION_MARKER_SUFFIX)) return false;
  return RESERVED_SUMMARY_RE.test(value.slice(COMPACTION_MARKER_PREFIX.length, -COMPACTION_MARKER_SUFFIX.length));
}
function details(entry: CompactionEntry): ServerDetails {
  const value: unknown = entry.details;
  if (!record(value) || value.type !== SERVER_COMPACTION_TYPE || value.version !== 1 ||
      typeof value.provider !== "string" || typeof value.model !== "string" ||
      typeof value.baseUrl !== "string" || typeof value.account !== "string" ||
      !record(value.artifact) || value.artifact.type !== "compaction" ||
      typeof value.artifact.encrypted_content !== "string" || !value.artifact.encrypted_content ||
      (value.artifact.id !== undefined && typeof value.artifact.id !== "string") ||
      !strings(value.sourceEntryIds) || !strings(value.retainedEntryIds) || !retainedItems(value.retainedItems) ||
      !strings(value.readFiles) || !strings(value.modifiedFiles) ||
      typeof value.reserveTokens !== "number" || !Number.isFinite(value.reserveTokens) || value.reserveTokens <= 0 ||
      (value.previousCompactionId !== undefined && typeof value.previousCompactionId !== "string") ||
      (value.customInstructions !== undefined && typeof value.customInstructions !== "string")) {
    throw new Error("Invalid server compaction checkpoint. Original history has been retained; refusing incomplete replay.");
  }
  return value as ServerDetails;
}
function isCodex(model: Model<Api> | undefined): model is Model<Api> {
  return !!model && canonicalProviderId(model.provider) === "openai-codex" && model.api === "openai-codex-responses";
}
async function requestAuth(ctx: ExtensionContext, model: Model<Api>): Promise<RequestAuth> {
  const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
  if (!auth.ok || !auth.apiKey) throw new Error("Compaction could not resolve the selected model's credentials.");
  return { ...auth, apiKey: auth.apiKey };
}
function accountKey(auth: RequestAuth): string {
  const headers = codexAuthHeaders(auth.apiKey, auth.headers);
  const id = Object.entries(headers).find(([key]) => key.toLowerCase() === "chatgpt-account-id")?.[1];
  if (!id) throw new Error("Codex account identity unavailable; refusing opaque checkpoint reuse.");
  return createHash("sha256").update(id).digest("hex");
}
function compatible(entry: CompactionEntry, model: Model<Api>, auth: RequestAuth): boolean {
  const saved = details(entry);
  return isCodex(model) && saved.provider === model.provider && saved.model === model.id &&
    saved.baseUrl === (auth.baseUrl ?? model.baseUrl) && saved.account === accountKey(auth);
}
function textOfSummary(entry: CompactionEntry): string {
  const message = convertToLlm(sessionEntryToContextMessages(entry))[0];
  if (!message || message.role !== "user") throw new Error("Pi compaction message format changed.");
  return typeof message.content === "string" ? message.content : message.content.filter((block) => block.type === "text").map((block) => block.text).join("");
}
function inputText(item: unknown): string | undefined {
  if (!record(item) || item.role !== "user") return undefined;
  if (typeof item.content === "string") return item.content;
  if (!Array.isArray(item.content) || item.content.length !== 1) return undefined;
  const block: unknown = item.content[0];
  return record(block) && block.type === "input_text" && typeof block.text === "string" ? block.text : undefined;
}
function combineUsage(left: Usage | undefined, right: Usage): Usage {
  if (!left) return right;
  return {
    input: left.input + right.input, output: left.output + right.output,
    cacheRead: left.cacheRead + right.cacheRead, cacheWrite: left.cacheWrite + right.cacheWrite,
    totalTokens: left.totalTokens + right.totalTokens,
    cost: { input: left.cost.input + right.cost.input, output: left.cost.output + right.cost.output,
      cacheRead: left.cost.cacheRead + right.cost.cacheRead, cacheWrite: left.cost.cacheWrite + right.cost.cacheWrite,
      total: left.cost.total + right.cost.total },
    ...(left.reasoning !== undefined || right.reasoning !== undefined ? { reasoning: (left.reasoning ?? 0) + (right.reasoning ?? 0) } : {}),
    ...(left.cacheWrite1h !== undefined || right.cacheWrite1h !== undefined ? { cacheWrite1h: (left.cacheWrite1h ?? 0) + (right.cacheWrite1h ?? 0) } : {}),
  };
}
function nativeStream(ctx: ExtensionContext): NonNullable<Parameters<typeof generateSummaryWithUsage>[9]> {
  return (model, context, options) => {
    const provider = ctx.modelRegistry.getProvider(model.provider);
    if (!provider) throw new Error("Native fallback provider unavailable.");
    return provider.streamSimple(model, context, options);
  };
}
function safeHeaders(headers: ProviderHeaders | undefined): Record<string, string> | undefined {
  return headers && Object.fromEntries(Object.entries(headers).filter((pair): pair is [string, string] => typeof pair[1] === "string"));
}
function cachedFallback(entries: readonly SessionEntry[], id: string): Fallback | undefined {
  for (let index = entries.length - 1; index >= 0; index--) {
    const entry = entries[index];
    if (entry.type !== "custom" || entry.customType !== COMPACTION_FALLBACK_TYPE || !record(entry.data)) continue;
    if (entry.data.checkpointId === id && typeof entry.data.summary === "string" && entry.data.summary.trim() && isUsage(entry.data.usage)) {
      return entry.data as Fallback;
    }
  }
  return undefined;
}
function isUsage(value: unknown): value is Usage {
  if (!record(value) || !record(value.cost)) return false;
  const cost = value.cost;
  const fields = ["input", "output", "cacheRead", "cacheWrite", "totalTokens"];
  const costs = ["input", "output", "cacheRead", "cacheWrite", "total"];
  return fields.every((key) => typeof value[key] === "number" && Number.isFinite(value[key]) && value[key] >= 0) &&
    costs.every((key) => typeof cost[key] === "number" && Number.isFinite(cost[key]) && cost[key] >= 0) &&
    (value.reasoning === undefined || (typeof value.reasoning === "number" && Number.isFinite(value.reasoning) && value.reasoning >= 0)) &&
    (value.cacheWrite1h === undefined || (typeof value.cacheWrite1h === "number" && Number.isFinite(value.cacheWrite1h) && value.cacheWrite1h >= 0));
}

/** Main and child sessions share this compaction engine, not their scheduling policy. */
export function registerServerCompaction(pi: ExtensionAPI, dependencies: ServerCompactionDependencies = {}): void {
  const remote = dependencies.remote ?? requestCodexCompaction;
  const summarize = dependencies.summarize ?? generateSummaryWithUsage;
  const nativeCompact = dependencies.nativeCompact ?? compact;
  let lifetime = new AbortController();
  // Only replacements prepared by the context hook for THIS request are eligible.
  let replacements = new Map<string, CodexResponsesInput>();
  const pending = new Map<string, Promise<string>>();
  const materialized = new Map<string, string>();
  const reset = () => { lifetime.abort(); lifetime = new AbortController(); replacements.clear(); pending.clear(); materialized.clear(); };
  pi.on("session_shutdown", reset);
  pi.on("session_start", reset);
  pi.on("session_tree", reset);
  pi.on("session_before_fork", reset);
  pi.on("session_before_switch", reset);
  pi.on("model_select", reset);
  const signalFor = (signal?: AbortSignal) => AbortSignal.any([lifetime.signal, ...(signal ? [signal] : [])]);
  const warn = (ctx: ExtensionContext, message: string) => ctx.ui.notify(message, "warning");
  const failRequest = (ctx: ExtensionContext) => {
    replacements.clear();
    ctx.abort(); // Extension runners swallow thrown hook errors; abort is essential to fail closed.
    warn(ctx, "Compaction fallback failed. Request stopped; original session history is intact. Retry or restore an earlier branch.");
  };

  async function boundedSummary(messages: AgentMessage[], previousSummary: string | undefined, model: Model<Api>, auth: RequestAuth,
    reserve: number, customInstructions: string | undefined, ctx: ExtensionContext, signal: AbortSignal): Promise<{ summary: string; usage: Usage }> {
    let transcript = serializeConversation(convertToLlm(messages));
    let summary = previousSummary;
    let usage: Usage | undefined;
    do {
      const budget = Math.floor((model.contextWindow - reserve - Math.ceil((summary?.length ?? 0) / 3) - 2048) * 3);
      if (budget < 1024) throw new Error("Fallback summary cannot fit the destination context window.");
      const chunk = transcript.slice(0, budget);
      transcript = transcript.slice(chunk.length);
      const result = await summarize([{ role: "user", content: chunk || "Preserve the previous checkpoint.", timestamp: Date.now() }],
        model, reserve, auth.apiKey, safeHeaders(auth.headers), signal, customInstructions, summary,
        ctx.thinkingLevel, nativeStream(ctx), auth.env);
      signal.throwIfAborted();
      if (!result.text.trim() || !isUsage(result.usage)) throw new Error("Native compaction returned invalid output.");
      summary = result.text;
      usage = combineUsage(usage, result.usage);
    } while (transcript.length);
    if (!summary || !usage) throw new Error("Native fallback produced no summary.");
    return { summary, usage };
  }

  async function materialize(entry: CompactionEntry, ctx: ExtensionContext, signal: AbortSignal, chain = new Set<string>()): Promise<string> {
    signal.throwIfAborted();
    if (chain.has(entry.id)) throw new Error("Cyclic compaction history.");
    const saved = details(entry);
    const model = ctx.model;
    if (!model) throw new Error("No model for native compaction fallback.");
    const existing = cachedFallback(ctx.sessionManager.getEntries(), entry.id);
    const reserve = Math.min(saved.reserveTokens, Math.floor(model.contextWindow / 4));
    const summaryBudget = Math.floor((model.contextWindow - reserve - 2048) * 3);
    const sessionId = ctx.sessionManager.getSessionId();
    const key = `${sessionId}:${entry.id}:${model.provider}:${model.id}:${model.baseUrl}`;
    const rebuilt = materialized.get(key);
    if (rebuilt) return rebuilt;
    // A cache generated for a larger model is not automatically safe for this
    // destination. Rebuild it from append-only sources when it exceeds the
    // conservative destination budget.
    if (existing && reserve >= 1024 && existing.summary.length <= summaryBudget) return existing.summary;
    const active = pending.get(key);
    if (active) return active;
    const nextChain = new Set(chain).add(entry.id);
    const work = (async () => {
      const entries = ctx.sessionManager.getEntries();
      const byId = new Map(entries.map((item) => [item.id, item]));
      let previousSummary: string | undefined;
      if (saved.previousCompactionId) {
        const previous = byId.get(saved.previousCompactionId);
        if (!previous || previous.type !== "compaction") throw new Error("Missing previous compaction history.");
        previousSummary = isServerEntry(previous) ? await materialize(previous, ctx, signal, nextChain) : previous.summary;
      }
      const messages = saved.sourceEntryIds.flatMap((id) => {
        const source = byId.get(id);
        if (!source) throw new Error("Original compaction history is unavailable.");
        return sessionEntryToContextMessages(source);
      });
      const auth = await requestAuth(ctx, model);
      const requestModel = auth.baseUrl ? { ...model, baseUrl: auth.baseUrl } : model;
      if (reserve < 1024) throw new Error("Model window too small for safe fallback summarization.");
      const result = await boundedSummary(messages, previousSummary, requestModel, auth, reserve, saved.customInstructions, ctx, signal);
      signal.throwIfAborted();
      if (ctx.sessionManager.getSessionId() !== sessionId) throw new Error("Session changed during fallback.");
      // Cache the repaired readable summary as well as the original remote
      // checkpoint. The latest destination-safe record is reusable after reload.
      materialized.set(key, result.summary);
      pi.appendEntry<Fallback>(COMPACTION_FALLBACK_TYPE, { checkpointId: entry.id, summary: result.summary, usage: result.usage });
      return result.summary;
    })();
    pending.set(key, work);
    try { return await work; } finally { if (pending.get(key) === work) pending.delete(key); }
  }

  pi.on("context", async (event, ctx) => {
    replacements.clear();
    const branch = ctx.sessionManager.getBranch();
    const checkpoints = branch.filter(isServerEntry);
    const bySummary = new Map<string, CompactionEntry>();
    for (const entry of checkpoints) {
      if (bySummary.has(entry.summary)) {
        failRequest(ctx);
        return { messages: [] };
      }
      bySummary.set(entry.summary, entry);
    }
    // A reserved placeholder is never a valid readable summary by itself. If
    // its metadata was removed or damaged, do not let it pass through as user
    // context and silently discard the archived history.
    if (branch.some((entry) => isReservedCheckpointSummary(entry) && !isServerEntry(entry))) {
      failRequest(ctx);
      return { messages: [] };
    }
    if (!event.messages.some((message) => message.role === "compactionSummary" &&
      (bySummary.has(message.summary) || RESERVED_SUMMARY_RE.test(message.summary)))) return;
    const signal = signalFor(ctx.signal);
    try {
      const model = ctx.model;
      if (!model) throw new Error("No selected model.");
      const auth = isCodex(model) ? await requestAuth(ctx, model) : undefined;
      const requestModel = auth?.baseUrl ? { ...model, baseUrl: auth.baseUrl } : model;
      const messages: AgentMessage[] = [];
      const nextReplacements = new Map<string, CodexResponsesInput>();
      const activeTools = new Set(pi.getActiveTools());
      const replayTools = convertResponsesTools(pi.getAllTools().filter((tool) => activeTools.has(tool.name)));
      const replayInput = auth ? convertResponsesMessages(requestModel, { messages: convertToLlm(event.messages) },
        new Set(["openai", "openai-codex", model.provider]), { includeSystemPrompt: false }) : [];
      for (const message of event.messages) {
        const entry = message.role === "compactionSummary" ? bySummary.get(message.summary) : undefined;
        if (message.role === "compactionSummary" && RESERVED_SUMMARY_RE.test(message.summary) && !entry) {
          throw new Error("Reserved Codex checkpoint marker has no valid metadata.");
        }
        if (!entry || message.role !== "compactionSummary") { messages.push(message); continue; }
        if (auth && compatible(entry, model, auth) && !wasRejected(entry, ctx)) {
          const marker = textOfSummary(entry);
          const otherInput = [...replayInput.filter((item) => inputText(item) !== marker), ...replayTools];
          try {
            nextReplacements.set(marker, replayItemsForEntry(entry, ctx.sessionManager.getEntries(), requestModel, otherInput, ctx.getSystemPrompt()));
            messages.push(message);
          } catch {
            messages.push({ ...message, summary: await materialize(entry, ctx, signal) });
          }
        } else {
          messages.push({ ...message, summary: await materialize(entry, ctx, signal) });
        }
      }
      signal.throwIfAborted();
      replacements = nextReplacements;
      return { messages };
    } catch { failRequest(ctx); return { messages: [] }; }
  });

  pi.on("before_provider_request", (event, ctx) => {
    if (!replacements.size) {
      try {
        if (record(event.payload) && Array.isArray(event.payload.input)) {
          const branch = ctx.sessionManager.getBranch();
          const unresolved = new Set([
            ...branch.filter(isServerEntry).map(textOfSummary),
            ...branch.filter(isReservedCheckpointSummary).map((entry) => `${COMPACTION_MARKER_PREFIX}${entry.summary}${COMPACTION_MARKER_SUFFIX}`),
          ]);
          if (event.payload.input.some((item: unknown) => {
            const text = inputText(item) ?? "";
            return unresolved.has(text) || isReservedCheckpointMarker(text);
          })) {
            failRequest(ctx);
            return { ...event.payload, input: [] };
          }
        }
        return;
      } catch {
        failRequest(ctx);
        return { ...recordPayload(event.payload), input: [] };
      }
    }
    try {
      const model = ctx.model;
      const payload = event.payload;
      if (!isCodex(model) || !record(payload) || !Array.isArray(payload.input)) throw new Error("Unexpected compaction replay payload.");
      const payloadInput = payload.input;
      const checkpointByMarker = new Map(ctx.sessionManager.getBranch().filter(isServerEntry).map((entry) => [textOfSummary(entry), entry]));
      const matches = new Set<string>();
      const input = payloadInput.flatMap((item: unknown, index: number) => {
        const text = inputText(item);
        const artifact = text === undefined ? undefined : replacements.get(text);
        if (!artifact || text === undefined) {
          if (text !== undefined && isReservedCheckpointMarker(text)) throw new Error("Reserved Codex checkpoint marker was not prepared for replay.");
          return item;
        }
        if (matches.has(text)) throw new Error("Duplicate compaction marker.");
        const checkpoint = checkpointByMarker.get(text);
        if (!checkpoint || !replayFits(artifact, payloadInput.filter((_candidate: unknown, otherIndex: number) => otherIndex !== index), model,
          details(checkpoint).reserveTokens, ctx.getSystemPrompt())) {
          throw new Error("Codex checkpoint replay cannot fit the destination context.");
        }
        matches.add(text);
        return artifact;
      });
      if (matches.size !== replacements.size) throw new Error("Missing compaction replay marker.");
      return { ...payload, input };
    } catch { failRequest(ctx); return { ...recordPayload(event.payload), input: [] }; }
  });

  pi.on("session_before_compact", async (event, ctx) => {
    const model = ctx.model;
    const contextEntries = buildContextEntries(event.branchEntries);
    const cut = contextEntries.findIndex((entry) => entry.id === event.preparation.firstKeptEntryId);
    const prefix = cut >= 0 ? contextEntries.slice(0, cut) : [];
    const previous = prefix.find((entry): entry is CompactionEntry => entry.type === "compaction");
    if (prefix.some((entry) => isReservedCheckpointSummary(entry) && !isServerEntry(entry))) {
      failRequest(ctx);
      return { cancel: true };
    }
    if (!isCodex(model) && (!previous || !isServerEntry(previous))) return;
    const signal = signalFor(event.signal);
    const startedAt = Date.now();
    const diagnose = (stage: string, error: unknown) => logCompactionDiagnostic(pi, ctx, stage, error, {
      reason: event.reason, aborted: signal.aborted, elapsedMs: Date.now() - startedAt,
      tokensBefore: event.preparation.tokensBefore,
    });
    try {
      if (!model || cut < 0) throw new Error("Missing compaction cut point.");
      if (isCodex(model)) {
        try {
          const auth = await requestAuth(ctx, model);
          const requestModel = auth.baseUrl ? { ...model, baseUrl: auth.baseUrl } : model;
          const rewritten: SessionEntry[] = [];
          const materializedSnapshots = new Map<string, string>();
          const artifacts = new Map<string, CompactionEntry>();
          for (const entry of prefix) {
            if (isServerEntry(entry)) {
              if (compatible(entry, model, auth) && !wasRejected(entry, ctx)) {
                artifacts.set(textOfSummary(entry), entry);
                rewritten.push(entry);
              } else {
                const summary = await materialize(entry, ctx, signal);
                materializedSnapshots.set(entry.id, summary);
                rewritten.push({ ...entry, summary });
              }
            } else rewritten.push(entry);
          }
          const activeTools = new Set(pi.getActiveTools());
          const tools = pi.getAllTools().filter((tool) => activeTools.has(tool.name));
          const responseTools = convertResponsesTools(tools);
          const convertedInput = convertResponsesMessages(requestModel, { messages: convertToLlm(rewritten.flatMap(sessionEntryToContextMessages)) },
            new Set(["openai", "openai-codex", model.provider]), { includeSystemPrompt: false });
          const input = convertedInput.flatMap((item, index) => {
            const checkpoint = artifacts.get(inputText(item) ?? "");
            if (!checkpoint) return [item];
            const otherInput = [...convertedInput.filter((_candidate, otherIndex) => otherIndex !== index), ...responseTools];
            return replayItemsForEntry(checkpoint, ctx.sessionManager.getEntries(), requestModel, otherInput,
              ctx.getSystemPrompt() + (event.customInstructions ? `\n\nCompaction focus: ${event.customInstructions}` : ""));
          });
          const result = await remote({ model: requestModel, apiKey: auth.apiKey, headers: auth.headers,
            input, tools: responseTools,
            instructions: ctx.getSystemPrompt() + (event.customInstructions ? `\n\nCompaction focus: ${event.customInstructions}` : ""), signal });
          if (!isUsage(result.usage) || !isCodexArtifact(result.artifact)) throw new Error("Codex compaction returned malformed output.");
          signal.throwIfAborted();
          const files = cumulativeFiles(event.preparation, previous);
          const modifiedFiles = [...new Set([...files.edited, ...files.written])].sort();
          const retained = retainedContextItems(prefix, previous, materializedSnapshots);
          const saved: ServerDetails = {
            type: SERVER_COMPACTION_TYPE, version: 1, provider: model.provider, model: model.id,
            baseUrl: requestModel.baseUrl, account: accountKey(auth), artifact: result.artifact,
            sourceEntryIds: prefix.filter((entry) => entry.type !== "compaction" && sessionEntryToContextMessages(entry).length > 0).map((entry) => entry.id),
            retainedEntryIds: retained.map((item) => item.entryId), retainedItems: retained,
            previousCompactionId: previous?.id, reserveTokens: event.preparation.settings.reserveTokens,
            customInstructions: event.customInstructions,
            readFiles: [...files.read].filter((file) => !modifiedFiles.includes(file)).sort(), modifiedFiles,
          };
          return { compaction: { summary: `[Codex server checkpoint ${randomUUID()}]\nOlder context is stored in an encrypted checkpoint. Original messages remain in the session archive.`,
            firstKeptEntryId: event.preparation.firstKeptEntryId, tokensBefore: event.preparation.tokensBefore,
            usage: result.usage, details: saved } };
        } catch (error) {
          diagnose("server", error);
          if (signal.aborted) return { cancel: true };
          warn(ctx, "Server-side compaction unavailable; using normal Pi compaction.");
        }
      }
      if (!previous || !isServerEntry(previous)) return; // Pi performs its untouched native fallback.
      const previousSummary = await materialize(previous, ctx, signal);
      let preparation: Preparation = { ...event.preparation, previousSummary, fileOps: cumulativeFiles(event.preparation, previous) };
      // Pi 0.84's split-turn path otherwise drops a previous summary when no full
      // old turns remain. Summarize this prefix together with that checkpoint.
      if (preparation.isSplitTurn && !preparation.messagesToSummarize.length) {
        preparation = { ...preparation, isSplitTurn: false, messagesToSummarize: preparation.turnPrefixMessages, turnPrefixMessages: [] };
      }
      const auth = await requestAuth(ctx, model);
      const requestModel = auth.baseUrl ? { ...model, baseUrl: auth.baseUrl } : model;
      const fallbackMessages = preparation.messagesToSummarize.concat(preparation.turnPrefixMessages);
      const transcriptLength = serializeConversation(convertToLlm(fallbackMessages)).length;
      const nativeBudget = Math.floor((model.contextWindow - Math.min(preparation.settings.reserveTokens, Math.floor(model.contextWindow / 4)) - 2048) * 3);
      let result;
      if (nativeBudget >= 1024 && transcriptLength + (preparation.previousSummary?.length ?? 0) <= nativeBudget) {
        result = await nativeCompact(preparation, requestModel, auth.apiKey, safeHeaders(auth.headers),
          event.customInstructions, signal, ctx.thinkingLevel, nativeStream(ctx), auth.env);
      } else {
        const reserve = Math.min(preparation.settings.reserveTokens, Math.floor(model.contextWindow / 4));
        if (reserve < 1024) throw new Error("Model window too small for safe fallback compaction.");
        const bounded = await boundedSummary(fallbackMessages, preparation.previousSummary, requestModel, auth, reserve,
          event.customInstructions, ctx, signal);
        const modifiedFiles = [...new Set([...preparation.fileOps.edited, ...preparation.fileOps.written])].sort();
        const readFiles = [...preparation.fileOps.read].filter((file) => !modifiedFiles.includes(file)).sort();
        result = {
          summary: bounded.summary + formatFiles(readFiles, modifiedFiles),
          firstKeptEntryId: preparation.firstKeptEntryId,
          tokensBefore: preparation.tokensBefore,
          usage: bounded.usage,
          details: { readFiles, modifiedFiles },
        };
      }
      signal.throwIfAborted();
      if (!result.summary.trim()) throw new Error("Empty native compaction.");
      return { compaction: result };
    } catch (error) {
      diagnose("fallback", error);
      if (!signal.aborted) warn(ctx, "Compaction failed; history was not replaced. Retry compaction before continuing.");
      return { cancel: true };
    }
  });

  pi.on("message_end", (event, ctx) => {
    const message = event.message;
    if (message.role !== "assistant" || message.stopReason !== "error" || !replacements.size ||
        !/encrypted|compaction/i.test(message.errorMessage ?? "") ||
        !/invalid|unsupported|incompatible|decrypt|malformed|not supported/i.test(message.errorMessage ?? "")) return;
    const entry = ctx.sessionManager.getBranch().filter(isServerEntry).at(-1);
    if (!entry || wasRejected(entry, ctx)) return;
    pi.appendEntry(REJECTED_CHECKPOINT_TYPE, { checkpointId: entry.id });
    warn(ctx, "Codex rejected the encrypted checkpoint; retrying once with normal Pi summary fallback.");
    pi.sendMessage({ customType: PROACTIVE_COMPACTION_CONTINUATION_TYPE, display: false,
      content: "Continue the active task after checkpoint recovery. Do not repeat completed tool operations." },
    { triggerTurn: true, deliverAs: "followUp" });
  });

  // Branch summarization is still Pi-native, but it must never summarize a
  // placeholder as if it contained the archived conversation.
  pi.on("session_before_tree", async (event, ctx) => {
    if (!event.preparation.userWantsSummary) return;
    const entries = event.preparation.entriesToSummarize;
    if (entries.some((entry) => isReservedCheckpointSummary(entry) && !isServerEntry(entry))) {
      failRequest(ctx);
      return { cancel: true };
    }
    if (!entries.some(isServerEntry)) return;
    try {
      const signal = signalFor(event.signal);
      const restored: SessionEntry[] = [];
      for (const entry of entries) {
        restored.push(isServerEntry(entry) ? { ...entry, summary: await materialize(entry, ctx, signal) } : entry);
      }
      signal.throwIfAborted();
      entries.splice(0, entries.length, ...restored);
    } catch {
      warn(ctx, "Cannot safely summarize this branch yet. History is intact; navigation cancelled.");
      return { cancel: true };
    }
  });
}

function formatFiles(readFiles: string[], modifiedFiles: string[]): string {
  const sections: string[] = [];
  if (readFiles.length) sections.push(`<read-files>\n${readFiles.join("\n")}\n</read-files>`);
  if (modifiedFiles.length) sections.push(`<modified-files>\n${modifiedFiles.join("\n")}\n</modified-files>`);
  return sections.length ? `\n\n${sections.join("\n\n")}` : "";
}

function isCodexArtifact(value: unknown): value is CodexCompactionArtifact {
  return record(value) && value.type === "compaction" && typeof value.encrypted_content === "string" &&
    value.encrypted_content.length > 0 && (value.id === undefined || typeof value.id === "string");
}

function retainedContextItems(prefix: readonly SessionEntry[], previous: CompactionEntry | undefined,
  snapshots: ReadonlyMap<string, string>): RetainedItem[] {
  const items: RetainedItem[] = [];
  if (previous && isServerEntry(previous)) items.push(...details(previous).retainedItems);
  for (const entry of prefix) {
    if (entry.type === "compaction") {
      if (isServerEntry(entry)) {
        const text = snapshots.get(entry.id);
        if (text !== undefined) items.push({ entryId: entry.id, text });
      } else items.push({ entryId: entry.id });
    } else if (hasUserMessage(entry)) {
      items.push({ entryId: entry.id });
    }
  }
  const seen = new Set<string>();
  return items.filter((item) => {
    if (seen.has(item.entryId)) return false;
    seen.add(item.entryId);
    return true;
  });
}

function hasUserMessage(entry: SessionEntry): boolean {
  return convertToLlm(sessionEntryToContextMessages(entry)).some((message) => message.role === "user");
}

/** Reconstruct Codex v2's retained client messages before the opaque item. */
function replayItemsForEntry(entry: CompactionEntry, entries: readonly SessionEntry[], model: Model<Api>,
  otherInput: readonly unknown[] = [], overheadText = ""): CodexResponsesInput {
  const saved = details(entry);
  const byId = new Map(entries.map((item) => [item.id, item]));
  const messages = saved.retainedItems.flatMap((item) => {
    if (item.text !== undefined) return [{ role: "user" as const, content: item.text, timestamp: 0 }];
    const source = byId.get(item.entryId);
    if (!source) throw new Error("Retained Codex checkpoint history is unavailable.");
    if (isServerEntry(source)) throw new Error("Opaque Codex checkpoint cannot be nested as retained user context.");
    return sessionEntryToContextMessages(source);
  });
  const userMessages = convertToLlm(messages).filter((message) => message.role === "user");
  const items = convertResponsesMessages(model, { messages: userMessages },
    new Set(["openai", "openai-codex", model.provider]), { includeSystemPrompt: false });
  const destinationReserve = Math.min(saved.reserveTokens, Math.floor(model.contextWindow / 4));
  // Codex's v2 limit is 64k, but leave room on small destination models for
  // the opaque item, retained suffix, and request overhead.
  const budget = Math.floor(model.contextWindow - destinationReserve - 2048);
  const artifact = saved.artifact;
  const fixedTokens = totalItemTokens(otherInput) + itemTokens(artifact) + Math.ceil(overheadText.length / 4);
  if (budget < 0 || fixedTokens > budget) throw new Error("Codex checkpoint replay cannot fit the destination context.");
  let remaining = Math.min(64_000 - 128, budget - fixedTokens);
  const retained: typeof items = [];
  for (let index = items.length - 1; index >= 0; index--) {
    const item = items[index];
    const cost = itemTokens(item);
    if (cost > remaining) {
      const truncated = truncateRetainedItem(item, remaining);
      if (truncated) retained.push(truncated as typeof item);
      remaining = 0;
      continue;
    }
    retained.push(item);
    remaining -= cost;
  }
  retained.reverse();
  return [...retained, artifact] as CodexResponsesInput;
}

function itemTokens(item: unknown): number {
  const encoded = JSON.stringify(item);
  return Math.max(1, Math.ceil((encoded?.length ?? 0) / 4));
}

function totalItemTokens(items: readonly unknown[]): number {
  let total = 0;
  for (const item of items) total += itemTokens(item);
  return total;
}

function replayFits(items: readonly unknown[], otherInput: readonly unknown[], model: Model<Api>, reserveTokens: number,
  overheadText = ""): boolean {
  const reserve = Math.min(reserveTokens, Math.floor(model.contextWindow / 4));
  const budget = Math.floor(model.contextWindow - reserve - 2048);
  return budget >= 0 && totalItemTokens(items) + totalItemTokens(otherInput) + Math.ceil(overheadText.length / 4) <= budget;
}

function truncateRetainedItem<T>(item: T, maxTokens: number): T | undefined {
  if (!record(item) || maxTokens <= 0) return undefined;
  const content = item.content;
  if (!Array.isArray(content)) return undefined;
  const textLength = content.reduce((total: number, block: unknown) =>
    total + (record(block) && block.type === "input_text" && typeof block.text === "string" ? block.text.length : 0), 0);
  if (textLength === 0) return undefined;
  const encodedLength = JSON.stringify(item).length;
  const maxTextLength = Math.max(0, maxTokens * 4 - (encodedLength - textLength));
  if (maxTextLength <= 0) return undefined;
  let remaining = maxTextLength;
  const truncatedContent = content.map((block: unknown) => {
    if (!record(block) || block.type !== "input_text" || typeof block.text !== "string") return block;
    const text = block.text.slice(0, remaining);
    remaining -= text.length;
    return { ...block, text };
  });
  const candidate = { ...item, content: truncatedContent };
  return Math.ceil(JSON.stringify(candidate).length / 4) <= maxTokens ? candidate as T : undefined;
}

function cumulativeFiles(preparation: Preparation, previous: CompactionEntry | undefined): Preparation["fileOps"] {
  const saved = previous && isServerEntry(previous) ? details(previous) : undefined;
  return {
    read: new Set([...preparation.fileOps.read, ...(saved?.readFiles ?? [])]),
    edited: new Set([...preparation.fileOps.edited, ...(saved?.modifiedFiles ?? [])]),
    written: new Set(preparation.fileOps.written),
  };
}

function wasRejected(entry: CompactionEntry, ctx: ExtensionContext): boolean {
  return ctx.sessionManager.getEntries().some((item) => item.type === "custom" &&
    item.customType === REJECTED_CHECKPOINT_TYPE && record(item.data) && item.data.checkpointId === entry.id);
}

function recordPayload(payload: unknown): Record<string, unknown> {
  return record(payload) ? payload : {};
}
