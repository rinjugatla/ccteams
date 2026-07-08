---
name: use-team
description: Apply (stack) a named ccteams agent team onto the current project by running ccteams use <team-name>. Additive — existing applied teams are kept.
argument-hint: [team-name]
allowed-tools: Bash
---

Apply the agent team specified by the user's argument to the current project. This is
additive: any team already applied stays applied — the new team is stacked alongside
it, not swapped in. The first team ever applied to a project remains the primary team
(its orchestration rules govern the project) unless it is later removed with
`ccteams unuse`.

Steps:
1. If no team name was provided, run `ccteams list` via Bash, show the output, and
   ask the user which team they want to apply before proceeding.

2. Decide whether to pass `--agent-teams`:
   - Pass `--agent-teams` if the user's request uses any of these phrases or clear
     synonyms: "agent-teams mode", "collaborative", "team mode", "teammates working
     in parallel", "have them work together", "parallel teammates", "member messaging".
   - Otherwise, run the plain form.

3. Run the appropriate command via Bash:
   - With flag:    `ccteams use <team-name> --agent-teams`
   - Without flag: `ccteams use <team-name>`

   `--agent-teams` enables Claude Code's experimental agent-teams feature
   (CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1 in .claude/settings.json), which allows
   teammates to message each other. It is opt-in; you never add it unless the user asked.

4. Relay ccteams's full output to the user — do not truncate or paraphrase it.

5. Explicitly repeat the session-restart instruction from ccteams's output:
   agents load at session start only; the change is NOT instantly active.
   The user must run `/exit` then `claude` to activate the applied team.
