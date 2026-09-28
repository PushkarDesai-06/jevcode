import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { saveConfig, type JevConfig } from "../core/config.js";
import { modelForTier, ROUTE_AGENTS } from "../core/models.js";
import type { Tier } from "../core/types.js";

// Setup writes into the host's own config files, which plugins can't do themselves.
// Every write backs up the original first and is idempotent.

function backup(file: string): string | undefined {
  if (!fs.existsSync(file)) return undefined;
  const dest = `${file}.jev-backup-${new Date().toISOString().replace(/[:.]/g, "-")}`;
  fs.copyFileSync(file, dest);
  return dest;
}

export interface SetupResult {
  changed: string[];
  notes: string[];
}

/** Install the jev statusline into ~/.claude/settings.json (refuses to replace another one without --force). */
export function setupClaudeStatusline(opts: { force: boolean; command: string; settingsPath?: string }): SetupResult {
  const file = opts.settingsPath ?? path.join(os.homedir(), ".claude", "settings.json");
  let settings: Record<string, unknown> = {};
  try {
    settings = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    // New file.
  }
  const existing = settings.statusLine as { command?: string } | undefined;
  if (existing?.command?.includes("jev")) return { changed: [], notes: ["jev statusline already installed."] };
  if (existing && !opts.force) {
    return {
      changed: [],
      notes: [
        `You already have a statusline (${existing.command ?? "custom"}). Re-run with --force to replace it,`,
        `or append the jev segment to your script: \`echo "$input" | ${opts.command}\`.`,
      ],
    };
  }
  const bak = backup(file);
  settings.statusLine = { type: "command", command: opts.command, padding: 0 };
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(settings, null, 2) + "\n");
  return { changed: [file], notes: bak ? [`Backup: ${bak}`] : [] };
}

const ROLE_TEXT: Record<Tier, { description: string; instructions: string; effort: string }> = {
  0: {
    description:
      "Fast, low-cost worker for simple, well-specified tasks: codebase lookups, small edits, routine shell/git chores. Used by jev routing.",
    instructions:
      "You are a fast worker handling a simple, well-specified task delegated by the main agent. Do exactly what the brief asks, verify it if a check is given, and reply with a terse result: what you did, files touched, anything that failed. If the task turns out to be harder or riskier than described, stop and say so instead of guessing.",
    effort: "low",
  },
  1: {
    description:
      "Capable mid-tier worker for moderate coding tasks: focused features, bug fixes, reviews. Used by jev routing.",
    instructions:
      "You are a capable engineer handling a delegated coding task. Follow the brief, keep changes minimal and consistent with the surrounding code, run the verification step if one is given, and reply with a concise summary: what changed, files touched, verification result, open questions.",
    effort: "medium",
  },
  2: {
    description:
      "Top-tier model for complex, subtle, or high-stakes work: hard debugging, architecture, security-sensitive changes. Used by jev routing to escalate.",
    instructions:
      "You are a senior engineer taking over a hard problem escalated by the main agent. Reason carefully, verify assumptions against the code, prefer correct over fast, and reply with a clear summary of findings, changes, verification, and remaining risks.",
    effort: "high",
  },
};

export function codexRoleToml(tier: Tier, cfg: JevConfig): string {
  const role = ROLE_TEXT[tier];
  const model = modelForTier("codex", tier, cfg.tierModels).id;
  return [
    `# Installed by jevcode (jev setup codex). Safe to delete; re-run setup to restore.`,
    `name = ${JSON.stringify(ROUTE_AGENTS[tier])}`,
    `description = ${JSON.stringify(role.description)}`,
    `nickname_candidates = [${JSON.stringify(["Quick", "Worker", "Deep"][tier])}]`,
    `model = ${JSON.stringify(model)}`,
    `model_reasoning_effort = ${JSON.stringify(role.effort)}`,
    `developer_instructions = """`,
    role.instructions,
    `"""`,
    "",
  ].join("\n");
}

/** Install jev-quick / jev-worker / jev-deep agent roles for Codex, pinned to Luna / Sol / Astra. */
export function setupCodexRoles(cfg: JevConfig, codexHome = path.join(os.homedir(), ".codex")): SetupResult {
  const dir = path.join(codexHome, "agents");
  fs.mkdirSync(dir, { recursive: true });
  const changed: string[] = [];
  for (const tier of [0, 1, 2] as Tier[]) {
    const file = path.join(dir, `${ROUTE_AGENTS[tier]}.toml`);
    const content = codexRoleToml(tier, cfg);
    if (fs.existsSync(file) && fs.readFileSync(file, "utf8") === content) continue;
    fs.writeFileSync(file, content);
    changed.push(file);
  }
  saveConfig({ codexRoles: true });
  return {
    changed,
    notes: [
      "Codex agent roles installed. Hook-driven delegation is now enabled for Codex.",
      "Optional: to make Codex's own sub-agents cheaper too, add to ~/.codex/config.toml:",
      `  [agents]\n  default_subagent_model = "${modelForTier("codex", 1, cfg.tierModels).id}"`,
    ],
  };
}
