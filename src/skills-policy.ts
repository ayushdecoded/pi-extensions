import os from "node:os";
import path from "node:path";
import type { Skill } from "@earendil-works/pi-coding-agent";

/** Whether cwd is a project workspace under ~/Projects. */
export function isProjectWorkspace(cwd: string, homeDir: string = os.homedir()): boolean {
  const projectsRoot = path.resolve(homeDir, "Projects");
  const relative = path.relative(projectsRoot, path.resolve(cwd));
  return relative !== "" && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

/** Whether a skill path belongs to one of Pi's global skill roots. */
export function isGlobalSkillPath(filePath: string, homeDir: string = os.homedir()): boolean {
  const skillPath = path.resolve(filePath);
  const globalRoots = [
    path.resolve(homeDir, ".agents", "skills"),
    path.resolve(homeDir, ".pi", "agent", "skills"),
  ];
  return globalRoots.some((root) => skillPath === root || skillPath.startsWith(`${root}${path.sep}`));
}

/**
 * Hide automatically discovered user/global skills inside project workspaces.
 * Explicit and project/package skills remain visible.
 */
export function filterVisibleSkills(
  skills: Skill[],
  cwd: string,
  homeDir: string = os.homedir(),
): Skill[] {
  if (!isProjectWorkspace(cwd, homeDir)) return skills;

  return skills.filter((skill) => {
    if (skill.sourceInfo.scope !== "user") return true;
    return !isGlobalSkillPath(skill.filePath, homeDir);
  });
}

/** Apply the same visibility policy to an already-formatted model prompt. */
export function filterVisibleSkillsPrompt(
  prompt: string,
  cwd: string,
  homeDir: string = os.homedir(),
): string {
  if (!isProjectWorkspace(cwd, homeDir)) return prompt;
  return prompt.replace(/\s*<skill>\s*([\s\S]*?)\s*<\/skill>/gu, (block, body: string) => {
    const location = body.match(/<location>([\s\S]*?)<\/location>/u)?.[1];
    return location && isGlobalSkillPath(unescapeXml(location), homeDir) ? "" : block;
  });
}

function unescapeXml(value: string): string {
  return value
    .replace(/&quot;/gu, '"')
    .replace(/&apos;/gu, "'")
    .replace(/&gt;/gu, ">")
    .replace(/&lt;/gu, "<")
    .replace(/&amp;/gu, "&");
}
