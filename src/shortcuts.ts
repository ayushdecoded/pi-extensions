import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
const THINKING_LEVELS: ThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

export function registerThinkingShortcuts(pi: ExtensionAPI): void {
  const change = (direction: 1 | -1, ctx: ExtensionContext): void => {
    const before = pi.getThinkingLevel();
    const requested = stepThinkingLevel(before, direction);
    pi.setThinkingLevel(requested);
    const after = pi.getThinkingLevel();
    ctx.ui.notify(
      after === before && requested !== before
        ? `Thinking stayed ${after} (current model may clamp it)`
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

export function stepThinkingLevel(current: ThinkingLevel, direction: 1 | -1): ThinkingLevel {
  const index = Math.max(0, THINKING_LEVELS.indexOf(current));
  return THINKING_LEVELS[Math.max(0, Math.min(THINKING_LEVELS.length - 1, index + direction))]!;
}
