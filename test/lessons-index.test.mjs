/**
 * Tests for the team-lessons index-extraction hook script
 * (scaffold/team-lessons/scripts/lessons-index.mjs).
 *
 * Uses only node:test + node:assert — the package has no dependencies and the
 * script must keep working in projects that have none either.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { CATALOG_START, CATALOG_END, GENERATED_NOTE } from '../scaffold/team-lessons/scripts/gen-lessons.mjs';
import { extractCatalog } from '../scaffold/team-lessons/scripts/lessons-index.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPT = path.join(REPO_ROOT, 'scaffold', 'team-lessons', 'scripts', 'lessons-index.mjs');

const catalogBody = '1. **[S A](lessons/01-a.md)** → M A';

/** Build a SKILL.md's full text the same way gen-lessons.mjs's new layout does. */
const skillWith = (body) =>
  `# T\n\n## Failure catalog\n\n${GENERATED_NOTE}\n${CATALOG_START}\n\n${body}\n${CATALOG_END}\n`;

/**
 * Build a SKILL.md the way the OLD generator laid it out, with the note BETWEEN
 * the markers. `gen-lessons.mjs` is user-owned and never force-upgraded, so every
 * project scaffolded before this change keeps this layout indefinitely — the hook
 * has to read it without leaking the note as if it were a catalog entry.
 */
const oldLayoutSkillWith = (body) =>
  `# T\n\n## Failure catalog\n\n${CATALOG_START}\n${GENERATED_NOTE}\n\n${body}\n${CATALOG_END}\n`;

describe('extractCatalog', () => {
  test('extracts and trims the catalog body between the markers', () => {
    assert.equal(extractCatalog(skillWith(catalogBody)), catalogBody);
  });

  test('returns "" when the markers are missing', () => {
    assert.equal(extractCatalog('# no markers here\n'), '');
  });

  test('returns "" when the markers are present but reversed', () => {
    assert.equal(extractCatalog(`${CATALOG_END}\n${CATALOG_START}\n`), '');
  });

  test('returns "" for the empty-state placeholder ("(none yet)")', () => {
    assert.equal(extractCatalog(skillWith('(none yet)')), '');
  });

  test('normalizes CRLF input to LF', () => {
    const crlf = skillWith(catalogBody).replace(/\n/g, '\r\n');
    assert.equal(extractCatalog(crlf), catalogBody);
  });

  test('returns "" when the markers hold nothing but blank lines', () => {
    assert.equal(extractCatalog(skillWith('   \n\n\t')), '');
  });

  test('drops the note from the OLD layout and returns only the entries', () => {
    assert.equal(extractCatalog(oldLayoutSkillWith(catalogBody)), catalogBody);
  });

  test('returns "" for the OLD layout with zero lessons (note + "(none yet)")', () => {
    assert.equal(extractCatalog(oldLayoutSkillWith('(none yet)')), '');
  });

  test('drops the leading comment generically, not by matching the note text', () => {
    // The note's wording may change; the skip must not be pinned to it.
    const reworded = oldLayoutSkillWith(catalogBody).replace(
      GENERATED_NOTE,
      '<!-- some other generated-file warning -->',
    );
    assert.equal(extractCatalog(reworded), catalogBody);
  });

  test('keeps a comment that follows a real entry (only leading ones are skipped)', () => {
    const body = `${catalogBody}\n<!-- trailing note -->`;
    assert.equal(extractCatalog(skillWith(body)), body);
  });
});

/**
 * The contract that matters to a hook is the exit code and stdout of the
 * actual process, not just the pure function — a hook shells out to this
 * file, so these run it via spawnSync exactly as a hook would.
 */
describe('CLI', () => {
  const makeRoot = (skillContent) => {
    const root = mkdtempSync(path.join(tmpdir(), 'lessons-index-cli-'));
    if (skillContent !== undefined) {
      writeFileSync(path.join(root, 'SKILL.md'), skillContent, 'utf8');
    }
    return root;
  };

  // The script resolves its paths from its own location, so tests redirect it
  // with GEN_LESSONS_ROOT rather than by changing cwd (same convention as
  // gen-lessons.mjs's own CLI tests).
  const run = (root) =>
    spawnSync(process.execPath, [SCRIPT], {
      encoding: 'utf8',
      env: { ...process.env, GEN_LESSONS_ROOT: root },
    });

  /**
   * The full silent contract: exit 0, nothing on stdout, and nothing on stderr
   * either — a hook writing to stderr surfaces as an error in the transcript,
   * which is exactly the session noise this script promises never to cause.
   */
  const assertSilent = (result) => {
    assert.equal(result.status, 0);
    assert.equal(result.stdout, '');
    assert.equal(result.stderr, '');
  };

  test('prints the catalog and exits 0 when SKILL.md has entries', () => {
    const root = makeRoot(skillWith(catalogBody));
    const result = run(root);
    assert.equal(result.status, 0);
    assert.equal(result.stdout.trim(), catalogBody);
    assert.equal(result.stderr, '');
  });

  test('prints only the entries for an already-installed project (OLD layout)', () => {
    // An existing install keeps its old user-owned gen-lessons.mjs, so its
    // SKILL.md keeps the note between the markers forever.
    const root = makeRoot(oldLayoutSkillWith(catalogBody));
    const result = run(root);
    assert.equal(result.status, 0);
    assert.equal(result.stdout.trim(), catalogBody);
    assert.ok(!result.stdout.includes('do not edit by hand'));
    assert.equal(result.stderr, '');
  });

  test('exits 0 with no output for an already-installed project with zero lessons (OLD layout)', () => {
    const root = makeRoot(oldLayoutSkillWith('(none yet)'));
    assertSilent(run(root));
  });

  test('exits 0 with no output when SKILL.md does not exist', () => {
    const root = makeRoot(); // no SKILL.md written
    assertSilent(run(root));
  });

  test('exits 0 with no output when the markers are missing or reversed', () => {
    const root = makeRoot(`${CATALOG_END}\n${CATALOG_START}\n`);
    assertSilent(run(root));
  });

  test('exits 0 with no output when there are zero lessons ("(none yet)")', () => {
    const root = makeRoot(skillWith('(none yet)'));
    assertSilent(run(root));
  });

  test('exits 0 with no output when the markers hold nothing but blank lines', () => {
    const root = makeRoot(skillWith('   \n\n\t'));
    assertSilent(run(root));
  });

  test('the shipped scaffold (zero lessons) exits 0 with no output', () => {
    // Guards the contract this feature exists for: a fresh project that
    // hasn't recorded a single lesson yet must not get any hook output.
    const scaffoldRoot = path.join(REPO_ROOT, 'scaffold', 'team-lessons');
    assertSilent(run(scaffoldRoot));
  });

  test('exits 0 with no output when SKILL.md is unreadable (e.g. a directory in its place)', () => {
    // Forces the readFileSync call to throw for a reason other than a
    // missing file, exercising the catch-all in main().
    const root = makeRoot();
    mkdirSync(path.join(root, 'SKILL.md'));
    try {
      assertSilent(run(root));
    } finally {
      rmSync(path.join(root, 'SKILL.md'), { recursive: true });
    }
  });
});

/**
 * `import.meta.dirname` only exists on Node >= 20.11, but package.json declares
 * `"node": ">=18.0.0"`. Using it would throw at IMPORT time — before the hook's
 * own try/catch can swallow anything — turning a session start into an error.
 * Nothing else can catch that: the suite runs on the developer's own Node, which
 * is new enough for the bug to stay invisible. So assert on the source instead.
 */
describe('Node 18 compatibility', () => {
  for (const name of ['gen-lessons.mjs', 'lessons-index.mjs']) {
    test(`${name} does not use import.meta.dirname outside comments`, () => {
      const source = readFileSync(
        path.join(REPO_ROOT, 'scaffold', 'team-lessons', 'scripts', name),
        'utf8',
      );
      const code = source
        .replace(/\/\*[\s\S]*?\*\//g, '') // block comments (incl. the file header)
        .replace(/^\s*\/\/.*$/gm, ''); // whole-line // comments
      assert.ok(
        !code.includes('import.meta.dirname'),
        `${name} uses import.meta.dirname, which is undefined on Node 18`,
      );
    });
  }
});
