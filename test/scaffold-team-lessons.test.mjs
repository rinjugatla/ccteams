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

const makeDest = () => path.join(mkdtempSync(path.join(tmpdir(), 'ccteams-lessons-')), 'team-lessons');

const OLD_STYLE_SKILL = `---
name: team-lessons
---

## Failure catalog — symptom → wrong instinct → correct move

(none yet)
`;

describe('scaffoldTeamLessons', () => {
  test('creates the whole skill when nothing exists yet', () => {
    const dest = makeDest();
    const result = scaffoldTeamLessons(dest);

    assert.deepEqual(result.created.map((p) => p.replace(/\\/g, '/')).sort(), [
      'AUTHORING.md',
      'SKILL.md',
      'lessons/.gitkeep',
      'scripts/gen-lessons.mjs',
    ]);
    assert.deepEqual(result.preserved, []);
    assert.equal(result.needsMigration, false);
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
    assert.equal(second.preserved.length, 4);
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
    ]);
    assert.equal(readFileSync(path.join(dest, 'SKILL.md'), 'utf8'), OLD_STYLE_SKILL);
    // No catalog markers → the generator would refuse to run, so `use` reports
    // the migration instead of silently shipping a script that errors.
    assert.equal(result.needsMigration, true);
  });

  test('does not report a migration when the existing SKILL.md has markers', () => {
    const dest = makeDest();
    mkdirSync(dest, { recursive: true });
    writeFileSync(
      path.join(dest, 'SKILL.md'),
      readFileSync(path.join(TEAM_LESSONS_SCAFFOLD_DIR, 'SKILL.md'), 'utf8'),
      'utf8',
    );

    assert.equal(scaffoldTeamLessons(dest).needsMigration, false);
  });
});
