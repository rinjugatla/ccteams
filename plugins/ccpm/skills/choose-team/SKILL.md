---
name: choose-team
description: Pick and apply the best ccpm agent team for a described need using natural language — reads team metadata, selects the closest match, and applies it.
argument-hint: [natural language request]
allowed-tools: Bash
---

Select and apply the agent team that best matches the user's natural-language
request. Follow these steps exactly:

1. Run `ccpm list --json` via Bash. This returns a JSON array where each element
   has `name`, `description`, `tags`, and `requiresAgentTeams`.

2. Read the user's request and compare it against each team's `description` and
   `tags`. Identify the ONE team that is the best fit.

3. If NO team is a plausible match for the request, do NOT force a pick.
   Present the available teams and ask the user to choose directly — do not apply
   any team without a confident match.

4. If a good match is found, tell the user which team you chose and give a single
   sentence explaining why it fits their request.

5. If the chosen team has `requiresAgentTeams: true`, note that this team
   requires the experimental Claude Code agent-teams feature
   (`CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1`), which ccpm will enable
   automatically in `.claude/settings.json`.

6. Run `ccpm use <chosen-team-name>` via Bash.

7. Relay ccpm's full output to the user — do not truncate or paraphrase it.

8. Explicitly repeat the session-restart instruction: agents load at session
   start only; the switch is NOT instantly active. The user must run `/exit`
   then `claude` to activate the new team.
