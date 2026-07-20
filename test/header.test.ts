import assert from "node:assert/strict";
import { test } from "node:test";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { discoverAvailableSkills, renderHeader, type HeaderInfo } from "../src/ui/header.ts";

const info: HeaderInfo = {
  version: "0.80.7",
  concurrency: 10,
  skills: ["pi-internals", "terminal-control"],
  configFile: ".pi/agents.yaml",
  contextFiles: ["my-pi-setup/resources/SYSTEM.md", "AGENTS.md"],
  agents: [
    { name: "Atlas", model: "gpt-5.6-luna", thinking: "medium" },
    { name: "Vigil", model: "gpt-5.6-sol", thinking: "high" },
  ],
};

function plain(value: string): string {
  return value.replace(/\x1b\[[0-9;]*m/g, "");
}

test("startup screen lists Pi's resolved skills rather than scanning selected directories", () => {
  const systemPrompt = `
<available_skills>
  <skill>
    <name>global-skill</name>
    <description>From a global location</description>
    <location>/home/user/.pi/agent/skills/global/SKILL.md</location>
  </skill>
  <skill>
    <name>settings-skill</name>
    <description>From a settings path</description>
    <location>/opt/skills/settings/SKILL.md</location>
  </skill>
  <skill>
    <name>escaped-&amp;-valid</name>
    <description>Escaped XML remains valid</description>
    <location>/tmp/skill/SKILL.md</location>
  </skill>
</available_skills>`;

  assert.deepEqual(discoverAvailableSkills(systemPrompt), ["escaped-&-valid", "global-skill", "settings-skill"]);
  assert.deepEqual(discoverAvailableSkills("no skills here"), []);
});

test("startup screen uses the centralized semantic role colors", () => {
  const colors: string[] = [];
  const theme = {
    fg: (color: string, text: string) => {
      if (text.includes("◆") || /ATLAS|VIGIL/.test(text)) colors.push(color);
      return text;
    },
  } as unknown as Theme;

  renderHeader("~/project", 120, info, theme);
  assert.deepEqual(colors, [
    "mdLink", "mdLink",
    "thinkingMax", "thinkingMax",
  ]);
});

test("startup screen renders arbitrary configured roles dynamically", () => {
  const customInfo = { ...info, agents: [...info.agents, { name: "Worker", model: "custom-model", thinking: "high" }] };
  const output = renderHeader("~/project", 120, customInfo).map(plain).join("\n");
  assert.match(output, /WORKER/);
  assert.match(output, /custom-model/);
});

test("startup screen is structured, branded, and width-safe", () => {
  for (const width of [24, 64, 120]) {
    const lines = renderHeader("~/Documents/dev_shit/pi-extensions", width, info);
    assert.ok(lines.length >= 10);
    assert.ok(lines.every((line) => visibleWidth(line) <= width));
  }
  const output = renderHeader("~/project", 120, info).map(plain).join("\n");
  assert.match(output, /██████╗/);
  assert.match(output, /Pi 0\.80\.7/);
  assert.match(output, /AGENTS.*CONTEXT.*ATLAS.*SYSTEM\.md.*VIGIL/s);
  assert.match(output, /\.pi\/agents\.yaml.*10 concurrent/);
  assert.match(output, /COMMANDS.*SKILLS.*\/agents.*pi-internals.*\/name/s);
  assert.match(output, /SHORTCUTS.*Alt\+M/s);
  assert.doesNotMatch(output, /\n\s*SETUP\s|nested delegation|persistent follow-ups/i);
});
