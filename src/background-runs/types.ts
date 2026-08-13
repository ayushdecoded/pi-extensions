/** Lifecycle of a detached background run. */
export type BackgroundRunStatus = "running" | "complete" | "failed" | "cancelled" | "detached" | "interrupted";

/** Persisted/observable state of one background run. Plain JSON, safe for session entries. */
export type BackgroundRunRecord = {
  id: string;
  command: string;
  cwd: string;
  status: BackgroundRunStatus;
  pid?: number;
  startedAt: number;
  finishedAt?: number;
  exitCode?: number | null;
  error?: string;
  /** Full output log path; the settle message and `logs` action read from here. */
  outputFile?: string;
  timeoutSeconds?: number;
};

/** Session-entry events for the run registry (mirrors the subagent event pattern). */
export type BackgroundRunEvent =
  | { type: "run.started"; run: BackgroundRunRecord }
  | { type: "run.settled"; run: BackgroundRunRecord };

/** Compact payload delivered as a follow-up message when a run settles on its own. */
export type BackgroundRunSettledResult = {
  runId: string;
  command: string;
  status: BackgroundRunStatus;
  exitCode?: number | null;
  error?: string;
  durationMs: number;
  /** Tail of the run's output (bounded). */
  output: string;
  fullOutputPath?: string;
};

/** Bash tool contract: `background: true` launches, `background: {action}` manages. */
export type BackgroundManageAction = "status" | "logs" | "kill";

export type BackgroundManageRequest = {
  action: BackgroundManageAction;
  runId: string;
};

export type BackgroundBashParams = {
  command?: string;
  timeout?: number;
  background?: true | BackgroundManageRequest;
};
