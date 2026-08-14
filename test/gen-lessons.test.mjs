/**
 * Tests for the team-lessons index generator shipped in scaffold/team-lessons/.
 *
 * Uses only node:test + node:assert — the package has no dependencies and the
 * generator must keep working in projects that have none either.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import {
  CATALOG_START,
  CATALOG_END,
  GENERATED_NOTE,
  EMPTY_CATALOG,
  parseFrontmatter,
  loadLessons,
  renderCatalog,
  buildSkill,
  resolvePaths,
} from '../scaffold/team-lessons/scripts/gen-lessons.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SCAFFOLD_TEAM_LESSONS = path.join(REPO_ROOT, 'scaffold', 'team-lessons');
const GENERATOR = path.join(SCAFFOLD_TEAM_LESSONS, 'scripts', 'gen-lessons.mjs');

describe('parseFrontmatter', () => {
  test('parses key: value pairs and array values', () => {
    const fm = parseFrontmatter('---\nid: 3\nslug: foo\nrefs: [PR #52, Issue #66]\n---\nbody\n');
    assert.deepEqual(fm, { id: '3', slug: 'foo', refs: ['PR #52', 'Issue #66'] });
  });

  test('only the first colon splits, so values may contain colons', () => {
    const fm = parseFrontmatter('---\nsummary: prefer X: not Y\n---\n');
    assert.equal(fm.summary, 'prefer X: not Y');
  });

  test('an empty array literal parses to an empty array', () => {
    assert.deepEqual(parseFrontmatter('---\nrefs: []\n---\n').refs, []);
  });

  test('accepts a closing --- at EOF (no trailing newline)', () => {
    assert.deepEqual(parseFrontmatter('---\nid: 1\nslug: a\n---'), { id: '1', slug: 'a' });
  });

  test('throws when there is no frontmatter', () => {
    assert.throws(() => parseFrontmatter('# heading only\n'));
  });
});

describe('loadLessons', () => {
  /** Build a lessons/ fixture in a temp dir and return its path. */
  const makeLessonsDir = (files) => {
    const dir = mkdtempSync(path.join(tmpdir(), 'gen-lessons-'));
    for (const [name, content] of Object.entries(files)) {
      writeFileSync(path.join(dir, name), content, 'utf8');
    }
    return dir;
  };

  test('sorts by id, not by filename', () => {
    const dir = makeLessonsDir({
      '02-b.md': '---\nid: 2\nslug: b\nsymptom: S B\nsummary: M B\n---\n',
      '01-a.md': '---\nid: 1\nslug: a\nsymptom: S A\nsummary: M A\n---\n',
      '10-c.md': '---\nid: 10\nslug: c\nsymptom: S C\nsummary: M C\n---\n',
    });
    assert.deepEqual(
      loadLessons(dir).map((l) => l.id),
      [1, 2, 10],
    );
  });

  test('ignores non-markdown files (e.g. .gitkeep)', () => {
    const dir = makeLessonsDir({
      '01-a.md': '---\nid: 1\nslug: a\nsymptom: S A\nsummary: M A\n---\n',
      '.gitkeep': '',
      'notes.txt': 'ignore me',
    });
    assert.equal(loadLessons(dir).length, 1);
  });

  test('returns an empty list for a lessons dir with no entries', () => {
    assert.deepEqual(loadLessons(makeLessonsDir({ '.gitkeep': '' })), []);
  });

  test('throws when id is not an integer', () => {
    const dir = makeLessonsDir({
      '01-a.md': '---\nid: abc\nslug: a\nsymptom: S A\nsummary: M A\n---\n',
    });
    assert.throws(() => loadLessons(dir), /id/);
  });

  test('throws when symptom is empty (would emit a blank index link)', () => {
    const dir = makeLessonsDir({
      '01-a.md': '---\nid: 1\nslug: a\nsymptom:\nsummary: M A\n---\n',
    });
    assert.throws(() => loadLessons(dir), /symptom/);
  });

  test('throws when two lessons share an id', () => {
    const dir = makeLessonsDir({
      '01-a.md': '---\nid: 1\nslug: a\nsymptom: S A\nsummary: M A\n---\n',
      '01-b.md': '---\nid: 1\nslug: b\nsymptom: S B\nsummary: M B\n---\n',
    });
    assert.throws(() => loadLessons(dir), /duplicate id/);
  });

  test('returns the "applies_when" value when the frontmatter has it', () => {
    const dir = makeLessonsDir({
      '01-a.md': '---\nid: 1\nslug: a\napplies_when: When W A\nsymptom: S A\nsummary: M A\n---\n',
    });
    assert.equal(loadLessons(dir)[0].appliesWhen, 'When W A');
  });

  test('does not throw when "applies_when" is missing (back-compat for pre-existing lessons)', () => {
    const dir = makeLessonsDir({
      '01-a.md': '---\nid: 1\nslug: a\nsymptom: S A\nsummary: M A\n---\n',
    });
    assert.doesNotThrow(() => loadLessons(dir));
    assert.equal(loadLessons(dir)[0].appliesWhen, '');
  });

  test('does not throw when "applies_when" is present but empty (key with no value)', () => {
    const dir = makeLessonsDir({
      '01-a.md': '---\nid: 1\nslug: a\napplies_when:\nsymptom: S A\nsummary: M A\n---\n',
    });
    assert.doesNotThrow(() => loadLessons(dir));
    assert.equal(loadLessons(dir)[0].appliesWhen, '');
  });
});

describe('renderCatalog', () => {
  test('renders an entry with applies_when as "<applies_when>" heading + symptom/summary sub-list', () => {
    const catalog = renderCatalog([
      { id: 1, file: '01-a.md', symptom: 'S A', summary: 'M A', appliesWhen: 'When W A' },
    ]);
    assert.equal(catalog, '1. **When W A**\n   - symptom: [S A](lessons/01-a.md)\n   - summary: M A');
  });

  test('renders an entry without applies_when in the legacy "[symptom]" heading + summary-only sub-list', () => {
    const catalog = renderCatalog([{ id: 1, file: '01-a.md', symptom: 'S A', summary: 'M A', appliesWhen: '' }]);
    assert.equal(catalog, '1. **[S A](lessons/01-a.md)**\n   - summary: M A');
  });

  test('renders a mixed list (with and without applies_when) correctly for each entry', () => {
    const catalog = renderCatalog([
      { id: 1, file: '01-a.md', symptom: 'S A', summary: 'M A', appliesWhen: 'When W A' },
      { id: 2, file: '02-b.md', symptom: 'S B', summary: 'M B', appliesWhen: '' },
    ]);
    assert.equal(
      catalog,
      [
        '1. **When W A**',
        '   - symptom: [S A](lessons/01-a.md)',
        '   - summary: M A',
        '2. **[S B](lessons/02-b.md)**',
        '   - summary: M B',
      ].join('\n'),
    );
  });

  // Sub-list indent must track the id's own "N. " marker width (id digits + 2),
  // not a flat constant: a flat indent under-indents by one column as soon as
  // an id reaches two digits, which breaks CommonMark's list nesting for that
  // entry (verified against GitHub's renderer — see PR discussion).
  for (const id of [1, 9, 10, 100]) {
    test(`sub-list lines are indented to match the "${id}. " marker width (id ${id})`, () => {
      const catalog = renderCatalog([
        { id, file: `${id}-a.md`, symptom: 'S A', summary: 'M A', appliesWhen: 'When W A' },
      ]);
      const expectedIndent = ' '.repeat(String(id).length + 2);
      const subLines = catalog.split('\n').slice(1);
      assert.ok(subLines.length > 0);
      for (const line of subLines) {
        assert.ok(
          line.startsWith(`${expectedIndent}- `),
          `expected ${expectedIndent.length}-space indent for id ${id}, got: ${JSON.stringify(line)}`,
        );
        // And not one column short/long, so an off-by-one regression is caught
        // even though it would still pass a bare startsWith() check above.
        assert.equal(
          line.length - line.trimStart().length,
          expectedIndent.length,
          `expected exactly ${expectedIndent.length} spaces for id ${id}, got: ${JSON.stringify(line)}`,
        );
      }
    });
  }

  test('renders a two-digit id (10) in the new format with a 4-space sub-list indent', () => {
    const catalog = renderCatalog([
      { id: 10, file: '10-j.md', symptom: 'S J', summary: 'M J', appliesWhen: 'When W J' },
    ]);
    assert.equal(
      catalog,
      '10. **When W J**\n    - symptom: [S J](lessons/10-j.md)\n    - summary: M J',
    );
  });

  test('renders a two-digit id (10) in the legacy format with a 4-space sub-list indent', () => {
    const catalog = renderCatalog([{ id: 10, file: '10-j.md', symptom: 'S J', summary: 'M J', appliesWhen: '' }]);
    assert.equal(catalog, '10. **[S J](lessons/10-j.md)**\n    - summary: M J');
  });

  test('renders the empty-state placeholder when there are no lessons', () => {
    assert.equal(renderCatalog([]), EMPTY_CATALOG);
  });
});

describe('buildSkill', () => {
  const wrap = (inner) =>
    `# Heading\n\nHand-written preamble.\n\n## Failure catalog\n\n${CATALOG_START}\n${inner}${CATALOG_END}\n`;
  const catalog = '1. **[S A](lessons/01-a.md)** → M A';

  // Mimics the OLD layout (before this change), where the note sat BETWEEN the
  // markers instead of above the start marker.
  const wrapOldFormat = (staleCatalog) =>
    `# Heading\n\nHand-written preamble.\n\n## Failure catalog\n\n${CATALOG_START}\n${GENERATED_NOTE}\n\n${staleCatalog}\n${CATALOG_END}\n`;

  test('replaces between the markers and places the note ABOVE the start marker', () => {
    const result = buildSkill(wrap('(stale index)\n'), catalog);
    assert.ok(result.includes('Hand-written preamble.'));
    assert.ok(result.includes(`${GENERATED_NOTE}\n${CATALOG_START}\n\n${catalog}\n${CATALOG_END}`));
    assert.ok(!result.includes('stale index'));
    // Only one note in the whole file, and it precedes the start marker.
    assert.equal(result.split(GENERATED_NOTE).length - 1, 1);
    assert.ok(result.indexOf(GENERATED_NOTE) < result.indexOf(CATALOG_START));
  });

  test('is idempotent across repeated calls (note is not stacked)', () => {
    const once = buildSkill(wrap('\n'), catalog);
    const twice = buildSkill(once, catalog);
    const thrice = buildSkill(twice, catalog);
    assert.equal(twice, once);
    assert.equal(thrice, once);
    assert.equal(once.split(GENERATED_NOTE).length - 1, 1);
  });

  test('migrates a SKILL.md from the older layout (note between the markers) in one pass', () => {
    const migrated = buildSkill(wrapOldFormat('(old catalog)'), catalog);
    assert.ok(migrated.includes(`${GENERATED_NOTE}\n${CATALOG_START}\n\n${catalog}\n${CATALOG_END}`));
    assert.ok(!migrated.includes('old catalog'));
    assert.equal(migrated.split(GENERATED_NOTE).length - 1, 1);

    // And the migrated result is itself idempotent on the next run.
    assert.equal(buildSkill(migrated, catalog), migrated);
  });

  test('recovers a file left with a stacked/duplicated note back to a single note', () => {
    // Simulates a file that was corrupted by re-running a buggy version of the
    // note-placement logic: the note appears twice, directly above the marker.
    const broken = wrap('\n').replace(CATALOG_START, `${GENERATED_NOTE}\n${GENERATED_NOTE}\n${CATALOG_START}`);
    const recovered = buildSkill(broken, catalog);
    assert.equal(recovered.split(GENERATED_NOTE).length - 1, 1);
  });

  test('normalizes CRLF input to LF', () => {
    const crlf = wrap('(stale index)\n').replace(/\n/g, '\r\n');
    assert.ok(!buildSkill(crlf, catalog).includes('\r'));
  });

  test('throws when the markers are missing', () => {
    assert.throws(() => buildSkill('# no markers here\n', catalog), /markers/);
  });

  test('ignores an end-marker string quoted in the prose ABOVE the start marker', () => {
    // SKILL.md documents its own generated region, so the end marker's text can
    // legitimately appear before the start marker. Searching for it from the top
    // of the file would find THAT occurrence and either throw on a healthy file
    // or replace the prose between the two occurrences.
    const prose = `# Heading\n\nThe generated region ends at ${CATALOG_END}.\n\n`;
    const source = `${prose}${CATALOG_START}\n(stale index)\n${CATALOG_END}\n`;

    let result;
    assert.doesNotThrow(() => {
      result = buildSkill(source, catalog);
    });
    // The prose above the start marker survives verbatim, quoted marker included.
    assert.ok(result.startsWith(prose), `prose was rewritten: ${JSON.stringify(result)}`);
    assert.equal(
      result.split(CATALOG_END).length - 1,
      2,
      'expected exactly two end markers: the one quoted in the prose + the real one',
    );
    // Only the real catalog region was replaced.
    assert.ok(
      result.includes(`${GENERATED_NOTE}\n${CATALOG_START}\n\n${catalog}\n${CATALOG_END}`),
      `the catalog region was not rebuilt: ${JSON.stringify(result)}`,
    );
    assert.ok(!result.includes('stale index'), 'the previous catalog body survived');
  });

  test('throws when the markers are present but reversed', () => {
    // Writing into a file whose end marker precedes its start marker would
    // silently swallow everything between them, so this must not be tolerated.
    assert.throws(() => buildSkill(`${CATALOG_END}\n${CATALOG_START}\n`, catalog), /markers/);
  });
});

describe('resolvePaths', () => {
  test('resolves lessons/ and SKILL.md from the team-lessons root', () => {
    const { lessonsDir, skillPath } = resolvePaths('/skill/team-lessons');
    assert.equal(lessonsDir.replace(/\\/g, '/'), '/skill/team-lessons/lessons');
    assert.equal(skillPath.replace(/\\/g, '/'), '/skill/team-lessons/SKILL.md');
  });
});

/**
 * The guardrail is not "the comparison is correct" but "a stale index makes CI
 * fail". That is the exit code, so it has to be tested through a real process:
 * deleting `process.exitCode = 1` from main() must turn a test red.
 */
describe('CLI', () => {
  /** A temp team-lessons root: one lesson (no applies_when) + a SKILL.md with bare markers. */
  const makeRoot = () => {
    const root = mkdtempSync(path.join(tmpdir(), 'gen-lessons-cli-'));
    const lessonsDir = path.join(root, 'lessons');
    mkdirSync(lessonsDir, { recursive: true });
    writeFileSync(
      path.join(lessonsDir, '01-a.md'),
      '---\nid: 1\nslug: a\nsymptom: S A\nsummary: M A\n---\nbody\n',
      'utf8',
    );
    const skillPath = path.join(root, 'SKILL.md');
    writeFileSync(skillPath, `# T\n\n${CATALOG_START}\n${CATALOG_END}\n`, 'utf8');
    return { root, skillPath };
  };

  /** Same shape as makeRoot(), but the lesson carries an `applies_when`. */
  const makeRootWithAppliesWhen = () => {
    const root = mkdtempSync(path.join(tmpdir(), 'gen-lessons-cli-'));
    const lessonsDir = path.join(root, 'lessons');
    mkdirSync(lessonsDir, { recursive: true });
    writeFileSync(
      path.join(lessonsDir, '01-a.md'),
      '---\nid: 1\nslug: a\napplies_when: When W A\nsymptom: S A\nsummary: M A\n---\nbody\n',
      'utf8',
    );
    const skillPath = path.join(root, 'SKILL.md');
    writeFileSync(skillPath, `# T\n\n${CATALOG_START}\n${CATALOG_END}\n`, 'utf8');
    return { root, skillPath };
  };

  // The script resolves its paths from its own location, so tests redirect it
  // with GEN_LESSONS_ROOT rather than by changing cwd.
  const run = (root, args = []) =>
    spawnSync(process.execPath, [GENERATOR, ...args], {
      encoding: 'utf8',
      env: { ...process.env, GEN_LESSONS_ROOT: root },
    });

  test('--check exits 1 when the committed index is stale', () => {
    assert.equal(run(makeRoot().root, ['--check']).status, 1);
  });

  test('writing generates the index, after which --check exits 0', () => {
    const { root, skillPath } = makeRoot();

    assert.equal(run(root).status, 0);
    assert.ok(readFileSync(skillPath, 'utf8').includes('**[S A](lessons/01-a.md)**\n   - summary: M A'));

    assert.equal(run(root, ['--check']).status, 0);
  });

  test('a lesson missing "applies_when" still lets --check exit 0, but warns on stderr', () => {
    const { root } = makeRoot();

    // Bring SKILL.md up to date first so --check has nothing to complain about
    // except (via stderr) the missing field.
    assert.equal(run(root).status, 0);

    const result = run(root, ['--check']);
    assert.equal(result.status, 0);
    assert.match(result.stderr, /applies_when/);
    assert.match(result.stderr, /01-a\.md/);
  });

  test('a lesson with "applies_when" renders the new heading, and --check stays exit 0', () => {
    const { root, skillPath } = makeRootWithAppliesWhen();

    assert.equal(run(root).status, 0);
    assert.ok(
      readFileSync(skillPath, 'utf8').includes(
        '1. **When W A**\n   - symptom: [S A](lessons/01-a.md)\n   - summary: M A',
      ),
    );

    const result = run(root, ['--check']);
    assert.equal(result.status, 0);
    assert.equal(result.stderr, '');
  });

  test('the shipped scaffold is already --check clean out of the box', () => {
    // Guards the empty-state contract: the SKILL.md we scaffold must match what
    // the generator produces for an empty lessons/, or a project's very first
    // CI run fails on a file nobody has touched yet.
    const result = run(SCAFFOLD_TEAM_LESSONS, ['--check']);
    assert.equal(result.status, 0, result.stderr);
  });
});
