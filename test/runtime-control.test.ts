import assert from "node:assert/strict";
import { test } from "node:test";
import { applyEvent } from "../src/runtime/state.ts";
import {
  ZERO_USAGE,
  type BatchResult,
  type InvocationResult,
  type InvocationRecord,
  isPromotedReceipt,
  type PromotedBatchReceipt,
} from "../src/runtime/types.ts";
import type { AgentRole, AgentsConfig } from "../src/config/agents.ts";
import { SubagentRuntime } from "../src/runtime/runtime.ts";

type FakeInvocation = {
  signal: AbortSignal;
  release: (patch?: { status?: "complete" | "cancelled"; error?: string }) => void;
};

/**
 * A runtime whose invocations park until the test releases them. Each stubbed
 * runInvocation records queued/running/finished state so the real batch
 * aggregation, redelivery, and result-merge machinery runs end to end.
 */
function fakeRuntime(events: unknown[]): { runtime: SubagentRuntime; launches: FakeInvocation[][] } {
  const runtime = validationRuntime(events);
  const launches: FakeInvocation[][] = [];
  const batchOrder: string[] = [];
  (runtime as any).runInvocation = (request: any, context: any, requestIndex: number, signal?: AbortSignal) => {
    let launchIndex = batchOrder.indexOf(context.batchId);
    if (launchIndex < 0) {
      launchIndex = batchOrder.length;
      batchOrder.push(context.batchId);
      launches.push([]);
    }
    const id = `inv-${launchIndex}-${requestIndex}`;
    const invocation: InvocationRecord = {
      id,
      batchId: context.batchId,
      agent: `atlas-${requestIndex + 1}`,
      role: "Atlas",
      task: request.task,
      followup: false,
      ordinal: 1,
      depth: context.depth + 1,
      status: "queued",
      queuedAt: Date.now(),
      timeoutMinutes: 10,
      usage: { ...ZERO_USAGE },
    };
    applyEvent(runtime.state, { type: "invocation.queued", invocation });
    applyEvent(runtime.state, { type: "invocation.running", id, startedAt: Date.now(), usageBaseline: { ...ZERO_USAGE } });
    return new Promise<any>((resolve) => {
      launches[launchIndex]![requestIndex] = {
        signal: signal ?? new AbortController().signal,
        release: (patch = {}) => {
          const status = patch.status ?? "complete";
          applyEvent(runtime.state, {
            type: "invocation.finished",
            id,
            status,
            finishedAt: Date.now(),
            usage: { ...ZERO_USAGE },
            ...(patch.error === undefined ? {} : { error: patch.error }),
          });
          resolve({
            invocationId: id,
            agent: invocation.agent,
            role: "Atlas",
            status,
            durationMs: 1,
            output: status === "complete" ? "done" : undefined,
            ...(patch.error === undefined ? {} : { error: patch.error }),
            usage: { ...ZERO_USAGE },
          });
        },
      };
    });
  };
  return { runtime, launches };
}

test("follow-up validation is atomic and queue receipts preserve FIFO task ids", async () => {
  const runtime = validationRuntime([]);
  runtime.state.agents.set("atlas-1", { handle: "atlas-1", role: "Atlas", sessionFile: "/tmp/atlas", createdAt: 1 });
  const requests = [{ agent: "atlas-1", messages: [{ message: "first" }, { message: "second" }] }];
  assert.throws(() => runtime.submitFollowups([
    ...requests,
    { agent: "missing", messages: [{ message: "must not partially accept" }] },
  ]), /Unknown agent handle/);
  assert.equal(runtime.followupTasks.size, 0, "invalid grouped submissions accept nothing");

  const seen: string[] = [];
  (runtime as any).runInvocation = async (request: any): Promise<InvocationResult> => {
    seen.push(request.messages[0].message);
    return { invocationId: `inv-${seen.length}`, agent: "atlas-1", role: "Atlas", status: "complete", durationMs: 1, usage: { ...ZERO_USAGE } };
  };
  const receipts = runtime.submitFollowups(requests);
  assert.deepEqual(receipts.followups.map((receipt) => receipt.state), ["queued", "queued"]);
  assert.notEqual(receipts.followups[0]!.id, receipts.followups[1]!.id);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(seen, ["first", "second"], "queued messages run FIFO on one handle");
  assert.deepEqual([...runtime.followupTasks.values()].map((task) => task.state), ["consumed", "consumed"]);

  const cancellationRuntime = validationRuntime([]);
  cancellationRuntime.state.agents.set("atlas-1", { handle: "atlas-1", role: "Atlas", sessionFile: "/tmp/atlas", createdAt: 1 });
  let release!: () => void;
  (cancellationRuntime as any).runInvocation = () => new Promise((resolve) => {
    release = () => resolve({ invocationId: "running", agent: "atlas-1", role: "Atlas", status: "complete", durationMs: 1, usage: { ...ZERO_USAGE } });
  });
  const pending = cancellationRuntime.submitFollowups([{ agent: "atlas-1", messages: [{ message: "running" }, { message: "pending" }] }]);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(cancellationRuntime.cancelAgent("atlas-1"), true, "agent cancellation clears pending queue work");
  assert.equal(cancellationRuntime.followupTasks.get(pending.followups[1]!.id)?.status, "rejected");
  release();
  await new Promise((resolve) => setImmediate(resolve));
});

test("mixed fresh and invalid steering validates before accepting anything", () => {
  const runtime = validationRuntime([]);
  runtime.state.agents.set("atlas-1", { handle: "atlas-1", role: "Atlas", sessionFile: "/tmp/atlas", createdAt: 1 });
  assert.throws(() => runtime.validateSubmission([
    { role: "Atlas", task: "fresh" },
    { agent: "atlas-1", messages: [{ message: "idle steer", delivery: "steer" }] },
  ]), /Cannot steer idle/);
  assert.equal(runtime.followupTasks.size, 0);
  assert.equal(runtime.state.invocations.size, 0);
});

test("queued follow-ups wait for queued/running invocation state before draining", async () => {
  const runtime = validationRuntime([]);
  runtime.state.agents.set("atlas-1", { handle: "atlas-1", role: "Atlas", sessionFile: "/tmp/atlas", createdAt: 1 });
  const running: InvocationRecord = { id: "busy", batchId: "batch-live", agent: "atlas-1", role: "Atlas", task: "busy", followup: false, ordinal: 1, depth: 0, status: "queued", queuedAt: 1, timeoutMinutes: 10, usage: { ...ZERO_USAGE } };
  runtime.state.invocations.set(running.id, running);
  const seen: string[] = [];
  (runtime as any).runInvocation = async (request: any) => {
    seen.push(request.messages[0].message);
    return { invocationId: "queued-result", agent: "atlas-1", role: "Atlas", status: "complete", durationMs: 1, output: "ordered", usage: { ...ZERO_USAGE } };
  };
  const submission = runtime.submitFollowups([{ agent: "atlas-1", messages: [{ message: "after busy" }] }]);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(seen, [], "scheduler-queued work cannot overlap the existing invocation");
  running.status = "complete";
  running.finishedAt = Date.now();
  applyEvent(runtime.state, { type: "invocation.finished", id: running.id, status: "complete", finishedAt: running.finishedAt, usage: { ...ZERO_USAGE } });
  await (SubagentRuntime.prototype as any).drainFollowupQueue.call(runtime, "atlas-1");
  assert.deepEqual(seen, ["after busy"], "the queued context runs only after the prior invocation settles");
  const settled = await submission.completion!;
  assert.equal(settled.runs[0]!.output, "ordered");
});

test("queued root outcomes keep a distinct detached ledger batch and deliver once", async () => {
  const runtime = validationRuntime([]);
  runtime.state.agents.set("atlas-1", { handle: "atlas-1", role: "Atlas", sessionFile: "/tmp/atlas", createdAt: 1 });
  const deliveries: any[] = [];
  runtime.options.deliverQueuedBatch = (launch) => deliveries.push(launch);
  (runtime as any).runInvocation = async () => ({ invocationId: "queued-result", agent: "atlas-1", role: "Atlas", status: "complete", durationMs: 1, output: "delivered", usage: { ...ZERO_USAGE } });
  const submission = runtime.submitFollowups([{ agent: "atlas-1", messages: [{ message: "deliver me" }] }], undefined, true);
  const result = await submission.completion!;
  assert.equal(deliveries.length, 1);
  assert.equal(deliveries[0]!.batchId, result.batchId);
  assert.equal(runtime.state.batches.get(result.batchId)?.detached, true);
  assert.equal(result.runs[0]!.output, "delivered");
});

test("disabling a role rejects pending queue work but lets consumed work finish", async () => {
  const runtime = validationRuntime([]);
  runtime.state.agents.set("atlas-1", { handle: "atlas-1", role: "Atlas", sessionFile: "/tmp/atlas", createdAt: 1 });
  let release!: () => void;
  (runtime as any).runInvocation = () => new Promise((resolve) => {
    release = () => resolve({ invocationId: "running", agent: "atlas-1", role: "Atlas", status: "complete", durationMs: 1, usage: { ...ZERO_USAGE } });
  });
  const submission = runtime.submitFollowups([{ agent: "atlas-1", messages: [{ message: "running" }, { message: "pending" }] }]);
  await new Promise((resolve) => setImmediate(resolve));
  const ids = submission.followups.map((item) => item.id);
  runtime.setDisabledRoles(["Atlas"]);
  assert.equal(runtime.followupTasks.get(ids[1]!)?.status, "rejected");
  assert.equal(runtime.followupTasks.get(ids[0]!)?.status, "accepted");
  release();
  const result = await submission.completion!;
  assert.equal(result.runs.length, 2);
});

test("batch and all cancellation settle pending queue ownership without swallowing outcomes", async () => {
  const runtime = validationRuntime([]);
  runtime.state.agents.set("atlas-1", { handle: "atlas-1", role: "Atlas", sessionFile: "/tmp/atlas", createdAt: 1 });
  const releases: Array<() => void> = [];
  (runtime as any).runInvocation = () => new Promise((resolve) => {
    releases.push(() => resolve({ invocationId: `queued-${releases.length}`, agent: "atlas-1", role: "Atlas", status: "complete", durationMs: 1, usage: { ...ZERO_USAGE } }));
  });
  const first = runtime.submitFollowups([{ agent: "atlas-1", messages: [{ message: "first" }, { message: "second" }] }]);
  const batchId = [...runtime.state.batches.keys()][0]!;
  assert.equal((runtime.controlAction({ action: "cancel", target: { batch: batchId } }) as any).status, "cancelled");
  releases[0]!();
  const firstResult = await first.completion!;
  assert.deepEqual(firstResult.runs.map((run) => run.status), ["complete", "cancelled"]);

  const second = runtime.submitFollowups([{ agent: "atlas-1", messages: [{ message: "third" }, { message: "fourth" }] }]);
  assert.equal((runtime.controlAction({ action: "cancel", target: { all: true } }) as any).status, "cancelled");
  releases[1]!();
  const secondResult = await second.completion!;
  assert.deepEqual(secondResult.runs.map((run) => run.status), ["complete", "cancelled"]);
});

test("steering uses the live child session, rejects idle children, and does not change timeout", () => {
  const runtime = validationRuntime([]);
  runtime.state.agents.set("atlas-1", { handle: "atlas-1", role: "Atlas", sessionFile: "/tmp/atlas", createdAt: 1 });
  let steered = "";
  const live = {
    isStreaming: true,
    steer: async (message: string) => { steered = message; },
    followUp: async () => {},
    pendingMessageCount: 0,
    getSteeringMessages: () => [],
    getFollowUpMessages: () => [],
    clearQueue: () => ({ steering: [], followUp: [] }),
  };
  runtime.liveSessions.set("atlas-1", live as any);
  const result = runtime.submitFollowups([{ agent: "atlas-1", messages: [{ message: "stop after command", delivery: "steer" }] }]);
  assert.equal(result.followups[0]!.status, "accepted");
  assert.equal(result.followups[0]!.state, "steering");
  assert.equal(steered, "stop after command");
  assert.throws(() => runtime.submitFollowups([{ agent: "atlas-1", timeoutMinutes: 3, messages: [{ message: "no timeout", delivery: "steer" }] }]), /cannot change timeoutMinutes/);
  runtime.liveSessions.delete("atlas-1");
  assert.throws(() => runtime.submitFollowups([{ agent: "atlas-1", messages: [{ message: "idle", delivery: "steer" }] }]), /Cannot steer idle/);
});

test("inspection is bounded, non-interrupting, and excludes raw tool payloads", (t) => {
  let now = 120_002;
  t.mock.method(Date, "now", () => now);
  const runtime = validationRuntime([]);
  runtime.state.agents.set("atlas-1", { handle: "atlas-1", role: "Atlas", sessionFile: "/tmp/atlas", createdAt: 1 });
  const invocation: InvocationRecord = {
    id: "inspect-inv", batchId: "batch-1", agent: "atlas-1", role: "Atlas",
    task: "A bounded task preview that should be truncated rather than exposing arbitrary payloads.",
    followup: false, ordinal: 1, depth: 0, status: "running", queuedAt: 1, startedAt: 2,
    timeoutMinutes: 10, usage: { ...ZERO_USAGE },
  };
  runtime.state.invocations.set(invocation.id, invocation);
  runtime.state.batches.set("batch-1", { id: "batch-1", createdAt: 1 });
  (runtime as any).activities.set(invocation.id, { invocationId: invocation.id, tool: "read", detail: "responding" });
  const controller = new AbortController();
  (runtime as any).agentCancels.set("atlas-1", controller);
  const result = runtime.controlAction({ action: "inspect", target: { all: true } });
  assert.equal(result.action, "inspect");
  assert.equal(result.agents.length, 1);
  assert.equal(result.agents[0]!.activity?.tool, "read");
  assert.ok((result.agents[0]!.taskPreview?.length ?? 0) <= 120);
  assert.ok(result.agents[0]!.pendingSteering.length === 0);
  assert.ok(!JSON.stringify(result).includes("tool_arguments"));
  assert.equal(controller.signal.aborted, false, "inspection never interrupts work");
  assert.equal(result.agents[0]!.elapsedMs, 120_000);
  assert.equal(result.batches[0]!.elapsedMs, 120_000);
  const internals = runtime as unknown as {
    activeToolCalls: Map<string, Map<string, string>>;
    toolExecutions: Map<string, Map<string, { toolName: string; args: unknown }>>;
  };
  internals.activeToolCalls.set(invocation.id, new Map([["call-1", "read"]]));
  internals.toolExecutions.set("atlas-1", new Map([["call-1", {
    toolName: "read", args: { path: "src/" + "long-path/".repeat(20), unrelated: "DO_NOT_EXPOSE" },
  }]]));
  const active = runtime.controlAction({ action: "inspect", target: { agent: "atlas-1" } });
  assert.equal(active.action, "inspect");
  assert.match(active.agents[0]!.activity!.detail!, /^src\/long-path/);
  assert.ok(active.agents[0]!.activity!.detail!.length <= 80);
  assert.ok(!JSON.stringify(active).includes("DO_NOT_EXPOSE"));
  invocation.status = "complete";
  invocation.finishedAt = 180_002;
  now = 600_002;
  const settled = runtime.controlAction({ action: "inspect", target: { all: true } });
  assert.equal(settled.action, "inspect");
  assert.equal(settled.agents[0]!.elapsedMs, 180_000, "completed agent duration is frozen");
  assert.equal(settled.batches[0]!.elapsedMs, 180_000, "settled batch duration is frozen");
  assert.equal(settled.batches[0]!.status, "settled");
});

test("nested control ownership and disabled-role controls remain enforced", () => {
  const runtime = validationRuntime([]);
  runtime.state.agents.set("parent-1", { handle: "parent-1", role: "Atlas", sessionFile: "/tmp/parent", createdAt: 1 });
  runtime.state.agents.set("owned-1", { handle: "owned-1", role: "Atlas", sessionFile: "/tmp/owned", createdAt: 2 });
  runtime.state.agents.set("foreign-1", { handle: "foreign-1", role: "Atlas", sessionFile: "/tmp/foreign", createdAt: 3 });
  const parent: InvocationRecord = { id: "parent", batchId: "batch", agent: "parent-1", role: "Atlas", task: "parent", followup: false, ordinal: 1, depth: 0, status: "running", queuedAt: 1, timeoutMinutes: 10, usage: { ...ZERO_USAGE } };
  const owned: InvocationRecord = { id: "owned", batchId: "batch", agent: "owned-1", role: "Atlas", task: "owned", followup: true, ordinal: 1, depth: 1, parentInvocationId: "parent", status: "running", queuedAt: 2, timeoutMinutes: 10, usage: { ...ZERO_USAGE } };
  const foreign: InvocationRecord = { id: "foreign", batchId: "batch", agent: "foreign-1", role: "Atlas", task: "foreign", followup: true, ordinal: 1, depth: 1, parentInvocationId: "other", status: "running", queuedAt: 3, timeoutMinutes: 10, usage: { ...ZERO_USAGE } };
  runtime.state.invocations.set(parent.id, parent);
  runtime.state.invocations.set(owned.id, owned);
  runtime.state.invocations.set(foreign.id, foreign);
  assert.equal((runtime.controlAction({ action: "inspect", target: { all: true } }, "parent-1") as any).agents.length, 1);
  assert.throws(() => runtime.controlAction({ action: "inspect", target: { agent: "foreign-1" } }, "parent-1"), /only control agents it spawned/);
  runtime.setDisabledRoles(["Atlas"]);
  assert.equal(runtime.controlAction({ action: "inspect", target: { agent: "owned-1" } }).action, "inspect");
  assert.equal((runtime.controlAction({ action: "cancel", target: { agent: "owned-1" } }) as any).status, "not-found", "disabled roles do not disable root controls");
});

test("promotion detaches a running foreground batch, releases the sync wait with a receipt, and keeps the completion machinery", async () => {
  const events: any[] = [];
  const { runtime, launches } = fakeRuntime(events);
  const pending = runtime.runRootBatch([{ role: "Atlas", task: "First" }, { role: "Atlas", task: "Second" }]);
  assert.equal(launches[0]!.length, 2, "both child invocations are running");
  assert.deepEqual(runtime.promotableRootBatches(), [{ batchId: "batch-1", agentCount: 2, promoted: false }]);

  const promotion = runtime.promoteRootBatch("batch-1");
  assert.equal(promotion.status, "promoted");

  const receipt = (await pending) as PromotedBatchReceipt;
  assert.deepEqual(receipt, { promoted: true, batchId: "batch-1", agentCount: 2 }, "the synchronous wait resolves with a receipt");
  assert.equal(isPromotedReceipt(receipt), true);

  assert.equal(runtime.state.batches.get("batch-1")?.detached, true, "the batch record is marked detached");
  assert.ok(events.some((event) => event.type === "batch.promoted" && event.batchId === "batch-1"), "promotion persists");
  assert.deepEqual(runtime.promotableRootBatches(), [{ batchId: "batch-1", agentCount: 2, promoted: true }]);

  // The promoted batch stays cancellable by id and its completion still aggregates every run.
  assert.equal(runtime.cancelRootBatch("batch-1"), true);
  launches[0]!.forEach((invocation) => invocation.release({ status: "cancelled", error: "Background batch cancelled by the parent session." }));
  const result = (await promotion.launch.completion) as BatchResult;
  assert.equal(result.batchId, "batch-1");
  assert.equal(result.runs.length, 2);
  assert.ok(result.runs.every((run) => run.status === "cancelled"));
  assert.equal(runtime.cancelRootBatch("batch-1"), false, "settled batches drop out of the cancel map");
  assert.deepEqual(runtime.promotableRootBatches(), [], "settled batches leave the promotion list");

  const redeliverable = runtime.settledDetachedBatches();
  assert.deepEqual(redeliverable.map((entry) => entry.batchId), ["batch-1"], "promoted batches flow through the settled redelivery machinery");
  assert.deepEqual(redeliverable[0]!.result.runs.map((run) => run.status), ["cancelled", "cancelled"]);
});

test("a caller abort after promotion does not cancel the promoted batch", async () => {
  const { runtime, launches } = fakeRuntime([]);
  const caller = new AbortController();
  const pending = runtime.runRootBatch([{ role: "Atlas", task: "Long work" }], caller.signal);
  const promotion = runtime.promoteRootBatch("batch-1");
  assert.equal(promotion.status, "promoted");
  assert.equal((await pending as PromotedBatchReceipt).promoted, true);

  caller.abort(new Error("parent turn stopped"));
  assert.equal(launches[0]![0]!.signal.aborted, false, "the child invocation signal is untouched after promotion");

  launches[0]![0]!.release();
  const result = (await promotion.launch.completion) as BatchResult;
  assert.equal(result.runs[0]!.status, "complete", "promoted work finishes instead of orphaning");
  assert.deepEqual(runtime.settledDetachedBatches().map((entry) => entry.batchId), ["batch-1"], "the finished promoted batch is delivered once");
});

test("a caller abort before promotion still cancels the foreground batch normally", async () => {
  const { runtime, launches } = fakeRuntime([]);
  const caller = new AbortController();
  const pending = runtime.runRootBatch([{ role: "Atlas", task: "Sync" }], caller.signal);
  assert.ok(runtime.promotableRootBatches()[0], "the foreground batch is promotable while running");

  caller.abort(new Error("parent turn stopped"));
  assert.equal(launches[0]![0]!.signal.aborted, true, "an unpromoted foreground batch honours the caller signal");
  launches[0]![0]!.release({ status: "cancelled", error: "Cancelled by the parent session." });
  const result = (await pending) as BatchResult;
  assert.equal(isPromotedReceipt(result), false);
  assert.equal(result.runs[0]!.status, "cancelled");
  assert.deepEqual(runtime.settledDetachedBatches(), [], "a cancelled foreground batch is not redelivered as background work");
});

test("promoting during caller cancellation releases the waiter and delivers the cancelled result exactly once", async () => {
  const events: any[] = [];
  const { runtime, launches } = fakeRuntime(events);
  const caller = new AbortController();
  const pending = runtime.runRootBatch([{ role: "Atlas", task: "Racing" }], caller.signal);
  caller.abort(new Error("parent turn stopped"));
  assert.equal(launches[0]![0]!.signal.aborted, true, "the abort itself lands before promotion");

  const promotion = runtime.promoteRootBatch("batch-1");
  assert.equal(promotion.status, "promoted", "promotion during cancellation detaches the aborting caller");
  const receipt = (await pending) as PromotedBatchReceipt;
  assert.equal(receipt.promoted, true);

  launches[0]![0]!.release({ status: "cancelled", error: "Cancelled by the parent session." });
  const result = (await promotion.launch.completion) as BatchResult;
  assert.equal(result.runs[0]!.status, "cancelled", "the cancelled batch still settles into the background path");
  assert.deepEqual(runtime.settledDetachedBatches().map((entry) => entry.batchId), ["batch-1"], "exactly one redeliverable outcome");
});

test("promoting after the batch settled is refused as settled and never double-delivers", async () => {
  const events: any[] = [];
  const { runtime, launches } = fakeRuntime(events);
  const pending = runtime.runRootBatch([{ role: "Atlas", task: "Quick" }]);
  launches[0]![0]!.release();
  const result = (await pending) as BatchResult;
  assert.equal(isPromotedReceipt(result), false, "an unpromoted batch resolves with its full result");
  const batchId = result.batchId;

  const promotion = runtime.promoteRootBatch(batchId);
  assert.deepEqual(promotion, { status: "settled", batchId });
  assert.equal(runtime.state.batches.get(batchId)?.detached, undefined, "settled foreground batches are never marked detached");
  assert.deepEqual(runtime.settledDetachedBatches(), [], "no follow-up redelivery for results the caller already received");
  assert.ok(!events.some((event) => event.type === "batch.promoted"), "no promotion event is recorded for a settled batch");
});

test("promotion and completion races cannot double-settle or orphan work", async () => {
  const { runtime, launches } = fakeRuntime([]);
  const pending = runtime.runRootBatch([{ role: "Atlas", task: "Racy" }]);
  const promotion = runtime.promoteRootBatch("batch-1");
  assert.equal(promotion.status, "promoted");
  assert.equal((await pending as PromotedBatchReceipt).promoted, true);

  launches[0]![0]!.release();
  const background = (await promotion.launch.completion) as BatchResult;
  assert.equal(background.runs[0]!.status, "complete", "promoted work settles with a full result instead of orphaning");

  assert.equal(runtime.promoteRootBatch("batch-1").status, "not-found", "a promoted-and-settled batch is no longer promotable");
  assert.deepEqual(runtime.settledDetachedBatches().map((entry) => entry.batchId), ["batch-1"], "the settled batch is redeliverable exactly once");
});

test("re-promoting an already promoted batch is idempotent and returns the same launch", async () => {
  const events: any[] = [];
  const { runtime, launches } = fakeRuntime(events);
  void runtime.runRootBatch([{ role: "Atlas", task: "Once" }]);
  const first = runtime.promoteRootBatch("batch-1");
  const second = runtime.promoteRootBatch("batch-1");
  assert.equal(first.status, "promoted");
  assert.equal(second.status, "promoted");
  assert.equal(first.launch, second.launch, "both receipts share the one completion");
  assert.equal(events.filter((event) => event.type === "batch.promoted").length, 1, "promotion is recorded once");
});

test("promoteRootBatch reports not-found for unknown, detached, or non-batch ids", async () => {
  const { runtime, launches } = fakeRuntime([]);
  const launch = runtime.startRootBatch([{ role: "Atlas", task: "Detached" }]);
  assert.equal(runtime.promoteRootBatch(launch.batchId).status, "not-found", "an already-detached batch is not promotable");
  assert.equal(runtime.promoteRootBatch("batch-999").status, "not-found");
  assert.equal(runtime.promoteRootBatch("atlas-1").status, "not-found", "agent handles are not batch ids");
  launches[0]![0]!.release();
  await launch.completion;
});

test("cancelAllRuns stops every live batch and agent exactly once and counts distinct controllers", () => {
  const runtime = validationRuntime([]);
  const first = new AbortController();
  const second = new AbortController();
  const agent = new AbortController();
  const alreadyStopped = new AbortController();
  (runtime as any).batchCancels.set("batch-1", first);
  (runtime as any).batchCancels.set("batch-2", second);
  (runtime as any).agentCancels.set("vigil-1", agent);
  (runtime as any).agentCancels.set("forge-1", alreadyStopped);
  alreadyStopped.abort(new Error("already stopped"));

  assert.equal(runtime.cancelAllRuns(), 3, "already-aborted agents are not counted");
  assert.equal(first.signal.aborted, true);
  assert.equal(second.signal.aborted, true);
  assert.equal(agent.signal.aborted, true);
  assert.equal(runtime.cancelAllRuns(), 0, "a second cancel-all finds nothing live");
});

test("cancelAllRuns settles two detached background batches as cancelled and still redelivers", async () => {
  const { runtime, launches } = fakeRuntime([]);
  const first = runtime.startRootBatch([{ role: "Atlas", task: "one" }]);
  const second = runtime.startRootBatch([{ role: "Atlas", task: "two" }]);
  assert.equal(runtime.cancelAllRuns(), 2);
  assert.equal(launches[0]![0]!.signal.aborted, true);
  assert.equal(launches[1]![0]!.signal.aborted, true);
  launches[0]![0]!.release({ status: "cancelled", error: "Background batch cancelled by the parent session." });
  launches[1]![0]!.release({ status: "cancelled", error: "Background batch cancelled by the parent session." });
  const [firstResult, secondResult] = await Promise.all([first.completion, second.completion]);
  assert.ok(firstResult.runs.every((run) => run.status === "cancelled"));
  assert.ok(secondResult.runs.every((run) => run.status === "cancelled"));
  assert.deepEqual(runtime.settledDetachedBatches().map((entry) => entry.batchId).sort(), [first.batchId, second.batchId], "cancelled background batches still report");
});

test("disabling a role rejects fresh delegations and follow-ups while running invocations finish", async () => {
  const runtime = rolesRuntime();
  runtime.state.agents.set("atlas-1", { handle: "atlas-1", role: "Atlas", sessionFile: "/tmp/atlas", createdAt: 1 });
  runtime.state.agents.set("worker-1", { handle: "worker-1", role: "Worker", sessionFile: "/tmp/worker", createdAt: 2 });
  runtime.setDisabledRoles(["worker"]);

  assert.equal(runtime.isRoleDisabled("WORKER"), true, "membership is case-insensitive");
  assert.equal(runtime.isRoleDisabled("Atlas"), false);
  assert.deepEqual(runtime.activeRoles.map((candidate) => candidate.name), ["Atlas", "Vigil"]);
  assert.deepEqual([...runtime.disabledRoles], ["Worker"]);

  await assert.rejects(
    runtime.runRootBatch([{ role: "Worker", task: "fresh work" }]),
    /Role Worker is disabled in this session/,
  );
  await assert.rejects(
    runtime.runRootBatch([{ agent: "worker-1", messages: [{ message: "follow up" }] }]),
    /Role Worker is disabled in this session/,
  );
  assert.equal(runtime.state.batches.size, 0, "rejected delegations record no batch state");
  assert.equal(runtime.state.invocations.size, 0, "rejected delegations record no invocations");

  // A disable decision does not touch live work: an already-running invocation stays running.
  const running: InvocationRecord = {
    id: "live", batchId: "batch-live", agent: "worker-1", role: "Worker", task: "already started",
    followup: false, ordinal: 1, depth: 1, status: "running", queuedAt: 1, timeoutMinutes: 10,
    usage: { ...ZERO_USAGE },
  };
  applyEvent(runtime.state, { type: "batch.started", batch: { id: "batch-live", createdAt: 1 } });
  applyEvent(runtime.state, { type: "invocation.queued", invocation: running });
  runtime.setDisabledRoles(["Worker"]);
  assert.equal(runtime.state.invocations.get("live")?.status, "running");

  // Re-enabling restores delegation.
  runtime.setDisabledRoles([]);
  assert.deepEqual(runtime.activeRoles.map((candidate) => candidate.name), ["Atlas", "Worker", "Vigil"]);
});

test("all roles disabled is safe: every delegation rejects and no delegate schemas are offered", async () => {
  const runtime = rolesRuntime();
  runtime.setDisabledRoles(["atlas", "WORKER", "vigil"]);

  assert.deepEqual(runtime.activeRoles, []);
  const delegatesFor = (SubagentRuntime.prototype as any).delegateRolesFor.bind(runtime);
  assert.deepEqual(delegatesFor(role("Atlas", ["Worker"]), 1), []);
  assert.deepEqual(delegatesFor(role("Worker", ["Atlas", "Worker"]), 1), []);
  await assert.rejects(runtime.runRootBatch([{ role: "Atlas", task: "any" }]), /disabled in this session/);
  await assert.rejects(runtime.runRootBatch([{ role: "Worker", task: "any" }]), /disabled in this session/);
  assert.equal(runtime.state.invocations.size, 0);
  assert.deepEqual(runtime.settledDetachedBatches(), []);
});

test("future child delegation schemas omit disabled delegates but keep enabled ones", () => {
  const runtime = rolesRuntime();
  const delegatesFor = (SubagentRuntime.prototype as any).delegateRolesFor.bind(runtime);
  assert.deepEqual(delegatesFor(role("Worker", ["Atlas", "Vigil"]), 1).map((candidate: AgentRole) => candidate.name), ["Atlas", "Vigil"]);

  runtime.setDisabledRoles(["vigil"]);
  assert.deepEqual(delegatesFor(role("Worker", ["Atlas", "Vigil"]), 1).map((candidate: AgentRole) => candidate.name), ["Atlas"], "disabled delegates drop from the child schema");
  assert.deepEqual(delegatesFor(role("Atlas", ["Worker"]), 1).map((candidate: AgentRole) => candidate.name), ["Worker"]);

  runtime.setDisabledRoles(["Atlas", "Vigil"]);
  assert.deepEqual(delegatesFor(role("Worker", ["Atlas", "Vigil"]), 1), [], "an all-disabled delegate set injects no subagent tool");
  assert.deepEqual(delegatesFor(role("Worker", ["Atlas", "Vigil"]), 2), [], "delegation is off at max depth regardless");
});

test("nested delegation to a disabled role rejects at launch even from a pre-disable child session", async () => {
  const { runtime, launches } = fakeRolesRuntime([]);
  const lease = {
    suspend: () => {},
    resume: async () => {},
  } as unknown as Parameters<SubagentRuntime["runNestedBatch"]>[2];

  runtime.setDisabledRoles(["Worker"]);
  await assert.rejects(
    runtime.runNestedBatch([{ role: "Worker", task: "nested fresh" }], { batchId: "batch", depth: 1 }, lease),
    /Role Worker is disabled in this session/,
  );
  runtime.state.agents.set("worker-1", { handle: "worker-1", role: "Worker", sessionFile: "/tmp/worker", createdAt: 2 });
  await assert.rejects(
    runtime.runNestedBatch([{ agent: "worker-1", messages: [{ message: "nested follow-up" }] }], { batchId: "batch", depth: 1 }, lease),
    /Role Worker is disabled in this session/,
  );
  assert.equal(runtime.state.invocations.size, 0);

  const nested = runtime.runNestedBatch([{ role: "Atlas", task: "nested enabled" }], { batchId: "batch", depth: 1 }, lease);
  await new Promise((resolve) => setImmediate(resolve));
  assert.ok(launches[0]![0], "the nested invocation starts for enabled roles");
  launches[0]![0]!.release();
  await assert.doesNotReject(nested, "enabled roles still delegate while a sibling role is disabled");
});

/**
 * Same recording stub as {@link fakeRuntime}, over the multi-role config: for
 * nested-delegation and disabled-role enforcement against live batch flow.
 */
function fakeRolesRuntime(events: unknown[]): { runtime: SubagentRuntime; launches: FakeInvocation[][] } {
  const { runtime, launches } = fakeRuntime(events);
  (runtime as any).options.config = {
    path: "/tmp/agents.yaml",
    version: 1,
    defaults: { maxDepth: 2, concurrency: 10, timeoutMinutes: 10 },
    roles: [role("Atlas", ["Worker"]), role("Worker", ["Atlas", "Vigil"]), role("Vigil", [])],
    presets: [],
  };
  (runtime as any).effectiveRoles = (runtime as any).resolveRoles(undefined);
  return { runtime, launches };
}

function role(name: string, delegates: string[]): AgentRole {
  return {
    name,
    description: `${name} role`,
    model: "provider/model",
    thinking: "medium",
    promptPath: "agents/role.md",
    promptFile: "/tmp/role.md",
    tools: ["read"],
    delegates,
    timeoutMinutes: 10,
  };
}

function rolesRuntime(): SubagentRuntime {
  return new SubagentRuntime({
    rootSessionId: "roles-root",
    cwd: "/tmp",
    config: {
      path: "/tmp/agents.yaml",
      version: 1,
      defaults: { maxDepth: 2, concurrency: 10, timeoutMinutes: 10 },
      roles: [role("Atlas", ["Worker"]), role("Worker", ["Atlas", "Vigil"]), role("Vigil", [])],
      presets: [],
    },
    modelRegistry: {} as any,
    appendEvent: () => {},
  });
}

function validationRuntime(events: unknown[]): SubagentRuntime {
  return new SubagentRuntime({
    rootSessionId: "control-root",
    cwd: "/tmp",
    config: {
      path: "/tmp/agents.yaml",
      version: 1,
      defaults: { maxDepth: 2, concurrency: 10, timeoutMinutes: 10 },
      roles: [{
        name: "Atlas",
        description: "Read-only explorer",
        model: "openai-codex/gpt-5.6-luna",
        thinking: "medium",
        promptPath: "agents/atlas.md",
        promptFile: "/tmp/atlas.md",
        tools: ["read", "bash"],
        delegates: [],
        timeoutMinutes: 10,
      }],
      presets: [],
    },
    modelRegistry: {} as any,
    appendEvent: (event) => events.push(event),
  });
}
