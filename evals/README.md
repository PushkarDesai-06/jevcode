# Routing evals

`labeled.jsonl` holds one prompt per line, labeled with the **cheapest tier a careful engineer would trust**:
- 0 = Haiku / Luna
- 1 = Sonnet / Sol
- 2 = Opus / Astra

```sh
jev eval evals/labeled.jsonl --offline                          # heuristic classifier
OPENROUTER_API_KEY=... jev eval evals/labeled.jsonl --max-under 0.05   # Jev; exits 1 if Saver under-routes > 5%
jev eval evals/labeled.jsonl --verbose --stage 3                # list misses for one stage
```

**Under-routing** means a task was sent below its label. It is the number that decides whether people trust Stage 3, so it gates releases. Over-routing only costs money.

Tuning knobs:
- `TIER_CAPABILITY` in `src/core/policy.ts`: per-level weights and penalties.
- The stage presets `STAGES`: thresholds and floors.

Add real prompts from `jev audit` misses to grow the set. Keep labels honest: label the tier you would actually trust, not the one that makes the numbers look good.
