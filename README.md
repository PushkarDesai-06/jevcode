# jevcode

**Send each prompt to the cheapest model that can handle it.** jevcode is a plugin for Claude Code and Codex. It uses [Jev](https://openrouter.ai/typesafe/jev-1.13), TypeSafe's System One classifier served through OpenRouter (about 130 ms, fractions of a cent per prompt), to classify every prompt. Simple work goes to cheaper models, hard work escalates, and pushback moves the task back up automatically.

```
jev ▸ → haiku · small edit · Saver
```

## See your number first

```sh
npx jevcode audit            # replays your last 30 days of Claude Code sessions
```

```
jev audit · last 30 days · 240 prompts in 66 sessions · classifier: jev
Without routing: $258 (API list-price equivalent)

Stage           Est. cost   Saved          Delegated   Escalated   Brief
1 · Balanced    $253        $4.97 (2%)     18          0           0
2 · Saver       $203        $54.98 (21%)   122         0           13
3 · Max Saver   $115        $144 (56%)     86          24          21
```

These are real numbers from one developer's Opus-heavy month, classified by Jev through OpenRouter. The audit itself cost about $0.01 in Jev calls. Without a key, jev falls back to a more cautious offline heuristic. On a Pro or Max plan, the same ratios apply to your usage limits.

Routing quality on the labeled set (`evals/labeled.jsonl`, Jev):
- **Saver:** 83% exact, 0% sent to too weak a model.
- **Max Saver:** 86% exact, 8% sent to too weak a model. That's mostly hard debugging handed to Sonnet, which is the trade Max Saver makes.

## Install

**Claude Code**
```
/plugin marketplace add PushkarDesai-06/jevcode
/plugin install jev@jevcode
/jev:setup key <OPENROUTER_API_KEY>   # optional; without it jev uses an offline heuristic
/jev:setup statusline                 # optional; shows routing in the status bar
```

**Codex**
```sh
codex plugin marketplace add PushkarDesai-06/jevcode
codex plugin add jev@jevcode          # then approve the hook with /hooks
npx jevcode setup key <OPENROUTER_API_KEY>
npx jevcode setup codex               # installs jev-quick / jev-worker / jev-deep agent roles
```

## The three stages

| | Stage 1 · Balanced | Stage 2 · Saver (default) | Stage 3 · Max Saver |
|---|---|---|---|
| Hands off to a cheaper model when | ≥ 90% sure it's enough | ≥ 75% sure | ≥ 55% sure |
| Delegates to | cheapest tier only | cheap or mid tier | cheap or mid tier |
| Main session | keep Opus / Astra | keep Opus / Astra | **Sonnet / Sol**, escalating hard work to Opus / Astra |
| Risky prompts (auth, payments, deploys) | top tier | top tier | mid tier |
| High-stakes prompts (prod data, migrations, destructive ops) | top tier | top tier | **top tier** |
| Built-in sub-agents (Explore…) | unchanged | pinned to Sonnet | pinned to Haiku unless the task is hard |
| Simple Q&A | answered on main | brief answer on main | brief answer on main |

Change stages with `/jev:mode 1|2|3|off`. `off` observes and logs without routing.

**Adaptation.** If you push back after a cheap route ("that's wrong", "still failing", or the same prompt again), jev moves that task back to the main model and raises the bar for that task type in that repo. Each clean cheap route relaxes it a little. `/jev:escalate` forces your next prompt onto the top model. You can also start any prompt with `!deep`, `!quick`, or `!nojev`.

## How it works, and why it's built this way

Neither Claude Code nor Codex lets a plugin change the main session's model per turn: hooks can add context but can't switch the model. So jevcode routes by **delegation**:

1. A `UserPromptSubmit` hook runs one Jev call per prompt. It asks six typed questions in parallel: complexity, task type, reasoning needed, risk, whether the prompt continues the current task, and scope.
2. The policy picks the cheapest tier whose P(sufficient) clears the stage's threshold, then applies guardrails. The guardrails can only raise the tier: risk floors, a low-confidence floor, and stickiness mid-task.
3. If the chosen tier differs from the main model, the hook tells the agent to hand the work to a plugin sub-agent pinned to that model:
   - Claude Code: `jev:jev-quick` (Haiku), `jev:jev-worker` (Sonnet), `jev:jev-deep` (Opus).
   - Codex: `jev-quick` (Luna), `jev-worker` (Sol), `jev-deep` (Astra).
4. A `Stop` hook reads the transcript's token usage, including sub-agent transcripts, and logs actual cost against "everything on the main model".

Delegation is subscription-safe and cache-friendly, which matters for two reasons:
- **Caches are model-scoped.** Switching the main model mid-conversation re-bills the whole context. Moving a 150k-token context from Opus 5.5 to Haiku costs about $0.16 more than staying.
- **Sub-agents keep bulky tool output out of the main context.** Otherwise every later turn re-reads that output.

**Where it doesn't pay:** a sub-agent has a fixed start-up cost, about $0.035 on Haiku in testing, so for a one-command task delegating costs more. Stages 1–2 tell the main model to skip the hand-off for single quick commands. Stage 3 always delegates.

**Failure handling.** If Jev is slow (1.5 s timeout), rate-limited, or down, jev keeps the current model. A circuit breaker then skips Jev for 30 seconds. Secrets are redacted before anything leaves your machine, and only the prompt plus the tail of the previous assistant message is sent.

## CLI

```
jev mode [off|1|2|3]      jev stats [--days N]      jev why
jev escalate [deep|worker] jev classify "<prompt>"   jev audit [--offline]
jev eval evals/labeled.jsonl [--offline] [--max-under 0.05]
jev setup key|statusline|codex    jev config [set <k> <v>]    jev doctor
```

### Jev provider

jev calls Jev System One at `https://openrouter.ai/api/v1/systemone` with your OpenRouter key (`OPENROUTER_API_KEY`, or `jev setup key sk-or-…`).
- **Pinned model.** It is `typesafe/jev-1.13`, because the routing thresholds are calibrated against it. To try a newer one, set `jev config set jevModel '"typesafe/jev-latest"'` and re-run `jev eval` first.
- **Cost tracking.** OpenRouter reports each call's cost, and `jev stats` shows savings net of it.
- **Direct TypeSafe.** Still supported: set `TYPESAFE_API_KEY`, or pass `jev setup key <key> --provider typesafe`.
- **Redirects.** Refused, so your key is never forwarded to another host.

Config lives in `~/.jevcode/config.json`. `mainTier` pins your main model's tier. `tierModels` overrides which model each tier maps to. `classifier: "heuristic"` forces offline mode.

## Development

```sh
npm install
npm run check      # typecheck + tests + build (bundles into dist/ and both plugins)
claude --plugin-dir plugins/claude-code    # try it live
```

Hooks are bundled with esbuild into dependency-free `.mjs` files (plugin caches don't run `npm install`), and the committed `plugins/*/dist` is what users run. **Run `npm run build` before committing.**

## Status

Verified live in Claude Code 2.1.283:
- hooks fire
- routing context reaches the model
- Sonnet delegates to `jev:jev-quick` and Haiku does the work
- Stop-hook accounting matches transcript usage

Not yet verified:
- **Codex hook output format and role discovery.** They're modeled on the Codex binary's config schema.
- **Jev live responses.** The endpoint and auth are confirmed against OpenRouter, but not a real classification. The parser tolerates several answer shapes. Run `jev doctor` with a key.
- **The PreToolUse sub-agent model pin.** Not yet tested live.

Roadmap:
- **Opt-in local gateway for API-key users.** True per-request model and effort rewriting, cache-aware.
- **Budget autopilot.** Shift stages automatically as you approach a daily budget or your 5-hour limit.
- **Team policies and dashboards.**
