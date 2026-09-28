/** Tier 0 = cheapest (Haiku / Luna), 1 = mid (Sonnet / Sol), 2 = top (Opus / Astra). */
export type Tier = 0 | 1 | 2;
export const TIERS: readonly Tier[] = [0, 1, 2];

/** 0 = off (observe only), 1 = Balanced, 2 = Saver, 3 = Max Saver. */
export type Stage = 0 | 1 | 2 | 3;

export type Host = "claude" | "codex";

export type TaskType =
  | "explain"
  | "lookup"
  | "small_edit"
  | "feature"
  | "debug"
  | "refactor"
  | "architecture"
  | "review"
  | "chore";

export const TASK_TYPES: readonly TaskType[] = [
  "explain",
  "lookup",
  "small_edit",
  "feature",
  "debug",
  "refactor",
  "architecture",
  "review",
  "chore",
];

/** Normalized classifier output, independent of whether Jev or the heuristic produced it. */
export interface Classification {
  /** Probability per complexity level: trivial, simple, moderate, complex, expert. Sums to 1. */
  complexity: number[];
  complexityConfidence: number;
  taskType: Record<TaskType, number>;
  taskTypeConfidence: number;
  /** Probability the task needs multi-step reasoning. */
  reasoning: number;
  /** Probability the task touches security, prod data, migrations, or irreversible ops. */
  risk: number;
  /** Probability this prompt continues the previous task rather than starting a new one. */
  continuation: number;
  /** Probability per scope level: line, file, few files, cross-cutting. */
  scope: number[];
  source: "jev" | "heuristic";
  latencyMs: number;
  jevModel?: string;
  inputTokens?: number;
  /** Classification cost in USD, when the provider reports it (OpenRouter does). */
  costUsd?: number;
}

export type RouteAction =
  /** Stay on the main model, no instruction injected. */
  | "stay"
  /** Stay on the main model but ask for a brief answer (Stage 3 Q&A). */
  | "brief"
  /** Hand the work to a cheaper subagent. */
  | "delegate_down"
  /** Hand the work to a stronger subagent. */
  | "escalate";

export interface Decision {
  /** Tier the work runs on (the main tier for "stay" / "brief"). */
  tier: Tier;
  /** Difficulty tier after guardrails, before stage rules map it to an action. */
  assessedTier: Tier;
  mainTier: Tier;
  action: RouteAction;
  stage: Stage;
  /** Probability each tier is sufficient, after calibration. */
  sufficiency: [number, number, number];
  threshold: number;
  taskType: TaskType;
  reasons: string[];
  override?: "deep" | "quick" | "nojev" | "escalate";
}

export interface ModelInfo {
  id: string;
  tier: Tier;
  /** USD per million tokens. */
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}
