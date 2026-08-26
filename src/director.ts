import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { basename, extname, isAbsolute, join, resolve } from "node:path";
import { homedir } from "node:os";
import { randomUUID } from "node:crypto";
import { defineTool, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { ProviderHeaders } from "@earendil-works/pi-ai";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { canonicalProviderId } from "./accounts/providers.ts";

const XAI_VIDEOS_BASE_URL = "https://api.x.ai/v1/videos";
const MAX_REFERENCES = 7;
const MAX_DURATION_SECONDS = 15;
const MAX_REFERENCE_DURATION_SECONDS = 10;
const OVERALL_TIMEOUT_MS = 10 * 60_000;

const ASPECT_RATIOS = ["1:1", "16:9", "9:16", "4:3", "3:4", "3:2", "2:3"] as const;
const RESOLUTIONS = ["480p", "720p"] as const;

const DEFAULT_MODEL = "grok-imagine-video";
const SOURCE_IMAGE_MODEL = "grok-imagine-video-1.5";

const IMAGE_MIME_TYPES: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
};

const VIDEO_MIME_TYPES: Record<string, string> = {
  ".mp4": "video/mp4",
  ".m4v": "video/mp4",
  ".webm": "video/webm",
  ".mov": "video/quicktime",
};

type AspectRatio = (typeof ASPECT_RATIOS)[number];
type Resolution = (typeof RESOLUTIONS)[number];

type DirectorParams = {
  prompt: string;
  source_image?: string;
  reference_images?: string[];
  source_video?: string;
  duration?: number;
  aspect_ratio?: AspectRatio;
  resolution?: Resolution;
};

type DirectorOperation = "generate" | "image-to-video" | "reference-to-video" | "edit";

type DirectorDetails = {
  operation: DirectorOperation;
  requestId: string;
  model: string;
  outputPath: string;
  outputUrl: string;
};

type DirectorDependencies = {
  fetch?: typeof fetch;
  outputRoot?: string;
  pollIntervalMs?: number;
};

type MediaInput = { path: string; url: string };

/** Creates videos with the active xAI login (SuperGrok/X Premium) via the experimental Imagine video endpoints. */
export function createDirectorTool(dependencies: DirectorDependencies = {}) {
  const fetchImpl = dependencies.fetch ?? fetch;
  const outputRoot = dependencies.outputRoot ?? join(homedir(), ".pi", "generated_videos");
  const pollIntervalMs = dependencies.pollIntervalMs ?? 3_000;

  return defineTool({
    name: "director",
    label: "Director",
    description:
      "Generate videos from a prompt, animate one source image, direct scenes with up to seven reference images, or apply a prompt-guided edit to an existing video. Returns the saved MP4 path.",
    promptSnippet: "Create videos from text, images, references, or edit existing footage.",
    promptGuidelines: [
      "Pass exactly one kind of media: source_image, reference_images, or source_video — never several.",
      "For generation, duration is 1-15 seconds (at most 10 with references); edits inherit the source video's length and geometry.",
      "Generation is asynchronous and slow; report the returned MP4 path to the user instead of reading it back.",
    ],
    parameters: Type.Object({
      prompt: Type.String({ minLength: 1, description: "What the video shows, or the change to make when editing." }),
      source_image: Type.Optional(Type.String({ minLength: 1, description: "Local path or HTTPS URL of one image to animate." })),
      reference_images: Type.Optional(Type.Array(Type.String({ minLength: 1 }), {
        minItems: 1,
        maxItems: MAX_REFERENCES,
        description: `Up to ${MAX_REFERENCES} local paths or HTTPS URLs guiding subjects and style.`,
      })),
      source_video: Type.Optional(Type.String({ minLength: 1, description: "Local path or HTTPS URL of an MP4/WebM clip to edit." })),
      duration: Type.Optional(Type.Number({
        minimum: 1,
        maximum: MAX_DURATION_SECONDS,
        multipleOf: 1,
        description: `Generated clip length in seconds (1-${MAX_DURATION_SECONDS}; at most ${MAX_REFERENCE_DURATION_SECONDS} with reference images). Ignored for edits. Default: 5.`,
      })),
      aspect_ratio: Type.Optional(Type.Union(ASPECT_RATIOS.map((value) => Type.Literal(value)), {
        description: `Generated frame aspect ratio. One of ${ASPECT_RATIOS.join(", ")}. Ignored for edits. Default: 16:9.`,
      })),
      resolution: Type.Optional(Type.Union(RESOLUTIONS.map((value) => Type.Literal(value)), {
        description: "Generated output resolution. One of 480p, 720p. Ignored for edits. Default: 720p.",
      })),
    }, { additionalProperties: false }),
    executionMode: "parallel",
    renderCall(args: DirectorParams, theme) {
      const operation = operationFor(args);
      return new Text(
        `${theme.fg("toolTitle", theme.bold("Director"))}${theme.fg("muted", ` · ${operation.label}`)}\n${theme.fg("text", args.prompt)}`,
        0,
        0,
      );
    },
    async execute(toolCallId: string, params: DirectorParams, signal: AbortSignal | undefined, _onUpdate: unknown, ctx: ExtensionContext) {
      const plan = planRequest(params);
      // Local paths are encoded as data URLs after validation; HTTPS URLs pass through.
      if (plan.operation === "image-to-video") {
        plan.payload.image = { url: (await loadMedia(params.source_image!, ctx.cwd, "image")).url };
      } else if (plan.operation === "reference-to-video") {
        plan.payload.reference_images = await Promise.all(
          (params.reference_images ?? []).map(async (reference) => ({
            url: (await loadMedia(reference, ctx.cwd, "image")).url,
          })),
        );
      } else if (plan.operation === "edit") {
        plan.payload.video = { url: (await loadMedia(params.source_video!, ctx.cwd, "video")).url };
      }
      const auth = await resolveXaiAuth(ctx);
      const requestSignal = timeoutSignal(signal, OVERALL_TIMEOUT_MS);
      try {
        // Submit the async generation/edit job with an idempotency key so a
        // retried POST cannot create duplicate renders.
        const submit = await fetchImpl(plan.endpoint, {
          method: "POST",
          signal: requestSignal.signal,
          headers: { ...directorHeaders(auth.apiKey, auth.headers), "x-idempotency-key": randomUUID() },
          body: JSON.stringify(plan.payload),
        });
        if (!submit.ok) throw new Error(await responseError(submit));
        const submitted = await submit.json() as { request_id?: string; id?: string };
        const requestId = submitted.request_id ?? submitted.id;
        if (!requestId) throw new Error("Director did not receive a request id from xAI.");

        const completed = await pollVideo(requestId, auth, requestSignal.signal, fetchImpl, pollIntervalMs);
        const videoUrl = completed.video?.url;
        if (!videoUrl) throw new Error(`Director finished without a video URL (status: ${completed.status}).`);

        const outputPath = await downloadVideo(videoUrl, outputRoot, toolCallId, requestSignal.signal, fetchImpl);
        const summary =
          `Saved video (${plan.operation}, ${plan.model})\n${outputPath}\nSource URL: ${videoUrl}`;
        return {
          content: [{ type: "text" as const, text: summary }],
          details: {
            operation: plan.operation,
            requestId,
            model: plan.model,
            outputPath,
            outputUrl: videoUrl,
          } satisfies DirectorDetails,
        };
      } finally {
        requestSignal.dispose();
      }
    },
  });
}

/** Resolves the active xAI OAuth/API credential, preferring the session model. */
export async function resolveXaiAuth(ctx: ExtensionContext): Promise<{ apiKey: string; headers?: ProviderHeaders }> {
  const models = ctx.modelRegistry.getAll();
  const model = ctx.model && canonicalProviderId(ctx.model.provider) === "xai"
    ? ctx.model
    : models.find((candidate) => canonicalProviderId(candidate.provider) === "xai");
  if (!model) throw new Error("Director requires an xAI login. Select an xai model or run `/login xai` (SuperGrok/X Premium) first.");
  const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
  if (!auth.ok || !auth.apiKey) {
    throw new Error(`Director could not access xAI credentials${auth.ok ? "." : `: ${auth.error}`}`);
  }
  return { apiKey: auth.apiKey, headers: auth.headers };
}

/** Headers for api.x.ai: provider headers first, Authorization only if absent, JSON plus a Pi user agent. */
export function directorHeaders(apiKey: string, authHeaders: ProviderHeaders | undefined): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(authHeaders ?? {})) {
    if (value !== null) headers[name] = value;
  }
  const hasAuthorization = Object.keys(headers).some((name) => name.toLowerCase() === "authorization");
  if (!hasAuthorization) headers["Authorization"] = `Bearer ${apiKey}`;
  headers["Accept"] = "application/json";
  headers["Content-Type"] = "application/json";
  headers["User-Agent"] = "Pi/director";
  return headers;
}

/**
 * Validates inputs, detects the media mode, and builds the submit payload.
 * Media modes are mutually exclusive: at most one of source_image,
 * reference_images, or source_video may be supplied.
 */
export function planRequest(params: DirectorParams): {
  endpoint: string;
  operation: DirectorOperation;
  model: string;
  payload: Record<string, unknown>;
} {
  const hasSourceImage = params.source_image !== undefined;
  const hasReferences = (params.reference_images?.length ?? 0) > 0;
  const hasSourceVideo = params.source_video !== undefined;
  const selected = [hasSourceImage, hasReferences, hasSourceVideo].filter(Boolean).length;
  if (selected > 1) {
    throw new Error("Director accepts only one media mode: choose source_image, reference_images, or source_video.");
  }

  const duration = params.duration ?? 5;
  if (hasReferences && duration > MAX_REFERENCE_DURATION_SECONDS) {
    throw new Error(`Reference-to-video supports at most ${MAX_REFERENCE_DURATION_SECONDS}s clips.`);
  }

  const model = hasSourceImage ? SOURCE_IMAGE_MODEL : DEFAULT_MODEL;
  const base = {
    model,
    prompt: params.prompt.trim(),
    duration,
    aspect_ratio: params.aspect_ratio ?? "16:9",
    resolution: params.resolution ?? "720p",
  };

  if (hasSourceVideo) {
    // xAI edits inherit the source clip's duration, aspect ratio, and
    // resolution; those generation controls are invalid on /videos/edits.
    return {
      endpoint: `${XAI_VIDEOS_BASE_URL}/edits`,
      operation: "edit",
      model,
      payload: { model, prompt: params.prompt.trim(), video: { url: params.source_video } },
    };
  }
  if (hasSourceImage) {
    return {
      endpoint: `${XAI_VIDEOS_BASE_URL}/generations`,
      operation: "image-to-video",
      model,
      payload: { ...base, image: { url: params.source_image } },
    };
  }
  if (hasReferences) {
    const references = params.reference_images!;
    if (references.length > MAX_REFERENCES) {
      throw new Error(`Director accepts at most ${MAX_REFERENCES} reference images.`);
    }
    return {
      endpoint: `${XAI_VIDEOS_BASE_URL}/generations`,
      operation: "reference-to-video",
      model,
      payload: { ...base, reference_images: references.map((url) => ({ url })) },
    };
  }
  return {
    endpoint: `${XAI_VIDEOS_BASE_URL}/generations`,
    operation: "generate",
    model,
    payload: base,
  };
}

/** Loads local media into data URLs; HTTPS URLs are passed through unchanged. */
export async function loadMedia(input: string, cwd: string, kind: "image" | "video"): Promise<MediaInput> {
  if (/^https:\/\//i.test(input)) return { path: input, url: input };
  const path = isAbsolute(input) ? input : resolve(cwd, input);
  const mimeTypes = kind === "image" ? IMAGE_MIME_TYPES : VIDEO_MIME_TYPES;
  const mimeType = mimeTypes[extname(path).toLowerCase()];
  if (!mimeType) {
    const supported = Object.values(kind === "image" ? IMAGE_MIME_TYPES : VIDEO_MIME_TYPES).join(", ");
    throw new Error(`Unsupported ${kind} '${input}'. Use ${supported}.`);
  }
  const bytes = await readFile(path);
  return { path, url: `data:${mimeType};base64,${bytes.toString("base64")}` };
}

async function pollVideo(
  requestId: string,
  auth: { apiKey: string; headers?: ProviderHeaders },
  signal: AbortSignal,
  fetchImpl: typeof fetch,
  pollIntervalMs: number,
): Promise<{ status: string; video?: { url?: string } }> {
  const pollHeaders = directorHeaders(auth.apiKey, auth.headers);
  delete pollHeaders["Content-Type"];
  for (;;) {
    signal.throwIfAborted();
    const response = await fetchImpl(`${XAI_VIDEOS_BASE_URL}/${encodeURIComponent(requestId)}`, {
      method: "GET",
      signal,
      headers: pollHeaders,
    });
    if (!response.ok) throw new Error(await responseError(response));
    const body = await response.json() as { status?: string; video?: { url?: string }; error?: { message?: string } };
    const status = body.status ?? "unknown";
    if (body.error?.message) throw new Error(`Director failed: ${body.error.message}`);
    if (/^(failed|error|expired|cancelled)$/i.test(status)) {
      throw new Error(`Director failed: xAI reported status "${status}".`);
    }
    if (/^done$/i.test(status)) return { status, video: body.video };
    await delay(pollIntervalMs, signal);
  }
}

async function downloadVideo(
  url: string,
  outputRoot: string,
  toolCallId: string,
  signal: AbortSignal,
  fetchImpl: typeof fetch,
): Promise<string> {
  const response = await fetchImpl(url, { method: "GET", signal, headers: { "User-Agent": "Pi/director" } });
  if (!response.ok) throw new Error(`Director could not download the video: ${response.status} ${response.statusText}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length === 0) throw new Error("Director downloaded an empty video file.");
  const directory = join(outputRoot, new Date().toISOString().slice(0, 10));
  await mkdir(directory, { recursive: true });
  const path = join(directory, `${safeName(toolCallId)}-${randomUUID().slice(0, 8)}.mp4`);
  const temporary = `${path}.tmp`;
  await writeFile(temporary, bytes, { flag: "wx" });
  await rename(temporary, path);
  return path;
}

function operationFor(params: DirectorParams): { label: string } {
  try {
    return { label: planRequest(params).operation };
  } catch {
    return { label: "video" };
  }
}

function safeName(value: string): string {
  return basename(value).replace(/[^a-zA-Z0-9_-]/g, "_") || "video";
}

async function responseError(response: Response): Promise<string> {
  let message = `Director request failed: ${response.status} ${response.statusText}`;
  try {
    const body = await response.json() as { error?: { message?: string } };
    if (body.error?.message) message = body.error.message;
  } catch { /* Keep the HTTP error. */ }
  return message;
}

function delay(milliseconds: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolveDelay, rejectDelay) => {
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolveDelay();
    }, milliseconds);
    const onAbort = () => {
      clearTimeout(timer);
      rejectDelay(signal.reason instanceof Error ? signal.reason : new Error("Director was aborted."));
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

function timeoutSignal(parent: AbortSignal | undefined, milliseconds: number): { signal: AbortSignal; dispose: () => void } {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error("Director timed out after 10 minutes.")), milliseconds);
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
