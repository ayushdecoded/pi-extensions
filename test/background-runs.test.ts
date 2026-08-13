import assert from "node:assert/strict";
import { test } from "node:test";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { createBackgroundBashTool } from "../src/background-runs/bash.ts";
import {
  BACKGROUND_RUN_RESULT_TYPE,
  deliverBackgroundRunResult,
  formatBackgroundRunResult,
  renderBackgroundRunMessage,
  type BackgroundRunResultDetails,
} from "../src/background-runs/message.ts";
import { RunOutput } from "../src/background-runs/output.ts";
import { ProcessesPanel } from "../src/background-runs/panel.ts";
import {
  BACKGROUND_RUNS_ENTRY_TYPE,
  BackgroundRunRegistry,
  reconcileBackgroundRuns,
  replayBackgroundRuns,
} from "../src/background-runs/registry.ts";
import type { BackgroundRunRecord, BackgroundRunSettledResult } from "../src/background-runs/types.ts";
import { composerBorder } from "../src/ui/full-paste-editor.ts";

function textOf(result: any): string {
  const part = result?.content?.[0];
  return part && typeof part === "object" && "text" in part ? String((part as { text: string }).text) : "";
}

function settle(registry: BackgroundRunRegistry): Promise<BackgroundRunSettledResult> {
  return new Promise((resolve) => {
    registry.onSettled((result) => resolve(result));
  });
}

function settledRecord(registry: BackgroundRunRegistry, id: string): BackgroundRunRecord {
  const record = registry.get(id);
  assert.ok(record, `expected run ${id} to exist`);
  return record;
}

async function waitFor(condition: () => boolean, timeoutMs = 2000): Promise<void> {
  const started = Date.now();
  while (!condition()) {
    if (Date.now() - started > timeoutMs) throw new Error("condition not met in time");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

test("rebindAppendEvent re-points persistence after a reload adopts the registry", async () => {
  const first: unknown[] = [];
  const second: unknown[] = [];
  const registry = new BackgroundRunRegistry({ appendEvent: (event) => first.push(event) });
  const settled = settle(registry);

  const record = registry.launch("printf reload-survived", process.cwd());
  // Simulate the reloaded extension instance taking over persistence.
  registry.rebindAppendEvent((event) => second.push(event));

  await settled;
  const settledEvent = second.find((event) => (event as { type?: string }).type === "run.settled");
  assert.ok(settledEvent, "run.settled is persisted through the rebound hook");
  assert.equal(registry.get(record.id)?.status, "complete");
});

test("launched runs settle as complete with bounded output tail and persisted events", async () => {
  const events: unknown[] = [];
  const registry = new BackgroundRunRegistry({ appendEvent: (event) => events.push(event) });
  const settled = settle(registry);

  const record = registry.launch("printf 'line1\\nline2\\n'", process.cwd());
  assert.equal(record.status, "running");
  assert.ok(record.id.startsWith("r_"));
  assert.equal(record.cwd, process.cwd());
  assert.ok(events.length === 1 && (events[0] as { type: string }).type === "run.started");

  const result = await settled;
  assert.equal(result.status, "complete");
  assert.equal(result.exitCode, 0);
  assert.match(result.output, /line1\nline2/);
  assert.ok(result.fullOutputPath, "full output path is exposed");
  assert.equal(registry.activeCount(), 0);
  assert.equal(registry.get(record.id)?.status, "complete");
  const settledEvents = events.filter((event) => (event as { type: string }).type === "run.settled");
  assert.equal(settledEvents.length, 1);
});

test("non-zero exits settle as failed with the exit code", async () => {
  const registry = new BackgroundRunRegistry({ appendEvent: () => {} });
  const settled = settle(registry);
  const record = registry.launch("printf 'boom' >&2; exit 3", process.cwd());
  const result = await settled;
  assert.equal(result.status, "failed");
  assert.equal(result.exitCode, 3);
  assert.match(result.output, /boom/);
  assert.equal(settledRecord(registry, record.id).status, "failed");
});

test("timeouts kill the process tree and report a timeout error", async () => {
  const registry = new BackgroundRunRegistry({ appendEvent: () => {} });
  const settled = settle(registry);
  const record = registry.launch("sleep 5", process.cwd(), { timeoutSeconds: 0.2 });
  const result = await settled;
  assert.equal(result.status, "failed");
  assert.match(result.error ?? "", /Timed out after/);
  assert.equal(settledRecord(registry, record.id).status, "failed");
});

test("kill terminates the process tree, marks the run cancelled, and reports back", async () => {
  const settledResults: BackgroundRunSettledResult[] = [];
  const registry = new BackgroundRunRegistry({ appendEvent: () => {} });
  registry.onSettled((result) => settledResults.push(result));
  const record = registry.launch("sleep 30", process.cwd());
  assert.ok(record.pid, "launched process has a pid");

  const updated = registry.kill(record.id);
  assert.equal(updated?.status, "cancelled");
  assert.equal(registry.get(record.id)?.status, "cancelled");

  // The process tree must actually be dead.
  await waitFor(() => {
    try {
      process.kill(record.pid!, 0);
      return false;
    } catch {
      return true;
    }
  });
  // A manual kill reports back once, like completion and failure.
  await waitFor(() => settledResults.length > 0);
  assert.equal(settledResults.length, 1);
  assert.equal(settledResults[0]!.runId, record.id);
  assert.equal(settledResults[0]!.status, "cancelled");
  assert.equal(settledResults[0]!.exitCode, null);
});

test("shutdown kills running trees and marks them interrupted", async () => {
  const events: unknown[] = [];
  const registry = new BackgroundRunRegistry({ appendEvent: (event) => events.push(event) });
  const first = registry.launch("sleep 30", process.cwd());
  const second = registry.launch("echo quick", process.cwd());
  await settle(registry); // second settles on its own

  registry.shutdown();
  assert.equal(registry.get(first.id)?.status, "interrupted");
  assert.equal(registry.get(second.id)?.status, "complete");
  await waitFor(() => {
    try {
      process.kill(first.pid!, 0);
      return false;
    } catch {
      return true;
    }
  });
  const settledEvents = events.filter((event) => (event as { type: string }).type === "run.settled");
  assert.ok(settledEvents.some((event) => (event as { run: BackgroundRunRecord }).run.id === first.id));
});

test("records round-trip through session entries and reconcile by liveness", async () => {
  const registry = new BackgroundRunRegistry({ appendEvent: () => {} });
  const record = registry.launch("sleep 30", process.cwd());
  const running = registry.get(record.id)!;
  assert.equal(running.status, "running");

  const entry = { type: "custom", customType: BACKGROUND_RUNS_ENTRY_TYPE, data: { type: "run.started", run: running } };
  const replayed = replayBackgroundRuns([entry as any]);
  assert.equal(replayed.length, 1);
  assert.equal(replayed[0]!.id, record.id);

  // A still-live pid after a restart means the process survived (e.g. reload) → detached.
  const alive = reconcileBackgroundRuns([entry as any]);
  assert.equal(alive[0]!.status, "detached", "a live pid after restart is detached");

  // A dead pid means the tree went down with the session → interrupted.
  const deadEntry = {
    type: "custom",
    customType: BACKGROUND_RUNS_ENTRY_TYPE,
    data: { type: "run.started", run: { ...running, pid: 2_147_483_647 } },
  };
  const dead = reconcileBackgroundRuns([deadEntry as any]);
  assert.equal(dead[0]!.status, "interrupted");
  assert.match(dead[0]!.error ?? "", /Interrupted/);

  registry.kill(record.id);
});

test("activeCount includes detached runs left running by a reload", () => {
  const registry = new BackgroundRunRegistry({ appendEvent: () => {} });
  const launched = registry.launch("sleep 30", process.cwd());
  assert.equal(registry.activeCount(), 1);
  registry.kill(launched.id);
  assert.equal(registry.activeCount(), 0);
  registry.seed([{ id: "r_detached1", command: "true", cwd: process.cwd(), status: "detached", startedAt: Date.now() }]);
  assert.equal(registry.activeCount(), 1, "detached runs still count as live");
});

test("run output keeps a bounded tail while the full stream lands on disk", async () => {
  const output = new RunOutput("t-1");
  for (let i = 0; i < 150; i += 1) output.append(`line ${i}\n`);
  output.close();
  const tail = output.tail();
  const lines = tail.split("\n");
  assert.equal(lines[0], "line 50", "tail keeps the last 100 lines");
  assert.equal(lines.at(-1), "line 149");
  const { readFileSync } = await import("node:fs");
  const full = readFileSync(output.file, "utf8");
  assert.match(full, /line 0\n/);
  assert.match(full, /line 149/);
});

test("the bash tool launches background runs and returns a receipt with the run id", async () => {
  const events: unknown[] = [];
  const registry = new BackgroundRunRegistry({ appendEvent: (event) => events.push(event) });
  const tool = createBackgroundBashTool({ cwd: process.cwd(), registry });
  const settled = settle(registry);

  const result = await tool.execute(
    "call-1",
    { command: "echo bg-launch", background: true },
    undefined,
    undefined,
    { cwd: process.cwd() } as any,
  );
  const details = result.details as { runId: string };
  assert.ok(details.runId.startsWith("r_"));
  assert.match(textOf(result), /\[Background run · .* · started\]/);
  assert.match(textOf(result), /Manage with bash/);

  const outcome = await settled;
  assert.equal(outcome.status, "complete");
  assert.match(outcome.output, /bg-launch/);
  assert.equal(registry.get(details.runId)?.status, "complete");
});

test("the bash tool manages runs through status, logs, and kill actions", async () => {
  const registry = new BackgroundRunRegistry({ appendEvent: () => {} });
  const tool = createBackgroundBashTool({ cwd: process.cwd(), registry });

  const launch = await tool.execute("call-1", { command: "echo managed; sleep 30", background: true }, undefined, undefined, { cwd: process.cwd() } as any);
  const runId = (launch.details as { runId: string }).runId;

  await waitFor(() => registry.logs(runId)?.tail.includes("managed") ?? false);

  const status = await tool.execute("call-2", { background: { action: "status", runId } }, undefined, undefined, { cwd: process.cwd() } as any);
  assert.match(textOf(status), /running/);

  const logs = await tool.execute("call-3", { background: { action: "logs", runId } }, undefined, undefined, { cwd: process.cwd() } as any);
  assert.match(textOf(logs), /managed/);

  const kill = await tool.execute("call-4", { background: { action: "kill", runId } }, undefined, undefined, { cwd: process.cwd() } as any);
  assert.match(textOf(kill), /killed/);
  assert.equal(registry.get(runId)?.status, "cancelled");

  await assert.rejects(
    tool.execute("call-5", { background: { action: "status", runId: "r_nope" } }, undefined, undefined, { cwd: process.cwd() } as any),
    /Unknown background run/,
  );
});

test("the bash tool still delegates foreground calls to the built-in backend", async () => {
  const registry = new BackgroundRunRegistry({ appendEvent: () => {} });
  const tool = createBackgroundBashTool({ cwd: process.cwd(), registry });
  const fakeCtx = {
    cwd: process.cwd(),
    sessionManager: { getSessionId: () => "test-session", getSessionFile: () => undefined },
    model: undefined,
    thinkingLevel: undefined,
  };
  const result = await tool.execute("call-1", { command: "printf 'foreground-ok'", timeout: 5 }, undefined, undefined, fakeCtx as any);
  assert.match(textOf(result), /foreground-ok/);
  assert.equal(registry.activeCount(), 0, "foreground calls never create background runs");
});

test("settled background runs deliver a follow-up message and render as a transcript card", () => {
  const sent: Array<{ message: any; options: any }> = [];
  const result: BackgroundRunSettledResult = {
    runId: "r_1234abcd",
    command: "npm run build",
    status: "failed",
    exitCode: 1,
    durationMs: 3_000,
    output: "error TS2345",
    fullOutputPath: "/tmp/pi-bg-run-r_1234abcd.log",
  };
  deliverBackgroundRunResult(result, ((message: any, options: any) => sent.push({ message, options })) as any);
  assert.equal(sent.length, 1);
  assert.equal(sent[0]!.message.customType, BACKGROUND_RUN_RESULT_TYPE);
  assert.equal(sent[0]!.message.display, true);
  assert.match(sent[0]!.message.content, /r_1234abcd · exited 1 · 3s/);
  assert.match(sent[0]!.message.content, /npm run build/);
  assert.deepEqual(sent[0]!.options, { triggerTurn: true, deliverAs: "followUp" });
});

test("stale session APIs do not reject background delivery", () => {
  const result: BackgroundRunSettledResult = {
    runId: "r_stale", command: "true", status: "complete", exitCode: 0, durationMs: 1, output: "",
  };
  assert.doesNotThrow(() => {
    deliverBackgroundRunResult(result, (() => { throw new Error("Extension API context is no longer active"); }) as any);
  });
});

test("formatBackgroundRunResult keeps the tail, full output path, and failure reason", () => {
  const text = formatBackgroundRunResult({
    runId: "r_abc", command: "make test", status: "complete", exitCode: 0, durationMs: 500,
    output: "  ok 1", fullOutputPath: "/tmp/x.log",
  });
  assert.match(text, /\[Background run · r_abc · exited 0 · 0s\]/);
  assert.match(text, /make test/);
  assert.match(text, /ok 1/);
  assert.match(text, /Full output: \/tmp\/x\.log/);
  assert.doesNotMatch(text, /Timed out/);

  const timedOut = formatBackgroundRunResult({
    runId: "r_tmo", command: "sleep 30", status: "failed", durationMs: 3_000,
    output: "start", error: "Timed out after 3 second(s).",
  });
  assert.match(timedOut, /failed · 3s/);
  assert.match(timedOut, /Timed out after 3 second\(s\)\./);
});

test("the background run card collapses output and expands it on demand", () => {
  const details: BackgroundRunResultDetails = {
    runId: "a3f941e0-1c7b", command: "npm test", status: "failed", exitCode: 2, durationMs: 42_000,
  };
  const theme = { fg: (_color: string, text: string) => text, bg: (_color: string, text: string) => text } as unknown as Theme;
  const collapsed = renderBackgroundRunMessage(
    { customType: BACKGROUND_RUN_RESULT_TYPE, content: "[tail output]", display: true, details, timestamp: 1 } as any,
    { expanded: false, outputPad: 1 },
    theme,
  )!.render(80).join("\n");
  assert.match(collapsed, /Background run.*settled.*a3f941e0/);
  assert.match(collapsed, /exited 2/);
  assert.match(collapsed, /npm test/);
  assert.doesNotMatch(collapsed, /\[tail output\]/);

  const expanded = renderBackgroundRunMessage(
    { customType: BACKGROUND_RUN_RESULT_TYPE, content: "[tail output]", display: true, details, timestamp: 1 } as any,
    { expanded: true, outputPad: 1 },
    theme,
  )!.render(80).join("\n");
  assert.match(expanded, /output[\s\S]*\[tail output\]/);

  // A manual kill renders as a "cancelled" card, not "settled".
  const killed = renderBackgroundRunMessage(
    {
      customType: BACKGROUND_RUN_RESULT_TYPE,
      content: "",
      display: true,
      details: { ...details, status: "cancelled", exitCode: null },
      timestamp: 1,
    } as any,
    { expanded: false, outputPad: 1 },
    theme,
  )!.render(80).join("\n");
  assert.match(killed, /Background run.*cancelled/);
  assert.match(killed, /− cancelled/);
});

test("composer border shows the background run count between context and mode", () => {
  const border = (text: string) => text;
  const full = composerBorder(40, "default", "45%/200k", " ⏳2", border);
  assert.equal(visibleWidth(full), 40, "border always fills the width");
  assert.match(full, /45%\/200k/);
  assert.match(full, /⏳2/);
  assert.match(full, /◆ default ◇/);

  // Runs drop first when narrow, then context.
  const noRuns = composerBorder(27, "default", "45%/200k", " ⏳2", border);
  assert.doesNotMatch(noRuns, /⏳/);
  assert.match(noRuns, /45%\/200k/);
  const noContext = composerBorder(21, "default", "45%/200k", " ⏳2", border);
  assert.doesNotMatch(noContext, /45%\/200k/);
  assert.doesNotMatch(noContext, /⏳/);
  assert.match(noContext, /◆ default ◇/);
});

test("the /ps panel lists recent runs first with spaced, muted settled rows", async () => {
  const registry = new BackgroundRunRegistry({ appendEvent: () => {} });
  const quickSettled = settle(registry);
  const quick = registry.launch("echo quick-done", process.cwd());
  await quickSettled;
  const slow = registry.launch("sleep 30", process.cwd());
  // A detached run is a live process left untracked by a reload.
  registry.seed([{ id: "r_det1", command: "sleep 60", cwd: process.cwd(), status: "detached", pid: 2_147_483_647, startedAt: Date.now() }]);
  const tui = { terminal: { rows: 24 }, requestRender: () => {} };
  const keybindings = { matches: () => false };

  // Tagged theme: colored glyphs and bright/muted rows (right-side text may clip
  // because tags inflate width, so full-content checks use the identity theme).
  const panel = new ProcessesPanel(registry, tui as any, taggedTheme() as any, keybindings as any, () => {});
  const text = panel.render(160).join("\n");
  assert.match(text, /Background runs/);
  // Recent first: detached (seeded last) renders above the running and settled runs.
  assert.ok(text.indexOf("sleep 60") < text.indexOf("sleep 30"), "most recent run renders first");
  assert.ok(text.indexOf("sleep 30") < text.indexOf("quick-done"), "running run appears above the settled one");
  // Detached and running rows use the ◐ glyph; settled rows are muted.
  assert.match(text, /<warning>◐<\/warning>/);
  assert.match(text, /<text>sleep 30<\/text>/);
  assert.match(text, /<muted>echo quick-done<\/muted>/);

  // Identity theme: the detached row's right side carries "running · untracked".
  const plain = new ProcessesPanel(registry, tui as any, { fg: (_c: string, t: string) => t, bold: (t: string) => t } as any, keybindings as any, () => {});
  const plainText = plain.render(160).join("\n");
  assert.match(plainText, /untracked/);
  assert.match(plainText, /sleep 60["\s\S]*running["\s\S]*untracked/);

  // Blank line separates the runs (a bordered, padded empty row inside the frame).
  const clean = plainText.replace(/\x1B\[0m\.\.\.\x1B\[0m/g, "").replace(/│/g, "");
  const cleanLines = clean.split("\n");
  const between = cleanLines.slice(
    cleanLines.findIndex((line) => line.includes("sleep 30")) + 1,
    cleanLines.findIndex((line) => line.includes("quick-done")),
  );
  assert.ok(between.some((line) => line.trim() === ""), "runs are separated by a blank line");

  // x kills the selected (top, detached) run, then j + x kills the running one.
  panel.handleInput("x");
  assert.equal(registry.get("r_det1")?.status, "cancelled", "x kills a detached run");
  panel.handleInput("j");
  panel.handleInput("x");
  assert.equal(registry.get(slow.id)?.status, "cancelled");
  panel.dispose();
  plain.dispose();
});

function taggedTheme(): any {
  return { fg: (color: string, text: string) => `<${color}>${text}</${color}>`, bold: (text: string) => `<bold>${text}</bold>` };
}
