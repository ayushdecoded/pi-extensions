import type { Theme, ThemeColor } from "@earendil-works/pi-coding-agent";

export type RoleRgb = readonly [number, number, number];

type RoleStyle = {
  themeColor: ThemeColor;
  fallbackRgb: RoleRgb;
};

const DEFAULT_ROLE_STYLE: RoleStyle = {
  themeColor: "text",
  fallbackRgb: [151, 174, 204],
};

/** The single role-color palette used by every subagent UI surface. */
const ROLE_STYLES: Readonly<Record<string, RoleStyle>> = {
  atlas: { themeColor: "mdLink", fallbackRgb: [123, 188, 255] },
  vigil: { themeColor: "thinkingMax", fallbackRgb: [255, 95, 255] },
};

export function roleColor(role: string): ThemeColor {
  return roleStyle(role).themeColor;
}

export function roleRgb(role: string): RoleRgb {
  return roleStyle(role).fallbackRgb;
}

export function roleText(text: string, role: string, theme: Theme): string {
  return theme.fg(roleColor(role), text);
}

/** Removes a leading agent-role list so a workstream caption cannot masquerade as an agent node. */
export function stripLeadingRoleNames(heading: string, roles: readonly string[]): string {
  const names = [...new Set(roles.map((role) => role.trim()).filter(Boolean))]
    .sort((left, right) => right.length - left.length)
    .map((role) => role.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  if (!names.length) return heading;
  const role = `(?:${names.join("|")})`;
  const prefix = new RegExp(`^(?:the\\s+)?${role}(?:(?:\\s*(?:,|&|and|\\+)\\s*)${role})*\\s*(?:subagents?|agents?)?\\s*(?:[:\\-–—]\\s*)?`, "i");
  const stripped = heading.replace(prefix, "").trim();
  return stripped || heading;
}

function roleStyle(role: string): RoleStyle {
  return ROLE_STYLES[role.toLowerCase()] ?? DEFAULT_ROLE_STYLE;
}
