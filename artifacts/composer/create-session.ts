// Build a deterministic native transcript for the offline composer fixture.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { zeroUsage } from "../../src/subagents/runtime.ts";

const manager = SessionManager.create(process.cwd(), mkdtempSync(join(tmpdir(), "composer-ui-fixture-")));
manager.appendModelChange("composer-fixture", "demo-272k");
manager.appendThinkingLevelChange("medium");
const usage = { ...zeroUsage(), input: 528, cacheRead: 43472, output: 128, totalTokens: 44128 };
usage.cost.total = 53.422;
manager.appendMessage({ role: "assistant", api: "openai-completions", model: "demo-272k", provider: "composer-fixture", usage,
  content: [{ type: "text", text: "Offline composer fixture: 98.8% cache hit, $53.422 cost, approximately 16% context." }], stopReason: "stop", timestamp: Date.now() });
console.log(manager.getSessionFile());
