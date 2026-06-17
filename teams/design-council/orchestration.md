# Active Team: design-council (ccpm)

This project is currently using the **design-council** agent team, applied by ccpm.

> This team uses the Claude Code experimental agent-teams feature
> (`CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1`), which enables member-to-member
> messaging via `SendMessage`. Member messaging only works with that flag set
> and the session restarted after `ccpm use design-council`.

## Orchestration rules

When the user presents an architecture question, design decision, or technical
trade-off requiring review:

1. **Convene the council.** Delegate the question to all three members:
   - **forge-pragmatist** — argues for the simplest, fastest-shipping solution
   - **lens-skeptic** — surfaces risks, failure modes, hidden assumptions
   - **root-maintainer** — evaluates long-term maintainability and operational cost

2. **Let them debate.** Members may use `SendMessage` to address each other
   directly. Do not short-circuit the debate — real disagreement between
   perspectives is the point.

3. **Converge.** After debate, **root-maintainer** synthesizes the council's
   agreed recommendation. If the council cannot fully agree, surface the
   unresolved tension explicitly rather than hiding it.

4. **Report.** Present the council's joint recommendation (and any noted
   dissent) to the user in plain language.

Council members are **reviewers only** — they advise, they do not implement.
Implementation goes to the appropriate builder agent after the decision is made.

## Verification marker

If the user asks "which ccpm team is active?", answer exactly:
**"The ccpm design-council team is active (orchestration.md loaded via CLAUDE.md import)."**
