import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import assert from "node:assert/strict";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";
import { codexAuthHeaders } from "../src/codex-auth.ts";
import { createVoiceInput, sampleWavLevel, VoiceIndicator, type Recorder, type RecorderHandle } from "../src/voice-input.ts";

const WAV_BYTES = Buffer.from([0x52, 0x49, 0x46, 0x46, 0x00, 0x00, 0x00, 0x00, 0x57, 0x41, 0x56, 0x45]);

function makeJwt(accountId: string): string {
  const enc = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${enc({ alg: "none" })}.${enc({ "https://api.openai.com/auth": { chatgpt_account_id: accountId } })}.sig`;
}

function fakeContext(token: string) {
  const notifications: Array<[string, string | undefined]> = [];
  const pasted: string[] = [];
  const widgets: Array<{ key: string; value: unknown; instance?: Component }> = [];
  const fakeTui = { requestRender: () => undefined } as never;
  const fakeTheme = { fg: (_color: string, text: string) => text } as never;
  let currentInstance: (Component & { dispose?(): void }) | undefined;
  const ctx = {
    mode: "tui",
    model: { provider: "openai-codex" },
    modelRegistry: {
      getAll: () => [{ provider: "openai-codex" }],
      getApiKeyAndHeaders: async () => ({ ok: true, apiKey: token, headers: { "chatgpt-account-id": "acc-123" } }),
    },
    ui: {
      notify: (message: string, type?: "info" | "warning" | "error") => { notifications.push([message, type]); },
      pasteToEditor: (text: string) => { pasted.push(text); },
      setWidget: (key: string, value: unknown) => {
        currentInstance?.dispose?.();
        currentInstance = undefined;
        let instance: Component | undefined;
        if (typeof value === "function") {
          instance = (value as (tui: unknown, theme: unknown) => Component)(fakeTui, fakeTheme);
          currentInstance = instance;
        }
        widgets.push({ key, value, instance });
      },
    },
  } as unknown as ExtensionContext;
  return {
    ctx,
    notifications,
    pasted,
    widgets,
    disposeWidgets: () => currentInstance?.dispose?.(),
  };
}

function fakeRecorder(): { recorder: Recorder; starts: string[]; stops: number[] } {
  const starts: string[] = [];
  const stops: number[] = [];
  let handle: RecorderHandle | undefined;
  return {
    starts,
    stops,
    recorder: {
      start(filePath: string) {
        starts.push(filePath);
        void writeFile(filePath, WAV_BYTES);
        handle = { pid: 4242, wait: async () => undefined };
        return handle;
      },
      async stop(h) {
        stops.push(h.pid);
      },
    },
  };
}

test("codexAuthHeaders builds Bearer/accept headers and derives the account id from the JWT", () => {
  const headers = codexAuthHeaders(makeJwt("acc-jwt"), undefined);
  assert.equal(headers.Authorization, `Bearer ${makeJwt("acc-jwt")}`);
  assert.equal(headers.Accept, "application/json");
  assert.equal(headers["ChatGPT-Account-ID"], "acc-jwt");
});

test("codexAuthHeaders drops null deletion markers and keeps a supplied account header", () => {
  const headers = codexAuthHeaders("not-a-jwt", { "chatgpt-account-id": "configured", "x-remove-me": null });
  assert.equal(headers["chatgpt-account-id"], "configured");
  assert.equal(headers.Authorization, "Bearer not-a-jwt");
  assert.ok(!("x-remove-me" in headers));
});

test("transcribeAudio posts multipart audio to the ChatGPT backend with Codex headers", async () => {
  const token = makeJwt("acc-123");
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fetchImpl = async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    return new Response(JSON.stringify({ text: "hello world" }), { status: 200, headers: { "content-type": "application/json" } });
  };
  const voice = createVoiceInput({ fetch: fetchImpl });
  const { ctx } = fakeContext(token);

  const text = await voice.transcribeAudio(WAV_BYTES, "audio/wav", ctx, "en");

  assert.equal(text, "hello world");
  assert.equal(calls.length, 1);
  const { url, init } = calls[0]!;
  assert.equal(url, "https://chatgpt.com/backend-api/transcribe");
  assert.equal(init.method, "POST");
  const headers = init.headers as Record<string, string>;
  assert.equal(headers.Authorization, `Bearer ${token}`);
  assert.equal(headers["chatgpt-account-id"], "acc-123");
  assert.equal(headers.originator, "Codex Desktop");
  assert.ok(/Codex Desktop\//.test(headers["User-Agent"] ?? ""));
  const form = init.body as FormData;
  assert.ok(form instanceof FormData);
  const file = form.get("file");
  assert.ok(file instanceof Blob);
  assert.equal(file.size, WAV_BYTES.length);
  assert.equal((file as File).name, "recording.wav");
  assert.equal((file as File).type, "audio/wav");
  assert.equal(form.get("language"), "en");
});

test("transcribeAudio rejects without text or with an HTTP error", async () => {
  const token = makeJwt("acc-123");
  const { ctx } = fakeContext(token);

  const empty = createVoiceInput({ fetch: async () => new Response(JSON.stringify({ text: "   " }), { status: 200 }) });
  await assert.rejects(empty.transcribeAudio(WAV_BYTES, "audio/wav", ctx), /no text/);

  const failing = createVoiceInput({ fetch: async () => new Response(JSON.stringify({ error: { message: "voice not available" } }), { status: 403 }) });
  await assert.rejects(failing.transcribeAudio(WAV_BYTES, "audio/wav", ctx), /voice not available/);
});

test("transcribeAudio requires an OpenAI Codex login", async () => {
  const voice = createVoiceInput({ fetch: async () => new Response("{}", { status: 200 }) });
  const ctx = {
    model: { provider: "anthropic" },
    modelRegistry: { getAll: () => [], getApiKeyAndHeaders: async () => ({ ok: false, error: "not signed in" }) },
    ui: { notify: () => undefined, pasteToEditor: () => undefined, setWidget: () => undefined },
  } as never;
  await assert.rejects(voice.transcribeAudio(WAV_BYTES, "audio/wav", ctx), /Codex login/);
});

test("toggle shows a recording widget, swaps to a transcribing widget on stop, and pastes", async () => {
  const token = makeJwt("acc-123");
  const recordDir = await mkdtemp(join(tmpdir(), "pi-voice-test-"));
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fetchImpl = async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    return new Response(JSON.stringify({ text: "fix the flaky test" }), { status: 200 });
  };
  const fake = fakeRecorder();
  const voice = createVoiceInput({ fetch: fetchImpl, recorder: fake.recorder, recordDir });
  const { ctx, notifications, pasted, widgets, disposeWidgets } = fakeContext(token);
  try {
    // Start: recording widget with the wav path; no toast is shown.
    assert.equal(await voice.toggle(ctx), "recording");
    assert.equal(fake.starts.length, 1);
    assert.ok(fake.starts[0]!.endsWith(".wav"));
    assert.equal(notifications.length, 0);
    assert.equal(widgets.length, 1);
    assert.equal(widgets[0]?.key, "voice-input");
    const recording = widgets[0]!.instance as VoiceIndicator;
    assert.ok(recording instanceof VoiceIndicator);
    assert.equal(recording.render(80).length, 1);
    assert.match(recording.render(80)[0] ?? "", /REC/);

    // Stop: the widget switches to transcribing mode (still present), then the
    // transcript is pasted, then the widget is removed.
    assert.equal(await voice.toggle(ctx), "transcribed");
    assert.equal(fake.stops.length, 1);
    assert.equal(fake.stops[0], 4242);
    assert.equal(calls.length, 1);
    assert.equal(pasted.length, 1);
    assert.equal(pasted[0], "fix the flaky test");
    assert.match(notifications.at(-1)?.[0] ?? "", /fix the flaky test/);
    assert.equal(widgets.length, 3);
    assert.match(widgets[1]!.instance!.render(80)[0] ?? "", /Transcribing/);
    assert.equal(widgets[2]?.key, "voice-input");
    assert.equal(widgets[2]?.value, undefined);

    // Recording file and pidfile are cleaned up.
    const pidExists = await readFile(join(recordDir, "pid"), "utf8").then(() => true, () => false);
    assert.equal(pidExists, false);
    const wavExists = await readFile(fake.starts[0]!, "utf8").then(() => true, () => false);
    assert.equal(wavExists, false);

    // State reset: a third toggle starts a fresh recording.
    assert.equal(await voice.toggle(ctx), "recording");
    assert.equal(fake.starts.length, 2);
  } finally {
    disposeWidgets();
    await rm(recordDir, { recursive: true, force: true });
  }
});

test("toggle notifies on failure and resets state", async () => {
  const token = makeJwt("acc-123");
  const recordDir = await mkdtemp(join(tmpdir(), "pi-voice-test-"));
  const fetchImpl = async () => { throw new Error("network down"); };
  const fake = fakeRecorder();
  const voice = createVoiceInput({ fetch: fetchImpl, recorder: fake.recorder, recordDir });
  const { ctx, notifications, pasted, widgets, disposeWidgets } = fakeContext(token);
  try {
    assert.equal(await voice.toggle(ctx), "recording");
    assert.equal(await voice.toggle(ctx), "error");
    assert.equal(pasted.length, 0);
    assert.equal(notifications.at(-1)?.[1], "error");
    assert.match(notifications.at(-1)?.[0] ?? "", /network down/);
    // Widget was swapped to transcribing and then removed even on failure.
    assert.equal(widgets.length, 3);
    assert.equal(widgets[2]?.value, undefined);

    // Next toggle can start again.
    assert.equal(await voice.toggle(ctx), "recording");
    assert.equal(fake.starts.length, 2);
  } finally {
    disposeWidgets();
    await rm(recordDir, { recursive: true, force: true });
  }
});

test("VoiceIndicator recording mode renders an audio-driven waveform", async () => {
  const tui = { requestRender: () => undefined } as never;
  const theme = { fg: (_color: string, text: string) => text } as never;
  const levels: number[] = [];
  const indicator = new VoiceIndicator({
    tui,
    theme,
    mode: "recording",
    filePath: "/tmp/rec.wav",
    startedAt: Date.now() - 65_000,
    sample: async () => levels.shift() ?? 0,
  });
  try {
    levels.push(1);
    await indicator.refresh();
    const loud = indicator.render(80)[0] ?? "";
    assert.match(loud, /REC 01:05/);
    assert.ok(loud.includes("█"));
    levels.push(0);
    await indicator.refresh();
    const quiet = indicator.render(80)[0] ?? "";
    assert.ok(quiet.includes("▁"));
    assert.equal(indicator.render(10).length, 0);
  } finally {
    indicator.dispose();
  }
});

test("VoiceIndicator transcribing mode renders a spinner", () => {
  const tui = { requestRender: () => undefined } as never;
  const theme = { fg: (_color: string, text: string) => text } as never;
  const indicator = new VoiceIndicator({ tui, theme, mode: "transcribing" });
  try {
    const line = indicator.render(80)[0] ?? "";
    assert.match(line, /Transcribing/);
    assert.match(line, /[\u2800-\u28FF]/);
  } finally {
    indicator.dispose();
  }
});

test("sampleWavLevel maps PCM RMS to a 0..1 level", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-voice-level-"));
  try {
    const loud = wavWithSamples(new Int16Array(100).fill(32000));
    const loudPath = join(dir, "loud.wav");
    await writeFile(loudPath, loud);
    assert.ok((await sampleWavLevel(loudPath)) > 0.9);

    const quiet = wavWithSamples(new Int16Array(100));
    const quietPath = join(dir, "quiet.wav");
    await writeFile(quietPath, quiet);
    assert.equal(await sampleWavLevel(quietPath), 0);

    assert.equal(await sampleWavLevel(join(dir, "missing.wav")), 0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

function wavWithSamples(samples: Int16Array): Buffer {
  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + samples.length * 2, 4);
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(48000, 24);
  header.writeUInt32LE(96000, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36);
  header.writeUInt32LE(samples.length * 2, 40);
  return Buffer.concat([header, Buffer.from(samples.buffer)]);
}
