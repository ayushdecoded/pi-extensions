import { readFileSync } from "node:fs";
import {
  DefaultResourceLoader,
  getAgentDir,
  SettingsManager,
  type InlineExtension,
  type ResourceLoader,
} from "@earendil-works/pi-coding-agent";
import type { Api, Model } from "@earendil-works/pi-ai";
import type { AgentRole } from "../config/agents.ts";
import { createVisionHookExtension } from "./vision-hook.ts";
import { filterVisibleSkills } from "../skills-policy.ts";

export async function createRoleResourceLoader(
  cwd: string,
  role: AgentRole,
  accountExtension?: InlineExtension,
  routeAccountModel?: <TApi extends Api>(model: Model<TApi>) => Model<TApi>,
): Promise<{
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
    extensionFactories: [
      ...(accountExtension ? [accountExtension] : []),
      createVisionHookExtension(
        () => ({ sidecar: role.image, promptFile: role.imagePromptFile }),
        undefined,
        accountExtension,
        routeAccountModel,
      ),
    ],
    skillsOverride: (base) => ({
      skills: filterVisibleSkills(base.skills, cwd).filter((skill) => allowedSkills.has(skill.name)),
      diagnostics: base.diagnostics,
    }),
    systemPromptOverride: () => undefined,
    appendSystemPromptOverride: () => [rolePrompt],
  });
  await loader.reload();
  return { loader, settings };
}
