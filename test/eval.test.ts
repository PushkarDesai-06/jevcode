import path from "node:path";
import { describe, expect, it } from "vitest";
import { loadCases, runEval } from "../src/cli/eval.js";
import { DEFAULT_CONFIG } from "../src/core/config.js";

// Regression gate on the offline heuristic. Jev-backed numbers are gated in CI with a
// real key (`jev eval evals/labeled.jsonl --max-under 0.05`).
describe("labeled eval (offline heuristic)", () => {
  it("keeps under-routing low: Saver ≤ 5%, Max Saver ≤ 15%", async () => {
    const cases = loadCases(path.join(__dirname, "..", "evals", "labeled.jsonl"));
    const scores = await runEval(cases, { ...DEFAULT_CONFIG, classifier: "heuristic" }, true);
    expect(scores[1].underRate).toBe(0);
    expect(scores[2].underRate).toBeLessThanOrEqual(0.05);
    expect(scores[3].underRate).toBeLessThanOrEqual(0.15);
    // Each stage should route at least as much work down as the one before.
    expect(scores[2].accuracy).toBeGreaterThanOrEqual(scores[1].accuracy);
  });
});
