/**
 * Tests for the team-lessons TEMPLATE ownership split (Issue #60):
 * lib/team-lessons-template.js's pure decision functions and ledger
 * invariants, plus lib/migrate.js's teamLessonsTemplateStep end to end.
 *
 * Uses only node:test + node:assert — the package has no dependencies and the
 * CLI must keep working in projects that have none either.
 *
 * Fixture convention: a "project" is a temp dir with a minimal v4 manifest and
 * a hand-built `.claude/skills/team-lessons/`, so each test states exactly
 * which generation of the template it is starting from. The REAL shipped
 * scaffold is used everywhere except the one test that must reproduce a
 * HISTORICAL generation — those bytes exist only in this repo's git history, so
 * that test injects a fake template + ledger through migrate()'s documented
 * `teamLessonsTemplate` seam (see migrate()'s opts).
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  existsSync,
  copyFileSync,
  rmSync,
} from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { migrate, MIGRATION_STEPS } from '../lib/migrate.js';
import { writeManifest } from '../lib/manifest.js';
import { TEAM_LESSONS_SCAFFOLD_DIR } from '../lib/use.js';
import {
  TEAM_LESSONS_OWNED_FILES,
  TEAM_LESSONS_LEDGER_FILES,
  TEAM_LESSONS_HASH_LEDGER,
  TEAM_LESSONS_TEMPLATE_VERSION,
  TEMPLATE_VERSION_RE,
  OUTDATED_SIGNATURE,
  OUTDATED_SIGNATURE_INTRODUCED_IN,
  classifyTemplateGeneration,
  findLedgerVersion,
  isKnownShippedHash,
  packageTemplateVersion,
  readTemplateVersion,
  signatureIsOutdated,
} from '../lib/team-lessons-template.js';

const MARKER_REL = 'scripts/template-version.mjs';
const GEN_REL = 'scripts/gen-lessons.mjs';

/**
 * Independent EOL-normalized sha256 — deliberately NOT lib/hash.js's own
 * implementation, matching this suite's convention (see test/hash.test.mjs and
 * test/use.test.mjs) so a bug shared between helper and assertion cannot hide.
 */
const normSha256 = (text) =>
  createHash('sha256').update(text.replace(/\r\n/g, '\n'), 'utf8').digest('hex');

const makeProject = () => mkdtempSync(path.join(tmpdir(), 'ccteams-tl-template-'));

/** Write a minimal, valid v4 manifest (one applied team, no placed files). */
const applyMinimalManifest = (root) => {
  writeManifest(root, {
    teams: { generalist: { appliedAt: new Date().toISOString(), placedFiles: [], agentTeams: false } },
  });
};

const teamLessonsDir = (root) => path.join(root, '.claude', 'skills', 'team-lessons');
const relPathIn = (dir, rel) => path.join(dir, ...rel.split('/'));
const shippedPath = (rel) => relPathIn(TEAM_LESSONS_SCAFFOLD_DIR, rel);
const shippedBytes = (rel) => readFileSync(shippedPath(rel));

/** Write `content` at `rel` under `dir`, creating parent directories. */
function writeRel(dir, rel, content) {
  const abs = relPathIn(dir, rel);
  mkdirSync(path.dirname(abs), { recursive: true });
  writeFileSync(abs, content, 'utf8');
  return abs;
}

/** Byte-level snapshot of one file, or null when it does not exist. */
const bytesOf = (abs) => (existsSync(abs) ? readFileSync(abs).toString('base64') : null);

const templateStepOf = (result) => {
  const step = result.steps.find((s) => s.id === 'team-lessons-template');
  assert.ok(step, `no team-lessons-template step; ids: ${result.steps.map((s) => s.id).join(', ')}`);
  return step;
};

/**
 * An older gen-lessons.mjs a formatter has reflowed: it matches NO ledger hash
 * (so the hash path cannot rescue it) and contains no `applies_when` (so the
 * functional signature still proves it predates generation 3). This is the
 * exact shape Issue #60 measured prettier producing.
 */
const REFORMATTED_OLD_GEN = `#!/usr/bin/env node
/** An older team-lessons generator, reflowed by a formatter. */
export const CATALOG_START = '<!-- team-lessons:catalog:start -->';
export const CATALOG_END = '<!-- team-lessons:catalog:end -->';

export function renderCatalog(lessons) {
  return lessons.map((lesson) => \`- \${lesson.symptom} — \${lesson.summary}\`).join('\\n');
}
`;

const USER_SKILL_MD = `---
name: team-lessons
---

# My project's own lessons index — ccteams must never rewrite this file.
`;

const USER_LESSON_MD = `---
symptom: something broke
summary: do it the other way
---

The full lesson body, written by a human.
`;

/**
 * A project stuck on a pre-marker team-lessons generation whose generator was
 * reformatted: user-owned SKILL.md and lessons/01-*.md present, an outdated
 * gen-lessons.mjs, and NO scripts/template-version.mjs.
 */
function seedReformattedOldProject() {
  const root = makeProject();
  applyMinimalManifest(root);
  const dir = teamLessonsDir(root);
  writeRel(dir, 'SKILL.md', USER_SKILL_MD);
  writeRel(dir, 'lessons/01-example.md', USER_LESSON_MD);
  writeRel(dir, GEN_REL, REFORMATTED_OLD_GEN);
  return root;
}

/** A project whose four ccteams-owned files are byte-identical to the shipped ones. */
function seedCurrentProject() {
  const root = makeProject();
  applyMinimalManifest(root);
  const dir = teamLessonsDir(root);
  writeRel(dir, 'SKILL.md', USER_SKILL_MD);
  for (const rel of TEAM_LESSONS_OWNED_FILES) {
    const abs = relPathIn(dir, rel);
    mkdirSync(path.dirname(abs), { recursive: true });
    copyFileSync(shippedPath(rel), abs);
  }
  return root;
}

describe('team-lessons template ledger — maintainer invariants', () => {
  test('ledger versions start at 1 and strictly increase', () => {
    assert.ok(TEAM_LESSONS_HASH_LEDGER.length > 0, 'the ledger must not be empty');
    assert.equal(TEAM_LESSONS_HASH_LEDGER[0].version, 1);
    for (let i = 1; i < TEAM_LESSONS_HASH_LEDGER.length; i += 1) {
      assert.ok(
        TEAM_LESSONS_HASH_LEDGER[i].version > TEAM_LESSONS_HASH_LEDGER[i - 1].version,
        `ledger entry ${i} (version ${TEAM_LESSONS_HASH_LEDGER[i].version}) does not come after ` +
          `entry ${i - 1} (version ${TEAM_LESSONS_HASH_LEDGER[i - 1].version})`,
      );
    }
  });

  test('TEAM_LESSONS_TEMPLATE_VERSION equals the last ledger entry\'s version', () => {
    const last = TEAM_LESSONS_HASH_LEDGER[TEAM_LESSONS_HASH_LEDGER.length - 1];
    assert.equal(
      TEAM_LESSONS_TEMPLATE_VERSION,
      last.version,
      'scaffold/team-lessons/scripts/template-version.mjs and the last ledger entry disagree — ' +
        'bump one to match the other',
    );
    assert.equal(packageTemplateVersion(), TEAM_LESSONS_TEMPLATE_VERSION);
  });

  test('the shipped scaffold hashes exactly match the last ledger entry', () => {
    const last = TEAM_LESSONS_HASH_LEDGER[TEAM_LESSONS_HASH_LEDGER.length - 1];
    const actual = {};
    for (const rel of TEAM_LESSONS_LEDGER_FILES) {
      actual[rel] = normSha256(readFileSync(shippedPath(rel), 'utf8'));
    }
    assert.deepEqual(
      actual,
      { ...last.files },
      'scaffold/team-lessons/ no longer matches ledger entry v' +
        `${last.version}. A ccteams-owned template file changed: append a NEW ledger entry with ` +
        'these hashes to TEAM_LESSONS_HASH_LEDGER in lib/team-lessons-template.js, and bump ' +
        'TEAM_LESSONS_TEMPLATE_VERSION in scaffold/team-lessons/scripts/template-version.mjs to match.',
    );
  });

  test('the marker file is owned but deliberately absent from the ledger', () => {
    assert.ok(TEAM_LESSONS_OWNED_FILES.includes(MARKER_REL));
    assert.ok(!TEAM_LESSONS_LEDGER_FILES.includes(MARKER_REL));
    // Hashing the marker into the ledger would be self-referential: bumping the
    // number changes the file, which changes the hash, forever.
    for (const entry of TEAM_LESSONS_HASH_LEDGER) {
      assert.ok(!(MARKER_REL in entry.files), `v${entry.version} must not record the marker file`);
    }
  });

  test('TEAM_LESSONS_OWNED_FILES is sorted, so processing order is deterministic', () => {
    assert.deepEqual(TEAM_LESSONS_OWNED_FILES, [...TEAM_LESSONS_OWNED_FILES].sort());
  });

  test('the generation marker is processed LAST — a load-bearing property, not alphabetical luck', () => {
    // teamLessonsTemplateStep decides whether it may advance the marker by
    // asking "did every owned file seen so far end up current?". That single
    // check is only sufficient because the marker comes last in the iteration
    // order (THE MARKER INVARIANT, half one, in lib/migrate.js). Today that
    // falls out of ASCII sorting; this assertion is what turns it from an
    // accident into a checked contract, so renaming a template file into a
    // position after the marker fails here rather than silently reintroducing
    // the "current marker beside a stale file" freeze.
    assert.equal(
      TEAM_LESSONS_OWNED_FILES[TEAM_LESSONS_OWNED_FILES.length - 1],
      MARKER_REL,
      `${MARKER_REL} must be processed after every other ccteams-owned file`,
    );
  });
});

describe('classifyTemplateGeneration()', () => {
  const base = { markerVersion: null, packageVersion: 5, ledgerVersion: null, signatureIsOld: false };

  test('marker above the package version → newer (a downgraded CLI)', () => {
    assert.equal(classifyTemplateGeneration({ ...base, markerVersion: 6 }), 'newer');
  });

  test('marker equal to the package version → current', () => {
    assert.equal(classifyTemplateGeneration({ ...base, markerVersion: 5 }), 'current');
  });

  test('marker below the package version → outdated-marker', () => {
    assert.equal(classifyTemplateGeneration({ ...base, markerVersion: 4 }), 'outdated-marker');
  });

  test('no marker but a ledger hit → outdated-ledger', () => {
    assert.equal(classifyTemplateGeneration({ ...base, ledgerVersion: 2 }), 'outdated-ledger');
  });

  test('no marker, no ledger hit, old signature → outdated-signature', () => {
    assert.equal(classifyTemplateGeneration({ ...base, signatureIsOld: true }), 'outdated-signature');
  });

  test('no marker, no ledger hit, silent signature → outdated-unknown', () => {
    assert.equal(classifyTemplateGeneration(base), 'outdated-unknown');
  });

  test('the marker beats the ledger AND the signature', () => {
    // A project whose files match an old ledger entry and lack the signature,
    // but whose marker says "current", must be left alone: the marker is
    // ccteams' own bookkeeping and outranks every content-derived guess.
    assert.equal(
      classifyTemplateGeneration({
        markerVersion: 5,
        packageVersion: 5,
        ledgerVersion: 1,
        signatureIsOld: true,
      }),
      'current',
    );
  });

  test('the ledger beats the signature', () => {
    assert.equal(
      classifyTemplateGeneration({ ...base, ledgerVersion: 3, signatureIsOld: true }),
      'outdated-ledger',
    );
  });
});

describe('readTemplateVersion()', () => {
  const makeDir = () => mkdtempSync(path.join(tmpdir(), 'ccteams-marker-'));

  test('parses the marker file this package actually ships', () => {
    assert.equal(readTemplateVersion(shippedPath(MARKER_REL)), TEAM_LESSONS_TEMPLATE_VERSION);
  });

  test('prose that mentions the constant does not outrank the real declaration', () => {
    // The shipped marker file's own doc comment discusses the extraction regex
    // and spells the constant out. That prose must never be mistaken for the
    // declaration — which is exactly what the `export const` prefix in
    // TEMPLATE_VERSION_RE buys, and what this test pins. Reproduces the shape of
    // the real file: an escaped mention of the pattern, a bare mention of the
    // identifier, and a decoy assignment WITHOUT the `export const` prefix, all
    // ABOVE the single real declaration.
    const dir = makeDir();
    const p = path.join(dir, 'template-version.mjs');
    writeFileSync(
      p,
      [
        '/**',
        ' * Extracted with `export\\s+const\\s+TEAM_LESSONS_TEMPLATE_VERSION\\s*=\\s*(\\d+)`.',
        ' * Bumping TEAM_LESSONS_TEMPLATE_VERSION also requires a ledger entry.',
        ' * A historical note: TEAM_LESSONS_TEMPLATE_VERSION = 99 was never shipped.',
        ' */',
        'export const TEAM_LESSONS_TEMPLATE_VERSION = 42;',
        '',
      ].join('\n'),
      'utf8',
    );
    assert.equal(
      readTemplateVersion(p),
      42,
      'a doc comment mentioning the constant won over the real `export const` declaration',
    );
  });

  test('tolerates formatting variance around the assignment', () => {
    const dir = makeDir();
    const variants = [
      'export const TEAM_LESSONS_TEMPLATE_VERSION=42;\n',
      'export const TEAM_LESSONS_TEMPLATE_VERSION   =   42;\n',
      "/** doc with a 'quoted string' and an = sign */\nexport const TEAM_LESSONS_TEMPLATE_VERSION = 42;\n",
      'export const TEAM_LESSONS_TEMPLATE_VERSION = 42;\r\n',
    ];
    variants.forEach((body, i) => {
      const p = path.join(dir, `v${i}.mjs`);
      writeFileSync(p, body, 'utf8');
      assert.equal(readTemplateVersion(p), 42, `variant ${i} did not parse: ${JSON.stringify(body)}`);
    });
  });

  test('returns null for a missing file', () => {
    assert.equal(readTemplateVersion(path.join(makeDir(), 'absent.mjs')), null);
  });

  test('returns null for a file without the constant', () => {
    const p = path.join(makeDir(), 'other.mjs');
    writeFileSync(p, 'export const SOMETHING_ELSE = 3;\n', 'utf8');
    assert.equal(readTemplateVersion(p), null);
  });

  test('TEMPLATE_VERSION_RE captures the digits and nothing else', () => {
    const m = TEMPLATE_VERSION_RE.exec('export const TEAM_LESSONS_TEMPLATE_VERSION = 123;');
    assert.equal(m?.[1], '123');
  });
});

describe('findLedgerVersion()', () => {
  const LEDGER = [
    { version: 1, files: { a: 'ha1', b: 'hb1' } },
    { version: 2, files: { a: 'ha2', b: 'hb1' } },
    { version: 3, files: { a: 'ha2', b: 'hb1' } }, // identical content to v2
  ];

  test('returns the HIGHEST matching entry, not the first', () => {
    assert.equal(findLedgerVersion(new Map([['a', 'ha2'], ['b', 'hb1']]), LEDGER), 3);
  });

  test('returns the matching entry when only one qualifies', () => {
    assert.equal(findLedgerVersion(new Map([['a', 'ha1'], ['b', 'hb1']]), LEDGER), 1);
  });

  test('returns null when a listed file\'s hash does not match', () => {
    assert.equal(findLedgerVersion(new Map([['a', 'ha1'], ['b', 'REFORMATTED']]), LEDGER), null);
  });

  test('returns null when a listed file is absent (null hash)', () => {
    // "could not read it" is not evidence that the bytes match.
    assert.equal(findLedgerVersion(new Map([['a', 'ha1'], ['b', null]]), LEDGER), null);
  });

  test('defaults to the real shipped ledger and recognizes the current template', () => {
    const disk = new Map(
      TEAM_LESSONS_LEDGER_FILES.map((rel) => [rel, normSha256(readFileSync(shippedPath(rel), 'utf8'))]),
    );
    assert.equal(findLedgerVersion(disk), TEAM_LESSONS_TEMPLATE_VERSION);
  });
});

describe('isKnownShippedHash()', () => {
  test('true for a hash ccteams historically shipped for that path', () => {
    const v1 = TEAM_LESSONS_HASH_LEDGER[0];
    assert.equal(isKnownShippedHash(GEN_REL, v1.files[GEN_REL]), true);
  });

  test('false for an unknown hash', () => {
    assert.equal(isKnownShippedHash(GEN_REL, normSha256(REFORMATTED_OLD_GEN)), false);
  });

  test('false when the hash belongs to a DIFFERENT path', () => {
    const v1 = TEAM_LESSONS_HASH_LEDGER[0];
    assert.equal(isKnownShippedHash('AUTHORING.md', v1.files[GEN_REL]), false);
  });

  test('false for a null hash (unreadable file)', () => {
    assert.equal(isKnownShippedHash(GEN_REL, null), false);
  });
});

describe('signatureIsOutdated()', () => {
  test('true for generator text that lacks applies_when', () => {
    assert.equal(signatureIsOutdated(REFORMATTED_OLD_GEN), true);
  });

  test('false for the generator this package ships (it has applies_when)', () => {
    assert.equal(signatureIsOutdated(readFileSync(shippedPath(GEN_REL), 'utf8')), false);
  });

  test('false for null — an unread file establishes nothing', () => {
    assert.equal(signatureIsOutdated(null), false);
    assert.equal(signatureIsOutdated(undefined), false);
  });
});

describe('migrate() — teamLessonsTemplateStep', () => {
  test('the template step runs FIRST, before the scaffold step', () => {
    const ids = MIGRATION_STEPS.map((s) => s.id);
    assert.equal(ids[0], 'team-lessons-template');
    assert.ok(
      ids.indexOf('team-lessons-scaffold') > 0,
      `team-lessons-scaffold must come after the template step; got ${ids.join(', ')}`,
    );
  });

  /**
   * THE ORDER REGRESSION. If teamLessonsScaffoldStep ran first it would place
   * the CURRENT scripts/template-version.mjs into this pre-marker project; the
   * generation check would then read that freshly-written marker, conclude
   * 'current', and leave gen-lessons.mjs stale forever — which is exactly the
   * bug Issue #60 reports. Asserting BOTH halves is the point: the marker must
   * end up present AND the old generator must have been replaced in the same
   * run.
   */
  test('a pre-marker project gets its generator updated AND the marker added, in one run', async () => {
    const root = seedReformattedOldProject();
    const dir = teamLessonsDir(root);

    const result = await migrate(root, { yes: true, force: true });

    assert.equal(result.success, true, result.message);
    assert.ok(
      readFileSync(relPathIn(dir, GEN_REL)).equals(shippedBytes(GEN_REL)),
      'scripts/gen-lessons.mjs was not updated to the shipped version',
    );
    assert.ok(existsSync(relPathIn(dir, MARKER_REL)), 'scripts/template-version.mjs was not added');
    assert.deepEqual(templateStepOf(result).updated, [GEN_REL]);
    // A second run now reads the marker and finds nothing left to do.
    const second = await migrate(root, { yes: true, force: true });
    assert.deepEqual(templateStepOf(second).updated, []);
    assert.deepEqual(templateStepOf(second).notices, []);
  });

  test('SKILL.md and lessons/** are byte-identical after a run that DOES update template files', async () => {
    const root = seedReformattedOldProject();
    const dir = teamLessonsDir(root);
    const skillPath = relPathIn(dir, 'SKILL.md');
    const lessonPath = relPathIn(dir, 'lessons/01-example.md');
    const before = { skill: bytesOf(skillPath), lesson: bytesOf(lessonPath) };

    const result = await migrate(root, { yes: true, force: true });

    assert.ok(
      templateStepOf(result).updated.length > 0,
      'sanity check: this run must actually have updated a template file',
    );
    assert.equal(bytesOf(skillPath), before.skill, 'SKILL.md was modified — it is user-owned');
    assert.equal(bytesOf(lessonPath), before.lesson, 'lessons/01-example.md was modified — it is user-owned');
  });

  test('a reformatted old generator is left alone without --force, and reported with the formatter guidance', async () => {
    const root = seedReformattedOldProject();
    const genPath = relPathIn(teamLessonsDir(root), GEN_REL);
    const before = bytesOf(genPath);

    const result = await migrate(root);

    assert.equal(bytesOf(genPath), before, 'the drifted generator must not be overwritten without --force');
    assert.deepEqual(templateStepOf(result).updated, []);
    const notices = templateStepOf(result).notices.join('\n');
    assert.match(notices, /Some ccteams-owned team-lessons files were left as they are/);
    assert.match(notices, /no longer match any version ccteams shipped/);
    assert.ok(notices.includes(GEN_REL), `the notice must name the file, got:\n${notices}`);
    assert.match(notices, /prettier/);
    assert.match(notices, /ccteams migrate --yes --force/);
    assert.match(notices, /re-run your formatter/);
    assert.match(notices, /interactive terminal/);
    // The step never established WHO changed the file, so it may not say so.
    assert.doesNotMatch(notices, /you have edited|you edited|your edit/i);
    // The whole report carries the guidance too (this is what a user sees).
    assert.match(result.message, /team-lessons template files/);
  });

  test('the same reformatted generator IS overwritten with --yes --force', async () => {
    const root = seedReformattedOldProject();
    const genPath = relPathIn(teamLessonsDir(root), GEN_REL);

    const result = await migrate(root, { yes: true, force: true });

    assert.ok(readFileSync(genPath).equals(shippedBytes(GEN_REL)));
    assert.deepEqual(templateStepOf(result).updated, [GEN_REL]);
    assert.deepEqual(templateStepOf(result).notices, []);
  });

  test('--dry-run predicts exactly what a real run then does, and writes nothing', async () => {
    const root = seedReformattedOldProject();
    const genPath = relPathIn(teamLessonsDir(root), GEN_REL);
    const before = bytesOf(genPath);

    const dryResult = await migrate(root, { dryRun: true, yes: true, force: true });

    assert.equal(bytesOf(genPath), before, '--dry-run wrote to disk');
    assert.deepEqual(templateStepOf(dryResult).updated, [GEN_REL]);
    assert.match(dryResult.message, /would be updated/);

    const realResult = await migrate(root, { yes: true, force: true });

    assert.deepEqual(
      templateStepOf(realResult).updated,
      templateStepOf(dryResult).updated,
      'dry-run and the real run disagreed about which files get updated',
    );
    assert.ok(readFileSync(genPath).equals(shippedBytes(GEN_REL)));
  });

  test("'current' generation: no heading, no notices, no writes", async () => {
    const root = seedCurrentProject();
    const dir = teamLessonsDir(root);
    const before = Object.fromEntries(
      TEAM_LESSONS_OWNED_FILES.map((rel) => [rel, bytesOf(relPathIn(dir, rel))]),
    );

    const result = await migrate(root, { yes: true, force: true });

    const step = templateStepOf(result);
    assert.deepEqual(step.updated, []);
    assert.deepEqual(step.notices, []);
    assert.doesNotMatch(result.message, /team-lessons template files/);
    for (const rel of TEAM_LESSONS_OWNED_FILES) {
      assert.equal(bytesOf(relPathIn(dir, rel)), before[rel], `${rel} was written on a 'current' install`);
    }
  });

  test("'outdated-marker': only the marker file is refreshed, silently, and the next run is quiet", async () => {
    const root = seedCurrentProject();
    const dir = teamLessonsDir(root);
    const markerPath = relPathIn(dir, MARKER_REL);
    // Derived, never a literal: the package's generation is bumped whenever a
    // template file changes, and a hardcoded number would silently stop being
    // "one generation older" at the next bump.
    writeFileSync(
      markerPath,
      `export const TEAM_LESSONS_TEMPLATE_VERSION = ${packageTemplateVersion() - 1};\n`,
      'utf8',
    );

    // No --yes, no --force, no prompt: a parsable marker is ccteams' own
    // bookkeeping, so refreshing it needs no confirmation.
    const result = await migrate(root);

    assert.deepEqual(templateStepOf(result).updated, [MARKER_REL]);
    assert.deepEqual(templateStepOf(result).notices, []);
    assert.ok(readFileSync(markerPath).equals(shippedBytes(MARKER_REL)));

    const second = await migrate(root);
    assert.deepEqual(templateStepOf(second).updated, []);
    assert.deepEqual(templateStepOf(second).notices, []);
  });

  test("'newer': reported only — not one file is touched", async () => {
    const root = seedCurrentProject();
    const dir = teamLessonsDir(root);
    const newerMarker = `export const TEAM_LESSONS_TEMPLATE_VERSION = ${TEAM_LESSONS_TEMPLATE_VERSION + 5};\n`;
    writeFileSync(relPathIn(dir, MARKER_REL), newerMarker, 'utf8');
    const before = Object.fromEntries(
      TEAM_LESSONS_OWNED_FILES.map((rel) => [rel, bytesOf(relPathIn(dir, rel))]),
    );

    const result = await migrate(root, { yes: true, force: true });

    const step = templateStepOf(result);
    assert.deepEqual(step.updated, []);
    const notices = step.notices.join('\n');
    assert.match(notices, /NEWER/);
    assert.match(notices, new RegExp(String(TEAM_LESSONS_TEMPLATE_VERSION + 5)));
    for (const rel of TEAM_LESSONS_OWNED_FILES) {
      assert.equal(bytesOf(relPathIn(dir, rel)), before[rel], `${rel} was modified on a 'newer' install`);
    }
  });

  /**
   * The 'outdated-ledger' path: an install with no marker whose files are still
   * byte-for-byte a generation ccteams shipped. Those historical bytes live only
   * in git history, so this drives migrate() through its documented
   * `teamLessonsTemplate` test seam with a fake template dir + ledger. No
   * --force and no prompt: a ledger hit PROVES the copy is unedited, so the
   * refresh needs no confirmation.
   */
  test("'outdated-ledger': unedited pre-marker files are refreshed with no --force and no prompt", async () => {
    const fakeScaffold = mkdtempSync(path.join(tmpdir(), 'ccteams-fake-scaffold-'));
    const oldContent = {
      'AUTHORING.md': '# authoring, generation one\n',
      // Contains applies_when on purpose: the signature path must NOT be what
      // rescues this fixture — the ledger alone has to.
      [GEN_REL]: "export const KEY = 'applies_when';\n// generation one\n",
      'scripts/lessons-index.mjs': '// index, generation one\n',
    };
    const newContent = {
      'AUTHORING.md': '# authoring, generation two\n',
      [GEN_REL]: "export const KEY = 'applies_when';\n// generation two\n",
      'scripts/lessons-index.mjs': '// index, generation two\n',
      [MARKER_REL]: 'export const TEAM_LESSONS_TEMPLATE_VERSION = 2;\n',
    };
    for (const [rel, body] of Object.entries(newContent)) writeRel(fakeScaffold, rel, body);

    const fakeLedger = [
      { version: 1, files: Object.fromEntries(Object.entries(oldContent).map(([r, b]) => [r, normSha256(b)])) },
      { version: 2, files: Object.fromEntries(Object.entries(oldContent).map(([r]) => [r, normSha256(newContent[r])])) },
    ];

    const root = makeProject();
    applyMinimalManifest(root);
    const dir = teamLessonsDir(root);
    writeRel(dir, 'SKILL.md', USER_SKILL_MD);
    for (const [rel, body] of Object.entries(oldContent)) writeRel(dir, rel, body);

    const result = await migrate(root, {
      teamLessonsTemplate: { scaffoldDir: fakeScaffold, ledger: fakeLedger, packageVersion: 2 },
      prompt: null, // prove no confirmation was needed
    });

    const step = templateStepOf(result);
    assert.deepEqual(step.updated, ['AUTHORING.md', GEN_REL, 'scripts/lessons-index.mjs']);
    assert.deepEqual(step.notices, []);
    for (const rel of Object.keys(oldContent)) {
      assert.equal(
        readFileSync(relPathIn(dir, rel), 'utf8'),
        newContent[rel],
        `${rel} was not refreshed from the injected template`,
      );
    }
  });

  /**
   * The same 'outdated-ledger' path, but with the project's files checked out
   * with CRLF line endings (git's core.autocrlf=true on Windows) while the
   * ledger holds LF digests — the state EVERY Windows user is actually in. Only
   * the EOL-normalized hashing (lib/hash.js's hashFileNormalizedSync) can match
   * these; a raw-byte comparison would miss every entry and silently downgrade
   * the install to 'outdated-unknown', where nothing is ever refreshed.
   */
  test("'outdated-ledger' still matches when the project's files are a CRLF checkout", async () => {
    const fakeScaffold = mkdtempSync(path.join(tmpdir(), 'ccteams-fake-scaffold-crlf-'));
    const oldLf = { 'AUTHORING.md': '# authoring\n\ngeneration one\n' };
    const newLf = {
      'AUTHORING.md': '# authoring\n\ngeneration two\n',
      [MARKER_REL]: 'export const TEAM_LESSONS_TEMPLATE_VERSION = 2;\n',
    };
    for (const [rel, body] of Object.entries(newLf)) writeRel(fakeScaffold, rel, body);
    // The ledger is built from the LF form, exactly as a git blob would give it.
    const fakeLedger = [{ version: 1, files: { 'AUTHORING.md': normSha256(oldLf['AUTHORING.md']) } }];

    const root = makeProject();
    applyMinimalManifest(root);
    const dir = teamLessonsDir(root);
    writeRel(dir, 'SKILL.md', USER_SKILL_MD);
    writeRel(dir, 'AUTHORING.md', oldLf['AUTHORING.md'].replace(/\n/g, '\r\n'));

    const result = await migrate(root, {
      teamLessonsTemplate: { scaffoldDir: fakeScaffold, ledger: fakeLedger, packageVersion: 2 },
      prompt: null,
    });

    assert.deepEqual(
      templateStepOf(result).updated,
      ['AUTHORING.md'],
      'a CRLF checkout of a shipped generation must still be recognized as unedited',
    );
    assert.equal(readFileSync(relPathIn(dir, 'AUTHORING.md'), 'utf8'), newLf['AUTHORING.md']);
  });

  describe('interactive prompt flow', () => {
    /** A promptFn stub returning pre-scripted answers in order, recording every question. */
    function makeQueuePrompt(answers) {
      const calls = [];
      const fn = async (question) => {
        calls.push(question);
        if (answers.length === 0) throw new Error('prompt called more times than the test scripted');
        return answers.shift();
      };
      fn.calls = calls;
      return fn;
    }

    test('answering "n" keeps the drifted file, and the prompt never claims the user edited it', async () => {
      const root = seedReformattedOldProject();
      const genPath = relPathIn(teamLessonsDir(root), GEN_REL);
      const before = bytesOf(genPath);
      const prompt = makeQueuePrompt(['n']);

      const result = await migrate(root, { prompt });

      assert.equal(prompt.calls.length, 1);
      assert.match(prompt.calls[0], /older team-lessons template generation/);
      assert.doesNotMatch(prompt.calls[0], /you have modified this file/);
      assert.equal(bytesOf(genPath), before);
      assert.deepEqual(templateStepOf(result).updated, []);
    });

    test('answering "y" overwrites that file', async () => {
      const root = seedReformattedOldProject();
      const genPath = relPathIn(teamLessonsDir(root), GEN_REL);
      const prompt = makeQueuePrompt(['y']);

      const result = await migrate(root, { prompt });

      assert.equal(prompt.calls.length, 1);
      assert.ok(readFileSync(genPath).equals(shippedBytes(GEN_REL)));
      assert.deepEqual(templateStepOf(result).updated, [GEN_REL]);
    });

    test('answering "q" skips this file and everything remaining', async () => {
      const root = seedReformattedOldProject();
      // A second drifted owned file, so "everything remaining" has something in it.
      const authoringPath = writeRel(teamLessonsDir(root), 'AUTHORING.md', '# my own authoring notes\n');
      const genPath = relPathIn(teamLessonsDir(root), GEN_REL);
      const prompt = makeQueuePrompt(['q']);

      const result = await migrate(root, { prompt });

      // AUTHORING.md sorts first, so it is the file that gets asked about.
      assert.equal(prompt.calls.length, 1);
      assert.match(prompt.calls[0], /AUTHORING\.md/);
      assert.equal(readFileSync(authoringPath, 'utf8'), '# my own authoring notes\n');
      assert.ok(!readFileSync(genPath).equals(shippedBytes(GEN_REL)));
      assert.deepEqual(templateStepOf(result).updated, []);
      assert.ok(templateStepOf(result).notices.length > 0, 'both skipped files must be reported');
    });

    test('answering "a" overwrites this file and every remaining one without re-asking', async () => {
      const root = seedReformattedOldProject();
      const authoringPath = writeRel(teamLessonsDir(root), 'AUTHORING.md', '# my own authoring notes\n');
      const genPath = relPathIn(teamLessonsDir(root), GEN_REL);
      const prompt = makeQueuePrompt(['a']);

      const result = await migrate(root, { prompt });

      assert.equal(prompt.calls.length, 1, '"a" must not ask again for the remaining files');
      assert.ok(readFileSync(authoringPath).equals(shippedBytes('AUTHORING.md')));
      assert.ok(readFileSync(genPath).equals(shippedBytes(GEN_REL)));
      assert.deepEqual(templateStepOf(result).updated, ['AUTHORING.md', GEN_REL]);
    });
  });

  test('an unreadable owned file is reported, never silently treated as up to date', async () => {
    const root = seedReformattedOldProject();
    const dir = teamLessonsDir(root);
    // A DIRECTORY where AUTHORING.md should be: readFileSync throws EISDIR, so
    // the normalized hash is null and no byte was ever compared.
    mkdirSync(relPathIn(dir, 'AUTHORING.md'), { recursive: true });

    const result = await migrate(root, { yes: true, force: true });

    const notices = templateStepOf(result).notices.join('\n');
    assert.match(notices, /could not be read/);
    assert.match(notices, /AUTHORING\.md/);
    assert.ok(!templateStepOf(result).updated.includes('AUTHORING.md'));
  });

  /**
   * THE MARKER INVARIANT (lib/migrate.js): a generation marker on disk asserts
   * that every ccteams-owned team-lessons file is present and current at that
   * generation, so it may not be written while any of them is drifted,
   * unreadable, or deferred.
   *
   * Before this was enforced, plain `ccteams migrate` printed "re-run with
   * --yes --force" AND, in the same run, let teamLessonsScaffoldStep place the
   * current marker. Every later run then read that marker, classified the
   * install 'current', and returned before the per-file loop — so the remedy
   * the tool itself had just printed did nothing, forever. These four tests pin
   * each route into that freeze.
   */
  describe('the generation marker is never recorded while work is outstanding', () => {
    test('a file deferred by a plain run is still updatable by the next --yes --force run', async () => {
      const root = seedReformattedOldProject();
      const dir = teamLessonsDir(root);
      const genPath = relPathIn(dir, GEN_REL);

      // Run 1: no yes/force/prompt — the drifted generator is reported, not written.
      const first = await migrate(root);
      assert.deepEqual(templateStepOf(first).updated, []);
      assert.equal(
        existsSync(relPathIn(dir, MARKER_REL)),
        false,
        'the marker must NOT be on disk while a drifted file is outstanding',
      );

      // Run 2: the user does exactly what run 1 told them to do.
      const second = await migrate(root, { yes: true, force: true });

      assert.deepEqual(
        templateStepOf(second).updated,
        [GEN_REL],
        'the advice the tool printed in run 1 must still work in run 2',
      );
      assert.ok(readFileSync(genPath).equals(shippedBytes(GEN_REL)));
      // Only now, with nothing outstanding, may the marker be recorded.
      assert.ok(existsSync(relPathIn(dir, MARKER_REL)), 'the marker must be recorded once work is done');
    });

    test('an existing marker is never advanced while another owned file is drifted', async () => {
      // The SECOND half of THE MARKER INVARIANT (lib/migrate.js, the marker
      // branch inside the per-file loop). The sibling test above covers a
      // project with NO marker, where the withheld-paths set does the work.
      // This one covers a project that ALREADY HAS one, where the only thing
      // standing between the user and a permanently frozen template is the
      // guard in that branch.
      //
      // Without it, run 1 advances the marker to the package's generation while
      // AUTHORING.md is still the user's — after which every later run
      // classifies the project 'current', returns before the per-file loop, and
      // `--yes --force` can never repair it. That is exactly the freeze bug
      // this issue exists to fix, just reached from a marker-bearing project.
      const root = seedCurrentProject();
      const dir = teamLessonsDir(root);
      const markerPath = relPathIn(dir, MARKER_REL);
      const authoringPath = relPathIn(dir, 'AUTHORING.md');
      const older = packageTemplateVersion() - 1;
      writeFileSync(markerPath, `export const TEAM_LESSONS_TEMPLATE_VERSION = ${older};\n`, 'utf8');
      writeFileSync(authoringPath, '# my own authoring notes\n', 'utf8');

      // Run 1: no yes/force/prompt. AUTHORING.md matches no shipped version, so
      // it is deferred — and the marker must not move past it.
      const first = await migrate(root);
      assert.deepEqual(
        templateStepOf(first).updated,
        [],
        'nothing may be written while the only outstanding file needs a decision',
      );
      assert.equal(
        readTemplateVersion(markerPath),
        older,
        'the marker must not advance past an unresolved file — doing so freezes it as "current" forever',
      );
      assert.ok(
        templateStepOf(first).notices.join('\n').includes('AUTHORING.md'),
        'the deferred file must be reported',
      );

      // Run 2: the user does what run 1 told them to. Both the file AND the
      // marker settle, in that order.
      const second = await migrate(root, { yes: true, force: true });
      const updated = templateStepOf(second).updated;
      assert.ok(updated.includes('AUTHORING.md'), `expected AUTHORING.md in ${JSON.stringify(updated)}`);
      assert.ok(updated.includes(MARKER_REL), `expected ${MARKER_REL} in ${JSON.stringify(updated)}`);
      assert.ok(
        readFileSync(authoringPath).equals(shippedBytes('AUTHORING.md')),
        'the advice printed in run 1 must actually repair the file',
      );
      assert.equal(
        readTemplateVersion(markerPath),
        packageTemplateVersion(),
        'only once nothing is outstanding may the marker record the current generation',
      );
    });

    test('answering "q" defers the finding rather than silencing it forever', async () => {
      const root = seedReformattedOldProject();
      const dir = teamLessonsDir(root);
      writeRel(dir, 'AUTHORING.md', '# my own authoring notes\n');

      await migrate(root, { prompt: async () => 'q' });
      assert.equal(existsSync(relPathIn(dir, MARKER_REL)), false);

      // Next run, no prompt: the deferred finding must come back, naming BOTH files.
      const second = await migrate(root);
      const notices = templateStepOf(second).notices.join('\n');

      assert.ok(notices.length > 0, '"q" meant "not now", not "never ask again"');
      assert.ok(notices.includes('AUTHORING.md'), `expected AUTHORING.md in:\n${notices}`);
      assert.ok(notices.includes(GEN_REL), `expected ${GEN_REL} in:\n${notices}`);
    });

    // NOT an exit-code guarantee: a file awaiting the user's decision
    // deliberately does not affect exitCode (README's rule, and ownedFilesStep
    // behaves the same). What must survive is the REPORTING — the drift has to
    // keep being named on every later run instead of going quiet.
    test('a --dry-run keeps reporting the drift until it is actually resolved', async () => {
      const root = seedReformattedOldProject();

      const beforeAnything = await migrate(root, { dryRun: true });
      assert.ok(
        templateStepOf(beforeAnything).notices.length > 0,
        'sanity check: the drift is reported before any run',
      );

      // A real run that resolves nothing (no --force) must not turn the check green.
      await migrate(root);
      const afterRealRun = await migrate(root, { dryRun: true });

      assert.ok(
        templateStepOf(afterRealRun).notices.length > 0,
        'a CI drift check must not go quiet while the file is still stale',
      );

      // Only actually fixing it clears the check.
      await migrate(root, { yes: true, force: true });
      const afterFix = await migrate(root, { dryRun: true });
      assert.deepEqual(templateStepOf(afterFix).notices, []);
      assert.equal(afterFix.exitCode, 0);
    });

    test('an unreadable owned file is re-examined on the next run', async () => {
      const root = seedReformattedOldProject();
      const dir = teamLessonsDir(root);
      const authoringPath = relPathIn(dir, 'AUTHORING.md');
      // A directory where the file belongs: readFileSync throws EISDIR.
      mkdirSync(authoringPath, { recursive: true });

      const first = await migrate(root, { yes: true, force: true });
      assert.match(templateStepOf(first).notices.join('\n'), /could not be read/);
      assert.equal(
        existsSync(relPathIn(dir, MARKER_REL)),
        false,
        'an unreadable file is unresolved work — the marker must be withheld',
      );

      // Clear the unreadable condition, leaving a drifted (but readable) file.
      rmSync(authoringPath, { recursive: true });
      writeFileSync(authoringPath, '# my own authoring notes\n', 'utf8');

      const second = await migrate(root, { yes: true, force: true });

      assert.ok(
        templateStepOf(second).updated.includes('AUTHORING.md'),
        'the previously-unreadable file must be re-examined, not assumed current',
      );
      assert.ok(readFileSync(authoringPath).equals(shippedBytes('AUTHORING.md')));
    });
  });

  test("'newer' does not back-fill missing owned files from the older package", async () => {
    const root = seedCurrentProject();
    const dir = teamLessonsDir(root);
    writeFileSync(
      relPathIn(dir, MARKER_REL),
      `export const TEAM_LESSONS_TEMPLATE_VERSION = ${packageTemplateVersion() + 5};\n`,
      'utf8',
    );
    // A ccteams-owned file this (older) package ships but the project lacks.
    rmSync(relPathIn(dir, 'scripts/lessons-index.mjs'));

    const result = await migrate(root, { yes: true, force: true });

    assert.equal(
      existsSync(relPathIn(dir, 'scripts/lessons-index.mjs')),
      false,
      'a newer install must not be back-filled with an older generation of an owned file',
    );
    const scaffoldStep = result.steps.find((s) => s.id === 'team-lessons-scaffold');
    assert.ok(!scaffoldStep.added.includes('scripts/lessons-index.mjs'));
    assert.ok(!scaffoldStep.kept.includes('scripts/lessons-index.mjs'));
    assert.deepEqual(templateStepOf(result).updated, []);
    // A path reported by no step's rows must at least be NAMED in the notice,
    // or the user has no way to learn it was skipped.
    assert.ok(
      templateStepOf(result).notices.join('\n').includes('scripts/lessons-index.mjs'),
      'the held-back file must be named, not merely alluded to',
    );
  });

  test("'newer' claims nothing was held back when nothing actually was", async () => {
    // The counterpart to the test above. On a complete install, withholding
    // changes nothing, so the notice must not assert that ccteams "held back"
    // files — a report may only claim what its own branch established.
    const root = seedCurrentProject();
    writeFileSync(
      relPathIn(teamLessonsDir(root), MARKER_REL),
      `export const TEAM_LESSONS_TEMPLATE_VERSION = ${packageTemplateVersion() + 5};\n`,
      'utf8',
    );

    const notices = templateStepOf(await migrate(root)).notices.join('\n');

    assert.ok(notices.includes('NEWER'), `sanity check: the downgrade is still reported:\n${notices}`);
    assert.ok(
      !/held back/i.test(notices),
      `nothing was missing, so nothing was held back — got:\n${notices}`,
    );
  });

  test('an unparsable marker falls back to content detection instead of being refreshed silently', async () => {
    const root = seedCurrentProject();
    const dir = teamLessonsDir(root);
    const markerPath = relPathIn(dir, MARKER_REL);
    // Present, but carrying no TEAM_LESSONS_TEMPLATE_VERSION assignment at all:
    // readTemplateVersion() returns null, so the marker cannot vouch for itself.
    writeFileSync(markerPath, "export const NOT_THE_MARKER = 'hello';\n", 'utf8');
    writeFileSync(relPathIn(dir, GEN_REL), REFORMATTED_OLD_GEN, 'utf8');

    const result = await migrate(root);

    // The unparsable marker is NOT ccteams' own bookkeeping any more — it is an
    // unrecognized file, so it takes the drift path like any other.
    assert.deepEqual(templateStepOf(result).updated, []);
    assert.equal(
      readFileSync(markerPath, 'utf8'),
      "export const NOT_THE_MARKER = 'hello';\n",
      'an unparsable marker must not be overwritten without --force',
    );
    const notices = templateStepOf(result).notices.join('\n');
    assert.ok(notices.includes(MARKER_REL), `the notice must name the marker file, got:\n${notices}`);
    assert.ok(notices.includes(GEN_REL));
  });

  test('an unparsable marker is the ONLY outstanding file and is still not refreshed silently', async () => {
    // Deliberately narrower than the test above: there, gen-lessons.mjs is also
    // drifted, so the marker branch's "is everything else resolved?" guard
    // short-circuits and the `markerVersion !== null` gate is never evaluated.
    // Here EVERY other owned file is byte-current, so the loop reaches that gate
    // and it alone decides the outcome — which is what makes this test able to
    // fail if the gate is ever weakened to an unconditional "refresh the
    // marker".
    const root = seedCurrentProject();
    const dir = teamLessonsDir(root);
    const markerPath = relPathIn(dir, MARKER_REL);
    const garbage = "export const NOT_THE_MARKER = 'hello';\n";
    writeFileSync(markerPath, garbage, 'utf8');

    // Generation comes from the ledger: the three ledger files are all current,
    // so this is recognized as the newest shipped content, marker notwithstanding.
    const result = await migrate(root);

    assert.deepEqual(
      templateStepOf(result).updated,
      [],
      'a marker ccteams cannot parse is not its own bookkeeping — it must not be overwritten unasked',
    );
    assert.equal(readFileSync(markerPath, 'utf8'), garbage, 'the unparsable marker was silently rewritten');
    assert.ok(
      templateStepOf(result).notices.join('\n').includes(MARKER_REL),
      'the marker must be reported as needing a decision',
    );
  });

  test("an unreadable PACKAGE source blames ccteams' installation, not the project's file", async () => {
    const fakeScaffold = mkdtempSync(path.join(tmpdir(), 'ccteams-broken-install-'));
    // ccteams' own AUTHORING.md is a DIRECTORY: reading it throws EISDIR, so
    // there is nothing to compare the project's copy against.
    mkdirSync(path.join(fakeScaffold, 'AUTHORING.md'), { recursive: true });

    const root = seedReformattedOldProject();
    const dir = teamLessonsDir(root);
    writeRel(dir, 'AUTHORING.md', '# the project copy, perfectly readable\n');

    const result = await migrate(root, {
      teamLessonsTemplate: { scaffoldDir: fakeScaffold, packageVersion: packageTemplateVersion() },
      yes: true,
      force: true,
    });

    const notices = templateStepOf(result).notices.join('\n');
    assert.match(notices, /CCTEAMS' OWN copy/);
    assert.match(notices, /problem with the ccteams installation, not with your project/);
    assert.ok(notices.includes('AUTHORING.md'));
    // It must NOT be filed under "check your file permissions".
    assert.doesNotMatch(notices, /file\(s\) in this project could not be read/);
  });

  /**
   * The three detection tiers must be DISTINGUISHABLE in what ccteams tells the
   * user, not just internally. Without these, every outdated-* value took one
   * indistinguishable code path and the whole ledger/signature mechanism could
   * be deleted without a behavioral test noticing.
   */
  describe('the drift notice names the evidence that actually identified the generation', () => {
    /** A project with a drifted AUTHORING.md, so a notice is always produced. */
    const seedWithDrift = (extra = () => {}) => {
      const root = makeProject();
      applyMinimalManifest(root);
      const dir = teamLessonsDir(root);
      writeRel(dir, 'SKILL.md', USER_SKILL_MD);
      writeRel(dir, 'AUTHORING.md', '# drifted authoring notes\n');
      extra(dir);
      return root;
    };

    test('outdated-marker states both generation numbers', async () => {
      const older = packageTemplateVersion() - 1;
      const root = seedWithDrift((dir) => {
        writeRel(dir, MARKER_REL, `export const TEAM_LESSONS_TEMPLATE_VERSION = ${older};\n`);
      });

      const notices = templateStepOf(await migrate(root)).notices.join('\n');

      assert.ok(
        notices.includes(`is generation ${older}; ccteams ships generation ${packageTemplateVersion()}`),
        `expected both generation numbers, got:\n${notices}`,
      );
    });

    test('outdated-ledger states the generation it identified by content', async () => {
      // Real ledger, real historical content is unavailable in-process — inject.
      const fakeScaffold = mkdtempSync(path.join(tmpdir(), 'ccteams-evidence-ledger-'));
      writeRel(fakeScaffold, 'AUTHORING.md', '# authoring, generation two\n');
      writeRel(fakeScaffold, 'scripts/lessons-index.mjs', '// index gen two\n');
      const OLD_INDEX = '// index gen one\n';

      const root = seedWithDrift((dir) => writeRel(dir, 'scripts/lessons-index.mjs', OLD_INDEX));
      const fakeLedger = [{ version: 1, files: { 'scripts/lessons-index.mjs': normSha256(OLD_INDEX) } }];

      const notices = templateStepOf(
        await migrate(root, {
          teamLessonsTemplate: { scaffoldDir: fakeScaffold, ledger: fakeLedger, packageVersion: 2 },
        }),
      ).notices.join('\n');

      assert.match(notices, /no generation marker; its file contents identify it as generation 1/);
      assert.doesNotMatch(notices, /never mentions/, 'the ledger matched — do not cite the signature');
    });

    test(`outdated-signature cites the missing "${OUTDATED_SIGNATURE}" token`, async () => {
      const root = seedWithDrift((dir) => writeRel(dir, GEN_REL, REFORMATTED_OLD_GEN));

      const notices = templateStepOf(await migrate(root)).notices.join('\n');

      assert.ok(
        notices.includes(`never mentions "${OUTDATED_SIGNATURE}"`),
        `expected the signature evidence, got:\n${notices}`,
      );
      assert.ok(notices.includes(`predates generation ${OUTDATED_SIGNATURE_INTRODUCED_IN}`));
      assert.doesNotMatch(notices, /file contents identify it as generation/);
    });

    test('outdated-unknown claims only that nothing could be verified', async () => {
      // No marker, no ledger match, and a gen-lessons.mjs that DOES contain the
      // signature token — so no tier can identify anything.
      const root = seedWithDrift((dir) =>
        writeRel(dir, GEN_REL, `// unrecognized content mentioning ${OUTDATED_SIGNATURE}\n`),
      );

      const notices = templateStepOf(await migrate(root)).notices.join('\n');

      assert.match(notices, /predates ccteams' generation tracking/);
      assert.match(notices, /nothing further about it could be verified/);
      assert.doesNotMatch(notices, /file contents identify it as generation/);
      assert.doesNotMatch(notices, /never mentions/);
    });
  });

  /**
   * One run, one verdict per file. teamLessonsTemplateStep and
   * teamLessonsScaffoldStep both operate on `.claude/skills/team-lessons/`, and
   * before the withheld set covered existing owned files a single report could
   * print `~ AUTHORING.md (updated)` under one heading and
   * `= AUTHORING.md (kept as-is)` under the next — flatly contradicting itself
   * about whether the user's generator had been replaced.
   */
  test('no path is reported by two different steps in the same run', async () => {
    const root = seedReformattedOldProject();
    const dir = teamLessonsDir(root);
    // This fixture makes all three row kinds occur in one run: the drifted
    // generator is UPDATED by the template step, the genuinely absent template
    // files are ADDED by the scaffold step, and the user's SKILL.md is KEPT.
    const result = await migrate(root, { yes: true, force: true });

    const seen = new Map(); // display path -> [step id]
    for (const step of result.steps) {
      for (const p of [...step.added, ...(step.updated ?? []), ...step.kept]) {
        if (!seen.has(p)) seen.set(p, []);
        seen.get(p).push(step.id);
      }
    }
    const duplicated = [...seen.entries()].filter(([, ids]) => ids.length > 1);
    assert.deepEqual(
      duplicated,
      [],
      `these paths were reported by more than one step: ${duplicated
        .map(([p, ids]) => `${p} (${ids.join(' + ')})`)
        .join(', ')}`,
    );
    // Sanity: the run really did exercise the overlap (the template step
    // reported the generator, and the scaffold step reported other files).
    assert.ok(templateStepOf(result).updated.includes(GEN_REL));
    assert.ok(
      result.steps.find((s) => s.id === 'team-lessons-scaffold').added.length > 0,
      'sanity check: the scaffold step still adds the files that were genuinely absent',
    );
    assert.ok(existsSync(relPathIn(dir, MARKER_REL)));
  });

  test('the interactive prompt names the file by its PROJECT-relative path', async () => {
    const root = seedReformattedOldProject();
    const calls = [];
    await migrate(root, {
      prompt: async (q) => {
        calls.push(q);
        return 'n';
      },
    });

    assert.equal(calls.length, 1);
    // ownedFilesStep asks about ".claude/agents/builder.md" in the same session,
    // so a bare "scripts/gen-lessons.mjs" would be ambiguous with no heading.
    assert.ok(
      calls[0].includes(`.claude/skills/team-lessons/${GEN_REL}`),
      `prompt must use the project-relative path, got:\n${calls[0]}`,
    );
  });

  test('a project with no team-lessons directory at all produces an empty template step', async () => {
    const root = makeProject();
    applyMinimalManifest(root);
    assert.equal(existsSync(teamLessonsDir(root)), false);

    const result = await migrate(root, { dryRun: true });

    const step = templateStepOf(result);
    assert.deepEqual(step.updated, []);
    assert.deepEqual(step.added, []);
    assert.deepEqual(step.notices, []);
  });
});
