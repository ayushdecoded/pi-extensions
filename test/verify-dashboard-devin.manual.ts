import assert from "node:assert/strict";
import { AgentsDashboard } from "../src/ui/dashboard.ts";
import { applyEvent, emptyRuntimeState } from "../src/runtime/state.ts";
import { ZERO_USAGE } from "../src/runtime/types.ts";
import { agentModelLabel } from "../src/config/agents.ts";

// 1. Verify agentModelLabel core
assert.equal(agentModelLabel("any/model", "devin"), "SWE-1.7 Max");
assert.equal(agentModelLabel("openai-codex/gpt-5", "native"), "gpt-5");
assert.equal(agentModelLabel("openai-codex/gpt-5", undefined), "gpt-5");
console.log("✓ agentModelLabel correctly maps devin->SWE-1.7 Max");

// 2. Verify dashboard uses persisted AgentRecord.backend, not active role config
const state = emptyRuntimeState();
applyEvent(state, { type: "batch.started", batch: { id: "batch-1", createdAt: 1 } });
applyEvent(state, { type: "agent.created", agent: { handle: "forge-1", role: "Forge", sessionFile: "/tmp/fake", createdAt: 1, backend: "devin" } });
applyEvent(state, { type: "invocation.queued", invocation: { id: "inv-1", batchId: "batch-1", agent: "forge-1", role: "Forge", task: "implement", followup: false, ordinal: 1, depth: 1, status: "running", queuedAt: 1, startedAt: 1, timeoutMinutes: 10, usage: { ...ZERO_USAGE } } });

// Runtime where active role config is still native (override not applied or changed)
const runtime = {
  state,
  activities: new Map(),
  liveSessions: new Map(),
  options: { cwd: "/tmp", config: { roles: [{ name: "Forge", model: "provider/native-model", thinking: "high", backend: "native" }] } },
  activeRoles: [{ name: "Forge", model: "provider/native-model", thinking: "high", backend: "native" }],
  subscribe: () => () => {},
  subscribeTranscript: () => () => {},
  transcriptRevision: () => 0,
} as unknown as any;

const tui = { terminal: { rows: 20 }, requestRender() {} } as any;
const theme = { fg: (_c: string, t: string) => t } as any;
const keybindings = { matches: () => false } as any;
const dashboard = new AgentsDashboard(runtime, tui, theme, keybindings, () => {});

// Render tree width >=92 to show model
const treeOutput = dashboard.render(120).join("\n");
console.log("Tree output snippet:", treeOutput.split("\n").slice(0,20).join("\n"));
assert.match(treeOutput, /SWE-1\.7 Max/, "tree should show SWE-1.7 Max from persisted agent backend");
assert.doesNotMatch(treeOutput, /native-model/, "tree should NOT show native fallback when agent backend is devin");
console.log("✓ dashboard tree uses persisted AgentRecord.backend");

// Now test viewer also
// Need to select invocation and open viewer
dashboard.handleInput("\r"); // confirm? Actually need to ensure selected
// Force selectedInvocationId
;(dashboard as any).selectedInvocationId = "inv-1";
const viewerLines = (dashboard as any).renderViewer(120, 20);
const viewerOutput = viewerLines.join("\n");
console.log("Viewer output snippet:", viewerOutput.split("\n").slice(0,20).join("\n"));
assert.match(viewerOutput, /SWE-1\.7 Max/, "viewer should show SWE-1.7 Max from persisted agent backend");
assert.doesNotMatch(viewerOutput, /native-model/);
console.log("✓ dashboard viewer uses persisted AgentRecord.backend");

// 3. Verify fallback when agent backend is native -> shows native model
const state2 = emptyRuntimeState();
applyEvent(state2, { type: "batch.started", batch: { id: "batch-1", createdAt: 1 } });
applyEvent(state2, { type: "agent.created", agent: { handle: "forge-1", role: "Forge", sessionFile: "/tmp/fake", createdAt: 1, backend: "native" } });
applyEvent(state2, { type: "invocation.queued", invocation: { id: "inv-1", batchId: "batch-1", agent: "forge-1", role: "Forge", task: "implement", followup: false, ordinal: 1, depth: 1, status: "running", queuedAt: 1, startedAt: 1, timeoutMinutes: 10, usage: { ...ZERO_USAGE } } });
const runtime2 = { ...runtime, state: state2 } as any;
const dashboard2 = new AgentsDashboard(runtime2, tui, theme, keybindings, () => {});
const tree2 = dashboard2.render(120).join("\n");
assert.match(tree2, /native-model/, "native agent should show native model");
assert.doesNotMatch(tree2, /SWE-1\.7 Max/);
console.log("✓ native backend correctly shows native model");

// 4. Verify when session override flips but old invocation remains devin
// activeRoles now devin but agent was native -> should show native? Actually persists native
// This case ensures we don't just always show current config
const runtime3 = {
  state: state2, // native agent
  activities: new Map(),
  liveSessions: new Map(),
  options: runtime.options,
  activeRoles: [{ name: "Forge", model: "provider/native-model", thinking: "high", backend: "devin" }], // now devin in config
  subscribe: () => () => {},
  subscribeTranscript: () => () => {},
  transcriptRevision: () => 0,
} as any;
const dashboard3 = new AgentsDashboard(runtime3, tui, theme, keybindings, () => {});
const tree3 = dashboard3.render(120).join("\n");
// Agent is native, even though config now devin, should still show native-model (persisted)
assert.match(tree3, /native-model/);
assert.doesNotMatch(tree3, /SWE-1\.7 Max/);
console.log("✓ session override change does not affect persisted native agent display");

console.log("\nAll dashboard backend verifications passed!");
