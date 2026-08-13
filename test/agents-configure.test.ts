import assert from "node:assert/strict";
import { test } from "node:test";
import type { KeybindingsManager, Theme } from "@earendil-works/pi-coding-agent";
import type { TUI } from "@earendil-works/pi-tui";
import { KeybindingsManager as PiTuiKeybindingsManager, TUI_KEYBINDINGS, visibleWidth } from "@earendil-works/pi-tui";
import {
  AgentModelConfigurePanel,
  showAgentModelConfigure,
  type AgentModelConfigureInput,
  type AgentModelConfigureResult,
} from "../src/ui/agents-configure.ts";

const ENTER = "\r";
const DOWN = "\x1b[B";
const TAB = "\t";
const ESCAPE = "\x1b";
const theme = { fg: (_color: string, text: string) => text } as unknown as Theme;
const tui = { terminal: { rows: 24 }, requestRender() {} } as unknown as TUI;
const keybindings = new PiTuiKeybindingsManager(TUI_KEYBINDINGS) as unknown as KeybindingsManager;

const input: AgentModelConfigureInput = {
  roles: [
    { name: "Atlas", model: "opencode-go/fast", configuredModel: "opencode-go/fast", thinking: "high" },
    { name: "Vigil", model: "openai-codex/deep", configuredModel: "openai-codex/deep", thinking: "high" },
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

function panel(source = input, results: AgentModelConfigureResult[] = []) {
  return new AgentModelConfigurePanel(source, tui, theme, keybindings, (result) => results.push(result));
}

function output(subject: AgentModelConfigurePanel, width = 70): string {
  return subject.render(width).join("\n");
}

test("picker defaults to scoped models and Tab reveals all providers and models", () => {
  const subject = panel();
  assert.match(output(subject), /scoped models/);
  subject.handleInput(ENTER); // Atlas -> providers
  assert.match(output(subject), /OpenCode Go/);
  assert.doesNotMatch(output(subject), /Codex/);

  subject.handleInput(TAB);
  assert.match(output(subject), /all models/);
  assert.match(output(subject), /Codex/);
  subject.handleInput(TAB);
  assert.match(output(subject), /scoped models/);
  assert.doesNotMatch(output(subject), /Codex/);
});

test("role, provider, and filtered model selection returns a canonical model ID", () => {
  const results: AgentModelConfigureResult[] = [];
  const subject = panel(input, results);
  subject.handleInput(ENTER); // Atlas
  subject.handleInput(TAB); // all
  subject.handleInput(ENTER); // Codex sorts before OpenCode Go
  subject.handleInput("m");
  subject.handleInput("i");
  assert.match(output(subject), /filter: mi/);
  assert.match(output(subject), /Mini/);
  assert.doesNotMatch(output(subject), /Deep\s/);
  subject.handleInput(ENTER);
  assert.deepEqual(results, [{ role: "Atlas", model: "openai-codex/mini" }]);
});

test("an overridden role offers reset to its configured model", () => {
  const results: AgentModelConfigureResult[] = [];
  const overridden: AgentModelConfigureInput = {
    ...input,
    roles: [{ name: "Atlas", model: "openai-codex/mini", configuredModel: "opencode-go/fast", thinking: "high" }],
  };
  const subject = panel(overridden, results);
  assert.match(output(subject), /mini · high/);
  subject.handleInput(ENTER);
  assert.match(output(subject), /Reset to configured model/);
  subject.handleInput(ENTER);
  assert.deepEqual(results, [{ role: "Atlas", reset: true }]);
});

test("Escape walks back through stages and rendering stays width-safe", () => {
  const results: AgentModelConfigureResult[] = [];
  const subject = panel(input, results);
  subject.handleInput(ENTER);
  subject.handleInput(ENTER);
  subject.handleInput(ESCAPE);
  assert.match(output(subject), /providers/);
  subject.handleInput(ESCAPE);
  assert.match(output(subject), /roles/);
  subject.handleInput(ESCAPE);
  assert.deepEqual(results, [undefined]);
  for (const width of [24, 40, 84]) assert.ok(subject.render(width).every((line) => visibleWidth(line) <= width));
});

test("empty Pi scope means all available models without a fake scoped view", () => {
  const subject = panel({ ...input, scopedModels: [] });
  assert.match(output(subject), /all models/);
  subject.handleInput(ENTER);
  assert.match(output(subject), /Codex/);
  subject.handleInput(TAB);
  assert.match(output(subject), /all models/);
});

test("showAgentModelConfigure requires TUI, roles, and available models", async () => {
  assert.equal(await showAgentModelConfigure({ mode: "rpc", ui: { custom() {} } }, input), undefined);
  assert.equal(await showAgentModelConfigure({ mode: "tui", ui: { custom() {} } }, { ...input, roles: [] }), undefined);
  assert.equal(await showAgentModelConfigure({ mode: "tui", ui: { custom() {} } }, { ...input, allModels: [] }), undefined);
});
