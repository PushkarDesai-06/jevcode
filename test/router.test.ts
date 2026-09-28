import fs from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { DEFAULT_CONFIG, type JevConfig } from "../src/core/config.js";
import { readLedger } from "../src/core/ledger.js";
import { route } from "../src/core/router.js";
import { loadGlobal, loadSession, updateGlobal } from "../src/core/state.js";
import { jsonResponse, useTempHome } from "./helpers.js";

const home = useTempHome();
const cfg: JevConfig = { ...DEFAULT_CONFIG, classifier: "heuristic", jevApiKey: undefined, stage: 2 };

const jevAnswer = (level: number, task: string, extra: Record<string, number> = {}) =>
  jsonResponse({
    answers: {
      complexity: { probabilities: [0, 1, 2, 3, 4].map((i) => (i === level ? 0.92 : 0.02)), confidence: 0.9 },
      task_type: { probabilities: { [task]: 0.9, feature: 0.05, debug: 0.05 }, confidence: 0.9 },
      reasoning_required: { noul: extra.reasoning ?? (level >= 2 ? 0.7 : 0.05) },
      risk: { noul: extra.risk ?? 0 },
      continuation: { noul: extra.continuation ?? 0 },
      scope: { probabilities: [0.5, 0.4, 0.1, 0], confidence: 0.8 },
    },
  });
const jevCfg: JevConfig = { ...DEFAULT_CONFIG, classifier: "jev", jevApiKey: "sk-or-k", stage: 2 };

describe("route", () => {
  it("delegates a simple edit on an Opus session to jev-quick (Claude)", async () => {
    const r = await route({ host: "claude", sessionId: "s", prompt: "rename foo to bar", model: "claude-opus-5-5" }, jevCfg, vi.fn(async () => jevAnswer(0, "small_edit")));
    expect(r.decision).toMatchObject({ action: "delegate_down", tier: 0, mainTier: 2 });
    expect(r.context).toContain('subagent_type "jev:jev-quick"');
    expect(r.notice).toMatch(/jev ▸ → haiku · small edit · Saver/);
  });

  it("emits nothing when staying on the main model", async () => {
    const r = await route({ host: "claude", sessionId: "s", prompt: "design a sharded queue", model: "claude-opus-5-5" }, jevCfg, vi.fn(async () => jevAnswer(4, "architecture")));
    expect(r.decision.action).toBe("stay");
    expect(r.context).toBeUndefined();
    expect(r.notice).toBeUndefined();
  });

  it("detects the main model from the transcript tail", async () => {
    const t = path.join(home.dir(), "t.jsonl");
    fs.writeFileSync(t, JSON.stringify({ type: "assistant", message: { id: "m1", model: "claude-sonnet-5", content: [{ type: "text", text: "done" }] } }) + "\n");
    const r = await route({ host: "claude", sessionId: "s", prompt: "design it", transcriptPath: t }, { ...jevCfg, stage: 3 }, vi.fn(async () => jevAnswer(4, "architecture")));
    expect(r.decision).toMatchObject({ mainTier: 1, action: "escalate", tier: 2 });
    expect(r.context).toContain("jev:jev-deep");
  });

  it("Codex without roles gives a user hint but no agent instruction", async () => {
    const r = await route({ host: "codex", sessionId: "c", prompt: "run the tests", model: "gpt-6-astra" }, jevCfg, vi.fn(async () => jevAnswer(0, "chore")));
    expect(r.decision.action).toBe("delegate_down");
    expect(r.context).toBeUndefined();
    expect(r.notice).toMatch(/gpt-6-luna.*jev setup codex/);
    const withRoles = await route({ host: "codex", sessionId: "c2", prompt: "run the tests", model: "gpt-6-astra" }, { ...jevCfg, codexRoles: true }, vi.fn(async () => jevAnswer(0, "chore")));
    expect(withRoles.context).toContain('agent_type "jev-quick"');
  });

  it("!deep forces the top tier and skips classification", async () => {
    const fetchImpl = vi.fn();
    const r = await route({ host: "claude", sessionId: "s", prompt: "!deep fix the typo", model: "claude-sonnet-5" }, jevCfg, fetchImpl);
    expect(r.decision).toMatchObject({ action: "escalate", tier: 2, override: "deep" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("`jev escalate` applies to exactly one prompt", async () => {
    updateGlobal((g) => (g.pendingOverride = { tier: 2, reason: "jev escalate (deep)", at: Date.now() }));
    const first = await route({ host: "claude", sessionId: "s", prompt: "fix it", model: "claude-sonnet-5" }, cfg);
    expect(first.decision.override).toBe("escalate");
    const second = await route({ host: "claude", sessionId: "s", prompt: "now run the tests", model: "claude-sonnet-5" }, cfg);
    expect(second.decision.override).toBeUndefined();
  });

  it("pushback after a cheap route pulls the task back up and makes the repo more cautious", async () => {
    const cwd = home.dir();
    await route({ host: "claude", sessionId: "s", prompt: "rename foo to bar", cwd, model: "claude-opus-5-5" }, jevCfg, vi.fn(async () => jevAnswer(0, "small_edit")));
    const r = await route({ host: "claude", sessionId: "s", prompt: "that's wrong, it broke the build", cwd, model: "claude-opus-5-5" }, jevCfg, vi.fn());
    expect(r.decision).toMatchObject({ tier: 2, override: "escalate" });
    expect(loadGlobal().calibration[cwd]?.small_edit).toBeGreaterThan(0);
    expect(readLedger().some((e) => e.kind === "signal" && e.signal === "complaint")).toBe(true);
  });

  it("a clean follow-up after a cheap route relaxes calibration", async () => {
    const cwd = home.dir();
    updateGlobal((g) => (g.calibration[cwd] = { small_edit: 0.1 }));
    await route({ host: "claude", sessionId: "s", prompt: "rename foo to bar", cwd, model: "claude-opus-5-5" }, jevCfg, vi.fn(async () => jevAnswer(0, "small_edit")));
    await route({ host: "claude", sessionId: "s", prompt: "great, now add a docstring", cwd, model: "claude-opus-5-5" }, jevCfg, vi.fn(async () => jevAnswer(0, "small_edit")));
    expect(loadGlobal().calibration[cwd]?.small_edit).toBeCloseTo(0.09);
  });

  it("fails open when Jev is down and records the decision", async () => {
    const r = await route({ host: "claude", sessionId: "s", prompt: "rename foo", model: "claude-opus-5-5" }, jevCfg, vi.fn(async () => jsonResponse({}, 529)));
    expect(r.decision.action).toBe("stay");
    expect(r.decision.reasons[0]).toMatch(/fail-open/);
    const entry = readLedger().find((e) => e.kind === "decision");
    expect(entry && entry.kind === "decision" && entry.classifier).toBe("none");
    expect(loadSession("s").lastDecision?.action).toBe("stay");
  });

  it("!nojev bypasses routing", async () => {
    const r = await route({ host: "claude", sessionId: "s", prompt: "!nojev run tests", model: "claude-opus-5-5" }, cfg);
    expect(r.decision.override).toBe("nojev");
    expect(r.context).toBeUndefined();
  });
});
