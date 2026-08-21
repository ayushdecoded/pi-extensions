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
    { name: "Atlas", model: "opencode-go/fast", thinking: "high", configuredModel: "opencode-go/fast", configuredThinking: "high", backend: "native", configuredBackend: "native", backendOptions: ["native"] },
    { name: "Vigil", model: "openai-codex/mini", thinking: "high", configuredModel: "openai-codex/deep", configuredThinking: "high", backend: "native", configuredBackend: "native", backendOptions: ["native"] },
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

test("session scope exposes the Forge backend picker", () => {
  const changes: Change[] = [];
  const forgeInput: AgentModelConfigureInput = {
    ...input,
    roles: [{ ...input.roles[0]!, backendOptions: ["native", "devin"] }],
  };
  const subject = panel(forgeInput, changes);
  subject.handleInput(ENTER); // Atlas -> settings
  subject.handleInput(DOWN); // Thinking
  subject.handleInput(DOWN); // Backend
  subject.handleInput(ENTER);
  assert.match(plain(output(subject)), /backends · Atlas/);
  subject.handleInput(DOWN); // Devin
  subject.handleInput(ENTER);
  assert.deepEqual(changes, [{ role: "Atlas", change: { kind: "backend", backend: "devin" } }]);
  assert.match(plain(output(subject)), /SWE-1\.7 Max/);
  assert.doesNotMatch(plain(output(subject)), /fast/);

  const project = panel(forgeInput, changes);
  project.handleInput("\u0013"); // Ctrl+S -> project scope
  project.handleInput(ENTER);
  assert.doesNotMatch(plain(output(project)), /Backend/);
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

function panelWithSave(saved: string[], source = input, changes: Change[] = []) {
  return new AgentModelConfigurePanel(
    source,
    tui,
    theme,
    keybindings,
    (role, change) => changes.push({ role, change }),
    () => {},
    () => {},
    (scope) => saved.push(scope),
  );
}

test("the save row flushes all roles at the current scope and keeps the panel open", () => {
  const changes: Change[] = [];
  const saved: string[] = [];
  const subject = panelWithSave(saved, input, changes);
  assert.match(plain(output(subject)), /Save all roles\s+→ session/);
  assert.match(plain(output(subject)), /1-9 jump/);
  assert.match(plain(output(subject)), /m\/t quick edit/);
  subject.handleInput(DOWN); // Vigil
  subject.handleInput(DOWN); // Save all roles
  subject.handleInput(ENTER);
  assert.deepEqual(saved, ["session"]);
  assert.deepEqual(changes, [], "saving does not emit per-role changes");
  assert.match(plain(output(subject)), /roles/, "panel stays open after saving");
});

test("save targets the scope chosen with Ctrl+S", () => {
  const saved: string[] = [];
  const subject = panelWithSave(saved);
  subject.handleInput("\u0013"); // Ctrl+S -> project
  subject.handleInput("\u0013"); // Ctrl+S -> global
  assert.match(plain(output(subject)), /Save all roles\s+→ global/);
  subject.handleInput(DOWN);
  subject.handleInput(DOWN);
  subject.handleInput(ENTER);
  assert.deepEqual(saved, ["global"]);
});

const RIGHT = "\x1b[C";
const LEFT = "\x1b[D";

function panelWithHooks(saved: string[], scopes: string[], source = input) {
  return new AgentModelConfigurePanel(
    source,
    tui,
    theme,
    keybindings,
    () => {},
    () => {},
    (scope) => scopes.push(scope),
    (scope) => saved.push(scope),
  );
}

test("arrow keys cycle the scope in both directions", () => {
  const saved: string[] = [];
  const scopes: string[] = [];
  const subject = panelWithHooks(saved, scopes);
  assert.match(plain(output(subject)), /scope: session/);
  subject.handleInput(RIGHT);
  assert.match(plain(output(subject)), /scope: project/);
  subject.handleInput(RIGHT);
  assert.match(plain(output(subject)), /scope: global/);
  subject.handleInput(RIGHT); // wraps to session
  assert.match(plain(output(subject)), /scope: session/);
  subject.handleInput(LEFT); // back to global
  assert.match(plain(output(subject)), /scope: global/);
  assert.deepEqual(scopes, ["project", "global", "session", "global"]);
  subject.handleInput(DOWN);
  subject.handleInput(DOWN);
  subject.handleInput(ENTER);
  assert.deepEqual(saved, ["global"]);
});

test("number keys jump to and confirm an item", () => {
  const changes: Change[] = [];
  const subject = panel(input, changes);
  subject.handleInput("2"); // Vigil -> settings
  assert.match(plain(output(subject)), /settings · Vigil/);
  subject.handleInput(ESCAPE); // back to roles
  subject.handleInput("3"); // save row fires without changing selection first
  assert.match(plain(output(subject)), /roles/, "still open after saving");
});

test("m and t act on the highlighted role straight from the roles list", () => {
  const changes: Change[] = [];
  const subject = panel(input, changes);
  subject.handleInput(DOWN); // highlight Vigil
  subject.handleInput("t"); // thinking picker for Vigil
  assert.match(plain(output(subject)), /thinking · Vigil/);
  subject.handleInput(DOWN); // high -> xhigh
  subject.handleInput(ENTER);
  assert.deepEqual(changes, [{ role: "Vigil", change: { kind: "thinking", thinking: "xhigh" } }]);

  const modelChanges: Change[] = [];
  const other = panel(input, modelChanges);
  other.handleInput("1"); // Atlas -> settings via number jump
  other.handleInput("m"); // model picker for Atlas
  assert.match(plain(output(other)), /providers · Atlas/);
});

test("models without configured auth stay visible but marked", () => {
  const withUnauthed: AgentModelConfigureInput = {
    ...input,
    allModels: [
      { provider: "opencode-go", providerLabel: "OpenCode Go", id: "fast", name: "Fast", available: true },
      { provider: "anthropic", providerLabel: "Anthropic", id: "claude-x", name: "Claude X", available: false },
    ],
  };
  const subject = panel(withUnauthed);
  subject.handleInput(ENTER); // Atlas -> settings
  subject.handleInput(ENTER); // Model -> providers
  subject.handleInput(TAB); // all models
  subject.handleInput(ENTER); // Anthropic sorts first -> models
  const rendered = plain(output(subject));
  assert.match(rendered, /claude-x · no auth/);
  subject.handleInput(ESCAPE);
  subject.handleInput(DOWN); // OpenCode Go
  subject.handleInput(ENTER);
  assert.match(plain(output(subject)), /Fast\s+✓ selected/, "authenticated models render unmarked");
  assert.doesNotMatch(plain(output(subject)), /no auth/, "authenticated models are not marked");
});

test("the reload row and r key re-read configs without closing", () => {
  const reloaded: boolean[] = [];
  const subject = new AgentModelConfigurePanel(
    input,
    tui,
    theme,
    keybindings,
    () => {},
    () => {},
    () => {},
    () => {},
    () => reloaded.push(true),
  );
  assert.match(plain(output(subject)), /Reload configs\s+yaml \+ overrides/);
  assert.match(plain(output(subject)), /r reload/);
  subject.handleInput("r"); // direct shortcut
  assert.deepEqual(reloaded, [true]);
  subject.handleInput(DOWN); // Vigil
  subject.handleInput(DOWN); // Save all roles
  subject.handleInput(DOWN); // Reload configs
  subject.handleInput(ENTER);
  assert.deepEqual(reloaded, [true, true]);
  assert.match(plain(output(subject)), /roles/, "panel stays open after reloading");
});
