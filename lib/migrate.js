/**
 * migrate.js — implements `ccteams migrate` (and `ccteams migrate --dry-run`).
 *
 * Purpose: a project that applied ccteams a while ago and then ran
 * `npm install -g https://github.com/rinjugatla/ccteams.git` does not
 * automatically pick up files that newer ccteams versions ship into
 * `.claude/` (npm updates the globally installed package, not files
 * ccteams already wrote into the project).
 * `ccteams migrate` closes that gap for the pieces ccteams is allowed to
 * touch without risking hand-written content — see each step's contract.
 *
 * Migration steps: this module is deliberately structured as a list of
 * independent "migration step" objects rather than one big function
 * (an old-layout `SKILL.md` / missing scaffold-file check, a missing
 * catalog-injection-hook check in settings.json, and a ccteams-owned-file
 * (agent/skill) upstream-diff check — see teamLessonsScaffoldStep,
 * teamLessonsHookStep and ownedFilesStep below), so that further steps can be
 * added by appending to MIGRATION_STEPS without touching migrate() itself.
 * See the `id`/`title`/`run` shape below.
 *
 * Interactivity: ownedFilesStep is the one step that may prompt (via
 * lib/prompt.js's node:readline/promises wrapper) — only when NOT --dry-run,
 * NOT --yes, and stdin/stdout are both a TTY (or a test injects its own
 * prompt function). `--dry-run` always communicates its finding via exitCode
 * instead, so its behavior is identical whether stdin is a TTY or a CI
 * pipe — see the exitCode rule in migrate() below.
 */

import fs from 'fs';
import path from 'path';
import { readManifest, writeManifest, resolvePlacedFiles, resolveFileHashes } from './manifest.js';
import { buildOwnedSourceIndex } from './placement.js';
import { hashFileSync } from './hash.js';
import { createTtyPrompter } from './prompt.js';
import { showFileDiff } from './diff.js';
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
 * A migration step. ctx = { projectRoot, dotClaudeDir, manifest, dryRun, yes,
 * force, promptFn }. `yes`/`force` mirror migrate()'s own opts (see its doc
 * comment); `promptFn` is `(question: string) => Promise<string>` or `null`
 * when no step may prompt this run (dry-run, `--yes`, non-TTY, or a test that
 * injected `prompt: null`) — only ownedFilesStep currently reads it.
 *
 * run(ctx) may be sync or async — migrate() always `await`s it — and must
 * return at least:
 *   {
 *     id: string,
 *     title: string,
 *     added: string[],    // paths (relative, for display) added — or that
 *                          // WOULD be added under dryRun — this run
 *     updated: string[],  // paths OVERWRITTEN with a newer/ccteams-chosen
 *                          // version — or that WOULD be under dryRun — this
 *                          // run. Optional on a step that never updates
 *                          // anything (defaults to [] — see formatMigrateReport).
 *     kept: string[],     // paths left untouched (already present)
 *     notices: string[],  // human-readable messages for detect-only findings
 *                          // (no file writes implied); ONE LINE PER ELEMENT —
 *                          // formatMigrateReport() indents each element by four
 *                          // spaces and prints it verbatim, so a multi-line
 *                          // message must be pushed as several elements that
 *                          // carry their own relative indentation.
 *   }
 * A step may also return extra fields consumed only by migrate() itself (see
 * ownedFilesStep's `baselineUpdates`) — formatMigrateReport() only ever reads
 * the fields documented above.
 *
 * Notices are advice, never work ccteams performed or will perform: they are
 * excluded from `pending`/`updates` and therefore from `exitCode` (see
 * migrate()). Only a file ccteams actually adds or updates counts toward
 * those totals, so `migrate --dry-run` keeps meaning "ccteams would change
 * these files without asking" in CI rather than "a human should read
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
 * distinguishing "the file does not exist" from "the file exists but could not
 * be read or parsed as JSON" — a distinction `readSettings()` (use.js)
 * deliberately collapses into `{}` for both, because its caller (useTeam())
 * only ever needs "safe default to merge into", never the reason. This step
 * needs the reason: see the design note on DESIGN-C below, at the call site in
 * teamLessonsHookStep.
 *
 * @param {string} dotClaudeDir absolute path to <project>/.claude
 * @returns {{ settings: object, unreadable: boolean }} unreadable is true when
 *   the file exists but reading OR parsing it threw; settings is {} in that
 *   case (never partially-parsed data). readFileSync and JSON.parse share one
 *   try block deliberately — the caller's advice is the same either way — so
 *   `unreadable` must never be reported as "the JSON is invalid" specifically:
 *   EACCES, EISDIR (a directory sitting at that path), and so on land here too.
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
 * DESIGN-C (settings.json absent vs. unreadable): `readSettingsForHookDetection`
 * distinguishes the two states, and only the unreadable state gets a
 * dedicated notice. An ABSENT settings.json is not ambiguous — "no file" and
 * "hooks not registered" are the same fact — so it is treated as normal
 * (both events reported unregistered, same wording as any other project). An
 * UNREADABLE settings.json (exists on disk, but reading or parsing it failed —
 * invalid JSON, EACCES, a directory at that path, ...) genuinely
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
        // The heading names only what this branch established. The read and
        // the parse share one try block (see readSettingsForHookDetection), so
        // "is not valid JSON" would name a cause never distinguished from a
        // plain read failure (EACCES, EISDIR, ...) — hence the advice covers
        // both possibilities too.
        notices: [
          '! .claude/settings.json exists but could not be read or parsed as JSON — could not ' +
            'check whether the team-lessons catalog hook is registered.',
          '  Fix the JSON syntax (or check the file is readable), then re-run "ccteams migrate" ' +
            'to check hook registration.',
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
 * Render the interactive prompt text for one file needing a decision.
 *
 * The two states get DIFFERENT wording on purpose (see ownedFilesStep's own
 * comment on the invariant this protects): 'user-modified' is the only state
 * that has actually verified the project's content diverged from a recorded
 * baseline, so it is the only one allowed to say "you have modified this
 * file". 'unknown-baseline' has verified only that the content differs from
 * what ccteams ships — it must not claim to know who changed it.
 *
 * @param {'user-modified' | 'unknown-baseline'} state
 * @param {string} dispPath project-relative, forward-slash display path
 * @returns {string}
 */
function buildOverwritePrompt(state, dispPath) {
  const options = '  [y] overwrite  [n] keep mine  [d] show diff  [a] overwrite all  [q] quit\n';
  if (state === 'user-modified') {
    return `${dispPath} — you have modified this file, and ccteams has a newer version.\n${options}`;
  }
  return (
    `${dispPath} — differs from the version ccteams ships. No baseline hash was\n` +
    `  recorded for it, so ccteams cannot tell an edit of yours from an upstream update.\n${options}`
  );
}

/**
 * Ask the user what to do about one user-modified/unknown-baseline file,
 * looping on an invalid answer or a diff request until a terminal answer
 * (y/n/a/q) is given.
 *
 * @param {{ promptFn: (question: string) => Promise<string> }} ctx
 * @param {'user-modified' | 'unknown-baseline'} state
 * @param {string} dispPath
 * @param {string} projectAbsPath current on-disk file
 * @param {string} packageSrcAbsPath what ccteams would overwrite it with
 * @param {{ onAll: () => void, onQuit: () => void }} callbacks invoked when
 *   the answer is 'a' (overwrite this and every remaining file) or 'q'
 *   (skip this and every remaining file) — the caller uses these to update
 *   its own loop-wide state without this function needing to know its shape.
 * @returns {Promise<boolean>} true = overwrite this file, false = keep it
 */
async function askAboutFile(ctx, state, dispPath, projectAbsPath, packageSrcAbsPath, { onAll, onQuit }) {
  const question = buildOverwritePrompt(state, dispPath);
  for (;;) {
    let raw;
    try {
      raw = await ctx.promptFn(question);
    } catch {
      raw = null; // a rejected prompt is treated exactly like EOF — see below.
    }
    // EOF (readline returns/resolves nothing when stdin closes mid-question)
    // falls back to the safe direction: skip this file AND every remaining
    // one, the same as an explicit 'q'.
    if (raw === null || raw === undefined) {
      onQuit();
      return false;
    }
    switch (String(raw).trim().toLowerCase()) {
      case 'y':
        return true;
      case 'n':
        return false;
      case 'a':
        onAll();
        return true;
      case 'q':
        onQuit();
        return false;
      case 'd':
        // { shown } is deliberately not branched on here: whether or not git
        // was available, showFileDiff() has ALREADY printed the right thing
        // for that outcome (the real diff, or its own explanatory fallback
        // text) — there is nothing left for this caller to decide or add.
        // Re-asking the SAME file is correct either way. (The return value
        // itself is not dead — it is asserted directly in test/diff.test.mjs.)
        showFileDiff(projectAbsPath, packageSrcAbsPath);
        continue; // show the diff, then re-ask the SAME file
      default:
        continue; // unrecognized input — re-ask rather than guess
    }
  }
}

/**
 * Build the notices ownedFilesStep reports for files it did NOT touch.
 *
 * Each block's heading must name only the condition its OWN branch actually
 * checked (see classifySkillLayout's docstring above for the same rule
 * applied elsewhere in this file) — most importantly, the unknown-baseline
 * block must never say "you edited this file": that branch never established
 * who changed it, only that a recorded baseline is absent.
 *
 * @param {{ orphanedDisp: string[], unreadableDisp: string[],
 *   userModifiedDisp: string[], unknownBaselineDisp: string[],
 *   unknownTeams: string[] }} findings
 * @returns {string[]}
 */
function buildOwnedFilesNotices({
  orphanedDisp,
  unreadableDisp,
  userModifiedDisp,
  unknownBaselineDisp,
  unknownTeams,
}) {
  const notices = [];

  if (orphanedDisp.length > 0) {
    notices.push(
      `! ${orphanedDisp.length} file(s) ccteams no longer ships a source for — left untouched, never deleted:`,
      ...orphanedDisp.map((p) => `  ${p}`),
      '  This happens when a team is renamed/removed in this ccteams version, or a file',
      "  dropped out of a still-known team's current file set.",
    );
  }

  if (unreadableDisp.length > 0) {
    notices.push(
      `! ${unreadableDisp.length} file(s) could not be read (permission error or similar) — left untouched:`,
      ...unreadableDisp.map((p) => `  ${p}`),
      '  ccteams could not compare this file\'s content, so it made no decision about it at all.',
      '  Check the file/directory permissions, then re-run "ccteams migrate".',
    );
  }

  if (unknownTeams.length > 0) {
    notices.push(
      '! Team(s) not shipped by this ccteams version — their placed files are treated as',
      `  orphaned (see above) and never touched: ${unknownTeams.join(', ')}`,
    );
  }

  if (userModifiedDisp.length > 0) {
    notices.push(
      `! ${userModifiedDisp.length} file(s) you have edited also differ from the version ccteams ships` +
        ' — left unchanged:',
      ...userModifiedDisp.map((p) => `  ${p}`),
      '  Overwrite them with "ccteams migrate --yes --force", or run "ccteams migrate" in an',
      '  interactive terminal to decide file by file.',
    );
  }

  if (unknownBaselineDisp.length > 0) {
    notices.push(
      `! ${unknownBaselineDisp.length} file(s) differ from the version ccteams ships, but no baseline hash` +
        ' was',
      '  recorded for them (e.g. an older manifest), so ccteams cannot tell an edit of yours',
      '  from an upstream update — left unchanged:',
      ...unknownBaselineDisp.map((p) => `  ${p}`),
      '  Overwrite them with "ccteams migrate --yes --force", or run "ccteams migrate" in an',
      '  interactive terminal to decide file by file.',
    );
  }

  return notices;
}

/**
 * Migration step: detect and reconcile drift in every ccteams-OWNED file
 * (agent definitions, playbook skills, the shared working-method skill —
 * anything recorded in some applied team's manifest entry `placedFiles`) by
 * comparing three things per file: the package's current source for it (U),
 * the project's current on-disk content (P), and the hash ccteams recorded
 * as the baseline when it was placed (B, absent on a pre-v4 manifest).
 *
 * SCOPE — determined ENTIRELY by reading `placedFiles` off the manifest, in
 * `manifest.teams` key order, deduped by absolute destination path. This is
 * deliberate, not incidental: `.claude/skills/team-lessons/` is NEVER
 * recorded in any team's `placedFiles` (use.js scaffolds it as a sibling
 * step and explicitly does not push its files there — see use.js step 4.8's
 * comment, and placement.js's reserved-name filtering, which is WHY no
 * team's resolved placement ever contains a team-lessons pair in the first
 * place). Reading `placedFiles` therefore excludes team-lessons structurally,
 * with no path-name check to hardcode or forget.
 *
 * Seven-way per-file classification (see the design doc this implements, and
 * classifyOwnedFile() below for the pure decision function these states are
 * computed by):
 *   1. orphaned         — no source in the package's CURRENT placement for
 *                          this dest (a removed/renamed team, or a file that
 *                          dropped out of a still-shipped team's set).
 *                          Never deleted; reported only.
 *   2. unreadable        — the package HAS a source for this dest, but either
 *                          that source or the project's own copy could not be
 *                          read (e.g. EACCES). Reported only — see
 *                          classifyOwnedFile()'s doc comment for why this is
 *                          its own state rather than folding into `orphaned`
 *                          or `unchanged`.
 *   3. missing           — the dest is simply absent on disk (and the source
 *                          IS readable). Restored with no confirmation (there
 *                          is nothing of the user's to lose by writing a file
 *                          that is not there).
 *   4. unchanged         — hash(P) === hash(U). Nothing to do, nothing to
 *                          report.
 *   5. upstream-changed  — hash(P) matches a recorded baseline (B), so the
 *                          project never touched it; only the package's own
 *                          source moved on. Updated with no confirmation.
 *   6. user-modified     — a baseline IS recorded, but hash(P) matches none
 *                          of the values recorded for it. Skipped by default;
 *                          overwrite needs `--yes --force` or an interactive
 *                          'y'/'a' answer.
 *   7. unknown-baseline  — no team claiming this dest ever recorded a hash
 *                          for it (a pre-v4 manifest). Same default behavior
 *                          as (6), but MUST NOT claim the user edited the
 *                          file — this branch never checked that; see
 *                          buildOwnedFilesNotices()'s doc comment.
 *
 * Processing order is the display path's ASCII sort — deterministic run to
 * run, so an interactive session's prompt order never depends on directory
 * walk order or manifest.teams iteration order.
 *
 * Baseline bookkeeping: this step also returns `baselineUpdates`, a
 * `Map<destAbsPath, newHash>` covering every file whose FINAL content (after
 * this step's real-or-hypothetical write) equals the package source — i.e.
 * states 3/4/5 (missing/unchanged/upstream-changed) always, and 6/7
 * (user-modified/unknown-baseline) only when actually overwritten. States 1
 * and 2 (orphaned/unreadable) never contribute — nothing was verified to
 * match the package source in either case. migrate() reconciles this into
 * the manifest's `fileHashes` for every team claiming that dest (see
 * migrate()'s own comment on why this is not this step's job: writing the
 * manifest is a cross-step concern the caller owns, exactly like the
 * write-once-at-the-end convention useTeam() already follows).
 */

/**
 * Pure per-file classifier — no filesystem access, so every input
 * combination (including the null-hash edge cases hashFileSync() produces
 * for an unreadable file) is directly unit-testable without fixtures.
 * Extracted from ownedFilesStep's per-file loop specifically to close a
 * correctness gap a code review found: hashFileSync() returns `null` for
 * ANY unreadable file (missing, a directory, EACCES, ...), so comparing
 * `pHash === uHash` directly — as the inline version of this logic used to —
 * would treat `null === null` (source AND dest both unreadable) as a
 * verified content match and silently classify it 'unchanged', when in fact
 * NO byte was ever compared. `unreadable` exists specifically to make that
 * case honest: it is reported, never silently folded into 'unchanged',
 * 'orphaned', or any state that implies a real comparison happened.
 *
 * @param {{
 *   hasSource: boolean,          // the package has a CURRENT source for this dest
 *   exists: boolean,             // the dest exists on disk (independent of pHash)
 *   uHash: string | null,        // hash of the package source, or null if unreadable
 *   pHash: string | null,        // hash of the dest, or null if it exists but unreadable
 *   baselineHashes: Set<string>, // every baseline hash recorded for this dest
 * }} input
 * @returns {'orphaned'|'unreadable'|'missing'|'unchanged'|'upstream-changed'|'user-modified'|'unknown-baseline'}
 */
export function classifyOwnedFile({ hasSource, exists, uHash, pHash, baselineHashes }) {
  if (!hasSource) return 'orphaned';
  // The package's own source could not be read — there is nothing to
  // compare against, and a `missing` restore or an `upstream-changed`
  // update would fail (or worse, propagate a bad read) if attempted from
  // it. Checked BEFORE `missing`: even an absent dest cannot be safely
  // "restored" from a source this function cannot vouch for.
  if (uHash === null) return 'unreadable';
  if (!exists) return 'missing';
  // The dest EXISTS but could not be read (e.g. EACCES) — distinct from
  // `missing` (existsSync() said "it's there") and from `unchanged` (this
  // function never actually compared any bytes to reach that conclusion).
  if (pHash === null) return 'unreadable';
  if (pHash === uHash) return 'unchanged';
  if (baselineHashes.size > 0 && baselineHashes.has(pHash)) return 'upstream-changed';
  return baselineHashes.size > 0 ? 'user-modified' : 'unknown-baseline';
}

export const ownedFilesStep = {
  id: 'ccteams-owned-files',
  title: 'ccteams-owned files',
  async run(ctx) {
    const { projectRoot, manifest, dryRun } = ctx;
    const teamNames = Object.keys(manifest.teams);

    // destAbsPath -> [team names claiming it]. Built directly from
    // placedFiles (never a directory walk) — see this step's own doc comment
    // above for why that is what keeps team-lessons structurally excluded.
    const claimedBy = new Map();
    for (const name of teamNames) {
      const entry = manifest.teams[name];
      for (const dest of resolvePlacedFiles(entry.placedFiles, projectRoot)) {
        if (!claimedBy.has(dest)) claimedBy.set(dest, []);
        claimedBy.get(dest).push(name);
      }
    }

    const { index: sourceIndex, unknownTeams } = buildOwnedSourceIndex(manifest, projectRoot);

    const displayPath = (abs) => path.relative(projectRoot, abs).split(path.sep).join('/');
    const sortedDests = [...claimedBy.keys()].sort((a, b) => displayPath(a).localeCompare(displayPath(b)));

    const added = [];
    const updated = [];
    const orphanedDisp = [];
    const unreadableDisp = [];
    const userModifiedDisp = [];
    const unknownBaselineDisp = [];
    // destAbsPath -> hash the file's content equals (or would equal) once
    // this step's work (real or hypothetical, under dry-run) is done.
    const baselineUpdates = new Map();

    // Interactive "answer for the rest of the run" state — 'a' and 'q' set
    // these, and every later file in sortedDests consults them before asking
    // anything itself.
    let overwriteAllRemaining = false;
    let skipAllRemaining = false;

    // Wraps a write (mkdirSync + copyFileSync) so a mid-run fs failure (e.g.
    // EACCES on a read-only .claude/) reaches the user as a short,
    // path-specific message instead of a raw stack trace — the same
    // treatment teamLessonsScaffoldStep already gives its own writes (see
    // that step's try/catch above). Re-thrown as a plain Error so migrate()'s
    // existing catch (which formats `{ success:false, message }`) handles it
    // exactly like any other step failure.
    const writeFile = (src, dest, disp) => {
      try {
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        fs.copyFileSync(src, dest);
      } catch (err) {
        throw new Error(`Could not write "${disp}": ${err.code ?? err.message}.`);
      }
    };

    for (const dest of sortedDests) {
      const disp = displayPath(dest);
      const src = sourceIndex.get(dest);
      const exists = src ? fs.existsSync(dest) : false;
      const uHash = src ? hashFileSync(src) : null;
      const pHash = exists ? hashFileSync(dest) : null;

      // Baseline resolution: any claiming team's recorded hash for this dest
      // counts — they all describe the same on-disk file, so in practice
      // they agree (see the design doc's rationale for this rule). Computed
      // unconditionally (even for states that end up not needing it, e.g.
      // orphaned) so classifyOwnedFile() can stay a pure function of already-
      // gathered facts rather than reaching back into the filesystem itself.
      const baselineHashes = new Set();
      for (const teamName of claimedBy.get(dest)) {
        const h = resolveFileHashes(manifest.teams[teamName], projectRoot).get(dest);
        if (h) baselineHashes.add(h);
      }

      const state = classifyOwnedFile({ hasSource: !!src, exists, uHash, pHash, baselineHashes });

      if (state === 'orphaned') {
        orphanedDisp.push(disp);
        continue;
      }

      if (state === 'unreadable') {
        unreadableDisp.push(disp);
        continue;
      }

      if (state === 'missing') {
        if (!dryRun) writeFile(src, dest, disp);
        added.push(disp);
        baselineUpdates.set(dest, uHash);
        continue;
      }

      if (state === 'unchanged') {
        // Report nothing; the baseline is a proven fact here (content
        // literally equals the package source right now), not a guess about
        // how it got that way.
        baselineUpdates.set(dest, uHash);
        continue;
      }

      if (state === 'upstream-changed') {
        if (!dryRun) writeFile(src, dest, disp);
        updated.push(disp);
        baselineUpdates.set(dest, uHash);
        continue;
      }

      // state is 'user-modified' or 'unknown-baseline' — same default
      // behavior (skip), different, precisely scoped wording (see
      // buildOwnedFilesNotices()).
      let overwrite = false;
      if (ctx.yes && ctx.force) {
        // --yes --force is the only non-interactive way to overwrite these —
        // --yes alone must never reach here (ctx.promptFn is already null
        // whenever ctx.yes is true — see migrate()'s promptFn construction —
        // so the branch below could never fire for --yes alone anyway; this
        // check is what actually AUTHORIZES the overwrite).
        overwrite = true;
      } else if (ctx.promptFn && !skipAllRemaining) {
        overwrite = overwriteAllRemaining
          ? true
          : await askAboutFile(ctx, state, disp, dest, src, {
              onAll: () => {
                overwriteAllRemaining = true;
              },
              onQuit: () => {
                skipAllRemaining = true;
              },
            });
      }

      if (overwrite) {
        if (!dryRun) writeFile(src, dest, disp);
        updated.push(disp);
        baselineUpdates.set(dest, uHash);
      } else if (state === 'user-modified') {
        userModifiedDisp.push(disp);
      } else {
        unknownBaselineDisp.push(disp);
      }
    }

    return {
      id: this.id,
      title: this.title,
      added,
      updated,
      kept: [], // unchanged files are never reported — see #4 above.
      notices: buildOwnedFilesNotices({
        orphanedDisp,
        unreadableDisp,
        userModifiedDisp,
        unknownBaselineDisp,
        unknownTeams,
      }),
      // Consumed by migrate() only (not part of the public StepResult shape
      // the other steps document) — see this step's own doc comment on
      // baseline bookkeeping.
      baselineUpdates,
    };
  },
};

/**
 * Reconcile ownedFilesStep's `baselineUpdates` into every team manifest
 * entry that claims the affected destination(s), returning a NEW teams map
 * (never mutates `manifest.teams`) plus how many DISTINCT files actually
 * needed a change.
 *
 * "Distinct files" (not distinct team-entry writes) is the unit `changedCount`
 * counts in, matching the "N ccteams-owned file(s)" wording migrate() reports
 * — a file claimed by two teams whose recorded baselines both need updating
 * is one changed FILE, not two, even though this function ends up rewriting
 * two team entries' fileHashes for it.
 *
 * @param {{ teams: Record<string, { placedFiles: unknown, fileHashes?: unknown }> }} manifest
 * @param {string} projectRoot
 * @param {Map<string, string>} baselineUpdates destAbsPath -> new hash
 * @returns {{ teamsMap: Record<string, unknown>, changedCount: number }}
 */
function applyBaselineUpdates(manifest, projectRoot, baselineUpdates) {
  const teamsMap = {};
  const changedDests = new Set();
  for (const [name, entry] of Object.entries(manifest.teams)) {
    const claimedDests = new Set(resolvePlacedFiles(entry.placedFiles, projectRoot));
    const nextHashes = resolveFileHashes(entry, projectRoot); // Map<absPath, hash> — copy per entry
    for (const [dest, newHash] of baselineUpdates) {
      if (!claimedDests.has(dest)) continue;
      if (nextHashes.get(dest) !== newHash) changedDests.add(dest);
      nextHashes.set(dest, newHash);
    }
    teamsMap[name] = { ...entry, fileHashes: Object.fromEntries(nextHashes) };
  }
  return { teamsMap, changedCount: changedDests.size };
}

/**
 * All migration steps, applied in order.
 */
export const MIGRATION_STEPS = [teamLessonsScaffoldStep, teamLessonsHookStep, ownedFilesStep];

/**
 * Run every migration step against the current project.
 *
 * projectRoot defaults to process.cwd(). opts:
 *   dryRun (default false) — when true, no step writes anything to disk
 *     (including the manifest's baseline-hash bookkeeping); `added`/`updated`
 *     report what WOULD happen.
 *   yes (default false) — skip the interactive confirmation entirely.
 *     upstream-changed files are still updated (they never needed
 *     confirmation); user-modified/unknown-baseline files are still SKIPPED
 *     unless `force` is also true — see ownedFilesStep.
 *   force (default false) — only takes effect together with `yes`: also
 *     overwrites user-modified/unknown-baseline files without asking. Alone
 *     (without `yes`) it does nothing at the migrate()/step level — the CLI
 *     (bin/ccteams.js) rejects that combination outright before it ever
 *     reaches here, so this function does not need to re-validate it.
 *   prompt ((question: string) => Promise<string>) — inject a prompt
 *     function for tests. `null` explicitly disables prompting (simulates a
 *     non-TTY run) even where stdin/stdout ARE a TTY. Omitted (undefined)
 *     falls back to autodetection: a real node:readline/promises prompter
 *     when both stdin and stdout are a TTY, otherwise no prompting.
 *
 * Returns:
 * {
 *   success: true,
 *   dryRun: boolean,
 *   applied: boolean,   // false only when ccteams is not applied in this project
 *   steps: StepResult[],
 *   pending: number,    // total `added` count across all steps
 *   updates: number,    // total `updated` count across all steps
 *   message: string,    // formatted report, ready to print
 *   exitCode: number,
 * }
 *
 * exitCode rule: `dryRun && (pending + updates) > 0` → 1 (mirrors the repo's
 * existing `gen-lessons.mjs --check` convention of a non-zero exit on
 * detected drift, and the umbrella issue's "no prompt in CI; use exit codes"
 * requirement). `updates` joins `pending` in this rule because both describe
 * work ccteams would do WITHOUT asking (restoring a missing file, or
 * updating an upstream-changed one) — exactly the class of change
 * `--dry-run` exists to preview. A skipped user-modified/unknown-baseline
 * file, an advisory notice, or the baseline-bookkeeping record count are
 * deliberately excluded: none of them is something ccteams does on its own —
 * the first two need a human decision, and the third changes nothing about
 * the project's files, only ccteams' own ledger of what it last saw. A real
 * (non-dry-run) run is always exitCode 0 on success — it does not fail just
 * because it wrote files.
 *
 * On failure (a step throws — see teamLessonsScaffoldStep for the cases this
 * covers), returns `{ success: false, message, exitCode: 1, ... }` matching
 * the `{ success, message }` shape useTeam()/unuseTeam() already use, instead
 * of letting the raw error (and its stack) propagate to the caller. This
 * applies identically whether dryRun is true or false — a step is expected to
 * detect its own failure conditions before writing anything, so the two modes
 * never disagree about whether an operation would succeed.
 */
export async function migrate(projectRoot = process.cwd(), opts = {}) {
  const { dryRun = false, yes = false, force = false, prompt } = opts;
  const dotClaudeDir = path.join(projectRoot, '.claude');
  const manifest = readManifest(projectRoot);

  if (!manifest) {
    return {
      success: true,
      dryRun,
      applied: false,
      steps: [],
      pending: 0,
      updates: 0,
      message: formatMigrateReport({ dryRun, applied: false, steps: [] }),
      exitCode: 0,
    };
  }

  // Lazily create the real TTY prompter — only if ownedFilesStep actually
  // asks a question — and guarantee it is closed exactly once no matter how
  // the step loop below exits (including a thrown error), so a run that
  // never needed a prompt never opens (or leaves hanging) stdin.
  let ttyPrompter = null;
  const promptFn = (() => {
    // --dry-run and --yes both mean "never prompt" — see this function's own
    // opts doc above — so ownedFilesStep is guaranteed ctx.promptFn === null
    // in either case; it does not need to re-check dryRun/yes itself.
    if (dryRun || yes) return null;
    if (prompt !== undefined) return prompt; // test-injected — may itself be null
    if (!(process.stdin.isTTY && process.stdout.isTTY)) return null; // CI / piped stdin
    return (question) => {
      if (!ttyPrompter) ttyPrompter = createTtyPrompter();
      return ttyPrompter.ask(question);
    };
  })();

  const ctx = { projectRoot, dotClaudeDir, manifest, dryRun, yes, force, promptFn };
  let steps;
  try {
    steps = [];
    for (const step of MIGRATION_STEPS) {
      // Call as `step.run(ctx)` (not a destructured `run`) so `this` inside
      // an existing step's run() still refers to the step object — see the
      // sibling steps' use of `this.id`/`this.title`.
      steps.push(await step.run(ctx));
    }
  } catch (err) {
    return {
      success: false,
      dryRun,
      applied: true,
      steps: [],
      pending: 0,
      updates: 0,
      message: `ccteams migrate: ${err.message ?? String(err)}`,
      exitCode: 1,
    };
  } finally {
    if (ttyPrompter) ttyPrompter.close();
  }

  const pending = steps.reduce((sum, step) => sum + step.added.length, 0);
  const updates = steps.reduce((sum, step) => sum + (step.updated ?? []).length, 0);

  // Reconcile ownedFilesStep's baseline-hash bookkeeping into the manifest.
  // This is deliberately done HERE, not inside the step: writing the
  // manifest is a cross-step, once-at-the-end concern the caller owns (the
  // same convention useTeam() already follows for its own single manifest
  // write), and only migrate() knows whether ANY step's baselineUpdates
  // actually changed a stored value (the gate for whether to write at all).
  let baselineMessageSuffix = '';
  const ownedFilesResult = steps.find((s) => s.id === ownedFilesStep.id);
  if (ownedFilesResult?.baselineUpdates?.size > 0) {
    const { teamsMap, changedCount } = applyBaselineUpdates(
      manifest,
      projectRoot,
      ownedFilesResult.baselineUpdates,
    );
    // Only write (and only report) when at least one stored value actually
    // changes — never write just to touch the manifest's mtime for a run
    // that provably changed nothing in it.
    if (changedCount > 0) {
      if (!dryRun) {
        writeManifest(projectRoot, { teams: teamsMap, agentTeamsFlagSet: manifest.agentTeamsFlagSet === true });
      }
      baselineMessageSuffix =
        `\n${dryRun ? 'Would record' : 'Recorded'} baseline hashes for ${changedCount} ` +
        'ccteams-owned file(s) in .claude/.ccteams-manifest.json.';
    }
  }

  const exitCode = dryRun && pending + updates > 0 ? 1 : 0;

  return {
    success: true,
    dryRun,
    applied: true,
    steps,
    pending,
    updates,
    message: formatMigrateReport({ dryRun, applied: true, steps }) + baselineMessageSuffix,
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

  let addedTotal = 0;
  let updatedTotal = 0;
  let hasNotices = false;
  for (const step of steps) {
    const updatedList = step.updated ?? []; // absent on steps that predate `updated` (none do — kept optional defensively)
    const rows = [
      ...step.added.map((p) => ({ marker: '+', path: p, kind: 'added' })),
      ...updatedList.map((p) => ({ marker: '~', path: p, kind: 'updated' })),
      ...step.kept.map((p) => ({ marker: '=', path: p, kind: 'kept' })),
    ];
    // Computed before the "skip an empty step's heading" check below on
    // purpose, defensively: a step with a non-empty `added`/`updated` always
    // has `rows.length > 0` too, so today no step both contributes to
    // addedTotal/updatedTotal AND gets skipped — but keeping the order this
    // way means a future step shape can never silently drop its contribution
    // to the summary line's wording just because it also happens to skip its
    // heading. This is UNRELATED to exitCode: migrate() computes its own
    // pending/updates from an independent `steps.reduce(...)` over the same
    // added/updated arrays (see migrate()'s own exitCode rule) — these two
    // totals are local to formatting and never read outside this function.
    addedTotal += step.added.length;
    updatedTotal += updatedList.length;
    // Skip the step entirely (no heading, no blank line) when it has nothing
    // to report — e.g. teamLessonsHookStep once both SessionStart and
    // SubagentStart are registered (see DESIGN-E in migrate.js). A step with
    // a non-empty `updated` must NOT be skipped here — `rows` already
    // includes `updated`, so this condition covers it without a separate
    // check; the historical bug this guards against is checking only
    // `added`/`kept` and dropping an `updated`-only step's heading.
    if (rows.length === 0 && step.notices.length === 0) continue;
    lines.push(`  ${step.title}`);
    const width = rows.length > 0 ? Math.max(...rows.map((r) => r.path.length)) : 0;
    for (const row of rows) {
      const suffix =
        row.kind === 'added'
          ? dryRun
            ? '(would be added)'
            : '(added)'
          : row.kind === 'updated'
            ? dryRun
              ? '(would be updated)'
              : '(updated)'
            : '(kept as-is)';
      lines.push(`    ${row.marker} ${padLabel(row.path, width)}   ${suffix}`);
    }
    for (const notice of step.notices) {
      lines.push(`    ${notice}`);
      hasNotices = true;
    }
    lines.push('');
  }

  if (addedTotal === 0 && updatedTotal === 0) {
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
    const parts = [];
    if (addedTotal > 0) parts.push(`added ${addedTotal} file${addedTotal !== 1 ? 's' : ''}`);
    if (updatedTotal > 0) parts.push(`updated ${updatedTotal} file${updatedTotal !== 1 ? 's' : ''}`);
    const sentence = parts.join(', ');
    lines.push(`${sentence.charAt(0).toUpperCase()}${sentence.slice(1)}.`);
  }

  return lines.join('\n');
}
