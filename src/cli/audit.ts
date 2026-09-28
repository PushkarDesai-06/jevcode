import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { classify } from "../core/classify.js";
import type { JevConfig } from "../core/config.js";
import { classifyHeuristic } from "../core/heuristic.js";
import { costOf, findModel, modelForTier, type Usage } from "../core/models.js";
import { decide } from "../core/policy.js";
import { readTurns, type TranscriptTurn } from "../core/transcript.js";
import type { Classification, Stage, Tier } from "../core/types.js";

// `jev audit`: replay past Claude Code sessions through the router and estimate what
// each stage would have saved. The growth wedge: users see their own number before
// they install anything.
//
// Cost model for a re-routed turn (stated in the report so the numbers are honest):
//   delegate_down → the turn's tokens priced on the cheaper model × DELEGATION_OVERHEAD,
//                   plus the sub-agent's fixed start-up cost (its own system prompt and
//                   tools, written to cache: ~$0.035 on Haiku in live testing), plus the
//                   main model reading the brief and relaying the result.
//   escalate      → the turn's tokens priced on the stronger model, plus the relay.
//   brief         → output tokens × BRIEF_OUTPUT_FACTOR on the main model.
export const DELEGATION_OVERHEAD = 1.2;
export const BRIEF_OUTPUT_FACTOR = 0.6;
const RELAY: Usage = { input: 0, output: 400, cacheRead: 4000, cacheWrite: 1500 };
const SUBAGENT_STARTUP: Usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 25_000 };

export interface AuditOptions {
  days: number;
  offline: boolean;
  limit: number;
  projectsDir?: string;
}

export interface AuditReport {
  sessions: number;
  turns: number;
  classified: number;
  classifier: "jev" | "heuristic";
  baselineUsd: number;
  stages: Record<1 | 2 | 3, { usd: number; saved: number; savedPct: number; delegated: number; escalated: number; brief: number }>;
  unknownModels: string[];
}

export function findTranscripts(dir: string, sinceMs: number): string[] {
  const out: string[] = [];
  let projects: string[] = [];
  try {
    projects = fs.readdirSync(dir);
  } catch {
    return out;
  }
  for (const p of projects) {
    const pdir = path.join(dir, p);
    let files: string[] = [];
    try {
      files = fs.readdirSync(pdir);
    } catch {
      continue;
    }
    for (const f of files) {
      if (!f.endsWith(".jsonl")) continue;
      const full = path.join(pdir, f);
      try {
        if (fs.statSync(full).mtimeMs >= sinceMs) out.push(full);
      } catch {
        // Skip unreadable file.
      }
    }
  }
  return out;
}

export async function runAudit(opts: AuditOptions, cfg: JevConfig, onProgress?: (done: number, total: number) => void): Promise<AuditReport> {
  const dir = opts.projectsDir ?? path.join(os.homedir(), ".claude", "projects");
  const files = findTranscripts(dir, Date.now() - opts.days * 86_400_000);
  const allTurns: TranscriptTurn[] = files.flatMap((f) => readTurns(f));
  const turns = allTurns.filter((t) => findModel(t.model));
  const unknown = new Set(
    allTurns.map((t) => t.model).filter((m): m is string => Boolean(m) && m !== "<synthetic>" && !findModel(m)),
  );
  const sample = turns.length > opts.limit ? evenSample(turns, opts.limit) : turns;
  const useJev = !opts.offline && cfg.classifier === "jev" && Boolean(cfg.jevApiKey);

  const classes: (Classification | undefined)[] = new Array(sample.length);
  let done = 0;
  const concurrency = useJev ? 4 : 1;
  let next = 0;
  await Promise.all(
    Array.from({ length: concurrency }, async () => {
      while (next < sample.length) {
        const i = next++;
        const t = sample[i]!;
        classes[i] = useJev
          ? (await classify({ prompt: t.prompt, previousAssistant: t.previousAssistant }, { ...cfg, jevTimeoutMs: 8000 })).classification
          : classifyHeuristic(t.prompt, Boolean(t.previousAssistant));
        onProgress?.(++done, sample.length);
      }
    }),
  );

  // Scale sampled costs back up to the full turn count.
  const scale = turns.length / Math.max(1, sample.length);
  const report: AuditReport = {
    sessions: files.length,
    turns: turns.length,
    classified: classes.filter(Boolean).length,
    classifier: useJev ? "jev" : "heuristic",
    baselineUsd: 0,
    stages: {
      1: { usd: 0, saved: 0, savedPct: 0, delegated: 0, escalated: 0, brief: 0 },
      2: { usd: 0, saved: 0, savedPct: 0, delegated: 0, escalated: 0, brief: 0 },
      3: { usd: 0, saved: 0, savedPct: 0, delegated: 0, escalated: 0, brief: 0 },
    },
    unknownModels: [...unknown],
  };

  sample.forEach((t, i) => {
    const main = findModel(t.model)!;
    const baseline = costOf(main, t.usage);
    report.baselineUsd += baseline * scale;
    for (const stage of [1, 2, 3] as Stage[]) {
      const s = report.stages[stage as 1 | 2 | 3];
      // Max Saver's strategy is a mid-tier main session that escalates hard work, so
      // simulate that instead of the model the session actually ran on.
      const simMain = stage === 3 && main.tier > 1 ? modelForTier("claude", 1, cfg.tierModels) : main;
      const d = decide({ stage, mainTier: simMain.tier, classification: classes[i] });
      const onMain = costOf(simMain, t.usage);
      let cost = onMain;
      if (d.action === "delegate_down" || d.action === "escalate") {
        const target = modelForTier("claude", d.tier as Tier, cfg.tierModels);
        cost = costOf(target, t.usage) * DELEGATION_OVERHEAD + costOf(target, SUBAGENT_STARTUP) + costOf(simMain, RELAY);
        if (d.action === "delegate_down") s.delegated++;
        else s.escalated++;
      } else if (d.action === "brief") {
        cost = onMain - (t.usage.output * (1 - BRIEF_OUTPUT_FACTOR) * simMain.output) / 1e6;
        s.brief++;
      }
      s.usd += cost * scale;
    }
  });
  for (const k of [1, 2, 3] as const) {
    const s = report.stages[k];
    s.saved = report.baselineUsd - s.usd;
    s.savedPct = report.baselineUsd > 0 ? (s.saved / report.baselineUsd) * 100 : 0;
  }
  return report;
}

function evenSample<T>(xs: T[], n: number): T[] {
  const step = xs.length / n;
  return Array.from({ length: n }, (_, i) => xs[Math.floor(i * step)]!);
}
