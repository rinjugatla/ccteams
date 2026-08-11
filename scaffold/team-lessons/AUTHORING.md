# team-lessons — layout and authoring rules

This file is for **writers** of lessons: read it when adding or updating an
entry, not on every task. Keeping it out of `SKILL.md` is the point — `SKILL.md`
is what gets loaded whenever the catalog is consulted, so it holds nothing but
the index.

## Layout (SKILL.md = index, lessons/ = bodies)

- `SKILL.md` — the generated index. One line per lesson: the symptom (linked to
  its file) → the one-line correct move.
- `lessons/NN-slug.md` — one lesson per file, holding the full
  symptom → wrong instinct → correct move write-up.
- `scripts/gen-lessons.mjs` — builds the index from the lessons' frontmatter.
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
lesson body and to the `symptom` / `summary` values that become the index lines.
The catalog is read by everyone working in the repo, human and agent alike, so
it should read like the rest of the repo; a catalog in a different language from
the README gets skimmed and then ignored. Keep technical terms, commands, file
paths, and identifiers in their original form rather than translating them.

The mechanical parts stay ASCII whatever the prose language: frontmatter keys
(`id`, `slug`, `symptom`, `summary`, `refs`) and the `slug` in `NN-slug.md` are
lowercase kebab-case, so filenames and links stay predictable everywhere.

## Frontmatter schema (every file in `lessons/`)

```markdown
---
id: 7
slug: worktree-wrong-landing
symptom: <the situation, as the reader will recognize it — becomes the index link text>
summary: <the correct move in one line — becomes the text after the → in the index>
refs: [PR #52, Issue #66]
---
```

- `id` — integer, must be unique; sets the index order (not the filename order).
- `slug` — matches the `slug` part of `NN-slug.md`.
- `symptom` / `summary` — required and non-empty; the generator fails loudly
  rather than emitting a blank index line.
- `refs` — related issues/PRs; use `[]` when there are none.

## Learning loop (how an entry gets added)

Triggered by the working-method learning loop: a mistake surfaced that neither
the team playbook nor this catalog predicted.

1. **Check for a duplicate first.** Keep it lean — if an existing lesson (or the
   team playbook) already covers the case, sharpen that one instead of adding a
   near-duplicate. A bloated catalog gets skimmed, not followed.
2. Create `lessons/NN-slug.md` with the next `id`, the frontmatter above, and a
   body structured as symptom → wrong instinct → correct move. Cross-link
   related lessons as `[NN-slug.md](NN-slug.md)`.
3. Regenerate the index:
   ```
   node .claude/skills/team-lessons/scripts/gen-lessons.mjs
   ```
4. Commit the new lesson file **and** the regenerated `SKILL.md` together.

If the lesson is universal to the stack rather than specific to this project,
also propose it upstream against the team's playbook in the ccteams repo.

## Keeping the committed index honest (CI)

The index is committed, so it can go stale the same way any generated-and-
committed artifact can. Verify it in CI:

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

If this skill was scaffolded by an older ccteams and your `SKILL.md` holds the
lessons inline (no `team-lessons:catalog:*` markers):

1. Move each entry into its own `lessons/NN-slug.md` with the frontmatter above.
2. Replace the catalog section of `SKILL.md` with the two marker lines:
   ```markdown
   <!-- team-lessons:catalog:start -->
   <!-- team-lessons:catalog:end -->
   ```
3. Run the generator; it fills the space between the markers.

The generator refuses to run if the markers are missing, so a half-finished
migration fails loudly instead of writing a mangled file.
