import * as path from "node:path";
import { randomUUID } from "node:crypto";
import {
  createAgentSession,
  getAgentDir,
  ModelRuntime,
  SessionManager,
  type AgentSession,
  type SessionStats,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { AgentRole } from "../config/agents.ts";
import { resolvePreset } from "../config/agents.ts";
import { defaultModeName } from "../config/mode.ts";
import { createSubagentTool } from "../tool.ts";
import { createWebSearchTool } from "../web-search/index.ts";
import { CapacityLease, CapacityScheduler } from "./scheduler.ts";
import { advanceStateRevision, applyEvent, emptyRuntimeState, fallbackEntriesUsage, sessionEntriesUsage, usageDelta } from "./state.ts";
import { createRoleResourceLoader } from "./resources.ts";
import { ActiveWorkTimeout } from "./timeout.ts";
import {
  ZERO_USAGE,
  type AgentRecord,
  type BackgroundBatchLaunch,
  type BatchResult,
  type FollowupBatchResult,
  type FollowupReceipt,
  type FollowupRequest,
  type ControlRequest,
  type ControlResult,
  type AgentInspection,
  type BatchInspection,
  type InspectionPendingItem,
  type InvocationContext,
  type InvocationRecord,
  type InvocationResult,
  type PromotedBatchReceipt,
  type ResolvedRequest,
  type RootBatchPromotion,
  type RuntimeOptions,
  type RuntimeState,
  type SubagentEvent,
  type SubagentRequest,
  type Usage,
} from "./types.ts";

export type RuntimeActivity = {
  invocationId: string;
  tool?: string;
  toolCount?: number;
  detail?: string;
};

export type RuntimeToolResult = {
  content: Array<{ type: string; text?: string; data?: string; mimeType?: string }>;
  details?: unknown;
};

export type RuntimeToolExecution = {
  toolCallId: string;
  toolName: string;
  args: unknown;
  executionStarted: boolean;
  argsComplete: boolean;
  result?: RuntimeToolResult & { isError: boolean };
  isPartial: boolean;
  revision: number;
};

/** Promotion state for a foreground root batch, from launch until it settles. */
type FollowupGroup = {
  batchId: string;
  callId: string;
  context?: InvocationContext;
  pending: Set<string>;
  results: Array<InvocationResult | undefined>;
  resolve: (result: BatchResult) => void;
  promise: Promise<BatchResult>;
  startedAt: number;
  detached: boolean;
  controller: AbortController;
};

type QueuedFollowup = FollowupReceipt & {
  message: string;
  timeoutMinutes?: number;
  batchId?: string;
  context?: InvocationContext;
  groupId?: string;
  requestIndex?: number;
};

type PromotableBatch = {
  launch: BackgroundBatchLaunch;
  controller: AbortController;
  /** Caller abort wiring, removed when the batch is promoted so later caller aborts cannot cancel it. */
  callerSignal?: AbortSignal;
  callerListener?: () => void;
  /** Resolves the synchronous waiter's promotion receipt inside {@link SubagentRuntime.runRootBatch}. */
  promise: Promise<PromotedBatchReceipt>;
  resolve: (receipt: PromotedBatchReceipt) => void;
  agentCount: number;
  promoted: boolean;
};

/**
 * Extension-bound hooks a surviving runtime re-points when a reload hands it
 * off to a fresh extension instance. `config` is included so newly loaded
 * agents.yaml content applies to delegations made after the reload.
 */
export type RuntimeReloadRebind = Partial<
  Pick<RuntimeOptions, "appendEvent" | "generateHeadings" | "accountExtension" | "routeAccountModel" | "modelRegistry" | "config" | "roleOverride" | "deliverQueuedBatch">
>;

/**
 * Upgrade a runtime object created by an older hot-loaded module instance.
 *
 * Reload preserves the JavaScript object, not its class module. New methods are
 * therefore absent from a surviving old prototype, and new private-by-
 * convention collections are absent from the object too. Initialize those
 * collections explicitly, validate the legacy core shape, then install the
 * current prototype. This is deliberately not a bare Object.setPrototypeOf:
 * an incompatible object fails loudly instead of losing live work silently.
 */
export function migrateRuntimeForReload(candidate: unknown): SubagentRuntime {
  if (!candidate || typeof candidate !== "object") {
    throw new Error("Cannot adopt subagent runtime: reload handoff is not an object.");
  }
  const runtime = candidate as Record<string, any>;
  const invalidCore: string[] = [];
  if (!isObject(runtime.options)) invalidCore.push("options");
  if (!isObject(runtime.state)) invalidCore.push("state");
  if (!isObject(runtime.scheduler) || typeof runtime.scheduler.acquire !== "function") invalidCore.push("scheduler");
  if (!(runtime.liveSessions instanceof Map)) invalidCore.push("liveSessions");
  if (typeof runtime.record !== "function") invalidCore.push("record");
  if (typeof runtime.runBatch !== "function") invalidCore.push("runBatch");
  const state = isObject(runtime.state) ? runtime.state : undefined;
  for (const name of ["agents", "invocations", "batches", "delegationCalls"]) {
    if (state && !(state[name] instanceof Map)) invalidCore.push(`state.${name}`);
  }
  if (invalidCore.length > 0) {
    throw new Error(`Cannot adopt subagent runtime: incompatible legacy runtime (${invalidCore.join(", ")}).`);
  }

  // Validate every existing field before adding any missing one. A malformed
  // field must never cause a live Map/Set to be silently discarded.
  const maps = ["promotableBatches", "liveDelegationRefreshers", "followupTasks", "followupQueues", "followupGroups"];
  const sets = ["disabledRoleNames", "followupDrain"];
  for (const key of maps) validateReloadCollection(runtime, key, Map);
  for (const key of sets) validateReloadCollection(runtime, key, Set);
  if (runtime.followupCounter !== undefined &&
      (!Number.isSafeInteger(runtime.followupCounter) || runtime.followupCounter < 0)) {
    throw new Error("Cannot adopt subagent runtime: incompatible legacy runtime (followupCounter).");
  }

  for (const key of maps) ensureMap(runtime, key);
  for (const key of sets) ensureSet(runtime, key);
  if (runtime.followupCounter === undefined) runtime.followupCounter = 0;
  Object.setPrototypeOf(runtime, SubagentRuntime.prototype);
  return runtime as SubagentRuntime;
}

function isObject(value: unknown): value is Record<string, any> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function validateReloadCollection<T extends Map<unknown, unknown> | Set<unknown>>(
  runtime: Record<string, any>,
  key: string,
  kind: { new (...args: any[]): T },
): void {
  if (runtime[key] !== undefined && !(runtime[key] instanceof kind)) {
    throw new Error(`Cannot adopt subagent runtime: incompatible legacy runtime (${key}).`);
  }
}

function ensureMap(target: Record<string, any>, key: string): void {
  if (target[key] === undefined) target[key] = new Map();
}

function ensureSet(target: Record<string, any>, key: string): void {
  if (target[key] === undefined) target[key] = new Set();
}

export class SubagentRuntime {
  readonly scheduler: CapacityScheduler;
  readonly state: RuntimeState;
  readonly activities = new Map<string, RuntimeActivity>();
  readonly liveSessions = new Map<string, AgentSession>();
  /** Authoritative lifecycle snapshots for tool calls in currently live child sessions. */
  readonly toolExecutions = new Map<string, Map<string, RuntimeToolExecution>>();
  private readonly activeToolCalls = new Map<string, Map<string, string>>();
  private readonly listeners = new Set<() => void>();
  private readonly reservedHandles: Set<string>;
  private batchCounter: number;
  private readonly invocationCancels = new Set<(reason?: unknown) => void>();
  /** Abort controller per root batch, keyed by batchId. */
  private readonly batchCancels = new Map<string, AbortController>();
  /** Abort controller per live child invocation, keyed by the agent handle. */
  private readonly agentCancels = new Map<string, AbortController>();
  /** Foreground root batches that can still be promoted to the background, keyed by batchId. */
  private readonly promotableBatches = new Map<string, PromotableBatch>();
  /** Canonical names of roles disabled for this session; new invocations to them reject. */
  private readonly disabledRoleNames = new Set<string>();
  private readonly pendingInvocations = new Set<Promise<InvocationResult>>();
  private readonly headingControllers = new Set<AbortController>();
  /** Refresh hooks for custom child delegation tools; policy changes affect the next child turn. */
  private readonly liveDelegationRefreshers = new Map<string, () => void>();
  /** Accepted queue/steer messages, retained until consumed or explicitly rejected. */
  readonly followupTasks = new Map<string, QueuedFollowup>();
  private readonly followupQueues = new Map<string, QueuedFollowup[]>();
  private readonly followupDrain = new Set<string>();
  private followupCounter = 0;
  private readonly followupGroups = new Map<string, FollowupGroup>();
  private modelRuntime?: ModelRuntime;
  private modelRuntimePromise?: Promise<ModelRuntime>;
  private disposed = false;
  private activeModeValue: string | undefined;
  private effectiveRoles: AgentRole[];

  constructor(readonly options: RuntimeOptions, initialState?: RuntimeState) {
    this.scheduler = new CapacityScheduler(options.config.defaults.concurrency);
    this.state = initialState ?? emptyRuntimeState();
    this.reservedHandles = new Set(options.reservedHandles ?? this.state.agents.keys());
    this.batchCounter = maxBatchCounter(this.state);
    this.activeModeValue = options.activeMode ?? defaultModeName(options.config);
    this.effectiveRoles = this.resolveRoles(this.activeModeValue);
  }

  /** The canonical name of the active preset, or undefined when no preset is active. */
  get activeMode(): string | undefined {
    return this.activeModeValue;
  }

  /** Roles the active preset activates, with overrides applied, minus disabled roles. */
  get activeRoles(): readonly AgentRole[] {
    return this.effectiveRoles.filter((role) => !this.isRoleDisabled(role.name));
  }

  /** Canonical names of roles currently disabled by session or persisted policy. */
  get disabledRoles(): ReadonlySet<string> {
    const disabled = new Set(this.disabledRoleNames);
    for (const role of this.effectiveRoles) {
      if (this.isPersistentlyDisabled(role.name)) disabled.add(role.name);
    }
    return disabled;
  }

  /**
   * Disable roles for this session: already-running invocations finish, but new
   * invocations — fresh delegations, follow-ups to agents of a disabled role,
   * and nested delegation to disabled roles — reject. Future child sessions
   * omit disabled roles from their delegation schemas. Names are canonicalized
   * case-insensitively; unknown names are remembered lowercase so a later
   * preset switch cannot resurrect them. Persisted scope overrides are resolved
   * separately by the role override callback. An empty iterable re-enables every
   * manually disabled role; disabling all configured roles is safe (every delegation rejects).
   */
  setDisabledRoles(roles: Iterable<string>): void {
    this.disabledRoleNames.clear();
    for (const name of roles) {
      const trimmed = name.trim();
      if (!trimmed) continue;
      const canonical = this.effectiveRoles.find((role) => role.name.toLowerCase() === trimmed.toLowerCase())?.name;
      this.disabledRoleNames.add(canonical ?? trimmed.toLowerCase());
    }
    this.rejectDisabledFollowups();
    this.refreshLiveDelegationTools();
    this.notify();
  }

  private rejectDisabledFollowups(): void {
    for (const task of this.followupTasks.values()) {
      const agent = this.state.agents.get(task.agent);
      if (agent && this.isRoleDisabled(agent.role) && task.status === "accepted" && task.state !== "consumed") {
        this.rejectFollowup(task, `Role ${agent.role} was disabled before this follow-up was consumed.`);
      }
    }
    for (const [handle, agent] of this.state.agents) {
      if (this.isRoleDisabled(agent.role)) this.clearFollowups(handle, `Role ${agent.role} was disabled before this follow-up was consumed.`);
    }
    for (const [handle, queue] of this.followupQueues) {
      queue.splice(0, queue.length, ...queue.filter((task) => task.status === "accepted"));
      if (queue.length === 0) this.followupQueues.delete(handle);
    }
  }

  /** All roles in the active preset, including disabled roles for configuration UI. */
  get configuredRoles(): readonly AgentRole[] {
    return this.effectiveRoles;
  }

  isRoleDisabled(name: string): boolean {
    const needle = name.toLowerCase();
    for (const disabled of this.disabledRoleNames) {
      if (disabled.toLowerCase() === needle) return true;
    }
    return this.isPersistentlyDisabled(name);
  }

  private isPersistentlyDisabled(name: string): boolean {
    return this.options.roleOverride?.(this.activeModeValue, name)?.enabled === false;
  }

  /**
   * Switch the active preset. Unknown names throw; subscribers are notified so
   * the header and footer re-render. New delegations use the new roles; already
   * running child sessions are unaffected.
   */
  setActiveMode(name: string | undefined): string | undefined {
    const canonical = name === undefined ? undefined : this.canonicalPresetName(name);
    if (name !== undefined && canonical === undefined) {
      throw new Error(`Unknown agents preset: ${name}.`);
    }
    if (canonical === this.activeModeValue) return canonical;
    this.activeModeValue = canonical;
    this.effectiveRoles = this.resolveRoles(canonical);
    this.rejectDisabledFollowups();
    this.refreshLiveDelegationTools();
    this.notify();
    return canonical;
  }

  private canonicalPresetName(name: string): string | undefined {
    return this.options.config.presets.find((preset) => preset.name.toLowerCase() === name.toLowerCase())?.name;
  }

  private resolveRoles(presetName: string | undefined): AgentRole[] {
    return resolvePreset(this.options.config, presetName).roles.map((role) => {
      const override = this.options.roleOverride?.(presetName, role.name);
      if (!override) return role;
      const model = override.model && override.model !== role.model ? override.model : undefined;
      const thinking = override.thinking && override.thinking !== role.thinking ? override.thinking : undefined;
      return model || thinking
        ? { ...role, ...(model ? { model } : {}), ...(thinking ? { thinking } : {}) }
        : role;
    });
  }

  /** Re-read persisted role overrides. Running invocations keep their existing sessions. */
  refreshRoles(): void {
    this.effectiveRoles = this.resolveRoles(this.activeModeValue);
    this.rejectDisabledFollowups();
    this.refreshLiveDelegationTools();
    this.notify();
  }

  /**
   * Re-point extension-bound hooks after a session reload. A reload keeps the
   * process alive, so in-flight child sessions keep running; this re-binds
   * persistence, heading generation, account routing, the model registry, and
   * the loaded config to the live extension instance that adopted this runtime.
   */
  rebindForReload(rebind: RuntimeReloadRebind): void {
    Object.assign(this.options, rebind);
  }

  /**
   * Drop the cached shared model runtime so the next child session builds a
   * fresh one: reload resets the provider registry, so the old instance may
   * hold stale provider state. In-flight sessions keep their own runtime.
   */
  resetModelRuntime(): void {
    this.modelRuntime = undefined;
    this.modelRuntimePromise = undefined;
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /**
   * One shared model/auth runtime for the whole delegation tree, lazily bound
   * to the same agentDir auth.json/models.json the host session uses.
   */
  private async getModelRuntime(): Promise<ModelRuntime> {
    if (!this.modelRuntimePromise) {
      const agentDir = getAgentDir();
      this.modelRuntimePromise = ModelRuntime.create({
        authPath: path.join(agentDir, "auth.json"),
        modelsPath: path.join(agentDir, "models.json"),
      });
    }
    return this.modelRuntimePromise;
  }

  /**
   * Launch a root batch. The batch gets its own abort controller so it can be
   * stopped later by id through {@link cancelRootBatch} while still honouring
   * a caller-supplied signal (synchronous delegation). Foreground batches
   * (`detached: false`) additionally register as promotable: while they run,
   * {@link promoteRootBatch} detaches them into the background delivery path.
   */
  startRootBatch(
    requests: SubagentRequest[],
    signal?: AbortSignal,
    onProgress?: (result: BatchResult) => void,
    detached = true,
  ): BackgroundBatchLaunch {
    this.validateBatch(requests);
    const batchId = this.nextBatchId();
    const createdAt = Date.now();
    this.record({ type: "batch.started", batch: { id: batchId, createdAt, ...(detached ? { detached: true } : {}) } });
    const callId = randomUUID();
    this.record({ type: "delegation.started", call: { id: callId, batchId, createdAt } });
    const progress = () => onProgress?.(this.snapshotBatch(batchId, undefined, createdAt));
    const unsubscribe = onProgress ? this.subscribe(progress) : undefined;
    const controller = new AbortController();
    this.batchCancels.set(batchId, controller);
    let removeCallerListener: (() => void) | undefined;
    let callerAbortListener: (() => void) | undefined;
    if (signal) {
      const abortFromCaller = () => controller.abort(signal.reason);
      callerAbortListener = abortFromCaller;
      if (signal.aborted) abortFromCaller();
      else signal.addEventListener("abort", abortFromCaller, { once: true });
      removeCallerListener = () => signal.removeEventListener("abort", abortFromCaller);
    }
    const completion = this.runBatch(requests, { batchId, callId, depth: 0 }, controller.signal)
      .then((result) => {
        const persisted = this.resultsForBatch(batchId);
        const persistedIds = new Set(persisted.map((run) => run.invocationId));
        return {
          ...result,
          allRuns: [...persisted, ...result.runs.filter((run) => !persistedIds.has(run.invocationId))],
          durationMs: Date.now() - createdAt,
        };
      })
      .finally(() => {
        unsubscribe?.();
        removeCallerListener?.();
        this.batchCancels.delete(batchId);
        this.promotableBatches.delete(batchId);
      });
    const launch = { batchId, completion };
    if (!detached) {
      let resolve!: (receipt: PromotedBatchReceipt) => void;
      const promise = new Promise<PromotedBatchReceipt>((res) => { resolve = res; });
      this.promotableBatches.set(batchId, {
        launch,
        controller,
        ...(signal && callerAbortListener ? { callerSignal: signal, callerListener: callerAbortListener } : {}),
        promise,
        resolve,
        agentCount: requests.length,
        promoted: false,
      });
    }
    return launch;
  }

  /**
   * Foreground root batches that are still running, oldest first, with their
   * promotion state. Integration (e.g. an Alt+B keybinding) lists these to
   * pick a batch id for {@link promoteRootBatch}.
   */
  promotableRootBatches(): Array<{ batchId: string; agentCount: number; promoted: boolean }> {
    return [...this.promotableBatches.values()].map((entry) => ({
      batchId: entry.launch.batchId,
      agentCount: entry.agentCount,
      promoted: entry.promoted,
    }));
  }

  /**
   * Promote a running foreground root batch to the background. The batch keeps
   * running untouched: the caller's abort signal is detached (later caller
   * aborts no longer cancel it), the synchronous waiter is released with a
   * {@link PromotedBatchReceipt} through the run's own promise, and the batch is
   * marked detached so the standard background result machinery (launch
   * completion plus settled-batch redelivery) delivers the outcome exactly
   * once. Promoting an already-promoted batch is idempotent and returns the
   * same launch. Returns `settled` when the batch finished before promotion
   * (its full result already went to the synchronous caller; never marked
   * detached, so it cannot double-deliver), or `not-found` for unknown,
   * detached, or already-settled ids.
   */
  promoteRootBatch(batchId: string): RootBatchPromotion {
    const entry = this.promotableBatches.get(batchId);
    if (!entry) {
      const record = this.state.batches.get(batchId);
      if (record && !record.detached) return { status: "settled", batchId };
      return { status: "not-found", batchId };
    }
    if (!entry.promoted) {
      entry.promoted = true;
      if (entry.callerSignal && entry.callerListener) {
        entry.callerSignal.removeEventListener("abort", entry.callerListener);
      }
      this.record({ type: "batch.promoted", batchId, promotedAt: Date.now() });
      entry.resolve({ promoted: true, batchId, agentCount: entry.agentCount });
    }
    return { status: "promoted", batchId, launch: entry.launch };
  }

  /** Execute the unified inspect/cancel control contract without launching or steering work. */
  controlAction(request: ControlRequest, callerHandle?: string): ControlResult {
    if (request.action === "inspect") return this.inspectTarget(request.target, callerHandle);
    const scope = "agent" in request.target ? "agent" : "batch" in request.target ? "batch" : "all";
    let stopped = 0;
    if ("agent" in request.target) {
      this.assertControlAccess(request.target.agent, callerHandle);
      stopped = this.cancelAgent(request.target.agent) ? 1 : 0;
    } else if ("batch" in request.target) {
      const batchId = request.target.batch;
      if (callerHandle) {
        const owned = this.ownedLiveAgents(callerHandle).filter((agent) =>
          [...this.state.invocations.values()].some((invocation) => invocation.agent === agent && invocation.batchId === batchId),
        );
        if (owned.length === 0) throw new Error(`Agent ${callerHandle} cannot control batch ${batchId}.`);
        for (const agent of owned) if (this.cancelAgent(agent)) stopped += 1;
      } else {
        stopped = this.cancelRootBatch(request.target.batch) ? 1 : 0;
      }
    } else if (callerHandle) {
      for (const agent of this.ownedLiveAgents(callerHandle)) if (this.cancelAgent(agent)) stopped += 1;
    } else {
      stopped = this.cancelAllRuns();
    }
    return { action: "cancel", target: request.target, status: stopped > 0 ? "cancelled" : "not-found", scope, ...(stopped > 0 ? { stopped } : {}) };
  }

  private inspectTarget(target: ControlRequest["target"], callerHandle?: string): ControlResult & { action: "inspect" } {
    const maxItems = 10;
    let agents: string[];
    let batchFilter: string | undefined;
    if ("agent" in target) {
      this.assertControlAccess(target.agent, callerHandle);
      agents = [target.agent];
    } else if ("batch" in target) {
      batchFilter = target.batch;
      agents = [...this.state.invocations.values()]
        .filter((invocation) => invocation.batchId === target.batch && (!callerHandle || this.ownerOfAgent(invocation.agent) === callerHandle))
        .map((invocation) => invocation.agent);
      agents = [...new Set(agents)];
      if (agents.length === 0) throw new Error(`No accessible work exists in batch ${target.batch}.`);
    } else {
      agents = callerHandle ? this.ownedLiveAgents(callerHandle) : [...this.state.agents.keys()];
    }
    const unique = [...new Set(agents)];
    const truncated = unique.length > maxItems;
    const selected = unique.slice(0, maxItems);
    const details = selected.map((handle) => this.inspectAgent(handle));
    const batchIds = batchFilter ? [batchFilter] : [...new Set(selected.map((handle) => this.latestInvocation(handle)?.batchId).filter((id): id is string => Boolean(id)))];
    const batches = batchIds.slice(0, maxItems).map((id) => this.inspectBatch(id, callerHandle));
    return { action: "inspect", target, agents: details, batches, truncated: truncated || batchIds.length > maxItems };
  }

  private ownedLiveAgents(callerHandle: string): string[] {
    const live = [...this.state.invocations.values()]
      .filter((invocation) => (invocation.status === "queued" || invocation.status === "running") && this.ownerOfAgent(invocation.agent) === callerHandle)
      .map((invocation) => invocation.agent);
    const pending = [...this.followupTasks.values()]
      .filter((task) => task.status === "accepted" && task.state !== "consumed" && this.ownerOfAgent(task.agent) === callerHandle)
      .map((task) => task.agent);
    return [...new Set([...live, ...pending])];
  }

  private assertControlAccess(handle: string, callerHandle?: string): void {
    if (!this.state.agents.has(handle)) throw new Error(`Unknown agent handle: ${handle}.`);
    if (callerHandle && this.ownerOfAgent(handle) !== callerHandle) {
      throw new Error(`Agent ${callerHandle} can only control agents it spawned.`);
    }
  }

  private latestInvocation(handle: string): InvocationRecord | undefined {
    return [...this.state.invocations.values()].filter((invocation) => invocation.agent === handle).sort((a, b) => b.queuedAt - a.queuedAt)[0];
  }

  private inspectAgent(handle: string): AgentInspection {
    const invocation = this.latestInvocation(handle);
    const record = this.state.agents.get(handle)!;
    const now = Date.now();
    const pending = [...this.followupTasks.values()].filter((task) => task.agent === handle && task.status === "accepted");
    const session = this.liveSessions.get(handle);
    const visible = session ? lastAssistant(session.messages) : undefined;
    const lastMessage = visible ? preview(assistantText(visible), 160) : "";
    const activity = invocation ? this.activities.get(invocation.id) : undefined;
    const activeCallId = invocation ? [...(this.activeToolCalls.get(invocation.id)?.keys() ?? [])].at(-1) : undefined;
    const call = activeCallId ? this.toolExecutions.get(handle)?.get(activeCallId) : undefined;
    const args = call?.args;
    const detail = args && typeof args === "object" && !Array.isArray(args)
      ? call?.toolName === "bash" && "command" in args && typeof args.command === "string" ? args.command
        : ["read", "write", "edit"].includes(call?.toolName ?? "") && "path" in args && typeof args.path === "string" ? args.path
        : undefined
      : undefined;
    return {
      agent: handle,
      role: preview(record.role, 80),
      status: invocation?.status ?? "idle",
      ...(invocation ? { taskPreview: preview(invocation.task, 120), elapsedMs: Math.max(0, (invocation.finishedAt ?? now) - (invocation.startedAt ?? invocation.queuedAt)) } : {}),
      ...(activity ? { activity: selectedActivity({ ...activity, detail: detail ?? activity.detail }) } : {}),
      ...(lastMessage ? { lastMessage } : {}),
      pendingSteering: pending.filter((task) => task.delivery === "steer").slice(0, 5).map(pendingItem),
      pendingQueue: pending.filter((task) => task.delivery === "queue").slice(0, 5).map(pendingItem),
    };
  }

  private inspectBatch(batchId: string, callerHandle?: string): BatchInspection {
    const batch = this.state.batches.get(batchId);
    const invocations = [...this.state.invocations.values()].filter((invocation) => invocation.batchId === batchId && (!callerHandle || this.ownerOfAgent(invocation.agent) === callerHandle));
    const live = invocations.filter((invocation) => invocation.status === "queued" || invocation.status === "running");
    const started = invocations.map((invocation) => invocation.startedAt ?? invocation.queuedAt).sort((a, b) => a - b)[0];
    const finished = live.length === 0 ? Math.max(...invocations.map((invocation) => invocation.finishedAt ?? invocation.startedAt ?? invocation.queuedAt)) : Date.now();
    return {
      batch: batchId,
      liveAgents: live.length,
      totalAgents: invocations.length,
      status: !batch ? "unknown" : live.length > 0 ? "running" : "settled",
      ...(started !== undefined ? { elapsedMs: Math.max(0, finished - started) } : {}),
    };
  }

  /**
   * Abort a running root batch by id. Every invocation in the batch — including
   * nested delegations, which abort through their live child sessions — settles
   * as cancelled and the detached completion resolves so the background
   * follow-up still reports. Returns false when no live batch has this id
   * (unknown or already settled).
   */
  cancelRootBatch(batchId: string): boolean {
    const controller = this.batchCancels.get(batchId);
    const followupGroup = this.followupGroups.get(batchId);
    let changed = false;
    if (controller && !controller.signal.aborted) {
      controller.abort(new Error(`Background batch ${batchId} cancelled by the parent session.`));
      changed = true;
    }
    if (followupGroup && !followupGroup.controller.signal.aborted) {
      followupGroup.controller.abort(new Error(`Queued follow-up batch ${batchId} cancelled by the parent session.`));
      changed = true;
    }
    for (const task of this.followupTasks.values()) {
      if (task.batchId === batchId && task.status === "accepted" && task.state !== "consumed") {
        this.rejectFollowup(task, `Batch ${batchId} was cancelled before this follow-up was consumed.`);
        changed = true;
      }
    }
    return changed;
  }

  /**
   * Abort a single live child agent by its handle, leaving the rest of its
   * batch running. Returns false when no live invocation owns that handle
   * (unknown, queued elsewhere, or already settled).
   */
  cancelAgent(handle: string): boolean {
    const cleared = this.clearFollowups(handle, `Agent ${handle} cancelled before this follow-up was consumed.`);
    const controller = this.agentCancels.get(handle);
    if (!controller || controller.signal.aborted) return cleared;
    controller.abort(new Error(`Agent ${handle} cancelled by the parent session.`));
    return true;
  }

  /**
   * Stop a root background batch by its receipt batchId, or a single live
   * agent by its handle. Returns the scope that was stopped, or undefined
   * when the target matched nothing live. Handles and batch ids cannot
   * collide: handles are slug-number (`vigil-1`), batch ids are `batch-N`.
   */
  cancelRootTarget(target: string): "batch" | "agent" | undefined {
    if (this.cancelAgent(target)) return "agent";
    if (this.cancelRootBatch(target)) return "batch";
    return undefined;
  }

  /**
   * Abort every live root batch and every live child agent — background and
   * foreground alike; each invocation, nested delegation included, settles as
   * cancelled and every live batch completion resolves so results still
   * report. Returns how many distinct controllers were stopped; agents already
   * aborted through their batch are not counted twice. Returns 0 when nothing
   * is live.
   */
  cancelAllRuns(): number {
    let stopped = 0;
    for (const [batchId, controller] of [...this.batchCancels]) {
      if (!controller.signal.aborted) {
        controller.abort(new Error(`Background batch ${batchId} cancelled by the parent session.`));
        stopped += 1;
      }
    }
    for (const [handle, controller] of [...this.agentCancels]) {
      if (!controller.signal.aborted) {
        this.clearFollowups(handle, `Agent ${handle} cancelled before this follow-up was consumed.`);
        controller.abort(new Error(`Agent ${handle} cancelled by the parent session.`));
        stopped += 1;
      }
    }
    for (const group of this.followupGroups.values()) {
      if (!group.controller.signal.aborted) {
        group.controller.abort(new Error("All queued follow-up work was cancelled."));
        stopped += 1;
      }
    }
    for (const [handle, queue] of this.followupQueues) {
      if (queue.length > 0) {
        this.clearFollowups(handle, `All agents cancelled before this follow-up was consumed.`);
        stopped += 1;
      }
    }
    return stopped;
  }

  /**
   * Results of detached root batches whose invocations have all settled,
   * oldest first. Used to re-deliver follow-up results that were queued while
   * the parent was streaming and then lost — for example when the turn was
   * interrupted before the host drained its follow-up queue.
   */
  settledDetachedBatches(): Array<{ batchId: string; result: BatchResult }> {
    const settled: Array<{ batchId: string; createdAt: number; result: BatchResult }> = [];
    for (const batch of this.state.batches.values()) {
      if (!batch.detached) continue;
      const invocations = [...this.state.invocations.values()].filter((item) => item.batchId === batch.id);
      if (
        invocations.length === 0 ||
        invocations.some((item) => item.status === "queued" || item.status === "running")
      ) {
        continue;
      }
      const runs = this.resultsForBatch(batch.id);
      const finishedAt = Math.max(0, ...invocations.map((item) => item.finishedAt ?? 0));
      settled.push({
        batchId: batch.id,
        createdAt: batch.createdAt,
        result: { batchId: batch.id, runs, allRuns: runs, durationMs: Math.max(0, finishedAt - batch.createdAt) },
      });
    }
    return settled.sort((left, right) => left.createdAt - right.createdAt)
      .map(({ batchId, result }) => ({ batchId, result }));
  }

  /**
   * Session-scoped sequential root batch id (`batch-1`, `batch-2`, ...).
   * The counter resumes past ids restored from persisted state, and the
   * uniqueness loop guards the rare case of a fresh runtime adopting state
   * whose batches were recorded out of order.
   */
  private nextBatchId(): string {
    let batchId: string;
    do {
      this.batchCounter += 1;
      batchId = `batch-${this.batchCounter}`;
    } while (this.state.batches.has(batchId) || this.batchCancels.has(batchId));
    return batchId;
  }

  /**
   * Run a foreground root batch: resolve with the full {@link BatchResult} when
   * the batch settles, or — if {@link promoteRootBatch} detached it first —
   * release the waiter early with a distinguishable {@link PromotedBatchReceipt}
   * while the batch continues into the background result machinery.
   */
  async runRootBatch(requests: SubagentRequest[], signal?: AbortSignal, onProgress?: (result: BatchResult) => void): Promise<BatchResult | PromotedBatchReceipt> {
    const launch = this.startRootBatch(requests, signal, onProgress, false);
    const entry = this.promotableBatches.get(launch.batchId);
    return entry ? Promise.race([launch.completion, entry.promise]) : launch.completion;
  }

  /** Validate fresh launches and follow-up control messages without accepting any item. */
  validateSubmission(requests: SubagentRequest[]): void {
    this.validateBatch(requests);
    for (const request of requests) {
      if (!this.isFollowup(request)) continue;
      const session = this.liveSessions.get(request.agent);
      for (const item of request.messages) {
        if (item.delivery === "steer" && request.timeoutMinutes !== undefined) {
          throw new Error("Steering follow-ups cannot change timeoutMinutes.");
        }
        if (item.delivery === "steer" && (!session || !session.isStreaming)) {
          throw new Error(`Cannot steer idle agent ${request.agent}.`);
        }
      }
    }
  }

  /** Accept a complete follow-up submission and return immediate per-message receipts. */
  submitFollowups(requests: FollowupRequest[], context?: InvocationContext, detached = false): FollowupBatchResult {
    this.validateSubmission(requests);
    const queueItems = requests.flatMap((request) => request.messages.filter((item) => (item.delivery ?? "queue") === "queue"));
    let group: FollowupGroup | undefined;
    if (queueItems.length > 0) {
      const batchId = this.nextBatchId();
      const callId = randomUUID();
      const startedAt = Date.now();
      let resolve!: (result: BatchResult) => void;
      const promise = new Promise<BatchResult>((res) => { resolve = res; });
      group = { batchId, callId, ...(context ? { context } : {}), pending: new Set(), results: [], resolve, promise, startedAt, detached, controller: new AbortController() };
      this.followupGroups.set(batchId, group);
      this.record({ type: "batch.started", batch: { id: batchId, createdAt: startedAt, ...(detached ? { detached: true } : {}) } });
      this.record({ type: "delegation.started", call: { id: callId, batchId, createdAt: startedAt, ...(context?.parentInvocationId ? { parentInvocationId: context.parentInvocationId } : {}) } });
      if (detached) this.options.deliverQueuedBatch?.({ batchId, completion: promise });
    }
    const receipts: FollowupReceipt[] = [];
    let requestIndex = 0;
    for (const request of requests) {
      const session = this.liveSessions.get(request.agent);
      for (const item of request.messages) {
        const id = this.nextFollowupId();
        const delivery = item.delivery ?? "queue";
        const task: QueuedFollowup = {
          id,
          agent: request.agent,
          delivery,
          status: "accepted",
          state: delivery === "steer" ? "steering" : "queued",
          message: item.message.trim(),
          ...(request.timeoutMinutes === undefined ? {} : { timeoutMinutes: request.timeoutMinutes }),
          ...(group ? { batchId: group.batchId, groupId: group.batchId, requestIndex } : {}),
          ...(context === undefined ? {} : { context }),
        };
        this.followupTasks.set(id, task);
        if (group && delivery === "queue") group.pending.add(id);
        receipts.push({ id, agent: request.agent, delivery, status: "accepted", state: task.state });
        if (delivery === "steer") {
          // AgentSession.steer queues the actual user message and never aborts
          // the current tool command; consumption is observed at message_start.
          void session!.steer(task.message).catch((error) => this.rejectFollowup(task, errorMessage(error)));
        } else {
          let queue = this.followupQueues.get(request.agent);
          if (!queue) {
            queue = [];
            this.followupQueues.set(request.agent, queue);
          }
          queue.push(task);
        }
        requestIndex += 1;
      }
      void this.drainFollowupQueue(request.agent);
    }
    if (group && group.pending.size === 0) this.finishFollowupGroup(group);
    return { followups: receipts.map((receipt) => ({ ...receipt, message: undefined })), ...(group ? { completion: group.promise } : {}) };
  }

  private nextFollowupId(): string {
    this.followupCounter += 1;
    return `followup-${this.followupCounter}`;
  }

  private isFollowup(request: SubagentRequest): request is FollowupRequest {
    return "messages" in request;
  }

  private rejectFollowup(task: QueuedFollowup, message: string): void {
    task.status = "rejected";
    task.state = "rejected";
    task.message = message;
    if (task.groupId && task.requestIndex !== undefined) {
      const group = this.followupGroups.get(task.groupId);
      if (group?.pending.delete(task.id)) {
        group.results[task.requestIndex] = {
          invocationId: `queued-${task.id}`,
          agent: task.agent,
          role: this.state.agents.get(task.agent)?.role ?? "Agent",
          status: "cancelled",
          durationMs: 0,
          error: message,
          usage: { ...ZERO_USAGE },
        };
        if (group.pending.size === 0) this.finishFollowupGroup(group);
      }
    }
    this.notify();
  }

  private finishFollowupTask(task: QueuedFollowup, result: InvocationResult): void {
    if (!task.groupId || task.requestIndex === undefined) return;
    const group = this.followupGroups.get(task.groupId);
    if (!group || !group.pending.delete(task.id)) return;
    group.results[task.requestIndex] = result;
    if (group.pending.size === 0) this.finishFollowupGroup(group);
  }

  private finishFollowupGroup(group: FollowupGroup): void {
    if (!this.followupGroups.has(group.batchId)) return;
    this.followupGroups.delete(group.batchId);
    const runs = group.results.filter((result): result is InvocationResult => result !== undefined);
    const result = { batchId: group.batchId, runs, allRuns: runs, durationMs: Date.now() - group.startedAt };
    group.resolve(result);
    if (group.context?.parentInvocationId) {
      const parent = this.state.invocations.get(group.context.parentInvocationId);
      const parentSession = parent ? this.liveSessions.get(parent.agent) : undefined;
      if (parentSession) void parentSession.followUp(formatQueuedResult(result)).catch(() => {});
    }
  }

  private consumeFollowup(handle: string, text: string): void {
    const task = [...this.followupTasks.values()].find((candidate) =>
      candidate.agent === handle && candidate.status === "accepted" && candidate.message === text,
    );
    if (!task) return;
    task.state = "consumed";
    this.notify();
  }

  private clearFollowups(handle: string, reason: string): boolean {
    let changed = false;
    const queued = this.followupQueues.get(handle);
    if (queued?.length) {
      for (const task of queued) {
        this.rejectFollowup(task, reason);
        changed = true;
      }
      queued.length = 0;
      this.followupQueues.delete(handle);
    }
    const session = this.liveSessions.get(handle);
    if (session && (session.pendingMessageCount > 0 || session.getSteeringMessages().length > 0 || session.getFollowUpMessages().length > 0)) {
      const cleared = session.clearQueue();
      const texts = new Set([...cleared.steering, ...cleared.followUp]);
      for (const task of this.followupTasks.values()) {
        if (task.agent === handle && task.status === "accepted" && task.state !== "consumed" && texts.has(task.message)) {
          this.rejectFollowup(task, reason);
          changed = true;
        }
      }
    }
    return changed;
  }

  private async drainFollowupQueue(handle: string): Promise<void> {
    if (this.followupDrain.has(handle) || this.isAgentBusy(handle)) return;
    const queue = this.followupQueues.get(handle);
    if (!queue?.length) return;
    this.followupDrain.add(handle);
    try {
      while (queue.length && !this.isAgentBusy(handle)) {
        const task = queue.shift()!;
        if (task.status !== "accepted") continue;
        const batchId = task.batchId!;
        const group = task.groupId ? this.followupGroups.get(task.groupId) : undefined;
        const callId = group?.callId ?? randomUUID();
        task.state = "consumed";
        this.notify();
        const request = { agent: handle, messages: [{ message: task.message, delivery: "queue" as const }], ...(task.timeoutMinutes === undefined ? {} : { timeoutMinutes: task.timeoutMinutes }) };
        try {
          const result = await this.runInvocation(
            request,
            group?.context
              ? { batchId, callId, depth: group.context.depth, ...(group.context.parentInvocationId ? { parentInvocationId: group.context.parentInvocationId } : {}) }
              : { batchId, callId, depth: 0 },
            task.requestIndex ?? 0,
            group?.controller.signal,
          );
          this.finishFollowupTask(task, result);
        } catch (error) {
          this.rejectFollowup(task, errorMessage(error));
        }
        if (!this.isAgentBusy(handle)) continue;
      }
    } finally {
      this.followupDrain.delete(handle);
      if (!queue.length) this.followupQueues.delete(handle);
    }
  }

  async runNestedBatch(
    requests: SubagentRequest[],
    context: InvocationContext,
    parentLease: CapacityLease,
    signal?: AbortSignal,
    onProgress?: (result: BatchResult) => void,
  ): Promise<BatchResult> {
    this.validateBatch(requests);
    const startedAt = Date.now();
    const callId = randomUUID();
    this.record({
      type: "delegation.started",
      call: {
        id: callId,
        batchId: context.batchId,
        ...(context.parentInvocationId ? { parentInvocationId: context.parentInvocationId } : {}),
        createdAt: startedAt,
      },
    });
    const callContext = { ...context, callId };
    const progress = () => onProgress?.(this.snapshotBatch(context.batchId, context.parentInvocationId, startedAt));
    const unsubscribe = onProgress ? this.subscribe(progress) : undefined;
    parentLease.suspend();
    try {
      return await this.runBatch(requests, callContext, signal);
    } finally {
      unsubscribe?.();
      await parentLease.resume(signal);
    }
  }

  private async runBatch(
    requests: SubagentRequest[],
    context: InvocationContext,
    signal?: AbortSignal,
  ): Promise<BatchResult> {
    const startedAt = Date.now();
    const pending = requests.map((request, requestIndex) => this.trackInvocation(request, context, requestIndex, signal));
    this.startHeadingGeneration(requests, context);
    const settled = await Promise.allSettled(pending);
    const runs = settled.map((result, requestIndex) =>
      result.status === "fulfilled"
        ? result.value
        : this.failedInvocationResult(requests[requestIndex]!, context, requestIndex, startedAt, result.reason)
    );
    return { batchId: context.batchId, runs, allRuns: runs, durationMs: Date.now() - startedAt };
  }

  private failedInvocationResult(
    request: SubagentRequest,
    context: InvocationContext,
    requestIndex: number,
    startedAt: number,
    error: unknown,
  ): InvocationResult {
    const invocation = [...this.state.invocations.values()].find((candidate) =>
      candidate.callId === context.callId && candidate.requestIndex === requestIndex
    );
    const role = invocation?.role ?? ("role" in request
      ? this.effectiveRoles.find((candidate) => candidate.name.toLowerCase() === request.role.toLowerCase())?.name ?? request.role
      : this.state.agents.get(request.agent)?.role ?? "Agent");
    const slug = role.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "agent";
    return {
      invocationId: invocation?.id ?? `unstarted-${context.callId ?? context.batchId}-${requestIndex}`,
      agent: invocation?.agent ?? ("agent" in request ? request.agent : `${slug}-unstarted`),
      role,
      status: "failed",
      durationMs: Date.now() - startedAt,
      error: errorMessage(error),
      usage: { ...ZERO_USAGE },
    };
  }

  private trackInvocation(
    request: SubagentRequest,
    context: InvocationContext,
    requestIndex: number,
    signal?: AbortSignal,
  ): Promise<InvocationResult> {
    const pending = this.runInvocation(request, context, requestIndex, signal);
    this.pendingInvocations.add(pending);
    void pending.then(
      () => this.pendingInvocations.delete(pending),
      () => this.pendingInvocations.delete(pending),
    );
    return pending;
  }

  private async runInvocation(
    request: SubagentRequest,
    context: InvocationContext,
    requestIndex: number,
    signal?: AbortSignal,
  ): Promise<InvocationResult> {
    let resolved: ResolvedRequest;
    let sessionManager: SessionManager;

    if ("role" in request) {
      const role = this.resolveRole(request.role);
      const timeoutMinutes = this.resolveTimeout(request.timeoutMinutes, role);
      const handle = this.allocateHandle(role.name);
      sessionManager = SessionManager.create(this.options.cwd, this.sessionDir(), {
        ...(this.options.rootSessionFile ? { parentSession: this.options.rootSessionFile } : {}),
      });
      const sessionFile = sessionManager.getSessionFile();
      if (!sessionFile) throw new Error("Pi did not create a persistent child session.");
      const agent: AgentRecord = {
        handle,
        role: role.name,
        sessionFile,
        createdAt: Date.now(),
      };
      this.reservedHandles.add(handle);
      this.record({ type: "agent.created", agent });
      resolved = {
        role,
        agent,
        task: request.task.trim(),
        timeoutMinutes,
        followup: false,
      };
    } else {
      const agent = this.state.agents.get(request.agent);
      if (!agent) throw new Error(`Unknown agent handle in this parent session: ${request.agent}.`);
      const role = this.resolveRole(agent.role);
      const timeoutMinutes = this.resolveTimeout(request.timeoutMinutes, role);
      sessionManager = SessionManager.open(agent.sessionFile, this.sessionDir(), this.options.cwd);
      const message = request.messages[0]?.message;
      if (!message) throw new Error("Follow-up messages must not be empty.");
      resolved = {
        role,
        agent,
        task: message.trim(),
        timeoutMinutes,
        followup: true,
      };
    }

    const invocation: InvocationRecord = {
      id: randomUUID(),
      batchId: context.batchId,
      ...(context.callId ? { callId: context.callId, requestIndex } : {}),
      agent: resolved.agent!.handle,
      role: resolved.role.name,
      task: resolved.task,
      followup: resolved.followup,
      ordinal: this.invocationCount(resolved.agent!.handle) + 1,
      ...(context.parentInvocationId ? { parentInvocationId: context.parentInvocationId } : {}),
      depth: context.depth + 1,
      status: "queued",
      queuedAt: Date.now(),
      timeoutMinutes: resolved.timeoutMinutes,
      usage: { ...ZERO_USAGE },
    };
    this.record({ type: "invocation.queued", invocation });

    let lease: CapacityLease | undefined;
    let session: AgentSession | undefined;
    let before: Usage = { ...ZERO_USAGE };
    let stopCause: "timeout" | "cancelled" | undefined;
    let activeTimeout: ActiveWorkTimeout | undefined;
    let abortSession: (() => void) | undefined;
    const controller = new AbortController();
    const cancel = (reason?: unknown) => {
      if (controller.signal.aborted) return;
      stopCause = "cancelled";
      activeTimeout?.dispose();
      controller.abort(reason);
    };
    const abortFromParent = () => cancel(signal?.reason);
    this.invocationCancels.add(cancel);
    this.agentCancels.set(resolved.agent!.handle, controller);
    if (signal) {
      if (signal.aborted) cancel(signal.reason);
      else signal.addEventListener("abort", abortFromParent, { once: true });
    }

    try {
      lease = await this.scheduler.acquire(controller.signal);
      controller.signal.throwIfAborted();
      // A request can sit in the scheduler after it was initially validated.
      // Re-check policy at execution time so newly disabled queued work never starts.
      if (this.isRoleDisabled(resolved.role.name)) {
        throw new Error(`Role ${resolved.role.name} is disabled in this session.`);
      }

      const { loader, settings } = await createRoleResourceLoader(
        this.options.cwd,
        resolved.role,
        this.options.accountExtension,
        this.options.routeAccountModel,
      );
      controller.signal.throwIfAborted();
      const leaseForNested = lease;
      const delegationPolicyAllowsControls = resolved.role.delegates.length > 0 && invocation.depth < this.options.config.defaults.maxDepth;
      const delegateRoles = delegationPolicyAllowsControls ? this.delegateRolesFor(resolved.role, invocation.depth) : [];
      const delegateConfig = delegationPolicyAllowsControls
        ? { ...this.options.config, roles: delegateRoles }
        : undefined;
      // The subagent schema is policy-dependent. It is rebuilt below when the
      // session starts and refreshed before every later child turn after a
      // disable or preset/override change.
      const tools = toolsForRole(resolved.role, invocation.depth, this.options.config.defaults.maxDepth);
      const customTools: ToolDefinition<any, any, any>[] = [];
      if (tools.includes("web_search")) customTools.push(createWebSearchTool());
      let delegationTool: ToolDefinition<any, any, any> | undefined;
      if (delegateConfig) {
        const nestedContext = {
          batchId: invocation.batchId,
          parentInvocationId: invocation.id,
          depth: invocation.depth,
        };
        const validateNested = (requests: SubagentRequest[]) => {
          const currentRole = this.effectiveRoles.find((candidate) => candidate.name.toLowerCase() === resolved.role.name.toLowerCase());
          this.assertNestedDelegation(
            requests,
            invocation.agent,
            currentRole ? this.delegateRolesFor(currentRole, invocation.depth).map((candidate) => candidate.name) : [],
          );
          this.validateSubmission(requests);
        };
        delegationTool = createSubagentTool(delegateConfig, async (requests, nestedSignal, onProgress) => {
          validateNested(requests);
          activeTimeout?.pause();
          controller.signal.throwIfAborted();
          try {
            return await this.runNestedBatch(requests, nestedContext, leaseForNested, nestedSignal, onProgress);
          } finally {
            if (!controller.signal.aborted) activeTimeout?.resume();
          }
        }, {
          validateRequests: validateNested,
          submitFollowups: (requests) => this.submitFollowups(requests, nestedContext),
          controlAction: (request) => this.controlAction(request, invocation.agent),
        });
        customTools.push(delegationTool);
      }
      const baseModel = this.findModel(resolved.role.model);
      const model = this.options.routeAccountModel?.(baseModel) ?? baseModel;

      const created = await createAgentSession({
        cwd: this.options.cwd,
        agentDir: getAgentDir(),
        modelRuntime: await this.getModelRuntime(),
        model,
        thinkingLevel: resolved.role.thinking,
        tools,
        customTools,
        resourceLoader: loader,
        sessionManager,
        settingsManager: settings,
      });
      session = created.session;
      abortSession = () => void session?.abort();
      controller.signal.addEventListener("abort", abortSession, { once: true });
      if (controller.signal.aborted) {
        abortSession();
        controller.signal.throwIfAborted();
      }
      this.liveSessions.set(invocation.agent, session);
      if (delegationTool) {
        this.liveDelegationRefreshers.set(invocation.agent, () => {
          const currentRole = this.effectiveRoles.find((candidate) => candidate.name.toLowerCase() === resolved.role.name.toLowerCase());
          const delegates = currentRole ? this.delegateRolesFor(currentRole, invocation.depth) : [];
          const controlsAllowed = resolved.role.delegates.length > 0 && invocation.depth < this.options.config.defaults.maxDepth;
          if (!controlsAllowed) {
            session!.setActiveToolsByName(session!.getActiveToolNames().filter((name) => name !== "subagent"));
            return;
          }
          const refreshedContext = { batchId: invocation.batchId, parentInvocationId: invocation.id, depth: invocation.depth };
          const fresh = createSubagentTool({ ...this.options.config, roles: delegates }, delegationTool!.execute as any, {
            validateRequests: (requests) => {
              this.assertNestedDelegation(requests, invocation.agent, delegates.map((candidate) => candidate.name));
              this.validateSubmission(requests);
            },
            submitFollowups: (requests) => this.submitFollowups(requests, refreshedContext),
            controlAction: (request) => this.controlAction(request, invocation.agent),
          });
          delegationTool!.parameters = fresh.parameters;
          delegationTool!.description = fresh.description;
          session!.setActiveToolsByName([...new Set([...session!.getActiveToolNames().filter((name) => name !== "subagent"), "subagent"])]);
        });
        this.liveDelegationRefreshers.get(invocation.agent)!();
      }
      before = sessionUsage(session);
      this.record({
        type: "invocation.running",
        id: invocation.id,
        startedAt: Date.now(),
        usageBaseline: before,
      });
      if (resolved.timeoutMinutes !== -1) {
        activeTimeout = new ActiveWorkTimeout(resolved.timeoutMinutes * 60_000, () => {
          if (controller.signal.aborted) return;
          stopCause = "timeout";
          controller.abort(new Error(`Timed out after ${resolved.timeoutMinutes} minute(s).`));
        });
        activeTimeout.resume();
      }
      const unsubscribe = session.subscribe((event) => {
        if (event.type === "message_start" && event.message.role === "user") {
          const text = typeof event.message.content === "string"
            ? event.message.content
            : event.message.content.filter((part) => part.type === "text").map((part) => part.text).join("");
          this.consumeFollowup(invocation.agent, text);
        }
        if (event.type === "tool_execution_start") {
          this.updateToolExecution(invocation.agent, event.toolCallId, event.toolName, {
            args: event.args,
            executionStarted: true,
            argsComplete: true,
            isPartial: true,
          });
          let calls = this.activeToolCalls.get(invocation.id);
          if (!calls) {
            calls = new Map();
            this.activeToolCalls.set(invocation.id, calls);
          }
          calls.set(event.toolCallId, event.toolName);
          this.syncToolActivity(invocation.id);
        } else if (event.type === "tool_execution_update") {
          this.updateToolExecution(invocation.agent, event.toolCallId, event.toolName, {
            args: event.args,
            executionStarted: true,
            argsComplete: true,
            result: { ...event.partialResult, isError: false },
            isPartial: true,
          });
        } else if (event.type === "tool_execution_end") {
          this.updateToolExecution(invocation.agent, event.toolCallId, event.toolName, {
            executionStarted: true,
            argsComplete: true,
            result: { ...event.result, isError: event.isError },
            isPartial: false,
          });
          const calls = this.activeToolCalls.get(invocation.id);
          calls?.delete(event.toolCallId);
          if (calls?.size === 0) this.activeToolCalls.delete(invocation.id);
          this.syncToolActivity(invocation.id);
        } else if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
          if (!this.activeToolCalls.has(invocation.id)) {
            const current = this.activities.get(invocation.id);
            if (current?.detail !== "responding" || current.tool !== undefined) {
              this.activities.set(invocation.id, { invocationId: invocation.id, detail: "responding" });
              this.notify();
            }
          }
        } else if (event.type === "message_end" && event.message.role === "assistant" && session) {
          const usage = usageWithPendingAssistant(usageDelta(sessionUsage(session), before), event.message);
          if (!sameUsage(invocation.usage, usage)) {
            invocation.usage = usage;
            advanceStateRevision(this.state);
            this.notify();
          }
        }
      });

      try {
        await session.prompt(resolved.task);
        await session.waitForIdle();
        if (endsWithEmptyFinal(session)) {
          // A turn that stops without any text is a silent/empty completion
          // (e.g. provider glitch returning content: []). The task may simply
          // be unfinished, so send one continuation prompt instead of asking
          // for a report (which would force a premature wrap-up) or treating
          // this as a failure.
          await session.prompt(EMPTY_FINAL_REPROMPT);
          await session.waitForIdle();
        }
        activeTimeout?.pause();
      } finally {
        unsubscribe();
      }

      const usage = usageDelta(sessionUsage(session), before);
      const final = lastAssistant(session.messages);
      if (controller.signal.aborted) {
        const timedOut = stopCause === "timeout";
        const error = timedOut
          ? `Timed out after ${resolved.timeoutMinutes} minute(s).`
          : "Cancelled by the parent session.";
        return this.finish(invocation.id, timedOut ? "failed" : "cancelled", usage, undefined, error);
      }
      if (!final) return this.finish(invocation.id, "failed", usage, undefined, "Agent produced no final response.");
      const output = assistantText(final);
      if (final.stopReason === "error" || final.stopReason === "aborted") {
        return this.finish(
          invocation.id,
          final.stopReason === "aborted" ? "cancelled" : "failed",
          usage,
          output || undefined,
          final.errorMessage ?? `Agent stopped with ${final.stopReason}.`,
        );
      }
      if ((final.stopReason === "stop" || final.stopReason === "length") && output === "") {
        return this.finish(
          invocation.id,
          "failed",
          usage,
          undefined,
          "Agent finished without producing a final response (empty completion). Resume or re-delegate the task to continue.",
        );
      }
      return this.finish(invocation.id, "complete", usage, output);
    } catch (error) {
      const usage = session ? usageDelta(sessionUsage(session), before) : { ...ZERO_USAGE };
      const timedOut = stopCause === "timeout";
      const cancelled = stopCause === "cancelled" || (controller.signal.aborted && !timedOut);
      return this.finish(
        invocation.id,
        cancelled ? "cancelled" : "failed",
        usage,
        undefined,
        timedOut ? `Timed out after ${resolved.timeoutMinutes} minute(s).` : errorMessage(error),
      );
    } finally {
      activeTimeout?.dispose();
      if (abortSession) controller.signal.removeEventListener("abort", abortSession);
      if (signal) signal.removeEventListener("abort", abortFromParent);
      this.invocationCancels.delete(cancel);
      this.agentCancels.delete(invocation.agent);
      const activityChanged = this.activities.delete(invocation.id);
      this.activeToolCalls.delete(invocation.id);
      this.liveSessions.delete(invocation.agent);
      this.liveDelegationRefreshers.delete(invocation.agent);
      this.toolExecutions.delete(invocation.agent);
      session?.dispose();
      lease?.release();
      void this.drainFollowupQueue(invocation.agent);
      if (activityChanged) this.notify();
    }
  }

  reconcileInterrupted(): void {
    for (const invocation of [...this.state.invocations.values()]) {
      if (invocation.status !== "queued" && invocation.status !== "running") continue;
      const agent = this.state.agents.get(invocation.agent);
      let usage = { ...ZERO_USAGE };
      if (agent) {
        try {
          const manager = SessionManager.open(agent.sessionFile, this.sessionDir(), this.options.cwd);
          usage = usageDelta(sessionEntriesUsage(manager.getEntries()), invocation.usageBaseline ?? ZERO_USAGE);
        } catch {
          // Keep zero usage when the child session cannot be recovered.
        }
      }
      this.record({
        type: "invocation.interrupted",
        id: invocation.id,
        finishedAt: Date.now(),
        usage,
        error: "Interrupted when the parent Pi session stopped.",
      });
    }
  }

  async shutdown(): Promise<void> {
    this.disposed = true;
    const reason = new Error("Subagent runtime is shutting down.");
    for (const controller of this.headingControllers) controller.abort(reason);
    this.headingControllers.clear();
    for (const cancel of [...this.invocationCancels]) cancel(reason);
    for (const controller of this.batchCancels.values()) controller.abort(reason);
    this.batchCancels.clear();
    this.agentCancels.clear();
    await Promise.allSettled([...this.liveSessions.values()].map((session) => session.abort()));
    await Promise.allSettled([...this.pendingInvocations]);
    for (const session of this.liveSessions.values()) session.dispose();
    this.liveSessions.clear();
    this.liveDelegationRefreshers.clear();
    this.toolExecutions.clear();
  }

  private finish(
    id: string,
    status: "complete" | "failed" | "cancelled",
    usage: Usage,
    output?: string,
    error?: string,
  ): InvocationResult {
    this.record({
      type: "invocation.finished",
      id,
      status,
      finishedAt: Date.now(),
      usage,
      ...(error === undefined ? {} : { error }),
    });
    const invocation = this.state.invocations.get(id)!;
    return {
      invocationId: id,
      agent: invocation.agent,
      role: invocation.role,
      status,
      durationMs: Math.max(0, (invocation.finishedAt ?? invocation.startedAt ?? invocation.queuedAt) - (invocation.startedAt ?? invocation.queuedAt)),
      ...(output === undefined ? {} : { output }),
      ...(error === undefined ? {} : { error }),
      usage,
    };
  }

  private record(event: SubagentEvent): void {
    applyEvent(this.state, event);
    try {
      this.options.appendEvent(event);
    } catch {
      // The session API can be invalidated by a reload or session replacement
      // while child work is still settling. The event stays applied to the
      // in-memory state and is buffered or replayed across the handoff.
    }
    this.notify();
  }

  private notify(): void {
    for (const listener of this.listeners) listener();
  }

  private updateToolExecution(
    handle: string,
    toolCallId: string,
    toolName: string,
    update: Partial<Omit<RuntimeToolExecution, "toolCallId" | "toolName" | "revision">>,
  ): void {
    let calls = this.toolExecutions.get(handle);
    if (!calls) {
      calls = new Map();
      this.toolExecutions.set(handle, calls);
    }
    const previous = calls.get(toolCallId);
    calls.set(toolCallId, {
      toolCallId,
      toolName,
      args: update.args ?? previous?.args ?? {},
      executionStarted: update.executionStarted ?? previous?.executionStarted ?? false,
      argsComplete: update.argsComplete ?? previous?.argsComplete ?? false,
      ...(update.result !== undefined ? { result: update.result } : previous?.result !== undefined ? { result: previous.result } : {}),
      isPartial: update.isPartial ?? previous?.isPartial ?? true,
      revision: (previous?.revision ?? 0) + 1,
    });
  }

  private syncToolActivity(invocationId: string): void {
    const calls = this.activeToolCalls.get(invocationId);
    const previous = this.activities.get(invocationId);
    if (!calls?.size) {
      if (previous?.tool !== undefined && this.activities.delete(invocationId)) this.notify();
      return;
    }
    const tool = [...calls.values()].at(-1)!;
    const next: RuntimeActivity = { invocationId, tool, toolCount: calls.size };
    if (previous?.tool !== next.tool || previous?.toolCount !== next.toolCount || previous?.detail !== undefined) {
      this.activities.set(invocationId, next);
      this.notify();
    }
  }

  private startHeadingGeneration(requests: SubagentRequest[], context: InvocationContext): void {
    const generate = this.options.generateHeadings;
    if (!generate || !context.callId || this.disposed) return;
    const invocations = [...this.state.invocations.values()]
      .filter((invocation) => invocation.callId === context.callId)
      .sort((left, right) => (left.requestIndex ?? 0) - (right.requestIndex ?? 0));
    if (invocations.length !== requests.length) return;

    const controller = new AbortController();
    this.headingControllers.add(controller);
    void generate(
      invocations.map((invocation) => ({ role: invocation.role, task: invocation.task })),
      controller.signal,
    ).then((headings) => {
      if (!headings || headings.requests.length !== invocations.length || controller.signal.aborted || this.disposed) return;
      this.record({
        type: "delegation.headings",
        callId: context.callId!,
        callHeading: headings.call,
        requestHeadings: invocations.map((invocation, index) => ({
          invocationId: invocation.id,
          heading: headings.requests[index]!,
        })),
      });
    }).catch(() => {
      // UI naming is best-effort and must never affect delegated work.
    }).finally(() => {
      this.headingControllers.delete(controller);
    });
  }

  private validateBatch(requests: SubagentRequest[]): void {
    if (this.disposed) throw new Error("Subagent runtime is shut down.");
    if (requests.length === 0 || requests.length > 10) throw new Error("subagent requires between 1 and 10 agents.");

    const seenFresh = new Set<string>();
    for (const request of requests) {
      if ("role" in request) {
        if (!request.task.trim()) throw new Error("Agent tasks must not be blank.");
        const role = this.resolveRole(request.role);
        this.resolveTimeout(request.timeoutMinutes, role);
        const key = request.role.toLowerCase();
        if (seenFresh.has(key)) continue;
        seenFresh.add(key);
        continue;
      }

      if (!request.agent.trim()) throw new Error("Follow-up agent handles must not be blank.");
      if (!Array.isArray(request.messages) || request.messages.length === 0 || request.messages.length > 10) {
        throw new Error("Follow-up messages require between 1 and 10 items.");
      }
      const agent = this.state.agents.get(request.agent);
      if (!agent) throw new Error(`Unknown agent handle in this parent session: ${request.agent}.`);
      const role = this.resolveRole(agent.role);
      this.resolveTimeout(request.timeoutMinutes, role);
      for (const item of request.messages) {
        if (!item.message.trim()) throw new Error("Follow-up messages must not be blank.");
        if (item.delivery !== undefined && item.delivery !== "queue" && item.delivery !== "steer") {
          throw new Error("Follow-up delivery must be queue or steer.");
        }
      }
    }
  }

  private resolveRole(name: string): AgentRole {
    const role = this.effectiveRoles.find((candidate) => candidate.name.toLowerCase() === name.toLowerCase());
    if (!role) throw new Error(`Unknown configured role: ${name}.`);
    if (this.isRoleDisabled(role.name)) throw new Error(`Role ${role.name} is disabled in this session.`);
    return role;
  }

  /**
   * Roles one invocation may delegate to: the role's configured delegates below
   * max depth, minus session-disabled roles. Empty when delegation is off —
   * fresh child schemas then omit the subagent tool entirely, and nested
   * attempts to disabled roles still reject in {@link resolveRole} at launch.
   */
  private refreshLiveDelegationTools(): void {
    for (const refresh of this.liveDelegationRefreshers.values()) refresh();
  }

  private delegateRolesFor(role: AgentRole, depth: number): AgentRole[] {
    if (role.delegates.length === 0 || depth >= this.options.config.defaults.maxDepth) return [];
    const allowed = new Set(role.delegates.map((name) => name.toLowerCase()));
    return this.effectiveRoles.filter((candidate) => allowed.has(candidate.name.toLowerCase()) && !this.isRoleDisabled(candidate.name));
  }

  private resolveTimeout(requested: number | undefined, role: AgentRole): number {
    if (requested === undefined) {
      return role.timeoutMinutes ?? this.options.config.defaults.timeoutMinutes;
    }
    if (requested === -1) return -1;
    if (!Number.isSafeInteger(requested) || requested <= 0) {
      throw new Error("timeoutMinutes must be -1 or a positive integer.");
    }
    return requested;
  }

  private allocateHandle(roleName: string): string {
    const slug = roleName.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "agent";
    let next = 1;
    while (this.reservedHandles.has(`${slug}-${next}`)) next += 1;
    return `${slug}-${next}`;
  }

  private assertNestedDelegation(
    requests: SubagentRequest[],
    callerHandle: string,
    allowedRoles: Iterable<string>,
  ): void {
    const allowed = new Set([...allowedRoles].map((name) => name.toLowerCase()));
    for (const request of requests) {
      if ("role" in request) {
        if (!allowed.has(request.role.toLowerCase())) {
          throw new Error(`Agent ${callerHandle} cannot delegate to role ${request.role}.`);
        }
        continue;
      }
      const target = this.state.agents.get(request.agent);
      if (!target) throw new Error(`Unknown agent handle in this parent session: ${request.agent}.`);
      if (!allowed.has(target.role.toLowerCase())) {
        throw new Error(`Agent ${callerHandle} cannot follow up with role ${target.role}.`);
      }
      if (this.ownerOfAgent(request.agent) !== callerHandle) {
        throw new Error(`Agent ${callerHandle} can only follow up with agents it spawned.`);
      }
    }
  }

  private ownerOfAgent(handle: string): string | undefined {
    const origin = [...this.state.invocations.values()]
      .filter((item) => item.agent === handle)
      .sort((left, right) => left.queuedAt - right.queuedAt)[0];
    if (!origin?.parentInvocationId) return undefined;
    return this.state.invocations.get(origin.parentInvocationId)?.agent;
  }

  private snapshotBatch(batchId: string, parentInvocationId: string | undefined, startedAt: number): BatchResult {
    const allRuns = this.resultsForBatch(batchId);
    const directIds = new Set([...this.state.invocations.values()]
      .filter((item) => item.batchId === batchId && item.parentInvocationId === parentInvocationId)
      .map((item) => item.id));
    return { batchId, runs: allRuns.filter((run) => directIds.has(run.invocationId)), allRuns, durationMs: Date.now() - startedAt };
  }

  private resultsForBatch(batchId: string): InvocationResult[] {
    return [...this.state.invocations.values()]
      .filter((invocation) => invocation.batchId === batchId)
      .map((invocation) => ({
        invocationId: invocation.id,
        agent: invocation.agent,
        role: invocation.role,
        status: invocation.status,
        durationMs: Math.max(0, (invocation.finishedAt ?? Date.now()) - (invocation.startedAt ?? invocation.queuedAt)),
        ...(invocation.error ? { error: invocation.error } : {}),
        usage: invocation.usage,
      }));
  }

  private invocationCount(handle: string): number {
    let count = 0;
    for (const invocation of this.state.invocations.values()) if (invocation.agent === handle) count += 1;
    return count;
  }

  private isAgentBusy(handle: string): boolean {
    for (const invocation of this.state.invocations.values()) {
      if (invocation.agent === handle && (invocation.status === "queued" || invocation.status === "running")) return true;
    }
    return false;
  }

  private sessionDir(): string {
    return path.join(getAgentDir(), "subagent-sessions", this.options.rootSessionId);
  }

  private findModel(id: string) {
    const slash = id.indexOf("/");
    const provider = id.slice(0, slash);
    const modelId = id.slice(slash + 1);
    const model = this.options.modelRegistry.find(provider, modelId);
    if (!model) throw new Error(`Configured model is unavailable: ${id}.`);
    return model;
  }
}

export function toolsForRole(role: Pick<AgentRole, "tools" | "delegates">, depth: number, maxDepth: number): string[] {
  const tools = [...new Set([...role.tools, "context_memory"])];
  return role.delegates.length > 0 && depth < maxDepth ? [...tools, "subagent"] : tools;
}

function sessionUsage(session: AgentSession): Usage {
  const native = statsUsage(session.getSessionStats());
  const fallback = fallbackEntriesUsage(session.sessionManager.getEntries());
  return {
    input: native.input + fallback.input, output: native.output + fallback.output,
    cacheRead: native.cacheRead + fallback.cacheRead, cacheWrite: native.cacheWrite + fallback.cacheWrite,
    total: native.total + fallback.total, cost: native.cost + fallback.cost,
  };
}

function statsUsage(stats: SessionStats): Usage {
  return {
    input: stats.tokens.input,
    output: stats.tokens.output,
    cacheRead: stats.tokens.cacheRead,
    cacheWrite: stats.tokens.cacheWrite,
    total: stats.tokens.total,
    cost: stats.cost,
  };
}

/** Sent after a turn that produced no text; shared by the root-session guard. */
export const EMPTY_FINAL_REPROMPT =
  "Your previous turn ended without any output. Continue your current task from where you left off; do not summarize or report unless the work is genuinely complete.";

/**
 * True when the session's last assistant turn stopped without producing any text.
 * Covers both clean stops that arrive empty (provider glitch) and "length" stops
 * where hidden reasoning consumed the whole budget and content came back empty.
 */
export function endsWithEmptyFinal(session: { messages: readonly unknown[] }): boolean {
  const final = lastAssistant(session.messages);
  return (
    final !== undefined &&
    (final.stopReason === "stop" || final.stopReason === "length") &&
    assistantText(final) === ""
  );
}

function lastAssistant(messages: readonly unknown[]): AssistantMessage | undefined {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index] as { role?: unknown };
    if (message?.role === "assistant") return message as AssistantMessage;
  }
  return undefined;
}

function formatQueuedResult(result: BatchResult): string {
  const lines = result.runs.map((run) => {
    const heading = `[${run.role} · ${run.agent} · ${run.status}]`;
    return run.output ? `${heading}\n${run.output}` : `${heading}\n${run.error ?? "No output."}`;
  });
  return `[Queued follow-up · ${result.batchId} · settled]\n${lines.join("\n\n")}`;
}

function preview(value: string, limit: number): string {
  const compact = value.replace(/\s+/g, " ").trim();
  return compact.length <= limit ? compact : `${compact.slice(0, Math.max(0, limit - 1))}…`;
}

function pendingItem(task: { id: string; message: string }): InspectionPendingItem {
  return { id: task.id, preview: preview(task.message, 80) };
}

function selectedActivity(activity: RuntimeActivity): { tool?: string; detail?: string } {
  return {
    ...(activity.tool ? { tool: activity.tool } : {}),
    ...(activity.detail ? { detail: preview(activity.detail, 80) } : {}),
  };
}

function assistantText(message: AssistantMessage): string {
  return message.content
    .filter((part): part is Extract<AssistantMessage["content"][number], { type: "text" }> => part.type === "text")
    .map((part) => part.text)
    .join("\n")
    .trim();
}

export function usageWithPendingAssistant(persisted: Usage, message: Pick<AssistantMessage, "usage">): Usage {
  const native = message.usage;
  return {
    input: persisted.input + native.input,
    output: persisted.output + native.output,
    cacheRead: persisted.cacheRead + native.cacheRead,
    cacheWrite: persisted.cacheWrite + native.cacheWrite,
    total: persisted.total + native.input + native.output + native.cacheRead + native.cacheWrite,
    cost: persisted.cost + native.cost.total,
  };
}

function sameUsage(left: Usage, right: Usage): boolean {
  return left.input === right.input && left.output === right.output && left.cacheRead === right.cacheRead &&
    left.cacheWrite === right.cacheWrite && left.total === right.total && left.cost === right.cost;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Highest `batch-N` id restored from persisted state, so counters resume. */
function maxBatchCounter(state: RuntimeState): number {
  let max = 0;
  for (const id of state.batches.keys()) {
    const match = /^batch-(\d+)$/.exec(id);
    if (match) max = Math.max(max, Number(match[1]));
  }
  return max;
}
