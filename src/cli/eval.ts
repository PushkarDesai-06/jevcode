import fs from "node:fs";
import { classify } from "../core/classify.js";
import type { JevConfig } from "../core/config.js";
import { classifyHeuristic } from "../core/heuristic.js";
import { decide } from "../core/policy.js";
import type { Classification, Stage, Tier } from "../core/types.js";

// Labeled eval: each line is {"prompt": "...", "tier": 0|1|2, "note"?: "..."} where tier
// is the cheapest model tier a careful engineer would trust with the task. We report,
// per stage, how often routing matched the label and the under-routing rate (a task sent
// below its label), which is the number that has to stay low for users to trust Stage 3.

export interface EvalCase {
  prompt: string;
  tier: Tier;
  note?: string;
}

export interface StageScore {
  exact: number;
  under: number;
  over: number;
  underRate: number;
  accuracy: number;
  misses: { prompt: string; label: Tier; got: Tier }[];
}

export function loadCases(file: string): EvalCase[] {
  return fs
    .readFileSync(file, "utf8")
    .split("\n")
    .filter((l) => l.trim() && !l.trim().startsWith("//"))
    .map((l) => JSON.parse(l) as EvalCase);
}

export async function runEval(cases: EvalCase[], cfg: JevConfig, offline: boolean): Promise<Record<1 | 2 | 3, StageScore>> {
  const useJev = !offline && cfg.classifier === "jev" && Boolean(cfg.jevApiKey);
  const classes: (Classification | undefined)[] = [];
  for (const c of cases) {
    classes.push(
      useJev ? (await classify({ prompt: c.prompt }, { ...cfg, jevTimeoutMs: 8000 })).classification : classifyHeuristic(c.prompt),
    );
  }
  const out = {} as Record<1 | 2 | 3, StageScore>;
  for (const stage of [1, 2, 3] as const) {
    const s: StageScore = { exact: 0, under: 0, over: 0, underRate: 0, accuracy: 0, misses: [] };
    cases.forEach((c, i) => {
      // Score the difficulty assessment against a top-tier main session.
      const got = decide({ stage: stage as Stage, mainTier: 2, classification: classes[i] }).assessedTier;
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
