import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { saveConfig } from "../src/core/config.js";
import { readLedger } from "../src/core/ledger.js";
import { cacheSwitchCost, findModel, tierOfModel } from "../src/core/models.js";
import { clip, redact } from "../src/core/redact.js";
import { loadSession, saveSession } from "../src/core/state.js";
import { readTail, readTurns, usageSince } from "../src/core/transcript.js";
import { runAgentGuard, runStop } from "../src/hooks/main.js";
import { useTempHome } from "./helpers.js";

const home = useTempHome();

const assistant = (id: string, model: string, usage: Record<string, number>, text?: string, sidechain = false) =>
  JSON.stringify({
    type: "assistant",
    isSidechain: sidechain,
    message: { id, model, content: text ? [{ type: "text", text }] : [{ type: "tool_use" }], usage },
  });
const user = (text: string) => JSON.stringify({ type: "user", message: { role: "user", content: text } });
const u = (input: number, output: number, cacheRead = 0, cacheWrite = 0) => ({
  input_tokens: input,
  output_tokens: output,
  cache_read_input_tokens: cacheRead,
  cache_creation_input_tokens: cacheWrite,
});

function writeTranscript(lines: string[]): string {
  const f = path.join(home.dir(), "proj", "sess.jsonl");
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, lines.join("\n") + "\n");
  return f;
}

describe("transcript", () => {
  it("de-duplicates usage repeated across content blocks and includes subagents", () => {
    const f = writeTranscript([
      user("rename foo"),
      assistant("m1", "claude-opus-5-5", u(10, 100, 5000, 200)),
      assistant("m1", "claude-opus-5-5", u(10, 100, 5000, 200), "done"),
    ]);
    const sub = path.join(home.dir(), "proj", "sess", "subagents", "agent-a1.jsonl");
    fs.mkdirSync(path.dirname(sub), { recursive: true });
    fs.writeFileSync(sub, assistant("s1", "claude-haiku-4-5", u(3, 50, 1000)) + "\n");

    const first = usageSince(f);
    expect(first.byModel["claude-opus-5-5"]).toEqual({ input: 10, output: 100, cacheRead: 5000, cacheWrite: 200 });
    expect(first.byModel["claude-haiku-4-5"]?.output).toBe(50);

    // Offsets make the next pass incremental.
    fs.appendFileSync(f, assistant("m2", "claude-opus-5-5", u(1, 7)) + "\n");
    const second = usageSince(f, first.offsets);
    expect(second.byModel).toEqual({ "claude-opus-5-5": { input: 1, output: 7, cacheRead: 0, cacheWrite: 0 } });
  });

  it("reads the last main-thread assistant text and model", () => {
    const f = writeTranscript([
      assistant("m1", "claude-sonnet-5", u(1, 1), "first"),
      assistant("m2", "claude-haiku-4-5", u(1, 1), "sidechain", true),
    ]);
    expect(readTail(f)).toEqual({ lastAssistantText: "first", lastAssistantModel: "claude-sonnet-5" });
  });

  it("splits into user turns with per-turn usage, skipping tool results and commands", () => {
    const f = writeTranscript([
      user("fix the bug"),
      assistant("m1", "claude-opus-5-5", u(5, 50)),
      JSON.stringify({ type: "user", message: { content: [{ type: "tool_result", content: "ok" }] } }),
      assistant("m2", "claude-opus-5-5", u(5, 60), "fixed"),
      user("<command-name>/model</command-name>"),
      user("thanks, now run tests"),
      assistant("m3", "claude-opus-5-5", u(1, 10), "all green"),
    ]);
    const turns = readTurns(f);
    expect(turns.map((t) => t.prompt)).toEqual(["fix the bug", "thanks, now run tests"]);
    expect(turns[0]!.usage.output).toBe(110);
    expect(turns[1]!.previousAssistant).toBe("fixed");
  });
});

describe("hooks", () => {
  it("Stop hook prices actual vs. main-model baseline", () => {
    const f = writeTranscript([
      user("rename"),
      assistant("m1", "claude-opus-5-5", u(0, 1000, 10000), "delegating"),
    ]);
    const sub = path.join(home.dir(), "proj", "sess", "subagents", "agent-a1.jsonl");
    fs.mkdirSync(path.dirname(sub), { recursive: true });
    fs.writeFileSync(sub, assistant("s1", "claude-haiku-4-5", u(0, 10000, 50000)) + "\n");
    runStop({ session_id: "sess", transcript_path: f }, "claude");
    const usage = readLedger().find((e) => e.kind === "usage");
    expect(usage?.kind).toBe("usage");
    if (usage?.kind !== "usage") return;
    expect(usage.baselineUsd).toBeGreaterThan(usage.actualUsd);
    // Second Stop with no new lines records nothing.
    runStop({ session_id: "sess", transcript_path: f }, "claude");
    expect(readLedger().filter((e) => e.kind === "usage")).toHaveLength(1);
  });

  it("agent guard pins built-in subagents to a cheaper model in Saver", () => {
    saveConfig({ stage: 2 });
    const s = loadSession("g");
    s.lastDecision = { tier: 0, assessedTier: 0, mainTier: 2, action: "delegate_down", stage: 2, sufficiency: [0.9, 1, 1], threshold: 0.75, taskType: "lookup", reasons: [] };
    saveSession(s);
    const out = runAgentGuard({ session_id: "g", tool_input: { subagent_type: "Explore", prompt: "find x" } }) as {
      hookSpecificOutput?: { updatedInput: Record<string, unknown> };
    };
    expect(out.hookSpecificOutput?.updatedInput).toMatchObject({ subagent_type: "Explore", prompt: "find x", model: "sonnet" });
    saveConfig({ stage: 3 });
    const max = runAgentGuard({ session_id: "g", tool_input: { subagent_type: "Explore", prompt: "find x" } }) as typeof out;
    expect(max.hookSpecificOutput?.updatedInput.model).toBe("haiku");
  });

  it("agent guard leaves explicit models, jev agents, hard tasks, and Balanced alone", () => {
    saveConfig({ stage: 3 });
    expect(runAgentGuard({ session_id: "g", tool_input: { subagent_type: "Explore", model: "opus" } })).toEqual({});
    expect(runAgentGuard({ session_id: "g", tool_input: { subagent_type: "jev:jev-quick" } })).toEqual({});
    expect(runAgentGuard({ session_id: "none", tool_input: { subagent_type: "Explore" } })).toEqual({}); // no decision → treated as hard
    saveConfig({ stage: 1 });
    expect(runAgentGuard({ session_id: "g", tool_input: { subagent_type: "Explore" } })).toEqual({});
  });
});

describe("models + redaction", () => {
  it("maps model names and aliases to tiers", () => {
    expect(tierOfModel("claude-opus-5-5[1m]")).toBe(2);
    expect(tierOfModel("claude-haiku-4-5-20251001")).toBe(0);
    expect(tierOfModel("sonnet")).toBe(1);
    expect(tierOfModel("gpt-6-luna")).toBe(0);
    expect(tierOfModel("mystery-model")).toBeUndefined();
  });

  it("switching a large cached context to a cheaper model can cost more than it saves", () => {
    const opus = findModel("claude-opus-5-5")!;
    const haiku = findModel("claude-haiku-4-5")!;
    // 150k context: cache write on Haiku ($1.25/M) vs cache read on Opus 5.5 ($0.20/M).
    expect(cacheSwitchCost(opus, haiku, 150_000)).toBeCloseTo(0.1575, 4);
  });

  it("redacts common secret formats and clips long text", () => {
    // Fake tokens are assembled at runtime so secret scanners don't flag the repo.
    const openai = "sk-" + "proj-" + "abcdefghijklmnopqrstuvwx";
    const github = "gh" + "p_" + "abcdefghijklmnopqrstuvwxyz0123";
    const s = redact(`key=${openai} and ${github} postgres://u:pw@host/db password: hunter22`);
    expect(s).not.toMatch(/sk-proj-a|ghp_a|:pw@|hunter22/);
    expect(clip("a".repeat(100), 50).length).toBeLessThan(80);
  });
});
