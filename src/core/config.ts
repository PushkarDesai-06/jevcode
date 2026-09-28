import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Host, Stage, Tier } from "./types.js";

export type JevProvider = "openrouter" | "typesafe";

/**
 * Where Jev System One is served. Both expose the same `POST {base}/v1/systemone`
 * contract; OpenRouter namespaces model ids and adds `usage.cost` to responses.
 * The model is pinned (not `jev-latest`) because the policy's thresholds are calibrated
 * against a specific model; bump it deliberately after re-running `jev eval`.
 */
export const JEV_PROVIDERS: Record<JevProvider, { base: string; model: string; keyEnv: string[] }> = {
  openrouter: {
    base: "https://openrouter.ai/api",
    model: "typesafe/jev-1.13",
    keyEnv: ["OPENROUTER_API_KEY", "CLAUDE_PLUGIN_OPTION_OPENROUTER_API_KEY"],
  },
  typesafe: {
    base: "https://api.typesafe.ai",
    model: "jev-1.13",
    keyEnv: ["TYPESAFE_API_KEY", "CLAUDE_PLUGIN_OPTION_TYPESAFE_API_KEY"],
  },
};

export interface JevConfig {
  stage: Stage;
  /** "jev" calls Jev via `jevProvider`; "heuristic" runs the offline keyword classifier (no key needed). */
  classifier: "jev" | "heuristic";
  jevProvider: JevProvider;
  jevApiKey?: string;
  /** Resolved from the provider unless overridden in config. */
  jevApiBase: string;
  jevModel: string;
  jevTimeoutMs: number;
  /**
   * Tier of the model the user runs the main session on, per host. When unset we
   * infer it from the hook payload, falling back to the stage default.
   */
  mainTier: Partial<Record<Host, Tier>>;
  /** Override the model id used for each tier, e.g. { claude: ["claude-haiku-4-5", ...] }. */
  tierModels: Partial<Record<Host, string[]>>;
  /** Send the previous assistant message tail to Jev as context. */
  includeContext: boolean;
  /** Show a one-line routing notice to the user on each routed prompt. */
  notify: boolean;
  /** Set by `jev setup codex` once the jev-* agent roles are installed in ~/.codex/agents. */
  codexRoles: boolean;
}

export const DEFAULT_CONFIG: JevConfig = {
  stage: 2,
  classifier: "jev",
  jevProvider: "openrouter",
  jevApiBase: JEV_PROVIDERS.openrouter.base,
  jevModel: JEV_PROVIDERS.openrouter.model,
  jevTimeoutMs: 1500,
  mainTier: {},
  tierModels: {},
  includeContext: true,
  notify: true,
  codexRoles: false,
};

export function jevHome(): string {
  return process.env.JEVCODE_HOME ?? path.join(os.homedir(), ".jevcode");
}

export function configPath(): string {
  return path.join(jevHome(), "config.json");
}

export function loadConfig(): JevConfig {
  let fileCfg: Partial<JevConfig> = {};
  try {
    fileCfg = JSON.parse(fs.readFileSync(configPath(), "utf8"));
  } catch {
    // Missing or unreadable config: use defaults.
  }
  const cfg: JevConfig = { ...DEFAULT_CONFIG, ...fileCfg };

  // Provider: explicit env/config wins; otherwise OpenRouter, falling back to direct
  // TypeSafe when only a TypeSafe key is present.
  const envKey = (p: JevProvider) => JEV_PROVIDERS[p].keyEnv.map((k) => process.env[k]).find(Boolean);
  const explicit = (process.env.JEVCODE_JEV_PROVIDER as JevProvider | undefined) ?? fileCfg.jevProvider;
  cfg.jevProvider =
    explicit && explicit in JEV_PROVIDERS
      ? explicit
      : !envKey("openrouter") && !fileCfg.jevApiKey && envKey("typesafe")
        ? "typesafe"
        : "openrouter";
  const provider = JEV_PROVIDERS[cfg.jevProvider];
  cfg.jevApiBase = process.env.JEVCODE_JEV_API_BASE ?? fileCfg.jevApiBase ?? provider.base;
  cfg.jevModel = process.env.JEVCODE_JEV_MODEL ?? fileCfg.jevModel ?? provider.model;
  // Environment wins so plugin userConfig / CI can inject keys without touching the file.
  cfg.jevApiKey = envKey(cfg.jevProvider) ?? cfg.jevApiKey;
  const envStage = process.env.JEVCODE_STAGE;
  if (envStage && /^[0-3]$/.test(envStage)) cfg.stage = Number(envStage) as Stage;
  if (!cfg.jevApiKey && cfg.classifier === "jev") cfg.classifier = "heuristic";
  return cfg;
}

export function saveConfig(patch: Partial<JevConfig>): JevConfig {
  let current: Partial<JevConfig> = {};
  try {
    current = JSON.parse(fs.readFileSync(configPath(), "utf8"));
  } catch {
    // Start fresh.
  }
  const next = { ...current, ...patch };
  writeJsonAtomic(configPath(), next, 0o600);
  return { ...DEFAULT_CONFIG, ...next };
}

export function writeJsonAtomic(file: string, data: unknown, mode = 0o644): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + "\n", { mode });
  fs.renameSync(tmp, file);
}

export function readJson<T>(file: string, fallback: T): T {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")) as T;
  } catch {
    return fallback;
  }
}
