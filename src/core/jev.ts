import type { Classification, TaskType } from "./types.js";
import { TASK_TYPES } from "./types.js";

// Question set sent to Jev System One. All questions are evaluated in parallel in one
// call, so adding one costs only its tokens, not latency.
const TASK_CRITERIA: Record<TaskType, string> = {
  explain: "Explain code or a concept, answer a question; no code changes",
  lookup: "Find where something is in the codebase or read files to report facts",
  small_edit: "A small, well-specified change: rename, typo, tweak a value, add a log line",
  feature: "Implement new functionality spanning some design decisions",
  debug: "Diagnose and fix a bug, failing test, or error",
  refactor: "Restructure existing code across multiple files without changing behavior",
  architecture: "Plan or design a system, compare approaches, make architectural decisions",
  review: "Review code or a diff for bugs, security, or quality",
  chore: "Routine shell/git/tooling task: run tests, commit, install deps, format",
};

export const COMPLEXITY_LEVELS = [
  "Trivial: one obvious step, no judgment needed",
  "Simple: a few straightforward steps in one place",
  "Moderate: several steps with some judgment or context gathering",
  "Complex: many interacting parts, careful reasoning or debugging",
  "Expert: deep, subtle, or high-stakes work needing top-tier reasoning",
];

export const SCOPE_LEVELS = [
  "A single line or value",
  "A single file",
  "A few related files",
  "Cross-cutting across the codebase",
];

export function buildQuestions(): Record<string, unknown> {
  return {
    complexity: {
      type: "score",
      instructions:
        "How hard is the coding-agent task the developer is asking for in `prompt`? Rate the reasoning and engineering difficulty, not the length of the text.",
      criteria: COMPLEXITY_LEVELS,
    },
    task_type: {
      type: "choice",
      instructions: "What kind of task is the developer asking the coding agent to do in `prompt`?",
      criteria: TASK_CRITERIA,
    },
    reasoning_required: {
      type: "noul",
      instructions: "Does completing `prompt` require multi-step reasoning, planning, or debugging?",
      criteria: {
        true: "Needs multi-step reasoning, planning, or hypothesis testing",
        false: "Can be done directly without deliberate reasoning",
      },
    },
    risk: {
      type: "noul",
      instructions:
        "Does `prompt` involve security-sensitive code, auth, payments, production data, database migrations, deployments, or irreversible operations?",
      criteria: {
        true: "High-stakes: mistakes could cause security issues, data loss, or outages",
        false: "Ordinary development work where mistakes are cheap to fix",
      },
    },
    continuation: {
      type: "noul",
      instructions:
        "Is `prompt` a follow-up that continues the task in `previous_assistant_message`, rather than starting a new, unrelated task?",
      criteria: {
        true: "Continues or refines the previous task",
        false: "Starts a new task, or there is no previous task",
      },
    },
    scope: {
      type: "score",
      instructions: "How much of the codebase will `prompt` likely touch?",
      criteria: SCOPE_LEVELS,
    },
  };
}

export interface JevState {
  prompt: string;
  previous_assistant_message?: string;
  project?: string;
}

export interface JevClientOptions {
  apiKey: string;
  apiBase: string;
  model: string;
  timeoutMs: number;
  fetchImpl?: typeof fetch;
}

export class JevError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    readonly retryable = false,
  ) {
    super(message);
  }
}

export async function classifyWithJev(state: JevState, opts: JevClientOptions): Promise<Classification> {
  const doFetch = opts.fetchImpl ?? fetch;
  const started = Date.now();
  const deadline = started + opts.timeoutMs;
  let attempt = 0;
  // One quick retry on 429/529 if the deadline allows; hooks can't wait long.
  for (;;) {
    const remaining = deadline - Date.now();
    if (remaining <= 50) throw new JevError("Jev timed out", undefined, true);
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), remaining);
    let res: Response;
    try {
      res = await doFetch(`${opts.apiBase.replace(/\/$/, "")}/v1/systemone`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${opts.apiKey}`,
          "Content-Type": "application/json",
          // OpenRouter app attribution; ignored by TypeSafe direct.
          "X-Title": "jevcode",
        },
        body: JSON.stringify({ model: opts.model, state, questions: buildQuestions() }),
        signal: ctrl.signal,
        // Never forward the bearer key to wherever a redirect points.
        redirect: "error",
      });
    } catch (err) {
      throw new JevError(`Jev request failed: ${(err as Error).message}`, undefined, true);
    } finally {
      clearTimeout(timer);
    }
    if (res.ok) {
      const body = (await res.json()) as JevResponse;
      return normalizeJevResponse(body, Date.now() - started);
    }
    const retryable = res.status === 429 || res.status === 529 || res.status >= 500;
    if (retryable && attempt === 0 && deadline - Date.now() > 400) {
      attempt++;
      await new Promise((r) => setTimeout(r, 150));
      continue;
    }
    // Surface the provider's reason (e.g. OpenRouter's "User not found" for a bad key).
    let detail = "";
    try {
      const err = (await res.json()) as { error?: { message?: string } | string };
      const msg = typeof err.error === "string" ? err.error : err.error?.message;
      if (msg) detail = `: ${msg.slice(0, 200)}`;
    } catch {
      // Non-JSON error body.
    }
    throw new JevError(`Jev returned HTTP ${res.status}${detail}`, res.status, retryable);
  }
}

interface JevResponse {
  model?: string;
  /** OpenRouter adds the upstream provider name. */
  provider?: string;
  answers?: Record<string, Record<string, unknown>>;
  /** OpenRouter adds `cost` (USD) to usage. */
  usage?: { input_tokens?: number; output_tokens?: number; cost?: number };
}

/**
 * Turn Jev answers into our Classification. Noul answers are documented as
 * `{type: "noul", noul: p}`; Choice/Score answers carry a probability distribution and
 * a `confidence`. We accept the distribution under any of the common field names, as a
 * map or an array, so a minor schema difference degrades to a softer answer instead of an error.
 */
export function normalizeJevResponse(body: JevResponse, latencyMs: number): Classification {
  const a = body.answers ?? {};
  const complexity = readDistribution(a.complexity, COMPLEXITY_LEVELS.length);
  const scope = readDistribution(a.scope, SCOPE_LEVELS.length);
  const taskDist = readChoice(a.task_type, TASK_TYPES as string[]);
  return {
    complexity: complexity.dist,
    complexityConfidence: complexity.confidence,
    taskType: taskDist.dist as Record<TaskType, number>,
    taskTypeConfidence: taskDist.confidence,
    reasoning: readNoul(a.reasoning_required, 0.5),
    risk: readNoul(a.risk, 0),
    continuation: readNoul(a.continuation, 0),
    scope: scope.dist,
    source: "jev",
    latencyMs,
    jevModel: body.model,
    inputTokens: body.usage?.input_tokens,
    costUsd: typeof body.usage?.cost === "number" ? body.usage.cost : undefined,
  };
}

function readNoul(ans: Record<string, unknown> | undefined, fallback: number): number {
  if (!ans) return fallback;
  for (const k of ["noul", "probability", "value", "true"]) {
    const v = ans[k];
    if (typeof v === "number") return clamp01(v);
    if (typeof v === "boolean") return v ? 1 : 0;
  }
  return fallback;
}

const DIST_KEYS = ["probabilities", "distribution", "scores", "score", "choice", "options"];

function findDistField(ans: Record<string, unknown>): unknown {
  for (const k of DIST_KEYS) {
    const v = ans[k];
    if (v && typeof v === "object") return v;
  }
  return undefined;
}

function readDistribution(
  ans: Record<string, unknown> | undefined,
  levels: number,
): { dist: number[]; confidence: number } {
  const uniform = Array(levels).fill(1 / levels) as number[];
  if (!ans) return { dist: uniform, confidence: 0 };
  const confidence = typeof ans.confidence === "number" ? clamp01(ans.confidence) : 0.5;
  const field = findDistField(ans);
  let raw: number[] | undefined;
  if (Array.isArray(field)) {
    raw = field.map((x) => (typeof x === "number" ? x : Number((x as { probability?: number })?.probability ?? 0)));
  } else if (field && typeof field === "object") {
    // Keyed by level index ("0".."n") or by the level text.
    const vals = Object.values(field as Record<string, unknown>).filter((v) => typeof v === "number") as number[];
    if (vals.length === levels) raw = vals;
  } else {
    // Only a point estimate: 0..1 fraction or a level index. Spread it by confidence.
    const point = typeof ans.score === "number" ? ans.score : typeof ans.value === "number" ? ans.value : undefined;
    if (point !== undefined) {
      const idx = point <= 1 && !Number.isInteger(point) ? point * (levels - 1) : point;
      raw = peaked(Math.round(idx), levels, confidence);
    }
  }
  if (!raw || raw.length !== levels) return { dist: uniform, confidence: 0 };
  return { dist: normalize(raw), confidence };
}

function readChoice(
  ans: Record<string, unknown> | undefined,
  options: string[],
): { dist: Record<string, number>; confidence: number } {
  const dist: Record<string, number> = Object.fromEntries(options.map((o) => [o, 1 / options.length]));
  if (!ans) return { dist, confidence: 0 };
  const confidence = typeof ans.confidence === "number" ? clamp01(ans.confidence) : 0.5;
  const field = findDistField(ans);
  if (field && typeof field === "object" && !Array.isArray(field)) {
    const m = field as Record<string, unknown>;
    const total = options.reduce((s, o) => s + (typeof m[o] === "number" ? (m[o] as number) : 0), 0);
    if (total > 0) {
      for (const o of options) dist[o] = (typeof m[o] === "number" ? (m[o] as number) : 0) / total;
      return { dist, confidence };
    }
  }
  // A bare label ("choice": "debug" / "answer": "debug").
  const label = [ans.choice, ans.answer, ans.value].find((v) => typeof v === "string") as string | undefined;
  if (label && options.includes(label)) {
    for (const o of options) dist[o] = o === label ? confidence || 0.7 : (1 - (confidence || 0.7)) / (options.length - 1);
  }
  return { dist, confidence };
}

function peaked(idx: number, levels: number, confidence: number): number[] {
  const c = Math.max(0.4, confidence);
  return Array.from({ length: levels }, (_, i) => (i === idx ? c : (1 - c) / (levels - 1)));
}

function normalize(xs: number[]): number[] {
  const s = xs.reduce((a, b) => a + Math.max(0, b), 0);
  return s > 0 ? xs.map((x) => Math.max(0, x) / s) : xs.map(() => 1 / xs.length);
}

function clamp01(x: number): number {
  return Math.min(1, Math.max(0, x));
}
