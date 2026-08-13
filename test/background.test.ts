import assert from "node:assert/strict";
import { test } from "node:test";
import type { Theme } from "@earendil-works/pi-coding-agent";
import {
  BACKGROUND_SUBAGENT_RESULT_TYPE,
  deliverBackgroundBatchResult,
  renderBackgroundBatchMessage,
  type BackgroundBatchResultDetails,
} from "../src/background.ts";
import { ZERO_USAGE, type BatchResult } from "../src/runtime/types.ts";

test("background batches report once after aggregate completion with follow-up delivery", async () => {
  let resolve!: (result: BatchResult) => void;
  const completion = new Promise<BatchResult>((done) => { resolve = done; });
  const sent: Array<{ message: any; options: any }> = [];
  const delivery = deliverBackgroundBatchResult(
    { batchId: "batch-1", completion },
    ((message: any, options: any) => sent.push({ message, options })) as any,
    () => true,
  );

  await Promise.resolve();
  assert.equal(sent.length, 0, "no partial agent result is delivered");

  const complete = {
    invocationId: "one", agent: "atlas-1", role: "Atlas", status: "complete" as const,
    durationMs: 10, output: "evidence", usage: { ...ZERO_USAGE },
  };
  const failed = {
    invocationId: "two", agent: "vigil-1", role: "Vigil", status: "failed" as const,
    durationMs: 20, error: "timed out", usage: { ...ZERO_USAGE },
  };
  resolve({ batchId: "batch-1", runs: [complete, failed], allRuns: [complete, failed], durationMs: 20 });
  await delivery;

  assert.equal(sent.length, 1);
  assert.equal(sent[0]!.message.customType, BACKGROUND_SUBAGENT_RESULT_TYPE);
  assert.equal(sent[0]!.message.display, true, "the transcript card must be visible");
  assert.match(sent[0]!.message.content, /batch-1 · settled/);
  assert.match(sent[0]!.message.content, /Atlas · atlas-1 · complete[\s\S]*evidence/);
  assert.match(sent[0]!.message.content, /Vigil · vigil-1 · failed[\s\S]*timed out/);
  assert.deepEqual(sent[0]!.message.details, {
    batchId: "batch-1",
    durationMs: 20,
    runs: [
      { role: "Atlas", agent: "atlas-1", status: "complete" },
      { role: "Vigil", agent: "vigil-1", status: "failed", error: "timed out" },
    ],
  });
  assert.deepEqual(sent[0]!.options, { triggerTurn: true, deliverAs: "followUp" });
});

test("background completion is suppressed after its owning runtime is replaced", async () => {
  const result: BatchResult = { batchId: "old", runs: [], allRuns: [], durationMs: 0 };
  const sent: unknown[] = [];
  await deliverBackgroundBatchResult(
    { batchId: "old", completion: Promise.resolve(result) },
    (((message: unknown) => sent.push(message)) as any),
    () => false,
  );
  assert.deepEqual(sent, []);
});

test("background completion resolves its sender at settle time (survives reload)", async () => {
  const result: BatchResult = { batchId: "reloaded", runs: [], allRuns: [], durationMs: 0 };
  const sent: unknown[] = [];
  // The delivery was started by a pre-reload instance; the sender is looked up
  // lazily so a post-reload instance can take it over before the batch settles.
  let current: (message: unknown, options: unknown) => void = () => {
    throw new Error("Extension API context is no longer active");
  };
  const delivery = deliverBackgroundBatchResult(
    { batchId: "reloaded", completion: Promise.resolve(result) },
    (((message: unknown, options: unknown) => current(message, options)) as any),
    () => true,
  );
  current = (message: unknown) => sent.push(message);
  await delivery;

  assert.equal(sent.length, 1);
  assert.equal((sent[0] as { customType?: string }).customType, BACKGROUND_SUBAGENT_RESULT_TYPE);
});

test("unexpected background batch failures still report back", async () => {
  const sent: Array<{ message: any; options: any }> = [];
  await deliverBackgroundBatchResult(
    { batchId: "broken", completion: Promise.reject(new Error("runtime unavailable")) },
    ((message: any, options: any) => sent.push({ message, options })) as any,
    () => true,
  );
  assert.equal(sent.length, 1);
  assert.match(sent[0]!.message.content, /broken · failed[\s\S]*runtime unavailable/);
  assert.deepEqual(sent[0]!.message.details, { batchId: "broken", durationMs: 0, runs: [], error: "runtime unavailable" });
  assert.deepEqual(sent[0]!.options, { triggerTurn: true, deliverAs: "followUp" });
});

test("a session-replacement send race does not reject detached completion", async () => {
  const result: BatchResult = { batchId: "stale", runs: [], allRuns: [], durationMs: 0 };
  await assert.doesNotReject(deliverBackgroundBatchResult(
    { batchId: "stale", completion: Promise.resolve(result) },
    (() => { throw new Error("Extension API context is no longer active"); }) as any,
    () => true,
  ));
});

test("the transcript renderer shows a compact indicator and full outputs when expanded", () => {
  const details: BackgroundBatchResultDetails = {
    batchId: "a3f941e0-1c7b",
    durationMs: 60_000,
    runs: [
      { role: "Atlas", agent: "atlas-1", status: "complete" },
      { role: "Vigil", agent: "vigil-2", status: "failed", error: "timed out" },
    ],
  };
  const theme = { fg: (_color: string, text: string) => text, bg: (_color: string, text: string) => text } as unknown as Theme;
  const collapsed = renderBackgroundBatchMessage(
    { customType: BACKGROUND_SUBAGENT_RESULT_TYPE, content: "[full output]", display: true, details, timestamp: 1 } as any,
    { expanded: false, outputPad: 1 },
    theme,
  )!.render(80).join("\n");
  assert.match(collapsed, /Background subagents.*settled.*a3f941e0/);
  assert.match(collapsed, /1 complete · 1 failed/);
  assert.match(collapsed, /✓ Atlas · atlas-1 · complete/);
  assert.match(collapsed, /✗ Vigil · vigil-2 · failed · timed out/);
  assert.doesNotMatch(collapsed, /\[full output\]/);

  const expanded = renderBackgroundBatchMessage(
    { customType: BACKGROUND_SUBAGENT_RESULT_TYPE, content: "[full output]", display: true, details, timestamp: 1 } as any,
    { expanded: true, outputPad: 1 },
    theme,
  )!.render(80).join("\n");
  assert.match(expanded, /outputs[\s\S]*\[full output\]/);
});
