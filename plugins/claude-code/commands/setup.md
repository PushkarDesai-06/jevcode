---
description: Set up jev — Jev API key, statusline, and a quick health check
argument-hint: "[key <OPENROUTER_API_KEY> | statusline]"
allowed-tools: Bash(jev:*)
---

Help the user set up jev. Their arguments: `$ARGUMENTS`

- If the arguments start with `key `, run `jev setup key <the key>`. Never echo the key back.
- If the arguments are `statusline`, run `jev setup statusline` and relay the result. Only add `--force` if the user explicitly asks to replace their existing statusline.
- Otherwise run `jev doctor` and `jev mode`, summarize the state, and explain the next step:
  1. Create an OpenRouter API key (openrouter.ai/keys) and run `/jev:setup key <key>`, or keep using the offline classifier.
  2. Optionally `/jev:setup statusline` to see routing in the status bar.
  3. Pick a stage with `/jev:mode 1|2|3` (default is 2, Saver). `/jev:audit` estimates savings for each stage from past sessions.
