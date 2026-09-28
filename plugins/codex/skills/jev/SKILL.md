---
name: jev
description: Manage jev model routing — show or change the optimization stage, explain the last routing decision, show savings, force escalation, or estimate savings. Use when the user mentions jev, routing, model tiers, saving tokens or credits, or asks why a prompt went to a particular model.
---

# jev routing

jev classifies each prompt with Jev (via OpenRouter) and routes it to the cheapest capable model tier (Luna → Sol → Astra). When a prompt carries a `<jev-route action="delegate_down" agent="jev-quick">` (or `jev-worker` / `jev-deep`) block, spawn a sub-agent with that `agent_type` and a self-contained brief, as the block says. The user enabled this delegation by installing jev.

Run the CLI with `jev <command>` if it's on PATH, otherwise `npx -y jevcode <command>`:

| User wants | Command |
|---|---|
| Current stage / change stage | `jev mode` / `jev mode 1\|2\|3\|off` (1 Balanced, 2 Saver, 3 Max Saver) |
| Why the last prompt was routed that way | `jev why` |
| Savings so far | `jev stats --days 7` |
| Force the next prompt onto the top model | `jev escalate` |
| Estimate savings per stage from history | `jev audit` |
| Enable delegation roles | `jev setup codex` |
| Health check | `jev doctor` |

Show command output to the user as-is in a code block, and add at most one sentence of interpretation. Never print the OpenRouter API key.

Inline overrides the user can type at the start of any prompt: `!deep` (force the top model), `!quick` (force the cheapest), `!nojev` (skip routing).
