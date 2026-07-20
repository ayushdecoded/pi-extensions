import { readFileSync } from "node:fs";
import {
  DefaultResourceLoader,
  getAgentDir,
  SettingsManager,
  type ResourceLoader,
} from "@earendil-works/pi-coding-agent";
import type { AgentRole } from "../config/agents.ts";

export async function createRoleResourceLoader(cwd: string, role: AgentRole): Promise<{
  loader: ResourceLoader;
  settings: SettingsManager;
}> {
  const agentDir = getAgentDir();
  const settings = SettingsManager.create(cwd, agentDir, { projectTrusted: true });
  const rolePrompt = readFileSync(role.promptFile, "utf8").trim();
  const allowedSkills = new Set(role.skills ?? []);

  const loader = new DefaultResourceLoader({
    cwd,
    agentDir,
    settingsManager: settings,
    noExtensions: true,
    noPromptTemplates: true,
    noThemes: true,
    skillsOverride: (base) => ({
      skills: base.skills.filter((skill) => allowedSkills.has(skill.name)),
      diagnostics: base.diagnostics,
    }),
    systemPromptOverride: () => undefined,
    appendSystemPromptOverride: () => [rolePrompt],
  });
  await loader.reload();
  return { loader, settings };
}
