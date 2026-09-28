import type { Host, ModelInfo, Tier } from "./types.js";

// Prices in USD per million tokens (first-party list prices, September 2026).
// Cache writes are the 5-minute TTL rate (1.25x input); cache reads are 0.1x input
// unless the provider publishes a different number.
export const CLAUDE_MODELS: ModelInfo[] = [
  { id: "claude-haiku-4-5", tier: 0, input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25 },
  { id: "claude-sonnet-5", tier: 1, input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 },
  { id: "claude-sonnet-4-6", tier: 1, input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
  { id: "claude-opus-5-5", tier: 2, input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5 },
  { id: "claude-opus-5", tier: 2, input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
  { id: "claude-opus-4-8", tier: 2, input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
  { id: "claude-fable-5-1", tier: 2, input: 10, output: 50, cacheRead: 0.25, cacheWrite: 12.5 },
];

export const OPENAI_MODELS: ModelInfo[] = [
  { id: "gpt-6-luna", tier: 0, input: 0.1, output: 0.5, cacheRead: 0.01, cacheWrite: 0.1 },
  { id: "gpt-6-sol", tier: 1, input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2 },
  { id: "gpt-6-astra", tier: 2, input: 10, output: 50, cacheRead: 1, cacheWrite: 10 },
  { id: "gpt-5.5", tier: 2, input: 5, output: 30, cacheRead: 0.5, cacheWrite: 5 },
];

/** Default model per tier. Users can override in config. */
export const DEFAULT_TIER_MODELS: Record<Host, [string, string, string]> = {
  claude: ["claude-haiku-4-5", "claude-sonnet-5", "claude-opus-5-5"],
  codex: ["gpt-6-luna", "gpt-6-sol", "gpt-6-astra"],
};

/** Claude Code subagent `model:` aliases per tier. */
export const CLAUDE_ALIASES: [string, string, string] = ["haiku", "sonnet", "opus"];

/** Plugin agent / Codex role per tier. Tier 2 is only used for escalation. */
export const ROUTE_AGENTS: [string, string, string] = ["jev-quick", "jev-worker", "jev-deep"];

const ALL_MODELS = [...CLAUDE_MODELS, ...OPENAI_MODELS];

export function findModel(id: string | undefined): ModelInfo | undefined {
  if (!id) return undefined;
  const clean = id.toLowerCase().replace(/\[.*\]$/, "").replace(/-\d{8}$/, "");
  return (
    ALL_MODELS.find((m) => m.id === clean) ??
    // Longest id that prefixes the name, e.g. "claude-opus-5-5-fast" -> claude-opus-5-5.
    [...ALL_MODELS].sort((a, b) => b.id.length - a.id.length).find((m) => clean.startsWith(m.id))
  );
}

/** Best-effort tier for any model name or alias, including ones we have no prices for. */
export function tierOfModel(name: string | undefined): Tier | undefined {
  if (!name) return undefined;
  const known = findModel(name);
  if (known) return known.tier;
  const n = name.toLowerCase();
  if (/haiku|luna|mini|nano|flash/.test(n)) return 0;
  if (/sonnet|\bsol\b|-sol|medium/.test(n)) return 1;
  if (/opus|fable|mythos|astra|opusplan/.test(n)) return 2;
  return undefined;
}

export function modelForTier(host: Host, tier: Tier, overrides?: Partial<Record<Host, string[]>>): ModelInfo {
  const id = overrides?.[host]?.[tier] ?? DEFAULT_TIER_MODELS[host][tier];
  return findModel(id) ?? { ...findModel(DEFAULT_TIER_MODELS[host][tier])!, id };
}

export interface Usage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

export function costOf(model: ModelInfo, u: Usage): number {
  return (
    (u.input * model.input + u.output * model.output + u.cacheRead * model.cacheRead + u.cacheWrite * model.cacheWrite) /
    1e6
  );
}

/**
 * Extra cost of moving a conversation of `contextTokens` from `from` to `to`.
 * Caches are model-scoped, so the whole context is re-billed as a cache write on
 * the new model instead of a cache read on the old one.
 */
export function cacheSwitchCost(from: ModelInfo, to: ModelInfo, contextTokens: number): number {
  return (contextTokens * (to.cacheWrite - from.cacheRead)) / 1e6;
}
