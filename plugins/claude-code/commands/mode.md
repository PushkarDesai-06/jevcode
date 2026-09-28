---
description: Show or set the jev optimization stage (off, 1 Balanced, 2 Saver, 3 Max Saver)
argument-hint: "[off|1|2|3]"
allowed-tools: Bash(jev:*)
---

!`jev mode $ARGUMENTS`

Report the result above to the user in one line. If they just switched to stage 3 and the current session model is Opus, mention that Max Saver saves the most with a Sonnet main session (`/model sonnet`), since hard tasks escalate to the jev-deep agent automatically. Don't do anything else.
