import assert from "node:assert/strict";
import { test } from "node:test";
import { ActiveWorkTimeout, MAX_TIMER_DELAY_MS, type TimeoutClock } from "../src/runtime/timeout.ts";

test("active-work timeout excludes time spent paused", () => {
  const clock = new FakeClock();
  let timedOut = false;
  const timeout = new ActiveWorkTimeout(10_000, () => { timedOut = true; }, clock);

  timeout.resume();
  clock.advance(4_000);
  timeout.pause();
  assert.equal(timeout.remainingMs, 6_000);

  clock.advance(60_000);
  assert.equal(timeout.remainingMs, 6_000);
  assert.equal(timedOut, false);

  timeout.resume();
  clock.advance(5_999);
  assert.equal(timedOut, false);
  clock.advance(1);
  assert.equal(timedOut, true);
});

test("pausing after the active budget elapsed cannot suppress expiry", () => {
  const clock = new FakeClock();
  let calls = 0;
  const timeout = new ActiveWorkTimeout(10_000, () => { calls += 1; }, clock);

  timeout.resume();
  clock.elapseWithoutDispatch(10_001);
  timeout.pause();

  assert.equal(calls, 1);
  assert.equal(timeout.remainingMs, 0);
});

test("long active-work budgets are scheduled in safe timer chunks", () => {
  const clock = new FakeClock();
  let calls = 0;
  const timeout = new ActiveWorkTimeout(MAX_TIMER_DELAY_MS + 10_000, () => { calls += 1; }, clock);

  timeout.resume();
  assert.equal(clock.nextDelayMs, MAX_TIMER_DELAY_MS);
  clock.advance(MAX_TIMER_DELAY_MS);
  assert.equal(calls, 0);
  assert.equal(clock.nextDelayMs, 10_000);
  clock.advance(10_000);
  assert.equal(calls, 1);
});

test("active-work timeout can pause and resume repeatedly without adding budget", () => {
  const clock = new FakeClock();
  let calls = 0;
  const timeout = new ActiveWorkTimeout(10_000, () => { calls += 1; }, clock);

  timeout.resume();
  clock.advance(2_000);
  timeout.pause();
  clock.advance(20_000);
  timeout.resume();
  clock.advance(3_000);
  timeout.pause();
  clock.advance(20_000);

  assert.equal(timeout.remainingMs, 5_000);
  timeout.resume();
  clock.advance(5_000);
  assert.equal(calls, 1);
  clock.advance(50_000);
  assert.equal(calls, 1);
});

class FakeClock implements TimeoutClock {
  private time = 0;
  private nextId = 1;
  private readonly timers = new Map<number, { due: number; callback: () => void }>();

  now(): number {
    return this.time;
  }

  set(callback: () => void, delayMs: number): unknown {
    const id = this.nextId++;
    this.timers.set(id, { due: this.time + delayMs, callback });
    return id;
  }

  clear(handle: unknown): void {
    this.timers.delete(handle as number);
  }

  get nextDelayMs(): number | undefined {
    const due = [...this.timers.values()].map((timer) => timer.due).sort((left, right) => left - right)[0];
    return due === undefined ? undefined : due - this.time;
  }

  elapseWithoutDispatch(ms: number): void {
    this.time += ms;
  }

  advance(ms: number): void {
    const target = this.time + ms;
    while (true) {
      const next = [...this.timers.entries()]
        .filter(([, timer]) => timer.due <= target)
        .sort((left, right) => left[1].due - right[1].due || left[0] - right[0])[0];
      if (!next) break;
      const [id, timer] = next;
      this.timers.delete(id);
      this.time = timer.due;
      timer.callback();
    }
    this.time = target;
  }
}
