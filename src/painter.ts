import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { basename, extname, isAbsolute, join, resolve } from "node:path";
import { homedir } from "node:os";
import { randomUUID } from "node:crypto";
import { defineTool, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { ProviderHeaders } from "@earendil-works/pi-ai";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";

const CODEX_IMAGES_URL = "https://chatgpt.com/backend-api/codex/images";
const MAX_REFERENCES = 5;
const MAX_REFERENCE_BYTES = 20 * 1024 * 1024;
const REQUEST_TIMEOUT_MS = 3 * 60_000;

const MIME_TYPES: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
};

type PainterParams = {
  prompt: string;
  reference_images?: string[];
  count?: 1 | 2 | 3 | 4;
  quality?: "low" | "medium" | "high" | "auto";
  mode?: "ui" | "general";
};

type PainterDetails = {
  operation: "generate" | "edit";
  paths: string[];
  quality: NonNullable<PainterParams["quality"]>;
  references: string[];
};

type PainterDependencies = {
  fetch?: typeof fetch;
  outputRoot?: string;
};

/** Creates images with the active ChatGPT/Codex OAuth subscription. */
export function createPainterTool(dependencies: PainterDependencies = {}) {
  const fetchImpl = dependencies.fetch ?? fetch;
  const outputRoot = dependencies.outputRoot ?? join(homedir(), ".pi", "generated_images");

  return defineTool({
    name: "painter",
    label: "Painter",
    description: "Create or edit raster images. For UI edits, pass the current screenshot first to preserve its visual system.",
    promptSnippet: "Create images and UI edits from local references.",
    promptGuidelines: [
      "Use for raster assets and UI mockups, not SVG, HTML, or CSS.",
      "For UI edits, pass the current screenshot first and name the change.",
      "Use count for variants; reuse an output path for follow-up edits.",
    ],
    parameters: Type.Object({
      prompt: Type.String({ minLength: 1, description: "What to create or change. Quote required text exactly." }),
      reference_images: Type.Optional(Type.Array(Type.String({ minLength: 1 }), {
        minItems: 1,
        maxItems: MAX_REFERENCES,
        description: "Up to five local paths. In UI mode, the first is the edit target.",
      })),
      count: Type.Optional(Type.Union([Type.Literal(1), Type.Literal(2), Type.Literal(3), Type.Literal(4)], {
        description: "Image variants to create. Default: 1.",
      })),
      quality: Type.Optional(Type.Union([Type.Literal("low"), Type.Literal("medium"), Type.Literal("high"), Type.Literal("auto")], {
        description: "Output quality. Default: auto.",
      })),
      mode: Type.Optional(Type.Union([Type.Literal("ui"), Type.Literal("general")], {
        description: "ui preserves a referenced product design. Default: ui.",
      })),
    }, { additionalProperties: false }),
    executionMode: "parallel",
    renderCall(args: PainterParams, theme) {
      const references = args.reference_images?.length ?? 0;
      const count = args.count ?? 1;
      const operation = references ? "edit" : "generate";
      return new Text(
        `${theme.fg("toolTitle", theme.bold("Painter"))}${theme.fg("muted", ` · ${operation} · ${count} image${count === 1 ? "" : "s"}`)}\n${theme.fg("text", args.prompt)}`,
        0,
        0,
      );
    },
    async execute(toolCallId: string, params: PainterParams, signal: AbortSignal | undefined, _onUpdate: unknown, ctx: ExtensionContext) {
      const quality = params.quality ?? "auto";
      const mode = params.mode ?? "ui";
      const references = await loadReferences(params.reference_images ?? [], ctx.cwd);
      const operation = references.length ? "edit" : "generate";
      const auth = await codexAuth(ctx);
      const requestSignal = timeoutSignal(signal, REQUEST_TIMEOUT_MS);
      try {
        const response = await fetchImpl(`${CODEX_IMAGES_URL}/${operation === "edit" ? "edits" : "generations"}`, {
          method: "POST",
          signal: requestSignal.signal,
          headers: codexHeaders(auth.apiKey, auth.headers, toolCallId),
          body: JSON.stringify({
            model: "gpt-image-2",
            prompt: buildPrompt(params.prompt, mode, references.length),
            ...(references.length ? { images: references.map((reference) => ({ image_url: reference.dataUrl })) } : {}),
            n: params.count ?? 1,
            quality,
            size: "auto",
            background: "auto",
          }),
        });
        if (!response.ok) throw new Error(await responseError(response));
        const payload = await response.json() as { data?: Array<{ b64_json?: string }> };
        const data = payload.data?.map((entry) => entry.b64_json).filter((entry): entry is string => typeof entry === "string" && entry.length > 0) ?? [];
        if (data.length === 0) throw new Error("Painter returned no image data.");
        const paths = await saveImages(data, outputRoot, toolCallId);
        return {
          content: [
            { type: "text", text: `Created ${paths.length} image${paths.length === 1 ? "" : "s"} (${operation}, ${quality}).\n${paths.join("\n")}` },
            ...data.map((image) => ({ type: "image" as const, data: image, mimeType: "image/png" })),
          ],
          details: { operation, paths, quality, references: references.map((reference) => reference.path) } satisfies PainterDetails,
        };
      } finally {
        requestSignal.dispose();
      }
    },
  });
}

async function codexAuth(ctx: ExtensionContext): Promise<{ apiKey: string; headers?: ProviderHeaders }> {
  const model = ctx.model?.provider === "openai-codex"
    ? ctx.model
    : ctx.modelRegistry.getAll().find((candidate) => candidate.provider === "openai-codex");
  if (!model) throw new Error("Painter requires an OpenAI Codex login. Select an openai-codex model and sign in first.");
  const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
  if (!auth.ok || !auth.apiKey) throw new Error(`Painter could not access Codex OAuth credentials${auth.ok ? "." : `: ${auth.error}`}`);
  return { apiKey: auth.apiKey, headers: auth.headers };
}

function codexHeaders(apiKey: string, authHeaders: ProviderHeaders | undefined, toolCallId: string): Record<string, string> {
  const headers: Record<string, string> = {
    "Authorization": `Bearer ${apiKey}`,
    "Accept": "application/json",
    "Content-Type": "application/json",
    "OpenAI-Beta": "codex-1",
    "originator": "Pi",
    "x-codex-image-turn-id": toolCallId,
  };
  // Null values are header-deletion markers: drop them rather than sending
  // them to fetch (which would serialize null as the literal string "null").
  for (const [name, value] of Object.entries(authHeaders ?? {})) {
    if (value !== null) headers[name] = value;
  }
  if (!header(headers, "ChatGPT-Account-ID")) {
    const accountId = accountIdFromToken(apiKey);
    if (accountId) headers["ChatGPT-Account-ID"] = accountId;
  }
  return headers;
}

async function loadReferences(paths: string[], cwd: string): Promise<Array<{ path: string; dataUrl: string }>> {
  if (paths.length > MAX_REFERENCES) throw new Error(`Painter accepts at most ${MAX_REFERENCES} reference images.`);
  return Promise.all(paths.map(async (input) => {
    const path = isAbsolute(input) ? input : resolve(cwd, input);
    const mimeType = MIME_TYPES[extname(path).toLowerCase()];
    if (!mimeType) throw new Error(`Unsupported reference image '${input}'. Use PNG, JPEG, WebP, or GIF.`);
    const bytes = await readFile(path);
    if (bytes.byteLength > MAX_REFERENCE_BYTES) throw new Error(`Reference image '${input}' exceeds the ${MAX_REFERENCE_BYTES / 1024 / 1024}MB limit.`);
    return { path, dataUrl: `data:${mimeType};base64,${bytes.toString("base64")}` };
  }));
}

function buildPrompt(prompt: string, mode: "ui" | "general", referenceCount: number): string {
  if (mode !== "ui" || referenceCount === 0) return prompt.trim();
  return `${prompt.trim()}\n\nUI preservation requirements: Image 1 is the authoritative existing-product screenshot. Preserve its application shell, layout, typography, spacing rhythm, palette, surface treatment, borders, shadows, and all unaffected content. Change only what this request explicitly names. The result must look like a native extension of this exact product, not a redesign or a generic dashboard.`;
}

async function saveImages(images: string[], outputRoot: string, toolCallId: string): Promise<string[]> {
  const directory = join(outputRoot, new Date().toISOString().slice(0, 10));
  await mkdir(directory, { recursive: true });
  return Promise.all(images.map(async (image, index) => {
    const bytes = Buffer.from(image, "base64");
    if (bytes.length === 0) throw new Error("Painter returned invalid image data.");
    const name = `${safeName(toolCallId)}-${index + 1}-${randomUUID().slice(0, 8)}.png`;
    const path = join(directory, name);
    const temporary = `${path}.tmp`;
    await writeFile(temporary, bytes, { flag: "wx" });
    await rename(temporary, path);
    return path;
  }));
}

function safeName(value: string): string {
  return basename(value).replace(/[^a-zA-Z0-9_-]/g, "_") || "image";
}

function header(headers: Record<string, string>, name: string): string | undefined {
  const target = name.toLowerCase();
  return Object.entries(headers).find(([key]) => key.toLowerCase() === target)?.[1];
}

function accountIdFromToken(token: string): string | undefined {
  try {
    const payload = token.split(".")[1];
    if (!payload) return undefined;
    const decoded = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as Record<string, { chatgpt_account_id?: string } | undefined>;
    return decoded["https://api.openai.com/auth"]?.chatgpt_account_id;
  } catch {
    return undefined;
  }
}

async function responseError(response: Response): Promise<string> {
  let message = `Painter request failed: ${response.status} ${response.statusText}`;
  try {
    const body = await response.json() as { error?: { message?: string; code?: string } };
    if (body.error?.message) message = body.error.message;
    if (body.error?.code === "moderation_blocked") message = "Painter blocked this request under image safety policy. Revise the prompt or reference image.";
  } catch { /* Keep the HTTP error. */ }
  return message;
}

function timeoutSignal(parent: AbortSignal | undefined, milliseconds: number): { signal: AbortSignal; dispose: () => void } {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error("Painter timed out.")), milliseconds);
  const abort = () => controller.abort(parent?.reason);
  parent?.addEventListener("abort", abort, { once: true });
  return {
    signal: controller.signal,
    dispose: () => {
      clearTimeout(timer);
      parent?.removeEventListener("abort", abort);
    },
  };
}

export { buildPrompt, codexHeaders, loadReferences };
