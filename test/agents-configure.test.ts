import assert from "node:assert/strict";
import { test } from "node:test";
import type { KeybindingsManager, Theme } from "@earendil-works/pi-coding-agent";
import type { TUI } from "@earendil-works/pi-tui";
import { KeybindingsManager as PiTuiKeybindingsManager, TUI_KEYBINDINGS, visibleWidth } from "@earendil-works/pi-tui";
import {
  AgentModelConfigurePanel,
  showAgentModelConfigure,
  type AgentConfigureCallbacks,
  type AgentConfigureResult,
  type AgentModelConfigureInput,
  type AgentRoleConfigState,
  type AgentRoleConfigureChange,
} from "../src/ui/agents-configure.ts";

const ENTER = "\r";
const DOWN = "\x1b[B";
const UP = "\x1b[A";
const TAB = "\t";
const ESCAPE = "\x1b";
const LEFT = "\x1b[D";
const RIGHT = "\x1b[C";
const SPACE = " ";

const theme = { fg: (_color: string, text: string) => text } as unknown as Theme;
const tui = { terminal: { rows: 24 }, requestRender() {} } as unknown as TUI;
const keybindings = new PiTuiKeybindingsManager(TUI_KEYBINDINGS) as unknown as KeybindingsManager;

function roleState(over: Partial<AgentRoleConfigState> = {}): AgentRoleConfigState {
  return {
    name: "Atlas",
    enabled: true,
    model: "opencode-go/fast",
    thinking: "high",
    configuredModel: "opencode-go/fast",
    configuredThinking: "high",
    ...over,
  };
}

function baseInput(): AgentModelConfigureInput {
  return {
    mode: "deep",
    roles: [
      roleState(),
      roleState({ name: "Vigil", model: "openai-codex/mini", configuredModel: "openai-codex/deep" }),
    ],
    scopedModels: [{ provider: "opencode-go", providerLabel: "OpenCode Go", id: "fast", name: "Fast" }],
    allModels: [
      { provider: "opencode-go", providerLabel: "OpenCode Go", id: "fast", name: "Fast" },
      { provider: "openai-codex", providerLabel: "Codex", id: "deep", name: "Deep" },
      { provider: "openai-codex", providerLabel: "Codex", id: "mini", name: "Mini" },
    ],
  };
}

type Harness = {
  subject: AgentModelConfigurePanel;
  seen: {
    changes: Array<{ role: string; change: AgentRoleConfigureChange }>;
    savedScopes: string[];
    scopeChanges: string[];
    reloads: number;
    refreshes: number;
  };
  closed: boolean[];
  setRefreshState: (next: AgentModelConfigureInput) => void;
  failNextReload: (error: string) => void;
};

/**
 * Host stand-in: the panel edits a clone of the initial input, which is exactly
 * what `refresh()` hands back — so any displayed update proves the panel
 * re-read host state instead of trusting its construction snapshot.
 */
function harness(source = baseInput()): Harness {
  const seen = {
    changes: [] as Array<{ role: string; change: AgentRoleConfigureChange }>,
    savedScopes: [] as string[],
    scopeChanges: [] as string[],
    reloads: 0,
    refreshes: 0,
  };
  const closed: boolean[] = [];
  let refreshState: AgentModelConfigureInput = structuredClone(source);
  let reloadImpl: () => AgentConfigureResult = () => ({});
  const callbacks: AgentConfigureCallbacks = {
    refresh: () => {
      seen.refreshes += 1;
      return refreshState;
    },
    onChange: (role, change) => {
      seen.changes.push({ role, change });
      const target = refreshState.roles.find((candidate) => candidate.name === role);
      if (target) {
        if (change.kind === "model") target.model = change.model;
        else if (change.kind === "thinking") target.thinking = change.thinking;
        else if (change.kind === "enabled") target.enabled = change.enabled;
        else if (change.kind === "reset-model") target.model = target.configuredModel;
        else if (change.kind === "reset-thinking") target.thinking = target.configuredThinking;
      }
      return {};
    },
    onScopeChange: (scope) => seen.scopeChanges.push(scope),
    onSaveDefaults: (scope) => {
      seen.savedScopes.push(scope);
      return {};
    },
    onReload: () => {
      seen.reloads += 1;
      return reloadImpl();
    },
  };
  return {
    subject: new AgentModelConfigurePanel(source, tui, theme, keybindings, callbacks, () => closed.push(true)),
    seen,
    closed,
    setRefreshState: (next) => { refreshState = next; },
    failNextReload: (error) => {
      reloadImpl = () => {
        reloadImpl = () => ({}); // one-shot: later reloads succeed
        return { error };
      };
    },
  };
}

function output(subject: AgentModelConfigurePanel, width = 70): string {
  return subject.render(width).join("\n");
}

function plain(value: string): string {
  return value.replace(/\x1b\[[0-9;]*m/g, "");
}

test("the role list labels scope, save, and reload explicitly", () => {
  const { subject } = harness();
  const out = plain(output(subject));
  assert.match(out, /Configure subagents/);
  assert.match(out, /mode: deep/);
  assert.match(out, /Scope\s+▸session◂\s+·\s+project\s+·\s+global/);
  assert.match(out, /Save defaults\s+session · all roles/);
  assert.match(out, /Reload configs\s+clears session overrides/);
  assert.doesNotMatch(out, /[Bb]ackend|[Dd]evin/, "backend support is gone");
});

test("disabled roles are displayed as blocking future work", () => {
  const input = baseInput();
  input.roles[1]!.enabled = false;
  const { subject } = harness(input);
  const out = plain(output(subject));
  assert.match(out, /Vigil\s+disabled/);
  assert.match(out, /Atlas\s+fast · high/, "enabled roles keep their model summary");
});

test("selecting a role opens a focused settings pane", () => {
  const { subject } = harness();
  subject.handleInput(ENTER); // Atlas -> settings
  const out = plain(output(subject, 84));
  assert.match(out, /settings · Atlas/);
  assert.match(out, /Enabled · session\s+on/);
  assert.match(out, /Model\s+fast/);
  assert.match(out, /Thinking\s+high/);
  assert.match(out, /✓ Done/);
  assert.doesNotMatch(out, /Reset/, "clean roles offer no reset rows");
  assert.doesNotMatch(out, /settings · Vigil/, "only the selected role's settings are shown");
});

test("the model picker searches across providers without a provider stage", () => {
  const { subject, seen } = harness();
  subject.handleInput(ENTER); // Atlas -> settings
  subject.handleInput(DOWN); // Model
  subject.handleInput(ENTER); // picker
  const picker = plain(output(subject, 84));
  assert.match(picker, /models · Atlas/);
  assert.match(picker, /type to filter/);
  assert.match(picker, /Fast\s+✓ current/, "the role's current model is marked");
  assert.doesNotMatch(picker, /Mini/, "the Pi scope limits the initial list");

  subject.handleInput(TAB); // all available models
  const all = plain(output(subject, 84));
  assert.match(all, /Mini/);
  assert.match(all, /Deep/);

  subject.handleInput("m");
  subject.handleInput("i");
  const filtered = plain(output(subject, 84));
  assert.match(filtered, /filter: mi/);
  assert.doesNotMatch(filtered, /Deep/, "the filter applies to all models");

  subject.handleInput(ENTER);
  assert.deepEqual(seen.changes, [{ role: "Atlas", change: { kind: "model", model: "openai-codex/mini" } }]);
  assert.match(plain(output(subject, 84)), /Model\s+mini/, "the refreshed host model is displayed");
});

test("the panel re-reads host state on reload instead of its snapshot", () => {
  const { subject, seen, setRefreshState } = harness();
  const fresh = baseInput();
  fresh.roles[0]!.model = "anthropic/claude-x";
  fresh.roles[0]!.configuredModel = "anthropic/claude-x";
  assert.doesNotMatch(plain(output(subject)), /claude-x/, "the construction snapshot still shows the old model");
  setRefreshState(fresh); // the host re-read agents.yaml behind the panel's back
  subject.handleInput("r"); // reload
  assert.equal(seen.reloads, 1);
  assert.ok(seen.refreshes >= 1, "reload consults refresh()");
  assert.deepEqual(seen.changes, []);
  assert.match(plain(output(subject)), /Atlas\s+claude-x/, "display follows refreshed host state");
});

test("applied changes adopt refreshed host state, not local guesses", () => {
  const { subject, seen } = harness();
  subject.handleInput(ENTER); // Atlas -> settings
  subject.handleInput(ENTER); // toggle Enabled (settings index 0)
  assert.deepEqual(seen.changes, [{ role: "Atlas", change: { kind: "enabled", enabled: false } }]);
  assert.match(plain(output(subject, 84)), /Enabled · session\s+off · blocks new work/);
  assert.match(plain(output(subject, 100)), /Atlas\s+disabled/, "role list reflects the adopted change");
});

test("the enabled toggle is session-only regardless of the chosen scope", () => {
  const { subject, seen } = harness();
  subject.handleInput(RIGHT); // scope -> project
  assert.deepEqual(seen.scopeChanges, ["project"]);
  subject.handleInput(ENTER); // Atlas -> settings
  subject.handleInput(ENTER); // toggle Enabled
  assert.deepEqual(seen.changes, [{ role: "Atlas", change: { kind: "enabled", enabled: false } }]);
  subject.handleInput(ENTER); // toggle back
  assert.deepEqual(seen.changes[1], { role: "Atlas", change: { kind: "enabled", enabled: true } });
});

test("arrow keys cycle the scope and save defaults target it", () => {
  const { subject, seen } = harness();
  subject.handleInput(RIGHT);
  assert.match(plain(output(subject)), /▸project◂/);
  subject.handleInput(RIGHT);
  assert.match(plain(output(subject)), /▸global◂/);
  subject.handleInput(LEFT);
  assert.match(plain(output(subject)), /▸project◂/);
  assert.deepEqual(seen.scopeChanges, ["project", "global", "project"]);
  subject.handleInput(DOWN);
  subject.handleInput(DOWN); // Save defaults
  subject.handleInput(ENTER);
  assert.deepEqual(seen.savedScopes, ["project"]);
  assert.deepEqual(seen.changes, [], "saving does not emit per-role changes");
  assert.match(plain(output(subject)), /roles/, "the panel stays open after saving");
});

test("the thinking picker marks the current level and emits the selection", () => {
  const { subject, seen } = harness();
  subject.handleInput(ENTER); // Atlas -> settings
  subject.handleInput(DOWN);
  subject.handleInput(DOWN); // Thinking
  subject.handleInput(ENTER); // picker
  const out = plain(output(subject, 84));
  assert.match(out, /thinking · Atlas/);
  assert.match(out, /high\s+✓ current/);
  subject.handleInput(DOWN); // xhigh
  subject.handleInput(DOWN); // max
  subject.handleInput(ENTER);
  assert.deepEqual(seen.changes, [{ role: "Atlas", change: { kind: "thinking", thinking: "max" } }]);
  assert.match(plain(output(subject, 84)), /settings · Atlas/, "the panel returns to settings and stays open");
});

test("reset rows appear only for fields that differ from the persisted baseline", () => {
  const { subject, seen } = harness();
  subject.handleInput(DOWN); // Vigil (model overridden)
  subject.handleInput(ENTER); // settings
  const out = plain(output(subject, 84));
  assert.match(out, /Reset model\s+→ deep/);
  assert.doesNotMatch(out, /Reset thinking/);
  subject.handleInput(DOWN);
  subject.handleInput(DOWN);
  subject.handleInput(DOWN); // Reset model
  subject.handleInput(ENTER);
  assert.deepEqual(seen.changes, [{ role: "Vigil", change: { kind: "reset-model" } }]);
  assert.match(plain(output(subject, 100)), /Vigil\s+deep · high/, "the override dot clears after the reset");
});

test("Escape walks back through panes and Escape on the role list closes", () => {
  const { subject, closed } = harness();
  subject.handleInput(ENTER); // Atlas -> settings
  subject.handleInput(DOWN);
  subject.handleInput(ENTER); // model picker
  subject.handleInput(ESCAPE); // picker -> settings
  assert.match(plain(output(subject, 84)), /settings · Atlas/);
  subject.handleInput(ESCAPE); // settings -> roles
  assert.match(plain(output(subject, 84)), /─ roles ─/);
  assert.doesNotMatch(plain(output(subject, 84)), /─ settings/);
  subject.handleInput(ESCAPE); // close
  assert.deepEqual(closed, [true]);
});

test("reload errors stay visible and leave the working state intact", () => {
  const { subject, seen, failNextReload } = harness();
  failNextReload("Invalid YAML in agents.yaml: bad mapping");
  subject.handleInput("r");
  const out = plain(output(subject));
  assert.match(out, /Invalid YAML in agents\.yaml: bad mapping/);
  assert.match(out, /▸session◂/, "the scope row still renders");
  assert.match(out, /Atlas/, "role rows are untouched");

  // The error persists across renders until an action succeeds.
  assert.match(plain(output(subject)), /Invalid YAML in agents\.yaml/);

  subject.handleInput(DOWN);
  subject.handleInput(DOWN);
  subject.handleInput(DOWN); // Reload configs row
  subject.handleInput(ENTER); // succeeds this time
  assert.equal(seen.reloads, 2);
  assert.doesNotMatch(plain(output(subject)), /Invalid YAML/, "a successful reload clears the error");
  assert.match(plain(output(subject)), /roles/, "the panel stays open");
});

test("wide terminals show the role list beside settings; narrow terminals drill down", () => {
  const { subject, seen, closed } = harness();
  subject.handleInput(ENTER); // select Atlas; the settings pane is focused
  const wide = plain(output(subject, 100));
  assert.match(wide, /─ roles ─/);
  assert.match(wide, /─ settings · Atlas ─/);

  subject.handleInput(SPACE); // toggle the enabled row in the focused settings pane
  assert.match(plain(output(subject, 100)), /Enabled · session\s+off/, "keys act on the focused pane");
  subject.handleInput(TAB); // focus the role list
  subject.handleInput(TAB); // focus settings again
  subject.handleInput(SPACE); // the toggle fires again from the refocused pane

  const narrow = plain(output(subject, 70));
  assert.match(narrow, /─ settings · Atlas ─/);
  assert.doesNotMatch(narrow, /─ roles ─/, "narrow terminals show one pane at a time");

  subject.handleInput(ESCAPE); // settings -> role list (narrow drill-down)
  subject.handleInput(ESCAPE); // close
  assert.deepEqual(closed, [true]);
  assert.ok(seen.changes.length >= 2, "both toggles fired");
});

test("digits jump straight into a role's settings", () => {
  const { subject } = harness();
  subject.handleInput("2");
  assert.match(plain(output(subject, 84)), /settings · Vigil/);
});

test("m and t open pickers straight from the role list", () => {
  const { subject } = harness();
  subject.handleInput(DOWN); // Vigil
  subject.handleInput("t");
  assert.match(plain(output(subject, 84)), /thinking · Vigil/);
  subject.handleInput(ESCAPE);
  subject.handleInput(ESCAPE); // back to the role list
  subject.handleInput(UP); // highlight Atlas
  subject.handleInput("m");
  assert.match(plain(output(subject, 84)), /models · Atlas/);
});

test("models without configured auth stay visible but marked", () => {
  const input = baseInput();
  input.allModels = [
    { provider: "opencode-go", providerLabel: "OpenCode Go", id: "fast", name: "Fast", available: true },
    { provider: "anthropic", providerLabel: "Anthropic", id: "claude-x", name: "Claude X", available: false },
  ];
  const { subject } = harness(input);
  subject.handleInput(ENTER); // settings
  subject.handleInput(DOWN);
  subject.handleInput(ENTER); // model picker (Pi scope: only Fast)
  subject.handleInput(TAB); // all models
  const out = plain(output(subject, 84));
  assert.match(out, /claude-x · no auth/);
  assert.match(out, /Fast\s+✓ current/, "authenticated models render unmarked");
});

test("narrow footer keeps navigation, confirmation, and back hints", () => {
  const { subject } = harness();
  const roles = plain(subject.render(30).join("\n"));
  assert.match(roles, /↑↓/);
  assert.match(roles, /↵ open/);
  assert.match(roles, /esc close/);
  subject.handleInput(ENTER);
  const settings = plain(subject.render(30).join("\n"));
  assert.match(settings, /↑↓/);
  assert.match(settings, /↵ select/);
  assert.match(settings, /esc back/);
});

test("rendering stays width-safe and padded at every pane width", () => {
  const { subject } = harness();
  subject.handleInput(ENTER); // settings
  subject.handleInput(DOWN);
  subject.handleInput(ENTER); // model picker
  for (const width of [24, 40, 70, 84, 100, 130]) {
    const lines = subject.render(width);
    assert.ok(lines.every((line) => visibleWidth(line) <= width), `a line exceeds ${width}: ${JSON.stringify(plain(lines.join("\n")))}`);
    assert.equal(lines[0], "", "a blank line pads the top");
    assert.equal(lines.at(-1), "", "a blank line pads the bottom");
  }
});

test("showAgentModelConfigure requires TUI mode, roles, and available models", async () => {
  let calls = 0;
  const ui = { custom: () => { calls += 1; return Promise.resolve(); } };
  const callbacks: AgentConfigureCallbacks = { refresh: () => baseInput(), onChange: () => {} };
  await showAgentModelConfigure({ mode: "rpc", ui }, baseInput(), callbacks);
  await showAgentModelConfigure({ mode: "tui", ui }, { ...baseInput(), roles: [] }, callbacks);
  await showAgentModelConfigure({ mode: "tui", ui }, { ...baseInput(), allModels: [] }, callbacks);
  assert.equal(calls, 0);
  await showAgentModelConfigure({ mode: "tui", ui }, baseInput(), callbacks);
  assert.equal(calls, 1);
});

test("host actions are guarded while a promise is in flight", async () => {
  const seen = { reloads: 0 };
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const subject = new AgentModelConfigurePanel(baseInput(), tui, theme, keybindings, {
    refresh: () => baseInput(),
    onChange: () => {},
    onReload: async () => {
      seen.reloads += 1;
      await gate;
      return {};
    },
  }, () => {});
  subject.handleInput("r");
  subject.handleInput("r"); // ignored while the first reload is pending
  assert.equal(seen.reloads, 1);
  release();
  await new Promise((resolve) => setTimeout(resolve, 0));
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(seen.reloads, 1);
});

test("a failed change keeps its error visible without replacing working state", () => {
  const { subject, seen } = harness();
  const failing: AgentConfigureCallbacks["onChange"] = () => ({ error: "project .pi is not writable" });
  const guarded = new AgentModelConfigurePanel(baseInput(), tui, theme, keybindings, {
    refresh: () => baseInput(),
    onChange: failing,
  }, () => {});
  guarded.handleInput(ENTER); // Atlas -> settings
  guarded.handleInput(ENTER); // toggle Enabled
  const out = plain(output(guarded, 100));
  assert.match(out, /project \.pi is not writable/);
  assert.match(out, /Enabled · session\s+on/, "the failed toggle does not flip the displayed state");
  assert.match(out, /Atlas\s+fast · high/, "the role list keeps working state");
  assert.deepEqual(seen.changes, []);
});
