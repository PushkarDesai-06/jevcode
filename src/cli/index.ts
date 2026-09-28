import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { classify } from "../core/classify.js";
import { configPath, DEFAULT_CONFIG, JEV_PROVIDERS, loadConfig, saveConfig, type JevConfig, type JevProvider } from "../core/config.js";
import { readLedger, summarize } from "../core/ledger.js";
import { decide, STAGE_NAMES } from "../core/policy.js";
import { latestSession, loadSession, updateGlobal } from "../core/state.js";
import type { Stage, Tier } from "../core/types.js";
import { runAudit } from "./audit.js";
import { loadCases, runEval } from "./eval.js";
import { bold, cyan, describeDecision, dim, green, pct, table, usd, yellow } from "./format.js";
import { setupClaudeStatusline, setupCodexRoles } from "./setup.js";
import { statusline } from "./statusline.js";

const HELP = `${bold("jev")} — Jev-powered model routing for Claude Code and Codex

${bold("Usage")}
  jev mode [off|1|2|3]        Show or set the optimization stage
                              1 Balanced · 2 Saver · 3 Max Saver
  jev status                  Current config, classifier, last decision
  jev why [session-id]        Explain the last routing decision
  jev stats [--days N]        Routing counts and estimated savings
  jev escalate [deep|worker]  Force the next prompt onto a stronger model
  jev classify "<prompt>"     Show how a prompt would be routed in each stage
  jev audit [--days N] [--offline] [--limit N]
                              Estimate savings from your past Claude Code sessions
  jev eval <file.jsonl> [--offline]
                              Score routing against a labeled prompt set
  jev setup key <OPENROUTER_API_KEY>   (a TypeSafe key also works; detected by prefix)
  jev setup statusline [--force]
  jev setup codex             Install Codex agent roles (enables delegation)
  jev config [get|set <key> <value>]
  jev doctor                  Check installation and Jev connectivity

Inline overrides in any prompt: !deep  !quick  !nojev
`;

function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}

function parseStage(v: string): Stage | undefined {
  const m: Record<string, Stage> = { off: 0, "0": 0, "1": 1, balanced: 1, "2": 2, saver: 2, "3": 3, max: 3, "max-saver": 3 };
  return m[v.toLowerCase()];
}

async function readStdin(): Promise<string> {
  if (process.stdin.isTTY) return "";
  const chunks: Buffer[] = [];
  for await (const c of process.stdin) chunks.push(c as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

/** Absolute path of this CLI's bundle, for wiring the statusline command. */
function selfCommand(): string {
  const self = fileURLToPath(import.meta.url);
  return `node ${JSON.stringify(self)} statusline`;
}

async function main(argv: string[]): Promise<number> {
  const [cmd, ...args] = argv;
  const cfg = loadConfig();

  switch (cmd) {
    case undefined:
    case "help":
    case "--help":
    case "-h":
      process.stdout.write(HELP);
      return 0;

    case "mode": {
      if (!args[0]) {
        console.log(`Stage ${cfg.stage} · ${STAGE_NAMES[cfg.stage]}`);
        return 0;
      }
      const stage = parseStage(args[0]);
      if (stage === undefined) {
        console.error("Stage must be off, 1, 2, or 3.");
        return 1;
      }
      saveConfig({ stage });
      console.log(`jev stage set to ${stage} · ${STAGE_NAMES[stage]}`);
      if (stage === 3) {
        console.log(
          dim("Max Saver works best with a mid-tier main session (Claude Code: /model sonnet; Codex: /model gpt-6-sol).\nHard tasks escalate to the jev-deep agent automatically."),
        );
      }
      return 0;
    }

    case "status": {
      const last = latestSession()?.lastDecision;
      console.log(
        table([
          ["Stage", `${cfg.stage} · ${STAGE_NAMES[cfg.stage]}`],
          ["Classifier", cfg.classifier === "jev" ? `Jev ${cfg.jevModel} via ${cfg.jevProvider}` : yellow("offline heuristic (no OPENROUTER_API_KEY)")],
          ["Main tier", Object.keys(cfg.mainTier).length ? JSON.stringify(cfg.mainTier) : "auto-detect"],
          ["Codex roles", cfg.codexRoles ? "installed" : "not installed (jev setup codex)"],
          ["Config", configPath()],
          ["Last decision", last ? `${last.action} T${last.tier} · ${last.taskType}` : "—"],
        ]),
      );
      return 0;
    }

    case "why": {
      const byId = args[0] ? loadSession(args[0]) : undefined;
      const s = byId?.lastDecision ? byId : latestSession();
      if (!s?.lastDecision) {
        console.log("No routing decisions yet.");
        return 0;
      }
      if (s.lastPrompt) console.log(`${bold("Prompt")}      ${s.lastPrompt.slice(0, 160).replace(/\s+/g, " ")}`);
      console.log(describeDecision(s.lastDecision));
      return 0;
    }

    case "stats": {
      const days = Number(flag(args, "--days") ?? 7);
      const s = summarize(readLedger(Date.now() - days * 86_400_000));
      if (args.includes("--json")) {
        console.log(JSON.stringify(s, null, 2));
        return 0;
      }
      console.log(bold(`Last ${days} day${days === 1 ? "" : "s"}`));
      console.log(
        table([
          ["Prompts routed", `${s.routed} of ${s.prompts}`],
          ["Actions", Object.entries(s.byAction).map(([k, v]) => `${k} ${v}`).join(" · ") || "—"],
          ["Tiers", `T0 ${s.byTier[0]} · T1 ${s.byTier[1]} · T2 ${s.byTier[2]}`],
          ["Actual spend", usd(s.actualUsd)],
          ["Without routing", usd(s.baselineUsd)],
          ["Saved (net of Jev)", s.baselineUsd > 0 ? green(`${usd(s.savedUsd)} (${pct(s.savedPct)})`) : "—"],
          ["Jev cost", s.jevCostUsd > 0 ? usd(s.jevCostUsd) : "—"],
          ["Escalations", String(s.escalations)],
          ["Jev unavailable", String(s.jevFailures)],
        ]),
      );
      console.log(dim("Spend is API-list-price equivalent from transcript token counts; on a subscription it maps to plan usage."));
      return 0;
    }

    case "escalate": {
      const tier: Tier = args[0] === "worker" ? 1 : 2;
      updateGlobal((g) => (g.pendingOverride = { tier, reason: `jev escalate (${tier === 2 ? "deep" : "worker"})`, at: Date.now() }));
      console.log(`Next prompt will run on tier ${tier} (${tier === 2 ? "jev-deep" : "jev-worker"}).`);
      return 0;
    }

    case "classify": {
      const prompt = args.filter((a) => !a.startsWith("--")).join(" ") || (await readStdin());
      if (!prompt.trim()) {
        console.error('Usage: jev classify "<prompt>"');
        return 1;
      }
      const r = await classify({ prompt }, cfg);
      if (!r.classification) {
        console.error(`Classification failed: ${r.error}`);
        return 1;
      }
      const c = r.classification;
      console.log(dim(`classifier: ${c.source} · ${c.latencyMs} ms`));
      console.log(`complexity  ${c.complexity.map((p) => p.toFixed(2)).join(" ")}  (conf ${c.complexityConfidence.toFixed(2)})`);
      console.log(`reasoning ${c.reasoning.toFixed(2)} · risk ${c.risk.toFixed(2)} · continuation ${c.continuation.toFixed(2)}`);
      const mainTier = cfg.mainTier.claude ?? 2;
      for (const stage of [1, 2, 3] as Stage[]) {
        const d = decide({ stage, mainTier, classification: c });
        console.log(`\n${cyan(`Stage ${stage} · ${STAGE_NAMES[stage]}`)}  →  ${bold(d.action)} T${d.tier}`);
        for (const reason of d.reasons) console.log(dim(`  • ${reason}`));
      }
      return 0;
    }

    case "audit": {
      const days = Number(flag(args, "--days") ?? 30);
      const limit = Number(flag(args, "--limit") ?? (cfg.classifier === "jev" ? 300 : 5000));
      const offline = args.includes("--offline");
      const report = await runAudit({ days, offline, limit, projectsDir: flag(args, "--dir") }, cfg, (done, total) => {
        if (process.stderr.isTTY) process.stderr.write(`\rclassifying ${done}/${total}…`);
      });
      if (process.stderr.isTTY) process.stderr.write("\r\x1b[K");
      if (args.includes("--json")) {
        console.log(JSON.stringify(report, null, 2));
        return 0;
      }
      if (report.turns === 0) {
        console.log(`No Claude Code prompts found in the last ${days} days.`);
        return 0;
      }
      console.log(bold(`jev audit · last ${days} days · ${report.turns} prompts in ${report.sessions} sessions`));
      console.log(dim(`classifier: ${report.classifier}${report.classifier === "heuristic" ? " (set OPENROUTER_API_KEY for Jev-quality estimates)" : ""}`));
      console.log(`\nWithout routing: ${bold(usd(report.baselineUsd))} (API list-price equivalent)\n`);
      const rows = [["Stage", "Est. cost", "Saved", "Delegated", "Escalated", "Brief"]];
      for (const k of [1, 2, 3] as const) {
        const s = report.stages[k];
        rows.push([
          `${k} · ${STAGE_NAMES[k]}`,
          usd(s.usd),
          green(`${usd(s.saved)} (${pct(s.savedPct)})`),
          String(s.delegated),
          String(s.escalated),
          String(s.brief),
        ]);
      }
      console.log(table(rows));
      console.log(
        dim(
          "\nEstimates: re-routed turns are priced on the target model with 20% overhead, a sub-agent start-up cost, and the main\nmodel's relay; brief answers cut output 40%. On a Pro/Max plan the same ratio applies to your usage limits.",
        ),
      );
      if (report.unknownModels.length) console.log(dim(`Skipped models without price data: ${report.unknownModels.join(", ")}`));
      return 0;
    }

    case "eval": {
      const file = args.find((a) => !a.startsWith("--"));
      if (!file) {
        console.error("Usage: jev eval <file.jsonl> [--offline]");
        return 1;
      }
      const cases = loadCases(file);
      const scores = await runEval(cases, cfg, args.includes("--offline"));
      const rows = [["Stage", "Accuracy", "Under-routed", "Over-routed"]];
      for (const k of [1, 2, 3] as const) {
        const s = scores[k];
        rows.push([`${k} · ${STAGE_NAMES[k]}`, pct(s.accuracy * 100), `${s.under} (${pct(s.underRate * 100)})`, String(s.over)]);
      }
      console.log(bold(`${cases.length} labeled prompts`));
      console.log(table(rows));
      if (args.includes("--verbose")) {
        const vs = (Number(flag(args, "--stage") ?? 2) || 2) as 1 | 2 | 3;
        for (const m of scores[vs].misses) console.log(dim(`  stage ${vs}: label T${m.label} got T${m.got}  ${m.prompt.slice(0, 90)}`));
      }
      const maxUnder = Number(flag(args, "--max-under") ?? NaN);
      if (!Number.isNaN(maxUnder) && scores[2].underRate > maxUnder) {
        console.error(`Saver under-routing ${pct(scores[2].underRate * 100)} exceeds ${pct(maxUnder * 100)}`);
        return 1;
      }
      return 0;
    }

    case "setup": {
      const [what, ...rest] = args;
      if (what === "key") {
        if (!rest[0]) {
          console.error("Usage: jev setup key <OPENROUTER_API_KEY> [--provider openrouter|typesafe]");
          return 1;
        }
        const named = flag(rest, "--provider") as JevProvider | undefined;
        const jevProvider: JevProvider = named ?? (rest[0].startsWith("sk-or-") ? "openrouter" : "typesafe");
        // Drop any per-provider overrides so the new provider's base URL and model apply.
        saveConfig({ jevApiKey: rest[0], classifier: "jev", jevProvider, jevApiBase: undefined, jevModel: undefined });
        console.log(`Saved ${jevProvider} key to ${configPath()} (mode 600). Model: ${JEV_PROVIDERS[jevProvider].model}.`);
        console.log(dim("Run `jev doctor` to check connectivity."));
        return 0;
      }
      if (what === "statusline") {
        const r = setupClaudeStatusline({ force: rest.includes("--force"), command: selfCommand() });
        for (const f of r.changed) console.log(`Updated ${f}`);
        for (const n of r.notes) console.log(n);
        return 0;
      }
      if (what === "codex") {
        const r = setupCodexRoles(cfg);
        for (const f of r.changed) console.log(`Wrote ${f}`);
        for (const n of r.notes) console.log(n);
        return 0;
      }
      console.error("Usage: jev setup key|statusline|codex");
      return 1;
    }

    case "config": {
      if (args[0] === "set" && args[1] && args[2] !== undefined) {
        const key = args[1] as keyof JevConfig;
        if (!(key in DEFAULT_CONFIG) && key !== "jevApiKey") {
          console.error(`Unknown key: ${key}`);
          return 1;
        }
        let value: unknown = args[2];
        try {
          value = JSON.parse(args[2]);
        } catch {
          // Plain string.
        }
        saveConfig({ [key]: value } as Partial<JevConfig>);
        console.log(`${key} = ${JSON.stringify(value)}`);
        return 0;
      }
      const shown = { ...cfg, jevApiKey: cfg.jevApiKey ? `${cfg.jevApiKey.slice(0, 6)}…` : undefined };
      console.log(JSON.stringify(shown, null, 2));
      return 0;
    }

    case "doctor": {
      let ok = true;
      const check = (name: string, pass: boolean, detail: string) => {
        ok &&= pass;
        console.log(`${pass ? green("✓") : yellow("!")} ${name}: ${detail}`);
      };
      const major = Number(process.versions.node.split(".")[0]);
      check("Node", major >= 18, process.versions.node);
      check("Config", true, fs.existsSync(configPath()) ? configPath() : "defaults (no config file yet)");
      if (cfg.classifier === "jev" && cfg.jevApiKey) {
        const r = await classify({ prompt: "rename the variable foo to bar in utils.ts" }, { ...cfg, jevTimeoutMs: 5000 });
        const c = r.classification;
        check(
          "Jev",
          Boolean(c),
          c
            ? `${cfg.jevProvider} · ${c.jevModel ?? cfg.jevModel} · ${c.latencyMs} ms${c.costUsd !== undefined ? ` · $${c.costUsd.toFixed(6)}/call` : ""}`
            : `${cfg.jevProvider} (${cfg.jevApiBase}): ${r.error}`,
        );
      } else {
        check("Jev", false, "no OPENROUTER_API_KEY, using the offline heuristic (jev setup key <key>)");
      }
      const bundleDir = path.dirname(fileURLToPath(import.meta.url));
      check("Hook bundle", fs.existsSync(path.join(bundleDir, "hook.mjs")), path.join(bundleDir, "hook.mjs"));
      return ok ? 0 : 1;
    }

    case "statusline":
      process.stdout.write(statusline(await readStdin()));
      return 0;

    default:
      console.error(`Unknown command: ${cmd}\n`);
      process.stdout.write(HELP);
      return 1;
  }
}

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  },
);
