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

/** Write a minimal, valid v4 manifest (one applied team, no placed files). */
const applyMinimalManifest = (root) => {
  writeManifest(root, {
    teams: { generalist: { appliedAt: new Date().toISOString(), placedFiles: [], agentTeams: false } },
  });
};

const teamLessonsDir = (root) => path.join(root, '.claude', 'skills', 'team-lessons');

/**
 * Write .claude/settings.json with the team-lessons hook already registered
 * for both SessionStart and SubagentStart, so the team-lessons-hook step
 * reports nothing. Used by fixtures that assert on the WHOLE formatted
 * message (e.g. "up to date") for an unrelated step (team-lessons-scaffold's
 * SKILL.md layout detection) — without this, those assertions would be
 * cross-contaminated by the hook step's own (correct, but unrelated) notices.
 */
const registerLessonsHooks = (root) => {
  const dir = path.join(root, '.claude');
  mkdirSync(dir, { recursive: true });
  const hookEntry = {
    matcher: '',
    hooks: [{ type: 'command', command: 'node .claude/skills/team-lessons/scripts/lessons-index.mjs' }],
  };
  writeFileSync(
    path.join(dir, 'settings.json'),
    JSON.stringify({ hooks: { SessionStart: [hookEntry], SubagentStart: [hookEntry] } }, null, 2) + '\n',
    'utf8',
  );
};

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

/**
 * Look a migration step up by its stable `id` (see MIGRATION_STEPS in
 * lib/migrate.js) instead of by its position in `result.steps`. Reordering the
 * steps is a legal refactor, and a positional lookup would then silently start
 * asserting about a DIFFERENT step — passing or failing for reasons unrelated
 * to what the test is named after.
 *
 * The explicit assert is the point of the helper: `find()` alone returns
 * undefined for an unknown id, so the test would die on `.added of undefined`
 * several lines later. Renaming or dropping a step id must instead fail here,
 * naming the id that vanished and the ids that do exist.
 */
const stepById = (result, id) => {
  const step = result.steps.find((s) => s.id === id);
  assert.ok(
    step,
    `no migration step with id "${id}"; present ids: ${result.steps.map((s) => s.id).join(', ')}`,
  );
  return step;
};

/** The step that scaffolds .claude/skills/team-lessons (adds/keeps its files). */
const scaffoldStepOf = (result) => stepById(result, 'team-lessons-scaffold');

describe('migrate()', () => {
  test('ccteams not applied (no manifest): exits 0, writes nothing', async () => {
    const root = makeProject();
    const result = await migrate(root);

    assert.equal(result.exitCode, 0);
    assert.equal(result.applied, false);
    assert.equal(existsSync(teamLessonsDir(root)), false);
    assert.match(result.message, /not applied/);
  });

  test('corrupted manifest (invalid JSON) is treated the same as not applied', async () => {
    const root = makeProject();
    mkdirSync(path.dirname(manifestPath(root)), { recursive: true });
    writeFileSync(manifestPath(root), '{ this is not valid json', 'utf8');

    const result = await migrate(root);

    assert.equal(result.exitCode, 0);
    assert.equal(result.applied, false);
    assert.equal(existsSync(teamLessonsDir(root)), false);
  });

  test('legacy v1/v2 manifest ({appliedTeam, placedFiles}) normalizes and proceeds', async () => {
    const root = makeProject();
    mkdirSync(path.dirname(manifestPath(root)), { recursive: true });
    writeFileSync(
      manifestPath(root),
      JSON.stringify({ appliedTeam: 'generalist', placedFiles: [] }),
      'utf8',
    );

    const result = await migrate(root);

    assert.equal(result.applied, true);
    assert.equal(result.exitCode, 0);
    for (const rel of EXPECTED_SCAFFOLD_FILES) {
      assert.ok(existsSync(path.join(teamLessonsDir(root), ...rel.split('/'))), `expected ${rel} to exist`);
    }
  });

  test('adds every missing team-lessons file when none exist yet', async () => {
    const root = makeProject();
    applyMinimalManifest(root);

    const result = await migrate(root);

    assert.equal(result.exitCode, 0);
    assert.equal(result.pending, EXPECTED_SCAFFOLD_FILES.length);
    for (const rel of EXPECTED_SCAFFOLD_FILES) {
      assert.ok(existsSync(path.join(teamLessonsDir(root), ...rel.split('/'))), `expected ${rel} to exist`);
    }
  });

  test('never-overwrite: every pre-existing file is byte-for-byte unchanged after migrate', async () => {
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

    const result = await migrate(root);

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
      scaffoldStepOf(result).added.slice().sort(),
      ['AUTHORING.md', 'lessons/.gitkeep', 'scripts/lessons-index.mjs'].sort(),
    );
    assert.deepEqual(
      scaffoldStepOf(result).kept.slice().sort(),
      ['SKILL.md', 'scripts/gen-lessons.mjs'].sort(),
    );
  });

  test('--dry-run writes nothing when team-lessons is entirely absent', async () => {
    const root = makeProject();
    applyMinimalManifest(root);

    const result = await migrate(root, { dryRun: true });

    assert.equal(existsSync(teamLessonsDir(root)), false);
    assert.equal(result.pending, EXPECTED_SCAFFOLD_FILES.length);
    assert.equal(result.exitCode, 1);
  });

  test('--dry-run leaves an existing team-lessons directory completely untouched', async () => {
    const root = makeProject();
    applyMinimalManifest(root);
    const dir = teamLessonsDir(root);
    mkdirSync(path.join(dir, 'scripts'), { recursive: true });
    writeFileSync(path.join(dir, 'SKILL.md'), 'HAND-WRITTEN SKILL.md\n', 'utf8');
    writeFileSync(path.join(dir, 'scripts', 'gen-lessons.mjs'), '// HAND-WRITTEN\n', 'utf8');

    const before = snapshotDir(dir);
    const result = await migrate(root, { dryRun: true });
    const after = snapshotDir(dir);

    // Full-directory equality: dry-run must add ZERO files, unlike the
    // never-overwrite test above (which allows new files to appear).
    assert.deepEqual(after, before);
    assert.equal(result.pending, 3);
    assert.equal(result.exitCode, 1);
  });

  test('dry-run and a real run report the same `added` set for the same starting state', async () => {
    const root = makeProject();
    applyMinimalManifest(root);

    const dryResult = await migrate(root, { dryRun: true });
    // Dry-run wrote nothing (asserted above), so the real run below starts from
    // the same on-disk state the dry-run observed.
    const realResult = await migrate(root, { dryRun: false });

    assert.deepEqual(
      scaffoldStepOf(dryResult).added.slice().sort(),
      scaffoldStepOf(realResult).added.slice().sort(),
    );
  });

  test('--dry-run exitCode is 1 when files are pending and 0 once everything is installed', async () => {
    const pendingRoot = makeProject();
    applyMinimalManifest(pendingRoot);
    assert.equal((await migrate(pendingRoot, { dryRun: true })).exitCode, 1);

    const upToDateRoot = makeProject();
    applyMinimalManifest(upToDateRoot);
    await migrate(upToDateRoot); // real run installs everything
    assert.equal((await migrate(upToDateRoot, { dryRun: true })).exitCode, 0);
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

  test('a squatting non-directory at .claude/skills/team-lessons is reported as a failure, not thrown', async () => {
    const root = makeProject();
    applyMinimalManifest(root);
    makeTeamLessonsAFile(root);

    // migrate() is async, so a step's throw can never reach the caller as a
    // SYNCHRONOUS exception any more — it would surface as a rejected
    // promise instead. assert.doesNotReject is the async-aware equivalent of
    // the original assert.doesNotThrow: it proves migrate()'s own try/catch
    // (see migrate.js) swallows the step's throw into a resolved
    // `{ success: false }`, rather than letting it become an uncaught
    // rejection.
    let result;
    await assert.doesNotReject(async () => {
      result = await migrate(root);
    });

    assert.equal(result.success, false);
    assert.equal(result.exitCode, 1);
    assert.match(result.message, /team-lessons/);
  });

  test('--dry-run reports the same failure as a real run instead of promising unwritable additions', async () => {
    const root = makeProject();
    applyMinimalManifest(root);
    makeTeamLessonsAFile(root);

    let result;
    await assert.doesNotReject(async () => {
      result = await migrate(root, { dryRun: true });
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

  const noticesOf = (result) => scaffoldStepOf(result).notices;

  test('legacy layout (note inside the markers) is reported with a regenerate command', async () => {
    const root = seedProject(legacyIndexSkill());

    const notices = noticesOf(await migrate(root));

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

  test('no-marker layout is reported differently, and never as the legacy layout', async () => {
    const root = seedProject(NO_MARKER_SKILL);

    const notices = noticesOf(await migrate(root));

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

  test('reversed markers (END before START) are reported as unusable markers, not as the legacy layout', async () => {
    const root = seedProject(REVERSED_MARKER_SKILL);

    const result = await migrate(root);
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

  test('a note both outside AND inside the markers is still reported as the legacy layout', async () => {
    // The realistic shape of a half-finished manual migration: the user added
    // the note above the start marker but never removed the old one below it.
    const root = seedProject(
      currentSkill().replace(`${CATALOG_START}\n`, `${CATALOG_START}\n${GENERATED_NOTE}\n`),
    );

    const notices = noticesOf(await migrate(root));

    assert.ok(
      notices.some((line) => line.includes(LEGACY_NOTE_PHRASE)),
      `expected a legacy-layout notice, got:\n${notices.join('\n')}`,
    );
  });

  test('following the advice actually clears the notice', async () => {
    const root = seedProject(legacyIndexSkill());
    registerLessonsHooks(root); // keep the unrelated hook step silent — see its doc comment
    const skillPath = path.join(teamLessonsDir(root), 'SKILL.md');
    await migrate(root); // installs the generator the notice tells the user to run

    assert.ok(noticesOf(await migrate(root)).length > 0, 'sanity check: the notice is present first');

    // Do exactly what the advised command does — same functions, from the same
    // generator ccteams ships — instead of spawning it, so this stays a unit
    // test. If buildSkill() ever stops moving the note out of the markers, the
    // advice becomes false and this test is what catches it.
    writeFileSync(skillPath, buildSkill(readFileSync(skillPath, 'utf8'), renderCatalog([])), 'utf8');

    const result = await migrate(root);
    assert.deepEqual(noticesOf(result), []);
    assert.match(result.message, /up to date/);
  });

  test('the current layout is reported as nothing at all', async () => {
    const root = seedProject(currentSkill());
    registerLessonsHooks(root); // keep the unrelated hook step silent — see its doc comment
    await migrate(root); // installs the four files that were genuinely missing

    // Second run: nothing left to add, and the current layout must produce no
    // notice — so the summary is the plain "up to date" line.
    const result = await migrate(root);

    assert.deepEqual(noticesOf(result), []);
    assert.equal(result.pending, 0);
    assert.match(result.message, /up to date/);
  });

  test('an absent SKILL.md (freshly scaffolded) produces no notices', async () => {
    const root = makeProject();
    applyMinimalManifest(root);

    const result = await migrate(root);

    assert.deepEqual(noticesOf(result), []);
    assert.ok(scaffoldStepOf(result).added.includes('SKILL.md'), 'sanity check: SKILL.md was created');
  });

  test('a detected SKILL.md is never rewritten — byte-identical in dry-run and in a real run', async () => {
    for (const [label, skillContent] of [
      ['legacy layout', legacyIndexSkill()],
      ['no markers', NO_MARKER_SKILL],
      ['reversed markers', REVERSED_MARKER_SKILL],
    ]) {
      const root = seedProject(skillContent);
      const skillPath = path.join(teamLessonsDir(root), 'SKILL.md');
      const before = fs.readFileSync(skillPath); // Buffer — byte-level comparison

      await migrate(root, { dryRun: true });
      assert.ok(fs.readFileSync(skillPath).equals(before), `${label}: dry-run modified SKILL.md`);

      await migrate(root, { dryRun: false });
      assert.ok(fs.readFileSync(skillPath).equals(before), `${label}: a real run modified SKILL.md`);
    }
  });

  test('dry-run and a real run emit exactly the same notices', async () => {
    for (const skillContent of [
      legacyIndexSkill(),
      NO_MARKER_SKILL,
      REVERSED_MARKER_SKILL,
      currentSkill(),
    ]) {
      const root = seedProject(skillContent);

      const dryResult = await migrate(root, { dryRun: true });
      // Dry-run writes nothing, so the real run below sees the same SKILL.md.
      const realResult = await migrate(root, { dryRun: false });

      assert.deepEqual(noticesOf(dryResult), noticesOf(realResult));
    }
  });

  test('the report does not claim "everything is up to date" while a notice is printed', async () => {
    const root = seedProject(legacyIndexSkill());
    await migrate(root); // install the files that are genuinely missing → pending becomes 0

    const result = await migrate(root);

    assert.equal(result.pending, 0);
    assert.ok(noticesOf(result).length > 0, 'sanity check: the notice survives a second run');
    assert.doesNotMatch(result.message, /up to date/);
    assert.match(result.message, /note/i);
    // Notices are advice, not pending work: they must not change the exit code.
    assert.equal(result.exitCode, 0);
    assert.equal((await migrate(root, { dryRun: true })).exitCode, 0);
  });
});

describe('migrate() — team-lessons hook detection', () => {
  /** Write .claude/settings.json verbatim (no team-lessons hook assumptions). */
  const writeRawSettings = (root, data) => {
    const dir = path.join(root, '.claude');
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, 'settings.json'), JSON.stringify(data, null, 2) + '\n', 'utf8');
  };

  const hookEntryFor = (command) => ({ matcher: '', hooks: [{ type: 'command', command }] });
  const DEFAULT_COMMAND = 'node .claude/skills/team-lessons/scripts/lessons-index.mjs';

  const hookStepOf = (result) => stepById(result, 'team-lessons-hook');
  const hookNoticesOf = (result) => hookStepOf(result).notices;

  test('both hooks registered: nothing is reported (no heading, no notices)', async () => {
    const root = makeProject();
    applyMinimalManifest(root);
    writeRawSettings(root, {
      hooks: {
        SessionStart: [hookEntryFor(DEFAULT_COMMAND)],
        SubagentStart: [hookEntryFor(DEFAULT_COMMAND)],
      },
    });

    const result = await migrate(root);

    assert.deepEqual(hookNoticesOf(result), []);
    assert.doesNotMatch(result.message, /team-lessons hook/, 'heading must not appear when there is nothing to report');
  });

  test('only SessionStart registered: only SubagentStart is advised', async () => {
    const root = makeProject();
    applyMinimalManifest(root);
    writeRawSettings(root, { hooks: { SessionStart: [hookEntryFor(DEFAULT_COMMAND)] } });

    const notices = hookNoticesOf(await migrate(root));

    assert.ok(notices.some((l) => l.includes('! SubagentStart')), `expected a SubagentStart notice, got:\n${notices.join('\n')}`);
    assert.ok(!notices.some((l) => l.includes('! SessionStart')), 'SessionStart is already registered — it must not be flagged');
    assert.ok(notices.some((l) => l.includes('"SubagentStart": [')), 'expected a copy-pasteable SubagentStart fragment');
    assert.ok(!notices.some((l) => l.includes('"SessionStart": [')), 'a registered event must not get a fragment either');
  });

  test('only SubagentStart registered: only SessionStart is advised', async () => {
    const root = makeProject();
    applyMinimalManifest(root);
    writeRawSettings(root, { hooks: { SubagentStart: [hookEntryFor(DEFAULT_COMMAND)] } });

    const notices = hookNoticesOf(await migrate(root));

    assert.ok(notices.some((l) => l.includes('! SessionStart')), `expected a SessionStart notice, got:\n${notices.join('\n')}`);
    assert.ok(!notices.some((l) => l.includes('! SubagentStart')), 'SubagentStart is already registered — it must not be flagged');
    assert.ok(notices.some((l) => l.includes('"SessionStart": [')), 'expected a copy-pasteable SessionStart fragment');
    assert.ok(!notices.some((l) => l.includes('"SubagentStart": [')), 'a registered event must not get a fragment either');
  });

  test('hooks key present but neither event registered: both are advised', async () => {
    const root = makeProject();
    applyMinimalManifest(root);
    writeRawSettings(root, { hooks: { SomeOtherHookEvent: [hookEntryFor('node some-other-script.mjs')] } });

    const notices = hookNoticesOf(await migrate(root));

    assert.ok(notices.some((l) => l.includes('! SessionStart')));
    assert.ok(notices.some((l) => l.includes('! SubagentStart')));
  });

  test('hooks key absent entirely: both events are advised', async () => {
    const root = makeProject();
    applyMinimalManifest(root);
    writeRawSettings(root, { permissions: { allow: [] } }); // some unrelated key, no hooks at all

    const notices = hookNoticesOf(await migrate(root));

    assert.ok(notices.some((l) => l.includes('! SessionStart')));
    assert.ok(notices.some((l) => l.includes('! SubagentStart')));
  });

  test('settings.json absent: both events are advised and migrate still succeeds', async () => {
    const root = makeProject();
    applyMinimalManifest(root);
    // Deliberately no settings.json written at all.

    const result = await migrate(root);

    assert.equal(result.success, true);
    const notices = hookNoticesOf(result);
    assert.ok(notices.some((l) => l.includes('! SessionStart')));
    assert.ok(notices.some((l) => l.includes('! SubagentStart')));
  });

  test('settings.json is broken JSON: reported as unreadable rather than "not registered", and migrate does not throw', async () => {
    const root = makeProject();
    applyMinimalManifest(root);
    const dir = path.join(root, '.claude');
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, 'settings.json'), '{ this is not valid json', 'utf8');

    let result;
    await assert.doesNotReject(async () => {
      result = await migrate(root);
    });

    assert.equal(result.success, true);
    const notices = hookNoticesOf(result);
    assert.ok(
      notices.some((l) => l.includes('could not be read or parsed as JSON')),
      `expected an unreadable-settings notice, got:\n${notices.join('\n')}`,
    );
    // Must not claim a specific event is "not registered" — that would assert
    // something this step could not actually verify (see DESIGN-C).
    assert.ok(!notices.some((l) => l.includes('! SessionStart')));
    assert.ok(!notices.some((l) => l.includes('! SubagentStart')));
  });

  test('settings.json unreadable for a NON-JSON reason: the notice reports the read failure without blaming JSON syntax', async () => {
    const root = makeProject();
    applyMinimalManifest(root);
    // A directory sitting at .claude/settings.json makes fs.readFileSync throw
    // EISDIR — a read failure that is emphatically NOT a JSON syntax error,
    // yet reaches the exact same `unreadable: true` branch, because
    // readSettingsForHookDetection wraps readFileSync and JSON.parse in ONE
    // try block. The notice therefore may not name invalid JSON as the cause:
    // that branch never distinguished which of the two steps failed.
    mkdirSync(path.join(root, '.claude', 'settings.json'), { recursive: true });

    let result;
    await assert.doesNotReject(async () => {
      result = await migrate(root);
    });

    assert.equal(result.success, true);
    const notices = hookNoticesOf(result);
    // (a) the read failure is actually reported ...
    assert.ok(
      notices.some((l) => l.includes('could not be read or parsed as JSON')),
      `expected an unreadable-settings notice, got:\n${notices.join('\n')}`,
    );
    // ... and (b) it is not reported as a JSON syntax error, which is what this
    // scenario proves it is not.
    assert.ok(
      !notices.some((l) => /not valid JSON|invalid JSON/i.test(l)),
      `the notice must not assert a JSON syntax error it never checked for, got:\n${notices.join('\n')}`,
    );
    // ... and (c) the ADVICE line carries the same restraint as the heading.
    // Checking only (a) and (b) leaves a real regression uncaught: a heading
    // reading "could not be read or parsed as JSON" followed by advice reading
    // only "Fix the JSON syntax" passes both of the assertions above (neither
    // matches "not valid JSON"/"invalid JSON") while still sending a user whose
    // settings.json is a directory or is chmod 000 off to hunt for a syntax
    // error that does not exist. Measured, not assumed: reverting just that one
    // line left all 48 tests in this file green before this assertion existed.
    assert.ok(
      notices.some((l) => /readable/i.test(l)),
      `the advice must also point at the read-failure possibility, not only at JSON syntax, got:\n${notices.join('\n')}`,
    );
    // ... and (d) the OTHER half of that advice survives too. (c) alone pins
    // only the readable side, so narrowing the advice to "Check that the file
    // is readable" — dropping the JSON-syntax half — passes every assertion
    // above while stranding the user whose settings.json really is malformed,
    // which is the far more common case. Measured, not assumed: that exact
    // mutation left all 205 tests green before this assertion existed.
    assert.ok(
      notices.some((l) => /JSON syntax/i.test(l)),
      `the advice must keep BOTH possibilities — dropping the JSON-syntax half strands a user whose settings.json really is malformed, got:\n${notices.join('\n')}`,
    );
    assert.ok(!notices.some((l) => l.includes('! SessionStart')));
    assert.ok(!notices.some((l) => l.includes('! SubagentStart')));
  });

  test('custom command forms are recognized as registered (no false "not registered")', async () => {
    const customCommands = [
      'cd $CLAUDE_PROJECT_DIR && node ./.claude/skills/team-lessons/scripts/lessons-index.mjs',
      'node /abs/path/to/project/.claude/skills/team-lessons/scripts/lessons-index.mjs',
      'node $CLAUDE_PROJECT_DIR/.claude/skills/team-lessons/scripts/lessons-index.mjs',
      'bash -c "node .claude/skills/team-lessons/scripts/lessons-index.mjs"',
    ];

    for (const command of customCommands) {
      const root = makeProject();
      applyMinimalManifest(root);
      writeRawSettings(root, {
        hooks: { SessionStart: [hookEntryFor(command)], SubagentStart: [hookEntryFor(command)] },
      });

      const result = await migrate(root);
      assert.deepEqual(
        hookNoticesOf(result),
        [],
        `expected "${command}" to be recognized as an existing registration`,
      );
    }
  });

  test('a non-empty matcher and multiple matcher entries are still scanned', async () => {
    const root = makeProject();
    applyMinimalManifest(root);
    // The real command sits in the SECOND matcher entry, under a non-empty
    // matcher — isHookRegisteredForEvent() must not stop at the first entry
    // and must not filter on `matcher` at all (Issue #17: "matcher の値は問わ
    // ない（全 matcher エントリを走査する）"). A regression that narrows the
    // scan to `matcher: ''` only, or to the first entry only, would make this
    // command invisible and wrongly report SessionStart as unregistered.
    writeRawSettings(root, {
      hooks: {
        SessionStart: [
          { matcher: 'Task', hooks: [{ type: 'command', command: 'node other.mjs' }] },
          { matcher: 'startup|resume', hooks: [{ type: 'command', command: DEFAULT_COMMAND }] },
        ],
        SubagentStart: [hookEntryFor(DEFAULT_COMMAND)],
      },
    });

    const result = await migrate(root);

    assert.deepEqual(
      hookNoticesOf(result),
      [],
      'the SessionStart command in the second, non-empty-matcher entry must still count as registered',
    );
  });

  test('malformed hooks shapes never throw and are treated as not registered', async () => {
    const malformedSettingsList = [
      { hooks: { SessionStart: 'not-an-array' } },
      { hooks: { SessionStart: ['not-an-object'] } },
      { hooks: { SessionStart: [{ matcher: '', hooks: 'not-an-array' }] } },
      { hooks: { SessionStart: [{ matcher: '', hooks: [{ type: 'command', command: 12345 }] }] } },
      { hooks: { SessionStart: [{ matcher: '', hooks: [null] }] } },
      { hooks: 'not-an-object' },
      { hooks: null },
    ];

    for (const settings of malformedSettingsList) {
      const root = makeProject();
      applyMinimalManifest(root);
      writeRawSettings(root, settings);

      let result;
      await assert.doesNotReject(async () => {
        result = await migrate(root);
      }, `should not throw for ${JSON.stringify(settings)}`);

      assert.equal(result.success, true);
      const notices = hookNoticesOf(result);
      assert.ok(
        notices.some((l) => l.includes('! SessionStart')),
        `expected SessionStart to be reported unregistered for ${JSON.stringify(settings)}`,
      );
    }
  });

  test('.claude is byte-identical after a real run in every settings.json state', async () => {
    // Each scenario proves the SAME thing (a real run touches nothing under
    // .claude/) but from a different settings.json starting state, because a
    // regression could plausibly hide in just one branch — e.g. writing back
    // only when the JSON is unparseable (readSettings()'s own doc comment in
    // use.js notes "write will overwrite" as an existing pattern elsewhere in
    // this codebase, which is exactly the kind of accidental reuse this guards
    // against), or only when settings.json does not exist yet.
    const scenarios = [
      {
        label: 'both hooks already registered',
        setup: (root) =>
          writeRawSettings(root, {
            hooks: {
              SessionStart: [hookEntryFor(DEFAULT_COMMAND)],
              SubagentStart: [hookEntryFor(DEFAULT_COMMAND)],
            },
          }),
        sanityCheck: (result) =>
          assert.deepEqual(hookNoticesOf(result), [], 'sanity check: no notice expected for this scenario'),
      },
      {
        label: 'only one hook registered',
        setup: (root) => writeRawSettings(root, { hooks: { SessionStart: [hookEntryFor(DEFAULT_COMMAND)] } }),
        sanityCheck: (result) =>
          assert.ok(
            hookNoticesOf(result).some((l) => l.includes('! SubagentStart')),
            'sanity check: a notice actually fired',
          ),
      },
      {
        label: 'settings.json is broken JSON',
        setup: (root) => {
          const dir = path.join(root, '.claude');
          mkdirSync(dir, { recursive: true });
          // The broken bytes themselves are part of what "byte-identical" must
          // cover here: the fix, if any, is the user's to make by hand.
          writeFileSync(path.join(dir, 'settings.json'), '{ this is not valid json', 'utf8');
        },
        sanityCheck: (result) =>
          assert.ok(
            hookNoticesOf(result).some((l) => l.includes('could not be read or parsed as JSON')),
            'sanity check: the unreadable-settings notice actually fired',
          ),
      },
      {
        label: 'settings.json absent',
        setup: () => {}, // no file written at all
        // Snapshot equality (before/after the run under test) alone CANNOT
        // prove settings.json was never created: the warm-up `migrate(root)`
        // call below runs BEFORE `before` is captured, so if a regression made
        // the absent-file branch create settings.json, the warm-up run would
        // create it and `before` would already show it present — the run
        // under test would then see it as already existing and never trip the
        // absent branch at all, leaving before/after equal despite the bug.
        // Asserting non-existence directly, on the ACTUAL project root (not
        // the warm-up-affected one), is what closes that hole — see the
        // dedicated warm-up-free test below for the same reasoning applied
        // end-to-end.
        sanityCheck: (result, root) => {
          assert.equal(
            existsSync(path.join(root, '.claude', 'settings.json')),
            false,
            'migrate() must never CREATE settings.json',
          );
          assert.ok(hookNoticesOf(result).some((l) => l.includes('! SessionStart')));
          assert.ok(hookNoticesOf(result).some((l) => l.includes('! SubagentStart')));
        },
      },
    ];

    for (const { label, setup, sanityCheck } of scenarios) {
      const root = makeProject();
      applyMinimalManifest(root);
      await migrate(root); // scaffold team-lessons fully first, so the run under test adds nothing else
      setup(root);

      const dotClaudeDir = path.join(root, '.claude');
      const before = snapshotDir(dotClaudeDir);
      const result = await migrate(root); // real (non-dry) run — the one under test
      const after = snapshotDir(dotClaudeDir);

      assert.deepEqual(after, before, `[${label}] migrate() must not write anything under .claude/`);
      sanityCheck(result, root);
    }
  });

  test('migrate() never creates .claude/settings.json when it is absent (real run and dry-run)', async () => {
    // There IS a warm-up migrate() below (line: "scaffold team-lessons fully
    // first"), so this test cannot claim the run under test is the only call
    // against the project. What closes that gap is the sanity assert on the
    // line right after it: it fails if the warm-up itself created
    // settings.json, so a warm-up creation can never masquerade as the run
    // under test staying clean. Each iteration also uses a FRESH project, so
    // the real run cannot leak a created file into the dry-run iteration.
    for (const dryRun of [false, true]) {
      const root = makeProject();
      applyMinimalManifest(root);
      await migrate(root); // scaffold team-lessons fully first (a separate, prior project state)
      const settingsPath = path.join(root, '.claude', 'settings.json');
      assert.equal(existsSync(settingsPath), false, 'sanity check: absent before the run under test');

      const result = await migrate(root, { dryRun }); // the run under test

      assert.equal(
        existsSync(settingsPath),
        false,
        `migrate(root, { dryRun: ${dryRun} }) must never create .claude/settings.json`,
      );
      assert.ok(hookNoticesOf(result).some((l) => l.includes('! SessionStart')), `dryRun=${dryRun}: sanity check`);
      assert.ok(hookNoticesOf(result).some((l) => l.includes('! SubagentStart')), `dryRun=${dryRun}: sanity check`);
    }
  });

  test('dry-run and a real run report identical hook notices, before and after team-lessons is scaffolded', async () => {
    const scenarios = [
      { hooks: {} },
      { hooks: { SessionStart: [hookEntryFor(DEFAULT_COMMAND)] } },
      { hooks: { SubagentStart: [hookEntryFor(DEFAULT_COMMAND)] } },
      {
        hooks: {
          SessionStart: [hookEntryFor(DEFAULT_COMMAND)],
          SubagentStart: [hookEntryFor(DEFAULT_COMMAND)],
        },
      },
    ];

    for (const settings of scenarios) {
      // Case A — team-lessons has never been scaffolded (fresh project): this is
      // the DESIGN-D regression case, where a naive existsSync() on
      // scripts/lessons-index.mjs would disagree between dry-run and a real run.
      const freshRoot = makeProject();
      applyMinimalManifest(freshRoot);
      writeRawSettings(freshRoot, settings);
      assert.deepEqual(
        hookNoticesOf(await migrate(freshRoot, { dryRun: true })),
        hookNoticesOf(await migrate(freshRoot, { dryRun: false })),
        `pre-scaffold case disagreed for ${JSON.stringify(settings)}`,
      );

      // Case B — team-lessons was already scaffolded by an earlier migrate().
      const scaffoldedRoot = makeProject();
      applyMinimalManifest(scaffoldedRoot);
      await migrate(scaffoldedRoot);
      writeRawSettings(scaffoldedRoot, settings);
      assert.deepEqual(
        hookNoticesOf(await migrate(scaffoldedRoot, { dryRun: true })),
        hookNoticesOf(await migrate(scaffoldedRoot, { dryRun: false })),
        `post-scaffold case disagreed for ${JSON.stringify(settings)}`,
      );
    }
  });

  test('a hook-only notice does not change exitCode semantics under --dry-run', async () => {
    const root = makeProject();
    applyMinimalManifest(root);
    await migrate(root); // scaffold everything first, so only the hook step can produce a notice
    writeRawSettings(root, { hooks: {} }); // both events unregistered

    const dryResult = await migrate(root, { dryRun: true });

    assert.ok(hookNoticesOf(dryResult).length > 0, 'sanity check: a notice actually fired');
    assert.equal(dryResult.pending, 0, 'a notice-only finding must not count as pending work');
    assert.equal(dryResult.exitCode, 0, 'notices must not flip exitCode — only addable files do');
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

    for (const badArgs of [['migrate', '--bogus'], ['migrate', '--dry-run', '--bogus']]) {
      const result = runCli(badArgs, root);
      assert.equal(result.status, 1, `expected ${badArgs.join(' ')} to exit 1`);
      assert.match(result.stdout + result.stderr, /Usage: ccteams migrate/);
    }
  });

  test('"migrate --yes" alone is accepted (not rejected as an unknown flag)', () => {
    const root = makeProject();
    applyMinimalManifest(root);

    const result = runCli(['migrate', '--yes'], root);

    assert.equal(result.status, 0);
    assert.doesNotMatch(result.stdout + result.stderr, /Unknown option/);
  });

  test('"migrate --force" without "--yes" is rejected with exit 1 and a specific message (not the generic usage text)', () => {
    const root = makeProject();
    applyMinimalManifest(root);

    const result = runCli(['migrate', '--force'], root);

    assert.equal(result.status, 1);
    assert.match(result.stderr, /"--force" only takes effect together with "--yes"/);
    // This is a DIFFERENT failure than an unrecognized flag — it must not be
    // reported via the generic "Unknown option(s)" / usage-dump path.
    assert.doesNotMatch(result.stderr, /Unknown option/);
  });

  test('"migrate --yes --force" is accepted together', () => {
    const root = makeProject();
    applyMinimalManifest(root);

    const result = runCli(['migrate', '--yes', '--force'], root);

    assert.equal(result.status, 0);
    assert.doesNotMatch(result.stdout + result.stderr, /only takes effect together/);
  });

  test('"ccteams --help" usage text includes migrate', () => {
    const result = runCli(['--help'], makeProject());
    assert.equal(result.status, 0);
    assert.match(result.stdout, /ccteams migrate/);
    assert.match(result.stdout, /--dry-run/);
    assert.match(result.stdout, /ccteams migrate --yes\b/);
    assert.match(result.stdout, /ccteams migrate --yes --force/);
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
  for (const relPath of [
    path.join('lib', 'migrate.js'),
    path.join('lib', 'manifest.js'),
    path.join('bin', 'ccteams.js'),
  ]) {
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
