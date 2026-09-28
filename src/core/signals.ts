import type { GlobalState } from "./state.js";
import type { Decision, TaskType, Tier } from "./types.js";

type GlobalStateLike = Pick<GlobalState, "calibration">;

export interface InlineOverride {
  prompt: string;
  forced?: { tier: Tier; reason: string; kind: Decision["override"] };
  bypass?: boolean;
}

/** `!deep`, `!quick`, `!nojev` at the start of a prompt force the routing for that prompt. */
export function parseInlineOverride(prompt: string): InlineOverride {
  const m = prompt.match(/^\s*!(deep|quick|nojev)\b\s*/i);
  if (!m) return { prompt };
  const kind = m[1]!.toLowerCase() as "deep" | "quick" | "nojev";
  const rest = prompt.slice(m[0].length);
  if (kind === "nojev") return { prompt: rest, bypass: true };
  return {
    prompt: rest,
    forced: kind === "deep" ? { tier: 2, reason: "!deep override", kind } : { tier: 0, reason: "!quick override", kind },
  };
}

const COMPLAINT =
  /\b(that'?s (wrong|not right|incorrect)|wrong|doesn'?t work|didn'?t work|not working|still (broken|failing|fails|wrong)|you broke|try again|that'?s not what i|no,? (that|this)|incorrect|regress(ed|ion)|made it worse|undo)\b/i;

export function isComplaint(prompt: string): boolean {
  return COMPLAINT.test(prompt.slice(0, 400));
}

export function isRetry(prompt: string, lastPrompt: string | undefined): boolean {
  if (!lastPrompt) return false;
  const norm = (s: string) => s.toLowerCase().replace(/\s+/g, " ").trim();
  return norm(prompt).length > 10 && norm(prompt) === norm(lastPrompt);
}

// Learning rates for per-repo calibration. A failure after a cheap route makes that
// task type noticeably more cautious; each clean cheap route relaxes it slowly.
export const CALIBRATION_STEP_UP = 0.07;
export const CALIBRATION_STEP_DOWN = 0.01;
export const CALIBRATION_MAX = 0.25;
export const CALIBRATION_MIN = -0.1;

export function adjustCalibration(
  g: GlobalStateLike,
  repo: string,
  taskType: TaskType,
  direction: "up" | "down",
): number {
  const repoCal = (g.calibration[repo] ??= {});
  const cur = repoCal[taskType] ?? 0;
  const next =
    direction === "up"
      ? Math.min(CALIBRATION_MAX, cur + CALIBRATION_STEP_UP)
      : Math.max(CALIBRATION_MIN, cur - CALIBRATION_STEP_DOWN);
  repoCal[taskType] = Math.round(next * 1000) / 1000;
  return repoCal[taskType]!;
}

/** True when the previous decision sent work below the main tier (so a complaint implicates routing). */
export function wasCheapRoute(d: Decision | undefined): boolean {
  return Boolean(d && (d.action === "delegate_down" || d.action === "brief"));
}
