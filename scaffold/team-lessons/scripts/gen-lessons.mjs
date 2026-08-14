/**
 * gen-lessons.mjs — generate the failure-catalog index in `SKILL.md` from the
 * frontmatter of every `lessons/NN-slug.md` file next to it.
 *
 * WHY THIS EXISTS
 * A single-file team-lessons skill grows without bound: every accepted lesson
 * appends several paragraphs, and the whole file is loaded into context on every
 * task that consults it. Splitting it — one lesson per file under `lessons/`,
 * with `SKILL.md` holding only a short "when to read → symptom → correct move"
 * index entry per lesson — caps the always-loaded cost at a few lines per
 * lesson while keeping the detail one click away. A hand-written index drifts
 * the moment a lesson is added or reworded, so the index is generated from
 * each lesson's own frontmatter (`applies_when` / `symptom` / `summary`)
 * instead of being maintained by hand.
 *
 * `applies_when` leads each entry so an agent scanning the index can rule a
 * lesson out from its first line: a `symptom`-only heading describes the
 * failure as it was first noticed, which is often narrower than every
 * situation the lesson actually applies to, and a reader who doesn't
 * recognize that exact symptom skips a lesson that would have applied. Lessons
 * written before this field existed have no `applies_when`; the index falls
 * back to the older symptom-only heading for those rather than treating the
 * missing field as a hard error (see `loadLessons`).
 *
 * The generated index is COMMITTED (agents read the repo, not a build output),
 * and `--check` re-derives it to prove the committed copy still matches
 * `lessons/`. Wire that into CI so a hand-edited or stale index fails the build.
 *
 * USAGE
 *   node .claude/skills/team-lessons/scripts/gen-lessons.mjs           write the index into SKILL.md
 *   node .claude/skills/team-lessons/scripts/gen-lessons.mjs --check   verify SKILL.md matches lessons/ (exit 1 on drift)
 *
 * Add a shortcut in your project's task runner if you have one, e.g.
 * `"gen:lessons": "node .claude/skills/team-lessons/scripts/gen-lessons.mjs"`.
 *
 * DESIGN NOTES
 * - Paths are resolved from THIS FILE's location, not from cwd, so the skill
 *   folder is self-contained and the script runs correctly from anywhere.
 * - Plain Node ESM with zero dependencies: the skill must work in projects that
 *   have no build step and no package manager at all. The frontmatter parser is
 *   a deliberately small hand-rolled one — the schema is six known keys, which
 *   does not justify pulling in a YAML library.
 */

import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

// `import.meta.dirname` needs Node >= 20.11; this package's `engines` allows
// Node 18, so resolve the same way the rest of the repo does (lib/teams.js,
// lib/use.js, bin/ccteams.js): derive it from `import.meta.url` instead.
const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** Index section delimiters. Only the text between these two lines is replaced. */
export const CATALOG_START = '<!-- team-lessons:catalog:start -->';
export const CATALOG_END = '<!-- team-lessons:catalog:end -->';

/** Warning placed right after the start marker so hand-editors are told to stop. */
export const GENERATED_NOTE =
  '<!-- Generated from lessons/*.md frontmatter by scripts/gen-lessons.mjs — do not edit by hand. -->';

/** Rendered in place of the list when `lessons/` holds no entries yet. */
export const EMPTY_CATALOG = '(none yet)';

// The team-lessons root is the parent of this `scripts/` directory. Resolving it
// from __dirname (not cwd) keeps the skill folder self-contained.
// Tests point GEN_LESSONS_ROOT at a fixture directory instead.
const DEFAULT_TEAM_LESSONS_ROOT = path.resolve(__dirname, '..');

/** Resolve `lessons/` and `SKILL.md` from the team-lessons root. */
export function resolvePaths(teamLessonsRoot = process.env.GEN_LESSONS_ROOT || DEFAULT_TEAM_LESSONS_ROOT) {
  return {
    lessonsDir: path.join(teamLessonsRoot, 'lessons'),
    skillPath: path.join(teamLessonsRoot, 'SKILL.md'),
  };
}

/**
 * Parse the leading `---`-delimited frontmatter block of a lesson file.
 *
 * Supported forms (the whole schema — nothing else is interpreted):
 *   key: value      string (only the FIRST `:` splits, so values may contain `:`)
 *   key: [a, b, c]  string array (empty items dropped)
 *
 * @param {string} content full text of a lesson file
 * @returns {Record<string, string | string[]>}
 */
export function parseFrontmatter(content) {
  // Allow the closing `---` to be followed by a newline or EOF, so a file that
  // is nothing but frontmatter (no trailing newline) still parses.
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(content);
  if (!match) {
    throw new Error('no frontmatter found (a leading block delimited by ---)');
  }

  /** @type {Record<string, string | string[]>} */
  const frontmatter = {};
  for (const rawLine of match[1].split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;

    const separatorIndex = line.indexOf(':');
    if (separatorIndex === -1) continue;

    const key = line.slice(0, separatorIndex).trim();
    const rawValue = line.slice(separatorIndex + 1).trim();

    if (rawValue.startsWith('[') && rawValue.endsWith(']')) {
      frontmatter[key] = rawValue
        .slice(1, -1)
        .split(',')
        .map((item) => item.trim())
        .filter(Boolean);
    } else {
      frontmatter[key] = rawValue;
    }
  }
  return frontmatter;
}

/**
 * Read every `*.md` under `lessons/` and return the index metadata, sorted by id.
 * Missing or duplicated `id`, and empty `symptom` / `summary`, are hard errors:
 * they would otherwise surface as a blank link or a silently reordered index.
 *
 * `applies_when` is treated more leniently: it is the field the index leads
 * with, but a repo may already have lessons written before this field existed.
 * Failing the whole catalog build over a missing `applies_when` would break
 * `--check` for every project that adopts this generator version, so a missing
 * or empty `applies_when` only prints a warning to stderr (naming the file) and
 * falls back to an empty string; `renderCatalog` uses that to pick the legacy
 * symptom-only heading for that entry instead of throwing.
 *
 * @param {string} lessonsDir absolute path to the lessons directory
 * @returns {{ file: string, id: number, symptom: string, summary: string, appliesWhen: string }[]}
 */
export function loadLessons(lessonsDir) {
  const fileNames = readdirSync(lessonsDir)
    .filter((name) => name.endsWith('.md'))
    .sort();

  const lessons = fileNames.map((file) => {
    const frontmatter = parseFrontmatter(readFileSync(path.join(lessonsDir, file), 'utf8'));

    const id = Number(frontmatter.id);
    if (!Number.isInteger(id)) {
      throw new Error(`${file}: frontmatter "id" is not an integer (got: ${frontmatter.id})`);
    }
    for (const key of ['symptom', 'summary']) {
      if (typeof frontmatter[key] !== 'string' || frontmatter[key].length === 0) {
        throw new Error(`${file}: frontmatter "${key}" is empty (required to build the index)`);
      }
    }

    const appliesWhen = typeof frontmatter.applies_when === 'string' ? frontmatter.applies_when : '';
    if (!appliesWhen) {
      console.error(
        `${file}: frontmatter "applies_when" is missing or empty — falling back to the legacy symptom-only index heading for this lesson. Add "applies_when: <when to read this>" when you next touch it.`,
      );
    }

    return {
      file,
      id,
      symptom: /** @type {string} */ (frontmatter.symptom),
      summary: /** @type {string} */ (frontmatter.summary),
      appliesWhen,
    };
  });

  lessons.sort((a, b) => a.id - b.id);

  const duplicated = lessons.find(
    (lesson, index) => index > 0 && lesson.id === lessons[index - 1].id,
  );
  if (duplicated) {
    throw new Error(`duplicate id ${duplicated.id} across lesson files`);
  }

  return lessons;
}

/**
 * Render the index body: one numbered entry per lesson, headed by WHEN to read
 * it so a scan of the index can rule a lesson out from its first line, with
 * `symptom` (linked to the detail file) and `summary` as a two-line sub-list:
 *
 *   1. **<applies_when>**
 *      - symptom: [<symptom>](lessons/NN-slug.md)
 *      - summary: <summary>
 *
 * Lessons written before `applies_when` existed (see `loadLessons`) render in
 * the older, backward-compatible heading instead, with only `summary` below it:
 *
 *   1. **[<symptom>](lessons/NN-slug.md)**
 *      - summary: <summary>
 *
 * The sub-list lines are indented to `String(id).length + 2` spaces — the
 * width of that item's own `N. ` ordered-list marker (`1. ` / `9. ` = 3,
 * `10. ` = 4, `100. ` = 5, …) — NOT a flat 3 spaces. CommonMark (and GitHub's
 * renderer) only treats a continuation line as part of the list item — nested
 * under it, rather than a separate top-level paragraph that also splits the
 * ordered list into two — when it is indented to at least the marker's own
 * width. A flat 3-space indent nests correctly for single-digit ids (where the
 * marker width IS 3) but under-indents by one column as soon as an id reaches
 * two digits, silently breaking the nesting (and the list) for that entry.
 *
 * @param {{ file: string, id: number, symptom: string, summary: string, appliesWhen: string }[]} lessons
 * @returns {string}
 */
export function renderCatalog(lessons) {
  if (lessons.length === 0) return EMPTY_CATALOG;
  return lessons
    .map((lesson) => {
      const indent = ' '.repeat(String(lesson.id).length + 2);
      const symptomLink = `[${lesson.symptom}](lessons/${lesson.file})`;
      if (lesson.appliesWhen) {
        return [
          `${lesson.id}. **${lesson.appliesWhen}**`,
          `${indent}- symptom: ${symptomLink}`,
          `${indent}- summary: ${lesson.summary}`,
        ].join('\n');
      }
      return [`${lesson.id}. **${symptomLink}**`, `${indent}- summary: ${lesson.summary}`].join('\n');
    })
    .join('\n');
}

/** Escape a literal string for embedding in a `RegExp` (e.g. the `—` and `.` in GENERATED_NOTE). */
function escapeRegExp(literal) {
  return literal.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Replace the text between the markers in SKILL.md with the rendered index,
 * leaving everything outside the markers (hand-written prose) untouched.
 *
 * The generated note is placed just ABOVE the start marker rather than
 * between the markers, so a marker-only diff (rebasing on a fresh catalog)
 * never touches the note line. Because that puts the note outside the region
 * this function replaces, a note left over from a previous run has to be
 * stripped from the end of `before` first — otherwise re-running (or
 * migrating a `SKILL.md` from the older layout, where the note sat between
 * the markers and simply falls off with the rest of that region) would stack
 * a fresh note on top of it every time. The pattern absorbs any number of
 * repeats so a file left in a broken, already-stacked state still recovers
 * to a single note on the next run.
 *
 * @param {string} skillContent current full text of SKILL.md
 * @param {string} catalogBody output of renderCatalog
 * @returns {string}
 */
export function buildSkill(skillContent, catalogBody) {
  const normalized = skillContent.replace(/\r\n/g, '\n');

  const startIndex = normalized.indexOf(CATALOG_START);
  const endIndex = normalized.indexOf(CATALOG_END);
  if (startIndex === -1 || endIndex === -1 || endIndex < startIndex) {
    throw new Error(
      `SKILL.md is missing the index markers (${CATALOG_START} / ${CATALOG_END}) in that order`,
    );
  }

  const staleNotePattern = new RegExp(`(?:${escapeRegExp(GENERATED_NOTE)}\\n+)+$`);
  const before = normalized.slice(0, startIndex).replace(staleNotePattern, '');
  const after = normalized.slice(endIndex);
  return `${before}${GENERATED_NOTE}\n${CATALOG_START}\n\n${catalogBody}\n${after}`;
}

function main() {
  const shouldCheckOnly = process.argv.slice(2).includes('--check');

  const { lessonsDir, skillPath } = resolvePaths();
  const lessons = loadLessons(lessonsDir);
  const catalog = renderCatalog(lessons);
  const current = readFileSync(skillPath, 'utf8');
  const next = buildSkill(current, catalog);

  if (shouldCheckOnly) {
    if (current.replace(/\r\n/g, '\n') !== next) {
      console.error(
        'SKILL.md index does not match lessons/. Re-run this script without --check and commit the result.',
      );
      process.exitCode = 1;
      return;
    }
    console.log(`OK: SKILL.md index matches lessons/ (${lessons.length} entr${lessons.length === 1 ? 'y' : 'ies'}).`);
    return;
  }

  writeFileSync(skillPath, next, 'utf8');
  console.log(`Wrote SKILL.md index from lessons/ (${lessons.length} entr${lessons.length === 1 ? 'y' : 'ies'}).`);
}

// Only run main() when executed as a CLI — importing this file (tests) must not.
if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === path.resolve(__dirname, 'gen-lessons.mjs')
) {
  main();
}
