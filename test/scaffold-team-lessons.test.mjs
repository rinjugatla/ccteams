/**
 * Tests for scaffoldTeamLessons() — the never-overwrite contract for the
 * user-owned team-lessons skill.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { scaffoldTeamLessons, TEAM_LESSONS_SCAFFOLD_DIR } from '../lib/use.js';
import {
  CATALOG_START,
  CATALOG_END,
  GENERATED_NOTE,
} from '../scaffold/team-lessons/scripts/gen-lessons.mjs';

const makeDest = () => path.join(mkdtempSync(path.join(tmpdir(), 'ccteams-lessons-')), 'team-lessons');

const OLD_STYLE_SKILL = `---
name: team-lessons
---

## Failure catalog — symptom → wrong instinct → correct move

(none yet)
`;

/**
 * The SKILL.md this package currently ships (the reference "new layout"),
 * normalized to LF. git may check the template out with CRLF (it does on
 * Windows with core.autocrlf=true), and the fixtures below rewrite the file
 * around line boundaries — matching on '\n' against a CRLF file silently does
 * nothing, so normalize once here instead of at every call site.
 */
const currentSkill = () =>
  readFileSync(path.join(TEAM_LESSONS_SCAFFOLD_DIR, 'SKILL.md'), 'utf8').replace(/\r\n/g, '\n');

/**
 * The same file in the pre-0.4 layout: markers present and ordered, but the
 * generated note still INSIDE them. Derived from the shipped template rather
 * than hand-written so it cannot drift away from the real file.
 */
function legacyIndexSkill() {
  const current = currentSkill();
  const legacy = current.replace(
    `${GENERATED_NOTE}\n${CATALOG_START}\n`,
    `${CATALOG_START}\n${GENERATED_NOTE}\n`,
  );
  assert.notEqual(legacy, current, 'fixture is stale: the shipped SKILL.md no longer has the note above the start marker');
  return legacy;
}

/**
 * The same file with a hand-written sentence that QUOTES the end marker in the
 * prose ABOVE the catalog region — a SKILL.md is allowed to document its own
 * generated section. Searching for the end marker from the top of the file
 * finds THIS occurrence, which precedes the start marker, and would report a
 * healthy file as needing migration. Applied on top of either layout fixture.
 */
function withEndMarkerQuotedInProse(skill) {
  const heading = '## Failure catalog';
  const quoted = skill.replace(heading, `The generated region ends at ${CATALOG_END}.\n\n${heading}`);
  assert.notEqual(quoted, skill, 'fixture is stale: the shipped SKILL.md no longer has a "## Failure catalog" heading');
  return quoted;
}

describe('scaffoldTeamLessons', () => {
  test('creates the whole skill when nothing exists yet', () => {
    const dest = makeDest();
    const result = scaffoldTeamLessons(dest);

    assert.deepEqual(result.created.map((p) => p.replace(/\\/g, '/')).sort(), [
      'AUTHORING.md',
      'SKILL.md',
      'lessons/.gitkeep',
      'scripts/gen-lessons.mjs',
      'scripts/lessons-index.mjs',
      'scripts/template-version.mjs',
    ]);
    assert.deepEqual(result.preserved, []);
    // Nothing pre-existed, so there is no legacy layout to report either way.
    assert.equal(result.needsMigration, false);
    assert.equal(result.hasLegacyIndexLayout, false);
    // lessons/ ships a .gitkeep so the folder is committed and its purpose is
    // discoverable before the first lesson exists.
    assert.ok(existsSync(path.join(dest, 'lessons', '.gitkeep')));
  });

  test('is idempotent and never overwrites user edits', () => {
    const dest = makeDest();
    scaffoldTeamLessons(dest);

    const skillPath = path.join(dest, 'SKILL.md');
    const edited = readFileSync(skillPath, 'utf8') + '\nhand-written note\n';
    writeFileSync(skillPath, edited, 'utf8');

    const second = scaffoldTeamLessons(dest);
    assert.deepEqual(second.created, []);
    assert.equal(second.preserved.length, 6);
    assert.equal(readFileSync(skillPath, 'utf8'), edited);
  });

  test('backfills only the missing files for an older single-file install', () => {
    const dest = makeDest();
    mkdirSync(dest, { recursive: true });
    writeFileSync(path.join(dest, 'SKILL.md'), OLD_STYLE_SKILL, 'utf8');

    const result = scaffoldTeamLessons(dest);

    assert.deepEqual(result.preserved, ['SKILL.md']);
    assert.deepEqual(result.created.map((p) => p.replace(/\\/g, '/')).sort(), [
      'AUTHORING.md',
      'lessons/.gitkeep',
      'scripts/gen-lessons.mjs',
      'scripts/lessons-index.mjs',
      'scripts/template-version.mjs',
    ]);
    assert.equal(readFileSync(path.join(dest, 'SKILL.md'), 'utf8'), OLD_STYLE_SKILL);
    // No catalog markers → the generator would refuse to run, so `use` reports
    // the migration instead of silently shipping a script that errors.
    assert.equal(result.needsMigration, true);
    // Exclusive with the other finding: without markers there is no "inside the
    // markers" for a stale note to be in.
    assert.equal(result.hasLegacyIndexLayout, false);
  });

  test('does not report a migration when the existing SKILL.md has markers', () => {
    const dest = makeDest();
    mkdirSync(dest, { recursive: true });
    writeFileSync(path.join(dest, 'SKILL.md'), currentSkill(), 'utf8');

    const result = scaffoldTeamLessons(dest);
    assert.equal(result.needsMigration, false);
    // The current layout must not be misreported as legacy.
    assert.equal(result.hasLegacyIndexLayout, false);
  });

  test('reports the legacy layout when the generated note sits inside the markers', () => {
    const dest = makeDest();
    mkdirSync(dest, { recursive: true });
    const legacy = legacyIndexSkill();
    writeFileSync(path.join(dest, 'SKILL.md'), legacy, 'utf8');

    const result = scaffoldTeamLessons(dest);

    assert.equal(result.hasLegacyIndexLayout, true);
    // Markers are present and ordered, so the generator CAN run — this is not
    // the "no markers" case.
    assert.equal(result.needsMigration, false);
    assert.equal(readFileSync(path.join(dest, 'SKILL.md'), 'utf8'), legacy);
  });

  test('an end-marker string quoted above the markers is not reported as a migration', () => {
    const dest = makeDest();
    mkdirSync(dest, { recursive: true });
    writeFileSync(path.join(dest, 'SKILL.md'), withEndMarkerQuotedInProse(currentSkill()), 'utf8');

    const result = scaffoldTeamLessons(dest);

    assert.equal(result.needsMigration, false);
    // The current layout keeps the note above the start marker, so nothing
    // inside the markers makes this the legacy layout either.
    assert.equal(result.hasLegacyIndexLayout, false);
  });

  test('an end-marker string quoted above the markers still lets the legacy layout be detected', () => {
    const dest = makeDest();
    mkdirSync(dest, { recursive: true });
    writeFileSync(path.join(dest, 'SKILL.md'), withEndMarkerQuotedInProse(legacyIndexSkill()), 'utf8');

    const result = scaffoldTeamLessons(dest);

    // Misreading the quoted marker as the end of the region would classify this
    // as (a) and hide the finding the user can actually act on.
    assert.equal(result.needsMigration, false);
    assert.equal(result.hasLegacyIndexLayout, true);
  });

  test('reversed markers (END before START) count as needing migration, not as the legacy layout', () => {
    const dest = makeDest();
    mkdirSync(dest, { recursive: true });
    // Both markers exist, so only the ORDER check separates this from a healthy
    // file — and buildSkill() throws on it exactly as it does on a missing pair.
    writeFileSync(
      path.join(dest, 'SKILL.md'),
      `---\nname: team-lessons\n---\n\n${CATALOG_END}\n\n(none yet)\n${CATALOG_START}\n`,
      'utf8',
    );

    const result = scaffoldTeamLessons(dest);

    assert.equal(result.needsMigration, true);
    assert.equal(result.hasLegacyIndexLayout, false);
  });

  test('a note both outside AND inside the markers still counts as the legacy layout', () => {
    const dest = makeDest();
    mkdirSync(dest, { recursive: true });
    // A half-finished manual migration: the new note was added above the start
    // marker but the old one below it was never removed.
    writeFileSync(
      path.join(dest, 'SKILL.md'),
      currentSkill().replace(`${CATALOG_START}\n`, `${CATALOG_START}\n${GENERATED_NOTE}\n`),
      'utf8',
    );

    const result = scaffoldTeamLessons(dest);

    assert.equal(result.hasLegacyIndexLayout, true);
    assert.equal(result.needsMigration, false);
  });

  test('detects the legacy layout in a CRLF file too', () => {
    const dest = makeDest();
    mkdirSync(dest, { recursive: true });
    // The markers and the generated note are single-line literals, so detection
    // needs no line-ending normalization — this pins that down.
    writeFileSync(path.join(dest, 'SKILL.md'), legacyIndexSkill().replace(/\n/g, '\r\n'), 'utf8');

    const result = scaffoldTeamLessons(dest);
    assert.equal(result.hasLegacyIndexLayout, true);
    assert.equal(result.needsMigration, false);
  });

  test('a hand-written comment between the markers is not reported as the legacy layout', () => {
    const dest = makeDest();
    mkdirSync(dest, { recursive: true });
    writeFileSync(
      path.join(dest, 'SKILL.md'),
      currentSkill().replace(`${CATALOG_START}\n`, `${CATALOG_START}\n<!-- a note of my own -->\n`),
      'utf8',
    );

    const result = scaffoldTeamLessons(dest);

    // Detection keys on the GENERATED_NOTE literal, not on "any comment", so a
    // user's own comment does not trigger a false "your file is out of date".
    assert.equal(result.hasLegacyIndexLayout, false);
    // The markers themselves are untouched — present and ordered — so the
    // generator CAN run and the user's comment must not be reported as a
    // migration either. Pinning only the flag above would let a regression that
    // classifies ANY extra line inside the markers as "needs migration" pass.
    assert.equal(result.needsMigration, false);
  });
});
