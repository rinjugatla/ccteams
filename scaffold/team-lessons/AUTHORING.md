# team-lessons — layout and authoring rules

This file is for **writers** of lessons: read it when adding or updating an
entry, not on every task. Keeping it out of `SKILL.md` is the point — `SKILL.md`
is what gets loaded whenever the catalog is consulted, so it holds nothing but
the index.

## Layout (SKILL.md = index, lessons/ = bodies)

- `SKILL.md` — the generated index. One entry per lesson, headed by WHEN to
  read it, with the symptom (linked to its file) and the one-line correct move
  underneath.
- `lessons/NN-slug.md` — one lesson per file, holding the full
  symptom → wrong instinct → correct move write-up.
- `scripts/gen-lessons.mjs` — builds the index from the lessons' frontmatter.
- `scripts/lessons-index.mjs` — prints just the index to stdout, so a Claude
  Code hook (`SessionStart` / `SubagentStart`) can inject it into every session
  and subagent instead of relying on someone remembering to paste it. Registering
  the hook is a step you take yourself, in `.claude/settings.json`; see the
  team-lessons section of the ccteams README for the exact snippet. It prints
  nothing while `lessons/` is empty.
- The section between `<!-- team-lessons:catalog:start -->` and
  `<!-- team-lessons:catalog:end -->` is **generated**. Never hand-edit it; the
  next generator run silently discards your changes. Everything outside the
  markers is hand-written and preserved.

Why generated rather than hand-maintained: an index written by hand drifts the
moment a lesson is added, renumbered, or reworded, and a stale index sends
agents to the wrong lesson (or hides one entirely). Deriving it from each
lesson's own frontmatter makes drift impossible to commit undetected.

## Language

Write lessons in **this project's primary language — the one its README is
written in**, not the language ccteams shipped this file in. That applies to the
lesson body and to the `applies_when` / `symptom` / `summary` values that
become the index lines. The catalog is read by everyone working in the repo,
human and agent alike, so it should read like the rest of the repo; a catalog
in a different language from the README gets skimmed and then ignored. Keep
technical terms, commands, file paths, and identifiers in their original form
rather than translating them.

The mechanical parts stay ASCII whatever the prose language: frontmatter keys
(`id`, `slug`, `applies_when`, `symptom`, `summary`, `refs`) are lowercase
**snake_case** (never kebab-case — a key typo'd as `applies-when` is silently
ignored by the parser rather than erroring, which just falls back to the
legacy heading for that lesson with a stderr warning, so it is worth getting
right). The `slug` value itself, and the `slug` part of the `NN-slug.md`
filename, are lowercase **kebab-case** — so filenames and links stay
predictable everywhere.

## Frontmatter schema (every file in `lessons/`)

```markdown
---
id: 7
slug: worktree-wrong-landing
applies_when: <the moment in the work to read this — becomes the index heading>
symptom: <the situation, as the reader will recognize it — becomes the index link text>
summary: <the correct move in one line — becomes the index's summary line>
refs: [PR #52, Issue #66]
---
```

- `id` — integer, must be unique; sets the index order (not the filename order).
- `slug` — matches the `slug` part of `NN-slug.md`.
- `applies_when` — the moment in the work where the reader should stop and
  check this lesson, written as the index heading a scan can rule in or out
  from its first line. **Write it as an action, not a role.** Prefer the
  action over the role: a reviewer doing the same action needs the same
  lesson just as much as a builder does. Splitting by role instead of action
  means a lesson silently fails to reach whichever role wrote it out —
  usually the reviewer, since a lesson is normally written from the builder's
  own situation first. Phrasing by role adds a filter that doesn't actually
  distinguish who needs the lesson, only a risk of leaving someone out. Prefer:
  ```yaml
  # ✗ scoped to a role — a reviewer doing the same thing gets skipped
  applies_when: when you're the builder

  # ✓ scoped to the action — applies to builder and reviewer alike
  applies_when: when writing an E2E spec / when reviewing one
  ```
  Required for new lessons (see the learning loop below); optional on
  older files — `gen-lessons.mjs` warns but does not fail when it is absent,
  and the index falls back to the pre-`applies_when` heading for that entry.
  Avoid `**bold**` or other Markdown emphasis inside the value: the index
  already wraps it in `**…**`, and a nested `**` breaks the rendered heading.
- `symptom` / `summary` — required and non-empty; the generator fails loudly
  rather than emitting a blank index line. The same `**bold**` caveat applies
  to `symptom`, which is also wrapped in `**…**` in the index.
- `refs` — related issues/PRs; use `[]` when there are none.

## Learning loop (how an entry gets added)

Triggered by the working-method learning loop: a mistake surfaced that neither
the team playbook nor this catalog predicted.

The trigger is a count, not a prediction: the first occurrence of a symptom
is a one-off — watch it, do not record it yet. The second occurrence of the
SAME symptom triggers this loop unconditionally, with no judgment call about
whether it is likely to recur. Count across sessions, working directories,
and agents — the second occurrence anywhere is what triggers it, not the
second occurrence inside one session (a per-session count rarely reaches two).
"Triggers this loop" does not mean "always write a new file": step 1 below
applies first — sharpen an existing lesson if one already covers the symptom.

1. **Check for a duplicate first.** Keep it lean — if an existing lesson (or the
   team playbook) already covers the case, sharpen that one instead of adding a
   near-duplicate. A bloated catalog gets skimmed, not followed.
2. Create `lessons/NN-slug.md` with the next `id`, the frontmatter above — including
   `applies_when`, which is required for every new lesson, phrased as an action
   rather than a role (see above) — and a body structured as symptom → wrong
   instinct → correct move. Cross-link related lessons as
   `[NN-slug.md](NN-slug.md)`.
3. Regenerate the index:
   ```
   node .claude/skills/team-lessons/scripts/gen-lessons.mjs
   ```
4. **Verify before committing — this must exit 0:**
   ```
   node .claude/skills/team-lessons/scripts/gen-lessons.mjs --check
   ```
   This is the same command CI runs (see below), so a failure here is a failure
   you would otherwise discover after pushing. It is redundant when step 3 just
   succeeded, and that is the point: it is what catches the runs where step 3
   was skipped, executed against a different checkout, or where `SKILL.md` was
   edited by hand between the markers. **Do not commit until it passes** — fix
   the cause and re-run step 3 rather than editing `SKILL.md` to match.
5. Commit the new lesson file **and** the regenerated `SKILL.md` together.

If the lesson is universal to the stack rather than specific to this project,
also propose it upstream against the team's playbook in the ccteams repo.

## Keeping the committed index honest (CI)

The index is committed, so it can go stale the same way any generated-and-
committed artifact can. Step 4 above is the author's own check; CI is the
backstop for the commits that skipped it and for edits made outside this
workflow. Run the same command there:

```
node .claude/skills/team-lessons/scripts/gen-lessons.mjs --check
```

`--check` re-derives the index and exits non-zero if the committed `SKILL.md`
differs, which also catches a hand-edit inside the markers. The script is plain
Node ESM with no dependencies, so this works in any project with Node installed.

If your project has a task runner, add a shortcut — e.g. in `package.json`:

```json
"scripts": {
  "gen:lessons": "node .claude/skills/team-lessons/scripts/gen-lessons.mjs"
}
```

## Migrating a pre-existing SKILL.md

If this skill was scaffolded by an older ccteams, `SKILL.md` may not have a
usable pair of `team-lessons:catalog:*` markers: one or both markers may be
missing (an early scaffold held the lessons inline), or no end marker follows
the start marker — a reversed pair lands here too. Either way:

1. Move each entry into its own `lessons/NN-slug.md` with the frontmatter above.
2. Put the two marker lines where the catalog belongs — replacing whatever
   catalog text is still there — in this order:
   ```markdown
   <!-- team-lessons:catalog:start -->
   <!-- team-lessons:catalog:end -->
   ```
3. Run the generator; it fills the space between the markers.

The generator refuses to run until `SKILL.md` contains both markers, in this
order, so a half-finished migration fails loudly instead of writing a mangled
file.
