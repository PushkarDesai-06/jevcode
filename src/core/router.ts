import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { classify } from "./classify.js";
import type { JevConfig } from "./config.js";
import { appendLedger } from "./ledger.js";
import { CLAUDE_ALIASES, modelForTier, ROUTE_AGENTS, tierOfModel } from "./models.js";
import { decide, STAGE_NAMES, STAGES, topTaskType } from "./policy.js";
import { adjustCalibration, isComplaint, isRetry, parseInlineOverride, wasCheapRoute } from "./signals.js";
import { loadGlobal, loadSession, saveGlobal, saveSession } from "./state.js";
import { readTail } from "./transcript.js";
import type { Decision, Host, Tier } from "./types.js";

export interface RouteRequest {
  host: Host;
  sessionId: string;
  prompt: string;
  cwd?: string;
  transcriptPath?: string;
  /** Active model slug if the host tells us (Codex does). */
  model?: string;
}

export interface RouteResult {
  decision: Decision;
  /** Instruction for the agent, injected as hook additionalContext. */
  context?: string;
  /** One-line notice shown to the user. */
  notice?: string;
}

export async function route(req: RouteRequest, cfg: JevConfig, fetchImpl?: typeof fetch): Promise<RouteResult> {
  const session = loadSession(req.sessionId);
  const global = loadGlobal();
  const repo = repoRoot(req.cwd);
  const tail = readTail(req.transcriptPath);

  // Claude Code sends no model in the hook payload, so fall back through the transcript,
  // what the statusline last saw, and the settings files. Codex sends `model` directly.
  const mainModel =
    req.model ?? tail.lastAssistantModel ?? session.mainModel ?? (req.host === "claude" ? claudeSettingsModel(req.cwd) : undefined);
  const mainTier: Tier | undefined = cfg.mainTier[req.host] ?? tierOfModel(mainModel);
  if (mainModel && mainModel !== session.mainModel) session.mainModel = mainModel;

  const inline = parseInlineOverride(req.prompt);
  let forced = inline.forced;
  let globalDirty = false;

  // One-shot override from `jev escalate`.
  if (!forced && global.pendingOverride && Date.now() - global.pendingOverride.at < 3_600_000) {
    forced = { tier: global.pendingOverride.tier, reason: global.pendingOverride.reason, kind: "escalate" };
  }
  if (global.pendingOverride) {
    delete global.pendingOverride;
    globalDirty = true;
  }

  // Feedback from the previous turn: a complaint or verbatim retry after a cheap route
  // means routing got it wrong. Pull this prompt back up and make the repo more cautious.
  const prev = session.lastDecision;
  const complaint = isComplaint(inline.prompt) || isRetry(inline.prompt, session.lastPrompt);
  if (prev && !inline.bypass && cfg.stage > 0) {
    const effectiveMain = mainTier ?? prev.mainTier;
    if (complaint && wasCheapRoute(prev)) {
      adjustCalibration(global, repo, prev.taskType, "up");
      globalDirty = true;
      appendLedger({ kind: "signal", at: Date.now(), sessionId: req.sessionId, repo, signal: "complaint", taskType: prev.taskType });
      forced ??= { tier: effectiveMain, reason: "previous cheap route got pushback → back to main model", kind: "escalate" };
    } else if (complaint && prev.tier === effectiveMain && effectiveMain < 2) {
      appendLedger({ kind: "signal", at: Date.now(), sessionId: req.sessionId, repo, signal: "complaint", taskType: prev.taskType });
      forced ??= { tier: (effectiveMain + 1) as Tier, reason: "pushback on main model → escalate one tier", kind: "escalate" };
    } else if (!complaint && wasCheapRoute(prev)) {
      adjustCalibration(global, repo, prev.taskType, "down");
      globalDirty = true;
      appendLedger({ kind: "signal", at: Date.now(), sessionId: req.sessionId, repo, signal: "success", taskType: prev.taskType });
    }
  }

  let classification;
  let classifyError: string | undefined;
  if (!inline.bypass && !forced) {
    const r = await classify(
      { prompt: inline.prompt, previousAssistant: tail.lastAssistantText, project: repo ? path.basename(repo) : undefined },
      cfg,
      fetchImpl,
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
    calibrationOffset: classification ? global.calibration[repo]?.[topTaskType(classification)] : undefined,
    forcedTier: forced,
    bypass: inline.bypass,
  });

  if (globalDirty) saveGlobal(global);
  session.lastDecision = decision;
  session.lastPrompt = inline.prompt.slice(0, 2000);
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
    jevProvider: classification?.source === "jev" ? cfg.jevProvider : undefined,
  });

  return { decision, context: instructionFor(decision, req.host, cfg), notice: cfg.notify ? noticeFor(decision, req.host, cfg) : undefined };
}

const COMPLEXITY_WORD = ["trivial", "simple", "moderate", "complex", "expert-level"];

export function instructionFor(d: Decision, host: Host, cfg: JevConfig): string | undefined {
  const agent = ROUTE_AGENTS[d.tier];
  const hardness = COMPLEXITY_WORD[Math.min(4, d.tier * 2)] ?? "moderate";
  switch (d.action) {
    case "stay":
      return undefined;
    case "brief":
      return `<jev-route action="brief">Simple question. Answer directly and concisely: a few sentences or a short snippet, no preamble, no recap.</jev-route>`;
    case "delegate_down":
    case "escalate": {
      if (host === "codex" && !cfg.codexRoles) return undefined;
      const how =
        host === "claude"
          ? `use the Agent tool with subagent_type "jev:${agent}"`
          : `spawn a sub-agent with agent_type "${agent}" (the user has explicitly enabled this delegation)`;
      const why =
        d.action === "delegate_down"
          ? `This request looks ${hardness} (${d.taskType.replace("_", " ")}), so it can run on a cheaper model.`
          : `This request needs stronger reasoning than the current model (${d.taskType.replace("_", " ")}).`;
      const brief =
        d.action === "delegate_down"
          ? "Relay its result to the user in 1-3 sentences."
          : "Review its result, then report to the user.";
      // Max Saver and explicit overrides are firm; lower stages leave room for the main
      // model to skip the hop when a single quick command is cheaper than a sub-agent.
      const strict = d.stage === 3 || d.override === "quick" || d.override === "deep";
      const exception = strict
        ? "Do not do the work yourself; only take over if the sub-agent fails."
        : "Handle it yourself only if it is a single quick command, depends on conversation context that can't fit in a brief, or the sub-agent fails.";
      return (
        `<jev-route action="${d.action}" agent="${agent}">\n` +
        `${why} To save cost, ${how}. Give it a self-contained brief: the goal, relevant files/paths, constraints, and how to verify. ${brief} ${exception}\n` +
        `</jev-route>`
      );
    }
  }
}

export function noticeFor(d: Decision, host: Host, cfg: JevConfig): string | undefined {
  if (d.action === "stay" && !d.override) return undefined;
  const model = host === "claude" ? CLAUDE_ALIASES[d.tier] : modelForTier(host, d.tier, cfg.tierModels).id;
  const stage = d.stage === 0 ? STAGE_NAMES[0] : STAGES[d.stage].name;
  const label =
    d.action === "delegate_down"
      ? `→ ${model}`
      : d.action === "escalate"
        ? `↑ ${model}`
        : d.action === "brief"
          ? "brief answer"
          : `stay (${model})`;
  const codexHint =
    host === "codex" && !cfg.codexRoles && d.action !== "brief" ? ` (run \`jev setup codex\` to enable delegation, or /model ${model})` : "";
  return `jev ▸ ${label} · ${d.taskType.replace("_", " ")} · ${stage}${d.override ? ` · ${d.override}` : ""}${codexHint}`;
}

/**
 * `model` from Claude Code settings, most specific first. Doesn't see a `--model` flag or
 * a mid-session `/model`; the transcript and statusline cover those after the first turn.
 */
export function claudeSettingsModel(cwd: string | undefined): string | undefined {
  const files = [
    ...(cwd ? [path.join(cwd, ".claude", "settings.local.json"), path.join(cwd, ".claude", "settings.json")] : []),
    path.join(os.homedir(), ".claude", "settings.json"),
  ];
  if (process.env.ANTHROPIC_MODEL) return process.env.ANTHROPIC_MODEL;
  for (const f of files) {
    try {
      const m = (JSON.parse(fs.readFileSync(f, "utf8")) as { model?: unknown }).model;
      if (typeof m === "string" && m) return m;
    } catch {
      // Missing or invalid settings file.
    }
  }
  return undefined;
}

/** Git root of cwd (walking up), else cwd. Used as the calibration key. */
export function repoRoot(cwd: string | undefined): string {
  if (!cwd) return "unknown";
  let dir = cwd;
  for (let i = 0; i < 40; i++) {
    if (fs.existsSync(path.join(dir, ".git"))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return cwd;
}
