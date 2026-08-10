import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import type {
  BeforeAgentStartEvent,
  BeforeAgentStartEventResult,
  ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import { assemblePackSystemPrompt, registerPackSystemPrompt } from "../src/system-prompt.ts";

test("pack prompt preserves append text, project context, and working directory", () => {
  const prompt = assemblePackSystemPrompt("Pack identity", {
    cwd: "C:\\work\\repo",
    selectedTools: ["bash"],
    appendSystemPrompt: "Additional behavior",
    contextFiles: [{ path: "AGENTS.md", content: "Project guidance" }],
    skills: [],
  });

  assert.equal(prompt.match(/Pack identity/g)?.length, 1);
  assert.match(prompt, /Additional behavior/);
  assert.match(prompt, /<project_instructions path="AGENTS\.md">\nProject guidance/);
  assert.match(prompt, /Current working directory: C:\/work\/repo$/);
});

test("before_agent_start returns one cached replacement and honors explicit SYSTEM.md", () => {
  let handler:
    | ((event: BeforeAgentStartEvent) => BeforeAgentStartEventResult | void)
    | undefined;
  const pi = {
    on(event: string, candidate: (event: BeforeAgentStartEvent) => BeforeAgentStartEventResult | void) {
      if (event === "before_agent_start") handler = candidate;
    },
  } as unknown as ExtensionAPI;
  registerPackSystemPrompt(pi);

  const options = { cwd: "/repo", selectedTools: ["read"], skills: [] };
  const event = {
    type: "before_agent_start",
    prompt: "hello",
    systemPrompt: "native",
    systemPromptOptions: options,
  } as BeforeAgentStartEvent;
  const first = handler!(event);
  const second = handler!({ ...event, prompt: "again" });

  assert.equal(first?.systemPrompt, second?.systemPrompt);
  assert.equal(first?.systemPrompt?.match(/collaborative software engineering agent/g)?.length, 1);
  assert.match(first?.systemPrompt ?? "", /Treat existing code as evidence, not an immutable specification/);
  assert.match(first?.systemPrompt ?? "", /confirm it explicitly with the user/);
  assert.equal(
    handler!({ ...event, systemPromptOptions: { ...options, customPrompt: "project override" } }),
    undefined,
  );
});

test("bundled defaults stay synchronized with the project development copies", async () => {
  const pairs = [
    [".pi/agents.yaml", "resources/agents.yaml"],
    ...["atlas", "forge", "vigil", "vision"].map((role) => [
      `.pi/agents/${role}.md`,
      `resources/agents/${role}.md`,
    ]),
  ];

  for (const [development, bundled] of pairs) {
    assert.equal(await readFile(bundled, "utf8"), await readFile(development, "utf8"), `${bundled} drifted`);
  }
});
