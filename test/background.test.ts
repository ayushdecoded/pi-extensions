import assert from "node:assert/strict";
import { test } from "node:test";
import {
  BACKGROUND_SUBAGENT_RESULT_TYPE,
  deliverBackgroundBatchResult,
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
  assert.equal(sent[0]!.message.display, false);
  assert.match(sent[0]!.message.content, /batch-1 · settled/);
  assert.match(sent[0]!.message.content, /Atlas · atlas-1 · complete[\s\S]*evidence/);
  assert.match(sent[0]!.message.content, /Vigil · vigil-1 · failed[\s\S]*timed out/);
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

test("unexpected background batch failures still report back", async () => {
  const sent: Array<{ message: any; options: any }> = [];
  await deliverBackgroundBatchResult(
    { batchId: "broken", completion: Promise.reject(new Error("runtime unavailable")) },
    ((message: any, options: any) => sent.push({ message, options })) as any,
    () => true,
  );
  assert.equal(sent.length, 1);
  assert.match(sent[0]!.message.content, /broken · failed[\s\S]*runtime unavailable/);
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
