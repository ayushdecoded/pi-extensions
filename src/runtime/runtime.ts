import * as path from "node:path";
import { readFileSync } from "node:fs";
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
import { advanceStateRevision, applyEvent, emptyRuntimeState, sessionEntriesUsage, usageDelta } from "./state.ts";
import { createRoleResourceLoader } from "./resources.ts";
import { ActiveWorkTimeout } from "./timeout.ts";
import { DevinAcpClient, isDevinBackend, type DevinAcpUpdate } from "./devin.ts";
import {
  ZERO_USAGE,
  type AgentRecord,
  type BackgroundBatchLaunch,
  type BatchResult,
  type InvocationContext,
  type InvocationRecord,
  type InvocationResult,
  type ResolvedRequest,
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

export type RuntimeDevinTranscript = {
  messages: unknown[];
  streamingMessage?: unknown;
  pendingToolCalls: Set<string>;
  revision: number;
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

/**
 * Extension-bound hooks a surviving runtime re-points when a reload hands it
 * off to a fresh extension instance. `config` is included so newly loaded
 * agents.yaml content applies to delegations made after the reload.
 */
export type RuntimeReloadRebind = Partial<
  Pick<RuntimeOptions, "appendEvent" | "generateHeadings" | "accountExtension" | "routeAccountModel" | "modelRegistry" | "config" | "roleOverride">
>;

export class SubagentRuntime {
  readonly scheduler: CapacityScheduler;
  readonly state: RuntimeState;
  readonly activities = new Map<string, RuntimeActivity>();
  readonly liveSessions = new Map<string, AgentSession>();
  /** Live transcript state for external Devin sessions while their ACP turn streams. */
  readonly devinTranscripts = new Map<string, RuntimeDevinTranscript>();
  /** Authoritative lifecycle snapshots for tool calls in currently live child sessions. */
  readonly toolExecutions = new Map<string, Map<string, RuntimeToolExecution>>();
  private readonly activeToolCalls = new Map<string, Map<string, string>>();
  private readonly listeners = new Set<() => void>();
  private readonly transcriptListeners = new Set<(handle: string, revision: number) => void>();
  private readonly transcriptRevisions = new Map<string, number>();
  private readonly reservedHandles: Set<string>;
  private batchCounter: number;
  private readonly invocationCancels = new Set<(reason?: unknown) => void>();
  /** Abort controller per detached (background) root batch, keyed by batchId. */
  private readonly batchCancels = new Map<string, AbortController>();
  /** Abort controller per live child invocation, keyed by the agent handle. */
  private readonly agentCancels = new Map<string, AbortController>();
  private readonly pendingInvocations = new Set<Promise<InvocationResult>>();
  private readonly headingControllers = new Set<AbortController>();
  private readonly devinClients = new Map<string, DevinAcpClient>();
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

  /** The roles the active preset activates, with overrides applied. */
  get activeRoles(): readonly AgentRole[] {
    return this.effectiveRoles;
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
      const backend = override.backend && override.backend !== role.backend ? override.backend : undefined;
      return model || thinking || backend
        ? { ...role, ...(model ? { model } : {}), ...(thinking ? { thinking } : {}), ...(backend ? { backend } : {}) }
        : role;
    });
  }

  /** Re-read persisted role overrides. Running invocations keep their existing sessions. */
  refreshRoles(): void {
    this.effectiveRoles = this.resolveRoles(this.activeModeValue);
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

  subscribeTranscript(listener: (handle: string, revision: number) => void): () => void {
    this.transcriptListeners.add(listener);
    return () => this.transcriptListeners.delete(listener);
  }

  transcriptRevision(handle: string): number {
    return this.transcriptRevisions.get(handle) ?? 0;
  }

  /**
   * Detach a root batch. The batch gets its own abort controller so it can be
   * stopped later by id through {@link cancelRootBatch} (background delegation)
   * while still honouring a caller-supplied signal (synchronous delegation).
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
    if (signal) {
      if (signal.aborted) controller.abort(signal.reason);
      else signal.addEventListener("abort", () => controller.abort(signal.reason), { once: true });
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
        this.batchCancels.delete(batchId);
      });
    return { batchId, completion };
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
    if (!controller || controller.signal.aborted) return false;
    controller.abort(new Error(`Background batch ${batchId} cancelled by the parent session.`));
    return true;
  }

  /**
   * Abort a single live child agent by its handle, leaving the rest of its
   * batch running. Returns false when no live invocation owns that handle
   * (unknown, queued elsewhere, or already settled).
   */
  cancelAgent(handle: string): boolean {
    const controller = this.agentCancels.get(handle);
    if (!controller || controller.signal.aborted) return false;
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

  async runRootBatch(requests: SubagentRequest[], signal?: AbortSignal, onProgress?: (result: BatchResult) => void): Promise<BatchResult> {
    return this.startRootBatch(requests, signal, onProgress, false).completion;
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
        backend: role.backend ?? "native",
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
      resolved = {
        role: agent.backend && agent.backend !== role.backend ? { ...role, backend: agent.backend } : role,
        agent,
        task: request.task.trim(),
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
      backend: resolved.role.backend ?? "native",
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

      if (isDevinBackend(resolved.role.backend)) {
        const client = this.devinClients.get(resolved.agent!.handle) ?? new DevinAcpClient(this.options.cwd, "swe-1-7", this.options.devinCommand ?? "devin");
        this.devinClients.set(resolved.agent!.handle, client);
        try {
          await client.start();
        } catch (error) {
          client.dispose();
          this.devinClients.delete(resolved.agent!.handle);
          throw error;
        }
        let backendSessionId = resolved.agent!.backendSessionId;
        if (backendSessionId) await client.loadSession(backendSessionId);
        else {
          backendSessionId = await client.newSession();
          this.record({ type: "agent.backend-session", handle: resolved.agent!.handle, sessionId: backendSessionId });
        }
        abortSession = () => client.cancel(backendSessionId!);
        controller.signal.addEventListener("abort", abortSession, { once: true });
        if (controller.signal.aborted) {
          abortSession();
          controller.signal.throwIfAborted();
        }
        before = { ...ZERO_USAGE };
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
        sessionManager.appendMessage(externalUserMessage(resolved.task));
        this.devinTranscripts.set(invocation.agent, {
          messages: sessionManager.getEntries()
            .filter((entry) => entry.type === "message")
            .map((entry) => entry.message),
          pendingToolCalls: new Set(),
          revision: 1,
        });
        this.notifyTranscript(invocation.agent);
        const prompt = resolved.followup
          ? resolved.task
          : `${readFileSync(resolved.role.promptFile, "utf8").trim()}\n\nAssigned task:\n${resolved.task}`;
        const result = await client.prompt(backendSessionId, prompt, controller.signal, (update) => {
          this.updateDevinActivity(invocation.id, invocation.agent, update);
          this.notifyTranscript(invocation.agent);
        });
        activeTimeout?.pause();
        if (controller.signal.aborted) {
          const timedOut = stopCause === "timeout";
          return this.finish(
            invocation.id,
            timedOut ? "failed" : "cancelled",
            { ...ZERO_USAGE },
            undefined,
            timedOut ? `Timed out after ${resolved.timeoutMinutes} minute(s).` : "Cancelled by the parent session.",
          );
        }
        if (result.output) {
          sessionManager.appendMessage(externalAssistantMessage(result.output));
          const transcript = this.devinTranscripts.get(invocation.agent);
          if (transcript) {
            transcript.messages = sessionManager.getEntries()
              .filter((entry) => entry.type === "message")
              .map((entry) => entry.message);
            transcript.streamingMessage = undefined;
            transcript.revision += 1;
          }
          this.notifyTranscript(invocation.agent);
        }
        if (result.stopReason === "cancelled") {
          return this.finish(invocation.id, "cancelled", { ...ZERO_USAGE }, result.output || undefined, "Cancelled by the parent session.");
        }
        if (!result.output) return this.finish(invocation.id, "failed", { ...ZERO_USAGE }, undefined, "Devin produced no final response.");
        return this.finish(invocation.id, "complete", { ...ZERO_USAGE }, result.output);
      }

      const { loader, settings } = await createRoleResourceLoader(
        this.options.cwd,
        resolved.role,
        this.options.accountExtension,
        this.options.routeAccountModel,
      );
      controller.signal.throwIfAborted();
      const leaseForNested = lease;
      const allowedDelegates = new Set(resolved.role.delegates.map((name) => name.toLowerCase()));
      const canDelegate = allowedDelegates.size > 0 && invocation.depth < this.options.config.defaults.maxDepth;
      const delegateConfig = canDelegate
        ? {
            ...this.options.config,
            roles: this.effectiveRoles.filter((role) => allowedDelegates.has(role.name.toLowerCase())),
          }
        : undefined;
      const tools = toolsForRole(resolved.role, invocation.depth, this.options.config.defaults.maxDepth);
      const customTools: ToolDefinition<any, any, any>[] = [];
      if (tools.includes("web_search")) customTools.push(createWebSearchTool());
      if (delegateConfig) {
        customTools.push(
          createSubagentTool(delegateConfig, async (requests, nestedSignal, onProgress) => {
            this.assertNestedDelegation(requests, invocation.agent, allowedDelegates);
            activeTimeout?.pause();
            controller.signal.throwIfAborted();
            try {
              return await this.runNestedBatch(
                requests,
                {
                  batchId: invocation.batchId,
                  parentInvocationId: invocation.id,
                  depth: invocation.depth,
                },
                leaseForNested,
                nestedSignal,
                onProgress,
              );
            } finally {
              if (!controller.signal.aborted) activeTimeout?.resume();
            }
          }),
        );
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
      before = statsUsage(session.getSessionStats());
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
        const transcriptChanged = event.type === "message_start" || event.type === "message_update" || event.type === "message_end" ||
          event.type === "tool_execution_start" || event.type === "tool_execution_update" || event.type === "tool_execution_end";

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
          const usage = usageWithPendingAssistant(usageDelta(statsUsage(session.getSessionStats()), before), event.message);
          if (!sameUsage(invocation.usage, usage)) {
            invocation.usage = usage;
            advanceStateRevision(this.state);
            this.notify();
          }
        }

        if (transcriptChanged) this.notifyTranscript(invocation.agent);
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

      const usage = usageDelta(statsUsage(session.getSessionStats()), before);
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
      const usage = session ? usageDelta(statsUsage(session.getSessionStats()), before) : { ...ZERO_USAGE };
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
      this.toolExecutions.delete(invocation.agent);
      this.devinTranscripts.delete(invocation.agent);
      this.notifyTranscript(invocation.agent);
      session?.dispose();
      lease?.release();
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
    for (const client of this.devinClients.values()) client.dispose();
    this.devinClients.clear();
    for (const handle of this.liveSessions.keys()) this.notifyTranscript(handle);
    this.liveSessions.clear();
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

  private notifyTranscript(handle: string): void {
    const revision = (this.transcriptRevisions.get(handle) ?? 0) + 1;
    this.transcriptRevisions.set(handle, revision);
    for (const listener of this.transcriptListeners) listener(handle, revision);
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

  private updateDevinActivity(invocationId: string, handle: string, update: DevinAcpUpdate): void {
    const transcript = this.devinTranscripts.get(handle);
    if (transcript && update.kind === "text") {
      const previous = transcript.streamingMessage as { content?: Array<{ type?: string; text?: string }> } | undefined;
      const previousText = previous?.content?.find((part) => part.type === "text")?.text ?? "";
      transcript.streamingMessage = externalAssistantMessage(previousText + update.text);
      transcript.revision += 1;
    }
    if (update.kind === "text") {
      this.activities.set(invocationId, { invocationId, detail: "responding" });
    } else if (update.active) {
      this.activities.set(invocationId, {
        invocationId,
        tool: update.name ?? "devin",
        detail: "working",
      });
    } else {
      this.activities.set(invocationId, { invocationId, detail: "responding" });
    }
    this.notify();
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

    const seen = new Set<string>();
    for (const request of requests) {
      if (!request.task.trim()) throw new Error("Agent tasks must not be blank.");

      if ("role" in request) {
        const role = this.resolveRole(request.role);
        this.resolveTimeout(request.timeoutMinutes, role);
        continue;
      }

      if (seen.has(request.agent)) throw new Error(`Agent ${request.agent} appears more than once in this call.`);
      seen.add(request.agent);
      if (this.isAgentBusy(request.agent)) throw new Error(`Agent ${request.agent} is already running.`);

      const agent = this.state.agents.get(request.agent);
      if (!agent) throw new Error(`Unknown agent handle in this parent session: ${request.agent}.`);
      const role = this.resolveRole(agent.role);
      this.resolveTimeout(request.timeoutMinutes, role);
    }
  }

  private resolveRole(name: string): AgentRole {
    const role = this.effectiveRoles.find((candidate) => candidate.name.toLowerCase() === name.toLowerCase());
    if (!role) throw new Error(`Unknown configured role: ${name}.`);
    return role;
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
    allowedRoles: ReadonlySet<string>,
  ): void {
    for (const request of requests) {
      if ("role" in request) {
        if (!allowedRoles.has(request.role.toLowerCase())) {
          throw new Error(`Agent ${callerHandle} cannot delegate to role ${request.role}.`);
        }
        continue;
      }
      const target = this.state.agents.get(request.agent);
      if (!target) throw new Error(`Unknown agent handle in this parent session: ${request.agent}.`);
      if (!allowedRoles.has(target.role.toLowerCase())) {
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
  return role.delegates.length > 0 && depth < maxDepth ? [...role.tools, "subagent"] : [...role.tools];
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

function externalUserMessage(text: string): any {
  return { role: "user", content: [{ type: "text", text }], timestamp: Date.now() };
}

function externalAssistantMessage(text: string): any {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
    api: "openai-completions",
    provider: "devin",
    model: "swe-1-7",
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop",
    timestamp: Date.now(),
  };
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
