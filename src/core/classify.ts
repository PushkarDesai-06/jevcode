import type { JevConfig } from "./config.js";
import { classifyHeuristic } from "./heuristic.js";
import { classifyWithJev, JevError } from "./jev.js";
import { clip, redact } from "./redact.js";
import { loadGlobal, updateGlobal } from "./state.js";
import type { Classification } from "./types.js";

export interface ClassifyInput {
  prompt: string;
  previousAssistant?: string;
  project?: string;
}

export interface ClassifyResult {
  classification?: Classification;
  /** Why classification is missing (fail-open), for `jev why` and the ledger. */
  error?: string;
}

const BREAKER_COOLDOWN_MS = 30_000;

/**
 * Classify a prompt. Never throws: if Jev is unavailable we return no classification
 * and the caller keeps the current model (fail-open). We deliberately don't fall back
 * to the heuristic on a Jev outage, because a user who configured Jev expects its
 * quality, and "stay on the strong model" is the safe default.
 */
export async function classify(input: ClassifyInput, cfg: JevConfig, fetchImpl?: typeof fetch): Promise<ClassifyResult> {
  const hasPrevious = Boolean(input.previousAssistant);
  if (cfg.classifier === "heuristic" || !cfg.jevApiKey) {
    return { classification: classifyHeuristic(input.prompt, hasPrevious) };
  }

  const g = loadGlobal();
  if (g.jevOpenUntil && g.jevOpenUntil > Date.now()) {
    return { error: "Jev circuit breaker open (recent failures)" };
  }

  try {
    const classification = await classifyWithJev(
      {
        prompt: clip(redact(input.prompt), 6000),
        ...(cfg.includeContext && input.previousAssistant
          ? { previous_assistant_message: clip(redact(input.previousAssistant), 1500) }
          : {}),
        ...(input.project ? { project: input.project } : {}),
      },
      {
        apiKey: cfg.jevApiKey,
        apiBase: cfg.jevApiBase,
        model: cfg.jevModel,
        timeoutMs: cfg.jevTimeoutMs,
        fetchImpl,
      },
    );
    if (g.jevOpenUntil) updateGlobal((s) => delete s.jevOpenUntil);
    return { classification };
  } catch (err) {
    const e = err as JevError;
    // Auth/validation errors are config problems, not outages: surface them, don't trip the breaker.
    if (e.retryable !== false) {
      updateGlobal((s) => (s.jevOpenUntil = Date.now() + BREAKER_COOLDOWN_MS));
    }
    return { error: e.message };
  }
}
