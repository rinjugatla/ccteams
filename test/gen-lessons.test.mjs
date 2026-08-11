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
});

describe('renderCatalog', () => {
  test('renders a numbered "symptom (link) → correct move" list', () => {
    const catalog = renderCatalog([
      { id: 1, file: '01-a.md', symptom: 'S A', summary: 'M A' },
      { id: 2, file: '02-b.md', symptom: 'S B', summary: 'M B' },
    ]);
    assert.equal(catalog, '1. **[S A](lessons/01-a.md)** → M A\n2. **[S B](lessons/02-b.md)** → M B');
  });

  test('renders the empty-state placeholder when there are no lessons', () => {
    assert.equal(renderCatalog([]), EMPTY_CATALOG);
  });
});

describe('buildSkill', () => {
  const wrap = (inner) =>
    `# Heading\n\nHand-written preamble.\n\n## Failure catalog\n\n${CATALOG_START}\n${inner}${CATALOG_END}\n`;
  const catalog = '1. **[S A](lessons/01-a.md)** → M A';

  test('replaces between the markers and preserves hand-written text outside', () => {
    const result = buildSkill(wrap('(stale index)\n'), catalog);
    assert.ok(result.includes('Hand-written preamble.'));
    assert.ok(result.includes(`${CATALOG_START}\n${GENERATED_NOTE}\n\n${catalog}\n${CATALOG_END}`));
    assert.ok(!result.includes('stale index'));
  });

  test('is idempotent', () => {
    const once = buildSkill(wrap('\n'), catalog);
    assert.equal(buildSkill(once, catalog), once);
  });

  test('normalizes CRLF input to LF', () => {
    const crlf = wrap('(stale index)\n').replace(/\n/g, '\r\n');
    assert.ok(!buildSkill(crlf, catalog).includes('\r'));
  });

  test('throws when the markers are missing', () => {
    assert.throws(() => buildSkill('# no markers here\n', catalog), /markers/);
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
  /** A temp team-lessons root: one lesson + a SKILL.md with bare markers. */
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
    assert.ok(readFileSync(skillPath, 'utf8').includes('**[S A](lessons/01-a.md)** → M A'));

    assert.equal(run(root, ['--check']).status, 0);
  });

  test('the shipped scaffold is already --check clean out of the box', () => {
    // Guards the empty-state contract: the SKILL.md we scaffold must match what
    // the generator produces for an empty lessons/, or a project's very first
    // CI run fails on a file nobody has touched yet.
    const result = run(SCAFFOLD_TEAM_LESSONS, ['--check']);
    assert.equal(result.status, 0, result.stderr);
  });
});
