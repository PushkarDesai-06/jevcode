import { describe, expect, it, vi } from "vitest";
import { classify } from "../src/core/classify.js";
import { DEFAULT_CONFIG, loadConfig, saveConfig } from "../src/core/config.js";
import { summarize } from "../src/core/ledger.js";
import { buildQuestions, classifyWithJev, normalizeJevResponse } from "../src/core/jev.js";
import { loadGlobal } from "../src/core/state.js";
import { jsonResponse, useTempHome } from "./helpers.js";

const okBody = {
  model: "jev-1.13.0",
  answers: {
    complexity: { type: "score", probabilities: [0.7, 0.2, 0.05, 0.03, 0.02], confidence: 0.9 },
    task_type: { type: "choice", probabilities: { small_edit: 0.8, feature: 0.1, debug: 0.1 }, confidence: 0.8 },
    reasoning_required: { type: "noul", noul: 0.1 },
    risk: { type: "noul", noul: 0.02 },
    continuation: { type: "noul", noul: 0.3 },
    scope: { type: "score", probabilities: { "0": 0.6, "1": 0.3, "2": 0.08, "3": 0.02 }, confidence: 0.7 },
  },
  usage: { input_tokens: 296, output_tokens: 20 },
};

const opts = { apiKey: "sk-or-k", apiBase: "https://openrouter.ai/api", model: "typesafe/jev-1.13", timeoutMs: 1500 };

describe("question schema", () => {
  it("respects Jev limits: 2-10 score levels, noul true/false criteria", () => {
    const q = buildQuestions() as Record<string, { type: string; criteria: unknown }>;
    for (const v of Object.values(q)) {
      if (v.type === "score") expect((v.criteria as string[]).length).toBeGreaterThanOrEqual(2);
      if (v.type === "score") expect((v.criteria as string[]).length).toBeLessThanOrEqual(10);
      if (v.type === "noul") expect(Object.keys(v.criteria as object).sort()).toEqual(["false", "true"]);
    }
  });
});

describe("normalizeJevResponse", () => {
  it("reads documented shapes", () => {
    const c = normalizeJevResponse(okBody, 130);
    expect(c.complexity[0]).toBeCloseTo(0.7);
    expect(c.complexityConfidence).toBe(0.9);
    expect(c.taskType.small_edit).toBeCloseTo(0.8);
    expect(c.risk).toBe(0.02);
    expect(c.scope[0]).toBeCloseTo(0.6);
    expect(c.inputTokens).toBe(296);
  });

  it("degrades gracefully on missing or unexpected answers", () => {
    const c = normalizeJevResponse({ answers: { complexity: { type: "score", score: 3, confidence: 0.8 }, task_type: { choice: "debug", confidence: 0.9 } } }, 1);
    expect(c.complexity.indexOf(Math.max(...c.complexity))).toBe(3);
    expect(c.taskType.debug).toBeCloseTo(0.9);
    expect(c.reasoning).toBe(0.5);
    const empty = normalizeJevResponse({}, 1);
    expect(empty.complexityConfidence).toBe(0);
    expect(empty.complexity.reduce((a, b) => a + b, 0)).toBeCloseTo(1);
  });
});

describe("classifyWithJev", () => {
  it("posts model, state and questions to OpenRouter's System One endpoint", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ ...okBody, id: "gen-1", provider: "TypeSafe", usage: { ...okBody.usage, cost: 0.0000124 } }));
    const c = await classifyWithJev({ prompt: "rename foo" }, { ...opts, fetchImpl });
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://openrouter.ai/api/v1/systemone");
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer sk-or-k");
    expect(init.redirect).toBe("error");
    expect(c.costUsd).toBeCloseTo(0.0000124);
    const body = JSON.parse(init.body as string);
    expect(body.model).toBe("typesafe/jev-1.13");
    expect(body.state.prompt).toBe("rename foo");
    expect(Object.keys(body.questions)).toContain("complexity");
  });

  it("retries once on 429, then succeeds", async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(jsonResponse({}, 429)).mockResolvedValueOnce(jsonResponse(okBody));
    const c = await classifyWithJev({ prompt: "x" }, { ...opts, fetchImpl });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(c.source).toBe("jev");
  });

  it("does not retry auth errors", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({}, 401));
    await expect(classifyWithJev({ prompt: "x" }, { ...opts, fetchImpl })).rejects.toMatchObject({ status: 401, retryable: false });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("times out", async () => {
    const fetchImpl = vi.fn(
      (_url: string, init?: RequestInit) =>
        new Promise<Response>((_, reject) => init?.signal?.addEventListener("abort", () => reject(new Error("aborted")))),
    );
    await expect(classifyWithJev({ prompt: "x" }, { ...opts, timeoutMs: 100, fetchImpl: fetchImpl as unknown as typeof fetch })).rejects.toThrow();
  });
});

describe("classify (fail-open + breaker)", () => {
  useTempHome();
  const cfg = { ...DEFAULT_CONFIG, jevApiKey: "sk-or-k", classifier: "jev" as const };

  it("uses the heuristic when no key is configured", async () => {
    const r = await classify({ prompt: "run the tests" }, { ...DEFAULT_CONFIG, jevApiKey: undefined });
    expect(r.classification?.source).toBe("heuristic");
  });

  it("redacts secrets before sending", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(okBody));
    const fakeKey = "sk-" + "ant-api03-" + "abcdefghijklmnopqrstuvwxyz0123"; // assembled so scanners don't flag it
    await classify({ prompt: `use key ${fakeKey} to call the api` }, cfg, fetchImpl);
    const body = JSON.parse((fetchImpl.mock.calls[0] as unknown as [string, RequestInit])[1].body as string);
    expect(body.state.prompt).not.toContain("sk-ant-api03");
    expect(body.state.prompt).toContain("[REDACTED_ANTHROPIC_KEY]");
  });

  it("returns an error (no classification) on outage and trips the breaker", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({}, 529));
    const r = await classify({ prompt: "x" }, cfg, fetchImpl);
    expect(r.classification).toBeUndefined();
    expect(loadGlobal().jevOpenUntil).toBeGreaterThan(Date.now());
    const calls = fetchImpl.mock.calls.length;
    const r2 = await classify({ prompt: "y" }, cfg, fetchImpl);
    expect(r2.error).toMatch(/circuit breaker/);
    expect(fetchImpl.mock.calls.length).toBe(calls);
  });

  it("doesn't trip the breaker on a bad key", async () => {
    const r = await classify({ prompt: "x" }, cfg, vi.fn(async () => jsonResponse({}, 401)));
    expect(r.error).toMatch(/401/);
    expect(loadGlobal().jevOpenUntil).toBeUndefined();
  });
});

describe("provider config", () => {
  useTempHome();

  it("defaults to OpenRouter with a pinned Jev model", () => {
    process.env.OPENROUTER_API_KEY = "sk-or-abc";
    const cfg = loadConfig();
    expect(cfg).toMatchObject({
      jevProvider: "openrouter",
      jevApiBase: "https://openrouter.ai/api",
      jevModel: "typesafe/jev-1.13",
      jevApiKey: "sk-or-abc",
      classifier: "jev",
    });
  });

  it("falls back to direct TypeSafe when only a TypeSafe key is set", () => {
    process.env.TYPESAFE_API_KEY = "ts-abc";
    expect(loadConfig()).toMatchObject({ jevProvider: "typesafe", jevApiBase: "https://api.typesafe.ai", jevModel: "jev-1.13" });
  });

  it("honors explicit provider and overrides, and goes offline with no key", () => {
    saveConfig({ jevProvider: "openrouter", jevModel: "typesafe/jev-latest" });
    process.env.TYPESAFE_API_KEY = "ts-abc"; // wrong provider's key is not used
    const cfg = loadConfig();
    expect(cfg.jevModel).toBe("typesafe/jev-latest");
    expect(cfg.jevApiKey).toBeUndefined();
    expect(cfg.classifier).toBe("heuristic");
  });
});

describe("stats", () => {
  it("reports savings net of Jev classification cost", () => {
    const d = { tier: 0, assessedTier: 0, mainTier: 2, action: "delegate_down", stage: 2, sufficiency: [1, 1, 1], threshold: 0.75, taskType: "chore", reasons: [] } as const;
    const s = summarize([
      { kind: "decision", at: 1, host: "claude", sessionId: "s", repo: "r", decision: { ...d, sufficiency: [1, 1, 1], reasons: [] }, classifier: "jev", latencyMs: 100, jevCostUsd: 0.01 },
      { kind: "usage", at: 2, host: "claude", sessionId: "s", actualUsd: 0.2, baselineUsd: 1, byModel: {} },
    ]);
    expect(s.jevCostUsd).toBe(0.01);
    expect(s.savedUsd).toBeCloseTo(0.79);
  });
});

describe("real OpenRouter response (captured 2026-09-28, typesafe/jev-1.13-20260917)", () => {
  const real = {
    model: "typesafe/jev-1.13-20260917",
    answers: {
      complexity: { type: "score", score: 2.59, legend: { "0": "Trivial", "1": "Simple", "2": "Moderate", "3": "Complex", "4": "Expert" }, probabilities: { "0": 0, "1": 0.01, "2": 0.39, "3": 0.6, "4": 0 }, confidence: 0.66 },
      task_type: { type: "choice", choice: "debug", probabilities: { lookup: 0, small_edit: 0, explain: 0, refactor: 0, chore: 0, architecture: 0, debug: 1, review: 0, feature: 0 }, confidence: 1 },
      reasoning_required: { type: "noul", noul: 0.97 },
      risk: { type: "noul", noul: 0.63 },
      continuation: { type: "noul", noul: 0.27 },
      scope: { type: "score", score: 1.92, legend: {}, probabilities: { "0": 0, "1": 0.09, "2": 0.9, "3": 0.01 }, confidence: 0.9 },
    },
    usage: { input_tokens: 933, output_tokens: 167, cost: 0.000039186 },
    id: "gen-dec-1790588894-WZuhujculjWXQ3VVe62G",
    provider: "TypeSafe",
  };

  it("parses every answer", () => {
    const c = normalizeJevResponse(real, 800);
    expect(c.complexity).toEqual([0, 0.01, 0.39, 0.6, 0].map((x) => x / 1));
    expect(c.complexityConfidence).toBe(0.66);
    expect(c.taskType.debug).toBe(1);
    expect(c.reasoning).toBe(0.97);
    expect(c.risk).toBe(0.63);
    expect(c.scope[2]).toBeCloseTo(0.9);
    expect(c.costUsd).toBeCloseTo(0.000039186);
  });
});
