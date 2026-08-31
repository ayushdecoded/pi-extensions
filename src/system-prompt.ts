import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  formatSkillsForPrompt,
  type BuildSystemPromptOptions,
  type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import { filterVisibleSkills } from "./skills-policy.ts";

const BUNDLED_SYSTEM_PROMPT_FILE = fileURLToPath(new URL("../resources/SYSTEM.md", import.meta.url));
const BUNDLED_SYSTEM_PROMPT = readFileSync(BUNDLED_SYSTEM_PROMPT_FILE, "utf8").trim();

/**
 * Supply the pack's main prompt when Pi has no explicit project/global SYSTEM.md.
 *
 * Pi emits before_agent_start for every submitted agent run and resets to its
 * base prompt when no override is returned. We therefore return the same cached
 * replacement each time; the file is read once and assembly happens once for
 * each immutable base-prompt options object.
 */
export function registerPackSystemPrompt(pi: ExtensionAPI): void {
  const assembled = new WeakMap<BuildSystemPromptOptions, string>();

  pi.on("before_agent_start", (event) => {
    // Preserve Pi's normal explicit override semantics. A project or global
    // SYSTEM.md remains an intentional escape hatch from the pack identity.
    if (event.systemPromptOptions.customPrompt) return;

    let systemPrompt = assembled.get(event.systemPromptOptions);
    if (!systemPrompt) {
      systemPrompt = assemblePackSystemPrompt(BUNDLED_SYSTEM_PROMPT, event.systemPromptOptions);
      assembled.set(event.systemPromptOptions, systemPrompt);
    }
    return { systemPrompt };
  });
}

export function assemblePackSystemPrompt(mainPrompt: string, options: BuildSystemPromptOptions): string {
  let prompt = mainPrompt.trim();

  if (options.appendSystemPrompt) prompt += `\n\n${options.appendSystemPrompt}`;

  if (options.contextFiles?.length) {
    prompt += "\n\n<project_context>\n\nProject-specific instructions and guidelines:\n\n";
    for (const context of options.contextFiles) {
      prompt += `<project_instructions path="${context.path}">\n${context.content}\n</project_instructions>\n\n`;
    }
    prompt += "</project_context>\n";
  }

  const hasRead = !options.selectedTools || options.selectedTools.includes("read");
  const visibleSkills = options.skills ? filterVisibleSkills(options.skills, options.cwd) : [];
  if (hasRead && visibleSkills.length) prompt += formatSkillsForPrompt(visibleSkills);

  prompt += `\nCurrent working directory: ${options.cwd.replace(/\\/g, "/")}`;
  return prompt;
}
