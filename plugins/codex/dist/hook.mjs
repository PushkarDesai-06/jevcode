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

// src/core/ledger.ts
import fs2 from "node:fs";
import path2 from "node:path";
var ledgerFile = () => path2.join(jevHome(), "ledger.jsonl");
function appendLedger(entry) {
  try {
    fs2.mkdirSync(jevHome(), { recursive: true });
    fs2.appendFileSync(ledgerFile(), JSON.stringify(entry) + "\n");
  } catch {
  }
}

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
function tierOfModel(name) {
  if (!name) return void 0;
  const known = findModel(name);
  if (known) return known.tier;
  const n = name.toLowerCase();
  if (/haiku|luna|mini|nano|flash/.test(n)) return 0;
  if (/sonnet|\bsol\b|-sol|medium/.test(n)) return 1;
  if (/opus|fable|mythos|astra|opusplan/.test(n)) return 2;
  return void 0;
}
function modelForTier(host, tier, overrides) {
  const id = overrides?.[host]?.[tier] ?? DEFAULT_TIER_MODELS[host][tier];
  return findModel(id) ?? { ...findModel(DEFAULT_TIER_MODELS[host][tier]), id };
}
function costOf(model, u) {
  return (u.input * model.input + u.output * model.output + u.cacheRead * model.cacheRead + u.cacheWrite * model.cacheWrite) / 1e6;
}

// src/core/router.ts
import fs5 from "node:fs";
import os2 from "node:os";
import path5 from "node:path";

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
import fs3 from "node:fs";
import path3 from "node:path";
var sessionsDir = () => path3.join(jevHome(), "sessions");
var globalFile = () => path3.join(jevHome(), "state.json");
function safeId(id) {
  return id.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 128) || "default";
}
function loadSession(sessionId) {
  return readJson(path3.join(sessionsDir(), `${safeId(sessionId)}.json`), {
    sessionId,
    updatedAt: 0
  });
}
function saveSession(state) {
  state.updatedAt = Date.now();
  writeJsonAtomic(path3.join(sessionsDir(), `${safeId(state.sessionId)}.json`), state);
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
function pruneSessions(maxAgeDays = 14) {
  const cutoff = Date.now() - maxAgeDays * 864e5;
  try {
    for (const f of fs3.readdirSync(sessionsDir())) {
      const p = path3.join(sessionsDir(), f);
      if (fs3.statSync(p).mtimeMs < cutoff) fs3.unlinkSync(p);
    }
  } catch {
  }
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

// src/core/signals.ts
function parseInlineOverride(prompt) {
  const m = prompt.match(/^\s*!(deep|quick|nojev)\b\s*/i);
  if (!m) return { prompt };
  const kind = m[1].toLowerCase();
  const rest = prompt.slice(m[0].length);
  if (kind === "nojev") return { prompt: rest, bypass: true };
  return {
    prompt: rest,
    forced: kind === "deep" ? { tier: 2, reason: "!deep override", kind } : { tier: 0, reason: "!quick override", kind }
  };
}
var COMPLAINT = /\b(that'?s (wrong|not right|incorrect)|wrong|doesn'?t work|didn'?t work|not working|still (broken|failing|fails|wrong)|you broke|try again|that'?s not what i|no,? (that|this)|incorrect|regress(ed|ion)|made it worse|undo)\b/i;
function isComplaint(prompt) {
  return COMPLAINT.test(prompt.slice(0, 400));
}
function isRetry(prompt, lastPrompt) {
  if (!lastPrompt) return false;
  const norm = (s) => s.toLowerCase().replace(/\s+/g, " ").trim();
  return norm(prompt).length > 10 && norm(prompt) === norm(lastPrompt);
}
var CALIBRATION_STEP_UP = 0.07;
var CALIBRATION_STEP_DOWN = 0.01;
var CALIBRATION_MAX = 0.25;
var CALIBRATION_MIN = -0.1;
function adjustCalibration(g, repo, taskType, direction) {
  const repoCal = g.calibration[repo] ??= {};
  const cur = repoCal[taskType] ?? 0;
  const next = direction === "up" ? Math.min(CALIBRATION_MAX, cur + CALIBRATION_STEP_UP) : Math.max(CALIBRATION_MIN, cur - CALIBRATION_STEP_DOWN);
  repoCal[taskType] = Math.round(next * 1e3) / 1e3;
  return repoCal[taskType];
}
function wasCheapRoute(d) {
  return Boolean(d && (d.action === "delegate_down" || d.action === "brief"));
}

// src/core/transcript.ts
import fs4 from "node:fs";
import path4 from "node:path";
function readTail(file, maxBytes = 256 * 1024) {
  if (!file) return {};
  let buf;
  try {
    const fd = fs4.openSync(file, "r");
    try {
      const size = fs4.fstatSync(fd).size;
      const len = Math.min(size, maxBytes);
      const b = Buffer.alloc(len);
      fs4.readSync(fd, b, 0, len, size - len);
      buf = b.toString("utf8");
    } finally {
      fs4.closeSync(fd);
    }
  } catch {
    return {};
  }
  const lines = buf.split("\n");
  const out = {};
  for (let i = lines.length - 1; i >= 0 && (!out.lastAssistantText || !out.lastAssistantModel); i--) {
    const e = parse(lines[i]);
    if (!e || e.type !== "assistant" || e.isSidechain) continue;
    const model = e.message?.model;
    if (!out.lastAssistantModel && model && model !== "<synthetic>") out.lastAssistantModel = model;
    if (!out.lastAssistantText) {
      const text = textOf(e.message?.content);
      if (text) out.lastAssistantText = text;
    }
  }
  return out;
}
function usageSince(file, offsets = {}) {
  const files = [file, ...subagentFiles(file)];
  const byModel = {};
  const seen = /* @__PURE__ */ new Set();
  const nextOffsets = { ...offsets };
  for (const f of files) {
    let size;
    try {
      size = fs4.statSync(f).size;
    } catch {
      continue;
    }
    const start = offsets[f] ?? 0;
    if (size <= start) continue;
    const fd = fs4.openSync(f, "r");
    let chunk;
    try {
      const b = Buffer.alloc(size - start);
      fs4.readSync(fd, b, 0, b.length, start);
      chunk = b.toString("utf8");
    } finally {
      fs4.closeSync(fd);
    }
    const lastNl = chunk.lastIndexOf("\n");
    if (lastNl < 0) continue;
    nextOffsets[f] = start + Buffer.byteLength(chunk.slice(0, lastNl + 1));
    for (const line of chunk.slice(0, lastNl).split("\n")) {
      const e = parse(line);
      const u = e?.message?.usage;
      const model = e?.message?.model;
      if (!e || e.type !== "assistant" || !u || !model || model === "<synthetic>") continue;
      const id = e.message?.id;
      if (id) {
        if (seen.has(id)) continue;
        seen.add(id);
      }
      const acc = byModel[model] ??= { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
      acc.input += u.input_tokens ?? 0;
      acc.output += u.output_tokens ?? 0;
      acc.cacheRead += u.cache_read_input_tokens ?? 0;
      acc.cacheWrite += u.cache_creation_input_tokens ?? 0;
    }
  }
  return { byModel, offsets: nextOffsets };
}
function subagentFiles(file) {
  const dir = path4.join(path4.dirname(file), path4.basename(file, ".jsonl"), "subagents");
  try {
    return fs4.readdirSync(dir).filter((f) => f.endsWith(".jsonl")).map((f) => path4.join(dir, f));
  } catch {
    return [];
  }
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

// src/core/router.ts
async function route(req, cfg, fetchImpl) {
  const session = loadSession(req.sessionId);
  const global = loadGlobal();
  const repo = repoRoot(req.cwd);
  const tail = readTail(req.transcriptPath);
  const mainModel = req.model ?? tail.lastAssistantModel ?? session.mainModel ?? (req.host === "claude" ? claudeSettingsModel(req.cwd) : void 0);
  const mainTier = cfg.mainTier[req.host] ?? tierOfModel(mainModel);
  if (mainModel && mainModel !== session.mainModel) session.mainModel = mainModel;
  const inline = parseInlineOverride(req.prompt);
  let forced = inline.forced;
  let globalDirty = false;
  if (!forced && global.pendingOverride && Date.now() - global.pendingOverride.at < 36e5) {
    forced = { tier: global.pendingOverride.tier, reason: global.pendingOverride.reason, kind: "escalate" };
  }
  if (global.pendingOverride) {
    delete global.pendingOverride;
    globalDirty = true;
  }
  const prev = session.lastDecision;
  const complaint = isComplaint(inline.prompt) || isRetry(inline.prompt, session.lastPrompt);
  if (prev && !inline.bypass && cfg.stage > 0) {
    const effectiveMain = mainTier ?? prev.mainTier;
    if (complaint && wasCheapRoute(prev)) {
      adjustCalibration(global, repo, prev.taskType, "up");
      globalDirty = true;
      appendLedger({ kind: "signal", at: Date.now(), sessionId: req.sessionId, repo, signal: "complaint", taskType: prev.taskType });
      forced ??= { tier: effectiveMain, reason: "previous cheap route got pushback \u2192 back to main model", kind: "escalate" };
    } else if (complaint && prev.tier === effectiveMain && effectiveMain < 2) {
      appendLedger({ kind: "signal", at: Date.now(), sessionId: req.sessionId, repo, signal: "complaint", taskType: prev.taskType });
      forced ??= { tier: effectiveMain + 1, reason: "pushback on main model \u2192 escalate one tier", kind: "escalate" };
    } else if (!complaint && wasCheapRoute(prev)) {
      adjustCalibration(global, repo, prev.taskType, "down");
      globalDirty = true;
      appendLedger({ kind: "signal", at: Date.now(), sessionId: req.sessionId, repo, signal: "success", taskType: prev.taskType });
    }
  }
  let classification;
  let classifyError;
  if (!inline.bypass && !forced) {
    const r = await classify(
      { prompt: inline.prompt, previousAssistant: tail.lastAssistantText, project: repo ? path5.basename(repo) : void 0 },
      cfg,
      fetchImpl
    );
    classification = r.classification;
    classifyError = r.error;
  }
  const decision = decide({
    stage: cfg.stage,
    mainTier,
    classification,
    classifyError,
    taskTier: session.taskTier,
    calibrationOffset: classification ? global.calibration[repo]?.[topTaskType(classification)] : void 0,
    forcedTier: forced,
    bypass: inline.bypass
  });
  if (globalDirty) saveGlobal(global);
  session.lastDecision = decision;
  session.lastPrompt = inline.prompt.slice(0, 2e3);
  session.taskTier = decision.tier;
  saveSession(session);
  appendLedger({
    kind: "decision",
    at: Date.now(),
    host: req.host,
    sessionId: req.sessionId,
    repo,
    decision,
    classifier: classification?.source ?? "none",
    latencyMs: classification?.latencyMs ?? 0,
    jevInputTokens: classification?.inputTokens,
    jevCostUsd: classification?.costUsd,
    jevProvider: classification?.source === "jev" ? cfg.jevProvider : void 0
  });
  return { decision, context: instructionFor(decision, req.host, cfg), notice: cfg.notify ? noticeFor(decision, req.host, cfg) : void 0 };
}
var COMPLEXITY_WORD = ["trivial", "simple", "moderate", "complex", "expert-level"];
function instructionFor(d, host, cfg) {
  const agent = ROUTE_AGENTS[d.tier];
  const hardness = COMPLEXITY_WORD[Math.min(4, d.tier * 2)] ?? "moderate";
  switch (d.action) {
    case "stay":
      return void 0;
    case "brief":
      return `<jev-route action="brief">Simple question. Answer directly and concisely: a few sentences or a short snippet, no preamble, no recap.</jev-route>`;
    case "delegate_down":
    case "escalate": {
      if (host === "codex" && !cfg.codexRoles) return void 0;
      const how = host === "claude" ? `use the Agent tool with subagent_type "jev:${agent}"` : `spawn a sub-agent with agent_type "${agent}" (the user has explicitly enabled this delegation)`;
      const why = d.action === "delegate_down" ? `This request looks ${hardness} (${d.taskType.replace("_", " ")}), so it can run on a cheaper model.` : `This request needs stronger reasoning than the current model (${d.taskType.replace("_", " ")}).`;
      const brief = d.action === "delegate_down" ? "Relay its result to the user in 1-3 sentences." : "Review its result, then report to the user.";
      const strict = d.stage === 3 || d.override === "quick" || d.override === "deep";
      const exception = strict ? "Do not do the work yourself; only take over if the sub-agent fails." : "Handle it yourself only if it is a single quick command, depends on conversation context that can't fit in a brief, or the sub-agent fails.";
      return `<jev-route action="${d.action}" agent="${agent}">
${why} To save cost, ${how}. Give it a self-contained brief: the goal, relevant files/paths, constraints, and how to verify. ${brief} ${exception}
</jev-route>`;
    }
  }
}
function noticeFor(d, host, cfg) {
  if (d.action === "stay" && !d.override) return void 0;
  const model = host === "claude" ? CLAUDE_ALIASES[d.tier] : modelForTier(host, d.tier, cfg.tierModels).id;
  const stage = d.stage === 0 ? STAGE_NAMES[0] : STAGES[d.stage].name;
  const label = d.action === "delegate_down" ? `\u2192 ${model}` : d.action === "escalate" ? `\u2191 ${model}` : d.action === "brief" ? "brief answer" : `stay (${model})`;
  const codexHint = host === "codex" && !cfg.codexRoles && d.action !== "brief" ? ` (run \`jev setup codex\` to enable delegation, or /model ${model})` : "";
  return `jev \u25B8 ${label} \xB7 ${d.taskType.replace("_", " ")} \xB7 ${stage}${d.override ? ` \xB7 ${d.override}` : ""}${codexHint}`;
}
function claudeSettingsModel(cwd) {
  const files = [
    ...cwd ? [path5.join(cwd, ".claude", "settings.local.json"), path5.join(cwd, ".claude", "settings.json")] : [],
    path5.join(os2.homedir(), ".claude", "settings.json")
  ];
  if (process.env.ANTHROPIC_MODEL) return process.env.ANTHROPIC_MODEL;
  for (const f of files) {
    try {
      const m = JSON.parse(fs5.readFileSync(f, "utf8")).model;
      if (typeof m === "string" && m) return m;
    } catch {
    }
  }
  return void 0;
}
function repoRoot(cwd) {
  if (!cwd) return "unknown";
  let dir = cwd;
  for (let i = 0; i < 40; i++) {
    if (fs5.existsSync(path5.join(dir, ".git"))) return dir;
    const parent = path5.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return cwd;
}

// src/hooks/main.ts
async function readStdin() {
  const chunks = [];
  for await (const c of process.stdin) chunks.push(c);
  return Buffer.concat(chunks).toString("utf8");
}
function emit(obj) {
  process.stdout.write(JSON.stringify(obj));
}
async function runRoute(input, host) {
  const cfg = loadConfig();
  if (!input.prompt) return {};
  const result = await route(
    {
      host,
      sessionId: input.session_id ?? "default",
      prompt: input.prompt,
      cwd: input.cwd,
      transcriptPath: input.transcript_path,
      model: input.model
    },
    cfg
  );
  const out = {};
  if (result.context) {
    out.hookSpecificOutput = { hookEventName: "UserPromptSubmit", additionalContext: result.context };
  }
  if (result.notice) out.systemMessage = result.notice;
  return out;
}
function runAgentGuard(input) {
  const cfg = loadConfig();
  const ti = input.tool_input;
  if (cfg.stage < 2 || !ti || ti.model) return {};
  const subagent = String(ti.subagent_type ?? "general-purpose");
  if (subagent.startsWith("jev:")) return {};
  const last = loadSession(input.session_id ?? "default").lastDecision;
  const taskTier = last?.tier ?? 2;
  if (taskTier === 2) return {};
  const searchOnly = /^(explore|search|claude-code-guide)$/i.test(subagent);
  const tier = cfg.stage === 3 ? searchOnly ? 0 : taskTier : searchOnly ? 1 : Math.max(1, taskTier);
  return {
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "allow",
      permissionDecisionReason: `jev: pinned ${subagent} subagent to ${CLAUDE_ALIASES[tier]}`,
      updatedInput: { ...ti, model: CLAUDE_ALIASES[tier] }
    }
  };
}
function runStop(input, host) {
  if (host !== "claude" || !input.transcript_path || !input.session_id) return {};
  const session = loadSession(input.session_id);
  const { byModel, offsets } = usageSince(input.transcript_path, session.transcriptOffsets);
  session.transcriptOffsets = offsets;
  const mainModelId = readTail(input.transcript_path).lastAssistantModel ?? session.mainModel;
  session.mainModel = mainModelId;
  saveSession(session);
  const main2 = findModel(mainModelId);
  let actualUsd = 0;
  let baselineUsd = 0;
  for (const [model, usage] of Object.entries(byModel)) {
    const info = findModel(model);
    if (!info) continue;
    actualUsd += costOf(info, usage);
    baselineUsd += costOf(main2 ?? info, usage);
  }
  if (actualUsd > 0) {
    appendLedger({ kind: "usage", at: Date.now(), host, sessionId: input.session_id, actualUsd, baselineUsd, byModel });
  }
  if (Math.random() < 0.02) pruneSessions();
  return {};
}
async function main() {
  const [cmd = "route", ...rest] = process.argv.slice(2);
  const hostIdx = rest.indexOf("--host");
  const host = hostIdx >= 0 && rest[hostIdx + 1] === "codex" ? "codex" : "claude";
  let out = {};
  try {
    const raw = await readStdin();
    const input = raw.trim() ? JSON.parse(raw) : {};
    if (cmd === "route") out = await runRoute(input, host);
    else if (cmd === "agent-guard") out = runAgentGuard(input);
    else if (cmd === "stop") out = runStop(input, host);
  } catch (err) {
    if (process.env.JEVCODE_DEBUG) process.stderr.write(`jev hook error: ${err.stack}
`);
  }
  emit(out);
}
if (process.env.VITEST === void 0) void main();
export {
  runAgentGuard,
  runRoute,
  runStop
};
