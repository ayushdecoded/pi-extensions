import assert from "node:assert/strict";
import { test } from "node:test";
import type { AutocompleteProvider } from "@earendil-works/pi-tui";
import {
  applyEmojiCompletion,
  createEmojiAutocompleteProvider,
  getEmojiInlineReplacement,
  getEmojiSuggestions,
} from "../src/ui/emoji-autocomplete.ts";

test("shows the full emoji list at a bare colon and filters as text is typed", () => {
  const allSuggestions = getEmojiSuggestions("hello :");
  assert.ok(allSuggestions);
  assert.equal(allSuggestions.prefix, ":");
  assert.ok(allSuggestions.items.length > 12);
  assert.ok(allSuggestions.items.some((item) => item.label.includes(":smile:")));

  const filteredSuggestions = getEmojiSuggestions("hello :smi");
  assert.ok(filteredSuggestions);
  assert.equal(filteredSuggestions.prefix, ":smi");
  assert.ok(filteredSuggestions.items.some((item) => item.label.includes(":smile:")));
  assert.ok(filteredSuggestions.items.length <= 12);
});

test("suggests emoji shortcodes only at token boundaries", () => {
  assert.equal(getEmojiSuggestions("https://example.test/:smi"), null);
  assert.equal(getEmojiSuggestions("word:smile"), null);
});

test("expands complete shortcodes but leaves unknown or embedded text alone", () => {
  assert.deepEqual(getEmojiInlineReplacement("hello :smile:"), { replaceLen: 7, insert: "😄" });
  assert.equal(getEmojiInlineReplacement("hello :not_an_emoji:"), null);
  assert.equal(getEmojiInlineReplacement("word:smile:"), null);
});

test("completion replaces just the shortcode before the cursor", () => {
  assert.deepEqual(
    applyEmojiCompletion(["hello :smi world"], 0, 10, { value: "😄", label: "😄  :smile:" }, ":smi"),
    { lines: ["hello 😄 world"], cursorLine: 0, cursorCol: 8 },
  );
});

test("emoji completion falls back to Pi's existing provider", async () => {
  let fallbacks = 0;
  const current: AutocompleteProvider = {
    async getSuggestions() {
      fallbacks++;
      return { items: [{ value: "fallback", label: "fallback" }], prefix: "fallback" };
    },
    applyCompletion(lines, cursorLine, cursorCol) {
      return { lines, cursorLine, cursorCol };
    },
  };
  const provider = createEmojiAutocompleteProvider(current);
  const result = await provider.getSuggestions(["/help"], 0, 5, { signal: new AbortController().signal });
  assert.equal(fallbacks, 1);
  assert.deepEqual(result, { items: [{ value: "fallback", label: "fallback" }], prefix: "fallback" });
});
