#!/usr/bin/env node

// src/cli/index.ts
import fs8 from "node:fs";
import path6 from "node:path";
import { fileURLToPath } from "node:url";

// src/core/types.ts
var TASK_TYPES = [
  "explain",
  "lookup",
  "small_edit",
  "feature",
  "debug",
  "refactor",
  "architecture",
  "review",
  "chore"
];

// src/core/heuristic.ts
var TASK_PATTERNS = [
  ["chore", /\b(run (the )?tests?|npm (i|install|run)|pnpm|yarn|commit|push|git (status|log|diff|add|stash|checkout|rebase)|format|lint|install|bump|changelog)\b/i],
  ["lookup", /\b(where (is|are|do)|find|which file|locate|grep|search for|list (all|the)|show me)\b/i],
  ["explain", /\b(what (is|does|are)|why (is|does)|how (does|do)|explain|meaning of|difference between)\b/i],
  ["small_edit", /\b(rename|typo|change .{1,40} to|add (a )?(log|comment|docstring)|remove (the )?unused|update (the )?(version|copy|text|string)|tweak)\b/i],
  ["debug", /\b(bug|error|exception|traceback|stack ?trace|fails?|failing|broken|crash|doesn'?t work|not working|fix|leak|regression|root cause|track (it )?down|slow|hangs?)\b/i],
  ["review", /\b(review|audit|look over|check (my|this) (code|diff|pr))\b/i],
  ["refactor", /\b(refactor|restructure|migrate|extract|split .* into|clean ?up|reorganize|move .* to)\b/i],
  ["architecture", /\b(design|architect|architecture|plan|approach|trade-?offs?|strategy|scal(e|ing|ability)|should (we|i) use)\b/i],
  ["feature", /\b(implement|add (a |an )?(new )?(feature|endpoint|page|command|option|flag|support)|build|create|integrate|support for)\b/i]
];
var HARD = /\b(race condition|deadlock|concurren|memory leak|leak|performance|latency|p9\d|throughput|bottleneck|regression|profil|optimi[sz]|security|vulnerab|distributed|consensus|cryptograph|compiler|algorithm|architect|migrat|intermittent|flaky|across (the )?(codebase|services|repo))/i;
var RISKY = /\b(auth\w*|oauth|password|secrets?|tokens?|payments?|billing|stripe|prod(uction)?|migrations?|deploy\w*|encrypt\w*|permissions?|credentials?|gdpr|pii)\b/i;
var SEVERE = /\b(prod(uction)? (database|db|data)|drop table|migrations? (script|that)|backfill|rotate .{0,30}credentials|rm -rf|delete .{0,30}(data|records|users)|deploy(ing)? to prod)/i;
var CONTINUE = /^(ok|okay|yes|yep|no|now|also|and|then|next|great|thanks|perfect|hmm|same|again|that|this|it|do it|go ahead|continue|try)\b/i;
var BASE_COMPLEXITY = {
  chore: 0.6,
  lookup: 0.8,
  explain: 1,
  small_edit: 0.8,
  review: 2,
  debug: 2.2,
  feature: 2.2,
  refactor: 2.6,
  architecture: 3.2
};
function classifyHeuristic(prompt, hasPrevious = false) {
  const started = Date.now();
  const text = prompt.trim();
  const scores = Object.fromEntries(TASK_TYPES.map((t) => [t, 0.1]));
  for (const [t, re] of TASK_PATTERNS) if (re.test(text)) scores[t] += 1;
  const total = Object.values(scores).reduce((a, b) => a + b, 0);
  const taskType = Object.fromEntries(TASK_TYPES.map((t) => [t, scores[t] / total]));
  const topRaw = TASK_TYPES.reduce(
    (a, b) => taskType[a] > taskType[b] || taskType[a] === taskType[b] && BASE_COMPLEXITY[a] >= BASE_COMPLEXITY[b] ? a : b
  );
  const matched = TASK_TYPES.filter((t) => scores[t] > 0.1);
  const top = matched.length ? topRaw : "feature";
  let level = matched.length ? Math.max(...matched.map((t) => BASE_COMPLEXITY[t])) : 1.4;
  const words = text.split(/\s+/).length;
  if (words > 120) level += 0.8;
  else if (words > 50) level += 0.4;
  else if (words < 8) level -= 0.3;
  if (HARD.test(text)) level += 1;
  if ((text.match(/\n/g) ?? []).length > 15) level += 0.3;
  level = Math.min(4, Math.max(0, level));
  const complexity = spread(level, 5);
  const risk = SEVERE.test(text) ? 0.9 : RISKY.test(text) ? 0.7 : 0.05;
  const reasoning = Math.min(0.95, 0.15 + level * 0.2);
  const continuation = hasPrevious && (CONTINUE.test(text) || words < 6) ? 0.8 : hasPrevious ? 0.3 : 0;
  const scopeLevel = top === "refactor" || top === "architecture" ? 2.5 : top === "small_edit" ? 0.5 : level / 1.6;
  const clearCut = ["chore", "lookup", "small_edit"].includes(top) && taskType[top] >= 0.45 && words <= 40 && !HARD.test(text) && risk < 0.5;
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
    latencyMs: Date.now() - started
  };
}
function spread(level, levels) {
  const raw = Array.from({ length: levels }, (_, i) => Math.max(0.02, 1 - Math.abs(i - level) / 1.2));
  const s = raw.reduce((a, b) => a + b, 0);
  return raw.map((x) => x / s);
}

// src/core/jev.ts
var TASK_CRITERIA = {
  explain: "Explain code or a concept, answer a question; no code changes",
  lookup: "Find where something is in the codebase or read files to report facts",
  small_edit: "A small, well-specified change: rename, typo, tweak a value, add a log line",
  feature: "Implement new functionality spanning some design decisions",
  debug: "Diagnose and fix a bug, failing test, or error",
  refactor: "Restructure existing code across multiple files without changing behavior",
  architecture: "Plan or design a system, compare approaches, make architectural decisions",
  review: "Review code or a diff for bugs, security, or quality",
  chore: "Routine shell/git/tooling task: run tests, commit, install deps, format"
};
var COMPLEXITY_LEVELS = [
  "Trivial: one obvious step, no judgment needed",
  "Simple: a few straightforward steps in one place",
  "Moderate: several steps with some judgment or context gathering",
  "Complex: many interacting parts, careful reasoning or debugging",
  "Expert: deep, subtle, or high-stakes work needing top-tier reasoning"
];
var SCOPE_LEVELS = [
  "A single line or value",
  "A single file",
  "A few related files",
  "Cross-cutting across the codebase"
];
function buildQuestions() {
  return {
    complexity: {
      type: "score",
      instructions: "How hard is the coding-agent task the developer is asking for in `prompt`? Rate the reasoning and engineering difficulty, not the length of the text.",
      criteria: COMPLEXITY_LEVELS
    },
    task_type: {
      type: "choice",
      instructions: "What kind of task is the developer asking the coding agent to do in `prompt`?",
      criteria: TASK_CRITERIA
    },
    reasoning_required: {
      type: "noul",
      instructions: "Does completing `prompt` require multi-step reasoning, planning, or debugging?",
      criteria: {
        true: "Needs multi-step reasoning, planning, or hypothesis testing",
        false: "Can be done directly without deliberate reasoning"
      }
    },
    risk: {
      type: "noul",
      instructions: "Does `prompt` involve security-sensitive code, auth, payments, production data, database migrations, deployments, or irreversible operations?",
      criteria: {
        true: "High-stakes: mistakes could cause security issues, data loss, or outages",
        false: "Ordinary development work where mistakes are cheap to fix"
      }
    },
    continuation: {
      type: "noul",
      instructions: "Is `prompt` a follow-up that continues the task in `previous_assistant_message`, rather than starting a new, unrelated task?",
      criteria: {
        true: "Continues or refines the previous task",
        false: "Starts a new task, or there is no previous task"
      }
    },
    scope: {
      type: "score",
      instructions: "How much of the codebase will `prompt` likely touch?",
      criteria: SCOPE_LEVELS
    }
  };
}
var JevError = class extends Error {
  constructor(message, status, retryable = false) {
    super(message);
    this.status = status;
    this.retryable = retryable;
  }
};
async function classifyWithJev(state, opts) {
  const doFetch = opts.fetchImpl ?? fetch;
  const started = Date.now();
  const deadline = started + opts.timeoutMs;
  let attempt = 0;
  for (; ; ) {
    const remaining = deadline - Date.now();
    if (remaining <= 50) throw new JevError("Jev timed out", void 0, true);
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), remaining);
    let res;
    try {
      res = await doFetch(`${opts.apiBase.replace(/\/$/, "")}/v1/systemone`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${opts.apiKey}`,
          "Content-Type": "application/json",
          // OpenRouter app attribution; ignored by TypeSafe direct.
          "X-Title": "jevcode"
        },
        body: JSON.stringify({ model: opts.model, state, questions: buildQuestions() }),
        signal: ctrl.signal,
        // Never forward the bearer key to wherever a redirect points.
        redirect: "error"
      });
    } catch (err) {
      throw new JevError(`Jev request failed: ${err.message}`, void 0, true);
    } finally {
      clearTimeout(timer);
    }
    if (res.ok) {
      const body = await res.json();
      return normalizeJevResponse(body, Date.now() - started);
    }
    const retryable = res.status === 429 || res.status === 529 || res.status >= 500;
    if (retryable && attempt === 0 && deadline - Date.now() > 400) {
      attempt++;
      await new Promise((r) => setTimeout(r, 150));
      continue;
    }
    let detail = "";
    try {
      const err = await res.json();
      const msg = typeof err.error === "string" ? err.error : err.error?.message;
      if (msg) detail = `: ${msg.slice(0, 200)}`;
    } catch {
    }
    throw new JevError(`Jev returned HTTP ${res.status}${detail}`, res.status, retryable);
  }
}
function normalizeJevResponse(body, latencyMs) {
  const a = body.answers ?? {};
  const complexity = readDistribution(a.complexity, COMPLEXITY_LEVELS.length);
  const scope = readDistribution(a.scope, SCOPE_LEVELS.length);
  const taskDist = readChoice(a.task_type, TASK_TYPES);
  return {
    complexity: complexity.dist,
    complexityConfidence: complexity.confidence,
    taskType: taskDist.dist,
    taskTypeConfidence: taskDist.confidence,
    reasoning: readNoul(a.reasoning_required, 0.5),
    risk: readNoul(a.risk, 0),
    continuation: readNoul(a.continuation, 0),
    scope: scope.dist,
    source: "jev",
    latencyMs,
    jevModel: body.model,
    inputTokens: body.usage?.input_tokens,
    costUsd: typeof body.usage?.cost === "number" ? body.usage.cost : void 0
  };
}
function readNoul(ans, fallback) {
  if (!ans) return fallback;
  for (const k of ["noul", "probability", "value", "true"]) {
    const v = ans[k];
    if (typeof v === "number") return clamp01(v);
    if (typeof v === "boolean") return v ? 1 : 0;
  }
  return fallback;
}
var DIST_KEYS = ["probabilities", "distribution", "scores", "score", "choice", "options"];
function findDistField(ans) {
  for (const k of DIST_KEYS) {
    const v = ans[k];
    if (v && typeof v === "object") return v;
  }
  return void 0;
}
function readDistribution(ans, levels) {
  const uniform = Array(levels).fill(1 / levels);
  if (!ans) return { dist: uniform, confidence: 0 };
  const confidence = typeof ans.confidence === "number" ? clamp01(ans.confidence) : 0.5;
  const field = findDistField(ans);
  let raw;
  if (Array.isArray(field)) {
    raw = field.map((x) => typeof x === "number" ? x : Number(x?.probability ?? 0));
  } else if (field && typeof field === "object") {
    const vals = Object.values(field).filter((v) => typeof v === "number");
    if (vals.length === levels) raw = vals;
  } else {
    const point = typeof ans.score === "number" ? ans.score : typeof ans.value === "number" ? ans.value : void 0;
    if (point !== void 0) {
      const idx = point <= 1 && !Number.isInteger(point) ? point * (levels - 1) : point;
      raw = peaked(Math.round(idx), levels, confidence);
    }
  }
  if (!raw || raw.length !== levels) return { dist: uniform, confidence: 0 };
  return { dist: normalize(raw), confidence };
}
function readChoice(ans, options) {
  const dist = Object.fromEntries(options.map((o) => [o, 1 / options.length]));
  if (!ans) return { dist, confidence: 0 };
  const confidence = typeof ans.confidence === "number" ? clamp01(ans.confidence) : 0.5;
  const field = findDistField(ans);
  if (field && typeof field === "object" && !Array.isArray(field)) {
    const m = field;
    const total = options.reduce((s, o) => s + (typeof m[o] === "number" ? m[o] : 0), 0);
    if (total > 0) {
      for (const o of options) dist[o] = (typeof m[o] === "number" ? m[o] : 0) / total;
      return { dist, confidence };
    }
  }
  const label = [ans.choice, ans.answer, ans.value].find((v) => typeof v === "string");
  if (label && options.includes(label)) {
    for (const o of options) dist[o] = o === label ? confidence || 0.7 : (1 - (confidence || 0.7)) / (options.length - 1);
  }
  return { dist, confidence };
}
function peaked(idx, levels, confidence) {
  const c = Math.max(0.4, confidence);
  return Array.from({ length: levels }, (_, i) => i === idx ? c : (1 - c) / (levels - 1));
}
function normalize(xs) {
  const s = xs.reduce((a, b) => a + Math.max(0, b), 0);
  return s > 0 ? xs.map((x) => Math.max(0, x) / s) : xs.map(() => 1 / xs.length);
}
function clamp01(x) {
  return Math.min(1, Math.max(0, x));
}

// src/core/redact.ts
var PATTERNS = [
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, "[REDACTED_PRIVATE_KEY]"],
  [/\bsk-ant-[A-Za-z0-9_-]{20,}/g, "[REDACTED_ANTHROPIC_KEY]"],
  [/\bsk-(?:proj-|svcacct-)?[A-Za-z0-9_-]{20,}/g, "[REDACTED_OPENAI_KEY]"],
  [/\b(?:ghp|gho|ghu|ghs|ghr|github_pat)_[A-Za-z0-9_]{20,}/g, "[REDACTED_GITHUB_TOKEN]"],
  [/\bxox[abprs]-[A-Za-z0-9-]{10,}/g, "[REDACTED_SLACK_TOKEN]"],
  [/\bAKIA[0-9A-Z]{16}\b/g, "[REDACTED_AWS_KEY]"],
  [/\bAIza[0-9A-Za-z_-]{35}\b/g, "[REDACTED_GOOGLE_KEY]"],
  [/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g, "[REDACTED_JWT]"],
  [/\b[a-z][a-z0-9+.-]*:\/\/[^\s:/@]+:[^\s@/]+@/gi, "[REDACTED_URL_CREDENTIALS]@"],
  [
    /\b((?:api[_-]?key|secret|token|password|passwd|pwd|auth)[A-Za-z0-9_]*\s*[:=]\s*)(["']?)[^\s"']{6,}\2/gi,
    "$1[REDACTED]"
  ]
];
function redact(text) {
  let out = text;
  for (const [re, repl] of PATTERNS) out = out.replace(re, repl);
  return out;
}
function clip(text, max) {
  if (text.length <= max) return text;
  const head = Math.floor(max * 0.6);
  const tail = Math.max(0, max - head - 20);
  return `${text.slice(0, head)}
\u2026[${text.length - head - tail} chars]\u2026
${text.slice(text.length - tail)}`;
}

// src/core/state.ts
import fs2 from "node:fs";
import path2 from "node:path";

// src/core/config.ts
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
var JEV_PROVIDERS = {
  openrouter: {
    base: "https://openrouter.ai/api",
    model: "typesafe/jev-1.13",
    keyEnv: ["OPENROUTER_API_KEY", "CLAUDE_PLUGIN_OPTION_OPENROUTER_API_KEY"]
  },
  typesafe: {
    base: "https://api.typesafe.ai",
    model: "jev-1.13",
    keyEnv: ["TYPESAFE_API_KEY", "CLAUDE_PLUGIN_OPTION_TYPESAFE_API_KEY"]
  }
};
var DEFAULT_CONFIG = {
  stage: 2,
  classifier: "jev",
  jevProvider: "openrouter",
  jevApiBase: JEV_PROVIDERS.openrouter.base,
  jevModel: JEV_PROVIDERS.openrouter.model,
  jevTimeoutMs: 1500,
  mainTier: {},
  tierModels: {},
  includeContext: true,
  notify: true,
  codexRoles: false
};
function jevHome() {
  return process.env.JEVCODE_HOME ?? path.join(os.homedir(), ".jevcode");
}
function configPath() {
  return path.join(jevHome(), "config.json");
}
function loadConfig() {
  let fileCfg = {};
  try {
    fileCfg = JSON.parse(fs.readFileSync(configPath(), "utf8"));
  } catch {
  }
  const cfg = { ...DEFAULT_CONFIG, ...fileCfg };
  const envKey = (p) => JEV_PROVIDERS[p].keyEnv.map((k) => process.env[k]).find(Boolean);
  const explicit = process.env.JEVCODE_JEV_PROVIDER ?? fileCfg.jevProvider;
  cfg.jevProvider = explicit && explicit in JEV_PROVIDERS ? explicit : !envKey("openrouter") && !fileCfg.jevApiKey && envKey("typesafe") ? "typesafe" : "openrouter";
  const provider = JEV_PROVIDERS[cfg.jevProvider];
  cfg.jevApiBase = process.env.JEVCODE_JEV_API_BASE ?? fileCfg.jevApiBase ?? provider.base;
  cfg.jevModel = process.env.JEVCODE_JEV_MODEL ?? fileCfg.jevModel ?? provider.model;
  cfg.jevApiKey = envKey(cfg.jevProvider) ?? cfg.jevApiKey;
  const envStage = process.env.JEVCODE_STAGE;
  if (envStage && /^[0-3]$/.test(envStage)) cfg.stage = Number(envStage);
  if (!cfg.jevApiKey && cfg.classifier === "jev") cfg.classifier = "heuristic";
  return cfg;
}
function saveConfig(patch) {
  let current = {};
  try {
    current = JSON.parse(fs.readFileSync(configPath(), "utf8"));
  } catch {
  }
  const next = { ...current, ...patch };
  writeJsonAtomic(configPath(), next, 384);
  return { ...DEFAULT_CONFIG, ...next };
}
function writeJsonAtomic(file, data, mode = 420) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + "\n", { mode });
  fs.renameSync(tmp, file);
}
function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
}

// src/core/state.ts
var sessionsDir = () => path2.join(jevHome(), "sessions");
var globalFile = () => path2.join(jevHome(), "state.json");
function safeId(id) {
  return id.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 128) || "default";
}
function loadSession(sessionId) {
  return readJson(path2.join(sessionsDir(), `${safeId(sessionId)}.json`), {
    sessionId,
    updatedAt: 0
  });
}
function saveSession(state) {
  state.updatedAt = Date.now();
  writeJsonAtomic(path2.join(sessionsDir(), `${safeId(state.sessionId)}.json`), state);
}
function loadGlobal() {
  return readJson(globalFile(), { calibration: {} });
}
function saveGlobal(state) {
  writeJsonAtomic(globalFile(), state);
}
function updateGlobal(fn) {
  const s = loadGlobal();
  fn(s);
  saveGlobal(s);
  return s;
}
function latestSession() {
  let best;
  let entries = [];
  try {
    entries = fs2.readdirSync(sessionsDir());
  } catch {
    return void 0;
  }
  for (const f of entries) {
    if (!f.endsWith(".json")) continue;
    const s = readJson(path2.join(sessionsDir(), f), null);
    if (s && (!best || s.updatedAt > best.updatedAt)) best = s;
  }
  return best;
}

// src/core/classify.ts
var BREAKER_COOLDOWN_MS = 3e4;
async function classify(input, cfg, fetchImpl) {
  const hasPrevious = Boolean(input.previousAssistant);
  if (cfg.classifier === "heuristic" || !cfg.jevApiKey) {
    return { classification: classifyHeuristic(input.prompt, hasPrevious) };
  }
  const g = loadGlobal();
  if (g.jevOpenUntil && g.jevOpenUntil > Date.now()) {
    return { error: "Jev circuit breaker open (recent failures)" };
  }
  try {
    const classification = await classifyWithJev(
      {
        prompt: clip(redact(input.prompt), 6e3),
        ...cfg.includeContext && input.previousAssistant ? { previous_assistant_message: clip(redact(input.previousAssistant), 1500) } : {},
        ...input.project ? { project: input.project } : {}
      },
      {
        apiKey: cfg.jevApiKey,
        apiBase: cfg.jevApiBase,
        model: cfg.jevModel,
        timeoutMs: cfg.jevTimeoutMs,
        fetchImpl
      }
    );
    if (g.jevOpenUntil) updateGlobal((s) => delete s.jevOpenUntil);
    return { classification };
  } catch (err) {
    const e = err;
    if (e.retryable !== false) {
      updateGlobal((s) => s.jevOpenUntil = Date.now() + BREAKER_COOLDOWN_MS);
    }
    return { error: e.message };
  }
}

// src/core/ledger.ts
import fs3 from "node:fs";
import path3 from "node:path";
var ledgerFile = () => path3.join(jevHome(), "ledger.jsonl");
function readLedger(sinceMs = 0) {
  let raw = "";
  try {
    raw = fs3.readFileSync(ledgerFile(), "utf8");
  } catch {
    return [];
  }
  const out = [];
  for (const line of raw.split("\n")) {
    if (!line) continue;
    try {
      const e = JSON.parse(line);
      if (e.at >= sinceMs) out.push(e);
    } catch {
    }
  }
  return out;
}
function summarize(entries) {
  const s = {
    prompts: 0,
    routed: 0,
    byAction: {},
    byTier: [0, 0, 0],
    actualUsd: 0,
    baselineUsd: 0,
    savedUsd: 0,
    savedPct: 0,
    escalations: 0,
    jevFailures: 0,
    jevCostUsd: 0
  };
  for (const e of entries) {
    if (e.kind === "decision") {
      s.prompts++;
      s.byAction[e.decision.action] = (s.byAction[e.decision.action] ?? 0) + 1;
      s.byTier[e.decision.tier]++;
      if (e.decision.action !== "stay") s.routed++;
      if (e.classifier === "none") s.jevFailures++;
      s.jevCostUsd += e.jevCostUsd ?? 0;
    } else if (e.kind === "usage") {
      s.actualUsd += e.actualUsd;
      s.baselineUsd += e.baselineUsd;
    } else if (e.kind === "signal" && (e.signal === "escalate" || e.signal === "complaint")) {
      s.escalations++;
    }
  }
  s.savedUsd = s.baselineUsd - s.actualUsd - s.jevCostUsd;
  s.savedPct = s.baselineUsd > 0 ? s.savedUsd / s.baselineUsd * 100 : 0;
  return s;
}

// src/core/policy.ts
var STAGES = {
  1: {
    name: "Balanced",
    threshold: 0.9,
    delegateTiers: [0],
    riskFloor: 2,
    architectureFloor: 2,
    lowConfidenceDrop: 0,
    stickyAt: 0.6,
    brevity: false,
    defaultMainTier: 2
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
    defaultMainTier: 2
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
    defaultMainTier: 1
  }
};
var LOW_CONFIDENCE = 0.4;
var READ_ONLY_DISCOUNT = 0.1;
var SEVERE_RISK = 0.8;
var STAGE_NAMES = {
  0: "Off (observe only)",
  1: STAGES[1].name,
  2: STAGES[2].name,
  3: STAGES[3].name
};
var TIER_CAPABILITY = {
  0: { levelWeights: [1, 0.85, 0.25, 0, 0], reasoningPenalty: 0.2, crossCuttingPenalty: 0.5 },
  1: { levelWeights: [1, 1, 0.95, 0.6, 0.1], reasoningPenalty: 0.1, crossCuttingPenalty: 0.1 },
  2: { levelWeights: [1, 1, 1, 1, 1], reasoningPenalty: 0, crossCuttingPenalty: 0 }
};
function readOnlyShare(c) {
  return c.taskType.lookup + c.taskType.explain + c.taskType.chore;
}
function sufficiency(c) {
  const out = [0, 0, 0];
  for (const t of [0, 1, 2]) {
    const cap = TIER_CAPABILITY[t];
    const mass = c.complexity.reduce((sum, p, level) => sum + p * (cap.levelWeights[level] ?? 0), 0);
    const crossCutting = (c.scope[c.scope.length - 1] ?? 0) * (1 - readOnlyShare(c));
    out[t] = clamp012(mass * (1 - cap.reasoningPenalty * c.reasoning) * (1 - cap.crossCuttingPenalty * crossCutting));
  }
  return out;
}
function topTaskType(c) {
  return TASK_TYPES.reduce((a, b) => c.taskType[a] >= c.taskType[b] ? a : b);
}
function decide(input) {
  const stage = input.stage;
  const preset = stage === 0 ? STAGES[2] : STAGES[stage];
  const mainTier = input.mainTier ?? preset.defaultMainTier;
  const reasons = [];
  const c = input.classification;
  const taskType = c ? topTaskType(c) : "feature";
  const suff = c ? sufficiency(c) : [0, 0, 1];
  const readOnlyDiscount = c ? READ_ONLY_DISCOUNT * readOnlyShare(c) : 0;
  const threshold = clamp(preset.threshold + (input.calibrationOffset ?? 0) - readOnlyDiscount, 0.4, 0.97);
  const base = { mainTier, stage, sufficiency: suff, threshold, taskType };
  if (input.bypass) {
    return { ...base, tier: mainTier, assessedTier: mainTier, action: "stay", reasons: ["!nojev: routing skipped"], override: "nojev" };
  }
  if (input.forcedTier) {
    const tier2 = input.forcedTier.tier;
    return {
      ...base,
      tier: tier2,
      assessedTier: tier2,
      action: actionFor(tier2, mainTier),
      reasons: [input.forcedTier.reason],
      override: input.forcedTier.kind
    };
  }
  if (!c) {
    return {
      ...base,
      tier: mainTier,
      assessedTier: mainTier,
      action: "stay",
      reasons: [`fail-open: ${input.classifyError ?? "no classification"}; kept main model`]
    };
  }
  let tier = 2;
  for (const t of [0, 1, 2]) {
    if (suff[t] >= threshold) {
      tier = t;
      break;
    }
  }
  reasons.push(`cheapest tier with P(sufficient) \u2265 ${threshold.toFixed(2)} is T${tier} (${suff.map((p) => p.toFixed(2)).join(" / ")})`);
  if (input.calibrationOffset) {
    reasons.push(`repo calibration for ${taskType}: ${input.calibrationOffset > 0 ? "+" : ""}${input.calibrationOffset.toFixed(2)}`);
  }
  const raise = (floor, why) => {
    if (tier < floor) {
      tier = floor;
      reasons.push(why);
    }
  };
  if (c.risk >= SEVERE_RISK) raise(2, `high-stakes (risk ${c.risk.toFixed(2)}) \u2192 top tier in every stage`);
  else if (c.risk >= 0.5) raise(preset.riskFloor, `risk ${c.risk.toFixed(2)} \u2265 0.5 \u2192 floor T${preset.riskFloor}`);
  if (c.taskType.architecture >= 0.45) raise(preset.architectureFloor, `architecture/planning \u2192 floor T${preset.architectureFloor}`);
  if (c.complexityConfidence < LOW_CONFIDENCE) {
    const floor = Math.max(0, mainTier - preset.lowConfidenceDrop);
    raise(floor, `classifier confidence ${c.complexityConfidence.toFixed(2)} < ${LOW_CONFIDENCE} \u2192 floor T${floor}`);
  }
  if (input.taskTier !== void 0 && c.continuation >= preset.stickyAt) {
    raise(input.taskTier, `continuing current task (p=${c.continuation.toFixed(2)}) \u2192 stay on T${input.taskTier}`);
  }
  const assessedTier = tier;
  if (tier < mainTier && !preset.delegateTiers.includes(tier)) {
    reasons.push(`stage ${stage} doesn't delegate to T${tier} \u2192 stay on main`);
    tier = mainTier;
  }
  let action = actionFor(tier, mainTier);
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
function actionFor(tier, mainTier) {
  if (tier < mainTier) return "delegate_down";
  if (tier > mainTier) return "escalate";
  return "stay";
}
function clamp012(x) {
  return Math.min(1, Math.max(0, x));
}
function clamp(x, lo, hi) {
  return Math.min(hi, Math.max(lo, x));
}

// src/cli/audit.ts
import fs5 from "node:fs";
import os2 from "node:os";
import path4 from "node:path";

// src/core/models.ts
var CLAUDE_MODELS = [
  { id: "claude-haiku-4-5", tier: 0, input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25 },
  { id: "claude-sonnet-5", tier: 1, input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 },
  { id: "claude-sonnet-4-6", tier: 1, input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
  { id: "claude-opus-5-5", tier: 2, input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5 },
  { id: "claude-opus-5", tier: 2, input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
  { id: "claude-opus-4-8", tier: 2, input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
  { id: "claude-fable-5-1", tier: 2, input: 10, output: 50, cacheRead: 0.25, cacheWrite: 12.5 }
];
var OPENAI_MODELS = [
  { id: "gpt-6-luna", tier: 0, input: 0.1, output: 0.5, cacheRead: 0.01, cacheWrite: 0.1 },
  { id: "gpt-6-sol", tier: 1, input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2 },
  { id: "gpt-6-astra", tier: 2, input: 10, output: 50, cacheRead: 1, cacheWrite: 10 },
  { id: "gpt-5.5", tier: 2, input: 5, output: 30, cacheRead: 0.5, cacheWrite: 5 }
];
var DEFAULT_TIER_MODELS = {
  claude: ["claude-haiku-4-5", "claude-sonnet-5", "claude-opus-5-5"],
  codex: ["gpt-6-luna", "gpt-6-sol", "gpt-6-astra"]
};
var CLAUDE_ALIASES = ["haiku", "sonnet", "opus"];
var ROUTE_AGENTS = ["jev-quick", "jev-worker", "jev-deep"];
var ALL_MODELS = [...CLAUDE_MODELS, ...OPENAI_MODELS];
function findModel(id) {
  if (!id) return void 0;
  const clean = id.toLowerCase().replace(/\[.*\]$/, "").replace(/-\d{8}$/, "");
  return ALL_MODELS.find((m) => m.id === clean) ?? // Longest id that prefixes the name, e.g. "claude-opus-5-5-fast" -> claude-opus-5-5.
  [...ALL_MODELS].sort((a, b) => b.id.length - a.id.length).find((m) => clean.startsWith(m.id));
}
function modelForTier(host, tier, overrides) {
  const id = overrides?.[host]?.[tier] ?? DEFAULT_TIER_MODELS[host][tier];
  return findModel(id) ?? { ...findModel(DEFAULT_TIER_MODELS[host][tier]), id };
}
function costOf(model, u) {
  return (u.input * model.input + u.output * model.output + u.cacheRead * model.cacheRead + u.cacheWrite * model.cacheWrite) / 1e6;
}

// src/core/transcript.ts
import fs4 from "node:fs";
function readTurns(file) {
  let raw;
  try {
    raw = fs4.readFileSync(file, "utf8");
  } catch {
    return [];
  }
  const turns = [];
  const seen = /* @__PURE__ */ new Set();
  let current;
  let lastAssistantText;
  for (const line of raw.split("\n")) {
    const e = parse(line);
    if (!e || e.isSidechain) continue;
    if (e.type === "user") {
      const content = e.message?.content;
      const isToolResult = Array.isArray(content) && content.some((c) => c?.type === "tool_result");
      const text = textOf(content);
      if (isToolResult || !text || text.startsWith("<command-") || text.startsWith("<local-command")) continue;
      current = {
        prompt: text,
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        previousAssistant: lastAssistantText
      };
      turns.push(current);
    } else if (e.type === "assistant" && current) {
      const text = textOf(e.message?.content);
      if (text) lastAssistantText = text;
      const u = e.message?.usage;
      const id = e.message?.id;
      if (!u || id && seen.has(id)) continue;
      if (id) seen.add(id);
      current.model ??= e.message?.model;
      current.usage.input += u.input_tokens ?? 0;
      current.usage.output += u.output_tokens ?? 0;
      current.usage.cacheRead += u.cache_read_input_tokens ?? 0;
      current.usage.cacheWrite += u.cache_creation_input_tokens ?? 0;
    }
  }
  return turns;
}
function parse(line) {
  if (!line || line[0] !== "{") return void 0;
  try {
    return JSON.parse(line);
  } catch {
    return void 0;
  }
}
function textOf(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return void 0;
  const parts = content.filter((c) => c?.type === "text").map((c) => c.text ?? "");
  const joined = parts.join("\n").trim();
  return joined || void 0;
}

// src/cli/audit.ts
var DELEGATION_OVERHEAD = 1.2;
var BRIEF_OUTPUT_FACTOR = 0.6;
var RELAY = { input: 0, output: 400, cacheRead: 4e3, cacheWrite: 1500 };
var SUBAGENT_STARTUP = { input: 0, output: 0, cacheRead: 0, cacheWrite: 25e3 };
function findTranscripts(dir, sinceMs) {
  const out = [];
  let projects = [];
  try {
    projects = fs5.readdirSync(dir);
  } catch {
    return out;
  }
  for (const p of projects) {
    const pdir = path4.join(dir, p);
    let files = [];
    try {
      files = fs5.readdirSync(pdir);
    } catch {
      continue;
    }
    for (const f of files) {
      if (!f.endsWith(".jsonl")) continue;
      const full = path4.join(pdir, f);
      try {
        if (fs5.statSync(full).mtimeMs >= sinceMs) out.push(full);
      } catch {
      }
    }
  }
  return out;
}
async function runAudit(opts, cfg, onProgress) {
  const dir = opts.projectsDir ?? path4.join(os2.homedir(), ".claude", "projects");
  const files = findTranscripts(dir, Date.now() - opts.days * 864e5);
  const allTurns = files.flatMap((f) => readTurns(f));
  const turns = allTurns.filter((t) => findModel(t.model));
  const unknown = new Set(
    allTurns.map((t) => t.model).filter((m) => Boolean(m) && m !== "<synthetic>" && !findModel(m))
  );
  const sample = turns.length > opts.limit ? evenSample(turns, opts.limit) : turns;
  const useJev = !opts.offline && cfg.classifier === "jev" && Boolean(cfg.jevApiKey);
  const classes = new Array(sample.length);
  let done = 0;
  const concurrency = useJev ? 4 : 1;
  let next = 0;
  await Promise.all(
    Array.from({ length: concurrency }, async () => {
      while (next < sample.length) {
        const i = next++;
        const t = sample[i];
        classes[i] = useJev ? (await classify({ prompt: t.prompt, previousAssistant: t.previousAssistant }, { ...cfg, jevTimeoutMs: 8e3 })).classification : classifyHeuristic(t.prompt, Boolean(t.previousAssistant));
        onProgress?.(++done, sample.length);
      }
    })
  );
  const scale = turns.length / Math.max(1, sample.length);
  const report = {
    sessions: files.length,
    turns: turns.length,
    classified: classes.filter(Boolean).length,
    classifier: useJev ? "jev" : "heuristic",
    baselineUsd: 0,
    stages: {
      1: { usd: 0, saved: 0, savedPct: 0, delegated: 0, escalated: 0, brief: 0 },
      2: { usd: 0, saved: 0, savedPct: 0, delegated: 0, escalated: 0, brief: 0 },
      3: { usd: 0, saved: 0, savedPct: 0, delegated: 0, escalated: 0, brief: 0 }
    },
    unknownModels: [...unknown]
  };
  sample.forEach((t, i) => {
    const main2 = findModel(t.model);
    const baseline = costOf(main2, t.usage);
    report.baselineUsd += baseline * scale;
    for (const stage of [1, 2, 3]) {
      const s = report.stages[stage];
      const simMain = stage === 3 && main2.tier > 1 ? modelForTier("claude", 1, cfg.tierModels) : main2;
      const d = decide({ stage, mainTier: simMain.tier, classification: classes[i] });
      const onMain = costOf(simMain, t.usage);
      let cost = onMain;
      if (d.action === "delegate_down" || d.action === "escalate") {
        const target = modelForTier("claude", d.tier, cfg.tierModels);
        cost = costOf(target, t.usage) * DELEGATION_OVERHEAD + costOf(target, SUBAGENT_STARTUP) + costOf(simMain, RELAY);
        if (d.action === "delegate_down") s.delegated++;
        else s.escalated++;
      } else if (d.action === "brief") {
        cost = onMain - t.usage.output * (1 - BRIEF_OUTPUT_FACTOR) * simMain.output / 1e6;
        s.brief++;
      }
      s.usd += cost * scale;
    }
  });
  for (const k of [1, 2, 3]) {
    const s = report.stages[k];
    s.saved = report.baselineUsd - s.usd;
    s.savedPct = report.baselineUsd > 0 ? s.saved / report.baselineUsd * 100 : 0;
  }
  return report;
}
function evenSample(xs, n) {
  const step = xs.length / n;
  return Array.from({ length: n }, (_, i) => xs[Math.floor(i * step)]);
}

// src/cli/eval.ts
import fs6 from "node:fs";
function loadCases(file) {
  return fs6.readFileSync(file, "utf8").split("\n").filter((l) => l.trim() && !l.trim().startsWith("//")).map((l) => JSON.parse(l));
}
async function runEval(cases, cfg, offline) {
  const useJev = !offline && cfg.classifier === "jev" && Boolean(cfg.jevApiKey);
  const classes = [];
  for (const c of cases) {
    classes.push(
      useJev ? (await classify({ prompt: c.prompt }, { ...cfg, jevTimeoutMs: 8e3 })).classification : classifyHeuristic(c.prompt)
    );
  }
  const out = {};
  for (const stage of [1, 2, 3]) {
    const s = { exact: 0, under: 0, over: 0, underRate: 0, accuracy: 0, misses: [] };
    cases.forEach((c, i) => {
      const got = decide({ stage, mainTier: 2, classification: classes[i] }).assessedTier;
      if (got === c.tier) s.exact++;
      else {
        if (got < c.tier) s.under++;
        else s.over++;
        s.misses.push({ prompt: c.prompt, label: c.tier, got });
      }
    });
    s.accuracy = s.exact / Math.max(1, cases.length);
    s.underRate = s.under / Math.max(1, cases.length);
    out[stage] = s;
  }
  return out;
}

// src/cli/format.ts
var useColor = process.stdout.isTTY && !process.env.NO_COLOR;
var wrap = (code) => (s) => useColor ? `\x1B[${code}m${s}\x1B[0m` : s;
var bold = wrap("1");
var dim = wrap("2");
var green = wrap("32");
var yellow = wrap("33");
var cyan = wrap("36");
function usd(n) {
  const sign = n < 0 ? "-" : "";
  const a = Math.abs(n);
  if (a >= 100) return `${sign}$${a.toFixed(0)}`;
  if (a >= 1) return `${sign}$${a.toFixed(2)}`;
  return `${sign}$${a.toFixed(3)}`;
}
function pct(n) {
  const r = Math.round(n);
  return `${r === 0 ? 0 : r}%`;
}
function describeDecision(d) {
  const lines = [
    `${bold("Action")}      ${d.action}  (tier T${d.tier} ${CLAUDE_ALIASES[d.tier]}, main T${d.mainTier} ${CLAUDE_ALIASES[d.mainTier]})`,
    `${bold("Stage")}       ${d.stage} \xB7 ${STAGE_NAMES[d.stage]}`,
    `${bold("Task type")}   ${d.taskType}`,
    `${bold("P(suff.)")}    T0 ${d.sufficiency[0].toFixed(2)} \xB7 T1 ${d.sufficiency[1].toFixed(2)} \xB7 T2 ${d.sufficiency[2].toFixed(2)}   threshold ${d.threshold.toFixed(2)}`
  ];
  if (d.override) lines.push(`${bold("Override")}    ${d.override}`);
  lines.push(`${bold("Why")}`);
  for (const r of d.reasons) lines.push(`  \u2022 ${r}`);
  return lines.join("\n");
}
function table(rows) {
  const widths = rows[0].map((_, i) => Math.max(...rows.map((r) => stripAnsi(r[i] ?? "").length)));
  return rows.map((r) => r.map((cell, i) => cell + " ".repeat(widths[i] - stripAnsi(cell).length)).join("   ")).join("\n");
}
function stripAnsi(s) {
  return s.replace(/\x1b\[[0-9;]*m/g, "");
}

// src/cli/setup.ts
import fs7 from "node:fs";
import os3 from "node:os";
import path5 from "node:path";
function backup(file) {
  if (!fs7.existsSync(file)) return void 0;
  const dest = `${file}.jev-backup-${(/* @__PURE__ */ new Date()).toISOString().replace(/[:.]/g, "-")}`;
  fs7.copyFileSync(file, dest);
  return dest;
}
function setupClaudeStatusline(opts) {
  const file = opts.settingsPath ?? path5.join(os3.homedir(), ".claude", "settings.json");
  let settings = {};
  try {
    settings = JSON.parse(fs7.readFileSync(file, "utf8"));
  } catch {
  }
  const existing = settings.statusLine;
  if (existing?.command?.includes("jev")) return { changed: [], notes: ["jev statusline already installed."] };
  if (existing && !opts.force) {
    return {
      changed: [],
      notes: [
        `You already have a statusline (${existing.command ?? "custom"}). Re-run with --force to replace it,`,
        `or append the jev segment to your script: \`echo "$input" | ${opts.command}\`.`
      ]
    };
  }
  const bak = backup(file);
  settings.statusLine = { type: "command", command: opts.command, padding: 0 };
  fs7.mkdirSync(path5.dirname(file), { recursive: true });
  fs7.writeFileSync(file, JSON.stringify(settings, null, 2) + "\n");
  return { changed: [file], notes: bak ? [`Backup: ${bak}`] : [] };
}
var ROLE_TEXT = {
  0: {
    description: "Fast, low-cost worker for simple, well-specified tasks: codebase lookups, small edits, routine shell/git chores. Used by jev routing.",
    instructions: "You are a fast worker handling a simple, well-specified task delegated by the main agent. Do exactly what the brief asks, verify it if a check is given, and reply with a terse result: what you did, files touched, anything that failed. If the task turns out to be harder or riskier than described, stop and say so instead of guessing.",
    effort: "low"
  },
  1: {
    description: "Capable mid-tier worker for moderate coding tasks: focused features, bug fixes, reviews. Used by jev routing.",
    instructions: "You are a capable engineer handling a delegated coding task. Follow the brief, keep changes minimal and consistent with the surrounding code, run the verification step if one is given, and reply with a concise summary: what changed, files touched, verification result, open questions.",
    effort: "medium"
  },
  2: {
    description: "Top-tier model for complex, subtle, or high-stakes work: hard debugging, architecture, security-sensitive changes. Used by jev routing to escalate.",
    instructions: "You are a senior engineer taking over a hard problem escalated by the main agent. Reason carefully, verify assumptions against the code, prefer correct over fast, and reply with a clear summary of findings, changes, verification, and remaining risks.",
    effort: "high"
  }
};
function codexRoleToml(tier, cfg) {
  const role = ROLE_TEXT[tier];
  const model = modelForTier("codex", tier, cfg.tierModels).id;
  return [
    `# Installed by jevcode (jev setup codex). Safe to delete; re-run setup to restore.`,
    `name = ${JSON.stringify(ROUTE_AGENTS[tier])}`,
    `description = ${JSON.stringify(role.description)}`,
    `nickname_candidates = [${JSON.stringify(["Quick", "Worker", "Deep"][tier])}]`,
    `model = ${JSON.stringify(model)}`,
    `model_reasoning_effort = ${JSON.stringify(role.effort)}`,
    `developer_instructions = """`,
    role.instructions,
    `"""`,
    ""
  ].join("\n");
}
function setupCodexRoles(cfg, codexHome = path5.join(os3.homedir(), ".codex")) {
  const dir = path5.join(codexHome, "agents");
  fs7.mkdirSync(dir, { recursive: true });
  const changed = [];
  for (const tier of [0, 1, 2]) {
    const file = path5.join(dir, `${ROUTE_AGENTS[tier]}.toml`);
    const content = codexRoleToml(tier, cfg);
    if (fs7.existsSync(file) && fs7.readFileSync(file, "utf8") === content) continue;
    fs7.writeFileSync(file, content);
    changed.push(file);
  }
  saveConfig({ codexRoles: true });
  return {
    changed,
    notes: [
      "Codex agent roles installed. Hook-driven delegation is now enabled for Codex.",
      "Optional: to make Codex's own sub-agents cheaper too, add to ~/.codex/config.toml:",
      `  [agents]
  default_subagent_model = "${modelForTier("codex", 1, cfg.tierModels).id}"`
    ]
  };
}

// src/cli/statusline.ts
function statusline(stdinJson) {
  let sessionId;
  let modelId;
  try {
    const input = JSON.parse(stdinJson);
    sessionId = input.session_id;
    modelId = input.model?.id;
  } catch {
  }
  if (sessionId && modelId) {
    const s2 = loadSession(sessionId);
    if (s2.mainModel !== modelId) {
      s2.mainModel = modelId;
      saveSession(s2);
    }
  }
  const cfg = loadConfig();
  const parts = [`jev ${cfg.stage === 0 ? "off" : STAGE_NAMES[cfg.stage]}`];
  const d = sessionId ? loadSession(sessionId).lastDecision : void 0;
  if (d) {
    if (d.action === "delegate_down") parts.push(`\u2192 ${CLAUDE_ALIASES[d.tier]}`);
    else if (d.action === "escalate") parts.push(`\u2191 ${CLAUDE_ALIASES[d.tier]}`);
    else if (d.action === "brief") parts.push("brief");
    if (d.override === "escalate") parts.push("escalated");
  }
  const startOfDay = /* @__PURE__ */ new Date();
  startOfDay.setHours(0, 0, 0, 0);
  const s = summarize(readLedger(startOfDay.getTime()));
  if (s.baselineUsd > 0) parts.push(`saved ${usd(s.savedUsd)} today`);
  if (cfg.classifier === "heuristic") parts.push("offline");
  return parts.join(" \xB7 ");
}

// src/cli/index.ts
var HELP = `${bold("jev")} \u2014 Jev-powered model routing for Claude Code and Codex

${bold("Usage")}
  jev mode [off|1|2|3]        Show or set the optimization stage
                              1 Balanced \xB7 2 Saver \xB7 3 Max Saver
  jev status                  Current config, classifier, last decision
  jev why [session-id]        Explain the last routing decision
  jev stats [--days N]        Routing counts and estimated savings
  jev escalate [deep|worker]  Force the next prompt onto a stronger model
  jev classify "<prompt>"     Show how a prompt would be routed in each stage
  jev audit [--days N] [--offline] [--limit N]
                              Estimate savings from your past Claude Code sessions
  jev eval <file.jsonl> [--offline]
                              Score routing against a labeled prompt set
  jev setup key <OPENROUTER_API_KEY>   (a TypeSafe key also works; detected by prefix)
  jev setup statusline [--force]
  jev setup codex             Install Codex agent roles (enables delegation)
  jev config [get|set <key> <value>]
  jev doctor                  Check installation and Jev connectivity

Inline overrides in any prompt: !deep  !quick  !nojev
`;
function flag(args, name) {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : void 0;
}
function parseStage(v) {
  const m = { off: 0, "0": 0, "1": 1, balanced: 1, "2": 2, saver: 2, "3": 3, max: 3, "max-saver": 3 };
  return m[v.toLowerCase()];
}
async function readStdin() {
  if (process.stdin.isTTY) return "";
  const chunks = [];
  for await (const c of process.stdin) chunks.push(c);
  return Buffer.concat(chunks).toString("utf8");
}
function selfCommand() {
  const self = fileURLToPath(import.meta.url);
  return `node ${JSON.stringify(self)} statusline`;
}
async function main(argv) {
  const [cmd, ...args] = argv;
  const cfg = loadConfig();
  switch (cmd) {
    case void 0:
    case "help":
    case "--help":
    case "-h":
      process.stdout.write(HELP);
      return 0;
    case "mode": {
      if (!args[0]) {
        console.log(`Stage ${cfg.stage} \xB7 ${STAGE_NAMES[cfg.stage]}`);
        return 0;
      }
      const stage = parseStage(args[0]);
      if (stage === void 0) {
        console.error("Stage must be off, 1, 2, or 3.");
        return 1;
      }
      saveConfig({ stage });
      console.log(`jev stage set to ${stage} \xB7 ${STAGE_NAMES[stage]}`);
      if (stage === 3) {
        console.log(
          dim("Max Saver works best with a mid-tier main session (Claude Code: /model sonnet; Codex: /model gpt-6-sol).\nHard tasks escalate to the jev-deep agent automatically.")
        );
      }
      return 0;
    }
    case "status": {
      const last = latestSession()?.lastDecision;
      console.log(
        table([
          ["Stage", `${cfg.stage} \xB7 ${STAGE_NAMES[cfg.stage]}`],
          ["Classifier", cfg.classifier === "jev" ? `Jev ${cfg.jevModel} via ${cfg.jevProvider}` : yellow("offline heuristic (no OPENROUTER_API_KEY)")],
          ["Main tier", Object.keys(cfg.mainTier).length ? JSON.stringify(cfg.mainTier) : "auto-detect"],
          ["Codex roles", cfg.codexRoles ? "installed" : "not installed (jev setup codex)"],
          ["Config", configPath()],
          ["Last decision", last ? `${last.action} T${last.tier} \xB7 ${last.taskType}` : "\u2014"]
        ])
      );
      return 0;
    }
    case "why": {
      const byId = args[0] ? loadSession(args[0]) : void 0;
      const s = byId?.lastDecision ? byId : latestSession();
      if (!s?.lastDecision) {
        console.log("No routing decisions yet.");
        return 0;
      }
      if (s.lastPrompt) console.log(`${bold("Prompt")}      ${s.lastPrompt.slice(0, 160).replace(/\s+/g, " ")}`);
      console.log(describeDecision(s.lastDecision));
      return 0;
    }
    case "stats": {
      const days = Number(flag(args, "--days") ?? 7);
      const s = summarize(readLedger(Date.now() - days * 864e5));
      if (args.includes("--json")) {
        console.log(JSON.stringify(s, null, 2));
        return 0;
      }
      console.log(bold(`Last ${days} day${days === 1 ? "" : "s"}`));
      console.log(
        table([
          ["Prompts routed", `${s.routed} of ${s.prompts}`],
          ["Actions", Object.entries(s.byAction).map(([k, v]) => `${k} ${v}`).join(" \xB7 ") || "\u2014"],
          ["Tiers", `T0 ${s.byTier[0]} \xB7 T1 ${s.byTier[1]} \xB7 T2 ${s.byTier[2]}`],
          ["Actual spend", usd(s.actualUsd)],
          ["Without routing", usd(s.baselineUsd)],
          ["Saved (net of Jev)", s.baselineUsd > 0 ? green(`${usd(s.savedUsd)} (${pct(s.savedPct)})`) : "\u2014"],
          ["Jev cost", s.jevCostUsd > 0 ? usd(s.jevCostUsd) : "\u2014"],
          ["Escalations", String(s.escalations)],
          ["Jev unavailable", String(s.jevFailures)]
        ])
      );
      console.log(dim("Spend is API-list-price equivalent from transcript token counts; on a subscription it maps to plan usage."));
      return 0;
    }
    case "escalate": {
      const tier = args[0] === "worker" ? 1 : 2;
      updateGlobal((g) => g.pendingOverride = { tier, reason: `jev escalate (${tier === 2 ? "deep" : "worker"})`, at: Date.now() });
      console.log(`Next prompt will run on tier ${tier} (${tier === 2 ? "jev-deep" : "jev-worker"}).`);
      return 0;
    }
    case "classify": {
      const prompt = args.filter((a) => !a.startsWith("--")).join(" ") || await readStdin();
      if (!prompt.trim()) {
        console.error('Usage: jev classify "<prompt>"');
        return 1;
      }
      const r = await classify({ prompt }, cfg);
      if (!r.classification) {
        console.error(`Classification failed: ${r.error}`);
        return 1;
      }
      const c = r.classification;
      console.log(dim(`classifier: ${c.source} \xB7 ${c.latencyMs} ms`));
      console.log(`complexity  ${c.complexity.map((p) => p.toFixed(2)).join(" ")}  (conf ${c.complexityConfidence.toFixed(2)})`);
      console.log(`reasoning ${c.reasoning.toFixed(2)} \xB7 risk ${c.risk.toFixed(2)} \xB7 continuation ${c.continuation.toFixed(2)}`);
      const mainTier = cfg.mainTier.claude ?? 2;
      for (const stage of [1, 2, 3]) {
        const d = decide({ stage, mainTier, classification: c });
        console.log(`
${cyan(`Stage ${stage} \xB7 ${STAGE_NAMES[stage]}`)}  \u2192  ${bold(d.action)} T${d.tier}`);
        for (const reason of d.reasons) console.log(dim(`  \u2022 ${reason}`));
      }
      return 0;
    }
    case "audit": {
      const days = Number(flag(args, "--days") ?? 30);
      const limit = Number(flag(args, "--limit") ?? (cfg.classifier === "jev" ? 300 : 5e3));
      const offline = args.includes("--offline");
      const report = await runAudit({ days, offline, limit, projectsDir: flag(args, "--dir") }, cfg, (done, total) => {
        if (process.stderr.isTTY) process.stderr.write(`\rclassifying ${done}/${total}\u2026`);
      });
      if (process.stderr.isTTY) process.stderr.write("\r\x1B[K");
      if (args.includes("--json")) {
        console.log(JSON.stringify(report, null, 2));
        return 0;
      }
      if (report.turns === 0) {
        console.log(`No Claude Code prompts found in the last ${days} days.`);
        return 0;
      }
      console.log(bold(`jev audit \xB7 last ${days} days \xB7 ${report.turns} prompts in ${report.sessions} sessions`));
      console.log(dim(`classifier: ${report.classifier}${report.classifier === "heuristic" ? " (set OPENROUTER_API_KEY for Jev-quality estimates)" : ""}`));
      console.log(`
Without routing: ${bold(usd(report.baselineUsd))} (API list-price equivalent)
`);
      const rows = [["Stage", "Est. cost", "Saved", "Delegated", "Escalated", "Brief"]];
      for (const k of [1, 2, 3]) {
        const s = report.stages[k];
        rows.push([
          `${k} \xB7 ${STAGE_NAMES[k]}`,
          usd(s.usd),
          green(`${usd(s.saved)} (${pct(s.savedPct)})`),
          String(s.delegated),
          String(s.escalated),
          String(s.brief)
        ]);
      }
      console.log(table(rows));
      console.log(
        dim(
          "\nEstimates: re-routed turns are priced on the target model with 20% overhead, a sub-agent start-up cost, and the main\nmodel's relay; brief answers cut output 40%. On a Pro/Max plan the same ratio applies to your usage limits."
        )
      );
      if (report.unknownModels.length) console.log(dim(`Skipped models without price data: ${report.unknownModels.join(", ")}`));
      return 0;
    }
    case "eval": {
      const file = args.find((a) => !a.startsWith("--"));
      if (!file) {
        console.error("Usage: jev eval <file.jsonl> [--offline]");
        return 1;
      }
      const cases = loadCases(file);
      const scores = await runEval(cases, cfg, args.includes("--offline"));
      const rows = [["Stage", "Accuracy", "Under-routed", "Over-routed"]];
      for (const k of [1, 2, 3]) {
        const s = scores[k];
        rows.push([`${k} \xB7 ${STAGE_NAMES[k]}`, pct(s.accuracy * 100), `${s.under} (${pct(s.underRate * 100)})`, String(s.over)]);
      }
      console.log(bold(`${cases.length} labeled prompts`));
      console.log(table(rows));
      if (args.includes("--verbose")) {
        const vs = Number(flag(args, "--stage") ?? 2) || 2;
        for (const m of scores[vs].misses) console.log(dim(`  stage ${vs}: label T${m.label} got T${m.got}  ${m.prompt.slice(0, 90)}`));
      }
      const maxUnder = Number(flag(args, "--max-under") ?? NaN);
      if (!Number.isNaN(maxUnder) && scores[2].underRate > maxUnder) {
        console.error(`Saver under-routing ${pct(scores[2].underRate * 100)} exceeds ${pct(maxUnder * 100)}`);
        return 1;
      }
      return 0;
    }
    case "setup": {
      const [what, ...rest] = args;
      if (what === "key") {
        if (!rest[0]) {
          console.error("Usage: jev setup key <OPENROUTER_API_KEY> [--provider openrouter|typesafe]");
          return 1;
        }
        const named = flag(rest, "--provider");
        const jevProvider = named ?? (rest[0].startsWith("sk-or-") ? "openrouter" : "typesafe");
        saveConfig({ jevApiKey: rest[0], classifier: "jev", jevProvider, jevApiBase: void 0, jevModel: void 0 });
        console.log(`Saved ${jevProvider} key to ${configPath()} (mode 600). Model: ${JEV_PROVIDERS[jevProvider].model}.`);
        console.log(dim("Run `jev doctor` to check connectivity."));
        return 0;
      }
      if (what === "statusline") {
        const r = setupClaudeStatusline({ force: rest.includes("--force"), command: selfCommand() });
        for (const f of r.changed) console.log(`Updated ${f}`);
        for (const n of r.notes) console.log(n);
        return 0;
      }
      if (what === "codex") {
        const r = setupCodexRoles(cfg);
        for (const f of r.changed) console.log(`Wrote ${f}`);
        for (const n of r.notes) console.log(n);
        return 0;
      }
      console.error("Usage: jev setup key|statusline|codex");
      return 1;
    }
    case "config": {
      if (args[0] === "set" && args[1] && args[2] !== void 0) {
        const key = args[1];
        if (!(key in DEFAULT_CONFIG) && key !== "jevApiKey") {
          console.error(`Unknown key: ${key}`);
          return 1;
        }
        let value = args[2];
        try {
          value = JSON.parse(args[2]);
        } catch {
        }
        saveConfig({ [key]: value });
        console.log(`${key} = ${JSON.stringify(value)}`);
        return 0;
      }
      const shown = { ...cfg, jevApiKey: cfg.jevApiKey ? `${cfg.jevApiKey.slice(0, 6)}\u2026` : void 0 };
      console.log(JSON.stringify(shown, null, 2));
      return 0;
    }
    case "doctor": {
      let ok = true;
      const check = (name, pass, detail) => {
        ok &&= pass;
        console.log(`${pass ? green("\u2713") : yellow("!")} ${name}: ${detail}`);
      };
      const major = Number(process.versions.node.split(".")[0]);
      check("Node", major >= 18, process.versions.node);
      check("Config", true, fs8.existsSync(configPath()) ? configPath() : "defaults (no config file yet)");
      if (cfg.classifier === "jev" && cfg.jevApiKey) {
        const r = await classify({ prompt: "rename the variable foo to bar in utils.ts" }, { ...cfg, jevTimeoutMs: 5e3 });
        const c = r.classification;
        check(
          "Jev",
          Boolean(c),
          c ? `${cfg.jevProvider} \xB7 ${c.jevModel ?? cfg.jevModel} \xB7 ${c.latencyMs} ms${c.costUsd !== void 0 ? ` \xB7 $${c.costUsd.toFixed(6)}/call` : ""}` : `${cfg.jevProvider} (${cfg.jevApiBase}): ${r.error}`
        );
      } else {
        check("Jev", false, "no OPENROUTER_API_KEY, using the offline heuristic (jev setup key <key>)");
      }
      const bundleDir = path6.dirname(fileURLToPath(import.meta.url));
      check("Hook bundle", fs8.existsSync(path6.join(bundleDir, "hook.mjs")), path6.join(bundleDir, "hook.mjs"));
      return ok ? 0 : 1;
    }
    case "statusline":
      process.stdout.write(statusline(await readStdin()));
      return 0;
    default:
      console.error(`Unknown command: ${cmd}
`);
      process.stdout.write(HELP);
      return 1;
  }
}
main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  }
);
