import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { buildPrompt, codexHeaders, createPainterTool, loadReferences } from "../src/painter.ts";

const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScL10wAAAABJRU5ErkJggg==", "base64");

function context() {
  const token = `header.${Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "account-1" } })).toString("base64url")}.signature`;
  const model = { provider: "openai-codex", id: "gpt-5.6" };
  return {
    cwd: "/workspace",
    model,
    modelRegistry: {
      getAll: () => [model],
      getApiKeyAndHeaders: async () => ({ ok: true as const, apiKey: token, headers: { "X-Existing": "yes" } }),
    },
  } as any;
}

test("Painter describes UI-preserving edits and supports four variants", () => {
  const tool = createPainterTool();
  const schema = JSON.stringify(tool.parameters);
  assert.match(tool.description, /preserve its visual system/i);
  assert.match(schema, /"high"/);
  assert.match(schema, /"count"/);
  assert.match(schema, /4/);
  assert.match(buildPrompt("Add a billing card", "ui", 1), /authoritative existing-product screenshot/);
  assert.equal(buildPrompt("A red fox", "general", 0), "A red fox");
});

test("Painter sends a Codex OAuth image-edit request and saves every result", async () => {
  const root = await mkdtemp(join(tmpdir(), "painter-"));
  const reference = join(root, "reference.png");
  await writeFile(reference, png);
  let request: Request | undefined;
  const tool = createPainterTool({
    outputRoot: join(root, "out"),
    fetch: async (input, init) => {
      request = new Request(input, init);
      return new Response(JSON.stringify({ data: [{ b64_json: png.toString("base64") }, { b64_json: png.toString("base64") }] }), { status: 200 });
    },
  }) as any;

  const result = await tool.execute("call:1", {
    prompt: "Add an activity panel",
    reference_images: [reference],
    count: 2,
    quality: "high",
    mode: "ui",
  }, undefined, undefined, context());

  assert.equal(request?.url, "https://chatgpt.com/backend-api/codex/images/edits");
  assert.equal(request?.headers.get("ChatGPT-Account-ID"), "account-1");
  assert.equal(request?.headers.get("x-codex-image-turn-id"), "call:1");
  const body = await request?.json() as any;
  assert.equal(body.model, "gpt-image-2");
  assert.equal(body.n, 2);
  assert.equal(body.quality, "high");
  assert.equal(body.images.length, 1);
  assert.match(body.prompt, /Preserve its application shell/);
  assert.equal(result.details.paths.length, 2);
  assert.deepEqual(await readFile(result.details.paths[0]), png);
  assert.equal(result.content.filter((part: any) => part.type === "image").length, 2);
});

test("Painter generates without references and reports useful API errors", async () => {
  let request: Request | undefined;
  const tool = createPainterTool({
    outputRoot: await mkdtemp(join(tmpdir(), "painter-")),
    fetch: async (input, init) => {
      request = new Request(input, init);
      return new Response(JSON.stringify({ error: { code: "moderation_blocked" } }), { status: 400 });
    },
  }) as any;
  await assert.rejects(
    tool.execute("call", { prompt: "A mockup", count: 1 }, undefined, undefined, context()),
    /blocked this request/i,
  );
  assert.equal(request?.url, "https://chatgpt.com/backend-api/codex/images/generations");
});

test("Painter reference loading checks formats and encodes local images", async () => {
  const root = await mkdtemp(join(tmpdir(), "painter-"));
  await writeFile(join(root, "screen.png"), png);
  const references = await loadReferences(["screen.png"], root);
  assert.equal(references[0]?.path, join(root, "screen.png"));
  assert.match(references[0]?.dataUrl ?? "", /^data:image\/png;base64,/);
  await assert.rejects(loadReferences(["screen.svg"], root), /Unsupported reference image/);
});

test("Painter preserves supplied account identity headers", () => {
  const headers = codexHeaders("not-a-jwt", { "chatgpt-account-id": "configured" }, "call");
  assert.equal(headers["chatgpt-account-id"], "configured");
  assert.equal(headers.Authorization, "Bearer not-a-jwt");
});
