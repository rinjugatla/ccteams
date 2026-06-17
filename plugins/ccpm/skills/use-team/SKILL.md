---
name: use-team
description: Apply a named ccpm agent team to the current project by running ccpm use <team-name>.
argument-hint: [team-name]
allowed-tools: Bash
---

Apply the agent team specified by the user's argument to the current project.

Steps:
1. If no team name was provided, run `ccpm list` via Bash, show the output, and
   ask the user which team they want to apply before proceeding.
2. Run `ccpm use <team-name>` via Bash, where `<team-name>` is the value the
   user supplied (or chose in step 1).
   - If the user asked to enable Claude Code's experimental agent-teams mode
     (member-to-member messaging via SendMessage), append `--agent-teams` to the
     command: `ccpm use <team-name> --agent-teams`. This writes
     CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1 to .claude/settings.json. It is
     optional and opt-in; some teams (e.g. design-council) enable it automatically.
3. Relay ccpm's full output to the user — do not truncate or paraphrase it.
4. Explicitly repeat the session-restart instruction from ccpm's output:
   agents load at session start only; the switch is NOT instantly active.
   The user must run `/exit` then `claude` to activate the new team.
