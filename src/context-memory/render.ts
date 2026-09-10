import { Text, stripTerminalSequences, wrapTextWithAnsi, type Component } from "@earendil-works/pi-tui";
import type { Theme } from "@earendil-works/pi-coding-agent";

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function clean(text: string): string {
  return stripTerminalSequences(text).replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, "").replace(/\t/g, "  ");
}

function displayText(text: string): string {
  // History can contain JSON-encoded tool/test output. Decode only the common
  // presentation escapes; the structured result sent to the model is unchanged.
  return clean(text).replace(/\\n/g, "\n").replace(/\\r/g, "").replace(/\\t/g, "  ").replace(/\\"/g, '"');
}

function oneLine(value: unknown): string {
  return typeof value === "string" ? clean(value).replace(/\s+/g, " ").trim() : "";
}

export function renderMemoryCall(args: unknown, theme: Theme): Component {
  const params = record(args) ? args : {};
  const actions: Record<string, string> = { search: "search history", list: "list history", read: "read history", notes: "working note", save_notes: "save note", edit: "edit note" };
  const action = typeof params.action === "string" ? actions[params.action] : undefined;
  const detail = params.action === "search" ? `“${oneLine(params.query)}”` :
    params.action === "read" ? oneLine(params.ref ?? params.entryId) :
    params.action === "list" && typeof params.before === "string" ? `before ${oneLine(params.before)}` : "";
  return new Text(theme.fg("toolTitle", theme.bold("Context memory")) +
    (action ? theme.fg("muted", ` · ${action}`) : "") + (detail ? `  ${theme.fg("accent", detail)}` : ""), 0, 0);
}

/** Presentation only: parse the existing wire output so previously recorded calls render too. */
export function renderMemoryResult(text: string, expanded: boolean, partial: boolean, isError: boolean, theme: Theme): Component {
  if (isError) return new Text(theme.fg("error", clean(text) || "Context memory failed."), 0, 0);
  if (partial) return new Text(theme.fg("muted", "Working…"), 0, 0);
  let data: unknown;
  try { data = JSON.parse(text); } catch { return new Text(theme.fg("muted", clean(text)), 0, 0); }
  if (!record(data)) return new Text(theme.fg("muted", "No memory result."), 0, 0);
  const result = data;

  return {
    invalidate() {},
    render(width: number): string[] {
      const lines: string[] = [];
      let clipped = false;
      const add = (value: string) => lines.push(...new Text(value, 0, 0).render(width));
      const preview = (value: string, maxLines: number) => {
        const wrapped = wrapTextWithAnsi(theme.fg("text", displayText(value).trim()), Math.max(1, width - 2));
        const visible = expanded ? wrapped : wrapped.slice(0, maxLines);
        clipped ||= visible.length < wrapped.length;
        lines.push(...visible.map((line) => `  ${line}`));
      };
      const metadata = (kind: unknown, id: unknown, timestamp: unknown, readOffset?: unknown, offBranch?: unknown) => {
        const date = typeof timestamp === "string" && Number.isFinite(Date.parse(timestamp))
          ? new Date(timestamp).toISOString().slice(0, 16).replace("T", " ") + " UTC" : "";
        const offset = expanded && typeof readOffset === "number" && Number.isSafeInteger(readOffset) && readOffset >= 0
          ? ` · read offset ${readOffset}` : "";
        const label = oneLine(kind).replace("pi-subagents-background-result", "subagent result").replace("pi-bg-run-result", "background result");
        add(theme.fg("accent", label) + theme.fg("dim", ` · ${oneLine(id)}${expanded && date ? ` · ${date}` : ""}${offset}${offBranch === true ? " · off-branch" : ""}`));
      };

      const scope = result.scope === "session" ? "all branches" : "current branch";
      if (Array.isArray(result.entries)) {
        const entries = result.entries.filter((item): item is Record<string, unknown> => record(item) && typeof item.excerpt === "string");
        add(theme.fg(entries.length ? "success" : "muted", entries.length
          ? `${entries.length} ${entries.length === 1 ? "entry" : "entries"} · ${scope}` : "No readable history on this branch."));
        for (const [index, entry] of (expanded ? entries : entries.slice(0, 3)).entries()) {
          if (index > 0) lines.push("");
          metadata(entry.kind, entry.ref ?? entry.entryId, entry.timestamp);
          preview(String(entry.excerpt), 2);
        }
        if (!expanded && entries.length > 3) { clipped = true; add(theme.fg("dim", `+ ${entries.length - 3} more entries`)); }
        if (typeof result.nextBefore === "string") add(theme.fg("dim", "More history available on the next list page."));
      } else if (Array.isArray(result.matches)) {
        const matches = result.matches.filter((item): item is Record<string, unknown> => record(item) && typeof item.excerpt === "string");
        add(theme.fg(matches.length ? "success" : "muted", matches.length
          ? `${matches.length} ${matches.length === 1 ? "match" : "matches"} · ${scope}` : "No matching history on this branch."));
        for (const [index, match] of (expanded ? matches : matches.slice(0, 3)).entries()) {
          if (index > 0) lines.push("");
          metadata(match.kind, match.ref ?? match.entryId, match.timestamp, match.readOffset, match.offBranch);
          preview(String(match.excerpt), 2);
        }
        if (!expanded && matches.length > 3) { clipped = true; add(theme.fg("dim", `+ ${matches.length - 3} more matches`)); }
        if (typeof result.nextBefore === "string") add(theme.fg("dim", "More history available on the next search page."));
      } else if (result.saved === true && typeof result.characters === "number") {
        add(theme.fg("success", result.characters === 0 ? "✓ Working note cleared" : "✓ Working note saved") +
          (result.characters ? theme.fg("muted", ` · ${result.characters.toLocaleString("en-US")} characters`) : ""));
      } else if (typeof result.text === "string") {
        if ((typeof result.ref === "string" && result.ref !== "notes") || typeof result.entryId === "string") {
          metadata(result.kind, result.ref ?? result.entryId, result.timestamp, undefined, result.offBranch);
          preview(result.text, 5);
          if (typeof result.nextOffset === "number") add(theme.fg("dim", "Entry continues on the next read page."));
          if (expanded) {
            const previous = result.previousRef ?? result.previousEntryId;
            const next = result.nextRef ?? result.nextEntryId;
            const neighbors = [typeof previous === "string" ? `← ${oneLine(previous)}` : "",
              typeof next === "string" ? `${oneLine(next)} →` : ""].filter(Boolean);
            if (neighbors.length) add(theme.fg("dim", neighbors.join("   ")));
          }
        } else if (!result.text) {
          add(theme.fg("muted", "No working note yet."));
        } else {
          add(theme.fg("muted", `Working note · ${result.text.length.toLocaleString("en-US")} characters`));
          preview(result.text, 4);
        }
      } else {
        preview(text, 4);
      }
      if (clipped) add(theme.fg("dim", "… expand tool output to read more"));
      return lines;
    },
  };
}
