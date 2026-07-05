---
name: debug-playbook
description: Operational playbook for systematic debugging — hypothesis ledgers, discriminating experiments, mechanism sentences, minimal fixes, sibling hunts. Read in full at the start of every bug investigation.
---

# Debug Playbook

This is the literal procedure a frontier model follows when debugging. Follow
it step by step; the order is the point. Skipping ahead to "the obvious fix"
is the single most expensive mistake in debugging.

## Operating loop

1. **Capture the failure verbatim.** Copy the exact error text, stack trace,
   failing assertion, or wrong output into your notes before touching
   anything. You will compare against this later — after a change, "a
   different error" and "the same error" are opposite results, and memory
   will lie to you about which one you're seeing.
2. **Reproduce before reasoning.** Run the smallest thing that fails: the one
   test (`<runner> <path>::<test>`), the one request (`curl` the endpoint),
   the one function (a REPL call). If you cannot reproduce, STOP — collect
   environment facts (versions, env vars, data state) and report what's
   missing. Never debug from a description of a failure you haven't seen.
   - Suspected flaky? Run it 10× in a loop and record the failure rate
     before anything else. A 3/10 failure is a different class of bug
     (ordering, time, shared state) than a 10/10 failure.
3. **Read the trace bottom-up, and find YOUR frame.** The deepest frame in
   code you own is where evidence starts. The reported line is where the
   error *surfaced*, not where the bug *lives* — treat it as the end of a
   thread to pull, not the answer.
4. **Write a hypothesis ledger.** List 2–3 candidate causes explicitly (in a
   comment, scratch file, or your working notes). For each: what it predicts
   you'd observe, and the cheapest check that would kill it. Rank by
   (prior probability × cheapness of the check).
5. **Run the discriminating experiment.** Pick the check that produces a
   DIFFERENT result under hypothesis A vs hypothesis B — not the one that
   merely confirms your favorite. Targeted print/log at a boundary, a
   narrowed input, a bisected commit range (`git bisect`), or commenting out
   one layer are all discriminators. One change at a time; revert each probe
   before the next.
6. **State the mechanism sentence.** Before writing any fix, you must be able
   to say: "X causes Y because Z" — where you have OBSERVED X and Y, and Z
   explains why this exact symptom appears (not merely "could appear"). If
   you cannot fill in Z, you have a correlation, not a cause. Return to
   step 4.
7. **Fix at the cause site, minimally.** The fix belongs where the mechanism
   sentence says the defect is — not where the error surfaced. If the fix
   feels large, re-check: you may be redesigning around the bug instead of
   fixing it.
8. **Regression test that fails first.** Write the test, run it against the
   UNFIXED code (stash the fix: `git stash`, run, `git stash pop`), confirm
   it fails with the captured failure — then confirm it passes with the fix.
   A regression test that never failed proves nothing.
9. **Hunt the siblings.** The same defect pattern usually exists elsewhere:
   `grep` for the same call, the same copy-pasted block, the same misused
   API. Report siblings even if fixing them is out of scope.
10. **Full suite + cleanup.** Run the whole test suite, remove every probe
    and debug print, and re-read your diff — the diff should contain the fix
    and the test, nothing else.

## Failure catalog — symptom → wrong instinct → correct move

1. **Test fails** → change the test's expectation to match output → first
   prove which side is wrong: read the spec/requirement or the function's
   contract; the test is code too, but it changes only with evidence.
2. **Error at line N** → fix line N → line N is the surface; walk backwards
   to where the bad value/state was CREATED, fix there.
3. **`undefined`/`nil`/`None` error** → add a null-check at the crash site →
   ask why the value is missing; a null-check at the crash site converts a
   loud bug into a silent one.
4. **Intermittent failure** → re-run until green and move on → a pass after
   a failure is data ABOUT flakiness, not absence of a bug. Loop it 10×;
   look for shared state, ordering dependence, time, and concurrency.
5. **Exception is noisy** → wrap in try/catch (or rescue/except) and log →
   you just hid the bug. Only catch where you can genuinely handle or
   translate the error.
6. **"It works on my machine / in isolation"** → assume the reporter is
   wrong → diff the environments: versions, env vars, data, build artifacts.
   The difference IS the lead.
7. **Change appears to have no effect** → conclude the change is wrong →
   first verify your code is actually running: add a one-line sentinel
   (`print("SENTINEL-1")`) and confirm it appears. Stale builds, wrong file,
   wrong process, and cached artifacts waste hours; the sentinel costs
   seconds.
8. **After a change the error message changes** → "still broken" → a
   DIFFERENT error is progress and information. Diff old vs new error
   verbatim (you captured the old one in step 1); it tells you what the
   change actually did.
9. **The bug seems impossible** → doubt the runtime/library → doubt your
   assumptions first, in this order: wrong file running, wrong branch, stale
   dependency, wrong database/env, test pollution from a previous test.
   Library bugs exist but are the LAST hypothesis, not the first.
10. **Fix works but you don't know why** → ship it → an unexplained fix is
    an unexploded bug. Back it out, confirm the failure returns, and find
    the mechanism sentence. If it doesn't return, your fix was a
    coincidence (timing, cache, rebuild).
11. **Multiple failures at once** → fix them in one pass → fix the FIRST
    failure (chronologically/causally first), re-run everything; downstream
    failures are often cascades of the first.
12. **Long bisect through code** → read everything → bisect through TIME
    instead: `git log` for recent changes to the failing area;
    `git bisect run <cmd>` automates it when a repro command exists.

## Discriminating checks (cheap, in rising order of cost)

- **Sentinel print** — is this code even running? (~10 seconds)
- **Boundary log** — print the value entering and leaving the suspect layer;
  the bug is on the side where the value is already wrong.
- **Input narrowing** — halve the failing input repeatedly until minimal;
  the removed half that restores success localizes the trigger.
- **Layer bypass** — call the inner function directly, skipping the outer
  layer; failure moves with the layer that contains it.
- **git bisect** — when it "worked before", binary-search the history
  instead of the code.
- **Fresh state** — clean build, fresh DB/fixtures, new shell; if the bug
  vanishes, the bug is in state management, and that IS the finding.

## Decision tree — when you are stuck

- 3 hypotheses killed with no survivor? → Re-read the ORIGINAL captured
  error, word by word. You are almost certainly holding one false
  assumption that all three hypotheses shared. Write down what all three
  assumed in common; test THAT.
- Cannot reproduce after 3 attempts? → Stop. Report exactly what you tried,
  what you observed instead, and the 2–3 environment facts that would
  discriminate. Do not "fix" what you cannot see fail.
- Repro requires production data/state you don't have? → Build the minimal
  synthetic state that your leading hypothesis predicts is sufficient. If
  the synthetic state does NOT reproduce, that kills the hypothesis — also
  progress.
- Fix requires touching more than the cause site + test? → The mechanism
  sentence is probably wrong or the "bug" is a design gap. Report the
  distinction explicitly and stop for a decision.

## Verification recipe (before declaring the bug fixed)

1. Regression test fails on unfixed code (stash-run-pop) — REQUIRED, not optional.
2. Regression test passes on fixed code.
3. Full suite passes (or its failures are pre-existing — prove it by running
   the suite on the base commit).
4. All probes/sentinels/debug prints removed — re-read the full diff.
5. The mechanism sentence appears in your report: "X caused Y because Z."
6. Sibling scan done — report `grep` pattern used and hits found.

## Reviewer checklist (bug-reproducer verifying a proposed fix)

1. Does the report contain a mechanism sentence with observed evidence for
   each clause? (No mechanism → reject.)
2. Did the regression test provably fail before the fix? (No stash-run → reject.)
3. Is the fix at the cause site or at the symptom site?
4. Does the fix silently swallow or broaden any error handling?
5. Were siblings hunted? With what pattern?
6. Is anything in the diff unrelated to the fix + test?
