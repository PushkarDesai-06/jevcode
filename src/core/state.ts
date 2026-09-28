import fs from "node:fs";
import path from "node:path";
import { jevHome, readJson, writeJsonAtomic } from "./config.js";
import type { Decision, TaskType, Tier } from "./types.js";

/** Per-session routing state, kept small so hooks can read it in a few ms. */
export interface SessionState {
  sessionId: string;
  lastDecision?: Decision;
  lastPrompt?: string;
  /** Tier the current task is running on; used for stickiness. */
  taskTier?: Tier;
  /** Byte offset per transcript file already accounted for by the Stop hook. */
  transcriptOffsets?: Record<string, number>;
  /** Main model seen at the last accounting pass. */
  mainModel?: string;
  updatedAt: number;
}

/** Cross-session state: one-shot overrides, circuit breaker, per-repo calibration. */
export interface GlobalState {
  /** Set by `jev escalate`: the next prompt is forced to this tier. */
  pendingOverride?: { tier: Tier; reason: string; at: number };
  /** Circuit breaker: skip Jev until this epoch ms. */
  jevOpenUntil?: number;
  /** repo -> taskType -> threshold offset (positive = more cautious). */
  calibration: Record<string, Partial<Record<TaskType, number>>>;
}

const sessionsDir = () => path.join(jevHome(), "sessions");
const globalFile = () => path.join(jevHome(), "state.json");

function safeId(id: string): string {
  return id.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 128) || "default";
}

export function loadSession(sessionId: string): SessionState {
  return readJson<SessionState>(path.join(sessionsDir(), `${safeId(sessionId)}.json`), {
    sessionId,
    updatedAt: 0,
  });
}

export function saveSession(state: SessionState): void {
  state.updatedAt = Date.now();
  writeJsonAtomic(path.join(sessionsDir(), `${safeId(state.sessionId)}.json`), state);
}

export function loadGlobal(): GlobalState {
  return readJson<GlobalState>(globalFile(), { calibration: {} });
}

export function saveGlobal(state: GlobalState): void {
  writeJsonAtomic(globalFile(), state);
}

export function updateGlobal(fn: (s: GlobalState) => void): GlobalState {
  const s = loadGlobal();
  fn(s);
  saveGlobal(s);
  return s;
}

/** Most recently updated session, for `jev why` run outside a hook. */
export function latestSession(): SessionState | undefined {
  let best: SessionState | undefined;
  let entries: string[] = [];
  try {
    entries = fs.readdirSync(sessionsDir());
  } catch {
    return undefined;
  }
  for (const f of entries) {
    if (!f.endsWith(".json")) continue;
    const s = readJson<SessionState | null>(path.join(sessionsDir(), f), null);
    if (s && (!best || s.updatedAt > best.updatedAt)) best = s;
  }
  return best;
}

/** Drop session files older than `maxAgeDays` so the directory doesn't grow forever. */
export function pruneSessions(maxAgeDays = 14): void {
  const cutoff = Date.now() - maxAgeDays * 86_400_000;
  try {
    for (const f of fs.readdirSync(sessionsDir())) {
      const p = path.join(sessionsDir(), f);
      if (fs.statSync(p).mtimeMs < cutoff) fs.unlinkSync(p);
    }
  } catch {
    // Nothing to prune.
  }
}
