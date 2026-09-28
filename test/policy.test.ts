import { describe, expect, it } from "vitest";
import { decide, sufficiency } from "../src/core/policy.js";
import type { Stage } from "../src/core/types.js";
import { cls } from "./helpers.js";

const trivialChore = cls({ level: 0, task: "chore" });
const simpleEdit = cls({ level: 1, task: "small_edit" });
const moderateFeature = cls({ level: 2, task: "feature", reasoning: 0.4 });
const complexDebug = cls({ level: 3, task: "debug", reasoning: 0.9 });
const expertArch = cls({ level: 4, task: "architecture", reasoning: 0.95 });

describe("sufficiency", () => {
  it("is monotonic across tiers and near 1 for the top tier", () => {
    for (const c of [trivialChore, moderateFeature, expertArch]) {
      const s = sufficiency(c);
      expect(s[0]).toBeLessThanOrEqual(s[1]);
      expect(s[1]).toBeLessThanOrEqual(s[2]);
      expect(s[2]).toBeGreaterThan(0.99);
    }
  });

  it("penalizes the cheap tier for reasoning and cross-cutting scope", () => {
    const plain = sufficiency(cls({ level: 1, reasoning: 0 }))[0];
    expect(sufficiency(cls({ level: 1, reasoning: 0.9 }))[0]).toBeLessThan(plain);
    expect(sufficiency(cls({ level: 1, reasoning: 0, crossCutting: 0.9 }))[0]).toBeLessThan(plain);
  });
});

describe("stages progressively route more work to cheaper tiers", () => {
  const run = (stage: Stage, c = moderateFeature, mainTier: 0 | 1 | 2 = 2) => decide({ stage, mainTier, classification: c });

  it("trivial chores go to the cheapest tier in every stage", () => {
    for (const stage of [1, 2, 3] as Stage[]) {
      const d = run(stage, trivialChore);
      expect(d.action).toBe("delegate_down");
      expect(d.tier).toBe(0);
    }
  });

  it("moderate features: Balanced stays on Opus, Saver delegates to Sonnet", () => {
    expect(run(1).action).toBe("stay");
    expect(run(2)).toMatchObject({ action: "delegate_down", tier: 1 });
  });

  it("Max Saver with a Sonnet main escalates only expert work", () => {
    expect(run(3, moderateFeature, 1)).toMatchObject({ action: "stay", tier: 1 });
    expect(run(3, simpleEdit, 1)).toMatchObject({ action: "delegate_down", tier: 0 });
    expect(run(3, expertArch, 1)).toMatchObject({ action: "escalate", tier: 2 });
  });

  it("complex debugging never drops below Sonnet, and stays on Opus in Balanced", () => {
    expect(run(1, complexDebug).tier).toBe(2);
    expect(run(2, complexDebug).tier).toBeGreaterThanOrEqual(1);
    expect(run(3, complexDebug, 1).tier).toBeGreaterThanOrEqual(1);
  });

  it("cumulative tier across a mixed workload decreases with each stage", () => {
    const workload = [trivialChore, simpleEdit, moderateFeature, complexDebug, expertArch, simpleEdit, moderateFeature];
    const total = (stage: Stage) => workload.reduce((sum, c) => sum + run(stage, c).tier, 0);
    expect(total(1)).toBeGreaterThan(total(2));
    expect(total(2)).toBeGreaterThanOrEqual(total(3));
  });
});

describe("guardrails", () => {
  it("risky prompts keep the top tier in Stages 1-2 and at least Sonnet in Stage 3", () => {
    const risky = cls({ level: 1, task: "small_edit", risk: 0.65 });
    expect(decide({ stage: 1, mainTier: 2, classification: risky }).tier).toBe(2);
    expect(decide({ stage: 2, mainTier: 2, classification: risky }).tier).toBe(2);
    expect(decide({ stage: 3, mainTier: 2, classification: risky }).tier).toBe(1);
  });

  it("high-stakes prompts (prod data, migrations) get the top tier even in Max Saver", () => {
    const severe = cls({ level: 1, task: "chore", risk: 0.9 });
    expect(decide({ stage: 3, mainTier: 1, classification: severe })).toMatchObject({ action: "escalate", tier: 2 });
  });

  it("low classifier confidence never downgrades in Stages 1-2, at most one tier in Stage 3", () => {
    const unsure = cls({ level: 0, task: "chore", confidence: 0.3 });
    expect(decide({ stage: 2, mainTier: 2, classification: unsure }).action).toBe("stay");
    expect(decide({ stage: 3, mainTier: 2, classification: unsure }).tier).toBe(1);
  });

  it("doesn't downgrade mid-task when the prompt continues the current task", () => {
    const followUp = cls({ level: 0, task: "small_edit", continuation: 0.9 });
    const d = decide({ stage: 2, mainTier: 2, classification: followUp, taskTier: 2 });
    expect(d.tier).toBe(2);
    expect(d.reasons.join(" ")).toMatch(/continuing current task/);
  });

  it("positive calibration offset makes routing more cautious", () => {
    const edge = cls({ level: 1, task: "small_edit", reasoning: 0.4 });
    const loose = decide({ stage: 2, mainTier: 2, classification: edge });
    const strict = decide({ stage: 2, mainTier: 2, classification: edge, calibrationOffset: 0.2 });
    expect(strict.tier).toBeGreaterThan(loose.tier);
  });

  it("Balanced only delegates to the cheapest tier, never to the mid tier", () => {
    const d = decide({ stage: 1, mainTier: 2, classification: cls({ level: 2, reasoning: 0.1 }) });
    expect(d.action === "stay" || d.tier === 0).toBe(true);
  });
});

describe("actions", () => {
  it("simple Q&A answers on main instead of paying for a subagent hop", () => {
    const qa = cls({ level: 0, task: "explain", reasoning: 0.1 });
    expect(decide({ stage: 1, mainTier: 2, classification: qa }).action).toBe("stay");
    expect(decide({ stage: 2, mainTier: 2, classification: qa }).action).toBe("brief");
    expect(decide({ stage: 3, mainTier: 1, classification: qa }).action).toBe("brief");
  });

  it("fails open to the main model without a classification", () => {
    const d = decide({ stage: 3, mainTier: 2, classifyError: "Jev timed out" });
    expect(d).toMatchObject({ action: "stay", tier: 2 });
    expect(d.reasons[0]).toMatch(/fail-open: Jev timed out/);
  });

  it("stage 0 observes but never routes", () => {
    const d = decide({ stage: 0, mainTier: 2, classification: trivialChore });
    expect(d.action).toBe("stay");
    expect(d.assessedTier).toBe(0);
    expect(d.reasons.at(-1)).toMatch(/observe-only: would have chosen delegate_down T0/);
  });

  it("forced tier and bypass win over classification", () => {
    expect(
      decide({ stage: 2, mainTier: 1, classification: trivialChore, forcedTier: { tier: 2, reason: "!deep", kind: "deep" } }),
    ).toMatchObject({ action: "escalate", tier: 2, override: "deep" });
    expect(decide({ stage: 3, mainTier: 2, classification: trivialChore, bypass: true })).toMatchObject({
      action: "stay",
      override: "nojev",
    });
  });
});
