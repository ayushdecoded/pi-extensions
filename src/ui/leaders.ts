import type { Theme } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

export function fitWithDotLeader(value: string, width: number, theme: Theme): string {
  const safeWidth = Math.max(0, width);
  const clipped = truncateToWidth(value, safeWidth);
  const contentWidth = visibleWidth(clipped);
  const remaining = Math.max(0, safeWidth - contentWidth);
  const separation = contentWidth > 0 && remaining >= 4 ? "  " : "";
  const leaderWidth = remaining - separation.length;
  if (leaderWidth < 4) return clipped + " ".repeat(remaining);
  return clipped + separation + dotLeader(leaderWidth, theme);
}

export function joinWithDotLeader(left: string, right: string, width: number, theme: Theme): string {
  const safeWidth = Math.max(0, width);
  if (!right) return truncateToWidth(left, safeWidth, "");
  const gap = safeWidth - visibleWidth(left) - visibleWidth(right);
  if (gap < 8) {
    return gap >= 2 ? `${left}${" ".repeat(gap)}${right}` : truncateToWidth(left, safeWidth, "");
  }
  return `${left}  ${dotLeader(gap - 4, theme)}  ${right}`;
}

function dotLeader(width: number, theme: Theme): string {
  const leader = Array.from({ length: Math.max(0, width) }, (_, index) => index % 3 === 0 ? "·" : " ").join("");
  return theme.fg("dim", leader);
}
