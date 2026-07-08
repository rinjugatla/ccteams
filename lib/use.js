/**
 * use.js — implements `ccteams use <team>`.
 *
 * All paths under the user's project are resolved from process.cwd() so that
 * running `ccteams use frontend` from any directory affects that directory's .claude/.
 *
 * CLAUDE.md target decision: we always target ./CLAUDE.md (cwd root), NOT
 * .claude/CLAUDE.md. Rationale: the @import directive in CLAUDE.md is
 * project-level configuration that most users keep at the repo root; the
 * .claude/ subdirectory CLAUDE.md is for project-scoped agent configuration
 * that ccteams should not own. We create ./CLAUDE.md if it does not exist.
 *
 * settings.json target: <cwd>/.claude/settings.json (project-level settings).
 * ccteams only manages a single env key defined by AGENT_TEAMS_ENV. It JSON-merges
 * into the existing file, preserving all unrelated keys.
 *
 * Agent placement: agents are copied directly into .claude/agents/<file>.md.
 * Safety is provided by two mechanisms:
 *   1. The manifest (placedFiles array) tracks every file ccteams wrote, so on a
 *      team switch we delete ONLY those tracked files and never touch others.
 *   2. The collision guard (see step 2.8) aborts before any mutation if an
 *      incoming agent filename would overwrite a hand-written file that ccteams
 *      did not place itself.
 */

import fs from 'fs';
import path from 'path';
import { findTeam, listTeams, resolveSkillDir } from './teams.js';
import { readManifest, writeManifest, resolvePlacedFiles } from './manifest.js';

// Single source of truth for the experimental env var name.
// If Claude Code ever renames it, change here only.
const AGENT_TEAMS_ENV = 'CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS';

// The import line we append/check in the project's root CLAUDE.md.
const ACTIVE_TEAM_IMPORT = '@.claude/active-team.md';

// team-lessons is the USER-OWNED home for learning-loop entries (lessons the
// team accumulates in this project). CONTRACT: ccteams scaffolds it once if
// absent and never tracks, overwrites, or deletes it — it must survive team
// switches, re-applies, and package updates. The name is reserved: teams may
// not ship a skill called "team-lessons".
const TEAM_LESSONS_SKILL_NAME = 'team-lessons';
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
function readSettings(dotClaudeDir) {
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
function writeSettings(dotClaudeDir, data) {
  const p = path.join(dotClaudeDir, 'settings.json');
  fs.writeFileSync(p, JSON.stringify(data, null, 2) + '\n', 'utf8');
}

/**
 * Apply a named team to the current project.
 * projectRoot defaults to process.cwd().
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

  // ── 1. Ensure .claude/agents/ and .claude/skills/ exist ─────────────────
  const dotClaudeDir = path.join(projectRoot, '.claude');
  const agentsDir = path.join(dotClaudeDir, 'agents');
  const skillsDestRoot = path.join(dotClaudeDir, 'skills');
  // A plain file squatting on any of these paths would make mkdirSync throw a
  // raw EEXIST/ENOTDIR — turn that into a clean, actionable error instead.
  for (const p of [dotClaudeDir, agentsDir, skillsDestRoot]) {
    if (fs.existsSync(p) && !fs.statSync(p).isDirectory()) {
      return {
        success: false,
        message: `ccteams: "${path.relative(projectRoot, p)}" exists and is not a directory. Remove it and retry.`,
      };
    }
  }
  fs.mkdirSync(agentsDir, { recursive: true });
  fs.mkdirSync(skillsDestRoot, { recursive: true });

  // ── 2. Read previous manifest (needed for guard and cleanup) ─────────────
  const manifest = readManifest(projectRoot);

  // Resolve what ccteams placed last time to absolute paths under THIS
  // projectRoot (handles v1 manifests written under a different root — see
  // resolvePlacedFiles). Files in this set are safe to overwrite; files NOT
  // in this set are hand-written.
  const prevPlacedFiles = resolvePlacedFiles(manifest, projectRoot);
  const prevPlacedSet = new Set(prevPlacedFiles);

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

  // ── 2.8. COLLISION GUARD — validate before any mutation ──────────────────
  // We compute the "protected" set NOW, before deleting anything, so the check
  // is based on the current disk state. A file is protected if it exists in
  // .claude/agents/ AND was NOT placed by ccteams last time (not in prevPlacedSet).
  // This is evaluated before any deletion so we never half-apply on failure.
  const collisions = agentFiles.filter((agentFile) => {
    const dest = path.join(agentsDir, agentFile);
    return fs.existsSync(dest) && !prevPlacedSet.has(dest);
  });

  // Extend collision guard to incoming skill dest files with the same logic.
  const skillCollisions = incomingSkillFilePairs.filter(
    ({ dest }) => fs.existsSync(dest) && !prevPlacedSet.has(dest),
  );

  if (collisions.length > 0 || skillCollisions.length > 0) {
    const agentList = collisions.map((f) => `.claude/agents/${f}`);
    const skillList = skillCollisions.map(({ dest }) =>
      path.relative(projectRoot, dest),
    );
    const allConflicts = [...agentList, ...skillList].join(', ');
    return {
      success: false,
      message:
        `ccteams: refusing to overwrite hand-written file(s): ${allConflicts}.\n` +
        `Rename or remove them, then retry.`,
    };
  }

  // ── 3. Remove previously ccteams-placed files ────────────────────────────
  // Deletion is driven entirely by the manifest's placedFiles paths — those
  // now point directly into .claude/agents/ or .claude/skills/, no subdir
  // logic needed for file removal itself.
  for (const f of prevPlacedFiles) {
    if (fs.existsSync(f)) {
      fs.rmSync(f, { force: true });
    }
  }

  // After file removal, prune any now-empty directories under .claude/skills/.
  // We only remove empty dirs — non-empty dirs (hand-written content) are left alone.
  if (fs.existsSync(skillsDestRoot)) {
    for (const entry of fs.readdirSync(skillsDestRoot, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const skillSubdir = path.join(skillsDestRoot, entry.name);
      // Recursive empty-dir pruner: removes only dirs that are (or become) empty.
      const pruneEmpty = (dir) => {
        for (const child of fs.readdirSync(dir, { withFileTypes: true })) {
          if (child.isDirectory()) pruneEmpty(path.join(dir, child.name));
        }
        if (fs.readdirSync(dir).length === 0) fs.rmdirSync(dir);
      };
      pruneEmpty(skillSubdir);
    }
    // Remove .claude/skills/ itself if now empty.
    if (fs.readdirSync(skillsDestRoot).length === 0) fs.rmdirSync(skillsDestRoot);
  }

  // ── 3.5. Manage the experimental agent-teams env key in settings.json ────
  // OWNERSHIP RULE: ccteams only removes the key on switch if its OWN previous
  // manifest says it set it — a user's pre-existing hand-set flag is never
  // touched. We never remove what we didn't write.
  const settings = readSettings(dotClaudeDir);
  let agentTeamsFlagSet = false;

  // enableAgentTeams: true if the team requires it OR the user opted in with --agent-teams.
  const enableAgentTeams = team.requiresAgentTeams || agentTeams;

  if (enableAgentTeams) {
    // JSON-merge: set only our key inside env, preserve everything else.
    if (!settings.env || typeof settings.env !== 'object') {
      settings.env = {};
    }
    settings.env[AGENT_TEAMS_ENV] = '1';
    writeSettings(dotClaudeDir, settings);
    agentTeamsFlagSet = true;
  } else if (manifest?.agentTeamsFlagSet === true) {
    // Previous team set the flag and this one doesn't need it — clean up.
    if (settings.env && typeof settings.env === 'object') {
      delete settings.env[AGENT_TEAMS_ENV];
      // Drop the env object entirely if now empty to keep settings tidy.
      if (Object.keys(settings.env).length === 0) {
        delete settings.env;
      }
      writeSettings(dotClaudeDir, settings);
    }
  }

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
  // file, so switches and re-applies can never delete or overwrite it.
  const lessonsPath = path.join(skillsDestRoot, TEAM_LESSONS_SKILL_NAME, 'SKILL.md');
  let lessonsCreated = false;
  if (!fs.existsSync(lessonsPath)) {
    fs.mkdirSync(path.dirname(lessonsPath), { recursive: true });
    fs.writeFileSync(lessonsPath, TEAM_LESSONS_TEMPLATE, 'utf8');
    lessonsCreated = true;
  }

  // ── 5. Place orchestration.md as .claude/active-team.md ─────────────────
  const orchSrc = path.join(team.teamDir, 'orchestration.md');
  const orchDest = path.join(dotClaudeDir, 'active-team.md');
  if (fs.existsSync(orchSrc)) {
    fs.copyFileSync(orchSrc, orchDest);
    placedFiles.push(orchDest);
  }

  // ── 6. Append @import to ./CLAUDE.md if not already present ─────────────
  // We target the repo-root CLAUDE.md (cwd/CLAUDE.md), not .claude/CLAUDE.md.
  // See module-level comment for rationale.
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
  writeManifest(projectRoot, { appliedTeam: teamName, placedFiles, agentTeamsFlagSet });

  // ── 8. Return success with restart instruction ───────────────────────────
  const lines = [
    `Team "${teamName}" applied successfully.`,
    '',
    `  Agents placed : .claude/agents/ (${agentFiles.length} file${agentFiles.length !== 1 ? 's' : ''})`,
    `  Skills placed : .claude/skills/ (${placedSkillNames.length} skill${placedSkillNames.length !== 1 ? 's' : ''}: ${placedSkillNames.join(', ')})`,
    `  Team lessons  : .claude/skills/team-lessons/SKILL.md (${lessonsCreated ? 'created' : 'preserved'} — user-owned, never overwritten)`,
    `  Orchestration : .claude/active-team.md`,
    `  CLAUDE.md     : ${claudeMdPath}`,
  ];

  // Surface any skill-resolution warnings inline in the success message.
  if (skillWarnings.length > 0) {
    lines.push('', ...skillWarnings);
  }

  if (agentTeamsFlagSet) {
    const reason = team.requiresAgentTeams
      ? `required by the ${teamName} team`
      : 'you opted in with --agent-teams';
    lines.push(
      '',
      `  Agent teams   : ENABLED (${reason}; ${AGENT_TEAMS_ENV}=1 written to .claude/settings.json)`,
    );
  }

  lines.push(
    '',
    'ACTION REQUIRED: agents load at session start only.',
    'Restart your Claude Code session to activate the team:',
    '  /exit',
    '  claude',
  );

  return { success: true, message: lines.join('\n') };
}
