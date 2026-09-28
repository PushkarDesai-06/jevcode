import type { Classification, TaskType } from "./types.js";
import { TASK_TYPES } from "./types.js";

// Offline keyword classifier. Used when there's no Jev key (try-before-you-buy and
// `jev audit --offline`) and in tests. It is deliberately cautious: when unsure it leans
// toward higher complexity, and it reports low confidence so the policy won't downgrade
// aggressively on its word.

const TASK_PATTERNS: [TaskType, RegExp][] = [
  ["chore", /\b(run (the )?tests?|npm (i|install|run)|pnpm|yarn|commit|push|git (status|log|diff|add|stash|checkout|rebase)|format|lint|install|bump|changelog)\b/i],
  ["lookup", /\b(where (is|are|do)|find|which file|locate|grep|search for|list (all|the)|show me)\b/i],
  ["explain", /\b(what (is|does|are)|why (is|does)|how (does|do)|explain|meaning of|difference between)\b/i],
  ["small_edit", /\b(rename|typo|change .{1,40} to|add (a )?(log|comment|docstring)|remove (the )?unused|update (the )?(version|copy|text|string)|tweak)\b/i],
  ["debug", /\b(bug|error|exception|traceback|stack ?trace|fails?|failing|broken|crash|doesn'?t work|not working|fix|leak|regression|root cause|track (it )?down|slow|hangs?)\b/i],
  ["review", /\b(review|audit|look over|check (my|this) (code|diff|pr))\b/i],
  ["refactor", /\b(refactor|restructure|migrate|extract|split .* into|clean ?up|reorganize|move .* to)\b/i],
  ["architecture", /\b(design|architect|architecture|plan|approach|trade-?offs?|strategy|scal(e|ing|ability)|should (we|i) use)\b/i],
  ["feature", /\b(implement|add (a |an )?(new )?(feature|endpoint|page|command|option|flag|support)|build|create|integrate|support for)\b/i],
];

// Stems on purpose ("concurren" matches concurrency/concurrent), so no trailing \b.
const HARD = /\b(race condition|deadlock|concurren|memory leak|leak|performance|latency|p9\d|throughput|bottleneck|regression|profil|optimi[sz]|security|vulnerab|distributed|consensus|cryptograph|compiler|algorithm|architect|migrat|intermittent|flaky|across (the )?(codebase|services|repo))/i;
const RISKY = /\b(auth\w*|oauth|password|secrets?|tokens?|payments?|billing|stripe|prod(uction)?|migrations?|deploy\w*|encrypt\w*|permissions?|credentials?|gdpr|pii)\b/i;
// Irreversible or production-data operations: top tier in every stage.
const SEVERE = /\b(prod(uction)? (database|db|data)|drop table|migrations? (script|that)|backfill|rotate .{0,30}credentials|rm -rf|delete .{0,30}(data|records|users)|deploy(ing)? to prod)/i;
const CONTINUE = /^(ok|okay|yes|yep|no|now|also|and|then|next|great|thanks|perfect|hmm|same|again|that|this|it|do it|go ahead|continue|try)\b/i;

const BASE_COMPLEXITY: Record<TaskType, number> = {
  chore: 0.6,
  lookup: 0.8,
  explain: 1.0,
  small_edit: 0.8,
  review: 2.0,
  debug: 2.2,
  feature: 2.2,
  refactor: 2.6,
  architecture: 3.2,
};

export function classifyHeuristic(prompt: string, hasPrevious = false): Classification {
  const started = Date.now();
  const text = prompt.trim();
  const scores = Object.fromEntries(TASK_TYPES.map((t) => [t, 0.1])) as Record<TaskType, number>;
  for (const [t, re] of TASK_PATTERNS) if (re.test(text)) scores[t] += 1;
  const total = Object.values(scores).reduce((a, b) => a + b, 0);
  const taskType = Object.fromEntries(TASK_TYPES.map((t) => [t, scores[t] / total])) as Record<TaskType, number>;
  // Ties break toward the harder task type, and the base level is the hardest matched
  // interpretation: "find and fix the race condition" is debugging, not a lookup.
  const topRaw = TASK_TYPES.reduce((a, b) =>
    taskType[a] > taskType[b] || (taskType[a] === taskType[b] && BASE_COMPLEXITY[a] >= BASE_COMPLEXITY[b]) ? a : b,
  );
  const matched = TASK_TYPES.filter((t) => scores[t] > 0.1);
  const top: TaskType = matched.length ? topRaw : "feature";

  // No keyword matched: judge by length alone instead of assuming the worst task type.
  let level = matched.length ? Math.max(...matched.map((t) => BASE_COMPLEXITY[t])) : 1.4;
  const words = text.split(/\s+/).length;
  if (words > 120) level += 0.8;
  else if (words > 50) level += 0.4;
  else if (words < 8) level -= 0.3;
  if (HARD.test(text)) level += 1.0;
  if ((text.match(/\n/g) ?? []).length > 15) level += 0.3; // pasted logs or code
  level = Math.min(4, Math.max(0, level));

  const complexity = spread(level, 5);
  const risk = SEVERE.test(text) ? 0.9 : RISKY.test(text) ? 0.7 : 0.05;
  const reasoning = Math.min(0.95, 0.15 + level * 0.2);
  const continuation = hasPrevious && (CONTINUE.test(text) || words < 6) ? 0.8 : hasPrevious ? 0.3 : 0;
  const scopeLevel = top === "refactor" || top === "architecture" ? 2.5 : top === "small_edit" ? 0.5 : level / 1.6;

  // Clear-cut routine asks get moderate confidence; everything else stays below the
  // policy's LOW_CONFIDENCE gate so Stages 1-2 never downgrade on a guess.
  const clearCut =
    ["chore", "lookup", "small_edit"].includes(top) &&
    taskType[top] >= 0.45 &&
    words <= 40 &&
    !HARD.test(text) &&
    risk < 0.5;

  return {
    complexity,
    // Below LOW_CONFIDENCE unless clear-cut, so the heuristic never downgrades on a guess.
    complexityConfidence: clearCut ? 0.65 : 0.35,
    taskType,
    taskTypeConfidence: taskType[top],
    reasoning,
    risk,
    continuation,
    scope: spread(scopeLevel, 4),
    source: "heuristic",
    latencyMs: Date.now() - started,
  };
}

/** Distribute probability mass around a fractional level (triangular kernel). */
function spread(level: number, levels: number): number[] {
  const raw = Array.from({ length: levels }, (_, i) => Math.max(0.02, 1 - Math.abs(i - level) / 1.2));
  const s = raw.reduce((a, b) => a + b, 0);
  return raw.map((x) => x / s);
}
