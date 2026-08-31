import assert from "node:assert/strict";
import test from "node:test";
import { type Skill } from "@earendil-works/pi-coding-agent";
import { filterVisibleSkills, filterVisibleSkillsPrompt, isProjectWorkspace } from "../src/skills-policy.ts";

function skill(filePath: string, scope: "user" | "project" | "temporary"): Skill {
  return {
    name: filePath,
    description: "test",
    filePath,
    baseDir: filePath,
    sourceInfo: { path: filePath, source: "test", scope, origin: "top-level" as const },
    disableModelInvocation: false,
  };
}

test("recognizes project workspaces below ~/Projects", () => {
  assert.equal(isProjectWorkspace("/home/user/Projects/app", "/home/user"), true);
  assert.equal(isProjectWorkspace("/home/user/Projects", "/home/user"), false);
  assert.equal(isProjectWorkspace("/home/user/Documents/app", "/home/user"), false);
});

test("filters the formatted model prompt with the same policy", () => {
  const prompt = `<available_skills>\n  <skill>\n    <name>global</name>\n    <location>/home/user/.agents/skills/global/SKILL.md</location>\n  </skill>\n  <skill>\n    <name>local</name>\n    <location>/home/user/Projects/app/.pi/skills/local/SKILL.md</location>\n  </skill>\n</available_skills>`;
  const filtered = filterVisibleSkillsPrompt(prompt, "/home/user/Projects/app", "/home/user");
  assert.equal(filtered.includes("<name>global</name>"), false);
  assert.equal(filtered.includes("<name>local</name>"), true);
});

test("hides global user skills only inside project workspaces", () => {
  const skills = [
    skill("/home/user/.agents/skills/global/SKILL.md", "user"),
    skill("/home/user/.pi/agent/skills/pi/SKILL.md", "user"),
    skill("/home/user/Projects/app/.pi/skills/local/SKILL.md", "project"),
    skill("/home/user/custom/SKILL.md", "temporary"),
  ];

  assert.deepEqual(
    filterVisibleSkills(skills, "/home/user/Projects/app", "/home/user").map((item) => item.filePath),
    ["/home/user/Projects/app/.pi/skills/local/SKILL.md", "/home/user/custom/SKILL.md"],
  );
  assert.equal(filterVisibleSkills(skills, "/home/user/Documents", "/home/user").length, 4);
});
