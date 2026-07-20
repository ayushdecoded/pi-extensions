type Waiter = {
  resolve: (lease: CapacityLease) => void;
  reject: (error: Error) => void;
  signal?: AbortSignal;
  abort?: () => void;
};

export class CapacityLease {
  private held = true;

  constructor(private readonly scheduler: CapacityScheduler) {}

  suspend(): void {
    if (!this.held) return;
    this.held = false;
    this.scheduler.releaseOne();
  }

  async resume(signal?: AbortSignal): Promise<void> {
    if (this.held) return;
    const replacement = await this.scheduler.acquire(signal);
    replacement.detach();
    this.held = true;
  }

  release(): void {
    if (!this.held) return;
    this.held = false;
    this.scheduler.releaseOne();
  }

  detach(): void {
    this.held = false;
  }
}

export class CapacityScheduler {
  private active = 0;
  private readonly queue: Waiter[] = [];

  constructor(readonly limit: number) {
    if (!Number.isSafeInteger(limit) || limit <= 0) throw new Error("Concurrency limit must be positive.");
  }

  get activeCount(): number {
    return this.active;
  }

  get queuedCount(): number {
    return this.queue.length;
  }

  acquire(signal?: AbortSignal): Promise<CapacityLease> {
    if (signal?.aborted) return Promise.reject(abortError());
    if (this.active < this.limit) {
      this.active += 1;
      return Promise.resolve(new CapacityLease(this));
    }

    return new Promise((resolve, reject) => {
      const waiter: Waiter = { resolve, reject, ...(signal ? { signal } : {}) };
      if (signal) {
        waiter.abort = () => {
          const index = this.queue.indexOf(waiter);
          if (index >= 0) this.queue.splice(index, 1);
          reject(abortError());
        };
        signal.addEventListener("abort", waiter.abort, { once: true });
      }
      this.queue.push(waiter);
    });
  }

  releaseOne(): void {
    if (this.active <= 0) return;
    this.active -= 1;
    this.drain();
  }

  private drain(): void {
    while (this.active < this.limit && this.queue.length > 0) {
      const waiter = this.queue.shift()!;
      if (waiter.abort && waiter.signal) waiter.signal.removeEventListener("abort", waiter.abort);
      if (waiter.signal?.aborted) {
        waiter.reject(abortError());
        continue;
      }
      this.active += 1;
      waiter.resolve(new CapacityLease(this));
    }
  }
}

export function abortError(): Error {
  const error = new Error("Cancelled before the agent started.");
  error.name = "AbortError";
  return error;
}
