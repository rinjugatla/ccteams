# Active Team: research (ccteams)

This project uses the **research** team: technical evaluation before implementation.

## Orchestration rules

- Use **tech-researcher** for any question of the form "which X", "compare A vs B",
  "should we use Y", or "what are the tradeoffs of Z" — before any builder starts work.
- tech-researcher produces a written recommendation only. It does not write code,
  edit files, or make implementation decisions beyond the recommendation.
- After a recommendation is accepted, switch to the appropriate implementation team
  (e.g., `ccteams use go-api`) and hand the decision there. Note: a team switch takes
  effect only at session start — after running `ccteams use`, tell the user to restart
  Claude Code before delegating to the new team's agents.

## When NOT to use this team
- You have already decided on an approach and need it implemented — use a builder team.
- The question is about a bug in existing code — use the debug team.
- The question requires writing or modifying code to answer (e.g., a performance
  spike) — use a builder team for the spike, then return here if needed.

## Team playbook
This team ships `.claude/skills/research-playbook/SKILL.md`. Every delegation prompt to
tech-researcher must begin with: "Read `.claude/skills/research-playbook/SKILL.md` first
and follow its operating loop." Hold the report to the playbook's gates:
- Decision criteria were fixed and weighted before candidates; "do nothing / use the
  incumbent" is scored in the matrix, not skipped.
- Every load-bearing claim carries a source AND a date; single-source and vendor
  benchmarks are marked as such.
- The recommendation is the first thing in the report: one winner + a specific reversal
  condition + confidence + migration cost from the current state.

## Working method (mandatory — every agent on this team)

The full method is installed at `.claude/skills/working-method/SKILL.md`; read it
when in doubt. When delegating, copy this digest verbatim into EVERY delegation
prompt:

> Working method (non-negotiable):
> 1. Restate the goal in one sentence + a "done means" criterion before acting.
> 2. Read the actual files before forming opinions; verify every path/function you reference exists in this project.
> 3. Name your riskiest assumption and check it first, while it is cheap.
> 4. The diff is a claim; execution is evidence. Run the project's build/lint/tests and report their real output.
> 5. Label claims VERIFIED (ran it) / REASONED (read it) / ASSUMED (unchecked) — never upgrade one silently.
> 6. Before finishing: re-read the original request; every requirement met, nothing promised-but-undone.

Also, on every delegation and review:
- If `.claude/skills/team-lessons/SKILL.md` has entries, include the relevant ones
  in the delegation prompt and hold reports to them like playbook rules.
- When a mistake surfaces that neither the playbook nor team-lessons predicted,
  draft an entry (symptom → wrong instinct → correct move) and propose adding it
  to team-lessons.
