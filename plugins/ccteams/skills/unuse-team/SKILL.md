---
name: unuse-team
description: Remove a named ccteams agent team from the current project by running ccteams unuse <team-name>.
argument-hint: [team-name]
allowed-tools: Bash
---

Remove the agent team specified by the user's argument from the current project.

Steps:
1. If no team name was provided, run `ccteams current` via Bash, show the output, and
   ask the user which applied team they want to remove before proceeding.

2. Run `ccteams unuse <team-name>` via Bash.

   This removes only the named team — any other applied team (and shared files like
   the working-method skill that another applied team still needs) is left untouched.
   If the team removed was the primary (first-applied) team, the next applied team
   becomes primary automatically.

3. Relay ccteams's full output to the user — do not truncate or paraphrase it.

4. Explicitly repeat the session-restart instruction from ccteams's output:
   agents load at session start only; the change is NOT instantly active.
   The user must run `/exit` then `claude` to activate it.
