// Deterministic manual UI fixture. Not part of the package manifest; makes no model calls.
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { zeroUsage, type Subagents } from "../../src/subagents/runtime.ts";

export default function (pi: ExtensionAPI) {
  let runtime: Subagents;
  pi.on("session_start", (_event, ctx) => {
    runtime = (globalThis as any)[Symbol.for("pi-extensions/subagents/v1")].get(ctx.sessionManager.getSessionId()).runtime;
    runtime.attach({
      save: state => pi.appendEntry("subagents-state-v1", state),
      deliver: report => pi.sendMessage({ customType: "subagent-completion", content: `${report.agent}: ${report.status}`, details: report, display: true }),
    });
    runtime.createChild = async record => {
      let finish!: () => void;
      const promise = new Promise<void>(resolve => { finish = resolve; });
      let done = false;
      return { prompt: async () => { await promise; done = true; }, waitForIdle: async () => {}, abort: async () => finish(), dispose() {},
        output: () => "Checked the configured models and extension entry points.\n\n- Atlas: Luna, high reasoning\n- Forge: DeepSeek Flash, high reasoning\n- Vigil: Astra, high reasoning\n\nNo files changed.\n\nAdditional evidence is available in the full report.", error: () => undefined,
        usage: () => done ? ({ ...zeroUsage(), input: 4000, output: 102, totalTokens: 4102,
          cost: { input: 0.008, output: 0.002, cacheRead: 0, cacheWrite: 0, total: 0.01 } }) : zeroUsage(), deliver: async () => {},
      };
    };
  });
  pi.registerCommand("ui-age", {
    handler: async () => {
      for (const record of runtime.records.values()) if (record.finishedAt) record.finishedAt = Date.now() - 119000;
      runtime.save();
    },
  });
  pi.registerCommand("ui-finish", {
    handler: async () => { for (const job of [...runtime.jobs.values()]) await job.child?.abort(); },
  });
  pi.registerCommand("ui-seed", {
    handler: async () => {
      const roles = ["Forge", "Vigil", "minimal"];
      for (const agent of roles) {
        const record = runtime.reserve(runtime.root, { agent, depth: 1, model: agent === "Forge" ? "opencode-go/deepseek-v4.1-flash" : "openai-codex/gpt-6-astra", thinking: "high", tools: ["read", "bash"], prompt: "" }, `${agent}: audit authentication and preserve existing work`, true);
        void runtime.start(record, record.task, true);
        record.title = agent === "Forge" ? "Implement token refresh safely" : agent === "Vigil" ? "Review concurrent session recovery" : "Check documentation 日本語 🔍";
        record.activity = agent === "Forge" ? "edit" : "read";
        if (agent === "Forge") {
          const child = runtime.reserve(record.handle, { agent: "Atlas", depth: 2, model: "openai-codex/gpt-6-luna", thinking: "high", tools: ["read", "web"], prompt: "" }, "Trace refresh-token ownership", true);
          void runtime.start(child, child.task, true); child.title = "Trace refresh-token ownership"; child.activity = "web";
        }
      }
      runtime.changed();
    },
  });
}
