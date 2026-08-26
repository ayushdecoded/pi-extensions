import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createDirectorTool, directorHeaders, loadMedia, planRequest, resolveXaiAuth } from "../src/director.ts";

const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScL10wAAAABJRU5ErkJggg==", "base64");
const mp4 = Buffer.from("00000018ftypmp42", "utf8");

function context() {
  const model = { provider: "xai", id: "grok-4" };
  return {
    cwd: "/workspace",
    model,
    modelRegistry: {
      getAll: () => [{ provider: "openai-codex", id: "gpt-5.6" }, model],
      getApiKeyAndHeaders: async () => ({ ok: true as const, apiKey: "xai-secret", headers: { "X-Account": "supergrok" } }),
    },
  } as any;
}

/** Fetch mock covering submit, one pending poll, a done poll, and the download. */
function videoPipeline(options: { url?: string } = {}) {
  const requests: Request[] = [];
  const fetchImpl = (async (input: any, init?: any) => {
    const request = new Request(input, init);
    requests.push(request);
    if (request.method === "POST") {
      return new Response(JSON.stringify({ request_id: "req-123" }), { status: 200 });
    }
    if (new URL(request.url).pathname.startsWith("/v1/videos/") && request.method === "GET") {
      const poll = requests.filter((entry) => entry.method === "GET" && new URL(entry.url).pathname.startsWith("/v1/videos/")).length;
      if (poll === 1) {
        return new Response(JSON.stringify({ status: "pending" }), { status: 200 });
      }
      return new Response(JSON.stringify({ status: "done", video: { url: options.url ?? "https://video.x.ai/out.mp4" } }), { status: 200 });
    }
    return new Response(mp4, { status: 200 });
  }) as typeof fetch;
  return { fetchImpl, requests };
}

test("Director routes payloads per media mode and applies defaults", () => {
  const generate = planRequest({ prompt: "A fox in snow" });
  assert.equal(generate.endpoint, "https://api.x.ai/v1/videos/generations");
  assert.equal(generate.operation, "generate");
  assert.equal(generate.payload.model, "grok-imagine-video");
  assert.deepEqual(generate.payload, {
    model: "grok-imagine-video", prompt: "A fox in snow", duration: 5,
    aspect_ratio: "16:9", resolution: "720p",
  });

  const image = planRequest({ prompt: "Make it move", source_image: "https://example.com/in.png" });
  assert.equal(image.operation, "image-to-video");
  assert.equal(image.payload.model, "grok-imagine-video-1.5");
  assert.deepEqual(image.payload.image, { url: "https://example.com/in.png" });

  const references = planRequest({ prompt: "Scene", reference_images: ["a.png", "b.png"], duration: 10 });
  assert.equal(references.operation, "reference-to-video");
  assert.equal(references.payload.model, "grok-imagine-video");
  assert.deepEqual(references.payload.reference_images, [{ url: "a.png" }, { url: "b.png" }]);

  const edit = planRequest({
    prompt: "Add rain",
    source_video: "https://example.com/in.mp4",
    duration: 9,
    aspect_ratio: "9:16",
    resolution: "480p",
  });
  assert.equal(edit.endpoint, "https://api.x.ai/v1/videos/edits");
  assert.equal(edit.operation, "edit");
  assert.deepEqual(edit.payload, {
    model: "grok-imagine-video",
    prompt: "Add rain",
    video: { url: "https://example.com/in.mp4" },
  });

  assert.throws(() => planRequest({ prompt: "x", source_image: "a.png", reference_images: ["b.png"] }), /one media mode/);
  assert.throws(() => planRequest({ prompt: "x", source_video: "v.mp4", source_image: "a.png" }), /one media mode/);
  assert.throws(() => planRequest({ prompt: "x", reference_images: Array.from({ length: 8 }, (_, i) => `${i}.png`) }), /at most 7 reference images/);
  assert.throws(() => planRequest({ prompt: "x", reference_images: ["a.png"], duration: 11 }), /at most 10s/);
});

test("Director runs the async flow end to end and saves the MP4", async () => {
  const root = await mkdtemp(join(tmpdir(), "director-"));
  await writeFile(join(root, "input.png"), png);
  const { fetchImpl, requests } = videoPipeline();
  const tool = createDirectorTool({
    outputRoot: join(root, "out"),
    pollIntervalMs: 1,
    fetch: fetchImpl,
  }) as any;

  const result = await tool.execute("call:1", {
    prompt: "Animate this",
    source_image: join(root, "input.png"),
    duration: 3,
    aspect_ratio: "9:16",
    resolution: "480p",
  }, undefined, undefined, context());

  assert.equal(requests[0]?.method, "POST");
  assert.equal(requests[0]?.url, "https://api.x.ai/v1/videos/generations");
  assert.equal(requests[0]?.headers.get("Authorization"), "Bearer xai-secret");
  assert.equal(requests[0]?.headers.get("User-Agent"), "Pi/director");
  assert.ok(requests[0]?.headers.get("x-idempotency-key"));
  const body = await requests[0]!.json() as any;
  assert.equal(body.model, "grok-imagine-video-1.5");
  assert.match(body.image.url, /^data:image\/png;base64,/);
  assert.equal(body.duration, 3);
  assert.equal(body.aspect_ratio, "9:16");
  assert.equal(body.resolution, "480p");

  const polls = requests.filter((request) => request.method === "GET" && request.url.startsWith("https://api.x.ai/v1/videos/"));
  assert.equal(polls.length, 2);
  for (const poll of polls) {
    assert.match(poll.url, /\/v1\/videos\/req-123$/);
    assert.equal(poll.headers.get("Accept"), "application/json");
  }

  assert.match(result.content[0].text, /Source URL: https:\/\/video\.x\.ai\/out\.mp4/);
  assert.equal(result.details.requestId, "req-123");
  assert.equal(result.details.model, "grok-imagine-video-1.5");
  assert.equal(result.details.operation, "image-to-video");
  assert.match(result.details.outputPath, /generated_videos|out/);
  assert.match(result.details.outputPath, /\.mp4$/);
  assert.deepEqual(await readFile(result.details.outputPath), mp4);
  assert.ok(!result.details.outputPath.endsWith(".tmp"));
});

test("Director reports API errors and failed terminal states", async () => {
  const root = await mkdtemp(join(tmpdir(), "director-"));
  const failing = createDirectorTool({
    outputRoot: join(root, "out"),
    fetch: async () => new Response(JSON.stringify({ error: { message: "prompt rejected" } }), { status: 400 }),
  }) as any;
  await assert.rejects(failing.execute("call", { prompt: "x" }, undefined, undefined, context()), /prompt rejected/);

  let calls = 0;
  const failedStatus = createDirectorTool({
    outputRoot: join(root, "out"),
    pollIntervalMs: 1,
    fetch: async () => {
      calls += 1;
      if (calls === 1) return new Response(JSON.stringify({ request_id: "r" }), { status: 200 });
      return new Response(JSON.stringify({ status: "failed", error: { message: "render crashed" } }), { status: 200 });
    },
  }) as any;
  await assert.rejects(failedStatus.execute("call", { prompt: "x" }, undefined, undefined, context()), /render crashed/);
});

test("Director aborts during polling when the signal fires", async () => {
  const root = await mkdtemp(join(tmpdir(), "director-"));
  const controller = new AbortController();
  let calls = 0;
  const tool = createDirectorTool({
    outputRoot: join(root, "out"),
    pollIntervalMs: 60_000,
    fetch: async (_input, init) => {
      calls += 1;
      if (calls === 1) return new Response(JSON.stringify({ request_id: "r" }), { status: 200 });
      controller.abort();
      init?.signal?.throwIfAborted?.();
      return new Response(JSON.stringify({ status: "pending" }), { status: 200 });
    },
  }) as any;
  await assert.rejects(
    tool.execute("call", { prompt: "x" }, controller.signal, undefined, context()),
    /abort/i,
  );
  assert.ok(calls >= 2);
});

test("Director auth resolves the xai credential and preserves provider headers", async () => {
  const ctx = context();
  ctx.model = { provider: "openai-codex", id: "gpt-5.6" };
  const auth = await resolveXaiAuth(ctx);
  assert.equal(auth.apiKey, "xai-secret");
  const headers = directorHeaders(auth.apiKey, auth.headers);
  assert.equal(headers["X-Account"], "supergrok");
  assert.equal(headers.Authorization, "Bearer xai-secret");
  assert.equal(headers["Content-Type"], "application/json");
  assert.equal(headers["User-Agent"], "Pi/director");
  // An existing Authorization from the provider is never overwritten.
  assert.equal(directorHeaders("other", { Authorization: "Bearer provider" }).Authorization, "Bearer provider");

  const noLogin = {
    cwd: "/workspace",
    modelRegistry: { getAll: () => [{ provider: "openai-codex", id: "gpt-5.6" }] },
  } as any;
  await assert.rejects(resolveXaiAuth(noLogin), /`\/login xai`/);
});

test("Director media loading encodes local files and passes HTTPS through", async () => {
  const root = await mkdtemp(join(tmpdir(), "director-media-"));
  await writeFile(join(root, "clip.mp4"), mp4);
  const image = await loadMedia("https://example.com/a.png", root, "image");
  assert.equal(image.url, "https://example.com/a.png");
  const localVideo = await loadMedia("clip.mp4", root, "video");
  assert.equal(localVideo.url, `data:video/mp4;base64,${mp4.toString("base64")}`);
  await assert.rejects(loadMedia("clip.txt", root, "video"), /Unsupported video/);
});
