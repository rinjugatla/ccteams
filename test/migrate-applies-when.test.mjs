/**
 * Tests for teamLessonsAppliesWhenStep (lib/migrate.js) — the `ccteams migrate`
 * step that scans the user-owned `lessons/**` for lesson files missing a usable
 * `applies_when` in their frontmatter, and reports what needs attention without
 * ever writing to `lessons/**` (see the step's own doc comment in lib/migrate.js
 * for the full contract; Issue #61).
 *
 * Uses only node:test + node:assert — the package has no dependencies and the
 * CLI must keep working in projects that have none either. Helpers below mirror
 * test/migrate.test.mjs's own style (mkdtempSync temp project, a minimal v4
 * manifest, id-based step lookup) rather than importing across test files —
 * each test file in this suite is self-contained by convention.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { migrate, teamLessonsAppliesWhenStep } from '../lib/migrate.js';
import { writeManifest } from '../lib/manifest.js';

/** Create a fresh temp project directory (already exists on disk). */
const makeProject = () => mkdtempSync(path.join(tmpdir(), 'ccteams-migrate-applies-when-'));

/** Write a minimal, valid v4 manifest (one applied team, no placed files). */
const applyMinimalManifest = (root) => {
  writeManifest(root, {
    teams: { generalist: { appliedAt: new Date().toISOString(), placedFiles: [], agentTeams: false } },
  });
};

const teamLessonsDir = (root) => path.join(root, '.claude', 'skills', 'team-lessons');
const lessonsDir = (root) => path.join(teamLessonsDir(root), 'lessons');

/**
 * Look a migration step up by its stable `id`, mirroring stepById in
 * test/migrate.test.mjs: an explicit assert here means a renamed/dropped step
 * id fails with a clear message instead of dying on `.notices of undefined`.
 */
const stepById = (result, id) => {
  const step = result.steps.find((s) => s.id === id);
  assert.ok(
    step,
    `no migration step with id "${id}"; present ids: ${result.steps.map((s) => s.id).join(', ')}`,
  );
  return step;
};

const appliesWhenStepOf = (result) => stepById(result, 'team-lessons-applies-when');

/** Write `content` as `lessons/<name>` (creating the directory as needed). */
const writeLesson = (root, name, content) => {
  mkdirSync(lessonsDir(root), { recursive: true });
  writeFileSync(path.join(lessonsDir(root), name), content, 'utf8');
};

/** A complete, valid lesson body with the given `applies_when` frontmatter line included as-is. */
const lessonWithAppliesWhenLine = ({ id, appliesWhenLine }) => `---
id: ${id}
slug: fixture-${id}
${appliesWhenLine}
symptom: something broke
summary: do the right thing
refs: []
---

Body text for fixture lesson ${id}.
`;

/** A complete, valid lesson with no `applies_when` key at all. */
const lessonMissingAppliesWhen = (id) =>
  lessonWithAppliesWhenLine({ id, appliesWhenLine: '' }).replace('\n\nsymptom', '\nsymptom');

/** A complete, valid lesson with `applies_when` set to a real value. */
const lessonWithAppliesWhen = (id, value = 'when doing the fixture thing') =>
  lessonWithAppliesWhenLine({ id, appliesWhenLine: `applies_when: ${value}` });

describe('migrate() — teamLessonsAppliesWhenStep', () => {
  test('missing applies_when: notice names every offending file (2+ files, each asserted individually)', async () => {
    const root = makeProject();
    applyMinimalManifest(root);
    writeLesson(root, '01-first.md', lessonMissingAppliesWhen(1));
    writeLesson(root, '02-second.md', lessonMissingAppliesWhen(2));
    writeLesson(root, '03-third.md', lessonWithAppliesWhen(3)); // has it — must not be listed

    const result = await migrate(root);
    const notices = appliesWhenStepOf(result).notices.join('\n');

    assert.match(notices, /01-first\.md/, `expected 01-first.md in:\n${notices}`);
    assert.match(notices, /02-second\.md/, `expected 02-second.md in:\n${notices}`);
    assert.doesNotMatch(notices, /03-third\.md/, `03-third.md has applies_when and must not be listed:\n${notices}`);
  });

  test('notice references AUTHORING.md, asking Claude Code to fill it in, and the gen-lessons.mjs regenerate command', async () => {
    const root = makeProject();
    applyMinimalManifest(root);
    writeLesson(root, '01-first.md', lessonMissingAppliesWhen(1));

    const result = await migrate(root);
    const notices = appliesWhenStepOf(result).notices.join('\n');

    assert.match(notices, /AUTHORING\.md/, `expected an AUTHORING.md reference in:\n${notices}`);
    assert.match(notices, /Claude Code/, `expected an instruction to ask Claude Code to fill it in:\n${notices}`);
    assert.match(
      notices,
      /node .*scripts\/gen-lessons\.mjs/,
      `expected the regenerate command in:\n${notices}`,
    );
  });

  test('every lesson has applies_when: this step reports no notices', async () => {
    const root = makeProject();
    applyMinimalManifest(root);
    writeLesson(root, '01-first.md', lessonWithAppliesWhen(1));
    writeLesson(root, '02-second.md', lessonWithAppliesWhen(2, 'when doing another fixture thing'));

    const result = await migrate(root);

    assert.deepEqual(appliesWhenStepOf(result).notices, []);
  });

  test('--dry-run and a real run report identical notices; --dry-run stays exitCode 0 with no pending/updates', async () => {
    const root = makeProject();
    applyMinimalManifest(root);
    await migrate(root); // scaffold everything else first, so only the lesson below is pending
    writeLesson(root, '01-first.md', lessonMissingAppliesWhen(1));

    const dryResult = await migrate(root, { dryRun: true });
    const realResult = await migrate(root, { dryRun: false });

    assert.deepEqual(appliesWhenStepOf(dryResult).notices, appliesWhenStepOf(realResult).notices);
    assert.ok(appliesWhenStepOf(dryResult).notices.length > 0, 'sanity check: the finding is actually present');
    // A missing-applies_when finding is advisory only — it must never move the
    // exitCode, unlike a genuinely pending/updatable file (see migrate()'s own
    // exitCode rule and the notices contract in lib/migrate.js).
    assert.equal(dryResult.exitCode, 0);
    assert.equal(dryResult.pending, 0);
    assert.equal(dryResult.updates, 0);
  });

  test('a malformed lesson (bad id, empty symptom) does not abort migrate(); other lessons are still checked', async () => {
    const root = makeProject();
    applyMinimalManifest(root);
    // Invalid per gen-lessons.mjs's own loadLessons: non-integer id AND empty
    // symptom — this step must not use loadLessons (which would throw and
    // abort the whole migrate() run), so this file must not crash anything.
    writeLesson(
      root,
      '01-bad.md',
      `---
id: not-an-integer
slug: bad
applies_when: when something bad happens
symptom:
summary: fix it
refs: []
---

Malformed fixture lesson.
`,
    );
    writeLesson(root, '02-good.md', lessonMissingAppliesWhen(2));

    const result = await migrate(root);

    assert.equal(result.success, true);
    const notices = appliesWhenStepOf(result).notices.join('\n');
    assert.match(notices, /02-good\.md/, `the well-formed lesson must still be detected:\n${notices}`);
  });

  test('a file with no frontmatter block is reported as "could not be checked", not as missing applies_when', async () => {
    const root = makeProject();
    applyMinimalManifest(root);
    writeLesson(root, '01-no-frontmatter.md', 'Just a plain markdown file with no frontmatter block at all.\n');

    const result = await migrate(root);
    const notices = appliesWhenStepOf(result).notices;

    // Assert BLOCK MEMBERSHIP, not a single order-dependent regex over the
    // whole joined text: buildTeamLessonsAppliesWhenNotices() always renders
    // the "missing applies_when" `!` block (if any) BEFORE the "could not be
    // checked" `!` block (if any) — see its own doc comment on the two
    // findings being independent, ordered blocks — so slicing on the second
    // block's own heading line reliably separates "everything belonging to
    // the missing-applies_when block" from "everything belonging to the
    // could-not-be-checked block", regardless of which phrase happens to
    // come first or second textually within a single joined string. A prior
    // version of this test used
    // `assert.doesNotMatch(joined, /01-no-frontmatter\.md.*no "applies_when"/s)`,
    // which only fails when the FILE NAME happens to precede the phrase in
    // the joined text — it passes just as readily when the file is
    // (incorrectly) classified into the wrong block, as long as that
    // block's own heading text does not literally contain "no \"applies_when\""
    // after the filename. This version fails for the right reason: the file
    // must be in the unreadable slice and ABSENT from the missing slice.
    const unreadableHeadingIndex = notices.findIndex((line) => line.includes('could not be checked'));
    assert.notEqual(unreadableHeadingIndex, -1, `expected a "could not be checked" block in:\n${notices.join('\n')}`);
    const missingBlock = notices.slice(0, unreadableHeadingIndex).join('\n');
    const unreadableBlock = notices.slice(unreadableHeadingIndex).join('\n');

    assert.match(unreadableBlock, /01-no-frontmatter\.md/, `expected the file in the unreadable block:\n${unreadableBlock}`);
    assert.doesNotMatch(missingBlock, /01-no-frontmatter\.md/, `the file must not also appear in the missing-applies_when block:\n${missingBlock}`);
  });

  /**
   * The test above slices `notices` at the "could not be checked" heading and
   * treats everything BEFORE it as the missing-applies_when block. That slice
   * is only meaningful if the two blocks are actually emitted in that order,
   * which the test above cannot check on its own: it produces a file for the
   * unreadable block only, so its "missing" slice is empty either way. This
   * test is the one that pins the ordering, by producing BOTH findings at once
   * and asserting each file lands in its own block — so a future reordering of
   * the two blocks in buildTeamLessonsAppliesWhenNotices() fails here loudly
   * instead of silently turning the slice above into a no-op.
   */
  test('both findings at once: each file lands in its own block, missing block first', async () => {
    const root = makeProject();
    applyMinimalManifest(root);
    writeLesson(root, '01-missing.md', lessonMissingAppliesWhen(1));
    writeLesson(root, '02-no-frontmatter.md', 'No frontmatter block here at all.\n');

    const result = await migrate(root);
    const notices = appliesWhenStepOf(result).notices;

    const unreadableHeadingIndex = notices.findIndex((line) => line.includes('could not be checked'));
    assert.notEqual(unreadableHeadingIndex, -1, `expected a "could not be checked" block in:\n${notices.join('\n')}`);
    // Both blocks must be present, and the missing block must come FIRST —
    // otherwise the slice is empty and the assertions below prove nothing.
    assert.ok(
      unreadableHeadingIndex > 0,
      `the missing-applies_when block must be emitted BEFORE the unreadable block; got:\n${notices.join('\n')}`,
    );
    const missingBlock = notices.slice(0, unreadableHeadingIndex).join('\n');
    const unreadableBlock = notices.slice(unreadableHeadingIndex).join('\n');

    assert.match(missingBlock, /01-missing\.md/, `expected 01-missing.md in the missing block:\n${missingBlock}`);
    assert.doesNotMatch(missingBlock, /02-no-frontmatter\.md/, `02-no-frontmatter.md must not be in the missing block:\n${missingBlock}`);
    assert.match(unreadableBlock, /02-no-frontmatter\.md/, `expected 02-no-frontmatter.md in the unreadable block:\n${unreadableBlock}`);
    assert.doesNotMatch(unreadableBlock, /01-missing\.md/, `01-missing.md must not be in the unreadable block:\n${unreadableBlock}`);
  });

  test('whitespace-only and array-form applies_when are both treated as missing', async () => {
    const root = makeProject();
    applyMinimalManifest(root);
    writeLesson(
      root,
      '01-whitespace.md',
      lessonWithAppliesWhenLine({ id: 1, appliesWhenLine: 'applies_when:    ' }),
    );
    writeLesson(
      root,
      '02-array.md',
      lessonWithAppliesWhenLine({ id: 2, appliesWhenLine: 'applies_when: [a, b]' }),
    );

    const result = await migrate(root);
    const notices = appliesWhenStepOf(result).notices.join('\n');

    assert.match(notices, /01-whitespace\.md/, `expected the whitespace-only file in:\n${notices}`);
    assert.match(notices, /02-array\.md/, `expected the array-form file in:\n${notices}`);
  });

  test('lessons/ holds only the scaffolded .gitkeep: notices are empty', async () => {
    // A REAL run has already scaffolded lessons/.gitkeep by the time this
    // step runs (teamLessonsScaffoldStep runs first — see MIGRATION_STEPS),
    // so lessonsDir DOES exist here; this exercises the "directory exists,
    // filtered to zero .md files" path, not the "directory absent" early
    // return (see the dry-run test right below for that one).
    const root = makeProject();
    applyMinimalManifest(root);

    const result = await migrate(root);

    assert.equal(existsSync(lessonsDir(root)), true, 'sanity check: scaffold already created lessons/.gitkeep');
    assert.deepEqual(appliesWhenStepOf(result).notices, []);
  });

  test('--dry-run on a project with no lessons/ directory yet: notices are empty', async () => {
    // --dry-run never writes (teamLessonsScaffoldStep included), so unlike
    // the test above, lessons/ genuinely does not exist yet here — this is
    // what exercises `if (!fs.existsSync(lessonsDir)) return empty;`'s early
    // return. Without it, readdirSync(lessonsDir) would throw ENOENT and
    // this step would wrongly print a "could not be listed" notice on every
    // fresh project's dry-run.
    const root = makeProject();
    applyMinimalManifest(root);

    const result = await migrate(root, { dryRun: true });

    assert.equal(existsSync(lessonsDir(root)), false, 'sanity check: dry-run must not have created lessons/');
    assert.deepEqual(appliesWhenStepOf(result).notices, []);
  });

  test('this step never adds or updates anything, even when it has findings', async () => {
    const root = makeProject();
    applyMinimalManifest(root);
    writeLesson(root, '01-first.md', lessonMissingAppliesWhen(1));

    const result = await migrate(root);
    const step = appliesWhenStepOf(result);

    assert.deepEqual(step.added, []);
    assert.deepEqual(step.updated, []);
  });

  /**
   * Calls teamLessonsAppliesWhenStep.run() DIRECTLY rather than going through
   * migrate() — the only test in this file to do so. That is deliberate, not
   * a stylistic shortcut: migrate() runs teamLessonsScaffoldStep BEFORE this
   * step (see MIGRATION_STEPS), and teamLessonsScaffoldStep throws outright
   * when something other than a directory squats on
   * `.claude/skills/team-lessons` itself (its own non-directory guard) —
   * which is the same fixture shape needed to make `lessons/` a plain file.
   * A migrate()-driven fixture that instead makes only the INNER `lessons/`
   * path a file (leaving `.claude/skills/team-lessons` itself a real
   * directory) never reaches teamLessonsScaffoldStep's guard, but
   * teamLessonsScaffoldStep's own scaffold call would then try to write
   * INSIDE `lessons/` (e.g. `lessons/.gitkeep`) and throw its own,
   * differently-worded failure first — so `migrate()` never reaches this
   * step's own `readdirSync` catch in EITHER shape. The only way to exercise
   * that catch block at all is to build ctx by hand and call `.run()` on the
   * step directly, matching the sibling `run(ctx) = { projectRoot,
   * dotClaudeDir, ... }` shape documented in lib/migrate.js. `dryRun: false`
   * is passed EXPLICITLY even though this step's `run()` never reads it (it
   * never writes anything — see its own `added`/`updated` contract): omitting
   * it would leave `ctx.dryRun` as `undefined`, which a future `run()` that
   * DID start reading it would silently treat as falsy, letting this test keep
   * passing for the wrong reason. `yes`/`force`/`promptFn` stay omitted — this
   * step never prompts, so there is no such ambiguity to remove for them.
   */
  test('readdirSync failure on lessons/ is reported, not thrown', () => {
    const root = makeProject();
    const dotClaudeDir = path.join(root, '.claude');
    mkdirSync(path.join(dotClaudeDir, 'skills', 'team-lessons'), { recursive: true });
    // `lessons` is a plain FILE here, not a directory — readdirSync() on it
    // throws ENOTDIR, the case this step's catch block must convert into a
    // notice instead of letting propagate.
    writeFileSync(path.join(dotClaudeDir, 'skills', 'team-lessons', 'lessons'), 'not a directory\n', 'utf8');

    let result;
    assert.doesNotThrow(() => {
      result = teamLessonsAppliesWhenStep.run({ projectRoot: root, dotClaudeDir, dryRun: false });
    });

    assert.deepEqual(result.added, []);
    assert.deepEqual(result.updated, []);
    assert.deepEqual(result.kept, []);
    assert.equal(result.notices.length, 3, `expected exactly 3 notice lines, got:\n${result.notices.join('\n')}`);
    assert.match(result.notices[0], /lessons\/ exists but could not be listed \(ENOTDIR\)/);
  });
});
