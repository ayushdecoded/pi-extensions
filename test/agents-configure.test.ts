import assert from "node:assert/strict";
import { test } from "node:test";
import type { KeybindingsManager, Theme } from "@earendil-works/pi-coding-agent";
import type { TUI } from "@earendil-works/pi-tui";
import { KeybindingsManager as PiTuiKeybindingsManager, TUI_KEYBINDINGS, visibleWidth } from "@earendil-works/pi-tui";
import {
  AgentModelConfigurePanel,
  showAgentModelConfigure,
  type AgentModelConfigureInput,
  type AgentRoleConfigureChange,
} from "../src/ui/agents-configure.ts";

const ENTER = "\r";
const DOWN = "\x1b[B";
const TAB = "\t";
const ESCAPE = "\x1b";
const theme = { fg: (_color: string, text: string) => text } as unknown as Theme;
const tui = { terminal: { rows: 24 }, requestRender() {} } as unknown as TUI;
const keybindings = new PiTuiKeybindingsManager(TUI_KEYBINDINGS) as unknown as KeybindingsManager;

const input: AgentModelConfigureInput = {
  mode: "deep",
  roles: [
    { name: "Atlas", model: "opencode-go/fast", thinking: "high", configuredModel: "opencode-go/fast", configuredThinking: "high" },
    { name: "Vigil", model: "openai-codex/mini", thinking: "high", configuredModel: "openai-codex/deep", configuredThinking: "high" },
  ],
  scopedModels: [
    { provider: "opencode-go", providerLabel: "OpenCode Go", id: "fast", name: "Fast" },
  ],
  allModels: [
    { provider: "opencode-go", providerLabel: "OpenCode Go", id: "fast", name: "Fast" },
    { provider: "openai-codex", providerLabel: "Codex", id: "deep", name: "Deep" },
    { provider: "openai-codex", providerLabel: "Codex", id: "mini", name: "Mini" },
  ],
};

type Change = { role: string; change: AgentRoleConfigureChange };

function panel(source = input, changes: Change[] = [], closed: boolean[] = []) {
  return new AgentModelConfigurePanel(
    source,
    tui,
    theme,
    keybindings,
    (role, change) => changes.push({ role, change }),
    () => closed.push(true),
  );
}

function output(subject: AgentModelConfigurePanel, width = 70): string {
  return subject.render(width).join("\n");
}

function plain(value: string): string {
  return value.replace(/\x1b\[[0-9;]*m/g, "");
}

test("header shows the active mode and scope, and Tab reveals all providers", () => {
  const subject = panel();
  const initial = plain(output(subject));
  assert.match(initial, /Configure subagents.*mode: deep.*scoped models/);

  subject.handleInput(ENTER); // Atlas -> settings
  assert.match(plain(output(subject)), /settings · Atlas/);
  assert.match(plain(output(subject)), /Model\s+fast/);
  assert.match(plain(output(subject)), /Thinking\s+high/);

  subject.handleInput(ENTER); // Model -> providers
  assert.match(plain(output(subject)), /OpenCode Go/);
  assert.doesNotMatch(plain(output(subject)), /Codex/);

  subject.handleInput(TAB);
  const all = plain(output(subject));
  assert.match(all, /all models/);
  assert.match(all, /Codex/);
});

test("selecting a model reports the canonical ID immediately", () => {
  const changes: Change[] = [];
  const subject = panel(input, changes);
  subject.handleInput(ENTER); // Atlas -> settings
  subject.handleInput(ENTER); // Model -> providers
  subject.handleInput(TAB); // all
  subject.handleInput(ENTER); // Codex sorts before OpenCode Go
  subject.handleInput("m");
  subject.handleInput("i");
  assert.match(plain(output(subject)), /filter: mi/);
  subject.handleInput(ENTER);
  assert.deepEqual(changes, [{ role: "Atlas", change: { kind: "model", model: "openai-codex/mini" } }]);
  assert.match(plain(output(subject)), /settings · Atlas/, "panel stays open for more edits");
});

test("selecting a thinking level reports it immediately", () => {
  const changes: Change[] = [];
  const subject = panel(input, changes);
  subject.handleInput(ENTER); // Atlas -> settings
  subject.handleInput(DOWN); // Thinking
  subject.handleInput(ENTER);
  assert.match(plain(output(subject)), /thinking · Atlas/);
  assert.match(plain(output(subject)), /selected/, "current level is marked");
  subject.handleInput(DOWN); // xhigh
  subject.handleInput(DOWN); // max
  subject.handleInput(ENTER);
  assert.deepEqual(changes, [{ role: "Atlas", change: { kind: "thinking", thinking: "max" } }]);
});

test("overridden roles offer per-field resets in settings", () => {
  const changes: Change[] = [];
  const subject = panel(input, changes);
  subject.handleInput(DOWN); // Vigil (overridden model)
  subject.handleInput(ENTER); // Vigil -> settings
  const settings = plain(output(subject));
  assert.match(settings, /Reset model/);
  assert.doesNotMatch(settings, /Reset thinking/, "only changed fields offer reset");
  subject.handleInput(DOWN); // Thinking
  subject.handleInput(DOWN); // Reset model
  subject.handleInput(ENTER);
  assert.deepEqual(changes, [{ role: "Vigil", change: { kind: "reset-model" } }]);
});

test("Escape walks back through stages and closing is idempotent", () => {
  const closed: boolean[] = [];
  const subject = panel(input, [], closed);
  subject.handleInput(ENTER); // Atlas -> settings
  subject.handleInput(ENTER); // Model -> providers
  subject.handleInput(ENTER); // Codex -> models
  subject.handleInput(ESCAPE); // models -> providers
  assert.match(plain(output(subject)), /providers · Atlas/);
  subject.handleInput(ESCAPE); // providers -> settings
  assert.match(plain(output(subject)), /settings · Atlas/);
  subject.handleInput(ESCAPE); // settings -> roles
  assert.match(plain(output(subject)), /roles/);
  subject.handleInput(ESCAPE); // roles -> close
  assert.deepEqual(closed, [true]);
});

test("padding keeps rows indented and rendering width-safe at all stages", () => {
  const subject = panel(input);
  subject.handleInput(ENTER); // settings
  subject.handleInput(ENTER); // providers
  subject.handleInput(TAB); // all
  subject.handleInput(ENTER); // models
  for (const width of [24, 40, 84]) {
    const lines = subject.render(width);
    assert.ok(lines.every((line) => visibleWidth(line) <= width), `line exceeds ${width}: ${JSON.stringify(plain(lines.join("\n")))}`);
  }
  const rendered = subject.render(84);
  assert.equal(rendered[0], "", "a blank line pads the top");
  assert.equal(rendered.at(-1), "", "a blank line pads the bottom");
  assert.match(plain(rendered.join("\n")), /^│  /m, "rows are padded inside the frame");
});

test("empty Pi scope means all available models without a fake scoped view", () => {
  const subject = panel({ ...input, scopedModels: [] });
  assert.match(plain(output(subject)), /all models/);
  subject.handleInput(ENTER); // Atlas -> settings
  subject.handleInput(ENTER); // Model -> providers
  assert.match(plain(output(subject)), /Codex/);
});

test("showAgentModelConfigure requires TUI, roles, and available models", async () => {
  const noop = () => {};
  assert.equal(await showAgentModelConfigure({ mode: "rpc", ui: { custom() {} } }, input, noop), undefined);
  assert.equal(await showAgentModelConfigure({ mode: "tui", ui: { custom() {} } }, { ...input, roles: [] }, noop), undefined);
  assert.equal(await showAgentModelConfigure({ mode: "tui", ui: { custom() {} } }, { ...input, allModels: [] }, noop), undefined);
});
