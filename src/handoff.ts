import { randomUUID } from "node:crypto";
import type { ExtensionAPI, ExtensionCommandContext, SessionEntry } from "@earendil-works/pi-coding-agent";

const HANDOFF_MESSAGE_TYPE = "session-handoff-generation";
const HANDOFF_ROLLBACK_ANCHOR_TYPE = "session-handoff-rollback-anchor";

interface HandoffGenerationDetails {
  generationMarker: string;
}

export function buildHandoffPrompt(nextGoal: string, sessionFile: string, generationMarker: string): string {
  const focus = nextGoal.trim()
    ? `The user's requested focus for the next session is: ${nextGoal.trim()}`
    : "No next-session focus was supplied. Continue the current work from its present state.";

  return `Generate the session handoff now. This is a summary-only turn: do not implement anything, change files, run validation, or perform general repository investigation.

Generation marker: ${generationMarker}
Current recorded session file: ${sessionFile}
${focus}

Write a compact, self-contained, chronological handoff for a fresh main agent. Include:
- the original goal and any later direction changes;
- important actions and findings in the order they occurred;
- decisions and their recorded rationale, preserving consequential provenance: distinguish user-approved decisions from agent or subagent proposals and findings, and never promote a recommendation to a settled decision;
- files inspected or changed and why;
- commands, tests, and other validation, with their recorded results;
- compact issues or blockers and how they were tackled or resolved;
- established success criteria and whether each is currently satisfied;
- the current state, unresolved questions or risks, and clear next steps;
- the next-session focus above, without replacing unfinished current-work context.

Use only evidence recorded in this session. Clearly distinguish facts, decisions, and assumptions, and do not guess or fill gaps from general knowledge. Do not inspect the repository for new evidence and do not perform new implementation work.

Do not delegate for an ordinary session. If the history is large, contains compaction, or appears incomplete, and the session file above exists, use only fresh read-only Atlas subagents to inspect that JSONL file in chronological chunks, then synthesize their findings. Atlas work must remain session-history inspection, not repository investigation. Do not refer the next session to old subagent handles or instruct it to follow up with them; old handles are not available there.

Return exactly one envelope and nothing before or after it. Put only the final handoff inside the envelope, replacing HANDOFF with the handoff text:
<session-handoff generation="${generationMarker}">HANDOFF</session-handoff>`;
}

export function extractGeneratedHandoff(
  branch: SessionEntry[],
  previousEntryIds: ReadonlySet<string>,
  generationMarker: string,
): string {
  const markerIndex = branch.findIndex(
    (entry) =>
      !previousEntryIds.has(entry.id) &&
      entry.type === "custom_message" &&
      entry.customType === HANDOFF_MESSAGE_TYPE &&
      (entry.details as Partial<HandoffGenerationDetails> | undefined)?.generationMarker === generationMarker,
  );
  if (markerIndex < 0) throw new Error("The handoff generation marker was not recorded in the active branch.");

  const assistantEntries = branch.slice(markerIndex + 1).filter(
    (entry) => !previousEntryIds.has(entry.id) && entry.type === "message" && entry.message.role === "assistant",
  );
  if (assistantEntries.length === 0) throw new Error("The handoff turn produced no new assistant response.");

  const opening = `<session-handoff generation="${generationMarker}">`;
  const closing = "</session-handoff>";
  const candidates = assistantEntries.flatMap((entry) => {
    if (entry.type !== "message" || entry.message.role !== "assistant") return [];
    const text = entry.message.content
      .filter((content): content is { type: "text"; text: string } => content.type === "text")
      .map((content) => content.text)
      .join("\n")
      .trim();
    if (!text.startsWith(opening) || !text.endsWith(closing)) return [];
    return [{ message: entry.message, body: text.slice(opening.length, -closing.length).trim() }];
  });

  if (candidates.length > 1) throw new Error("The handoff turn produced multiple matching response envelopes.");
  const candidate = candidates[0];
  if (!candidate) {
    // A sole response is unambiguously from this triggered turn even when a provider
    // failure prevented it from emitting the requested marker envelope.
    const soleEntry = assistantEntries.length === 1 ? assistantEntries[0] : undefined;
    if (soleEntry?.type === "message" && soleEntry.message.role === "assistant") {
      if (soleEntry.message.stopReason === "error") {
        throw new Error(soleEntry.message.errorMessage?.trim() || "Handoff generation failed.");
      }
      if (soleEntry.message.stopReason === "aborted") throw new Error("Handoff generation was cancelled.");
    }
    throw new Error("The handoff turn produced no matching complete response envelope.");
  }

  if (candidate.message.stopReason !== "stop") {
    const reason = candidate.message.stopReason;
    if (reason === "error") throw new Error(candidate.message.errorMessage?.trim() || "Handoff generation failed.");
    if (reason === "aborted") throw new Error("Handoff generation was cancelled.");
    throw new Error(`Handoff generation was incomplete (stop reason: ${reason}).`);
  }
  if (!candidate.body) throw new Error("The handoff turn produced an empty response envelope.");
  return candidate.body;
}

async function rollbackGeneration(ctx: ExtensionCommandContext, anchorEntryId: string): Promise<string | undefined> {
  try {
    const result = await ctx.navigateTree(anchorEntryId, { summarize: false });
    return result.cancelled ? "navigation through the rollback anchor was cancelled" : undefined;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

export function registerHandoffCommand(pi: ExtensionAPI): void {
  let handoffInProgress = false;

  pi.registerCommand("handoff", {
    description: "Transfer the current work to a new parent-linked session",
    handler: async (args, ctx) => {
      if (handoffInProgress) {
        ctx.ui.notify("A handoff is already in progress.", "warning");
        return;
      }
      if (ctx.mode !== "tui") {
        ctx.ui.notify("Handoff requires TUI mode.", "error");
        return;
      }
      if (!ctx.model) {
        ctx.ui.notify("No model selected.", "error");
        return;
      }

      const parentSession = ctx.sessionManager.getSessionFile();
      if (!parentSession) {
        ctx.ui.notify("Handoff requires a persisted session so the new session can link to its parent.", "error");
        return;
      }

      handoffInProgress = true;
      let generationStarted = false;
      let rollbackAnchorId: string | undefined;
      let sessionReplacementAttempted = false;
      try {
        await ctx.waitForIdle();

        const branch = ctx.sessionManager.getBranch();
        const hasConversation = branch.some(
          (entry) =>
            entry.type === "compaction" ||
            entry.type === "branch_summary" ||
            (entry.type === "message" && (entry.message.role === "user" || entry.message.role === "assistant")),
        );
        if (!hasConversation) {
          ctx.ui.notify("No conversation to hand off.", "error");
          return;
        }

        const originalLeafId = ctx.sessionManager.getLeafId() ?? undefined;
        if (!originalLeafId) {
          ctx.ui.notify("The active conversation has no leaf to hand off.", "error");
          return;
        }

        const originalEntryIds = new Set(branch.map((entry) => entry.id));
        const generationMarker = randomUUID();
        pi.sendMessage<HandoffGenerationDetails>(
          {
            customType: HANDOFF_ROLLBACK_ANCHOR_TYPE,
            content: "",
            display: false,
            details: { generationMarker },
          },
          { triggerTurn: false },
        );

        const anchoredBranch = ctx.sessionManager.getBranch();
        const anchors = anchoredBranch.filter(
          (entry) =>
            !originalEntryIds.has(entry.id) &&
            entry.type === "custom_message" &&
            entry.customType === HANDOFF_ROLLBACK_ANCHOR_TYPE &&
            entry.parentId === originalLeafId &&
            entry.content === "" &&
            entry.display === false &&
            (entry.details as Partial<HandoffGenerationDetails> | undefined)?.generationMarker === generationMarker,
        );
        if (anchors.length !== 1 || ctx.sessionManager.getLeafId() !== anchors[0]!.id) {
          throw new Error("The handoff rollback anchor was not recorded as the active child of the original leaf.");
        }
        const anchorEntryId = anchors[0]!.id;
        rollbackAnchorId = anchorEntryId;

        const previousEntryIds = new Set(anchoredBranch.map((entry) => entry.id));
        const prompt = buildHandoffPrompt(args, parentSession, generationMarker);
        generationStarted = true;
        pi.sendMessage<HandoffGenerationDetails>(
          {
            customType: HANDOFF_MESSAGE_TYPE,
            content: prompt,
            display: false,
            details: { generationMarker },
          },
          { triggerTurn: true },
        );
        await ctx.waitForIdle();

        const generated = extractGeneratedHandoff(ctx.sessionManager.getBranch(), previousEntryIds, generationMarker);
        const edited = await ctx.ui.editor("Review session handoff", generated);
        if (edited === undefined) {
          const cleanupError = await rollbackGeneration(ctx, anchorEntryId);
          ctx.ui.notify(
            cleanupError
              ? `Handoff cancelled, but generation cleanup failed: ${cleanupError}.`
              : "Handoff cancelled.",
            cleanupError ? "error" : "info",
          );
          return;
        }
        const finalHandoff = edited.trim();
        if (!finalHandoff) {
          const cleanupError = await rollbackGeneration(ctx, anchorEntryId);
          ctx.ui.notify(
            cleanupError
              ? `Handoff cannot be empty. Generation cleanup also failed: ${cleanupError}.`
              : "Handoff cannot be empty.",
            "error",
          );
          return;
        }

        sessionReplacementAttempted = true;
        const result = await ctx.newSession({
          parentSession,
          withSession: async (replacementCtx) => {
            replacementCtx.ui.setEditorText(finalHandoff);
            replacementCtx.ui.notify("Handoff ready. Review and submit when ready.", "info");
          },
        });
        if (result.cancelled) {
          const cleanupError = await rollbackGeneration(ctx, anchorEntryId);
          ctx.ui.notify(
            cleanupError
              ? `New session creation was cancelled, but generation cleanup failed: ${cleanupError}.`
              : "New session creation was cancelled.",
            cleanupError ? "error" : "info",
          );
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (sessionReplacementAttempted) {
          // Replacement may already have invalidated the command context. Do not touch it here.
          console.error(`Handoff session creation failed: ${message}`);
        } else {
          const cleanupError = generationStarted && rollbackAnchorId
            ? await rollbackGeneration(ctx, rollbackAnchorId)
            : undefined;
          ctx.ui.notify(
            cleanupError
              ? `Handoff failed: ${message} Generation cleanup also failed: ${cleanupError}.`
              : `Handoff failed: ${message}`,
            "error",
          );
        }
      } finally {
        handoffInProgress = false;
      }
    },
  });
}
