import assert from "node:assert/strict";
import { test } from "node:test";
import { normalizeHeading, parseSubagentHeadings } from "../src/subagent-headings.ts";

test("parses one call heading and one ordered heading per request", () => {
  assert.deepEqual(
    parseSubagentHeadings(
      '```json\n{"call":"CRM API Workstream Implementation","requests":["Contact Package APIs","Map Existing CRM APIs"]}\n```',
      2,
    ),
    {
      call: "CRM API Workstream Implementation",
      requests: ["Contact Package APIs", "Map Existing CRM APIs"],
    },
  );
  assert.equal(parseSubagentHeadings('{"call":"Batch","requests":["Only one"]}', 2), undefined);
});

test("headings are terminal-safe and limited to six words", () => {
  assert.equal(
    normalizeHeading("**One two three four five six seven.**\x1b]0;hidden\x07"),
    "One two three four five six",
  );
  assert.equal(normalizeHeading("\x1b[31mInspect API contracts\x1b[0m"), "Inspect API contracts");
  assert.equal(normalizeHeading("   "), undefined);
});
