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
import { findTeam, listTeams, resolveSkillDir } from './teams.js';
import { readManifest, writeManifest, resolvePlacedFiles } from './manifest.js';

// Single source of truth for the experimental env var name.
// If Claude Code ever renames it, change here only.
export const AGENT_TEAMS_ENV = 'CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS';

// The import line we append/check in the project's root CLAUDE.md. It always
// points at the generated composite file, regardless of how many teams are applied.
export const ACTIVE_TEAM_IMPORT = '@.claude/active-team.md';

// team-lessons is the USER-OWNED home for learning-loop entries (lessons the
// team accumulates in this project). CONTRACT: ccteams scaffolds it once if
// absent and never tracks, overwrites, or deletes it — it must survive team
// switches, re-applies, and package updates. The name is reserved: teams may
// not ship a skill called "team-lessons".
export const TEAM_LESSONS_SKILL_NAME = 'team-lessons';
const TEAM_LESSONS_TEMPLATE = `---
name: team-lessons
description: Project-specific lessons learned — failure-catalog entries accumulated via the learning loop. Owned by this project; ccteams never overwrites this file.
---

# Team Lessons (this project)

Durable, project-specific additions to the active team's playbook. ccteams
scaffolded this file once and will never touch it again — it survives team
switches and package updates.

Entries arrive via the learning loop: when a mistake surfaces that the
playbook did not predict, the orchestrator proposes an entry here in the
standard format. Keep it lean — before adding, check whether an existing
entry (here or in the playbook) already covers the case and sharpen that
instead. If a lesson is universal to the stack rather than specific to this
project, contribute it upstream to the team's playbook in the ccteams repo.

## Failure catalog — symptom → wrong instinct → correct move

(none yet)
`;

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

  // ── 2.5. Resolve incoming agent file list ────────────────────────────────
  const sourceAgentsDir = path.join(team.teamDir, 'agents');
  const agentFiles = fs.existsSync(sourceAgentsDir)
    ? fs.readdirSync(sourceAgentsDir).filter((f) => f.endsWith('.md'))
    : [];

  // ── 2.6. Resolve effective skill list ────────────────────────────────────
  // working-method is always first; team.skills may add more (deduped).
  // The team-lessons name is reserved for the user-owned lessons file — a team
  // shipping a skill under that name would break the never-overwrite contract,
  // so it is skipped with a warning instead of placed.
  const skillWarnings = [];
  const rawSkillNames = ['working-method', ...team.skills.filter((s) => s !== 'working-method')]
    .filter((skillName) => {
      if (skillName === TEAM_LESSONS_SKILL_NAME) {
        skillWarnings.push(
          `  Warning: skill name "${TEAM_LESSONS_SKILL_NAME}" is reserved for the user-owned lessons file — skipped.`,
        );
        return false;
      }
      return true;
    });

  // Map each skill name to { skillName, srcDir } — filter out unresolvable ones
  // but collect a warning for each so we can surface it in the return message.
  const resolvedSkills = rawSkillNames.flatMap((skillName) => {
    const srcDir = resolveSkillDir(team, skillName);
    if (!srcDir) {
      skillWarnings.push(`  Warning: skill "${skillName}" not found — skipped.`);
      return [];
    }
    return [{ skillName, srcDir }];
  });

  // Build the full list of (srcFile → destFile) pairs for the incoming skills.
  // Flat skill dirs are the norm; recurse anyway in case a skill has subdirs.
  const incomingSkillFilePairs = [];
  for (const { skillName, srcDir } of resolvedSkills) {
    const destDir = path.join(skillsDestRoot, skillName);
    // Walk recursively to support potential nested files inside a skill dir.
    const walk = (dir, relBase) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const srcPath = path.join(dir, entry.name);
        const relPath = relBase ? path.join(relBase, entry.name) : entry.name;
        if (entry.isDirectory()) {
          walk(srcPath, relPath);
        } else {
          incomingSkillFilePairs.push({ src: srcPath, dest: path.join(destDir, relPath) });
        }
      }
    };
    walk(srcDir, '');
  }

  // Incoming team-specific orchestration file.
  const orchSrc = path.join(team.teamDir, 'orchestration.md');
  const orchDest = path.join(ccteamsDir, `${teamName}.md`);

  // ── 2.8. COLLISION GUARD — validate before any mutation ──────────────────
  // A destination file is protected (abort, no mutation) if it exists on disk
  // AND is not in the union of every applied team's resolved placedFiles.
  const collisions = agentFiles.filter((agentFile) => {
    const dest = path.join(agentsDir, agentFile);
    return fs.existsSync(dest) && !allOwnedFiles.has(dest);
  });

  const skillCollisions = incomingSkillFilePairs.filter(
    ({ dest }) => fs.existsSync(dest) && !allOwnedFiles.has(dest),
  );

  const orchCollision =
    fs.existsSync(orchSrc) && fs.existsSync(orchDest) && !allOwnedFiles.has(orchDest);

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

  for (const agentFile of agentFiles) {
    const src = path.join(sourceAgentsDir, agentFile);
    const dest = path.join(agentsDir, agentFile);
    fs.copyFileSync(src, dest);
    placedFiles.push(dest);
  }

  // ── 4.5. Copy skill directories into .claude/skills/<skillName>/ ─────────
  const placedSkillNames = [];

  for (const { src, dest } of incomingSkillFilePairs) {
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(src, dest);
    placedFiles.push(dest);
  }

  // Record skill names that were actually placed for the success message.
  for (const { skillName } of resolvedSkills) {
    placedSkillNames.push(skillName);
  }

  // ── 4.8. Scaffold the user-owned team-lessons skill (once, never again) ──
  // Deliberately NOT pushed to placedFiles: the manifest must never own this
  // file, so switches, re-applies, and unuse can never delete or overwrite it.
  const lessonsPath = path.join(skillsDestRoot, TEAM_LESSONS_SKILL_NAME, 'SKILL.md');
  let lessonsCreated = false;
  if (!fs.existsSync(lessonsPath)) {
    fs.mkdirSync(path.dirname(lessonsPath), { recursive: true });
    fs.writeFileSync(lessonsPath, TEAM_LESSONS_TEMPLATE, 'utf8');
    lessonsCreated = true;
  }

  // ── 5. Place orchestration.md as .claude/ccteams/<team-name>.md ─────────
  if (fs.existsSync(orchSrc)) {
    fs.copyFileSync(orchSrc, orchDest);
    placedFiles.push(orchDest);
  }

  // ── 5.5. Update the manifest's team entry (in place if re-applying) ──────
  teamsMap[teamName] = {
    appliedAt: new Date().toISOString(),
    placedFiles,
    agentTeams: enableAgentTeams,
  };
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
    `  Team lessons   : .claude/skills/team-lessons/SKILL.md (${lessonsCreated ? 'created' : 'preserved'} — user-owned, never overwritten)`,
    `  Orchestration  : .claude/ccteams/${teamName}.md`,
    `  Active teams   : .claude/active-team.md (regenerated)`,
    `  CLAUDE.md      : ${claudeMdPath}`,
  ];

  // Surface any skill-resolution warnings inline in the success message.
  if (skillWarnings.length > 0) {
    lines.push('', ...skillWarnings);
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
