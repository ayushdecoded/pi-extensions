// Offline UI-only provider. Not included in package.json; never makes network/model calls.
import { createAssistantMessageEventStream, type AssistantMessage } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { zeroUsage } from "../../src/subagents/runtime.ts";

export default function (pi: ExtensionAPI) {
  pi.registerCommand("ui-multiline", { handler: async (_args, ctx) => { ctx.ui.setEditorText("first line\nsecond line"); } });
  pi.registerProvider("composer-fixture", {
    apiKey: "offline-fixture", api: "openai-completions", baseUrl: "http://127.0.0.1:9", models: [{
      id: "demo-272k", name: "Offline composer fixture", reasoning: true, input: ["text"], contextWindow: 272000, maxTokens: 32000,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    }],
    streamSimple(model, _context, options) {
      const stream = createAssistantMessageEventStream();
      const message: AssistantMessage = { role: "assistant", api: "openai-completions", provider: "composer-fixture", model: model.id,
        content: [], stopReason: "aborted", timestamp: Date.now(), usage: zeroUsage() };
      const stop = () => { stream.push({ type: "error", reason: "aborted", error: message }); stream.end(); };
      if (options?.signal?.aborted) queueMicrotask(stop);
      else options?.signal?.addEventListener("abort", stop, { once: true });
      return stream;
    },
  });
}
