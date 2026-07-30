import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  CONFIG_DIR_NAME,
  getAgentDir,
  loadProjectContextFiles,
  type ExtensionContext,
  type Theme,
} from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { AgentsConfig } from "../config/agents.ts";
import { roleRgb, roleText } from "./roles.ts";

const RESET = "\x1b[0m";
const BOLD = "\x1b[1m";
type Rgb = readonly [number, number, number];

const PALETTE: readonly Rgb[] = [
  [22, 83, 189],
  [48, 129, 247],
  [93, 171, 255],
  [151, 205, 255],
  [93, 171, 255],
  [48, 129, 247],
];

const FULL_TITLE_LINES = [
  "██████╗ ██╗     ██████╗ ██████╗ ██████╗ ██╗███╗   ██╗ ██████╗      █████╗  ██████╗ ███████╗███╗   ██╗████████╗",
  "██╔══██╗██║    ██╔════╝██╔═══██╗██╔══██╗██║████╗  ██║██╔════╝     ██╔══██╗██╔════╝ ██╔════╝████╗  ██║╚══██╔══╝",
  "██████╔╝██║    ██║     ██║   ██║██║  ██║██║██╔██╗ ██║██║  ███╗    ███████║██║  ███╗█████╗  ██╔██╗ ██║   ██║",
  "██╔═══╝ ██║    ██║     ██║   ██║██║  ██║██║██║╚██╗██║██║   ██║    ██╔══██║██║   ██║██╔══╝  ██║╚██╗██║   ██║",
  "██║     ██║    ╚██████╗╚██████╔╝██████╔╝██║██║ ╚████║╚██████╔╝    ██║  ██║╚██████╔╝███████╗██║ ╚████║   ██║",
  "╚═╝     ╚═╝     ╚═════╝ ╚═════╝ ╚═════╝ ╚═╝╚═╝  ╚═══╝ ╚═════╝     ╚═╝  ╚═╝ ╚═════╝ ╚══════╝╚═╝  ╚═══╝   ╚═╝",
];

const COMPACT_TITLE_LINES = [
  "██████╗ ██╗",
  "██╔══██╗██║",
  "██████╔╝██║",
  "██╔═══╝ ██║",
  "██║     ██║",
  "╚═╝     ╚═╝",
];

const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const BUNDLED_SYSTEM_PROMPT = join(PACKAGE_ROOT, "resources", "SYSTEM.md");

export type HeaderInfo = {
  version: string;
  agents: Array<{ name: string; model: string; thinking: string }>;
  concurrency: number;
  skills: string[];
  prompts?: string[];
  extensions?: string[];
  themes?: string[];
  configFile: string;
  contextFiles: string[];
};

type DisplaySection = {
  name: string;
  rows: string[];
  meta?: string;
};

export function installHeader(ctx: ExtensionContext, config: AgentsConfig, commands: readonly { name: string; source: string; sourceInfo: { source: string } }[]): void {
  if (ctx.mode !== "tui") return;
  const title = formatDirectory(ctx.cwd);
  const info: HeaderInfo = {
    version: piVersion(),
    agents: [...config.roles]
      .sort((left, right) => roleOrder(left.name) - roleOrder(right.name))
      .map((role) => ({
        name: role.name,
        model: role.model.split("/").at(-1) ?? role.model,
        thinking: role.thinking,
      })),
    concurrency: config.defaults.concurrency,
    // Pi has already resolved skills from every supported source before session_start.
    // Read its effective prompt rather than duplicating its discovery rules here.
    skills: discoverAvailableSkills(ctx.getSystemPrompt()),
    prompts: discoverResourceNames(commands, "prompt"),
    extensions: discoverExtensionNames(commands),
    themes: ctx.ui.getAllThemes().map((theme) => theme.name).sort(),
    configFile: formatResourcePath(config.path, ctx.cwd),
    contextFiles: discoverContextFiles(ctx.cwd, ctx.isProjectTrusted()),
  };

  ctx.ui.setHeader((tui, theme) => {
    queueMicrotask(() => tui.requestRender(true));
    return {
      invalidate() {},
      render(width: number): string[] {
        return renderHeader(title, width, info, theme);
      },
    };
  });
  ctx.ui.setTitle(`pi — ${title}`);
}

export function renderHeader(title: string, width: number, info?: HeaderInfo, theme?: Theme): string[] {
  const titleLines = width >= 114 ? FULL_TITLE_LINES : COMPACT_TITLE_LINES;
  const artWidth = Math.max(...titleLines.map((line) => visibleWidth(line)));
  const artIndent = " ".repeat(Math.max(0, Math.floor((width - artWidth) / 2)));
  const art = titleLines.map((line, row) =>
    truncateToWidth(`${artIndent}${BOLD}${gradientText(line, row * 0.035)}${RESET}`, width),
  );
  const lines = ["", ...art];
  if (width < 114) lines.push(center(foreground([151, 174, 204], "C O D I N G   A G E N T"), width));

  const version = foreground([116, 139, 171], `Pi ${info?.version ?? ""}`.trim());
  const workspace = foreground([151, 174, 204], title);
  lines.push("", center(`${version}   ${foreground([71, 151, 251], "◆")}   ${workspace}`, width), "");
  if (!info) return [...lines, ""];

  const agentRows = info.agents.map((agent) => agentRow(agent, theme));
  const contextRows = info.contextFiles.length
    ? info.contextFiles.map((file, index) => `${foreground([221, 176, 91], String(index + 1).padStart(2, "0"))}  ${foreground([151, 174, 204], file)}`)
    : [foreground([116, 139, 171], "No context files")];
  const commandRows = ["/agents", "/handoff", "/create-skill", "/save-md", "/name"].map(
    (command) => `${foreground([71, 151, 251], "›")}  ${foreground([151, 174, 204], command)}`,
  );
  const skillRows = info.skills.length
    ? info.skills.map((skill) => `${foreground([116, 139, 171], "◇")}  ${foreground([151, 174, 204], skill)}`)
    : [foreground([116, 139, 171], "No loaded skills")];
  const shortcutRows = [
    `${foreground([93, 171, 255], "↑")}  Alt+.  ${foreground([116, 139, 171], "Deeper thinking")}`,
    `${foreground([93, 171, 255], "↓")}  Alt+,  ${foreground([116, 139, 171], "Lighter thinking")}`,
    `${foreground([93, 171, 255], "↻")}  Alt+M  ${foreground([116, 139, 171], "Next model")}`,
  ];

  const agents: DisplaySection = {
    name: "AGENTS",
    rows: agentRows,
    meta: `${info.configFile}  │  ${info.concurrency} concurrent`,
  };
  const context: DisplaySection = { name: "CONTEXT", rows: contextRows };
  const commands: DisplaySection = { name: "COMMANDS", rows: commandRows };
  const skills: DisplaySection = { name: "SKILLS", rows: skillRows };
  const prompts: DisplaySection = { name: "PROMPTS", rows: resourceRows(info.prompts ?? [], "/") };
  const extensions: DisplaySection = { name: "EXTENSIONS", rows: resourceRows(info.extensions ?? []) };
  const themes: DisplaySection = { name: "THEMES", rows: resourceRows(info.themes ?? []) };
  const shortcuts: DisplaySection = { name: "SHORTCUTS", rows: shortcutRows };

  if (width >= 96) {
    lines.push(...pairedSections(agents, context, width), "");
    lines.push(...pairedSections(commands, skills, width), "");
    lines.push(...pairedSections(prompts, extensions, width), "");
    lines.push(...pairedSections(themes, shortcuts, width), "");
  } else {
    for (const section of [agents, context, commands, skills, prompts, extensions, themes, shortcuts]) {
      lines.push(...singleSection(section, width), "");
    }
  }
  return lines;
}

function resourceRows(items: string[], prefix = ""): string[] {
  return items.length
    ? items.map((item) => `${foreground([116, 139, 171], "◇")}  ${foreground([151, 174, 204], `${prefix}${item}`)}`)
    : [foreground([116, 139, 171], "No loaded resources")];
}

function agentRow(agent: HeaderInfo["agents"][number], theme?: Theme): string {
  const color = (text: string) => theme ? roleText(text, agent.name, theme) : foreground(roleRgb(agent.name), text);
  const marker = color("◆");
  const name = color(agent.name.toUpperCase().padEnd(8));
  const model = foreground([151, 174, 204], agent.model.padEnd(17));
  const thinking = foreground([116, 139, 171], agent.thinking);
  return `${marker}  ${name}  ${model}  ${thinking}`;
}

function pairedSections(left: DisplaySection, right: DisplaySection, width: number): string[] {
  const contentWidth = Math.max(1, Math.min(112, width - 4));
  const gap = 8;
  const columnWidth = Math.max(1, Math.floor((contentWidth - gap) / 2));
  const leftLines = sectionLines(left, columnWidth);
  const rightLines = sectionLines(right, columnWidth);
  const count = Math.max(leftLines.length, rightLines.length);
  const indent = " ".repeat(Math.max(0, Math.floor((width - contentWidth) / 2)));
  const lines: string[] = [];
  for (let index = 0; index < count; index++) {
    const leftLine = leftLines[index] ?? "";
    const rightLine = rightLines[index] ?? "";
    lines.push(truncateToWidth(`${indent}${padToWidth(leftLine, columnWidth)}${" ".repeat(gap)}${rightLine}`, width));
  }
  return lines;
}

function singleSection(section: DisplaySection, width: number): string[] {
  const contentWidth = Math.max(1, Math.min(112, width - 4));
  const indent = " ".repeat(Math.max(0, Math.floor((width - contentWidth) / 2)));
  return sectionLines(section, contentWidth).map((line) => truncateToWidth(`${indent}${line}`, width));
}

function sectionLines(section: DisplaySection, width: number): string[] {
  const name = foreground([221, 176, 91], section.name);
  const meta = section.meta ? foreground([92, 111, 139], section.meta) : "";
  const gap = meta ? Math.max(2, width - visibleWidth(name) - visibleWidth(meta)) : 0;
  const heading = truncateToWidth(`${name}${" ".repeat(gap)}${meta}`, width);
  return [
    heading,
    foreground([48, 67, 94], "─".repeat(width)),
    "",
    ...section.rows.map((row) => truncateToWidth(row, width)),
  ];
}

function discoverContextFiles(cwd: string, trusted: boolean): string[] {
  const agentDir = getAgentDir();
  const projectSystem = join(cwd, CONFIG_DIR_NAME, "SYSTEM.md");
  const globalSystem = join(agentDir, "SYSTEM.md");
  const projectAppend = join(cwd, CONFIG_DIR_NAME, "APPEND_SYSTEM.md");
  const globalAppend = join(agentDir, "APPEND_SYSTEM.md");
  const files = [
    trusted && existsSync(projectSystem) ? projectSystem : existsSync(globalSystem) ? globalSystem : BUNDLED_SYSTEM_PROMPT,
    ...(trusted && existsSync(projectAppend)
      ? [projectAppend]
      : existsSync(globalAppend)
        ? [globalAppend]
        : []),
    ...loadProjectContextFiles({ cwd, agentDir }).map((file) => file.path),
  ];
  return [...new Set(files.map((file) => formatResourcePath(file, cwd)))];
}

function discoverResourceNames(
  commands: readonly { name: string; source: string }[],
  source: "prompt" | "skill",
  prefix = "",
): string[] {
  return [...new Set(commands.filter((command) => command.source === source).map((command) => `${prefix}${command.name}`))].sort();
}

function discoverExtensionNames(commands: readonly { name: string; source: string; sourceInfo: { source: string } }[]): string[] {
  return [...new Set(commands.filter((command) => command.source === "extension").map((command) => command.sourceInfo.source))].sort();
}

export function discoverAvailableSkills(systemPrompt: string): string[] {
  const block = systemPrompt.match(/<available_skills>\s*([\s\S]*?)\s*<\/available_skills>/u)?.[1];
  if (!block) return [];

  const names = new Set<string>();
  for (const match of block.matchAll(/<name>([\s\S]*?)<\/name>/gu)) {
    const name = unescapeXml(match[1]!).trim();
    if (name) names.add(name);
  }
  return [...names].sort();
}

function unescapeXml(value: string): string {
  return value
    .replace(/&quot;/gu, '"')
    .replace(/&apos;/gu, "'")
    .replace(/&gt;/gu, ">")
    .replace(/&lt;/gu, "<")
    .replace(/&amp;/gu, "&");
}

function piVersion(): string {
  try {
    const packageFile = join(PACKAGE_ROOT, "node_modules", "@earendil-works", "pi-coding-agent", "package.json");
    return JSON.parse(readFileSync(packageFile, "utf8")).version ?? "unknown";
  } catch {
    return "unknown";
  }
}

function formatResourcePath(file: string, cwd: string): string {
  const absolute = resolve(file);
  if (isInside(absolute, cwd)) return relative(cwd, absolute) || ".";
  if (isInside(absolute, PACKAGE_ROOT)) return `my-pi-setup/${relative(PACKAGE_ROOT, absolute)}`;
  const home = homedir();
  if (isInside(absolute, home)) return `~/${relative(home, absolute)}`;
  return absolute;
}

function isInside(target: string, root: string): boolean {
  const pathFromRoot = relative(resolve(root), target);
  return pathFromRoot === "" || (!pathFromRoot.startsWith("..") && !pathFromRoot.startsWith("/"));
}

function roleOrder(name: string): number {
  const canonical = ["atlas", "vigil"];
  const index = canonical.indexOf(name.toLowerCase());
  return index < 0 ? canonical.length : index;
}

function formatDirectory(cwd: string): string {
  const home = homedir();
  if (cwd === home) return "~";
  return cwd.startsWith(`${home}/`) ? `~/${relative(home, cwd)}` : cwd;
}

function center(text: string, width: number): string {
  const padding = Math.max(0, Math.floor((width - visibleWidth(text)) / 2));
  return truncateToWidth(`${" ".repeat(padding)}${text}`, width);
}

function padToWidth(text: string, width: number): string {
  const clipped = truncateToWidth(text, width);
  return `${clipped}${" ".repeat(Math.max(0, width - visibleWidth(clipped)))}`;
}

function gradientText(text: string, phase: number): string {
  const characters = [...text];
  const span = Math.max(characters.length - 1, 1);
  return characters
    .map((character, index) =>
      character === " " ? character : foreground(sampleGradient(index / span + phase), character),
    )
    .join("");
}

function sampleGradient(position: number): Rgb {
  const wrapped = ((position % 1) + 1) % 1;
  const scaled = wrapped * PALETTE.length;
  const index = Math.floor(scaled);
  const next = (index + 1) % PALETTE.length;
  const amount = scaled - index;
  const start = PALETTE[index]!;
  const end = PALETTE[next]!;
  return [mix(start[0], end[0], amount), mix(start[1], end[1], amount), mix(start[2], end[2], amount)];
}

function mix(start: number, end: number, amount: number): number {
  return Math.round(start + (end - start) * amount);
}

function foreground([red, green, blue]: Rgb, text: string): string {
  return `\x1b[38;2;${red};${green};${blue}m${text}${RESET}`;
}
