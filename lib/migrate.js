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
 * independent "migration step" objects rather than one big function
 * (currently: an old-layout `SKILL.md` / missing scaffold-file check, and a
 * missing catalog-injection-hook check in settings.json — see
 * teamLessonsScaffoldStep and teamLessonsHookStep below), so that further
 * steps (e.g. detecting stale ccteams-owned agent/skill files — umbrella
 * issue #14's sub-D) can be added by appending to MIGRATION_STEPS without
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
import {
  scaffoldTeamLessons,
  TEAM_LESSONS_SKILL_NAME,
  TEAM_LESSONS_SCAFFOLD_DIR,
} from './use.js';
// Quoted verbatim in the "no markers" notice so the text a user copies is
// always the pair the shipped generator actually looks for (same single-source
// reasoning as the import in use.js).
import { CATALOG_START, CATALOG_END } from '../scaffold/team-lessons/scripts/gen-lessons.mjs';

/**
 * Turn scaffoldTeamLessons()'s two detect-only findings into report lines.
 *
 * Both findings are about a user-owned SKILL.md that ccteams must not rewrite
 * (README.md's never-overwrite contract), so every notice ends in an action the
 * USER runs. The two cases get different text because they have different
 * causes and different fixes — see classifySkillLayout() in use.js:
 *   - needsMigration: the marker pair is unusable (absent, or END before
 *     START), so the generator throws; the markers must be fixed by hand first.
 *   - hasLegacyIndexLayout: the markers are present AND correctly ordered — the
 *     only stale thing is the generated note's position — so one re-run of the
 *     generator is the entire fix.
 * They are mutually exclusive, so at most one block is emitted. Each heading
 * must name the condition its OWN branch tests: "wrong marker order" belongs to
 * the first branch (which is where a reversed pair actually lands), never to
 * the second, whose precondition is that the order is right.
 *
 * The text is identical in dry-run and in a real run, deliberately: the two
 * modes must report the same findings (see the step's contract), so a notice
 * may not be reworded for one of them. That is why the generator command is
 * printed even in a dry-run where the generator itself is still listed as
 * "would be added" — the ordering between the two is carried by the report's
 * own trailing line ("Run \"ccteams migrate\" to apply."), not by this text.
 *
 * @param {{ needsMigration: boolean, hasLegacyIndexLayout: boolean }} scaffoldResult
 * @param {string} displayDestDir team-lessons dir, relative to the project root,
 *   with forward slashes — used to spell the generator path the user can paste.
 * @returns {string[]} one element per rendered line (see MIGRATION_STEPS notes)
 */
function buildTeamLessonsNotices(scaffoldResult, displayDestDir) {
  const generatorCommand = `node ${displayDestDir}/scripts/gen-lessons.mjs`;

  if (scaffoldResult.needsMigration) {
    return [
      '! SKILL.md — the catalog index markers are missing or out of order.',
      '  The generator refuses to run until SKILL.md contains both markers, in this order:',
      `    ${CATALOG_START}`,
      `    ${CATALOG_END}`,
      // "Put them" rather than "Add them"/"Fix them": this branch covers BOTH a
      // file with no markers at all (nothing to "fix" yet) and one whose pair is
      // reversed (nothing to "add"), so the verb has to fit either state.
      '  Put them where the catalog belongs, move each lesson into lessons/NN-slug.md, then run:',
      `    ${generatorCommand}`,
      '  (or your project\'s own alias, e.g. "pnpm run gen:lessons")',
      `  Full steps: ${displayDestDir}/AUTHORING.md — "Migrating a pre-existing SKILL.md".`,
    ];
  }

  if (scaffoldResult.hasLegacyIndexLayout) {
    return [
      '! SKILL.md — the generated note is still inside the catalog index markers (pre-0.4 layout).',
      '  The markers themselves are fine; regenerate so the index sits alone between them:',
      `    ${generatorCommand}`,
      '  (or your project\'s own alias, e.g. "pnpm run gen:lessons")',
    ];
  }

  return [];
}

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
 *                          // (no file writes implied); ONE LINE PER ELEMENT —
 *                          // formatMigrateReport() indents each element by four
 *                          // spaces and prints it verbatim, so a multi-line
 *                          // message must be pushed as several elements that
 *                          // carry their own relative indentation.
 *   }
 *
 * Notices are advice, never work ccteams performed or will perform: they are
 * excluded from `pending` and therefore from `exitCode` (see migrate()). Only a
 * file ccteams can actually add counts as pending, so `migrate --dry-run` keeps
 * meaning "there are files to install" in CI rather than "a human should read
 * something" — changing that is out of scope here.
 */

/**
 * Migration step: scaffold the user-owned team-lessons skill's missing files
 * (never overwrites an existing file — see scaffoldTeamLessons's contract in
 * use.js), and REPORT, without touching it, a pre-existing SKILL.md whose
 * catalog index is in an older layout.
 *
 * The old-layout finding is emitted from this step rather than a step of its
 * own because it is a property of the same file set this step already inspects:
 * a separate step would re-walk the skill directory and print a second
 * "team-lessons skill" heading for one skill. Later steps (settings.json hook
 * detection, ccteams-owned file refresh) still append their own step objects to
 * MIGRATION_STEPS.
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
    // Detect-only: scaffoldTeamLessons() never rewrites a pre-existing SKILL.md,
    // so this reports the same findings in dry-run and in a real run — the file
    // it inspects is identical in both, before and after.
    return {
      id: this.id,
      title: this.title,
      added: result.created.map(toDisplayPath),
      kept: result.preserved.map(toDisplayPath),
      notices: buildTeamLessonsNotices(result, displayDestDir),
    };
  },
};

// The substring both `SessionStart` and `SubagentStart` entries are searched
// for (see isHookRegisteredForEvent). Deliberately a SUBSTRING match, not an
// exact-command match: a user may point the hook at an absolute path, prefix
// it with `cd $CLAUDE_PROJECT_DIR &&`, wrap it in `bash -c "..."`, or use
// `$CLAUDE_PROJECT_DIR` instead of a relative path. Issue #17 asks us to
// prioritize avoiding a FALSE "not registered" report over catching every
// possible unregistered variant, so a loose substring match is the intended
// behavior, not a shortcut.
const HOOK_COMMAND_NEEDLE = 'lessons-index.mjs';

/**
 * Read .claude/settings.json for the sole purpose of inspecting `hooks`,
 * distinguishing "the file does not exist" from "the file exists but is not
 * valid JSON" — a distinction `readSettings()` (use.js) deliberately collapses
 * into `{}` for both, because its caller (useTeam()) only ever needs "safe
 * default to merge into", never the reason. This step needs the reason: see
 * the design note on DESIGN-C below, at the call site in teamLessonsHookStep.
 *
 * @param {string} dotClaudeDir absolute path to <project>/.claude
 * @returns {{ settings: object, unreadable: boolean }} unreadable is true only
 *   when the file exists but JSON.parse threw; settings is {} in that case
 *   (never partially-parsed data).
 */
function readSettingsForHookDetection(dotClaudeDir) {
  const settingsPath = path.join(dotClaudeDir, 'settings.json');
  if (!fs.existsSync(settingsPath)) {
    return { settings: {}, unreadable: false };
  }
  try {
    return { settings: JSON.parse(fs.readFileSync(settingsPath, 'utf8')), unreadable: false };
  } catch {
    return { settings: {}, unreadable: true };
  }
}

/**
 * Whether `hooks.<eventName>` in `settings` already contains a command that
 * looks like it invokes the team-lessons index script.
 *
 * Every level of `settings.hooks.<eventName>[].hooks[].command` is validated
 * defensively (typeof / Array.isArray checks, no destructuring assumptions)
 * so a hand-edited or half-written settings.json — wrong types at any level —
 * is treated as "not registered" instead of throwing. This mirrors the
 * "never throw, just report" contract classifySkillLayout() and
 * scaffoldTeamLessons() already follow for a hand-edited SKILL.md.
 *
 * @param {object} settings parsed settings.json (or {})
 * @param {'SessionStart'|'SubagentStart'} eventName
 * @returns {boolean}
 */
function isHookRegisteredForEvent(settings, eventName) {
  const hooksSection = settings?.hooks;
  if (!hooksSection || typeof hooksSection !== 'object') return false;
  const matchers = hooksSection[eventName];
  if (!Array.isArray(matchers)) return false;
  for (const matcherEntry of matchers) {
    const hookList = matcherEntry?.hooks;
    if (!Array.isArray(hookList)) continue;
    for (const hook of hookList) {
      if (typeof hook?.command === 'string' && hook.command.includes(HOOK_COMMAND_NEEDLE)) {
        return true;
      }
    }
  }
  return false;
}

/**
 * DESIGN-D (dry-run/real-run agreement on whether lessons-index.mjs exists):
 *
 * teamLessonsScaffoldStep runs before this step in MIGRATION_STEPS and WRITES
 * scripts/lessons-index.mjs on a real run but not under --dry-run (dry-run
 * never writes — see its own contract). A naive `fs.existsSync(destPath)`
 * check in THIS step would therefore see the file present after a real
 * `ccteams migrate` but absent under `ccteams migrate --dry-run` on the exact
 * same starting project — a dry-run/real-run disagreement forbidden by the
 * project's "notices may not be reworded/retimed for one mode" rule.
 *
 * The fix: ask "will scripts/lessons-index.mjs exist once migrate is done
 * running (real or dry)?" instead of "does it exist on disk right now?". The
 * answer is yes whenever EITHER of these is true:
 *   - it is already on disk (a previously-scaffolded project, or this IS a
 *     real run and the scaffold step already wrote it this pass), or
 *   - the package's own scaffold template ships it (TEAM_LESSONS_SCAFFOLD_DIR),
 *     because teamLessonsScaffoldStep unconditionally copies every template
 *     file that is missing at the destination, in both modes (dry-run just
 *     skips the actual copyFileSync/mkdirSync calls — see scaffoldTeamLessons's
 *     contract in use.js). So if the template has the file, a completed
 *     migrate (real or, hypothetically, dry-run) guarantees the destination
 *     has it too.
 *
 * This keeps migrate()'s step-running loop untouched (no ctx threading of
 * prior results between steps is needed — see the module's `this`-binding
 * note on MIGRATION_STEPS) while still answering the "will it exist" question
 * identically regardless of dryRun.
 *
 * @param {{ dotClaudeDir: string }} ctx
 * @returns {boolean}
 */
function lessonsIndexWillExist(ctx) {
  const destPath = path.join(
    ctx.dotClaudeDir,
    'skills',
    TEAM_LESSONS_SKILL_NAME,
    'scripts',
    'lessons-index.mjs',
  );
  if (fs.existsSync(destPath)) return true;
  const scaffoldSrcPath = path.join(TEAM_LESSONS_SCAFFOLD_DIR, 'scripts', 'lessons-index.mjs');
  return fs.existsSync(scaffoldSrcPath);
}

/**
 * Render the copy-pasteable `"<eventName>": [ ... ]` fragment for a single
 * unregistered hook event, as an array of already-relative-indented lines
 * (see the notices contract: one rendered line per array element).
 *
 * Built with JSON.stringify (not a hand-written template literal) so the
 * fragment can never drift from valid JSON syntax, and sliced/dedented from a
 * throwaway `{ [eventName]: [...] }` wrapper so the shape matches the README's
 * "Injecting the catalog via a hook" example and Issue #17's own sample
 * output exactly (a `"<eventName>": [...]` fragment, not a full object).
 *
 * @param {'SessionStart'|'SubagentStart'} eventName
 * @param {string} commandPath forward-slash path to lessons-index.mjs,
 *   relative to the project root — see displayDestDir in teamLessonsHookStep.
 * @returns {string[]}
 */
function buildHookRegistrationSnippetLines(eventName, commandPath) {
  const wrapper = {
    [eventName]: [
      { matcher: '', hooks: [{ type: 'command', command: `node ${commandPath}` }] },
    ],
  };
  const rendered = JSON.stringify(wrapper, null, 2).split('\n');
  // Drop the wrapper's outer `{` / `}` lines and dedent the remaining lines by
  // the 2 spaces JSON.stringify indented them for the now-removed wrapper.
  return rendered.slice(1, -1).map((line) => (line.startsWith('  ') ? line.slice(2) : line));
}

/**
 * Migration step: detect whether the team-lessons catalog-injection hook
 * (README.md, "Injecting the catalog via a hook") is registered in
 * .claude/settings.json for BOTH `SessionStart` and `SubagentStart`, and
 * report — never write — whatever is missing.
 *
 * Placed AFTER teamLessonsScaffoldStep in MIGRATION_STEPS (see
 * lessonsIndexWillExist's DESIGN-D note above for why the ordering matters).
 *
 * CONTRACT: this step never calls writeSettings() or otherwise touches
 * .claude/settings.json — see the module header's "ccteams only manages a
 * single env key ... preserving all unrelated keys" note in use.js and the
 * project's broader "never touch a settings.json key ccteams didn't write"
 * rule (lib/unuse.js). Hooks run arbitrary user commands; registering one is
 * a deliberate step the user takes themselves (see README.md's rationale in
 * the same section this step points readers back to).
 *
 * DESIGN-C (settings.json absent vs. unparseable): `readSettingsForHookDetection`
 * distinguishes the two states, and only the unparseable state gets a
 * dedicated notice. An ABSENT settings.json is not ambiguous — "no file" and
 * "hooks not registered" are the same fact — so it is treated as normal
 * (both events reported unregistered, same wording as any other project). An
 * UNPARSEABLE settings.json (exists on disk but is invalid JSON) genuinely
 * cannot be inspected, so claiming "SubagentStart is not registered" would
 * assert something this step did not actually verify (the project's rule
 * that a notice's heading must name only what its own branch tested — see
 * classifySkillLayout's docstring for the same rule applied to SKILL.md).
 * That state gets its own notice instead, and skips the registration check
 * entirely for both events.
 *
 * DESIGN-E (no "✓ registered" line): unlike Issue #17's illustrative sample
 * output, this step's notices never announce a registered event as OK.
 * buildTeamLessonsNotices() (the sibling step above) only ever reports
 * problems — it has no "this file is fine" line either — so a bare success
 * carries no notice by the same convention. This is also what makes "both
 * registered → report nothing" (an explicit completion condition) fall out
 * naturally: notices stays [] rather than becoming a list of two ✓ lines.
 */
export const teamLessonsHookStep = {
  id: 'team-lessons-hook',
  title: 'team-lessons hook',
  run(ctx) {
    const skillDir = path.join(ctx.dotClaudeDir, 'skills', TEAM_LESSONS_SKILL_NAME);
    const displayDestDir = path.relative(ctx.projectRoot, skillDir).split(path.sep).join('/');
    const empty = { id: this.id, title: this.title, added: [], kept: [], notices: [] };

    // Nothing meaningful to advise about a script that will never exist (see
    // lessonsIndexWillExist's DESIGN-D note) — this only trips if the package
    // itself ships without the scaffold template, an environment problem this
    // step is not responsible for diagnosing.
    if (!lessonsIndexWillExist(ctx)) return empty;

    const { settings, unreadable } = readSettingsForHookDetection(ctx.dotClaudeDir);
    if (unreadable) {
      return {
        ...empty,
        notices: [
          '! .claude/settings.json exists but is not valid JSON — could not check whether the ' +
            'team-lessons catalog hook is registered.',
          '  Fix the JSON syntax, then re-run "ccteams migrate" to check hook registration.',
        ],
      };
    }

    const registeredByEvent = {
      SessionStart: isHookRegisteredForEvent(settings, 'SessionStart'),
      SubagentStart: isHookRegisteredForEvent(settings, 'SubagentStart'),
    };
    if (registeredByEvent.SessionStart && registeredByEvent.SubagentStart) return empty;

    const commandPath = `${displayDestDir}/scripts/lessons-index.mjs`;
    const notices = [];
    // Each event's line names only the scope THAT event actually covers — not
    // "agents" in general. Only SessionStart's one-directional fact (it does
    // not fire for subagents) is documented in README.md:234; the README says
    // nothing about whether SubagentStart fires for the main session, so the
    // per-event line below must not imply anything about the OTHER event's
    // scope either way (a SessionStart-only-missing report must not claim
    // subagents are affected, since SubagentStart may already be registered).
    const scopeOf = { SessionStart: 'the main session', SubagentStart: 'subagents' };
    // Order matches README.md's "Injecting the catalog via a hook" section
    // (SessionStart, then SubagentStart) — see the two events individually,
    // per the umbrella issue's "取りこぼさないため" requirement.
    for (const eventName of ['SessionStart', 'SubagentStart']) {
      if (registeredByEvent[eventName]) continue;
      notices.push(
        `! ${eventName} — not registered. The team-lessons catalog will not reach ${scopeOf[eventName]} via this hook.`,
        '  Add this to .claude/settings.json:',
        ...buildHookRegistrationSnippetLines(eventName, commandPath).map((line) => `  ${line}`),
      );
    }
    // The parenthetical below repeats ONLY what README.md:234 itself states
    // (SessionStart's one-directional fact) — it must not also assert
    // SubagentStart's firing scope for the main session, which the README
    // does not document and this module cannot verify first-hand.
    notices.push(
      '  Both SessionStart and SubagentStart are needed — see README.md, "Injecting the catalog',
      '  via a hook", for why (SessionStart does not fire for subagents, and subagents are',
      '  the ones that most need the catalog).',
    );

    return { ...empty, notices };
  },
};

/**
 * All migration steps, applied in order. Later subs (D) append here.
 */
export const MIGRATION_STEPS = [teamLessonsScaffoldStep, teamLessonsHookStep];

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
  let hasNotices = false;
  for (const step of steps) {
    const rows = [
      ...step.added.map((p) => ({ marker: '+', path: p, added: true })),
      ...step.kept.map((p) => ({ marker: '=', path: p, added: false })),
    ];
    // Computed before the "skip an empty step's heading" check below on
    // purpose, defensively: a step with a non-empty `added` always has
    // `rows.length > 0` too, so today no step both contributes to `pending`
    // AND gets skipped — but keeping the order this way means a future step
    // shape can never silently drop its contribution to the summary line's
    // wording ("Everything is up to date." vs. "Added N file(s).") just
    // because it also happens to skip its heading. This is UNRELATED to
    // exitCode: migrate() computes its own exitCode from an independent
    // `steps.reduce(...)` over the same `added` arrays (see migrate()'s own
    // exitCode rule above) — this `pending` variable is local to formatting
    // and never read outside this function.
    pending += step.added.length;
    // Skip the step entirely (no heading, no blank line) when it has nothing
    // to report — e.g. teamLessonsHookStep once both SessionStart and
    // SubagentStart are registered (see DESIGN-E in migrate.js). Printing an
    // empty `team-lessons hook` heading in that case would contradict the
    // "report nothing once both are registered" completion condition.
    if (rows.length === 0 && step.notices.length === 0) continue;
    lines.push(`  ${step.title}`);
    const width = rows.length > 0 ? Math.max(...rows.map((r) => r.path.length)) : 0;
    for (const row of rows) {
      const suffix = row.added ? (dryRun ? '(would be added)' : '(added)') : '(kept as-is)';
      lines.push(`    ${row.marker} ${padLabel(row.path, width)}   ${suffix}`);
    }
    for (const notice of step.notices) {
      lines.push(`    ${notice}`);
      hasNotices = true;
    }
    lines.push('');
  }

  if (pending === 0) {
    // "Everything is up to date" would contradict a notice printed two lines
    // above it: notices exist precisely because something is NOT up to date and
    // only the user can fix it (ccteams may not rewrite those files). Notices
    // are not counted here — one finding spans several lines (see the notices
    // contract above) — so the wording avoids implying a number.
    lines.push(
      hasNotices
        ? 'No files to add — see the note(s) above for what needs your attention.'
        : 'Everything is up to date.',
    );
  } else if (dryRun) {
    lines.push('Run "ccteams migrate" to apply.');
  } else {
    lines.push(`Added ${pending} file${pending !== 1 ? 's' : ''}.`);
  }

  return lines.join('\n');
}
