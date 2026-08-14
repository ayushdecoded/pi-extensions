import assert from "node:assert/strict";
import { test } from "node:test";
import { stepAvailableThinkingLevel } from "../src/shortcuts.ts";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
const THINKING_LEVELS: ThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

/** Minimal ExtensionAPI stand-in reproducing the SDK's supported-level clamping. */
function fakePi(supported: ThinkingLevel[], initial: ThinkingLevel): ExtensionAPI {
  let level = initial;
  return {
    getThinkingLevel: () => level,
    setThinkingLevel: (requested) => {
      const requestedIndex = Math.max(0, THINKING_LEVELS.indexOf(requested));
      if (supported.includes(requested)) {
        level = requested;
        return;
      }
      for (let i = requestedIndex; i < THINKING_LEVELS.length; i++) {
        const candidate = THINKING_LEVELS[i]!;
        if (supported.includes(candidate)) {
          level = candidate;
          return;
        }
      }
      for (let i = requestedIndex - 1; i >= 0; i--) {
        const candidate = THINKING_LEVELS[i]!;
        if (supported.includes(candidate)) {
          level = candidate;
          return;
        }
      }
      level = supported[0]!;
    },
  } as ExtensionAPI;
}

test("steps only within the model's supported levels (off/high/max)", () => {
  const pi = fakePi(["off", "high", "max"], "max");
  assert.equal(stepAvailableThinkingLevel(pi, "max", -1), "high");
  assert.equal(pi.getThinkingLevel(), "high");
  assert.equal(stepAvailableThinkingLevel(pi, "high", -1), "off");
  assert.equal(stepAvailableThinkingLevel(pi, "off", -1), "off");
  assert.equal(stepAvailableThinkingLevel(pi, "off", 1), "high");
  assert.equal(stepAvailableThinkingLevel(pi, "high", 1), "max");
  assert.equal(stepAvailableThinkingLevel(pi, "max", 1), "max");
});

test("skips unsupported levels when descending from max (high/max only)", () => {
  const pi = fakePi(["high", "max"], "max");
  assert.equal(stepAvailableThinkingLevel(pi, "max", -1), "high");
  assert.equal(stepAvailableThinkingLevel(pi, "high", -1), "high");
});

test("full ladder still steps one level at a time", () => {
  const pi = fakePi(THINKING_LEVELS, "medium");
  assert.equal(stepAvailableThinkingLevel(pi, "medium", 1), "high");
  assert.equal(stepAvailableThinkingLevel(pi, "medium", -1), "low");
  assert.equal(stepAvailableThinkingLevel(pi, "off", -1), "off");
  assert.equal(stepAvailableThinkingLevel(pi, "max", 1), "max");
});

test("sparse maps land on the nearest supported level, not a clamp detour", () => {
  const pi = fakePi(["minimal", "xhigh"], "minimal");
  assert.equal(stepAvailableThinkingLevel(pi, "minimal", 1), "xhigh");
  assert.equal(stepAvailableThinkingLevel(pi, "xhigh", -1), "minimal");
  assert.equal(stepAvailableThinkingLevel(pi, "xhigh", 1), "xhigh");
});
