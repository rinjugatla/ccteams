/**
 * migrate.js — implements `ccteams migrate` (and `ccteams migrate --dry-run`).
 *
 * Purpose: a project that applied ccteams a while ago and then ran
 * `npm install -g ccteams@latest` does not automatically pick up files that
 * newer ccteams versions ship into `.claude/` (npm updates the globally
 * installed package, not files ccteams already wrote into the project).
 * `ccteams migrate` closes that gap for the pieces ccteams is allowed to
 * touch without risking hand-written content — see each step's contract.
 *
 * Migration steps: this module is deliberately structured as a list of
 * independent "migration step" objects rather than one big function, so that
 * future steps (e.g. detecting an old-layout SKILL.md, or a stale hook wired
 * into settings.json) can be added by appending to MIGRATION_STEPS without
 * touching migrate() itself. See the `id`/`title`/`run` shape below.
 *
 * No interactivity: this module never imports `node:readline` or reads
 * `process.stdin`. `--dry-run` communicates its finding via exitCode instead
 * of a prompt, so behavior is identical whether stdin is a TTY or a CI
 * pipe — see the exitCode rule in migrate() below.
 */

import fs from 'fs';
import path from 'path';
import { readManifest } from './manifest.js';
import { scaffoldTeamLessons, TEAM_LESSONS_SKILL_NAME } from './use.js';

/**
 * A migration step. ctx = { projectRoot, dotClaudeDir, manifest, dryRun }.
 * run(ctx) must return:
 *   {
 *     id: string,
 *     title: string,
 *     added: string[],    // paths (relative, for display) added — or that
 *                          // WOULD be added under dryRun — this run
 *     kept: string[],     // paths left untouched (already present)
 *     notices: string[],  // human-readable messages for detect-only findings
 *                          // (no file writes implied); empty for steps that
 *                          // only add files, like this sub's team-lessons step
 *   }
 */

/**
 * Migration step: scaffold the user-owned team-lessons skill's missing files
 * (never overwrites an existing file — see scaffoldTeamLessons's contract in
 * use.js). This is the only step implemented so far; later steps (old-layout
 * SKILL.md detection, settings.json hook detection, ccteams-owned file
 * refresh) are expected to append their own step objects to MIGRATION_STEPS.
 */
export const teamLessonsScaffoldStep = {
  id: 'team-lessons-scaffold',
  title: 'team-lessons skill',
  run(ctx) {
    const destDir = path.join(ctx.dotClaudeDir, 'skills', TEAM_LESSONS_SKILL_NAME);
    const toDisplayPath = (relPath) => relPath.split(path.sep).join('/');
    const displayDestDir = path.relative(ctx.projectRoot, destDir).split(path.sep).join('/');

    // Guard against a non-directory squatting on the destination (e.g. a plain
    // file at .claude/skills/team-lessons): fs.existsSync() on a path INSIDE
    // it reports "missing" either way, so without this check --dry-run would
    // report every file as addable (it is not — writing would fail) while a
    // real run would throw an unhandled EEXIST from fs.mkdirSync() deep inside
    // scaffoldTeamLessons(). Checking here, before either mode proceeds, is
    // what keeps dry-run and a real run in agreement.
    if (fs.existsSync(destDir) && !fs.statSync(destDir).isDirectory()) {
      throw new Error(`"${displayDestDir}" exists and is not a directory. Remove or rename it, then retry.`);
    }

    let result;
    try {
      result = scaffoldTeamLessons(destDir, undefined, { dryRun: ctx.dryRun });
    } catch (err) {
      // Convert any other unexpected fs failure (e.g. EACCES on a read-only
      // .claude/) into a short, path-specific message instead of letting the
      // raw error (and its stack) reach the user — see migrate()'s catch.
      throw new Error(`Could not update "${displayDestDir}": ${err.code ?? err.message}.`);
    }

    // Display paths relative to the team-lessons skill dir (matches the
    // Issue #15 example output: "scripts/lessons-index.mjs", "SKILL.md", ...).
    return {
      id: this.id,
      title: this.title,
      added: result.created.map(toDisplayPath),
      kept: result.preserved.map(toDisplayPath),
      notices: [],
    };
  },
};

/**
 * All migration steps, applied in order. Later subs (B/C/D) append here.
 */
export const MIGRATION_STEPS = [teamLessonsScaffoldStep];

/**
 * Run every migration step against the current project.
 *
 * projectRoot defaults to process.cwd(). opts.dryRun (default false) — when
 * true, no step writes anything to disk; `added` reports what WOULD be added.
 *
 * Returns:
 * {
 *   success: true,
 *   dryRun: boolean,
 *   applied: boolean,   // false only when ccteams is not applied in this project
 *   steps: StepResult[],
 *   pending: number,    // total `added` count across all steps
 *   message: string,    // formatted report, ready to print
 *   exitCode: number,
 * }
 *
 * exitCode rule: `dryRun && pending > 0` → 1 (mirrors the repo's existing
 * `gen-lessons.mjs --check` convention of a non-zero exit on detected drift,
 * and the umbrella issue's "no prompt in CI; use exit codes" requirement). A
 * real (non-dry-run) run is always exitCode 0 on success — it does not fail
 * just because it wrote files.
 *
 * On failure (a step throws — see teamLessonsScaffoldStep for the cases this
 * covers), returns `{ success: false, message, exitCode: 1, ... }` matching
 * the `{ success, message }` shape useTeam()/unuseTeam() already use, instead
 * of letting the raw error (and its stack) propagate to the caller. This
 * applies identically whether dryRun is true or false — a step is expected to
 * detect its own failure conditions before writing anything, so the two modes
 * never disagree about whether an operation would succeed.
 */
export function migrate(projectRoot = process.cwd(), opts = {}) {
  const { dryRun = false } = opts;
  const dotClaudeDir = path.join(projectRoot, '.claude');
  const manifest = readManifest(projectRoot);

  if (!manifest) {
    return {
      success: true,
      dryRun,
      applied: false,
      steps: [],
      pending: 0,
      message: formatMigrateReport({ dryRun, applied: false, steps: [] }),
      exitCode: 0,
    };
  }

  const ctx = { projectRoot, dotClaudeDir, manifest, dryRun };
  let steps;
  try {
    steps = MIGRATION_STEPS.map((step) => step.run(ctx));
  } catch (err) {
    return {
      success: false,
      dryRun,
      applied: true,
      steps: [],
      pending: 0,
      message: `ccteams migrate: ${err.message ?? String(err)}`,
      exitCode: 1,
    };
  }

  const pending = steps.reduce((sum, step) => sum + step.added.length, 0);
  const exitCode = dryRun && pending > 0 ? 1 : 0;

  return {
    success: true,
    dryRun,
    applied: true,
    steps,
    pending,
    message: formatMigrateReport({ dryRun, applied: true, steps }),
    exitCode,
  };
}

/**
 * Pad `label` to align the "(added)" / "(would be added)" / "(kept as-is)"
 * annotations across a block of lines, matching the Issue #15 example output.
 */
function padLabel(label, width) {
  return label.length >= width ? label : label + ' '.repeat(width - label.length);
}

/**
 * Format the result of migrate() into human-readable text. Kept as a pure
 * function (input: the same shape migrate() computes) so it can be unit
 * tested without touching the filesystem.
 */
export function formatMigrateReport({ dryRun, applied, steps }) {
  if (!applied) {
    return [
      'ccteams is not applied in this project.',
      '',
      'Run "ccteams use <team>" first, then "ccteams migrate" to pick up new files later.',
    ].join('\n');
  }

  const lines = [];
  lines.push(dryRun ? 'ccteams migrate (dry run — nothing was written)' : 'ccteams migrate');
  lines.push('');

  let pending = 0;
  for (const step of steps) {
    lines.push(`  ${step.title}`);
    const rows = [
      ...step.added.map((p) => ({ marker: '+', path: p, added: true })),
      ...step.kept.map((p) => ({ marker: '=', path: p, added: false })),
    ];
    const width = rows.length > 0 ? Math.max(...rows.map((r) => r.path.length)) : 0;
    for (const row of rows) {
      const suffix = row.added ? (dryRun ? '(would be added)' : '(added)') : '(kept as-is)';
      lines.push(`    ${row.marker} ${padLabel(row.path, width)}   ${suffix}`);
    }
    for (const notice of step.notices) {
      lines.push(`    ${notice}`);
    }
    pending += step.added.length;
    lines.push('');
  }

  if (pending === 0) {
    lines.push('Everything is up to date.');
  } else if (dryRun) {
    lines.push('Run "ccteams migrate" to apply.');
  } else {
    lines.push(`Added ${pending} file${pending !== 1 ? 's' : ''}.`);
  }

  return lines.join('\n');
}
