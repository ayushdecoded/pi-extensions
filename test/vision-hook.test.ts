import assert from "node:assert/strict";
import { test } from "node:test";
import {
  appendNote,
  createVisionHookExtension,
  type VisionConfig,
} from "../src/runtime/vision-hook.ts";

const TEXT_ONLY = { id: "deepseek-v4-flash", provider: "opencode-go", input: ["text"] };
const VISION = { id: "qwen3.7-plus", provider: "opencode-go", input: ["text", "image"] };

function hookContext(overrides: Record<string, unknown> = {}) {
  return {
    model: TEXT_ONLY,
    modelRegistry: { find: (provider: string, id: string) => ({ ...VISION, id, provider }) },
    cwd: "/tmp",
    signal: undefined,
    ...overrides,
  } as any;
}

function captureHandler(
  vision: VisionConfig,
  describe?: (cwd: string, model: any, images: unknown[], prompt: string) => Promise<unknown>,
  routeModel?: (model: any) => any,
) {
  const handlers: Record<string, (event: any, ctx: any) => unknown> = {};
  const pi = {
    on: (event: string, handler: (event: any, ctx: any) => unknown) => {
      handlers[event] = handler;
    },
  } as any;
  const describeImages = describe ?? (async () => ({
    text: "A red block on white.",
    usage: { input: 50, output: 5, cacheRead: 0, cacheWrite: 0, total: 55, cost: 0.0005 },
  }));
  (createVisionHookExtension(() => vision, describeImages as any, undefined, routeModel) as any)(pi);
  return handlers.tool_result!;
}

const READ_IMAGE = {
  toolName: "read",
  content: [
    { type: "text", text: "Read image file [png]\n/tmp/shot.png" },
    { type: "image", data: "aGVsbG8=", mimeType: "image/png" },
  ],
};

test("vision hook ignores non-read tools and text-only read results", async () => {
  const handler = captureHandler({ sidecar: "opencode-go/qwen3.7-plus" });
  assert.equal(await handler({ toolName: "bash", content: [{ type: "text", text: "ok" }] }, hookContext()), undefined);
  assert.equal(await handler({ toolName: "read", content: [{ type: "text", text: "Read image file [png]" }] }, hookContext()), undefined);
});

test("vision hook passes images through when the model can see them", async () => {
  let ran = false;
  const handler = captureHandler({ sidecar: "opencode-go/qwen3.7-plus" }, async () => {
    ran = true;
    return { text: "", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0, cost: 0 } };
  });
  const result = await handler(READ_IMAGE, hookContext({ model: { ...TEXT_ONLY, input: ["text", "image"] } }));
  assert.equal(result, undefined);
  assert.equal(ran, false);
});

test("vision hook keeps the image and appends a note when no sidecar is configured", async () => {
  const handler = captureHandler({});
  const result = await handler(READ_IMAGE, hookContext());
  assert.deepEqual(result, {
    content: [
      { type: "text", text: "Read image file [png]\n/tmp/shot.png" },
      { type: "image", data: "aGVsbG8=", mimeType: "image/png" },
      {
        type: "text",
        text: "Image reading is disabled: this model cannot see images and no image model is configured.",
      },
    ],
  });
});

test("vision hook runs the sidecar and folds its usage into the read result", async () => {
  let seen: any;
  const handler = captureHandler(
    { sidecar: "opencode-go/qwen3.7-plus" },
    async (cwd, model, images, prompt) => {
      seen = { cwd, model, images, prompt };
      return { text: "A red block on white.", usage: { input: 50, output: 5, cacheRead: 0, cacheWrite: 0, total: 55, cost: 0.0005 } };
    },
    (model) => ({ ...model, provider: "plan:opencode-go:0123456789abcdef" }),
  );
  const readUsage = {
    input: 1,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 1,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
  const result = await handler({ ...READ_IMAGE, usage: readUsage }, hookContext());

  assert.deepEqual(result, {
    content: [
      { type: "text", text: "Read image file [png]\n/tmp/shot.png" },
      { type: "image", data: "aGVsbG8=", mimeType: "image/png" },
      { type: "text", text: "<image analysis>\nA red block on white.\n</image analysis>" },
    ],
    usage: {
      input: 51,
      output: 5,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 56,
      cost: { input: 0.0005, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.0005 },
    },
  });
  assert.equal(seen.model.id, "qwen3.7-plus");
  assert.equal(seen.model.provider, "plan:opencode-go:0123456789abcdef");
  assert.equal(seen.images.length, 1);
  assert.equal(seen.cwd, "/tmp");
  assert.match(seen.prompt, /exhaustively/);
});

test("vision hook reports sidecar failures as a text note", async () => {
  const handler = captureHandler({ sidecar: "opencode-go/qwen3.7-plus" }, async () => {
    throw new Error("provider down");
  });
  const result = await handler(READ_IMAGE, hookContext());
  assert.deepEqual(result, {
    content: [
      { type: "text", text: "Read image file [png]\n/tmp/shot.png" },
      { type: "image", data: "aGVsbG8=", mimeType: "image/png" },
      { type: "text", text: "Image analysis failed: provider down" },
    ],
  });
});

test("appendNote keeps text and image parts and appends the note", () => {
  assert.deepEqual(appendNote([{ type: "text", text: "a" }, { type: "image" }, { type: "text", text: "b" }], "X"), [
    { type: "text", text: "a" },
    { type: "image" },
    { type: "text", text: "b" },
    { type: "text", text: "X" },
  ]);
  assert.deepEqual(appendNote(undefined, "X"), [{ type: "text", text: "X" }]);
});
