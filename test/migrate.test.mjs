/**
 * Tests for `ccteams migrate` / `ccteams migrate --dry-run` (lib/migrate.js and
 * the "migrate" branch of bin/ccteams.js).
 *
 * Uses only node:test + node:assert — the package has no dependencies and the
 * CLI must keep working in projects that have none either.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { migrate, formatMigrateReport } from '../lib/migrate.js';
import { manifestPath, writeManifest } from '../lib/manifest.js';
import { TEAM_LESSONS_SCAFFOLD_DIR } from '../lib/use.js';
import {
  CATALOG_START,
  CATALOG_END,
  GENERATED_NOTE,
  buildSkill,
  renderCatalog,
} from '../scaffold/team-lessons/scripts/gen-lessons.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BIN = path.join(REPO_ROOT, 'bin', 'ccteams.js');

// The five files scaffoldTeamLessons() ships (see scaffold/team-lessons/), kept
// as a literal list here matching the convention in scaffold-team-lessons.test.mjs.
const EXPECTED_SCAFFOLD_FILES = [
  'AUTHORING.md',
  'SKILL.md',
  'lessons/.gitkeep',
  'scripts/gen-lessons.mjs',
  'scripts/lessons-index.mjs',
];

/** Create a fresh temp project directory (already exists on disk). */
const makeProject = () => mkdtempSync(path.join(tmpdir(), 'ccteams-migrate-'));

/** Write a minimal, valid v3 manifest (one applied team, no placed files). */
const applyMinimalManifest = (root) => {
  writeManifest(root, {
    teams: { generalist: { appliedAt: new Date().toISOString(), placedFiles: [], agentTeams: false } },
  });
};

const teamLessonsDir = (root) => path.join(root, '.claude', 'skills', 'team-lessons');

/**
 * Make .claude/skills/team-lessons a plain FILE instead of a directory — the
 * reproduction for the "raw stack trace / dry-run vs real mismatch" bug: a
 * step must detect this and fail cleanly in BOTH dry-run and a real run,
 * rather than throwing (real run) or misreporting addable files (dry-run).
 */
const makeTeamLessonsAFile = (root) => {
  mkdirSync(path.join(root, '.claude', 'skills'), { recursive: true });
  writeFileSync(teamLessonsDir(root), 'oops — this is a file, not a directory\n', 'utf8');
};

/**
 * Recursively snapshot every file under `dir` as { "relative/posix/path": base64 }.
 * Returns {} if the directory does not exist. Used to prove byte-for-byte that
 * pre-existing files were not touched (never-overwrite) or that NOTHING was
 * written at all (dry-run).
 */
function snapshotDir(dir) {
  const map = {};
  if (!existsSync(dir)) return map;
  const walk = (d, relBase) => {
    for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
      const abs = path.join(d, entry.name);
      const rel = relBase ? path.join(relBase, entry.name) : entry.name;
      if (entry.isDirectory()) {
        walk(abs, rel);
        continue;
      }
      map[rel.split(path.sep).join('/')] = fs.readFileSync(abs).toString('base64');
    }
  };
  walk(dir, '');
  return map;
}

describe('migrate()', () => {
  test('ccteams not applied (no manifest): exits 0, writes nothing', () => {
    const root = makeProject();
    const result = migrate(root);

    assert.equal(result.exitCode, 0);
    assert.equal(result.applied, false);
    assert.equal(existsSync(teamLessonsDir(root)), false);
    assert.match(result.message, /not applied/);
  });

  test('corrupted manifest (invalid JSON) is treated the same as not applied', () => {
    const root = makeProject();
    mkdirSync(path.dirname(manifestPath(root)), { recursive: true });
    writeFileSync(manifestPath(root), '{ this is not valid json', 'utf8');

    const result = migrate(root);

    assert.equal(result.exitCode, 0);
    assert.equal(result.applied, false);
    assert.equal(existsSync(teamLessonsDir(root)), false);
  });

  test('legacy v1/v2 manifest ({appliedTeam, placedFiles}) normalizes and proceeds', () => {
    const root = makeProject();
    mkdirSync(path.dirname(manifestPath(root)), { recursive: true });
    writeFileSync(
      manifestPath(root),
      JSON.stringify({ appliedTeam: 'generalist', placedFiles: [] }),
      'utf8',
    );

    const result = migrate(root);

    assert.equal(result.applied, true);
    assert.equal(result.exitCode, 0);
    for (const rel of EXPECTED_SCAFFOLD_FILES) {
      assert.ok(existsSync(path.join(teamLessonsDir(root), ...rel.split('/'))), `expected ${rel} to exist`);
    }
  });

  test('adds every missing team-lessons file when none exist yet', () => {
    const root = makeProject();
    applyMinimalManifest(root);

    const result = migrate(root);

    assert.equal(result.exitCode, 0);
    assert.equal(result.pending, EXPECTED_SCAFFOLD_FILES.length);
    for (const rel of EXPECTED_SCAFFOLD_FILES) {
      assert.ok(existsSync(path.join(teamLessonsDir(root), ...rel.split('/'))), `expected ${rel} to exist`);
    }
  });

  test('never-overwrite: every pre-existing file is byte-for-byte unchanged after migrate', () => {
    const root = makeProject();
    applyMinimalManifest(root);
    const dir = teamLessonsDir(root);
    mkdirSync(path.join(dir, 'scripts'), { recursive: true });
    writeFileSync(path.join(dir, 'SKILL.md'), 'HAND-WRITTEN SKILL.md — do not touch\n', 'utf8');
    writeFileSync(
      path.join(dir, 'scripts', 'gen-lessons.mjs'),
      '// HAND-WRITTEN generator — do not touch\n',
      'utf8',
    );

    const before = snapshotDir(dir); // only the two hand-written files at this point

    const result = migrate(root);

    const after = snapshotDir(dir);
    // Every file that existed BEFORE migrate ran must be byte-identical after —
    // this is the assertion that actually catches a broken never-overwrite guard
    // (it fails immediately if scaffoldTeamLessons() ever stops skipping
    // existing destinations).
    for (const [relPath, contentBefore] of Object.entries(before)) {
      assert.equal(after[relPath], contentBefore, `pre-existing file ${relPath} was modified by migrate()`);
    }
    assert.equal(Object.keys(before).length, 2, 'sanity check: fixture set up two hand-written files');

    // The three files that were missing got added; the two hand-written ones were kept.
    assert.deepEqual(
      result.steps[0].added.slice().sort(),
      ['AUTHORING.md', 'lessons/.gitkeep', 'scripts/lessons-index.mjs'].sort(),
    );
    assert.deepEqual(result.steps[0].kept.slice().sort(), ['SKILL.md', 'scripts/gen-lessons.mjs'].sort());
  });

  test('--dry-run writes nothing when team-lessons is entirely absent', () => {
    const root = makeProject();
    applyMinimalManifest(root);

    const result = migrate(root, { dryRun: true });

    assert.equal(existsSync(teamLessonsDir(root)), false);
    assert.equal(result.pending, EXPECTED_SCAFFOLD_FILES.length);
    assert.equal(result.exitCode, 1);
  });

  test('--dry-run leaves an existing team-lessons directory completely untouched', () => {
    const root = makeProject();
    applyMinimalManifest(root);
    const dir = teamLessonsDir(root);
    mkdirSync(path.join(dir, 'scripts'), { recursive: true });
    writeFileSync(path.join(dir, 'SKILL.md'), 'HAND-WRITTEN SKILL.md\n', 'utf8');
    writeFileSync(path.join(dir, 'scripts', 'gen-lessons.mjs'), '// HAND-WRITTEN\n', 'utf8');

    const before = snapshotDir(dir);
    const result = migrate(root, { dryRun: true });
    const after = snapshotDir(dir);

    // Full-directory equality: dry-run must add ZERO files, unlike the
    // never-overwrite test above (which allows new files to appear).
    assert.deepEqual(after, before);
    assert.equal(result.pending, 3);
    assert.equal(result.exitCode, 1);
  });

  test('dry-run and a real run report the same `added` set for the same starting state', () => {
    const root = makeProject();
    applyMinimalManifest(root);

    const dryResult = migrate(root, { dryRun: true });
    // Dry-run wrote nothing (asserted above), so the real run below starts from
    // the same on-disk state the dry-run observed.
    const realResult = migrate(root, { dryRun: false });

    assert.deepEqual(
      dryResult.steps[0].added.slice().sort(),
      realResult.steps[0].added.slice().sort(),
    );
  });

  test('--dry-run exitCode is 1 when files are pending and 0 once everything is installed', () => {
    const pendingRoot = makeProject();
    applyMinimalManifest(pendingRoot);
    assert.equal(migrate(pendingRoot, { dryRun: true }).exitCode, 1);

    const upToDateRoot = makeProject();
    applyMinimalManifest(upToDateRoot);
    migrate(upToDateRoot); // real run installs everything
    assert.equal(migrate(upToDateRoot, { dryRun: true }).exitCode, 0);
  });

  test('formatMigrateReport: "up to date" message when there is nothing to add', () => {
    const message = formatMigrateReport({
      dryRun: false,
      applied: true,
      steps: [{ id: 'x', title: 'x', added: [], kept: ['SKILL.md'], notices: [] }],
    });
    assert.match(message, /up to date/);
  });

  test('formatMigrateReport renders a step\'s notices', () => {
    const message = formatMigrateReport({
      dryRun: false,
      applied: true,
      steps: [{ id: 'x', title: 'x', added: [], kept: [], notices: ['old-layout SKILL.md detected'] }],
    });
    assert.match(message, /old-layout SKILL.md detected/);
  });

  test('a squatting non-directory at .claude/skills/team-lessons is reported as a failure, not thrown', () => {
    const root = makeProject();
    applyMinimalManifest(root);
    makeTeamLessonsAFile(root);

    let result;
    assert.doesNotThrow(() => {
      result = migrate(root);
    });

    assert.equal(result.success, false);
    assert.equal(result.exitCode, 1);
    assert.match(result.message, /team-lessons/);
  });

  test('--dry-run reports the same failure as a real run instead of promising unwritable additions', () => {
    const root = makeProject();
    applyMinimalManifest(root);
    makeTeamLessonsAFile(root);

    let result;
    assert.doesNotThrow(() => {
      result = migrate(root, { dryRun: true });
    });

    assert.equal(result.success, false);
    assert.equal(result.exitCode, 1);
    assert.equal(result.pending, 0, 'must not report 5 addable files for a destination it cannot write to');
    assert.match(result.message, /team-lessons/);
  });
});

describe('migrate() — team-lessons SKILL.md layout detection', () => {
  /**
   * The SKILL.md this package ships (the reference "current layout"),
   * normalized to LF — git may check the template out with CRLF, and the
   * fixture below rewrites the file around line boundaries (see the same note
   * in scaffold-team-lessons.test.mjs).
   */
  const currentSkill = () =>
    readFileSync(path.join(TEAM_LESSONS_SCAFFOLD_DIR, 'SKILL.md'), 'utf8').replace(/\r\n/g, '\n');

  /**
   * Same file in the pre-0.4 layout: markers present and ordered, but the
   * generated note still INSIDE them. Derived from the shipped template so the
   * fixture cannot silently drift away from the real thing.
   */
  const legacyIndexSkill = () => {
    const current = currentSkill();
    const legacy = current.replace(
      `${GENERATED_NOTE}\n${CATALOG_START}\n`,
      `${CATALOG_START}\n${GENERATED_NOTE}\n`,
    );
    assert.notEqual(legacy, current, 'fixture is stale: the shipped SKILL.md changed shape');
    return legacy;
  };

  /** A SKILL.md from before the index existed at all — no markers anywhere. */
  const NO_MARKER_SKILL = `---
name: team-lessons
---

## Failure catalog — symptom → wrong instinct → correct move

1. **Something we learned** — do it the other way.
`;

  /**
   * Both markers present but REVERSED (end before start) — the generator throws
   * on this exactly as it does on a missing pair, so it must be reported as the
   * unusable-markers case, not as the milder legacy-layout one.
   */
  const REVERSED_MARKER_SKILL = `---
name: team-lessons
---

## Failure catalog

${CATALOG_END}

(none yet)
${CATALOG_START}
`;

  /**
   * The distinguishing phrase of each notice heading. Held as constants so the
   * "these two are mutually exclusive" assertions cannot drift apart from the
   * text lib/migrate.js actually emits.
   */
  const UNUSABLE_MARKERS_PHRASE = 'markers are missing or out of order';
  const LEGACY_NOTE_PHRASE = 'the generated note is still inside';

  const seedProject = (skillContent) => {
    const root = makeProject();
    applyMinimalManifest(root);
    mkdirSync(teamLessonsDir(root), { recursive: true });
    writeFileSync(path.join(teamLessonsDir(root), 'SKILL.md'), skillContent, 'utf8');
    return root;
  };

  const noticesOf = (result) => result.steps[0].notices;

  test('legacy layout (note inside the markers) is reported with a regenerate command', () => {
    const root = seedProject(legacyIndexSkill());

    const notices = noticesOf(migrate(root));

    assert.ok(
      notices.some((line) => line.includes(LEGACY_NOTE_PHRASE)),
      `expected a legacy-layout notice, got:\n${notices.join('\n')}`,
    );
    // The advice is only actionable if it names the command to run.
    assert.ok(
      notices.some((line) => line.includes('scripts/gen-lessons.mjs')),
      `expected the generator command in the notice, got:\n${notices.join('\n')}`,
    );
    // Exclusive with the unusable-markers case: the markers ARE there, in order,
    // so the notice must not accuse them of being missing or misordered.
    assert.ok(
      !notices.some((line) => line.includes(UNUSABLE_MARKERS_PHRASE)),
      `notice contradicts its own precondition:\n${notices.join('\n')}`,
    );
  });

  test('no-marker layout is reported differently, and never as the legacy layout', () => {
    const root = seedProject(NO_MARKER_SKILL);

    const notices = noticesOf(migrate(root));

    assert.ok(
      notices.some((line) => line.includes(UNUSABLE_MARKERS_PHRASE)),
      `expected an unusable-markers notice, got:\n${notices.join('\n')}`,
    );
    // Re-running the generator alone cannot fix this case, but the notice must
    // still say what to run after the markers are added.
    assert.ok(notices.some((line) => line.includes('scripts/gen-lessons.mjs')));
    assert.ok(
      !notices.some((line) => line.includes(LEGACY_NOTE_PHRASE)),
      'the two legacy states must be reported exclusively',
    );
  });

  test('reversed markers (END before START) are reported as unusable markers, not as the legacy layout', () => {
    const root = seedProject(REVERSED_MARKER_SKILL);

    const result = migrate(root);
    const notices = noticesOf(result);

    // Both markers are present, so only the ORDER check can catch this — this is
    // what pins down the `endIndex > startIndex` half of the marker predicate.
    assert.ok(
      notices.some((line) => line.includes(UNUSABLE_MARKERS_PHRASE)),
      `expected an unusable-markers notice, got:\n${notices.join('\n')}`,
    );
    assert.ok(
      !notices.some((line) => line.includes(LEGACY_NOTE_PHRASE)),
      'a reversed pair is not the "note in the wrong place" case',
    );
    // The generator would throw on this file, so the heading must not claim the
    // markers are fine.
    assert.ok(!notices.some((line) => line.includes('The markers themselves are fine')));
  });

  test('a note both outside AND inside the markers is still reported as the legacy layout', () => {
    // The realistic shape of a half-finished manual migration: the user added
    // the note above the start marker but never removed the old one below it.
    const root = seedProject(
      currentSkill().replace(`${CATALOG_START}\n`, `${CATALOG_START}\n${GENERATED_NOTE}\n`),
    );

    const notices = noticesOf(migrate(root));

    assert.ok(
      notices.some((line) => line.includes(LEGACY_NOTE_PHRASE)),
      `expected a legacy-layout notice, got:\n${notices.join('\n')}`,
    );
  });

  test('following the advice actually clears the notice', () => {
    const root = seedProject(legacyIndexSkill());
    const skillPath = path.join(teamLessonsDir(root), 'SKILL.md');
    migrate(root); // installs the generator the notice tells the user to run

    assert.ok(noticesOf(migrate(root)).length > 0, 'sanity check: the notice is present first');

    // Do exactly what the advised command does — same functions, from the same
    // generator ccteams ships — instead of spawning it, so this stays a unit
    // test. If buildSkill() ever stops moving the note out of the markers, the
    // advice becomes false and this test is what catches it.
    writeFileSync(skillPath, buildSkill(readFileSync(skillPath, 'utf8'), renderCatalog([])), 'utf8');

    const result = migrate(root);
    assert.deepEqual(noticesOf(result), []);
    assert.match(result.message, /up to date/);
  });

  test('the current layout is reported as nothing at all', () => {
    const root = seedProject(currentSkill());
    migrate(root); // installs the four files that were genuinely missing

    // Second run: nothing left to add, and the current layout must produce no
    // notice — so the summary is the plain "up to date" line.
    const result = migrate(root);

    assert.deepEqual(noticesOf(result), []);
    assert.equal(result.pending, 0);
    assert.match(result.message, /up to date/);
  });

  test('an absent SKILL.md (freshly scaffolded) produces no notices', () => {
    const root = makeProject();
    applyMinimalManifest(root);

    const result = migrate(root);

    assert.deepEqual(noticesOf(result), []);
    assert.ok(result.steps[0].added.includes('SKILL.md'), 'sanity check: SKILL.md was created');
  });

  test('a detected SKILL.md is never rewritten — byte-identical in dry-run and in a real run', () => {
    for (const [label, skillContent] of [
      ['legacy layout', legacyIndexSkill()],
      ['no markers', NO_MARKER_SKILL],
      ['reversed markers', REVERSED_MARKER_SKILL],
    ]) {
      const root = seedProject(skillContent);
      const skillPath = path.join(teamLessonsDir(root), 'SKILL.md');
      const before = fs.readFileSync(skillPath); // Buffer — byte-level comparison

      migrate(root, { dryRun: true });
      assert.ok(fs.readFileSync(skillPath).equals(before), `${label}: dry-run modified SKILL.md`);

      migrate(root, { dryRun: false });
      assert.ok(fs.readFileSync(skillPath).equals(before), `${label}: a real run modified SKILL.md`);
    }
  });

  test('dry-run and a real run emit exactly the same notices', () => {
    for (const skillContent of [
      legacyIndexSkill(),
      NO_MARKER_SKILL,
      REVERSED_MARKER_SKILL,
      currentSkill(),
    ]) {
      const root = seedProject(skillContent);

      const dryResult = migrate(root, { dryRun: true });
      // Dry-run writes nothing, so the real run below sees the same SKILL.md.
      const realResult = migrate(root, { dryRun: false });

      assert.deepEqual(noticesOf(dryResult), noticesOf(realResult));
    }
  });

  test('the report does not claim "everything is up to date" while a notice is printed', () => {
    const root = seedProject(legacyIndexSkill());
    migrate(root); // install the files that are genuinely missing → pending becomes 0

    const result = migrate(root);

    assert.equal(result.pending, 0);
    assert.ok(noticesOf(result).length > 0, 'sanity check: the notice survives a second run');
    assert.doesNotMatch(result.message, /up to date/);
    assert.match(result.message, /note/i);
    // Notices are advice, not pending work: they must not change the exit code.
    assert.equal(result.exitCode, 0);
    assert.equal(migrate(root, { dryRun: true }).exitCode, 0);
  });
});

describe('ccteams migrate — CLI integration', () => {
  const runCli = (args, cwd) =>
    spawnSync(process.execPath, [BIN, ...args], {
      cwd,
      encoding: 'utf8',
      env: { ...process.env, CI: '1', NO_UPDATE_NOTIFIER: '1' },
    });

  test('"migrate --dry-run" does not prompt on non-TTY stdin and exits 1 when pending', () => {
    const root = makeProject();
    applyMinimalManifest(root);

    const result = runCli(['migrate', '--dry-run'], root);

    assert.equal(result.status, 1);
    assert.match(result.stdout, /dry run/);
    assert.equal(existsSync(teamLessonsDir(root)), false);
  });

  test('"migrate" (real run) exits 0 and adds the missing files', () => {
    const root = makeProject();
    applyMinimalManifest(root);

    const result = runCli(['migrate'], root);

    assert.equal(result.status, 0);
    for (const rel of EXPECTED_SCAFFOLD_FILES) {
      assert.ok(existsSync(path.join(teamLessonsDir(root), ...rel.split('/'))), `expected ${rel} to exist`);
    }
  });

  test('unknown flags are rejected with exit 1 and a usage message', () => {
    const root = makeProject();
    applyMinimalManifest(root);

    for (const badArgs of [['migrate', '--bogus'], ['migrate', '--yes'], ['migrate', '--force']]) {
      const result = runCli(badArgs, root);
      assert.equal(result.status, 1, `expected ${badArgs.join(' ')} to exit 1`);
      assert.match(result.stdout + result.stderr, /Usage: ccteams migrate/);
    }
  });

  test('"ccteams --help" usage text includes migrate', () => {
    const result = runCli(['--help'], makeProject());
    assert.equal(result.status, 0);
    assert.match(result.stdout, /ccteams migrate/);
    assert.match(result.stdout, /--dry-run/);
  });

  test('"migrate" on a squatting file exits 1 with a clean Error line, no stack trace, on stderr', () => {
    const root = makeProject();
    applyMinimalManifest(root);
    makeTeamLessonsAFile(root);

    const result = runCli(['migrate'], root);

    assert.equal(result.status, 1);
    assert.match(result.stderr, /^Error: /m);
    assert.ok(!/\n\s+at /.test(result.stderr), `stderr should not contain a stack trace:\n${result.stderr}`);
  });
});

describe('Node 18 compatibility', () => {
  // import.meta.dirname is undefined on Node 18 (this repo's floor: "node": ">=18.0.0"
  // in package.json). Using it would throw at import time, before any try/catch could
  // help — see the identical rationale and pattern in test/lessons-index.test.mjs.
  for (const relPath of [path.join('lib', 'migrate.js'), path.join('bin', 'ccteams.js')]) {
    test(`${relPath.split(path.sep).join('/')} does not use import.meta.dirname outside comments`, () => {
      const source = readFileSync(path.join(REPO_ROOT, relPath), 'utf8');
      const code = source
        .replace(/\/\*[\s\S]*?\*\//g, '') // block comments (incl. file headers)
        .replace(/^\s*\/\/.*$/gm, ''); // whole-line // comments
      assert.ok(
        !code.includes('import.meta.dirname'),
        `${relPath} uses import.meta.dirname, which is undefined on Node 18`,
      );
    });
  }
});
