import { randomBytes } from "node:crypto";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { RunOutput } from "./output.ts";
import { isPidAlive, killProcessTree, spawnBackgroundCommand } from "./process.ts";
import type { BackgroundRunEvent, BackgroundRunRecord, BackgroundRunSettledResult } from "./types.ts";

export const BACKGROUND_RUNS_ENTRY_TYPE = "pi-bg-runs";

export function newRunId(): string {
  return `r_${randomBytes(4).toString("hex")}`;
}

export type BackgroundRunRegistryOptions = {
  /** Persist registry events as session entries so history survives restarts. */
  appendEvent: (event: BackgroundRunEvent) => void;
};

/**
 * Root-session store of detached terminal runs. Mirrors the subagent runtime's
 * shape: records are persisted via session entries, replayed on startup, and
 * reconciled when the owning Pi process restarts or reloads.
 */
export class BackgroundRunRegistry {
  private readonly records = new Map<string, BackgroundRunRecord>();
  private readonly outputs = new Map<string, RunOutput>();
  private readonly listeners = new Set<() => void>();
  private readonly settledListeners = new Set<(result: BackgroundRunSettledResult) => void>();
  private readonly appendEvent: (event: BackgroundRunEvent) => void;
  private quitting = false;

  constructor(options: BackgroundRunRegistryOptions) {
    this.appendEvent = options.appendEvent;
  }

  isEmpty(): boolean {
    return this.records.size === 0;
  }

  /** Merge historical records (replayed from session entries). Never overwrites live records. */
  seed(records: readonly BackgroundRunRecord[]): void {
    let changed = false;
    for (const record of records) {
      if (this.records.has(record.id)) continue;
      this.records.set(record.id, { ...record });
      changed = true;
    }
    if (changed) this.notify();
  }

  /** Launch a command detached from the caller's turn. Returns the live record. */
  launch(command: string, cwd: string, options: { timeoutSeconds?: number } = {}): BackgroundRunRecord {
    const id = newRunId();
    const startedAt = Date.now();
    const output = new RunOutput(id);
    const record: BackgroundRunRecord = {
      id,
      command,
      cwd,
      status: "running",
      startedAt,
      outputFile: output.file,
      ...(options.timeoutSeconds === undefined ? {} : { timeoutSeconds: options.timeoutSeconds }),
    };
    this.records.set(id, record);
    this.outputs.set(id, output);

    const { pid, completion } = spawnBackgroundCommand(
      command,
      cwd,
      (chunk) => output.append(chunk),
      options.timeoutSeconds,
    );
    if (pid) record.pid = pid;

    this.record({ type: "run.started", run: cloneRecord(record) });
    this.notify();

    void completion.then(({ exitCode, timedOut, spawnError }) => {
      output.close();
      if (this.quitting || record.status !== "running") return; // killed or interrupted meanwhile
      record.finishedAt = Date.now();
      record.exitCode = exitCode;
      if (spawnError) {
        record.status = "failed";
        record.error = spawnError;
      } else if (timedOut) {
        record.status = "failed";
        record.error = `Timed out after ${options.timeoutSeconds ?? 0} second(s).`;
      } else {
        record.status = exitCode === 0 ? "complete" : "failed";
      }
      this.record({ type: "run.settled", run: cloneRecord(record) });
      this.notify();
      this.emitSettled(record, output);
    });

    return cloneRecord(record);
  }

  get(id: string): BackgroundRunRecord | undefined {
    const record = this.records.get(id);
    return record ? cloneRecord(record) : undefined;
  }

  list(): BackgroundRunRecord[] {
    return [...this.records.values()].map(cloneRecord);
  }

  /** Runs the user should still see as live: tracked running plus detached (left running by a reload). */
  activeCount(): number {
    let count = 0;
    for (const record of this.records.values()) {
      if (record.status === "running" || record.status === "detached") count += 1;
    }
    return count;
  }

  logs(id: string): { tail: string; file: string } | undefined {
    const output = this.outputs.get(id);
    if (!output) return undefined;
    return { tail: output.tail(), file: output.file };
  }

  /** Kill a running or detached run's process tree, mark it cancelled, and report back. */
  kill(id: string): BackgroundRunRecord | undefined {
    const record = this.records.get(id);
    if (!record) return undefined;
    if (record.status === "running" || record.status === "detached") {
      if (record.pid) killProcessTree(record.pid);
      record.status = "cancelled";
      record.finishedAt = Date.now();
      record.exitCode = null;
      this.record({ type: "run.settled", run: cloneRecord(record) });
      this.notify();
      this.emitSettled(record, this.outputs.get(id));
    }
    return cloneRecord(record);
  }

  /** Session quit: kill every running tree and mark the run interrupted. */
  shutdown(): void {
    this.quitting = true;
    for (const record of this.records.values()) {
      if (record.status !== "running") continue;
      if (record.pid) killProcessTree(record.pid);
      record.status = "interrupted";
      record.finishedAt = Date.now();
      this.record({ type: "run.settled", run: cloneRecord(record) });
    }
    this.notify();
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Fired only when a run settles on its own (complete/failed/timeout), never on explicit kill. */
  onSettled(listener: (result: BackgroundRunSettledResult) => void): () => void {
    this.settledListeners.add(listener);
    return () => this.settledListeners.delete(listener);
  }

  private notify(): void {
    for (const listener of [...this.listeners]) listener();
  }

  /**
   * Persist a registry event. The owning session API can be invalidated after
   * reload or session replacement while a detached run is still settling; the
   * run itself is intentionally left running, so persistence failure is benign.
   */
  private record(event: BackgroundRunEvent): void {
    try {
      this.appendEvent(event);
    } catch {
      // Session API no longer active (reload or session replacement).
    }
  }

  private emitSettled(record: BackgroundRunRecord, output: RunOutput | undefined): void {
    const result: BackgroundRunSettledResult = {
      runId: record.id,
      command: record.command,
      status: record.status,
      ...(record.exitCode === undefined ? {} : { exitCode: record.exitCode }),
      ...(record.error === undefined ? {} : { error: record.error }),
      durationMs: (record.finishedAt ?? Date.now()) - record.startedAt,
      output: output?.tail() ?? "",
      ...(output?.file ?? record.outputFile ? { fullOutputPath: output?.file ?? record.outputFile } : {}),
    };
    for (const listener of [...this.settledListeners]) listener(result);
  }
}

/** Rebuild run records from persisted session entries. */
export function replayBackgroundRuns(entries: readonly SessionEntry[]): BackgroundRunRecord[] {
  const records = new Map<string, BackgroundRunRecord>();
  for (const entry of entries) {
    if (entry.type !== "custom" || entry.customType !== BACKGROUND_RUNS_ENTRY_TYPE) continue;
    const event = entry.data as BackgroundRunEvent | undefined;
    if (!event || typeof event !== "object") continue;
    if (event.type === "run.started" || event.type === "run.settled") {
      records.set(event.run.id, { ...event.run });
    }
  }
  return [...records.values()];
}

/**
 * Reconcile records replayed after a process restart: runs still marked "running"
 * were never settled. A still-live pid means the process survived the restart (a
 * reload, or a crash that did not kill the tree) and is now untracked → detached.
 * A dead pid means the tree went down with the session → interrupted.
 */
export function reconcileBackgroundRuns(entries: readonly SessionEntry[]): BackgroundRunRecord[] {
  const records = replayBackgroundRuns(entries);
  for (const record of records) {
    if (record.status !== "running") continue;
    if (isPidAlive(record.pid)) {
      record.status = "detached";
    } else {
      record.status = "interrupted";
      record.error = "Interrupted when the parent Pi session stopped.";
      record.finishedAt = Date.now();
    }
  }
  return records;
}

function cloneRecord(record: BackgroundRunRecord): BackgroundRunRecord {
  return { ...record };
}
