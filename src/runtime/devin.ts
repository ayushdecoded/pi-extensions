import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import type { AgentBackend } from "../config/agents.ts";

export type DevinAcpUpdate =
  | { kind: "text"; text: string }
  | { kind: "tool"; name?: string; active: boolean };

export type DevinAcpPromptResult = {
  output: string;
  stopReason: string;
};

type JsonRpcResponse = {
  jsonrpc?: string;
  id?: number;
  result?: any;
  error?: { code?: number; message?: string };
};

type JsonRpcNotification = {
  jsonrpc?: string;
  method?: string;
  params?: any;
};

type Pending = {
  resolve: (value: any) => void;
  reject: (error: Error) => void;
};

/** Minimal ACP client for the local Devin CLI. It intentionally has no Pi identity. */
export class DevinAcpClient {
  private child?: ChildProcessWithoutNullStreams;
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  private stdoutBuffer = "";
  private started = false;
  private disposed = false;
  private readonly promptSessions = new Set<string>();
  private readonly loadedSessions = new Set<string>();

  constructor(
    private readonly cwd: string,
    private readonly model = "swe-1-7",
    private readonly command = "devin",
  ) {}

  async start(): Promise<void> {
    if (this.started) return;
    if (this.disposed) throw new Error("Devin ACP client is disposed.");
    const env = scrubPiEnvironment({ ...process.env, DEVIN_MODEL: this.model });
    const child = spawn(this.command, [
      "--permission-mode",
      "dangerous",
      "--respect-workspace-trust",
      "false",
      "acp",
      "--model",
      this.model,
    ], {
      cwd: this.cwd,
      env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.child = child;
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => this.consumeStdout(chunk));
    child.stderr.on("data", () => {
      // Devin's diagnostics are written to its own log. Do not leak them into
      // the child transcript or the parent model context.
    });
    child.once("error", (error) => {
      this.started = false;
      this.loadedSessions.clear();
      if (this.child === child) this.child = undefined;
      this.failPending(error instanceof Error ? error : new Error(String(error)));
    });
    child.once("exit", (code, signal) => {
      this.started = false;
      this.loadedSessions.clear();
      if (this.child === child) this.child = undefined;
      if (!this.disposed && (code !== 0 || signal !== null)) {
        this.failPending(new Error(`Devin ACP exited (${signal ?? `code ${code}`}).`));
      } else if (!this.disposed) {
        this.failPending(new Error("Devin ACP exited unexpectedly."));
      }
    });

    try {
      await this.request("initialize", {
        protocolVersion: 1,
        clientCapabilities: {
          fs: { readTextFile: false, writeTextFile: false },
          terminal: false,
        },
        clientInfo: { name: "workspace-agent", version: "1" },
      });
      this.started = true;
    } catch (error) {
      child.kill("SIGTERM");
      this.loadedSessions.clear();
      this.child = undefined;
      throw error;
    }
  }

  async newSession(): Promise<string> {
    await this.start();
    const result = await this.request("session/new", { cwd: this.cwd, mcpServers: [] });
    const sessionId = result?.sessionId;
    if (typeof sessionId !== "string" || sessionId.length === 0) {
      throw new Error("Devin ACP did not return a session id.");
    }
    this.loadedSessions.add(sessionId);
    return sessionId;
  }

  async loadSession(sessionId: string): Promise<void> {
    await this.start();
    if (this.loadedSessions.has(sessionId)) return;
    await this.request("session/load", { sessionId, cwd: this.cwd, mcpServers: [] });
    this.loadedSessions.add(sessionId);
  }

  async prompt(
    sessionId: string,
    text: string,
    signal: AbortSignal | undefined,
    onUpdate: (update: DevinAcpUpdate) => void,
  ): Promise<DevinAcpPromptResult> {
    await this.start();
    const chunks: string[] = [];
    this.callbacks.set(sessionId, (update) => {
      if (update.kind === "text") chunks.push(update.text);
      onUpdate(update);
    });
    this.promptSessions.add(sessionId);
    const abort = () => {
      this.notify("session/cancel", { sessionId });
      onUpdate({ kind: "tool", active: false });
    };
    if (signal) {
      if (signal.aborted) abort();
      else signal.addEventListener("abort", abort, { once: true });
    }
    try {
      const prompt = this.request("session/prompt", {
        sessionId,
        prompt: [{ type: "text", text }],
      });
      const result = await raceAbort(prompt, signal);
      return {
        output: chunks.join("") || (typeof result?.output === "string" ? result.output : ""),
        stopReason: typeof result?.stopReason === "string" ? result.stopReason : "end_turn",
      };
    } finally {
      this.callbacks.delete(sessionId);
      this.promptSessions.delete(sessionId);
      if (signal) signal.removeEventListener("abort", abort);
    }
  }

  cancel(sessionId: string): void {
    if (!this.child || this.disposed) return;
    this.notify("session/cancel", { sessionId });
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.failPending(new Error("Devin ACP client disposed."));
    this.child?.kill("SIGTERM");
    this.child = undefined;
  }

  private consumeStdout(chunk: string): void {
    this.stdoutBuffer += chunk;
    while (true) {
      const newline = this.stdoutBuffer.indexOf("\n");
      if (newline < 0) return;
      const line = this.stdoutBuffer.slice(0, newline).trim();
      this.stdoutBuffer = this.stdoutBuffer.slice(newline + 1);
      if (!line) continue;
      let message: JsonRpcResponse & JsonRpcNotification;
      try {
        message = JSON.parse(line) as JsonRpcResponse & JsonRpcNotification;
      } catch {
        this.failPending(new Error("Devin ACP emitted invalid JSON."));
        continue;
      }
      if (typeof message.method === "string") {
        this.handleNotification(message);
        continue;
      }
      if (typeof message.id === "number") {
        const pending = this.pending.get(message.id);
        if (!pending) continue;
        this.pending.delete(message.id);
        if (message.error) pending.reject(new Error(message.error.message ?? "Devin ACP request failed."));
        else pending.resolve(message.result);
      }
    }
  }

  private handleNotification(message: JsonRpcNotification & { id?: number }): void {
    if (message.method === "session/request_permission" && typeof message.id === "number") {
      const options = Array.isArray(message.params?.options) ? message.params.options : [];
      const selected = options.find((option: any) => option?.kind === "allow_always")
        ?? options.find((option: any) => option?.kind === "allow_once")
        ?? options.find((option: any) => typeof option?.kind === "string" && option.kind.startsWith("allow"));
      const outcome = selected?.optionId
        ? { outcome: { outcome: "selected", optionId: selected.optionId } }
        : { outcome: { outcome: "cancelled" } };
      this.respond(message.id, outcome);
      return;
    }
    if (message.method !== "session/update") return;
    const update = message.params?.update;
    const sessionId = message.params?.sessionId;
    if (!update || typeof update !== "object") return;
    if (update.sessionUpdate === "agent_message_chunk" && update.content?.type === "text") {
      const text = typeof update.content.text === "string" ? update.content.text : "";
      if (text) this.onPromptUpdate(sessionId, { kind: "text", text });
    } else if (update.sessionUpdate === "tool_call" || update.sessionUpdate === "tool_call_update") {
      this.onPromptUpdate(sessionId, {
        kind: "tool",
        name: typeof update.title === "string" ? update.title : undefined,
        active: update.status !== "completed" && update.status !== "failed" && update.status !== "cancelled",
      });
    }
  }

  private onPromptUpdate(sessionId: unknown, update: DevinAcpUpdate): void {
    if (typeof sessionId !== "string" || !this.promptSessions.has(sessionId)) return;
    // The callback is attached by prompt() through the temporary map below.
    this.callbacks.get(sessionId)?.(update);
  }

  private readonly callbacks = new Map<string, (update: DevinAcpUpdate) => void>();

  private write(message: unknown): void {
    if (!this.child?.stdin.writable) throw new Error("Devin ACP stdin is unavailable.");
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  private respond(id: number, result: unknown): void {
    try {
      this.write({ jsonrpc: "2.0", id, result });
    } catch {
      // The child may have exited while a permission request was in flight.
    }
  }

  private notify(method: string, params: unknown): void {
    try {
      this.write({ jsonrpc: "2.0", method, params });
    } catch {
      // Cancellation is best effort when the child has already exited.
    }
  }

  private request(method: string, params: unknown): Promise<any> {
    const id = this.nextId++;
    const promise = new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }));
    try {
      this.write({ jsonrpc: "2.0", id, method, params });
    } catch (error) {
      this.pending.delete(id);
      throw error;
    }
    return promise;
  }

  private failPending(error: Error): void {
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
  }
}

function scrubPiEnvironment(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  for (const key of Object.keys(env)) {
    if (key === "AI_AGENT" || key.startsWith("PI_")) delete env[key];
  }
  return env;
}

async function raceAbort<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) throw signal.reason ?? new Error("Operation aborted.");
  return await Promise.race([
    promise,
    new Promise<T>((_, reject) => signal.addEventListener("abort", () => reject(signal.reason ?? new Error("Operation aborted.")), { once: true })),
  ]);
}

export function isDevinBackend(backend: AgentBackend | undefined): boolean {
  return backend === "devin";
}
