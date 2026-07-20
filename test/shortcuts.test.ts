import assert from "node:assert/strict";
import { test } from "node:test";
import { stepThinkingLevel } from "../src/shortcuts.ts";

test("directional thinking steps clamp at supported boundaries", () => {
  assert.equal(stepThinkingLevel("medium", 1), "high");
  assert.equal(stepThinkingLevel("medium", -1), "low");
  assert.equal(stepThinkingLevel("max", 1), "max");
  assert.equal(stepThinkingLevel("off", -1), "off");
});
