export type TimeoutClock = {
  now(): number;
  set(callback: () => void, delayMs: number): unknown;
  clear(handle: unknown): void;
};

export const MAX_TIMER_DELAY_MS = 2_147_483_647;

const SYSTEM_CLOCK: TimeoutClock = {
  now: () => performance.now(),
  set(callback, delayMs) {
    const timer = setTimeout(callback, delayMs);
    timer.unref?.();
    return timer;
  },
  clear(handle) {
    clearTimeout(handle as ReturnType<typeof setTimeout>);
  },
};

/** A timeout budget that advances only while resumed. */
export class ActiveWorkTimeout {
  private remaining: number;
  private startedAt?: number;
  private timer?: unknown;
  private disposed = false;

  constructor(
    durationMs: number,
    private readonly onTimeout: () => void,
    private readonly clock: TimeoutClock = SYSTEM_CLOCK,
  ) {
    if (!Number.isFinite(durationMs) || durationMs < 0) throw new Error("Timeout duration must be non-negative.");
    this.remaining = durationMs;
  }

  get remainingMs(): number {
    if (this.startedAt === undefined) return this.remaining;
    return Math.max(0, this.remaining - Math.max(0, this.clock.now() - this.startedAt));
  }

  resume(): void {
    if (this.disposed || this.startedAt !== undefined) return;
    if (this.remaining <= 0) {
      this.expire();
      return;
    }
    this.startedAt = this.clock.now();
    this.timer = this.clock.set(() => this.handleTimer(), Math.min(this.remaining, MAX_TIMER_DELAY_MS));
  }

  pause(): void {
    if (this.disposed || this.startedAt === undefined) return;
    const remaining = this.remainingMs;
    if (this.timer !== undefined) this.clock.clear(this.timer);
    this.timer = undefined;
    this.startedAt = undefined;
    this.remaining = remaining;
    if (remaining <= 0) this.expire();
  }

  dispose(): void {
    if (this.disposed) return;
    if (this.timer !== undefined) this.clock.clear(this.timer);
    this.timer = undefined;
    this.startedAt = undefined;
    this.disposed = true;
  }

  private handleTimer(): void {
    if (this.disposed || this.startedAt === undefined) return;
    this.remaining = this.remainingMs;
    this.startedAt = undefined;
    this.timer = undefined;
    if (this.remaining <= 0) this.expire();
    else this.resume();
  }

  private expire(): void {
    if (this.disposed) return;
    if (this.timer !== undefined) this.clock.clear(this.timer);
    this.timer = undefined;
    this.startedAt = undefined;
    this.remaining = 0;
    this.disposed = true;
    this.onTimeout();
  }
}
