import { randomUUID } from "node:crypto";
import type { Usage } from "@earendil-works/pi-ai";
import type { Thinking } from "./config.ts";
import { displayTitle } from "./title.ts";

export const STATE_TYPE = "subagents-state-v1";
export type Status = "running" | "completed" | "failed" | "cancelled" | "interrupted";
export type Spec = { agent: string; prompt: string; model: string; thinking: Thinking; tools: string[]; depth: number };
export type Report = { handle: string; agent: string; runId: string; status: Status; text: string; usage: Usage; sessionFile?: string; title?: string };
export type AgentRecord = Spec & {
  handle: string; owner: string; sessionFile?: string; status: Status;
  runId: string; task: string; background: boolean; report?: Report;
  title?: string; titleError?: string; activity?: string; startedAt?: number; finishedAt?: number;
};
export type Snapshot = { version: 1; root: string; records: AgentRecord[]; pending: Report[]; widgetCollapsed?: boolean };
export type Child = {
  prompt(task: string): Promise<void>;
  waitForIdle(): Promise<void>;
  abort(): Promise<void>;
  dispose(): void;
  output(): string;
  error(): string | undefined;
  usage(): Usage;
  deliver(report: Report): Promise<void>;
};
export type Sink = { save(state: Snapshot): void; deliver(report: Report): void };
type Job = { controller: AbortController; child?: Child; done: Promise<Report>; extra: Usage };
export const zeroUsage = (): Usage => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } });
export function addUsage(a: Usage, b: Usage, sign = 1): Usage {
  const result = zeroUsage();
  for (const key of ["input", "output", "cacheRead", "cacheWrite", "totalTokens"] as const) result[key] = a[key] + sign * b[key];
  for (const key of ["input", "output", "cacheRead", "cacheWrite", "total"] as const) result.cost[key] = a.cost[key] + sign * b.cost[key];
  return result;
}
export function canDelegate(spec: Pick<Spec, "agent" | "depth">) {
  return spec.depth === 1 && (spec.agent === "Forge" || spec.agent === "Vigil");
}

// Owns only handles, live work, and completion delivery. Pi owns each child's loop,
// transcript, retries and compaction. This object survives /reload in the same process.
export class Subagents {
  readonly records = new Map<string, AgentRecord>();
  readonly jobs = new Map<string, Job>();
  private pending: Report[] = [];
  private sink?: Sink;
  private closed = false;
  widgetCollapsed = false;
  private listeners = new Set<() => void>();
  subscribe(listener: () => void) { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; }
  changed() { for (const listener of this.listeners) listener(); }
  constructor(
    readonly root: string,
    public createChild: (record: AgentRecord, signal: AbortSignal, progress: (text: string) => void) => Promise<Child>,
    snapshot?: Snapshot,
  ) {
    if (snapshot?.root !== root) snapshot = undefined;
    for (const saved of snapshot?.records ?? []) {
      this.records.set(saved.handle, { ...saved, status: saved.status === "running" ? "interrupted" : saved.status });
    }
    this.pending = snapshot?.pending ?? [];
    this.widgetCollapsed = snapshot?.widgetCollapsed ?? false;
  }
  snapshot(): Snapshot {
    return structuredClone({ version: 1, root: this.root, records: [...this.records.values()], pending: this.pending, widgetCollapsed: this.widgetCollapsed });
  }
  attach(sink: Sink) { this.sink = sink; this.save(); this.flush(); }
  detach() { this.sink = undefined; }
  save() {
    try { this.sink?.save(this.snapshot()); } catch { this.sink = undefined; }
    this.changed();
  }
  private flush() {
    if (!this.sink || this.closed) return;
    while (this.pending.length) {
      const report = this.pending[0];
      try { this.sink.deliver(report); } catch { this.sink = undefined; return; }
      this.pending.shift();
      this.save();
    }
  }
  owned(owner: string, handle: string) {
    const record = this.records.get(handle);
    if (!record || record.owner !== owner) throw new Error(`Unknown handle for this agent: ${handle}`);
    return record;
  }
  reserve(owner: string, spec: Spec, task: string, background: boolean): AgentRecord {
    if (owner !== this.root) {
      const parent = this.records.get(owner);
      if (!parent || !canDelegate(parent) || spec.agent !== "Atlas" || spec.depth !== 2) throw new Error("Only depth-1 Forge/Vigil may spawn depth-2 Atlas.");
    } else if (spec.depth !== 1) throw new Error("Root children must be depth 1.");
    if (this.closed) throw new Error("Subagent runtime is closed.");
    const record: AgentRecord = { ...spec, handle: `${spec.agent.toLowerCase()}-${randomUUID()}`, owner, status: "interrupted", runId: "", task, background };
    this.records.set(record.handle, record);
    return record;
  }
  start(record: AgentRecord, task: string, background: boolean, progress: (text: string) => void = () => {}): Promise<Report> {
    if (this.closed) throw new Error("Subagent runtime is closed.");
    if (this.jobs.has(record.handle)) throw new Error(`Agent ${record.handle} is busy; wait or cancel it before a follow-up.`);
    if (record.owner !== this.root) {
      const parent = this.records.get(record.owner);
      if (!parent || !canDelegate(parent) || record.agent !== "Atlas" || record.depth !== 2) throw new Error("Delegation is not allowed.");
    }
    record.task = task; record.background = background; record.status = "running";
    record.runId = randomUUID(); record.report = undefined;
    record.startedAt = Date.now(); record.finishedAt = undefined; record.activity = "starting";
    record.titleError = undefined;
    const job: Job = { controller: new AbortController(), done: undefined!, extra: zeroUsage() };
    this.jobs.set(record.handle, job);
    // Start in a microtask, after registration, so even immediate failures are tracked.
    job.done = Promise.resolve().then(() => this.run(record, job, progress));
    this.save();
    return job.done;
  }
  private async run(record: AgentRecord, job: Job, progress: (text: string) => void): Promise<Report> {
    let before = zeroUsage();
    let text = "";
    let status: Status = "completed";
    try {
      job.controller.signal.throwIfAborted();
      job.child = await this.createChild(record, job.controller.signal, (text) => {
        record.activity = text; this.changed(); progress(text);
      });
      this.save();
      before = job.child.usage();
      job.controller.signal.throwIfAborted();
      await job.child.prompt(record.task);
      // A child can launch background Atlas work. Do not close its session while
      // those completions are still destined for it, or report it finished early.
      while (true) {
        const descendants = [...this.jobs].filter(([handle]) => this.records.get(handle)?.owner === record.handle).map(([, child]) => child.done);
        if (descendants.length) await Promise.all(descendants);
        await job.child.waitForIdle();
        if (![...this.jobs.keys()].some(handle => this.records.get(handle)?.owner === record.handle)) break;
      }
      job.controller.signal.throwIfAborted();
      const error = job.child.error();
      if (error) throw new Error(error);
      text = job.child.output() || "Agent finished without a text response. Inspect its session before retrying.";
    } catch (error) {
      status = job.controller.signal.aborted ? "cancelled" : "failed";
      text = error instanceof Error ? error.message : String(error);
      job.controller.abort();
      await this.cancelChildren(record.handle);
      await job.child?.abort();
    }
    const usage = addUsage(addUsage(job.child?.usage() ?? before, before, -1), job.extra);
    job.child?.dispose();
    const report: Report = { handle: record.handle, agent: record.agent, runId: record.runId, status, text, usage, sessionFile: record.sessionFile, title: displayTitle(record) };
    record.status = status; record.report = report; record.finishedAt = Date.now(); record.activity = undefined;
    this.jobs.delete(record.handle);
    // Deliver nested results before resolving their jobs, so the owner's wait
    // cannot finish between Atlas completion and its follow-up being queued.
    if (record.background) {
      if (record.owner === this.root) {
        if (!this.closed) this.pending.push(report);
      } else {
        const parent = this.jobs.get(record.owner);
        // Spent usage still belongs to the parent when cancellation/shutdown suppresses delivery.
        if (parent) parent.extra = addUsage(parent.extra, usage);
        if (!this.closed && parent?.child && !parent.controller.signal.aborted) {
          try { await parent.child.deliver(report); }
          catch (error) { record.report = { ...report, text: `${text}\nCompletion delivery failed: ${String(error)}` }; }
        }
      }
    }
    this.save();
    this.flush();
    return report;
  }
  async cancel(owner: string, handle: string) {
    this.owned(owner, handle);
    const job = this.jobs.get(handle);
    if (!job) return;
    job.controller.abort();
    await this.cancelChildren(handle);
    await job.child?.abort();
    await job.done;
  }
  private async cancelChildren(owner: string) {
    await Promise.all([...this.jobs.keys()].filter(handle => this.records.get(handle)?.owner === owner).map(handle => this.cancel(owner, handle)));
  }
  async close() {
    this.closed = true;
    // Abort all first: a parent may currently be waiting for a child tool call.
    for (const job of this.jobs.values()) job.controller.abort();
    await Promise.all([...this.jobs.values()].map(async job => { await job.child?.abort(); await job.done; }));
    this.save();
    this.detach();
  }
}
