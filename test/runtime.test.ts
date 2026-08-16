import assert from "node:assert/strict";
import { test } from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import { CapacityScheduler } from "../src/runtime/scheduler.ts";
import { advanceStateRevision, applyEvent, emptyRuntimeState, usageDelta } from "../src/runtime/state.ts";
import { ZERO_USAGE, type InvocationRecord } from "../src/runtime/types.ts";
import type { AgentsConfig } from "../src/config/agents.ts";
import type { RoleOverride } from "../src/config/model-overrides.ts";
import {
  SubagentRuntime,
  toolsForRole,
  usageWithPendingAssistant,
} from "../src/runtime/runtime.ts";
import { AgentsPanel, costColor, invocationDuration, renderPanel } from "../src/ui/panel.ts";
import { projectBatches } from "../src/ui/projection.ts";
import { roleColor, stripLeadingRoleNames } from "../src/ui/roles.ts";

test("capacity is global and queued acquisition observes cancellation", async () => {
  const scheduler = new CapacityScheduler(1);
  const first = await scheduler.acquire();
  const controller = new AbortController();
  const queued = scheduler.acquire(controller.signal);
  assert.equal(scheduler.activeCount, 1);
  assert.equal(scheduler.queuedCount, 1);

  controller.abort();
  await assert.rejects(queued, { name: "AbortError" });
  assert.equal(scheduler.queuedCount, 0);
  first.release();
  assert.equal(scheduler.activeCount, 0);
});

test("suspending a parent lease lets nested work use the same slot", async () => {
  const scheduler = new CapacityScheduler(1);
  const parent = await scheduler.acquire();
  parent.suspend();
  const child = await scheduler.acquire();
  assert.equal(scheduler.activeCount, 1);
  child.release();
  await parent.resume();
  assert.equal(scheduler.activeCount, 1);
  parent.release();
  assert.equal(scheduler.activeCount, 0);
});

test("runtime injects the subagent tool only for delegating roles below max depth", () => {
  assert.deepEqual(toolsForRole({ tools: ["read"], delegates: [] }, 1, 2), ["read"]);
  assert.deepEqual(toolsForRole({ tools: ["read", "write"], delegates: ["Atlas"] }, 1, 2), ["read", "write", "subagent"]);
  assert.deepEqual(toolsForRole({ tools: ["read", "write"], delegates: ["Atlas"] }, 2, 2), ["read", "write"]);
});

test("switching the active preset re-resolves roles and notifies subscribers", () => {
  const config = {
    path: "/tmp/agents.yaml",
    version: 1,
    defaults: { maxDepth: 2, concurrency: 10, timeoutMinutes: 10 },
    defaultPreset: "deep",
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
    presets: [
      { name: "deep", roleNames: ["Atlas"], overrides: new Map() },
      {
        name: "light",
        roleNames: ["Atlas"],
        overrides: new Map([["Atlas", { model: "opencode-go/deepseek-v4-flash", thinking: "high" }]]),
      },
    ],
  } as unknown as AgentsConfig;
  const runtime = new SubagentRuntime({
    rootSessionId: "mode-root",
    cwd: "/tmp",
    config,
    modelRegistry: {} as any,
    appendEvent: () => {},
  });
  let updates = 0;
  runtime.subscribe(() => { updates += 1; });
  const resolveRole = (SubagentRuntime.prototype as any).resolveRole.bind(runtime);

  assert.equal(runtime.activeMode, "deep");
  assert.equal(resolveRole("Atlas").model, "openai-codex/gpt-5.6-luna");

  assert.equal(runtime.setActiveMode("LIGHT"), "light");
  assert.equal(runtime.activeMode, "light");
  assert.equal(resolveRole("Atlas").model, "opencode-go/deepseek-v4-flash");
  assert.equal(resolveRole("Atlas").thinking, "high");
  assert.deepEqual(runtime.activeRoles.map((role) => role.name), ["Atlas"]);
  assert.equal(updates, 1);

  // Switching to the already-active mode is a no-op.
  runtime.setActiveMode("light");
  assert.equal(updates, 1);

  assert.throws(() => runtime.setActiveMode("missing"), /Unknown agents preset: missing\./);
});

test("persisted role overrides apply model and thinking and refresh immediately", () => {
  const selected = new Map<string, RoleOverride>([
    ["deep:Atlas", { model: "provider/deep-override", thinking: "max" }],
  ]);
  const runtime = new SubagentRuntime({
    rootSessionId: "override-root",
    cwd: "/tmp",
    config: {
      path: "/tmp/agents.yaml",
      version: 1,
      defaults: { maxDepth: 1, concurrency: 1, timeoutMinutes: 10 },
      defaultPreset: "deep",
      roles: [{
        name: "Atlas", description: "Explore", model: "provider/base", thinking: "medium",
        promptPath: "agents/atlas.md", promptFile: "/tmp/atlas.md", tools: ["read"], delegates: [],
      }],
      presets: [
        { name: "deep", roleNames: ["Atlas"], overrides: new Map([["Atlas", { model: "provider/deep" }]]) },
        { name: "light", roleNames: ["Atlas"], overrides: new Map([["Atlas", { model: "provider/light" }]]) },
      ],
    },
    activeMode: "deep",
    roleOverride: (preset, role) => selected.get(`${preset}:${role}`),
    modelRegistry: {} as any,
    appendEvent: () => {},
  });
  let updates = 0;
  runtime.subscribe(() => { updates += 1; });

  assert.equal(runtime.activeRoles[0]!.model, "provider/deep-override");
  assert.equal(runtime.activeRoles[0]!.thinking, "max");
  runtime.setActiveMode("light");
  assert.equal(runtime.activeRoles[0]!.model, "provider/light");
  assert.equal(runtime.activeRoles[0]!.thinking, "medium", "thinking stays on the preset-applied value");
  selected.set("light:Atlas", { model: "provider/light-override" });
  runtime.refreshRoles();
  assert.equal(runtime.activeRoles[0]!.model, "provider/light-override");
  assert.equal(runtime.activeRoles[0]!.thinking, "medium");
  assert.equal(updates, 2);
});

test("configured timeouts are defaults rather than maximum limits", () => {
  const runtime = validationRuntime([]);
  const atlas = runtime.options.config.roles[0]!;
  const resolveTimeout = (SubagentRuntime.prototype as any).resolveTimeout.bind(runtime);

  assert.equal(resolveTimeout(undefined, { ...atlas, timeoutMinutes: 7 }), 7);
  const globalDefaultRole = { ...atlas };
  delete globalDefaultRole.timeoutMinutes;
  assert.equal(resolveTimeout(undefined, globalDefaultRole), 10);
  assert.equal(resolveTimeout(20, atlas), 20);
  assert.equal(resolveTimeout(3, atlas), 3);
  assert.equal(resolveTimeout(-1, atlas), -1);
});

test("root batches validate every request before recording state or allocating agents", async () => {
  const events: unknown[] = [];
  const runtime = validationRuntime(events);

  await assert.rejects(
    runtime.runRootBatch([
      { role: "Atlas", task: "This request is valid." },
      { role: "Atlas", task: "This request has an invalid timeout.", timeoutMinutes: 0 },
    ]),
    /timeoutMinutes must be -1 or a positive integer/,
  );

  assert.deepEqual(events, []);
  assert.equal(runtime.state.batches.size, 0);
  assert.equal(runtime.state.agents.size, 0);
  assert.equal(runtime.state.invocations.size, 0);
});

test("root batches can return a launch handle before detached completion", async () => {
  const events: any[] = [];
  const runtime = validationRuntime(events);
  let finish!: (result: any) => void;
  const pending = new Promise<any>((resolve) => { finish = resolve; });
  (runtime as any).runBatch = () => pending;

  const launch = runtime.startRootBatch([{ role: "Atlas", task: "Inspect in the background." }]);
  assert.equal(typeof launch.batchId, "string");
  assert.deepEqual(events.map((event) => event.type), ["batch.started", "delegation.started"]);
  let completed = false;
  void launch.completion.then(() => { completed = true; });
  await Promise.resolve();
  assert.equal(completed, false);

  finish({ batchId: launch.batchId, runs: [], allRuns: [], durationMs: 0 });
  const result = await launch.completion;
  assert.equal(result.batchId, launch.batchId);
  assert.deepEqual(result.allRuns, []);
});

test("cancelRootBatch aborts a detached batch and settles it as cancelled", async () => {
  const runtime = validationRuntime([]);
  const pending: Array<{ resolve: (value: any) => void }> = [];
  (runtime as any).runInvocation = (_request: unknown, _context: unknown, _requestIndex: number, signal?: AbortSignal) =>
    new Promise((resolve) => {
      const index = pending.length;
      pending.push({ resolve });
      signal?.addEventListener("abort", () => resolve({
        invocationId: `inv-${index + 1}`,
        agent: `atlas-${index + 1}`,
        role: "Atlas",
        status: "cancelled",
        durationMs: 1,
        error: "Background batch cancelled by the parent session.",
        usage: { ...ZERO_USAGE },
      }));
    });

  const launch = runtime.startRootBatch([
    { role: "Atlas", task: "First" },
    { role: "Atlas", task: "Second" },
  ]);
  assert.equal(pending.length, 2, "both invocations started with the batch signal");
  assert.equal(runtime.cancelRootBatch("unknown-batch"), false, "unknown ids are not cancellable");

  assert.equal(runtime.cancelRootBatch(launch.batchId), true);
  const result = await launch.completion;
  assert.equal(result.runs.length, 2);
  assert.ok(result.runs.every((run) => run.status === "cancelled"), "all agents report cancelled");
  assert.equal(runtime.cancelRootBatch(launch.batchId), false, "settled batches drop out of the cancel map");
});

test("cancelRootBatch is idempotent and a second cancel returns false", async () => {
  const runtime = validationRuntime([]);
  (runtime as any).runInvocation = (_request: unknown, _context: unknown, _requestIndex: number, signal?: AbortSignal) =>
    new Promise((resolve) => {
      signal?.addEventListener("abort", () => resolve({
        invocationId: "inv", agent: "atlas-1", role: "Atlas", status: "cancelled",
        durationMs: 1, usage: { ...ZERO_USAGE },
      }));
    });

  const launch = runtime.startRootBatch([{ role: "Atlas", task: "Only" }]);
  assert.equal(runtime.cancelRootBatch(launch.batchId), true);
  assert.equal(runtime.cancelRootBatch(launch.batchId), false, "already-aborted batches are not re-aborted");
  const result = await launch.completion;
  assert.equal(result.runs[0]!.status, "cancelled");
});

test("root batch ids are session-scoped sequential counters", async () => {
  const runtime = validationRuntime([]);
  (runtime as any).runBatch = () => new Promise(() => {});

  const first = runtime.startRootBatch([{ role: "Atlas", task: "one" }]);
  const second = runtime.startRootBatch([{ role: "Atlas", task: "two" }]);
  const third = runtime.startRootBatch([{ role: "Atlas", task: "three" }]);

  assert.equal(first.batchId, "batch-1");
  assert.equal(second.batchId, "batch-2");
  assert.equal(third.batchId, "batch-3");
  assert.equal(runtime.state.batches.get(first.batchId)?.id, "batch-1");
  assert.equal(typeof runtime.state.batches.get(first.batchId)?.createdAt, "number");
});

test("batch counters resume past ids restored from persisted state", async () => {
  const state = emptyRuntimeState();
  for (let i = 1; i <= 5; i += 1) state.batches.set(`batch-${i}`, { id: `batch-${i}`, createdAt: i });
  state.batches.set("legacy-uuid", { id: "legacy-uuid", createdAt: 6 });
  const seed = validationRuntime([]);
  const runtime = new SubagentRuntime({ ...seed.options, appendEvent: () => {} }, state);
  (runtime as any).runBatch = () => new Promise(() => {});

  const launch = runtime.startRootBatch([{ role: "Atlas", task: "resumed" }]);
  assert.equal(launch.batchId, "batch-6", "the counter continues past restored batch and legacy ids");
});

test("cancelRootTarget stops one agent by handle or a whole batch by id", () => {
  const runtime = validationRuntime([]);
  const agent = new AbortController();
  const batch = new AbortController();
  (runtime as any).agentCancels.set("vigil-1", agent);
  (runtime as any).batchCancels.set("batch-1", batch);

  assert.equal(runtime.cancelRootTarget("vigil-1"), "agent");
  assert.equal(agent.signal.aborted, true);
  assert.equal(batch.signal.aborted, false, "stopping one agent leaves the batch running");

  assert.equal(runtime.cancelRootTarget("vigil-1"), undefined, "an already-stopped agent is not re-aborted");

  assert.equal(runtime.cancelRootTarget("batch-1"), "batch");
  assert.equal(batch.signal.aborted, true);

  assert.equal(runtime.cancelRootTarget("missing"), undefined, "unknown targets are not found");
  assert.equal(runtime.cancelRootTarget("batch-1"), undefined, "settled batches are not re-aborted");
});

test("cancelAgent reports false for unknown or already-settled handles", () => {
  const runtime = validationRuntime([]);
  const controller = new AbortController();
  (runtime as any).agentCancels.set("forge-2", controller);

  assert.equal(runtime.cancelAgent("forge-2"), true);
  assert.equal(runtime.cancelAgent("forge-2"), false);
  assert.equal(runtime.cancelAgent("atlas-9"), false);
});

test("a caller signal still cancels synchronous root batches through the batch controller", async () => {
  const runtime = validationRuntime([]);
  (runtime as any).runInvocation = (_request: unknown, _context: unknown, _requestIndex: number, signal?: AbortSignal) =>
    new Promise((_resolve, reject) => {
      signal?.addEventListener("abort", () => reject(signal.reason));
    });
  const controller = new AbortController();
  const pending = runtime.runRootBatch([{ role: "Atlas", task: "Sync" }], controller.signal);
  controller.abort(new Error("parent turn stopped"));
  const result = await pending;
  assert.equal(result.runs[0]!.status, "failed");
});

test("batches await every request and aggregate unexpected invocation rejections as failures", async () => {
  const runtime = validationRuntime([]);
  let finishSecond!: (result: any) => void;
  const second = new Promise<any>((resolve) => { finishSecond = resolve; });
  (runtime as any).runInvocation = (_request: unknown, _context: unknown, requestIndex: number) =>
    requestIndex === 0 ? Promise.reject(new Error("failed before session creation")) : second;

  const launch = runtime.startRootBatch([
    { role: "Atlas", task: "First" },
    { role: "Atlas", task: "Second" },
  ]);
  let completed = false;
  void launch.completion.then(() => { completed = true; });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(completed, false, "one rejection must not report before the remaining request settles");

  finishSecond({
    invocationId: "second", agent: "atlas-2", role: "Atlas", status: "complete",
    durationMs: 1, output: "done", usage: { ...ZERO_USAGE },
  });
  const result = await launch.completion;
  assert.equal(result.runs.length, 2);
  assert.equal(result.runs[0]!.status, "failed");
  assert.match(result.runs[0]!.error ?? "", /failed before session creation/);
  assert.equal(result.runs[1]!.status, "complete");
  assert.deepEqual(result.allRuns, result.runs);
});

test("nested batches validate before suspending the parent lease", async () => {
  const runtime = validationRuntime([]);
  let suspensions = 0;
  let resumptions = 0;
  const lease = {
    suspend: () => { suspensions += 1; },
    resume: async () => { resumptions += 1; },
  } as unknown as Parameters<SubagentRuntime["runNestedBatch"]>[2];

  await assert.rejects(
    runtime.runNestedBatch(
      [{ role: "Atlas", task: "This request has an invalid timeout.", timeoutMinutes: 0 }],
      { batchId: "parent-batch", depth: 1 },
      lease,
    ),
    /timeoutMinutes must be -1 or a positive integer/,
  );

  assert.equal(suspensions, 0);
  assert.equal(resumptions, 0);
  assert.equal(runtime.state.agents.size, 0);
  assert.equal(runtime.state.invocations.size, 0);
});

test("nested delegation allows only configured roles and owned follow-ups", () => {
  const state = emptyRuntimeState();
  state.agents.set("atlas-owned", { handle: "atlas-owned", role: "Atlas", sessionFile: "/tmp/owned", createdAt: 1 });
  state.agents.set("atlas-foreign", { handle: "atlas-foreign", role: "Atlas", sessionFile: "/tmp/foreign", createdAt: 2 });
  state.agents.set("worker-owned", { handle: "worker-owned", role: "Worker", sessionFile: "/tmp/worker", createdAt: 3 });
  for (const item of [
    invocation({ id: "architect-run", batchId: "batch", agent: "architect-1", role: "Architect", status: "running" }),
    invocation({ id: "vigil-run", batchId: "batch", agent: "vigil-1", role: "Vigil", status: "running" }),
    invocation({ id: "owned", batchId: "batch", agent: "atlas-owned", role: "Atlas", status: "complete", parentInvocationId: "architect-run", queuedAt: 2 }),
    invocation({ id: "foreign", batchId: "batch", agent: "atlas-foreign", role: "Atlas", status: "complete", parentInvocationId: "vigil-run", queuedAt: 3 }),
    invocation({ id: "wrong-role", batchId: "batch", agent: "worker-owned", role: "Worker", status: "complete", parentInvocationId: "architect-run", queuedAt: 4 }),
  ]) state.invocations.set(item.id, item);
  const runtime = Object.assign(Object.create(SubagentRuntime.prototype), { state }) as SubagentRuntime;
  const enforce = (SubagentRuntime.prototype as any).assertNestedDelegation.bind(runtime);
  const atlasOnly = new Set(["atlas"]);

  assert.doesNotThrow(() => enforce([{ role: "Atlas", task: "fresh" }], "architect-1", atlasOnly));
  assert.doesNotThrow(() => enforce([{ agent: "atlas-owned", task: "continue" }], "architect-1", atlasOnly));
  assert.throws(() => enforce([{ role: "Worker", task: "fresh" }], "architect-1", atlasOnly), /cannot delegate to role Worker/);
  assert.throws(() => enforce([{ agent: "worker-owned", task: "continue" }], "architect-1", atlasOnly), /cannot follow up with role Worker/);
  assert.throws(() => enforce([{ agent: "atlas-foreign", task: "continue" }], "architect-1", atlasOnly), /only follow up with agents it spawned/);
});

test("projection keeps nested agents attached and active batches above settled batches", () => {
  const state = emptyRuntimeState();
  applyEvent(state, { type: "batch.started", batch: { id: "old", createdAt: 1 } });
  applyEvent(state, { type: "batch.started", batch: { id: "new", createdAt: 2 } });
  const parent = invocation({ id: "parent", batchId: "new", agent: "architect-1", role: "Architect", status: "running" });
  const child = invocation({
    id: "child",
    batchId: "new",
    agent: "atlas-1",
    role: "Atlas",
    status: "complete",
    parentInvocationId: "parent",
  });
  const settled = invocation({ id: "settled", batchId: "old", agent: "worker-1", role: "Worker", status: "complete" });
  for (const item of [parent, child, settled]) applyEvent(state, { type: "invocation.queued", invocation: item });

  const batches = projectBatches(state);
  assert.equal(batches[0]?.batch.id, "new");
  assert.equal(batches[0]?.roots[0]?.invocation.id, "parent");
  assert.equal(batches[0]?.roots[0]?.children[0]?.invocation.id, "child");
  assert.equal(batches[1]?.batch.id, "old");
});

test("runtime generates headings asynchronously without adding them to execution results", async () => {
  const events: any[] = [];
  const runtime = validationRuntime(events);
  (runtime.options as any).generateHeadings = async (requests: unknown[]) => {
    assert.deepEqual(requests, [{ role: "Atlas", task: "Inspect API contracts" }]);
    return { call: "API Contract Research", requests: ["Inspect API Contracts"] };
  };
  applyEvent(runtime.state, { type: "batch.started", batch: { id: "batch", createdAt: 1 } });
  applyEvent(runtime.state, { type: "delegation.started", call: { id: "call", batchId: "batch", createdAt: 1 } });
  applyEvent(runtime.state, {
    type: "invocation.queued",
    invocation: invocation({
      id: "inv", batchId: "batch", callId: "call", requestIndex: 0,
      agent: "atlas-1", role: "Atlas", task: "Inspect API contracts", status: "running",
    }),
  });

  (runtime as any).startHeadingGeneration([{ role: "Atlas", task: "Inspect API contracts" }], { batchId: "batch", callId: "call", depth: 0 });
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(runtime.state.delegationCalls.get("call")?.heading, "API Contract Research");
  assert.equal(runtime.state.invocations.get("inv")?.heading, "Inspect API Contracts");
  assert.equal(events.at(-1)?.type, "delegation.headings");
});

test("delegation headings persist as UI-only call and invocation metadata with nested grouping", () => {
  const state = emptyRuntimeState();
  applyEvent(state, { type: "batch.started", batch: { id: "batch", createdAt: 1 } });
  applyEvent(state, { type: "delegation.started", call: { id: "root-call", batchId: "batch", createdAt: 1 } });
  const parent = invocation({
    id: "parent", batchId: "batch", callId: "root-call", requestIndex: 0,
    agent: "architect-1", role: "Architect", status: "running",
  });
  applyEvent(state, { type: "invocation.queued", invocation: parent });
  applyEvent(state, {
    type: "delegation.started",
    call: { id: "nested-call", batchId: "batch", parentInvocationId: "parent", createdAt: 2 },
  });
  const child = invocation({
    id: "child", batchId: "batch", callId: "nested-call", requestIndex: 0,
    parentInvocationId: "parent", agent: "atlas-1", role: "Atlas", status: "running",
  });
  applyEvent(state, { type: "invocation.queued", invocation: child });
  applyEvent(state, {
    type: "delegation.headings",
    callId: "root-call",
    callHeading: "CRM API Workstreams",
    requestHeadings: [{ invocationId: "parent", heading: "Implement Contact APIs" }],
  });
  applyEvent(state, {
    type: "delegation.headings",
    callId: "nested-call",
    callHeading: "API Contract Research",
    requestHeadings: [{ invocationId: "child", heading: "Map Existing CRM APIs" }],
  });

  const [batch] = projectBatches(state);
  assert.equal(batch?.rootCall?.heading, "CRM API Workstreams");
  assert.equal(batch?.roots[0]?.invocation.heading, "Implement Contact APIs");
  assert.equal(batch?.roots[0]?.childCalls[0]?.call.heading, "API Contract Research");
  assert.equal(batch?.roots[0]?.childCalls[0]?.children[0]?.invocation.heading, "Map Existing CRM APIs");
});

test("state revisions cache projections and direct usage updates invalidate aggregate views", () => {
  const state = emptyRuntimeState();
  applyEvent(state, { type: "batch.started", batch: { id: "batch", createdAt: 1 } });
  const item = invocation({ id: "one", batchId: "batch", agent: "atlas-1", role: "Atlas", status: "running" });
  applyEvent(state, { type: "invocation.queued", invocation: item });

  const first = projectBatches(state);
  assert.strictEqual(projectBatches(state), first);
  item.usage = { ...ZERO_USAGE, total: 99 };
  advanceStateRevision(state);
  const updated = projectBatches(state);
  assert.notStrictEqual(updated, first);
  assert.equal(updated[0]?.usage.total, 99);

  const revisionless = { agents: state.agents, invocations: state.invocations, batches: state.batches, delegationCalls: state.delegationCalls };
  assert.notStrictEqual(projectBatches(revisionless), projectBatches(revisionless), "revision remains optional for stubs");
});

test("transcript revisions notify their dedicated subscribers without repainting general runtime listeners", () => {
  const runtime = validationRuntime([]);
  let generalUpdates = 0;
  const transcriptUpdates: Array<[string, number]> = [];
  const unsubscribeGeneral = runtime.subscribe(() => { generalUpdates += 1; });
  const unsubscribeTranscript = runtime.subscribeTranscript((handle, revision) => transcriptUpdates.push([handle, revision]));

  (runtime as any).notifyTranscript("atlas-1");
  (runtime as any).notifyTranscript("atlas-1");
  assert.equal(generalUpdates, 0);
  assert.deepEqual(transcriptUpdates, [["atlas-1", 1], ["atlas-1", 2]]);
  assert.equal(runtime.transcriptRevision("atlas-1"), 2);
  unsubscribeGeneral();
  unsubscribeTranscript();
});

test("parallel tool activity survives out-of-order completion and shows a count", () => {
  const runtime = validationRuntime([]);
  let updates = 0;
  runtime.subscribe(() => { updates += 1; });
  const calls = new Map([["call-a", "read"], ["call-b", "bash"]]);
  (runtime as any).activeToolCalls.set("inv", calls);
  (runtime as any).syncToolActivity("inv");
  assert.deepEqual(runtime.activities.get("inv"), { invocationId: "inv", tool: "bash", toolCount: 2 });

  calls.delete("call-a");
  (runtime as any).syncToolActivity("inv");
  assert.deepEqual(runtime.activities.get("inv"), { invocationId: "inv", tool: "bash", toolCount: 1 });
  calls.delete("call-b");
  (runtime as any).activeToolCalls.delete("inv");
  (runtime as any).syncToolActivity("inv");
  assert.equal(runtime.activities.has("inv"), false);
  assert.equal(updates, 3);
});

test("live tool lifecycle snapshots retain partial and final renderer state", () => {
  const runtime = validationRuntime([]);
  (runtime as any).updateToolExecution("atlas-1", "call", "bash", {
    args: { command: "printf hi" }, executionStarted: true, argsComplete: true, isPartial: true,
  });
  (runtime as any).updateToolExecution("atlas-1", "call", "bash", {
    result: { content: [{ type: "text", text: "hi" }], details: { phase: 1 }, isError: false }, isPartial: true,
  });
  let snapshot = runtime.toolExecutions.get("atlas-1")?.get("call");
  assert.equal(snapshot?.revision, 2);
  assert.equal(snapshot?.isPartial, true);
  assert.equal(snapshot?.result?.content[0]?.text, "hi");

  (runtime as any).updateToolExecution("atlas-1", "call", "bash", {
    result: { content: [{ type: "text", text: "failed" }], details: { phase: 2 }, isError: true }, isPartial: false,
  });
  snapshot = runtime.toolExecutions.get("atlas-1")?.get("call");
  assert.equal(snapshot?.revision, 3);
  assert.equal(snapshot?.isPartial, false);
  assert.equal(snapshot?.result?.isError, true);
  assert.deepEqual(snapshot?.args, { command: "printf hi" });
});

test("live usage includes the assistant message not yet present in session stats", () => {
  const persisted = { input: 10, output: 2, cacheRead: 3, cacheWrite: 1, total: 16, cost: 0.1 };
  const message = {
    usage: {
      input: 4,
      output: 5,
      cacheRead: 6,
      cacheWrite: 7,
      totalTokens: 22,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.2 },
    },
  } as any;
  assert.deepEqual(usageWithPendingAssistant(persisted, message), {
    input: 14, output: 7, cacheRead: 9, cacheWrite: 8, total: 38, cost: 0.30000000000000004,
  });
});test("panel rows show tree metrics without leaking tasks", () => {
  const state = emptyRuntimeState();
  applyEvent(state, { type: "batch.started", batch: { id: "batch", createdAt: 1 } });
  for (const item of [
    invocation({ id: "one", batchId: "batch", agent: "atlas-1", role: "Atlas", status: "running", task: "SECRET PROMPT", heading: "Trace Public Forms", followup: true, ordinal: 3, startedAt: 500, usage: { ...ZERO_USAGE, total: 1234, cost: 2.5 } }),
    invocation({ id: "two", batchId: "batch", agent: "worker-1", role: "Worker", status: "running", heading: "Trace A Much Longer Workspace Policy" }),
  ]) applyEvent(state, { type: "invocation.queued", invocation: item });
  const runtime = { state, activities: new Map([["one", { invocationId: "one", tool: "read", toolCount: 2 }]]) } as unknown as SubagentRuntime;
  const colorCalls: Array<[string, string]> = [];
  const theme = { fg: (color: string, text: string) => { colorCalls.push([color, text]); return text; } } as unknown as Parameters<typeof renderPanel>[1];
  const lines = renderPanel(runtime, theme, 120, 2_000);
  const rows = lines.filter((line) => /^[├└]─/.test(line));
  assert.equal(rows.length, 2);
  assert.match(rows[0]!, /Atlas.*↻.*running.*Trace Public Forms.*read \+1.*·  ·.*1s.*1\.2k tok.*2\.500/);
  assert.doesNotMatch(lines.join("\n"), /SECRET PROMPT|#3|follow-up|atlas-1/);
  assert.match(rows[1]!, /^└─.*running.*Trace A Much Longer.*working.*·  ·/);
  const firstActivityColumn = visibleWidth(rows[0]!.slice(0, rows[0]!.indexOf("read +1")));
  const secondActivityColumn = visibleWidth(rows[1]!.slice(0, rows[1]!.indexOf("working")));
  assert.equal(firstActivityColumn, secondActivityColumn, "live activity occupies one aligned, unlabelled column");
  assert.ok(colorCalls.some(([color, text]) => color === "text" && text === "Trace Public Forms"));
  assert.ok(!colorCalls.some(([, text]) => text.includes("read +1") || text === "working"), "activity has no color styling");
});

test("nested delegation captions preserve direct agent ownership in the live panel", () => {
  const state = emptyRuntimeState();
  applyEvent(state, { type: "batch.started", batch: { id: "batch", createdAt: 1 } });
  applyEvent(state, { type: "delegation.started", call: { id: "root", batchId: "batch", createdAt: 1 } });
  applyEvent(state, { type: "invocation.queued", invocation: invocation({
    id: "vigil", batchId: "batch", callId: "root", agent: "vigil-1", role: "Vigil", status: "running",
  }) });
  applyEvent(state, { type: "delegation.started", call: {
    id: "nested", batchId: "batch", parentInvocationId: "vigil", createdAt: 2,
  } });
  for (const [index, id] of ["atlas-1", "atlas-2"].entries()) {
    applyEvent(state, { type: "invocation.queued", invocation: invocation({
      id, batchId: "batch", callId: "nested", requestIndex: index, parentInvocationId: "vigil",
      agent: id, role: "Atlas", status: "running",
    }) });
  }
  applyEvent(state, {
    type: "delegation.headings", callId: "nested", callHeading: "Atlas Read-only M7 Review Sweep",
    requestHeadings: [
      { invocationId: "atlas-1", heading: "Inspect M7 Policy Authority" },
      { invocationId: "atlas-2", heading: "Inspect Migration Contract Parity" },
    ],
  });
  const runtime = { state, activities: new Map() } as unknown as SubagentRuntime;
  const theme = { fg: (_color: string, text: string) => text } as unknown as Parameters<typeof renderPanel>[1];
  const output = renderPanel(runtime, theme, 120, 2_000).join("\n");

  assert.match(output, /└─.*Vigil[\s\S]*› Read-only M7 Review Sweep[\s\S]*├─.*Atlas[\s\S]*└─.*Atlas/);
  assert.doesNotMatch(output, /Atlas Read-only M7 Review Sweep|└─ Atlas Read-only/);
});

test("panel summary is one line and all ANSI-safe rows stay within responsive widths", () => {
  const state = emptyRuntimeState();
  applyEvent(state, { type: "batch.started", batch: { id: "batch", createdAt: 1 } });
  applyEvent(state, { type: "invocation.queued", invocation: invocation({ id: "one", batchId: "batch", agent: "atlas-1", role: "Atlas", status: "running", startedAt: 1 }) });
  const runtime = { state, activities: new Map([["one", { invocationId: "one", tool: "read" }]]) } as unknown as SubagentRuntime;
  const theme = { fg: (color: string, text: string) => `\x1b[${color === "error" ? 31 : 36}m${text}\x1b[0m` } as unknown as Parameters<typeof renderPanel>[1];
  for (const width of [28, 52, 90]) {
    const lines = renderPanel(runtime, theme, width, 2_000);
    assert.equal(lines.filter((line) => line.includes("Agents")).length, 1);
    assert.ok(lines.every((line) => visibleWidth(line) <= width));
    assert.doesNotMatch(lines.join("\n"), /task|atlas-1|follow-up/i);
  }
});

test("panel keeps every running batch visible and hides only settled ones", () => {
  const state = emptyRuntimeState();
  applyEvent(state, { type: "batch.started", batch: { id: "old", createdAt: 1 } });
  applyEvent(state, { type: "invocation.queued", invocation: invocation({ id: "old-run", batchId: "old", agent: "atlas-1", role: "Atlas", status: "running", queuedAt: 1, startedAt: 2 }) });
  applyEvent(state, { type: "batch.started", batch: { id: "new", createdAt: 3 } });
  applyEvent(state, { type: "invocation.queued", invocation: invocation({ id: "new-run", batchId: "new", agent: "worker-1", role: "Worker", status: "running", queuedAt: 3, startedAt: 4 }) });
  applyEvent(state, { type: "batch.started", batch: { id: "settled", createdAt: 5 } });
  applyEvent(state, { type: "invocation.queued", invocation: invocation({ id: "done-run", batchId: "settled", agent: "vigil-1", role: "Vigil", status: "complete", queuedAt: 5, startedAt: 6, finishedAt: 7 }) });
  const runtime = { state, activities: new Map() } as unknown as SubagentRuntime;
  const theme = { fg: (_color: string, text: string) => text } as unknown as Parameters<typeof renderPanel>[1];

  const expanded = renderPanel(runtime, theme, 120, 8_000).join("\n");
  assert.match(expanded, /Atlas×1/);
  assert.match(expanded, /Worker×1/);
  assert.match(expanded, /└─ ◐ Atlas.*running/);
  assert.match(expanded, /└─ ◐ Worker.*running/);
  assert.doesNotMatch(expanded, /Vigil×1/, "settled batches stay out of the live panel");

  const minimized = renderPanel(runtime, theme, 120, 8_000, true);
  assert.equal(minimized.length, 2, "minimized panel lists one summary line per running batch");
  assert.match(minimized[0]!, /Worker×1/, "newest running batch sorts first");
  assert.match(minimized[1]!, /Atlas×1/);
});

test("compact panel shows only the latest batch, then expires to the dashboard hint", () => {
  const state = emptyRuntimeState();
  applyEvent(state, { type: "batch.started", batch: { id: "old", createdAt: 1 } });
  applyEvent(state, { type: "batch.started", batch: { id: "new", createdAt: 2 } });
  applyEvent(state, { type: "invocation.queued", invocation: invocation({ id: "old-run", batchId: "old", agent: "atlas-1", role: "Atlas", status: "complete" }) });
  applyEvent(state, { type: "invocation.queued", invocation: invocation({ id: "new-run", batchId: "new", agent: "worker-1", role: "Worker", status: "complete", queuedAt: 2 }) });
  const runtime = { state, activities: new Map() } as unknown as SubagentRuntime;
  const theme = { fg: (_color: string, text: string) => text } as unknown as Parameters<typeof renderPanel>[1];
  const output = renderPanel(runtime, theme, 120, 2_000).join("\n");
  assert.match(output, /Worker×1/);
  assert.doesNotMatch(output, /Atlas×1|older batch/);
  assert.match(output, /See all agent batches in \/agents/);

  const expired = renderPanel(runtime, theme, 120, 50_000).join("\n");
  assert.doesNotMatch(expired, /Worker×1|Atlas×1|Agents ✓/);
  assert.equal(expired, "See all agent batches in /agents");
});

test("minimized panel collapses to one summary line and hides once the batch settles", () => {
  const state = emptyRuntimeState();
  applyEvent(state, { type: "batch.started", batch: { id: "batch", createdAt: 1 } });
  applyEvent(state, { type: "invocation.queued", invocation: invocation({ id: "one", batchId: "batch", agent: "atlas-1", role: "Atlas", status: "running", startedAt: 1 }) });
  applyEvent(state, { type: "invocation.queued", invocation: invocation({ id: "two", batchId: "batch", agent: "vigil-1", role: "Vigil", status: "queued", queuedAt: 2 }) });
  const runtime = { state, activities: new Map() } as unknown as SubagentRuntime;
  const theme = { fg: (_color: string, text: string) => text } as unknown as Parameters<typeof renderPanel>[1];

  const expanded = renderPanel(runtime, theme, 120, 10_000, false);
  assert.ok(expanded.length > 1, "expanded panel lists every agent");
  assert.match(expanded.join("\n"), /Atlas.*running|Vigil.*queued/);

  const minimized = renderPanel(runtime, theme, 120, 10_000, true);
  assert.equal(minimized.length, 1, "minimized panel is exactly one summary line");
  assert.match(minimized[0]!, /Agents.*2 agents/);
  assert.doesNotMatch(minimized.join("\n"), /atlas-1|vigil-1|See all agent batches/);
});

test("minimized panel is hidden entirely when the latest batch is settled", () => {
  const state = emptyRuntimeState();
  applyEvent(state, { type: "batch.started", batch: { id: "batch", createdAt: 1 } });
  applyEvent(state, { type: "invocation.queued", invocation: invocation({ id: "one", batchId: "batch", agent: "atlas-1", role: "Atlas", status: "complete", startedAt: 1, finishedAt: 2_000 }) });
  const runtime = { state, activities: new Map() } as unknown as SubagentRuntime;
  const theme = { fg: (_color: string, text: string) => text } as unknown as Parameters<typeof renderPanel>[1];

  const minimized = renderPanel(runtime, theme, 120, 50_000, true);
  assert.deepEqual(minimized, [], "settled batches leave the minimized panel empty");
  const expanded = renderPanel(runtime, theme, 120, 50_000, false);
  assert.match(expanded.join("\n"), /See all agent batches in \/agents/);
});

test("AgentsPanel respects the minimized getter", () => {
  const state = emptyRuntimeState();
  applyEvent(state, { type: "batch.started", batch: { id: "batch", createdAt: 1 } });
  applyEvent(state, { type: "invocation.queued", invocation: invocation({ id: "one", batchId: "batch", agent: "atlas-1", role: "Atlas", status: "running", startedAt: 1 }) });
  const runtime = { state, activities: new Map(), subscribe: () => () => {} } as unknown as SubagentRuntime;
  const theme = { fg: (_color: string, text: string) => text } as unknown as Parameters<typeof renderPanel>[1];
  const tui = { requestRender: () => {} } as any;
  let minimized = false;
  const panel = new AgentsPanel(runtime, tui, theme, () => minimized);
  assert.ok(panel.render(120).length > 1, "expanded by default");
  minimized = true;
  assert.equal(panel.render(120).length, 1);
  panel.dispose();
});

test("role, cost, and invocation duration helpers follow UI thresholds", () => {
  assert.deepEqual([roleColor("Atlas"), roleColor("Vigil"), roleColor("Worker")], ["mdLink", "thinkingMax", "text"]);
  assert.equal(stripLeadingRoleNames("Atlas Read-only M7 Review Sweep", ["Atlas"]), "Read-only M7 Review Sweep");
  assert.equal(stripLeadingRoleNames("Atlas and Vigil: API implementation", ["Atlas", "Vigil"]), "API implementation");
  assert.deepEqual([costColor(1.999), costColor(2), costColor(6.999), costColor(7)], ["success", "warning", "warning", "error"]);
  assert.equal(invocationDuration(invocation({ id: "x", batchId: "b", agent: "a", role: "Atlas", status: "complete", queuedAt: 10, startedAt: 20, finishedAt: 70 }), 100), 50);
});

test("persisted batch results carry per-invocation duration for settled statuses", () => {
  const state = emptyRuntimeState();
  for (const [index, status] of (["complete", "failed", "cancelled", "interrupted"] as const).entries()) {
    const item = invocation({ id: `duration-${status}`, batchId: "durations", agent: `agent-${index}`, role: "Atlas", status, queuedAt: 100, startedAt: 200, finishedAt: 1_700 });
    state.invocations.set(item.id, item);
  }
  const results = (SubagentRuntime.prototype as any).resultsForBatch.call({ state }, "durations");
  assert.deepEqual(results.map((result: any) => result.durationMs), [1_500, 1_500, 1_500, 1_500]);
});

test("native usage deltas keep cache fields and cost without reinterpretation", () => {
  assert.deepEqual(
    usageDelta(
      { input: 20, output: 10, cacheRead: 8, cacheWrite: 4, total: 42, cost: 0.25 },
      { input: 5, output: 3, cacheRead: 2, cacheWrite: 1, total: 11, cost: 0.05 },
    ),
    { input: 15, output: 7, cacheRead: 6, cacheWrite: 3, total: 31, cost: 0.2 },
  );
});

test("rebindForReload re-points extension-bound hooks for the adopting instance", () => {
  const runtime = validationRuntime([]);
  const config = runtime.options.config;
  const rebind = {
    config: { ...config, defaults: { ...config.defaults, concurrency: 3 } },
    appendEvent: () => {},
    modelRegistry: {} as any,
  };
  runtime.rebindForReload(rebind as any);

  assert.equal(runtime.options.appendEvent, rebind.appendEvent);
  assert.equal(runtime.options.modelRegistry, rebind.modelRegistry);
  assert.equal(runtime.options.config.defaults.concurrency, 3, "freshly loaded config applies to new delegations");
  assert.equal(runtime.options.rootSessionId, "validation-root", "session identity survives the handoff");
});

function validationRuntime(events: unknown[]): SubagentRuntime {
  return new SubagentRuntime({
    rootSessionId: "validation-root",
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

function invocation(overrides: Partial<InvocationRecord> & Pick<InvocationRecord, "id" | "batchId" | "agent" | "role" | "status">): InvocationRecord {
  return {
    task: "task",
    followup: false,
    ordinal: 1,
    depth: 1,
    queuedAt: 1,
    timeoutMinutes: 10,
    usage: { ...ZERO_USAGE },
    ...overrides,
  };
}
