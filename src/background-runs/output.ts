import { createWriteStream, type WriteStream } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const MAX_TAIL_LINES = 100;
const MAX_TAIL_BYTES = 8 * 1024;

/**
 * Accumulates a background run's output: full stream goes to a per-run temp file
 * (so `logs` and the settle message can reference the complete output), while a
 * bounded in-memory tail keeps recent output cheaply readable.
 */
export class RunOutput {
  readonly file: string;
  private readonly stream: WriteStream;
  private readonly tailLines: string[] = [];
  private tailBytes = 0;
  private pending = "";
  private closed = false;

  constructor(runId: string) {
    this.file = join(tmpdir(), `pi-bg-run-${runId}.log`);
    this.stream = createWriteStream(this.file, { flags: "w" });
    // A background run may be killed while writing; never crash on stream errors.
    this.stream.on("error", () => {});
  }

  append(chunk: string): void {
    if (this.closed) return;
    this.stream.write(chunk);
    const lines = (this.pending + chunk).split("\n");
    this.pending = lines.pop() ?? "";
    for (const line of lines) this.pushLine(line);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    if (this.pending) this.pushLine(this.pending);
    this.pending = "";
    this.stream.end();
  }

  tail(): string {
    return this.tailLines.join("\n");
  }

  private pushLine(line: string): void {
    this.tailLines.push(line);
    this.tailBytes += Buffer.byteLength(line) + 1;
    while (this.tailLines.length > MAX_TAIL_LINES || this.tailBytes > MAX_TAIL_BYTES) {
      const dropped = this.tailLines.shift();
      if (dropped === undefined) break;
      this.tailBytes -= Buffer.byteLength(dropped) + 1;
    }
  }
}
