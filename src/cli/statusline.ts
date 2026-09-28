import { loadConfig } from "../core/config.js";
import { readLedger, summarize } from "../core/ledger.js";
import { CLAUDE_ALIASES } from "../core/models.js";
import { STAGE_NAMES } from "../core/policy.js";
import { loadSession, saveSession } from "../core/state.js";
import { usd } from "./format.js";

/** Claude Code statusline segment: `jev Saver · → haiku · saved $1.23 today`. */
export function statusline(stdinJson: string): string {
  let sessionId: string | undefined;
  let modelId: string | undefined;
  try {
    const input = JSON.parse(stdinJson) as { session_id?: string; model?: { id?: string } };
    sessionId = input.session_id;
    modelId = input.model?.id;
  } catch {
    // Statusline input missing: show global numbers only.
  }
  // The statusline is the only place Claude Code tells us the live model (including after
  // /model), so record it for the router's main-tier detection.
  if (sessionId && modelId) {
    const s = loadSession(sessionId);
    if (s.mainModel !== modelId) {
      s.mainModel = modelId;
      saveSession(s);
    }
  }
  const cfg = loadConfig();
  const parts = [`jev ${cfg.stage === 0 ? "off" : STAGE_NAMES[cfg.stage]}`];
  const d = sessionId ? loadSession(sessionId).lastDecision : undefined;
  if (d) {
    if (d.action === "delegate_down") parts.push(`→ ${CLAUDE_ALIASES[d.tier]}`);
    else if (d.action === "escalate") parts.push(`↑ ${CLAUDE_ALIASES[d.tier]}`);
    else if (d.action === "brief") parts.push("brief");
    if (d.override === "escalate") parts.push("escalated");
  }
  const startOfDay = new Date();
  startOfDay.setHours(0, 0, 0, 0);
  const s = summarize(readLedger(startOfDay.getTime()));
  if (s.baselineUsd > 0) parts.push(`saved ${usd(s.savedUsd)} today`);
  if (cfg.classifier === "heuristic") parts.push("offline");
  return parts.join(" · ");
}
