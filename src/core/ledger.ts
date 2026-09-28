import fs from "node:fs";
import path from "node:path";
import { jevHome } from "./config.js";
import type { Decision, Host } from "./types.js";

/**
 * Append-only JSONL ledger. JSONL (not SQLite) keeps the hooks dependency-free and
 * working on any Node >= 18; volumes are a few hundred lines per day.
 */
export type LedgerEntry =
  | {
      kind: "decision";
      at: number;
      host: Host;
      sessionId: string;
      repo: string;
      decision: Decision;
      classifier: "jev" | "heuristic" | "none";
      latencyMs: number;
      jevInputTokens?: number;
      jevCostUsd?: number;
      jevProvider?: string;
    }
  | {
      kind: "usage";
      at: number;
      host: Host;
      sessionId: string;
      /** Actual spend for the turn, priced per model that ran. */
      actualUsd: number;
      /** Same tokens priced at the main model: what the turn would have cost without routing. */
      baselineUsd: number;
      byModel: Record<string, { input: number; output: number; cacheRead: number; cacheWrite: number }>;
    }
  | {
      kind: "signal";
      at: number;
      sessionId: string;
      repo: string;
      signal: "escalate" | "complaint" | "retry" | "success";
      taskType?: string;
    };

const ledgerFile = () => path.join(jevHome(), "ledger.jsonl");

export function appendLedger(entry: LedgerEntry): void {
  try {
    fs.mkdirSync(jevHome(), { recursive: true });
    fs.appendFileSync(ledgerFile(), JSON.stringify(entry) + "\n");
  } catch {
    // Accounting must never break a prompt.
  }
}

export function readLedger(sinceMs = 0): LedgerEntry[] {
  let raw = "";
  try {
    raw = fs.readFileSync(ledgerFile(), "utf8");
  } catch {
    return [];
  }
  const out: LedgerEntry[] = [];
  for (const line of raw.split("\n")) {
    if (!line) continue;
    try {
      const e = JSON.parse(line) as LedgerEntry;
      if (e.at >= sinceMs) out.push(e);
    } catch {
      // Skip a torn line from a concurrent append.
    }
  }
  return out;
}

export interface StatsSummary {
  prompts: number;
  routed: number;
  byAction: Record<string, number>;
  byTier: [number, number, number];
  actualUsd: number;
  baselineUsd: number;
  savedUsd: number;
  savedPct: number;
  escalations: number;
  jevFailures: number;
  /** What classification itself cost (OpenRouter reports it per call). */
  jevCostUsd: number;
}

export function summarize(entries: LedgerEntry[]): StatsSummary {
  const s: StatsSummary = {
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
    jevCostUsd: 0,
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
  // Net of classification cost, so the headline number is honest.
  s.savedUsd = s.baselineUsd - s.actualUsd - s.jevCostUsd;
  s.savedPct = s.baselineUsd > 0 ? (s.savedUsd / s.baselineUsd) * 100 : 0;
  return s;
}
