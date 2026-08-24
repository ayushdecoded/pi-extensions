import assert from "node:assert/strict";
import { test } from "node:test";
import { endsWithEmptyFinal } from "../src/runtime/runtime.ts";

function assistant(stopReason: string, content: unknown[]) {
  return { role: "assistant", stopReason, content };
}

test("endsWithEmptyFinal matches the empty completion observed from stealth/ox-alpha (content: [], stop)", () => {
  const session = {
    messages: [
      { role: "user", content: [{ type: "text", text: "task" }] },
      // Exact shape from the incident log: zero-usage, no content blocks.
      assistant("stop", []),
    ],
  };
  assert.equal(endsWithEmptyFinal(session), true);
});

test("endsWithEmptyFinal matches a length-truncated turn whose hidden reasoning consumed the budget", () => {
  const session = {
    messages: [
      { role: "user", content: [{ type: "text", text: "task" }] },
      assistant("length", [{ type: "text", text: "" }]),
    ],
  };
  assert.equal(endsWithEmptyFinal(session), true);
});

test("endsWithEmptyFinal accepts a normal final report", () => {
  const session = {
    messages: [
      { role: "user", content: [{ type: "text", text: "task" }] },
      assistant("stop", [{ type: "text", text: "Slice complete. All checks green." }]),
    ],
  };
  assert.equal(endsWithEmptyFinal(session), false);
});

test("endsWithEmptyFinal accepts a length-stopped turn that still produced text", () => {
  const session = {
    messages: [
      { role: "user", content: [{ type: "text", text: "task" }] },
      assistant("length", [{ type: "text", text: "Partial report before the cutoff." }]),
    ],
  };
  assert.equal(endsWithEmptyFinal(session), false);
});

test("endsWithEmptyFinal ignores non-final stops (tool use, errors, aborted)", () => {
  for (const stopReason of ["toolUse", "error", "aborted", "pending"]) {
    const session = {
      messages: [
        { role: "user", content: [{ type: "text", text: "task" }] },
        assistant(stopReason, []),
      ],
    };
    assert.equal(endsWithEmptyFinal(session), false, `stopReason=${stopReason}`);
  }
});

test("endsWithEmptyFinal returns false when there is no assistant message yet", () => {
  assert.equal(endsWithEmptyFinal({ messages: [{ role: "user", content: [] }] }), false);
});
