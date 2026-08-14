import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
const THINKING_LEVELS: ThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

export function registerThinkingShortcuts(pi: ExtensionAPI): void {
  const change = (direction: 1 | -1, ctx: ExtensionContext): void => {
    const before = pi.getThinkingLevel();
    const after = stepAvailableThinkingLevel(pi, before, direction);
    ctx.ui.notify(
      after === before
        ? `Thinking stayed ${after} (model ${direction === 1 ? "maximum" : "minimum"})`
        : `Thinking: ${after}`,
      "info",
    );
  };

  pi.registerShortcut("alt+.", {
    description: "Increase thinking level",
    handler: (ctx) => change(1, ctx),
  });
  pi.registerShortcut("alt+,", {
    description: "Decrease thinking level",
    handler: (ctx) => change(-1, ctx),
  });
  pi.registerCommand("thinking-up", {
    description: "Increase thinking level",
    handler: async (_args, ctx) => change(1, ctx),
  });
  pi.registerCommand("thinking-down", {
    description: "Decrease thinking level",
    handler: async (_args, ctx) => change(-1, ctx),
  });
}

/**
 * Step to the next thinking level the current model actually supports, probing
 * through the global ladder in the given direction. The SDK clamps unsupported
 * levels back to the current one without persisting anything, so each probe is
 * a no-op until it hits an available level — the first probe that changes the
 * effective level lands exactly on the model's next supported level.
 */
export function stepAvailableThinkingLevel(
  pi: ExtensionAPI,
  current: ThinkingLevel,
  direction: 1 | -1,
): ThinkingLevel {
  const currentIndex = Math.max(0, THINKING_LEVELS.indexOf(current));
  const candidates =
    direction === 1
      ? THINKING_LEVELS.slice(currentIndex + 1)
      : THINKING_LEVELS.slice(0, currentIndex).reverse();
  for (const candidate of candidates) {
    pi.setThinkingLevel(candidate);
    const after = pi.getThinkingLevel();
    if (after !== current) return after;
  }
  return current;
}
