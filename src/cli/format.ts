import type { Decision } from "../core/types.js";
import { CLAUDE_ALIASES } from "../core/models.js";
import { STAGE_NAMES } from "../core/policy.js";

const useColor = process.stdout.isTTY && !process.env.NO_COLOR;
const wrap = (code: string) => (s: string) => (useColor ? `\x1b[${code}m${s}\x1b[0m` : s);
export const bold = wrap("1");
export const dim = wrap("2");
export const green = wrap("32");
export const yellow = wrap("33");
export const cyan = wrap("36");

export function usd(n: number): string {
  const sign = n < 0 ? "-" : "";
  const a = Math.abs(n);
  if (a >= 100) return `${sign}$${a.toFixed(0)}`;
  if (a >= 1) return `${sign}$${a.toFixed(2)}`;
  return `${sign}$${a.toFixed(3)}`;
}

export function pct(n: number): string {
  const r = Math.round(n);
  return `${r === 0 ? 0 : r}%`;
}

export function describeDecision(d: Decision): string {
  const lines = [
    `${bold("Action")}      ${d.action}  (tier T${d.tier} ${CLAUDE_ALIASES[d.tier]}, main T${d.mainTier} ${CLAUDE_ALIASES[d.mainTier]})`,
    `${bold("Stage")}       ${d.stage} · ${STAGE_NAMES[d.stage]}`,
    `${bold("Task type")}   ${d.taskType}`,
    `${bold("P(suff.)")}    T0 ${d.sufficiency[0].toFixed(2)} · T1 ${d.sufficiency[1].toFixed(2)} · T2 ${d.sufficiency[2].toFixed(2)}   threshold ${d.threshold.toFixed(2)}`,
  ];
  if (d.override) lines.push(`${bold("Override")}    ${d.override}`);
  lines.push(`${bold("Why")}`);
  for (const r of d.reasons) lines.push(`  • ${r}`);
  return lines.join("\n");
}

export function table(rows: string[][]): string {
  const widths = rows[0]!.map((_, i) => Math.max(...rows.map((r) => stripAnsi(r[i] ?? "").length)));
  return rows
    .map((r) => r.map((cell, i) => cell + " ".repeat(widths[i]! - stripAnsi(cell).length)).join("   "))
    .join("\n");
}

function stripAnsi(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\x1b\[[0-9;]*m/g, "");
}
