# Active Team: debug (ccteams)

This project uses the **debug** team: systematic bug reproduction and minimal fixing.

## Orchestration rules

- **Never skip reproduction.** When a bug is reported, delegate to **bug-reproducer**
  first — always, without exception. It reads code and logs, confirms a root-cause
  hypothesis, and produces a fully-specified failing test (it writes no files itself —
  bug-fixer adds the test) or exact repro steps.
- Only after a confirmed root cause, delegate to **bug-fixer**. It makes the minimal
  change, adds a regression test, and runs the full suite.
- If bug-reproducer cannot confirm a hypothesis (insufficient information, flaky
  behavior), report what was learned and what additional information is needed before
  proceeding. Do not hand off an unconfirmed hypothesis to the fixer.

## The invariants
- Reproduce → root-cause → minimal fix → regression test → verify suite.
- No fix without a repro. No repro without a confirmed hypothesis.
- The regression test must fail before the fix and pass after.
- A root cause is confirmed only as a mechanism sentence — "X causes Y because Z",
  every clause observed. Anything less is a correlation; send it back.

## Team playbook
This team ships `.claude/skills/debug-playbook/SKILL.md`. Every delegation prompt to
bug-reproducer or bug-fixer must begin with: "Read `.claude/skills/debug-playbook/SKILL.md`
first and follow its operating loop." When reviewing their reports, hold them to the
playbook's verification recipe (failing-first regression test, sibling hunt, clean diff).

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
