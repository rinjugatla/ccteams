---
name: research-playbook
description: Operational playbook for technical evaluation — project-first framing, criteria-before-candidates, source triangulation with dates, evidence-cited tradeoff matrices, and recommendation-first reporting. Read in full at the start of every task on this team.
---

# Research Playbook

This is the literal procedure a frontier model follows to evaluate a technical
choice and write a recommendation. This team writes no code. The order is the
point: defining criteria AFTER seeing candidates is how motivated reasoning
sneaks in, and it is the single most expensive mistake in research.

## Operating loop

1. **Read the PROJECT first — the recommendation lives in its constraints.** A
   generic "A vs B" comparison is worthless; the same question has opposite
   answers in different projects. Before searching the web, read the repo:
   - Stack, language, framework, and their VERSIONS (from lockfiles /
     dependency files, not memory — a project on framework v2 can't use a
     library that needs v5).
   - Deployment target (serverless, container, edge, on-prem), team size, and
     what is ALREADY installed (an incumbent that half-solves the problem
     changes the math entirely).
   - What the user actually needs the tech to DO — restate it in one sentence,
     including any constraint they didn't say out loud (license, bundle size,
     sync/async, data residency).
2. **Define 3–6 weighted decision criteria FROM those constraints, BEFORE
   looking at candidates.** Write them down first. Weight them (e.g., "fit for
   async: high; maintenance health: high; migration cost: medium; license:
   gate"). Fixing criteria before candidates is what prevents you from
   reverse-engineering criteria to justify a favorite.
3. **Enumerate candidates, INCLUDING "do nothing / use what's already
   installed."** 2–4 real candidates plus the null option. The incumbent is
   always a candidate; skipping it biases toward change. If the question names
   candidates, start there and add any obvious omission.
4. **Triangulate each candidate across independent source types, and record
   the DATE of every source:**
   - Official docs — for the feature set and the CURRENT major version.
   - Changelog / release history — release cadence, is it still shipping?
   - GitHub issues/PRs — maintainer responsiveness, date of last release, open
     critical-bug count, "is this abandoned" signal.
   - Independent posts/benchmarks — for real-world failure modes docs omit.
   A claim from one source type is a lead, not a fact; confirm load-bearing
   claims from a second, independent source.
5. **Build a tradeoff matrix where every cell cites evidence.** Rows =
   candidates (including "do nothing"), columns = your criteria. No cell may be
   a vibe: each is a fact + source + date, or an explicit "unknown — could not
   verify." An empty or unsourced cell is a hole to fill, not a cell to guess.
6. **Lead the report with the recommendation.** First line names ONE winner.
   Then: the reversal condition ("choose B instead if <specific, checkable
   condition>"), your confidence (high/medium/low + why), and the migration
   cost FROM THE CURRENT STATE (not from zero). Rationale and matrix follow;
   they justify the call, they don't bury it.

## Failure catalog — methodology mistake → why it's wrong → correct move

1. **Recommending by GitHub stars / popularity** → popularity measures
   adoption timing and marketing, not fit for THIS project → score against your
   weighted criteria; a less-popular tool that fits the constraints wins.
2. **Ignoring migration cost from the incumbent** → the "better" tool can cost
   more to adopt than it saves → always score "do nothing" and state migration
   cost from the current state, in the recommendation.
3. **Version-blind advice** → citing docs/tutorials for v2 while the project
   installs v5 (or vice versa) → check the project's pinned version FIRST, read
   the docs FOR THAT major version, and label every version-specific claim with
   its version.
4. **Single-source claim** → one blog/one benchmark can be wrong, stale, or
   paid → confirm every load-bearing claim from a second, independent source
   type; if you can't, mark it "single-source, unverified."
5. **Vendor benchmark credulity** → a vendor's "3x faster" is marketing until
   proven → label it "vendor-claimed," seek an independent benchmark, and note
   the test conditions (they rarely match yours).
6. **Novelty for its own sake** → "it's the modern way" is not a reason → a new
   tool earns its place only by uniquely satisfying a criterion the incumbent
   fails; name that criterion or don't recommend it.
7. **Ignoring maintenance signals** → last release 18 months ago, issues piling
   up unanswered → check last-release date and maintainer responsiveness; an
   unmaintained dependency is a future migration you're signing up for.
8. **Answering a different question than asked** → drifting to the interesting
   question instead of the user's → re-read the request; if you're recommending
   on axis Y when they asked about axis X, stop and realign (or flag the
   mismatch explicitly).
9. **Burying the recommendation** → a balanced essay that never commits leaves
   the user to decide with less context than you now have → the winner is the
   first line; ambivalence is stated as a tie-breaker, not as a shrug.
10. **Missing reversal condition** → "use A" with no "unless…" is
    unfalsifiable and useless when their situation shifts → every recommendation
    ships with a specific, checkable condition under which the answer flips.
11. **Criteria invented after seeing candidates** → you'll pick criteria your
    favorite happens to win → criteria are written and weighted in loop step 2,
    before candidate research; if new information forces a criterion change, say
    so explicitly and re-score all candidates.

## Discriminating checks (cheap, before committing to a claim)

- **Is this the project's actual version?** Open the lockfile/dependency file;
  don't trust the latest-docs URL you happened to land on.
- **When was this source published?** No date → treat as undated and
  low-trust. A 2021 benchmark of a fast-moving library is nearly worthless now.
- **Is this claim independent of the vendor?** Vendor domain, sponsored post, or
  the tool's own README benchmark → "vendor-claimed" until an independent source
  confirms.
- **Is the project still alive?** Last release date + last-30-days issue
  activity on GitHub. Archived/read-only repo → near-automatic disqualifier.
- **Would this criterion change my ranking?** If two candidates tie on a
  criterion, it's not discriminating — drop its weight and find one that is.
- **Does "do nothing" actually lose?** If you can't articulate why the incumbent
  fails a weighted criterion, the honest recommendation may be "keep what you
  have."

## Decision trees

**(a) How many candidates to evaluate:**
- Question names specific options? → evaluate those + "do nothing" + at most one
  obvious omission. Don't pad to look thorough.
- Open-ended ("what should I use for X")? → shortlist to 2–4 that plausibly meet
  the gating criteria (license, version, runtime), plus "do nothing." Reject the
  rest in one line each so the user sees they were considered.

**(b) When sources disagree:**
- Official docs vs a blog post? → docs win for CURRENT behavior, but check the
  docs' version and date; a blog may be reporting a real bug the docs omit.
- Two independent benchmarks disagree? → report the RANGE and the differing test
  conditions; do not average them into a false precision.
- Can't resolve a load-bearing disagreement? → mark the cell "disputed," lower
  your confidence, and make it an open question in the report.

**(c) What confidence to state:**
- Multiple independent sources agree, versions match the project, criteria are
  clearly discriminating? → HIGH.
- Some claims single-sourced or version-approximate, but the ranking is robust
  to those uncertainties? → MEDIUM; name the uncertainties.
- Key claims unverifiable, or the ranking flips on an unknown? → LOW; say what
  evidence would raise it, and recommend a spike rather than a commitment.

## Verification recipe (before delivering the report)

1. Every load-bearing claim carries a source AND a date. Scan the report: any
   claim without both is either fixed or explicitly downgraded to "unverified."
2. No empty or vibes-based matrix cell — each is fact+source+date or an explicit
   "unknown."
3. The recommendation names a single winner + a specific reversal condition +
   a confidence level + the migration cost from the current state.
4. "Do nothing / use the incumbent" was scored in the matrix, not skipped.
5. The report answers the question that was ASKED (re-read the original
   request) — not an adjacent one you found more interesting.
6. The recommendation is the FIRST thing in the report, not the conclusion of an
   essay.

## Self-review checklist (single-agent team — audit your own report before sending)

This team has one agent; you are your own reviewer. Run this list adversarially,
as if trying to reject the report:

1. Could a reader flip my recommendation by pointing to a constraint I ignored?
   (Re-check the project's versions, deployment target, incumbent.)
2. Did I define criteria before or after I knew which tool I liked? (If after,
   re-derive from constraints and re-score.)
3. Which claims rest on a single source or a vendor's own numbers? (Mark or
   confirm each.)
4. Is any matrix cell a guess wearing a fact's clothes? (Replace with sourced
   fact or "unknown.")
5. Did I score "do nothing," and can I state exactly why it loses (or doesn't)?
6. Is the reversal condition specific and checkable, or a hedge? ("if needs
   change" is a hedge; "if you add a second write region" is checkable.)
7. Am I answering the user's question, at the altitude they asked it?
