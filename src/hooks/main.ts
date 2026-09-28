// Single hook entrypoint, bundled to dist/hook.js:
//   node hook.js route        --host claude|codex   (UserPromptSubmit)
//   node hook.js agent-guard  --host claude         (PreToolUse on Agent/Task)
//   node hook.js stop         --host claude|codex   (Stop: cost accounting)
// Every path exits 0 with valid JSON: a routing hook must never block the user's prompt.
import { loadConfig } from "../core/config.js";
import { appendLedger } from "../core/ledger.js";
import { CLAUDE_ALIASES, costOf, findModel } from "../core/models.js";
import { route } from "../core/router.js";
import { loadSession, pruneSessions, saveSession } from "../core/state.js";
import { readTail, usageSince } from "../core/transcript.js";
import type { Host, Tier } from "../core/types.js";

interface HookInput {
  session_id?: string;
  transcript_path?: string;
  cwd?: string;
  hook_event_name?: string;
  prompt?: string;
  model?: string;
  tool_name?: string;
  tool_input?: Record<string, unknown>;
  stop_hook_active?: boolean;
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const c of process.stdin) chunks.push(c as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

function emit(obj: Record<string, unknown>): void {
  process.stdout.write(JSON.stringify(obj));
}

export async function runRoute(input: HookInput, host: Host): Promise<Record<string, unknown>> {
  const cfg = loadConfig();
  if (!input.prompt) return {};
  const result = await route(
    {
      host,
      sessionId: input.session_id ?? "default",
      prompt: input.prompt,
      cwd: input.cwd,
      transcriptPath: input.transcript_path,
      model: input.model,
    },
    cfg,
  );
  const out: Record<string, unknown> = {};
  if (result.context) {
    out.hookSpecificOutput = { hookEventName: "UserPromptSubmit", additionalContext: result.context };
  }
  if (result.notice) out.systemMessage = result.notice;
  return out;
}

/**
 * Subagents Claude spawns on its own (Explore, general-purpose, ...) inherit the main
 * model unless told otherwise. In Saver / Max Saver we pin them to a cheaper tier based
 * on how hard the current task was classified.
 */
export function runAgentGuard(input: HookInput): Record<string, unknown> {
  const cfg = loadConfig();
  const ti = input.tool_input;
  if (cfg.stage < 2 || !ti || ti.model) return {};
  const subagent = String(ti.subagent_type ?? "general-purpose");
  if (subagent.startsWith("jev:")) return {}; // our agents already pin their model
  const last = loadSession(input.session_id ?? "default").lastDecision;
  const taskTier: Tier = last?.tier ?? 2;
  if (taskTier === 2) return {}; // hard task: let subagents inherit the strong model
  const searchOnly = /^(explore|search|claude-code-guide)$/i.test(subagent);
  const tier: Tier = cfg.stage === 3 ? (searchOnly ? 0 : taskTier) : searchOnly ? 1 : (Math.max(1, taskTier) as Tier);
  return {
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "allow",
      permissionDecisionReason: `jev: pinned ${subagent} subagent to ${CLAUDE_ALIASES[tier]}`,
      updatedInput: { ...ti, model: CLAUDE_ALIASES[tier] },
    },
  };
}

/** Price the tokens used since the last Stop, actual vs. "everything on the main model". */
export function runStop(input: HookInput, host: Host): Record<string, unknown> {
  if (host !== "claude" || !input.transcript_path || !input.session_id) return {};
  const session = loadSession(input.session_id);
  const { byModel, offsets } = usageSince(input.transcript_path, session.transcriptOffsets);
  session.transcriptOffsets = offsets;
  const mainModelId = readTail(input.transcript_path).lastAssistantModel ?? session.mainModel;
  session.mainModel = mainModelId;
  saveSession(session);

  const main = findModel(mainModelId);
  let actualUsd = 0;
  let baselineUsd = 0;
  for (const [model, usage] of Object.entries(byModel)) {
    const info = findModel(model);
    if (!info) continue;
    actualUsd += costOf(info, usage);
    baselineUsd += costOf(main ?? info, usage);
  }
  if (actualUsd > 0) {
    appendLedger({ kind: "usage", at: Date.now(), host, sessionId: input.session_id, actualUsd, baselineUsd, byModel });
  }
  if (Math.random() < 0.02) pruneSessions();
  return {};
}

async function main(): Promise<void> {
  const [cmd = "route", ...rest] = process.argv.slice(2);
  const hostIdx = rest.indexOf("--host");
  const host: Host = hostIdx >= 0 && rest[hostIdx + 1] === "codex" ? "codex" : "claude";
  let out: Record<string, unknown> = {};
  try {
    const raw = await readStdin();
    const input = (raw.trim() ? JSON.parse(raw) : {}) as HookInput;
    if (cmd === "route") out = await runRoute(input, host);
    else if (cmd === "agent-guard") out = runAgentGuard(input);
    else if (cmd === "stop") out = runStop(input, host);
  } catch (err) {
    if (process.env.JEVCODE_DEBUG) process.stderr.write(`jev hook error: ${(err as Error).stack}\n`);
  }
  emit(out);
}

if (process.env.VITEST === undefined) void main();
