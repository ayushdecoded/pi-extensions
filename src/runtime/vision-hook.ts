import { readFileSync } from "node:fs";
import {
  createAgentSession,
  DefaultResourceLoader,
  getAgentDir,
  SessionManager,
  SettingsManager,
  type ExtensionContext,
  type ExtensionFactory,
  type ResourceLoader,
  type ToolResultEvent,
} from "@earendil-works/pi-coding-agent";
import type { Api, AssistantMessage, ImageContent, Model, TextContent } from "@earendil-works/pi-ai";
import { usageDelta } from "./state.ts";
import type { Usage } from "./types.ts";

const IMAGES_DISABLED_NOTE = "Image reading is disabled: this model cannot see images and no image model is configured.";

/** Fixed instruction for the vision sidecar: report everything, act on nothing. */
const VISION_PROMPT =
  "Describe the attached image(s) exhaustively: transcribe all visible text verbatim, and report layout, colors, UI elements, diagrams, code, people, and anything else which might have been missed here. Include every detail you can see; do not summarize, interpret, or take action. This description is the only view another agent has of the image.";

/** Sidecars only describe; keep thinking low so they stay cheap. */
const VISION_THINKING = "low" as const;

/** What the read-tool hook needs: which sidecar to run and which prompt to use. */
export type VisionConfig = {
  sidecar?: string;
  promptFile?: string;
};

/** pi-ai's native usage shape as carried on tool result messages. */
type NativeUsage = {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  totalTokens: number;
  cost: { input: number; output: number; cacheRead: number; cacheWrite: number; total: number };
};

/**
 * The one image-viewing mechanism: when a text-only model's `read` returns
 * image bytes, swap them for a description from the configured vision sidecar.
 * The model never sees a new tool — it just called read. Image-capable models
 * are untouched, and no-sidecar sessions get a plain text note.
 *
 * The vision config comes from agents.yaml via the getter: subagents use the
 * resolved role preset (`image`/`imagePrompt`), the main session uses the
 * `defaults` values. Only the built-in prompt is a code fallback.
 */
export function createVisionHookHandler(
  getVision: () => VisionConfig,
  describe: DescribeImages = describeImages,
): (event: ToolResultEvent, ctx: ExtensionContext) => Promise<{ content: TextContent[]; usage?: NativeUsage } | void> {
  return async (event, ctx) => {
    if (event.toolName !== "read") return;
    const model = ctx.model;
    if (!model || model.input.includes("image")) return;

    const images = (event.content ?? []).filter((content): content is ImageContent => content.type === "image");
    if (images.length === 0) return;

    const { sidecar: sidecarId, promptFile } = getVision();
    if (!sidecarId) {
      return { content: replaceImages(event.content, IMAGES_DISABLED_NOTE) };
    }

    const slash = sidecarId.indexOf("/");
    const sidecar = ctx.modelRegistry.find(sidecarId.slice(0, slash), sidecarId.slice(slash + 1));
    if (!sidecar) {
      return { content: replaceImages(event.content, `Image analysis unavailable: ${sidecarId} is not in the model catalog.`) };
    }

    const prompt = promptFile ? readFileSync(promptFile, "utf8").trim() : VISION_PROMPT;
    try {
      const { text, usage } = await describe(ctx.cwd, sidecar, images, prompt, ctx.signal ?? undefined);
      return {
        content: replaceImages(event.content, `<image analysis>\n${text}\n</image analysis>`),
        usage: addNativeUsage(event.usage, toNativeUsage(usage)),
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { content: replaceImages(event.content, `Image analysis failed: ${message}`) };
    }
  };
}

/** Wrap the shared handler as a minimal inline extension for child sessions. */
export function createVisionHookExtension(getVision: () => VisionConfig, describe?: DescribeImages): ExtensionFactory {
  return (pi) => {
    pi.on("tool_result", createVisionHookHandler(getVision, describe));
  };
}

type DescribeImages = typeof describeImages;

/**
 * Run a throwaway vision session that only describes images, then dispose it.
 * Internal: the hook is the only caller, so there is no standalone image path.
 */
async function describeImages(
  cwd: string,
  model: Model<Api>,
  images: ImageContent[],
  prompt: string,
  signal?: AbortSignal,
): Promise<{ text: string; usage: Usage }> {
  const agentDir = getAgentDir();
  const settings = SettingsManager.create(cwd, agentDir, { projectTrusted: true });
  const created = await createAgentSession({
    cwd,
    agentDir,
    model,
    thinkingLevel: VISION_THINKING,
    noTools: "all",
    resourceLoader: await createSidecarResourceLoader(cwd, settings),
    sessionManager: SessionManager.inMemory(cwd),
    settingsManager: settings,
  });
  const session = created.session;
  const abortSidecar = () => void session.abort();
  signal?.addEventListener("abort", abortSidecar, { once: true });
  try {
    const before = statsUsage(session.getSessionStats());
    await session.prompt(prompt, { images });
    await session.waitForIdle();
    if (signal?.aborted) throw new Error("Image analysis was cancelled.");
    const final = lastAssistant(session.messages);
    if (!final) throw new Error("Image analysis produced no response.");
    return { text: assistantText(final), usage: usageDelta(statsUsage(session.getSessionStats()), before) };
  } finally {
    signal?.removeEventListener("abort", abortSidecar);
    session.dispose();
  }
}

/** A bare loader for throwaway sidecar sessions that must not see role prompts or skills. */
async function createSidecarResourceLoader(cwd: string, settings: SettingsManager): Promise<ResourceLoader> {
  const agentDir = getAgentDir();
  const loader = new DefaultResourceLoader({
    cwd,
    agentDir,
    settingsManager: settings,
    noExtensions: true,
    noPromptTemplates: true,
    noThemes: true,
    systemPromptOverride: () => undefined,
    appendSystemPromptOverride: () => [],
  });
  await loader.reload();
  return loader;
}

/** Keep the read result's text notes and swap every image part for the given text. */
export function replaceImages(content: Array<{ type: string; text?: string }> | undefined, replacement: string): TextContent[] {
  const text = (content ?? [])
    .filter((part): part is { type: "text"; text: string } => part.type === "text" && typeof part.text === "string")
    .map((part) => part.text)
    .join("\n")
    .trim();
  const body = text ? `${text}\n\n${replacement}` : replacement;
  return [{ type: "text", text: body }];
}

function statsUsage(stats: {
  tokens: { input: number; output: number; cacheRead: number; cacheWrite: number; total: number };
  cost: number;
}): Usage {
  return {
    input: stats.tokens.input,
    output: stats.tokens.output,
    cacheRead: stats.tokens.cacheRead,
    cacheWrite: stats.tokens.cacheWrite,
    total: stats.tokens.total,
    cost: stats.cost,
  };
}

function lastAssistant(messages: readonly unknown[]): AssistantMessage | undefined {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index] as { role?: unknown };
    if (message?.role === "assistant") return message as AssistantMessage;
  }
  return undefined;
}

function assistantText(message: AssistantMessage): string {
  return message.content
    .filter((part): part is Extract<AssistantMessage["content"][number], { type: "text" }> => part.type === "text")
    .map((part) => part.text)
    .join("\n")
    .trim();
}

function toNativeUsage(usage: Usage): NativeUsage {
  return {
    input: usage.input,
    output: usage.output,
    cacheRead: usage.cacheRead,
    cacheWrite: usage.cacheWrite,
    totalTokens: usage.total,
    cost: { input: usage.cost, output: 0, cacheRead: 0, cacheWrite: 0, total: usage.cost },
  };
}

function addNativeUsage(left: NativeUsage | undefined, right: NativeUsage): NativeUsage {
  if (!left) return right;
  return {
    input: left.input + right.input,
    output: left.output + right.output,
    cacheRead: left.cacheRead + right.cacheRead,
    cacheWrite: left.cacheWrite + right.cacheWrite,
    totalTokens: left.totalTokens + right.totalTokens,
    cost: {
      input: left.cost.input + right.cost.input,
      output: left.cost.output + right.cost.output,
      cacheRead: left.cost.cacheRead + right.cost.cacheRead,
      cacheWrite: left.cost.cacheWrite + right.cost.cacheWrite,
      total: left.cost.total + right.cost.total,
    },
  };
}
