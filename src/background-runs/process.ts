import { spawn, type ChildProcess } from "node:child_process";
import { getShellConfig } from "@earendil-works/pi-coding-agent";

export type BackgroundSpawnResult = {
  pid: number | undefined;
  completion: Promise<{ exitCode: number | null; timedOut: boolean; spawnError?: string }>;
};

/** True when a pid still refers to a live process (same-uid check via signal 0). */
export function isPidAlive(pid: number | undefined): boolean {
  if (pid === undefined) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

const EXIT_STDIO_GRACE_MS = 100;

/**
 * Spawn a command detached from the caller's lifecycle: the returned completion
 * resolves when the process settles, and the process is NOT tied to any tool-call
 * abort signal. Output is streamed through `onData`.
 *
 * Mirrors the built-in bash backend (shell resolution, detached spawn, process-tree
 * kill on timeout) while keeping the pid available so the registry can kill it later.
 */
export function spawnBackgroundCommand(
  command: string,
  cwd: string,
  onData: (chunk: string) => void,
  timeoutSeconds?: number,
): BackgroundSpawnResult {
  const shellConfig = getShellConfig();
  const env = { ...process.env };
  // Session-bound variables describe the launching session; a detached run that
  // outlives it must not advertise stale session identity.
  delete env.PI_SESSION_ID;
  delete env.PI_SESSION_FILE;
  delete env.PI_PROVIDER;
  delete env.PI_MODEL;
  delete env.PI_REASONING_LEVEL;

  const commandFromStdin = shellConfig.commandTransport === "stdin";
  const child = spawn(shellConfig.shell, commandFromStdin ? shellConfig.args : [...shellConfig.args, command], {
    cwd,
    detached: process.platform !== "win32",
    env,
    stdio: [commandFromStdin ? "pipe" : "ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  if (commandFromStdin) {
    child.stdin?.on("error", () => {});
    child.stdin?.end(command);
  }
  child.stdout?.on("data", (chunk: Buffer) => onData(chunk.toString("utf8")));
  child.stderr?.on("data", (chunk: Buffer) => onData(chunk.toString("utf8")));

  let timedOut = false;
  let timeoutHandle: NodeJS.Timeout | undefined;
  if (timeoutSeconds !== undefined && timeoutSeconds > 0) {
    timeoutHandle = setTimeout(() => {
      timedOut = true;
      if (child.pid) killProcessTree(child.pid);
    }, timeoutSeconds * 1000);
  }

  const completion = waitForChildProcess(child).then(
    (exitCode) => {
      if (timeoutHandle) clearTimeout(timeoutHandle);
      return { exitCode, timedOut };
    },
    (error: unknown) => {
      if (timeoutHandle) clearTimeout(timeoutHandle);
      const message = error instanceof Error ? error.message : String(error);
      return { exitCode: null, timedOut, spawnError: `Failed to start: ${message}` };
    },
  );

  return { pid: child.pid, completion };
}

/**
 * Wait for a child process to terminate without hanging on inherited stdio handles.
 *
 * A short-lived child can `exit` while a detached descendant keeps its stdout/stderr
 * pipe open. After `exit` we wait for the pipes to fall idle: the grace timer is
 * re-armed on every chunk, so an actively writing descendant keeps us reading, while
 * a quiet inherited handle still releases us after the grace elapses. (Same contract
 * as the built-in bash backend.)
 */
function waitForChildProcess(child: ChildProcess): Promise<number | null> {
  return new Promise((resolve, reject) => {
    let settled = false;
    let exited = false;
    let exitCode: number | null = null;
    let postExitTimer: NodeJS.Timeout | undefined;
    let stdoutEnded = child.stdout === null;
    let stderrEnded = child.stderr === null;

    const cleanup = () => {
      if (postExitTimer) clearTimeout(postExitTimer);
      child.removeListener("error", onError);
      child.removeListener("exit", onExit);
      child.removeListener("close", onClose);
      child.stdout?.removeListener("end", onStdoutEnd);
      child.stderr?.removeListener("end", onStderrEnd);
      child.stdout?.removeListener("data", onData);
      child.stderr?.removeListener("data", onData);
    };
    const finalize = (code: number | null) => {
      if (settled) return;
      settled = true;
      cleanup();
      child.stdout?.destroy();
      child.stderr?.destroy();
      resolve(code);
    };
    const maybeFinalizeAfterExit = () => {
      if (!exited || settled) return;
      if (stdoutEnded && stderrEnded) finalize(exitCode);
    };
    const armIdleTimer = () => {
      if (postExitTimer) clearTimeout(postExitTimer);
      postExitTimer = setTimeout(() => finalize(exitCode), EXIT_STDIO_GRACE_MS);
    };
    const onData = () => {
      if (exited && !settled) armIdleTimer();
    };
    const onStdoutEnd = () => {
      stdoutEnded = true;
      maybeFinalizeAfterExit();
    };
    const onStderrEnd = () => {
      stderrEnded = true;
      maybeFinalizeAfterExit();
    };
    const onError = (error: Error) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    };
    const onExit = (code: number | null) => {
      exited = true;
      exitCode = code;
      maybeFinalizeAfterExit();
      if (!settled) armIdleTimer();
    };
    const onClose = (code: number | null) => {
      finalize(code);
    };

    child.stdout?.once("end", onStdoutEnd);
    child.stderr?.once("end", onStderrEnd);
    child.stdout?.on("data", onData);
    child.stderr?.on("data", onData);
    child.once("error", onError);
    child.once("exit", onExit);
    child.once("close", onClose);
  });
}

/** Kill a process and all its children (cross-platform), mirroring the built-in backend. */
export function killProcessTree(pid: number): void {
  if (process.platform === "win32") {
    try {
      spawn("taskkill", ["/F", "/T", "/PID", String(pid)], {
        stdio: "ignore",
        detached: true,
        windowsHide: true,
      });
    } catch {
      // Ignore taskkill failures; the process may already be gone.
    }
    return;
  }
  try {
    process.kill(-pid, "SIGKILL");
  } catch {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // Process already dead.
    }
  }
}
