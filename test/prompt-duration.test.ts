import assert from "node:assert/strict";
import { test } from "node:test";
import type {
  ExtensionAPI,
  ExtensionContext,
  SessionEntry,
  Theme,
} from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import {
  PROMPT_DURATION_ENTRY_TYPE,
  PromptDurationController,
  durationPresentation,
  formatPromptDuration,
  reconcileLatestPrompt,
  registerPromptDuration,
  renderDurationDivider,
  renderLiveDuration,
  type PromptDurationClock,
  type PromptDurationEntryData,
} from "../src/ui/prompt-duration.ts";

const plainTheme = {
  fg: (_color: string, text: string) => text,
  bold: (text: string) => text,
} as unknown as Theme;

test("duration ladder keeps zipping below five minutes and escalates playfully", () => {
  assert.equal(durationPresentation(0).liveLabel, "Zipping");
  assert.equal(durationPresentation(4 * 60_000 + 59_000).liveLabel, "Zipping");
  assert.equal(durationPresentation(5 * 60_000).liveLabel, "Cooking");
  assert.equal(durationPresentation(15 * 60_000).liveLabel, "Forging");
  assert.equal(durationPresentation(30 * 60_000).liveLabel, "Questing");
  assert.equal(durationPresentation(60 * 60_000).liveLabel, "On an odyssey");
  assert.equal(durationPresentation(4 * 60 * 60_000).liveLabel, "Bending spacetime");
  assert.equal(durationPresentation(8 * 60 * 60_000).liveLabel, "Lost in the sauce");

  assert.equal(formatPromptDuration(42_900), "42s");
  assert.equal(formatPromptDuration(2 * 60_000 + 17_000), "2m 17s");
  assert.equal(formatPromptDuration(8 * 60 * 60_000 + 21 * 60_000), "8h 21m");
  assert.doesNotMatch(renderLiveDuration(2 * 60_000, plainTheme), /Brewing/i);
});

test("finished dividers are responsive and change copy and rules by duration", () => {
  const samples = [
    [2 * 60_000 + 17_000, /⚡ Zipped for 2m 17s/],
    [8 * 60_000 + 4_000, /🛠 Cooked for 8m 04s/],
    [23 * 60_000 + 11_000, /🔥 Forged for 23m 11s/],
    [47 * 60_000 + 2_000, /🧭 Quest completed in 47m 02s/],
    [2 * 60 * 60_000 + 14 * 60_000, /🚀 Odyssey lasted 2h 14m/],
    [6 * 60 * 60_000 + 3 * 60_000, /🌌 Bent spacetime for 6h 03m/],
    [8 * 60 * 60_000 + 21 * 60_000, /🫠 Returned from the void after 8h 21m/],
  ] as const;

  for (const [duration, expected] of samples) {
    const wide = renderDurationDivider(duration, 80, plainTheme);
    assert.match(wide, expected);
    assert.equal(visibleWidth(wide), 80);
    for (const width of [12, 24, 48]) {
      assert.ok(visibleWidth(renderDurationDivider(duration, width, plainTheme)) <= width);
    }
  }
});

test("entry renderer hides sub-minute completions and renders durable long ones", () => {
  let renderer: ((entry: any, options: any, theme: Theme) => any) | undefined;
  const handlers = new Map<string, Function[]>();
  const pi = {
    registerEntryRenderer(_customType: string, candidate: typeof renderer) { renderer = candidate; },
    on(event: string, handler: Function) {
      const list = handlers.get(event) ?? [];
      list.push(handler);
      handlers.set(event, list);
    },
  } as unknown as ExtensionAPI;

  registerPromptDuration(pi, new FakeClock());
  assert.ok(renderer);
  assert.equal(handlers.get("message_start")?.length, 1);
  assert.equal(handlers.get("agent_settled")?.length, 1);

  const entry = (durationMs: number) => ({
    data: { version: 1, startedAt: 0, completedAt: durationMs, durationMs },
  });
  assert.equal(renderer!(entry(59_999), { expanded: false }, plainTheme), undefined);
  const component = renderer!(entry(60_000), { expanded: false }, plainTheme);
  assert.match(component.render(60)[0], /Zipped for 1m 00s/);
});

test("queued prompts receive independent user-perceived timers and dividers", () => {
  const clock = new FakeClock();
  const harness = createHarness(clock);
  const controller = new PromptDurationController(harness.pi, clock);
  controller.startSession(harness.ctx);

  controller.startPrompt(0, harness.ctx);
  harness.branch.push(userEntry("user-a", 0));
  clock.time = 120_000;

  // Prompt B was submitted after 30s but only delivered after A had owned the
  // working row for two minutes. B therefore starts live with 90s already elapsed.
  controller.startPrompt(30_000, harness.ctx);
  harness.branch.push(userEntry("user-b", 30_000));

  assert.equal(harness.durations.length, 1);
  assert.deepEqual(harness.durations[0], {
    version: 1,
    promptEntryId: "user-a",
    startedAt: 0,
    completedAt: 120_000,
    durationMs: 120_000,
  });
  assert.match(harness.working.at(-1) ?? "", /Zipping.*1m 30s/);

  clock.time = 330_000;
  controller.settlePrompt(harness.ctx);
  assert.equal(harness.durations.length, 2);
  assert.deepEqual(harness.durations[1], {
    version: 1,
    promptEntryId: "user-b",
    startedAt: 30_000,
    completedAt: 330_000,
    durationMs: 300_000,
  });
  assert.equal(harness.working.at(-1), undefined);
});

test("reload reconciliation backfills the latest completed prompt once using persistence time", () => {
  const clock = new FakeClock();
  const harness = createHarness(clock);
  const eightHours = 8 * 60 * 60_000;
  harness.branch.push(userEntry("long-user", 0));
  harness.branch.push(assistantEntry("long-assistant", eightHours + 21 * 60_000));

  const controller = new PromptDurationController(harness.pi, clock);
  controller.startSession(harness.ctx, false);
  assert.equal(harness.durations.length, 0, "ordinary startup/resume must not mutate historical branches");
  controller.startSession(harness.ctx, true);
  assert.equal(harness.durations.length, 1);
  assert.deepEqual(harness.durations[0], {
    version: 1,
    promptEntryId: "long-user",
    startedAt: 0,
    completedAt: eightHours + 21 * 60_000,
    durationMs: eightHours + 21 * 60_000,
    reconstructed: true,
  });
  assert.match(renderDurationDivider(harness.durations[0]!.durationMs, 100, plainTheme), /Returned from the void/);

  reconcileLatestPrompt(harness.pi, harness.ctx);
  assert.equal(harness.durations.length, 1);
});

test("distinct prompts submitted in the same millisecond are deduplicated by entry identity", () => {
  const clock = new FakeClock();
  const harness = createHarness(clock);
  const controller = new PromptDurationController(harness.pi, clock);
  controller.startSession(harness.ctx);

  controller.startPrompt(0, harness.ctx);
  harness.branch.push(userEntry("same-time-a", 0));
  clock.time = 120_000;
  controller.startPrompt(0, harness.ctx);
  harness.branch.push(userEntry("same-time-b", 0));
  clock.time = 240_000;
  controller.settlePrompt(harness.ctx);

  assert.deepEqual(harness.durations.map((duration) => duration.promptEntryId), ["same-time-a", "same-time-b"]);
});

test("sub-minute prompts do not add durable transcript entries", () => {
  const clock = new FakeClock();
  const harness = createHarness(clock);
  const controller = new PromptDurationController(harness.pi, clock);
  controller.startSession(harness.ctx);
  controller.startPrompt(0, harness.ctx);
  harness.branch.push(userEntry("quick-user", 0));
  clock.time = 59_999;
  controller.settlePrompt(harness.ctx);
  assert.deepEqual(harness.durations, []);
});

class FakeClock implements PromptDurationClock {
  time = 0;
  private nextHandle = 1;
  private readonly timers = new Map<number, () => void>();

  now(): number { return this.time; }
  setInterval(callback: () => void): unknown {
    const handle = this.nextHandle++;
    this.timers.set(handle, callback);
    return handle;
  }
  clearInterval(handle: unknown): void { this.timers.delete(handle as number); }
  tick(): void { for (const callback of this.timers.values()) callback(); }
}

function createHarness(_clock: FakeClock): {
  pi: ExtensionAPI;
  ctx: ExtensionContext;
  branch: SessionEntry[];
  durations: PromptDurationEntryData[];
  working: Array<string | undefined>;
} {
  const branch: SessionEntry[] = [];
  const durations: PromptDurationEntryData[] = [];
  const working: Array<string | undefined> = [];
  let nextId = 1;

  const pi = {
    appendEntry(customType: string, data: PromptDurationEntryData) {
      if (customType !== PROMPT_DURATION_ENTRY_TYPE) return;
      durations.push(data);
      branch.push({
        type: "custom",
        customType,
        data,
        id: `duration-${nextId++}`,
        parentId: branch.at(-1)?.id ?? null,
        timestamp: new Date(data.completedAt).toISOString(),
      } as SessionEntry);
    },
  } as unknown as ExtensionAPI;

  const ctx = {
    mode: "tui",
    ui: {
      theme: plainTheme,
      setWorkingMessage(message?: string) { working.push(message); },
    },
    sessionManager: { getBranch: () => branch },
  } as unknown as ExtensionContext;

  return { pi, ctx, branch, durations, working };
}

function userEntry(id: string, timestamp: number): SessionEntry {
  return {
    type: "message",
    id,
    parentId: null,
    timestamp: new Date(timestamp).toISOString(),
    message: {
      role: "user",
      content: [{ type: "text", text: id }],
      timestamp,
    },
  } as SessionEntry;
}

function assistantEntry(id: string, persistedAt: number): SessionEntry {
  return {
    type: "message",
    id,
    parentId: null,
    timestamp: new Date(persistedAt).toISOString(),
    message: {
      role: "assistant",
      content: [{ type: "text", text: "done" }],
      api: "test",
      provider: "test",
      model: "test",
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: "stop",
      // Assistant timestamps mark response creation, not persistence/completion.
      timestamp: 1,
    },
  } as SessionEntry;
}
