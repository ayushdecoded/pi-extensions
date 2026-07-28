import type { AutocompleteItem, AutocompleteProvider, AutocompleteSuggestions } from "@earendil-works/pi-tui";
import emojiBuckets from "./data/emojis.json" with { type: "json" };

type EmojiEntry = readonly [name: string, emoji: string];
type EmojiBuckets = Readonly<Record<string, readonly EmojiEntry[]>>;

const EMOJIS = emojiBuckets as unknown as EmojiBuckets;
const ALL_EMOJI_ENTRIES: readonly EmojiEntry[] = Object.values(EMOJIS)
  .flat()
  .sort(([left], [right]) => left.localeCompare(right));
const MAX_SUGGESTIONS = 12;

export type EmojiInlineReplacement = { replaceLen: number; insert: string };

function lowerBound(entries: readonly EmojiEntry[], target: string): number {
  let low = 0;
  let high = entries.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (entries[middle]![0] < target) low = middle + 1;
    else high = middle;
  }
  return low;
}

function isShortcodeCharacter(code: number): boolean {
  return (
    (code >= 0x61 && code <= 0x7a) ||
    (code >= 0x41 && code <= 0x5a) ||
    (code >= 0x30 && code <= 0x39) ||
    code === 0x5f ||
    code === 0x2b ||
    code === 0x2d
  );
}

function isTokenBoundary(text: string, colonIndex: number): boolean {
  if (colonIndex === 0) return true;
  return /[\s([{>]/.test(text[colonIndex - 1]!);
}

function extractShortcode(textBeforeCursor: string): { prefix: string; name: string } | undefined {
  let nameStart = textBeforeCursor.length;
  while (nameStart > 0 && isShortcodeCharacter(textBeforeCursor.charCodeAt(nameStart - 1))) nameStart--;

  const colonIndex = nameStart - 1;
  if (colonIndex < 0 || textBeforeCursor.charCodeAt(colonIndex) !== 0x3a || !isTokenBoundary(textBeforeCursor, colonIndex)) {
    return undefined;
  }

  const name = textBeforeCursor.slice(nameStart);
  return { prefix: `:${name}`, name: name.toLowerCase() };
}

export function getEmojiSuggestions(textBeforeCursor: string): AutocompleteSuggestions | null {
  const shortcode = extractShortcode(textBeforeCursor);
  if (!shortcode) return null;

  const items: AutocompleteItem[] = [];
  if (shortcode.name.length === 0) {
    // Return the full local list so the TUI's SelectList can scroll through it.
    // The list only renders its configured visible window, so this does not
    // make the autocomplete popup thousands of rows tall.
    for (const [name, emoji] of ALL_EMOJI_ENTRIES) {
      items.push({ value: emoji, label: `${emoji}  :${name}:` });
    }
  } else {
    const entries = EMOJIS[shortcode.name[0]!];
    if (!entries) return null;

    for (
      let index = lowerBound(entries, shortcode.name);
      index < entries.length && items.length < MAX_SUGGESTIONS;
      index++
    ) {
      const [name, emoji] = entries[index]!;
      if (!name.startsWith(shortcode.name)) break;
      items.push({ value: emoji, label: `${emoji}  :${name}:` });
    }
  }

  return items.length > 0 ? { items, prefix: shortcode.prefix } : null;
}

/** Return a replacement once a complete `:shortcode:` has been typed. */
export function getEmojiInlineReplacement(textBeforeCursor: string): EmojiInlineReplacement | null {
  if (!textBeforeCursor.endsWith(":")) return null;

  const closingColon = textBeforeCursor.length - 1;
  let nameStart = closingColon;
  while (nameStart > 0 && isShortcodeCharacter(textBeforeCursor.charCodeAt(nameStart - 1))) nameStart--;
  if (nameStart === closingColon || nameStart === 0 || textBeforeCursor.charCodeAt(nameStart - 1) !== 0x3a) return null;

  const openingColon = nameStart - 1;
  if (!isTokenBoundary(textBeforeCursor, openingColon)) return null;

  const name = textBeforeCursor.slice(nameStart, closingColon).toLowerCase();
  const entries = EMOJIS[name[0] ?? ""];
  if (!entries) return null;

  const entry = entries[lowerBound(entries, name)];
  if (!entry || entry[0] !== name) return null;
  return { replaceLen: name.length + 2, insert: entry[1] };
}

export function applyEmojiCompletion(
  lines: string[],
  cursorLine: number,
  cursorCol: number,
  item: AutocompleteItem,
  prefix: string,
): { lines: string[]; cursorLine: number; cursorCol: number } {
  const line = lines[cursorLine] ?? "";
  const before = line.slice(0, cursorCol - prefix.length);
  const nextLines = [...lines];
  nextLines[cursorLine] = before + item.value + line.slice(cursorCol);
  return { lines: nextLines, cursorLine, cursorCol: before.length + item.value.length };
}

/** Add emoji shortcodes without taking over Pi's existing command/path completion. */
export function createEmojiAutocompleteProvider(current: AutocompleteProvider): AutocompleteProvider {
  return {
    triggerCharacters: [...new Set([...(current.triggerCharacters ?? []), ":"])],
    async getSuggestions(lines, cursorLine, cursorCol, options) {
      const emojiSuggestions = getEmojiSuggestions((lines[cursorLine] ?? "").slice(0, cursorCol));
      return emojiSuggestions ?? current.getSuggestions(lines, cursorLine, cursorCol, options);
    },
    applyCompletion(lines, cursorLine, cursorCol, item, prefix) {
      return prefix.startsWith(":")
        ? applyEmojiCompletion(lines, cursorLine, cursorCol, item, prefix)
        : current.applyCompletion(lines, cursorLine, cursorCol, item, prefix);
    },
    shouldTriggerFileCompletion: current.shouldTriggerFileCompletion?.bind(current),
  };
}
