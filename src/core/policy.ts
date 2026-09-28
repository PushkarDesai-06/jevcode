import type { Classification, Decision, RouteAction, Stage, TaskType, Tier } from "./types.js";
import { TASK_TYPES } from "./types.js";

export interface StagePreset {
  name: string;
  /** Minimum P(tier is sufficient) required to pick a tier. Lower = more aggressive. */
  threshold: number;
  /** Tiers we may delegate *down* to. Stage 1 only hands off trivial work. */
  delegateTiers: Tier[];
  /** Minimum tier for risky prompts. */
  riskFloor: Tier;
  /** Minimum tier for architecture / planning prompts. */
  architectureFloor: Tier;
  /** How far below the main tier we may go when the classifier is unsure. */
  lowConfidenceDrop: 0 | 1;
  /** Continuation probability above which we keep the task on its current tier. */
  stickyAt: number;
  /** Ask the main model for brief answers on simple Q&A instead of delegating. */
  brevity: boolean;
  /** Default main-session tier when we can't detect it. */
  defaultMainTier: Tier;
}

export const STAGES: Record<Exclude<Stage, 0>, StagePreset> = {
  1: {
    name: "Balanced",
    threshold: 0.9,
    delegateTiers: [0],
    riskFloor: 2,
    architectureFloor: 2,
    lowConfidenceDrop: 0,
    stickyAt: 0.6,
    brevity: false,
    defaultMainTier: 2,
  },
  2: {
    name: "Saver",
    threshold: 0.75,
    delegateTiers: [0, 1],
    riskFloor: 2,
    architectureFloor: 2,
    lowConfidenceDrop: 0,
    stickyAt: 0.7,
    brevity: false,
    defaultMainTier: 2,
  },
  3: {
    name: "Max Saver",
    threshold: 0.55,
    delegateTiers: [0, 1],
    riskFloor: 1,
    architectureFloor: 1,
    lowConfidenceDrop: 1,
    stickyAt: 0.85,
    brevity: true,
    // Inverted strategy: run the main session on the mid tier, escalate the hard stuff.
    defaultMainTier: 1,
  },
};

/**
 * Below this score confidence the classifier is genuinely unsure, so don't trust it to
 * downgrade. Kept low because P(sufficient) already integrates spread across levels:
 * Jev splitting "trivial" vs "simple" (confidence ~0.5) is still a confident T0.
 */
export const LOW_CONFIDENCE = 0.4;

/** Threshold reduction for fully read-only work. */
export const READ_ONLY_DISCOUNT = 0.1;

/** Risk above which even Max Saver keeps the top tier: prod data, migrations, destructive ops. */
export const SEVERE_RISK = 0.8;

export const STAGE_NAMES: Record<Stage, string> = {
  0: "Off (observe only)",
  1: STAGES[1].name,
  2: STAGES[2].name,
  3: STAGES[3].name,
};

/**
 * How reliably each tier handles each complexity level (trivial, simple, moderate,
 * complex, expert), and how much a need for multi-step reasoning or cross-cutting scope
 * erodes that. These are the calibration knobs the eval harness tunes; see evals/README.md.
 */
export const TIER_CAPABILITY: Record<Tier, { levelWeights: number[]; reasoningPenalty: number; crossCuttingPenalty: number }> = {
  0: { levelWeights: [1, 0.85, 0.25, 0, 0], reasoningPenalty: 0.2, crossCuttingPenalty: 0.5 },
  1: { levelWeights: [1, 1, 0.95, 0.6, 0.1], reasoningPenalty: 0.1, crossCuttingPenalty: 0.1 },
  2: { levelWeights: [1, 1, 1, 1, 1], reasoningPenalty: 0, crossCuttingPenalty: 0 },
};

/** Probability the task only reads (lookups, Q&A, routine chores): mistakes there are cheap. */
export function readOnlyShare(c: Classification): number {
  return c.taskType.lookup + c.taskType.explain + c.taskType.chore;
}

export function sufficiency(c: Classification): [number, number, number] {
  const out = [0, 0, 0] as [number, number, number];
  for (const t of [0, 1, 2] as Tier[]) {
    const cap = TIER_CAPABILITY[t];
    const mass = c.complexity.reduce((sum, p, level) => sum + p * (cap.levelWeights[level] ?? 0), 0);
    // Wide scope only hurts when the task edits code; "run the tests" touches everything
    // but changes nothing.
    const crossCutting = (c.scope[c.scope.length - 1] ?? 0) * (1 - readOnlyShare(c));
    out[t] = clamp01(mass * (1 - cap.reasoningPenalty * c.reasoning) * (1 - cap.crossCuttingPenalty * crossCutting));
  }
  return out;
}

export function topTaskType(c: Classification): TaskType {
  return TASK_TYPES.reduce((a, b) => (c.taskType[a] >= c.taskType[b] ? a : b));
}

export interface PolicyInput {
  stage: Stage;
  mainTier?: Tier;
  classification?: Classification;
  /** Error text when classification failed (fail-open). */
  classifyError?: string;
  /** Tier the current task is already running on, for stickiness. */
  taskTier?: Tier;
  /** Threshold offset learned for this repo + task type. */
  calibrationOffset?: number;
  /** Forced tier from an inline override or `jev escalate`. */
  forcedTier?: { tier: Tier; reason: string; kind: Decision["override"] };
  /** Skip routing entirely for this prompt (`!nojev`). */
  bypass?: boolean;
}

export function decide(input: PolicyInput): Decision {
  const stage = input.stage;
  const preset = stage === 0 ? STAGES[2] : STAGES[stage];
  const mainTier = input.mainTier ?? preset.defaultMainTier;
  const reasons: string[] = [];
  const c = input.classification;
  const taskType = c ? topTaskType(c) : "feature";
  const suff = c ? sufficiency(c) : ([0, 0, 1] as [number, number, number]);
  // Cost of error: a wrong lookup or answer is cheap to recover from, a wrong edit isn't.
  const readOnlyDiscount = c ? READ_ONLY_DISCOUNT * readOnlyShare(c) : 0;
  const threshold = clamp(preset.threshold + (input.calibrationOffset ?? 0) - readOnlyDiscount, 0.4, 0.97);

  const base = { mainTier, stage, sufficiency: suff, threshold, taskType };

  if (input.bypass) {
    return { ...base, tier: mainTier, assessedTier: mainTier, action: "stay", reasons: ["!nojev: routing skipped"], override: "nojev" };
  }

  if (input.forcedTier) {
    const tier = input.forcedTier.tier;
    return {
      ...base,
      tier,
      assessedTier: tier,
      action: actionFor(tier, mainTier),
      reasons: [input.forcedTier.reason],
      override: input.forcedTier.kind,
    };
  }

  if (!c) {
    return {
      ...base,
      tier: mainTier,
      assessedTier: mainTier,
      action: "stay",
      reasons: [`fail-open: ${input.classifyError ?? "no classification"}; kept main model`],
    };
  }

  // 1. Cheapest tier that clears the threshold.
  let tier: Tier = 2;
  for (const t of [0, 1, 2] as Tier[]) {
    if (suff[t] >= threshold) {
      tier = t;
      break;
    }
  }
  reasons.push(`cheapest tier with P(sufficient) ≥ ${threshold.toFixed(2)} is T${tier} (${suff.map((p) => p.toFixed(2)).join(" / ")})`);
  if (input.calibrationOffset) {
    reasons.push(`repo calibration for ${taskType}: ${input.calibrationOffset > 0 ? "+" : ""}${input.calibrationOffset.toFixed(2)}`);
  }

  // 2. Guardrails, each can only raise the tier.
  const raise = (floor: Tier, why: string) => {
    if (tier < floor) {
      tier = floor;
      reasons.push(why);
    }
  };
  if (c.risk >= SEVERE_RISK) raise(2, `high-stakes (risk ${c.risk.toFixed(2)}) → top tier in every stage`);
  else if (c.risk >= 0.5) raise(preset.riskFloor, `risk ${c.risk.toFixed(2)} ≥ 0.5 → floor T${preset.riskFloor}`);
  if (c.taskType.architecture >= 0.45) raise(preset.architectureFloor, `architecture/planning → floor T${preset.architectureFloor}`);
  if (c.complexityConfidence < LOW_CONFIDENCE) {
    const floor = Math.max(0, mainTier - preset.lowConfidenceDrop) as Tier;
    raise(floor, `classifier confidence ${c.complexityConfidence.toFixed(2)} < ${LOW_CONFIDENCE} → floor T${floor}`);
  }
  if (input.taskTier !== undefined && c.continuation >= preset.stickyAt) {
    // Don't downgrade in the middle of a task: the cheaper model would start cold
    // without the reasoning so far, and re-reading context erases the saving.
    raise(input.taskTier, `continuing current task (p=${c.continuation.toFixed(2)}) → stay on T${input.taskTier}`);
  }

  const assessedTier = tier;

  // 3. Only delegate down to tiers this stage allows.
  if (tier < mainTier && !preset.delegateTiers.includes(tier)) {
    reasons.push(`stage ${stage} doesn't delegate to T${tier} → stay on main`);
    tier = mainTier;
  }

  let action = actionFor(tier, mainTier);

  // 4. For plain Q&A, a subagent hop costs more than it saves: answer on main, briefly.
  const qa = c.taskType.explain + c.taskType.lookup * 0.3 >= 0.5 && c.reasoning < 0.5;
  if (action === "delegate_down" && c.taskType.explain >= 0.5 && c.reasoning < 0.5) {
    action = preset.brevity || stage >= 2 ? "brief" : "stay";
    tier = mainTier;
    reasons.push("simple Q&A: answering on main is cheaper than a subagent hop");
  } else if (action === "stay" && preset.brevity && qa) {
    action = "brief";
    reasons.push("Max Saver: brief answer for simple Q&A");
  }

  if (stage === 0) {
    reasons.push(`observe-only: would have chosen ${action} T${tier}`);
    return { ...base, tier: mainTier, assessedTier, action: "stay", reasons };
  }

  return { ...base, tier, assessedTier, action, reasons };
}

function actionFor(tier: Tier, mainTier: Tier): RouteAction {
  if (tier < mainTier) return "delegate_down";
  if (tier > mainTier) return "escalate";
  return "stay";
}

function clamp01(x: number): number {
  return Math.min(1, Math.max(0, x));
}

function clamp(x: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, x));
}
