import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach } from "vitest";
import type { Classification, TaskType } from "../src/core/types.js";
import { TASK_TYPES } from "../src/core/types.js";

/** Build a classification peaked at a complexity level, with sensible defaults. */
export function cls(opts: {
  level: number;
  task?: TaskType;
  confidence?: number;
  reasoning?: number;
  risk?: number;
  continuation?: number;
  crossCutting?: number;
}): Classification {
  const complexity = [0, 1, 2, 3, 4].map((i) => (i === opts.level ? 0.92 : 0.02));
  const task = opts.task ?? "feature";
  const taskType = Object.fromEntries(TASK_TYPES.map((t) => [t, t === task ? 0.84 : 0.02])) as Record<TaskType, number>;
  const cc = opts.crossCutting ?? 0;
  return {
    complexity,
    complexityConfidence: opts.confidence ?? 0.85,
    taskType,
    taskTypeConfidence: 0.84,
    reasoning: opts.reasoning ?? (opts.level >= 2 ? 0.7 : 0.1),
    risk: opts.risk ?? 0,
    continuation: opts.continuation ?? 0,
    scope: [0.4 - cc / 3, 0.3 - cc / 3, 0.3 - cc / 3, cc],
    source: "jev",
    latencyMs: 120,
  };
}

/** Isolate ~/.jevcode for each test. */
export function useTempHome(): { dir: () => string } {
  let dir = "";
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "jevcode-test-"));
    process.env.JEVCODE_HOME = dir;
    for (const k of ["TYPESAFE_API_KEY", "OPENROUTER_API_KEY", "JEVCODE_JEV_PROVIDER", "JEVCODE_JEV_API_BASE", "JEVCODE_JEV_MODEL"]) {
      delete process.env[k];
    }
    delete process.env.JEVCODE_STAGE;
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
    delete process.env.JEVCODE_HOME;
  });
  return { dir: () => dir };
}

export function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}
