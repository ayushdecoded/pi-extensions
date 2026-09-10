import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

/** Persist metadata only: never serialize errors, request bodies, headers, or stacks. */
export function logCompactionDiagnostic(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  stage: string,
  error: unknown,
  metadata: { reason?: string; aborted?: boolean; elapsedMs?: number; tokensBefore?: number } = {},
): void {
  const message = error instanceof Error ? error.message : "Unknown error";
  // Only retain our fixed compaction errors and known cancellation messages.
  // Provider errors can contain arbitrary payloads; retain only an HTTP status.
  const status = /\bHTTP\s+([1-5]\d{2})\b/i.exec(message)?.[1];
  // Keep only messages from our fixed, non-sensitive failure vocabulary. In
  // particular, checkpoint replay errors are useful here: a fast failure
  // usually means the encrypted item could not fit the destination request,
  // not that the remote endpoint was unavailable. Never persist arbitrary
  // provider text because it may contain response bodies or conversation data.
  const safeMessage = /^(?:Codex compaction|Codex checkpoint|Compaction|Native compaction|Native fallback|Fallback summary|Missing compaction|Empty native compaction|Model window too small|No model for native compaction|Invalid server compaction|Missing previous compaction|Missing source|Cyclic compaction|Codex account identity)[A-Za-z0-9 .,;:'()_-]*$/.test(message)
    ? message.slice(0, 300)
    : /^(?:Operation aborted|The operation was aborted\.|aborted)$/.test(message)
      ? message
      : `Unclassified error${status ? ` (HTTP ${status})` : ""}`;
  try {
    pi.appendEntry("compaction-diagnostic", {
      stage, provider: ctx.model?.provider, model: ctx.model?.id,
      message: safeMessage, ...metadata,
    });
  } catch {
    // Diagnostics must never interfere with compaction or cancellation.
  }
}
