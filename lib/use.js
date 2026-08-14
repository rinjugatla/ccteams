/**
 * use.js — implements `ccteams use <team>` (additive apply) and shared helpers
 * used by `ccteams unuse <team>` (see unuse.js).
 *
 * All paths under the user's project are resolved from process.cwd() so that
 * running `ccteams use frontend` from any directory affects that directory's .claude/.
 *
 * Multi-team model: `use` is ADDITIVE. Multiple teams may be applied to the same
 * project at once; the manifest's `teams` key order records application order,
 * and the FIRST-applied team is the primary team (see manifest.js). Re-applying
 * an already-applied team updates its entry in place — it never loses primary
 * status and never touches other teams' files.
 *
 * CLAUDE.md target decision: we always target ./CLAUDE.md (cwd root), NOT
 * .claude/CLAUDE.md. Rationale: the @import directive in CLAUDE.md is
 * project-level configuration that most users keep at the repo root; the
 * .claude/ subdirectory CLAUDE.md is for project-scoped agent configuration
 * that ccteams should not own. We create ./CLAUDE.md if it does not exist.
 * CLAUDE.md always imports the single generated composite file
 * .claude/active-team.md — never a per-team file — so the import line itself
 * never changes across `use`/`unuse` calls.
 *
 * settings.json target: <cwd>/.claude/settings.json (project-level settings).
 * ccteams only manages a single env key defined by AGENT_TEAMS_ENV. It JSON-merges
 * into the existing file, preserving all unrelated keys.
 *
 * Agent placement: agents are copied directly into .claude/agents/<file>.md.
 * Each team's orchestration.md is copied to .claude/ccteams/<team-name>.md (NOT
 * .claude/active-team.md — that file is a generated composite, see
 * generateActiveTeamMd() — and NOT .claude/teams/, which risks colliding with
 * Claude Code's own experimental agent-teams feature).
 *
 * Safety is provided by two mechanisms:
 *   1. The manifest (per-team placedFiles arrays) tracks every file ccteams
 *      wrote for each applied team, so files can be removed by refcount: a
 *      file is only deleted when no OTHER applied team also claims it.
 *   2. The collision guard aborts before any mutation if an incoming file
 *      would overwrite a hand-written file — "hand-written" means it exists on
 *      disk but is not in the union of every currently-applied team's
 *      resolved placedFiles. Files owned by another ccteams team are
 *      ccteams-owned and safe to overwrite (this is how shared files like the
 *      working-method skill coexist across teams).
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { findTeam, listTeams, TEAM_LESSONS_SKILL_NAME } from './teams.js';
import { readManifest, writeManifest, resolvePlacedFiles, resolveFileHashes } from './manifest.js';
import { resolveTeamPlacement } from './placement.js';
import { hashFileSync } from './hash.js';
// The index markers and the generated note are defined by the generator we ship,
// so we import them from it instead of re-declaring the literals here (they used
// to be duplicated, which is how a marker rename would have silently broken
// detection). We deliberately import the PACKAGE's copy under scaffold/ rather
// than reading the project's own .claude/skills/team-lessons/scripts/gen-lessons.mjs:
// the project copy may be older than this package, and using it as the yardstick
// would make the detection circular (an outdated copy would declare its own
// outdated layout current). Importing this module has no side effects — it only
// calls main() when it is the process entry point (see its bottom guard).
import {
  CATALOG_START,
  CATALOG_END,
  GENERATED_NOTE,
} from '../scaffold/team-lessons/scripts/gen-lessons.mjs';

// Single source of truth for the experimental env var name.
// If Claude Code ever renames it, change here only.
export const AGENT_TEAMS_ENV = 'CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS';

// The import line we append/check in the project's root CLAUDE.md. It always
// points at the generated composite file, regardless of how many teams are applied.
export const ACTIVE_TEAM_IMPORT = '@.claude/active-team.md';

// team-lessons is the USER-OWNED home for learning-loop entries (lessons the
// team accumulates in this project). CONTRACT: ccteams scaffolds a file only if
// it is absent and never tracks, overwrites, or deletes anything under the
// skill — it must survive team switches, re-applies, and package updates.
// TEAM_LESSONS_SKILL_NAME itself now lives in teams.js (the single source of
// truth placement.js and this module both import from — see that module's
// comment); re-exported here so existing external importers (migrate.js)
// keep working unchanged.
export { TEAM_LESSONS_SKILL_NAME };

// The skill is scaffolded from a real directory in this package rather than
// from an inline string, because it is no longer one file: the catalog is split
// into one lesson per file under lessons/, with SKILL.md holding a generated
// index and scripts/gen-lessons.mjs generating it. Keeping the template on disk
// means the shipped generator is the same file we can test in this repo.
const SCAFFOLD_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'scaffold');
export const TEAM_LESSONS_SCAFFOLD_DIR = path.join(SCAFFOLD_DIR, TEAM_LESSONS_SKILL_NAME);

/**
 * Classify a pre-existing SKILL.md against the layout the shipped generator
 * produces. Two distinct legacy states exist, and they need different advice:
 *
 *   (a) needsMigration — the marker pair is missing (or the end marker comes
 *       first). buildSkill() THROWS on exactly this condition, so re-running the
 *       generator cannot fix it; the user has to add the markers first.
 *   (b) hasLegacyIndexLayout — the markers are present and ordered, but the
 *       generated note still sits BETWEEN them (the pre-0.4 layout). Here a
 *       plain re-run of the generator is the whole fix: buildSkill() replaces
 *       the entire inter-marker region and re-emits the note above the start
 *       marker.
 *
 * The two are mutually exclusive by construction: (b) is only evaluated once
 * the markers are known to be present and ordered.
 *
 * (b) is detected by looking for the GENERATED_NOTE literal itself rather than
 * "any HTML comment in the region" (the generic approach scripts/lessons-index.mjs
 * takes when it skips comment lines while PARSING). Detection here drives a
 * user-facing "your file is out of date" claim, so a false positive on a comment
 * the user wrote by hand inside the catalog region is worse than missing an
 * exotic hand-mangled variant.
 *
 * Marker/note literals contain no newline, so a CRLF file needs no normalization
 * before these indexOf/includes calls.
 *
 * @param {string} content full text of an existing SKILL.md
 * @returns {{ needsMigration: boolean, hasLegacyIndexLayout: boolean }}
 */
function classifySkillLayout(content) {
  const startIndex = content.indexOf(CATALOG_START);
  const endIndex = content.indexOf(CATALOG_END);
  // Equivalent to the predicate buildSkill() throws on. It writes that test as
  // `endIndex < startIndex`, which also admits equality; two different literals
  // can never start at the same index, so the two forms agree on every input.
  const hasMarkers = startIndex !== -1 && endIndex !== -1 && endIndex > startIndex;
  if (!hasMarkers) return { needsMigration: true, hasLegacyIndexLayout: false };

  const between = content.slice(startIndex + CATALOG_START.length, endIndex);
  return { needsMigration: false, hasLegacyIndexLayout: between.includes(GENERATED_NOTE) };
}

/**
 * Scaffold the user-owned team-lessons skill into `destDir`, file by file.
 *
 * Every file in the template is written only if its destination does not exist,
 * so a project that already has a hand-maintained SKILL.md keeps it verbatim
 * while still gaining the pieces it lacks (lessons/, scripts/, AUTHORING.md).
 * Nothing here is recorded in the manifest — the skill must be undeletable by
 * `unuse` and unaffected by re-applies.
 *
 * @param {string} destDir absolute path to .claude/skills/team-lessons
 * @param {string} [scaffoldDir] template source (overridable for tests)
 * @param {{ dryRun?: boolean }} [opts] dryRun: true — compute the same result
 *   without writing anything (no mkdirSync/copyFileSync calls). Used by
 *   `ccteams migrate --dry-run` (see migrate.js) to report what WOULD be added
 *   without touching disk. The walk and existsSync-based decision are shared
 *   with the real-write path on purpose — only the write calls are gated — so
 *   dry-run and a real run always compute the IDENTICAL judgment of which
 *   files are missing. That is a guarantee about the JUDGMENT only: a real
 *   run's write calls can still fail on disk after the judgment is made (e.g.
 *   EACCES on a read-only .claude/) — that is a separate failure mode dry-run
 *   cannot preview, since it never attempts the write at all.
 * @returns {{ created: string[], preserved: string[], needsMigration: boolean,
 *   hasLegacyIndexLayout: boolean }}
 *   paths relative to destDir, plus two mutually exclusive findings about a
 *   PRE-EXISTING SKILL.md (both false when SKILL.md was just created, or when it
 *   already matches the current layout) — see classifySkillLayout:
 *     needsMigration       — no usable marker pair; the generator would refuse
 *                            to run. Key name kept for backward compatibility.
 *     hasLegacyIndexLayout — markers are fine but the generated note is still
 *                            inside them; re-running the generator fixes it.
 *   Both are detect-only: this function never rewrites SKILL.md.
 *   In dry-run mode, `created` lists files that WOULD be created.
 */
export function scaffoldTeamLessons(destDir, scaffoldDir = TEAM_LESSONS_SCAFFOLD_DIR, opts = {}) {
  const { dryRun = false } = opts;
  const created = [];
  const preserved = [];
  if (!fs.existsSync(scaffoldDir)) {
    return { created, preserved, needsMigration: false, hasLegacyIndexLayout: false };
  }

  const walk = (dir, relBase) => {
    const entries = fs
      .readdirSync(dir, { withFileTypes: true })
      .sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      const srcPath = path.join(dir, entry.name);
      const relPath = relBase ? path.join(relBase, entry.name) : entry.name;
      if (entry.isDirectory()) {
        walk(srcPath, relPath);
        continue;
      }
      const destPath = path.join(destDir, relPath);
      if (fs.existsSync(destPath)) {
        preserved.push(relPath);
        continue;
      }
      if (!dryRun) {
        fs.mkdirSync(path.dirname(destPath), { recursive: true });
        fs.copyFileSync(srcPath, destPath);
      }
      created.push(relPath);
    }
  };
  walk(scaffoldDir, '');

  // Only a SKILL.md we did NOT write can be in a legacy layout — a file we just
  // created is a copy of the current template by definition. Reading it here (in
  // dry-run mode too) is what keeps both modes reporting the same findings: the
  // file is never written by this function in either mode.
  const skillPath = path.join(destDir, 'SKILL.md');
  const { needsMigration, hasLegacyIndexLayout } = preserved.includes('SKILL.md')
    ? classifySkillLayout(fs.readFileSync(skillPath, 'utf8'))
    : { needsMigration: false, hasLegacyIndexLayout: false };

  return { created, preserved, needsMigration, hasLegacyIndexLayout };
}

/**
 * Read .claude/settings.json, returning {} if absent or unparseable.
 */
export function readSettings(dotClaudeDir) {
  const p = path.join(dotClaudeDir, 'settings.json');
  if (!fs.existsSync(p)) return {};
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {
    // Unparseable — return empty so we don't corrupt it further; write will overwrite.
    return {};
  }
}

/**
 * Write settings back to .claude/settings.json with 2-space indent + trailing newline.
 */
export function writeSettings(dotClaudeDir, data) {
  const p = path.join(dotClaudeDir, 'settings.json');
  fs.writeFileSync(p, JSON.stringify(data, null, 2) + '\n', 'utf8');
}

/**
 * Recursively remove empty directories under (and including) rootDir.
 * Only ever removes directories that are empty — non-empty dirs (hand-written
 * content) are left alone. No-op if rootDir does not exist.
 */
export function pruneEmptyDirs(rootDir) {
  if (!fs.existsSync(rootDir)) return;
  const pruneEmpty = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) pruneEmpty(path.join(dir, entry.name));
    }
    if (fs.readdirSync(dir).length === 0) fs.rmdirSync(dir);
  };
  for (const entry of fs.readdirSync(rootDir, { withFileTypes: true })) {
    if (entry.isDirectory()) pruneEmpty(path.join(rootDir, entry.name));
  }
  if (fs.readdirSync(rootDir).length === 0) fs.rmdirSync(rootDir);
}

/**
 * Build the content of the generated composite .claude/active-team.md file.
 * teamNames must be in application order (first = primary).
 */
export function generateActiveTeamMd(teamNames) {
  const lines = [
    '# Active Teams (ccteams)',
    '',
    '<!-- GENERATED by ccteams — do not edit; regenerated on every `ccteams use` / `ccteams unuse`. -->',
    '',
    `Applied teams (in application order): ${teamNames.join(', ')}`,
    '',
    'The FIRST team listed is the **primary team**: its orchestration rules govern this',
    'project and its lead acts as the single orchestrator. Every other team is a',
    '**support team**: treat its agents as additional specialists available for',
    "delegation, and read its section for how they work. Where a support team's rules",
    "conflict with the primary team's rules (who orchestrates, ship/commit gates), the",
    "primary team's rules win.",
    '',
    ...teamNames.map((name) => `@.claude/ccteams/${name}.md`),
    '',
  ];
  return lines.join('\n');
}

/**
 * Union of every applied team's resolved placedFiles, as a Set of absolute paths.
 * excludeTeam, if given, is skipped (used to compute "files owned by OTHER teams").
 */
export function unionPlacedFiles(teamsMap, projectRoot, excludeTeam = null) {
  const set = new Set();
  for (const [name, entry] of Object.entries(teamsMap)) {
    if (name === excludeTeam) continue;
    for (const f of resolvePlacedFiles(entry.placedFiles, projectRoot)) set.add(f);
  }
  return set;
}

/**
 * Apply a named team to the current project, additively (existing applied
 * teams are unaffected). projectRoot defaults to process.cwd().
 * opts.agentTeams — user explicitly opted in with --agent-teams flag.
 *
 * Returns an object: { success, message }
 */
export function useTeam(teamName, projectRoot = process.cwd(), opts = {}) {
  const { agentTeams = false } = opts;
  // ── 0. Resolve the team ──────────────────────────────────────────────────
  const team = findTeam(teamName);
  if (!team) {
    const available = listTeams().map((t) => t.name).join(', ');
    return {
      success: false,
      message: `Unknown team "${teamName}". Available: ${available || '(none)'}`,
    };
  }

  // ── 1. Ensure .claude/agents/, .claude/skills/, .claude/ccteams/ exist ──
  const dotClaudeDir = path.join(projectRoot, '.claude');
  const agentsDir = path.join(dotClaudeDir, 'agents');
  const skillsDestRoot = path.join(dotClaudeDir, 'skills');
  const ccteamsDir = path.join(dotClaudeDir, 'ccteams');
  // A plain file squatting on any of these paths would make mkdirSync throw a
  // raw EEXIST/ENOTDIR — turn that into a clean, actionable error instead.
  for (const p of [dotClaudeDir, agentsDir, skillsDestRoot, ccteamsDir]) {
    if (fs.existsSync(p) && !fs.statSync(p).isDirectory()) {
      return {
        success: false,
        message: `ccteams: "${path.relative(projectRoot, p)}" exists and is not a directory. Remove it and retry.`,
      };
    }
  }
  fs.mkdirSync(agentsDir, { recursive: true });
  fs.mkdirSync(skillsDestRoot, { recursive: true });
  fs.mkdirSync(ccteamsDir, { recursive: true });

  // ── 2. Read previous manifest (needed for guard, refcount cleanup) ───────
  const manifest = readManifest(projectRoot);
  const teamsMap = manifest?.teams ? { ...manifest.teams } : {};
  const isReapply = Object.prototype.hasOwnProperty.call(teamsMap, teamName);

  // Union of every CURRENTLY applied team's resolved placedFiles (including
  // this team's own previous entry if re-applying) — these are all
  // ccteams-owned and therefore safe to overwrite.
  const allOwnedFiles = unionPlacedFiles(teamsMap, projectRoot);

  // ── 2.5/2.6. Resolve incoming agent/skill/orchestration placements ───────
  // Extracted to placement.js so this src→dest computation has exactly one
  // implementation, shared with the diff-detection index buildOwnedSourceIndex()
  // builds for already-applied teams (Issue #18 phase 2) — see that module's
  // header comment.
  const {
    agentPairs,
    skillPairs: incomingSkillFilePairs,
    orch,
    agentFiles,
    placedSkillNames: resolvedSkillNames,
    warnings: skillWarnings,
  } = resolveTeamPlacement(team, projectRoot);
  const orchDest = orch?.dest ?? path.join(ccteamsDir, `${teamName}.md`);

  // ── 2.8. COLLISION GUARD — validate before any mutation ──────────────────
  // A destination file is protected (abort, no mutation) if it exists on disk
  // AND is not in the union of every applied team's resolved placedFiles.
  const collisions = agentPairs
    .filter(({ dest }) => fs.existsSync(dest) && !allOwnedFiles.has(dest))
    .map(({ dest }) => path.basename(dest));

  const skillCollisions = incomingSkillFilePairs.filter(
    ({ dest }) => fs.existsSync(dest) && !allOwnedFiles.has(dest),
  );

  const orchCollision =
    orch !== null && fs.existsSync(orchDest) && !allOwnedFiles.has(orchDest);

  if (collisions.length > 0 || skillCollisions.length > 0 || orchCollision) {
    const agentList = collisions.map((f) => `.claude/agents/${f}`);
    const skillList = skillCollisions.map(({ dest }) => path.relative(projectRoot, dest));
    const orchList = orchCollision ? [path.relative(projectRoot, orchDest)] : [];
    const allConflicts = [...agentList, ...skillList, ...orchList].join(', ');
    return {
      success: false,
      message:
        `ccteams: refusing to overwrite hand-written file(s): ${allConflicts}.\n` +
        `Rename or remove them, then retry.`,
    };
  }

  // ── 3. Re-apply: remove this team's own previous files, refcounted ───────
  // Never delete a file that is ALSO in another applied team's placedFiles.
  if (isReapply) {
    const otherTeamsFiles = unionPlacedFiles(teamsMap, projectRoot, teamName);
    const ownPrevFiles = resolvePlacedFiles(teamsMap[teamName].placedFiles, projectRoot);
    for (const f of ownPrevFiles) {
      if (otherTeamsFiles.has(f)) continue;
      if (fs.existsSync(f)) fs.rmSync(f, { force: true });
    }
    pruneEmptyDirs(skillsDestRoot);
    pruneEmptyDirs(ccteamsDir);
    pruneEmptyDirs(agentsDir);
    // Directories may have been pruned away entirely — recreate for the copy step below.
    fs.mkdirSync(agentsDir, { recursive: true });
    fs.mkdirSync(skillsDestRoot, { recursive: true });
    fs.mkdirSync(ccteamsDir, { recursive: true });
  }

  // ── 3.5. Manage the experimental agent-teams env key in settings.json ────
  // OWNERSHIP RULE: ccteams only removes the key if its OWN manifest says it
  // set it — a user's pre-existing hand-set flag is never touched.
  const settings = readSettings(dotClaudeDir);

  // This team needs it if it requires it OR the user opted in with --agent-teams.
  const enableAgentTeams = team.requiresAgentTeams || agentTeams;
  // Any OTHER already-applied team that also needs it keeps the key set.
  const otherTeamsNeedFlag = Object.entries(teamsMap).some(
    ([name, entry]) => name !== teamName && entry.agentTeams === true,
  );
  const shouldHaveFlag = enableAgentTeams || otherTeamsNeedFlag;

  if (shouldHaveFlag) {
    if (!settings.env || typeof settings.env !== 'object') {
      settings.env = {};
    }
    if (settings.env[AGENT_TEAMS_ENV] !== '1') {
      settings.env[AGENT_TEAMS_ENV] = '1';
      writeSettings(dotClaudeDir, settings);
    }
  } else if (manifest?.agentTeamsFlagSet === true) {
    // ccteams previously set the flag and no applied team needs it anymore — clean up.
    if (settings.env && typeof settings.env === 'object') {
      delete settings.env[AGENT_TEAMS_ENV];
      // Drop the env object entirely if now empty to keep settings tidy.
      if (Object.keys(settings.env).length === 0) {
        delete settings.env;
      }
      writeSettings(dotClaudeDir, settings);
    }
  }
  const agentTeamsFlagSet = shouldHaveFlag;

  // ── 4. Copy agents directly into .claude/agents/ ────────────────────────
  const placedFiles = [];
  // Hashed AFTER copyFileSync, keyed by absolute dest path — the disk content
  // is the baseline that matters (a src-based hash would lie about what
  // actually landed if the copy were ever to transform bytes). writeManifest()
  // normalizes these keys to project-relative paths, same as placedFiles.
  const fileHashes = {};

  for (const { src, dest } of agentPairs) {
    fs.copyFileSync(src, dest);
    placedFiles.push(dest);
    fileHashes[dest] = hashFileSync(dest);
  }

  // ── 4.5. Copy skill directories into .claude/skills/<skillName>/ ─────────
  const placedSkillNames = resolvedSkillNames;

  for (const { src, dest } of incomingSkillFilePairs) {
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(src, dest);
    placedFiles.push(dest);
    fileHashes[dest] = hashFileSync(dest);
  }

  // ── 4.8. Scaffold the user-owned team-lessons skill (missing files only) ──
  // Deliberately NOT pushed to placedFiles: the manifest must never own these
  // files, so switches, re-applies, and unuse can never delete or overwrite
  // them. Existing files are always preserved, so this is also how a project
  // scaffolded by an older ccteams picks up the generator and lessons/ folder.
  const teamLessonsDir = path.join(skillsDestRoot, TEAM_LESSONS_SKILL_NAME);
  const lessonsScaffold = scaffoldTeamLessons(teamLessonsDir);

  // ── 5. Place orchestration.md as .claude/ccteams/<team-name>.md ─────────
  if (orch !== null) {
    fs.copyFileSync(orch.src, orchDest);
    placedFiles.push(orchDest);
    fileHashes[orchDest] = hashFileSync(orchDest);
  }

  // ── 5.5. Update the manifest's team entry (in place if re-applying) ──────
  teamsMap[teamName] = {
    appliedAt: new Date().toISOString(),
    placedFiles,
    fileHashes,
    agentTeams: enableAgentTeams,
  };

  // ── 5.6. Sync OTHER teams' recorded baseline for any dest we just wrote ──
  // A shared file (e.g. working-method) can be claimed by more than one
  // team's manifest entry, but only THIS team's fileHashes gets rebuilt
  // above — every other claiming team's entry still carries whatever hash
  // it recorded the last time IT wrote that dest, which is now stale (this
  // apply just overwrote the file's bytes). `ccteams migrate`'s
  // ownedFilesStep unions every claiming team's recorded hash into its
  // "known baseline" set, so a stale entry left behind here would still be
  // treated as a legitimate past baseline — letting a user who intentionally
  // rolls a shared file back to that stale content be silently overwritten
  // as "upstream-changed" instead of being asked. Updating every other
  // claiming team's entry to the SAME hash we just recorded keeps all of a
  // shared dest's recorded baselines in agreement with what is actually on
  // disk right now, mirroring migrate.js's own applyBaselineUpdates().
  for (const [otherName, otherEntry] of Object.entries(teamsMap)) {
    if (otherName === teamName) continue;
    const otherDests = new Set(resolvePlacedFiles(otherEntry.placedFiles, projectRoot));
    const otherHashesAbs = resolveFileHashes(otherEntry, projectRoot);
    let changed = false;
    for (const dest of placedFiles) {
      if (!otherDests.has(dest)) continue;
      const newHash = fileHashes[dest];
      if (otherHashesAbs.get(dest) !== newHash) {
        otherHashesAbs.set(dest, newHash);
        changed = true;
      }
    }
    if (changed) {
      teamsMap[otherName] = { ...otherEntry, fileHashes: Object.fromEntries(otherHashesAbs) };
    }
  }

  const appliedOrder = Object.keys(teamsMap);

  // ── 6. Regenerate the composite .claude/active-team.md ───────────────────
  const activeTeamMdPath = path.join(dotClaudeDir, 'active-team.md');
  fs.writeFileSync(activeTeamMdPath, generateActiveTeamMd(appliedOrder), 'utf8');

  // ── 6.5. Append @import to ./CLAUDE.md if not already present ────────────
  // We target the repo-root CLAUDE.md (cwd/CLAUDE.md), not .claude/CLAUDE.md.
  // See module-level comment for rationale. The import line itself never
  // changes — it always points at the generated composite file.
  const claudeMdPath = path.join(projectRoot, 'CLAUDE.md');
  let claudeMdContent = fs.existsSync(claudeMdPath)
    ? fs.readFileSync(claudeMdPath, 'utf8')
    : '';

  // Match on a line boundary so a mid-prose mention doesn't suppress the directive.
  const hasImportLine = claudeMdContent
    .split('\n')
    .some((l) => l.trim() === ACTIVE_TEAM_IMPORT);
  if (!hasImportLine) {
    const separator =
      claudeMdContent.length > 0 && !claudeMdContent.endsWith('\n\n')
        ? claudeMdContent.endsWith('\n')
          ? '\n'
          : '\n\n'
        : '';
    claudeMdContent += separator + ACTIVE_TEAM_IMPORT + '\n';
    fs.writeFileSync(claudeMdPath, claudeMdContent, 'utf8');
  }

  // ── 7. Write manifest ────────────────────────────────────────────────────
  writeManifest(projectRoot, { teams: teamsMap, agentTeamsFlagSet });

  // ── 8. Return success with restart instruction ───────────────────────────
  const lines = [
    `Team "${teamName}" ${isReapply ? 're-applied' : 'applied'} successfully.`,
    '',
    `  Agents placed  : .claude/agents/ (${agentFiles.length} file${agentFiles.length !== 1 ? 's' : ''})`,
    `  Skills placed  : .claude/skills/ (${placedSkillNames.length} skill${placedSkillNames.length !== 1 ? 's' : ''}: ${placedSkillNames.join(', ')})`,
    `  Team lessons   : .claude/skills/${TEAM_LESSONS_SKILL_NAME}/ (${lessonsScaffold.created.length} file${lessonsScaffold.created.length !== 1 ? 's' : ''} created, ${lessonsScaffold.preserved.length} preserved — user-owned, never overwritten)`,
    `  Orchestration  : .claude/ccteams/${teamName}.md`,
    `  Active teams   : .claude/active-team.md (regenerated)`,
    `  CLAUDE.md      : ${claudeMdPath}`,
  ];

  // Surface any skill-resolution warnings inline in the success message.
  if (skillWarnings.length > 0) {
    lines.push('', ...skillWarnings);
  }

  // A SKILL.md scaffolded by an older ccteams keeps its lessons inline and has
  // no index markers, so the generator we just placed would refuse to run on
  // it. We never rewrite a user-owned file — point at the migration steps.
  //
  // SCOPE: only `needsMigration` is surfaced here. `hasLegacyIndexLayout` (the
  // milder finding — the generator runs fine, it just has not been re-run since
  // the note moved) is reported by `ccteams migrate` only, which is the command
  // whose job is telling a project what it is behind on. `use` deliberately
  // stays quiet about it rather than adding a second note to a message that
  // already ends in "ACTION REQUIRED: restart your session". Reporting it here
  // too would be a reasonable follow-up; it is out of scope for the migrate
  // work that introduced the flag, not an oversight.
  if (lessonsScaffold.needsMigration) {
    lines.push(
      '',
      `  Note: .claude/skills/${TEAM_LESSONS_SKILL_NAME}/SKILL.md has no generated-index markers (older layout).`,
      '        It was left untouched — see that skill\'s AUTHORING.md ("Migrating a pre-existing SKILL.md").',
    );
  }

  if (agentTeamsFlagSet) {
    const reason = enableAgentTeams
      ? team.requiresAgentTeams
        ? `required by the ${teamName} team`
        : 'you opted in with --agent-teams'
      : 'required by another applied team';
    lines.push(
      '',
      `  Agent teams    : ENABLED (${reason}; ${AGENT_TEAMS_ENV}=1 written to .claude/settings.json)`,
    );
  }

  lines.push(
    '',
    `Applied teams (in order): ${appliedOrder
      .map((name, i) => (i === 0 ? `${name} (primary)` : name))
      .join(', ')}`,
    '',
    'ACTION REQUIRED: agents load at session start only.',
    'Restart your Claude Code session to activate the change:',
    '  /exit',
    '  claude',
  );

  return { success: true, message: lines.join('\n') };
}
