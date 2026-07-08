/**
 * unuse.js — implements `ccteams unuse <team>`.
 *
 * Removes one applied team from the current project without disturbing any
 * other applied team. Files are removed by refcount: a file is only deleted
 * from disk if no OTHER applied team's placedFiles also claims it (this is how
 * shared files like the working-method skill survive removing one team while
 * another that also ships it remains applied).
 *
 * See use.js for the shared constants/helpers this module reuses (manifest
 * shape, env-key ownership rule, empty-dir pruning, composite active-team.md
 * generation).
 */

import fs from 'fs';
import path from 'path';
import { readManifest, writeManifest, deleteManifest, resolvePlacedFiles } from './manifest.js';
import {
  AGENT_TEAMS_ENV,
  ACTIVE_TEAM_IMPORT,
  readSettings,
  writeSettings,
  pruneEmptyDirs,
  generateActiveTeamMd,
  unionPlacedFiles,
} from './use.js';

/**
 * Remove a named team from the current project. projectRoot defaults to
 * process.cwd().
 *
 * Returns an object: { success, message }
 */
export function unuseTeam(teamName, projectRoot = process.cwd()) {
  // ── 0. Resolve the manifest and confirm the team is applied ──────────────
  const manifest = readManifest(projectRoot);
  const appliedNames = manifest ? Object.keys(manifest.teams) : [];

  if (!manifest || !Object.prototype.hasOwnProperty.call(manifest.teams, teamName)) {
    return {
      success: false,
      message:
        `ccteams: team "${teamName}" is not applied. ` +
        `Currently applied: ${appliedNames.length > 0 ? appliedNames.join(', ') : 'none'}.`,
    };
  }

  const dotClaudeDir = path.join(projectRoot, '.claude');
  const agentsDir = path.join(dotClaudeDir, 'agents');
  const skillsDestRoot = path.join(dotClaudeDir, 'skills');
  const ccteamsDir = path.join(dotClaudeDir, 'ccteams');

  const teamsMap = { ...manifest.teams };
  const ownFiles = resolvePlacedFiles(teamsMap[teamName].placedFiles, projectRoot);
  const otherTeamsFiles = unionPlacedFiles(teamsMap, projectRoot, teamName);

  // ── 1. Delete this team's placed files, refcounted against other teams ───
  let removedCount = 0;
  for (const f of ownFiles) {
    if (otherTeamsFiles.has(f)) continue; // still claimed by another applied team
    if (fs.existsSync(f)) {
      fs.rmSync(f, { force: true });
      removedCount++;
    }
  }

  // Prune any now-empty directories left behind — never removes non-empty dirs.
  pruneEmptyDirs(skillsDestRoot);
  pruneEmptyDirs(ccteamsDir);
  pruneEmptyDirs(agentsDir);

  // ── 2. Remove the team from the manifest ──────────────────────────────────
  delete teamsMap[teamName];
  const remainingNames = Object.keys(teamsMap);

  // ── 3. Recompute the agent-teams env flag ─────────────────────────────────
  // OWNERSHIP RULE: only remove the key if ccteams itself set it AND no
  // remaining team still needs it. A user's pre-existing hand-set flag, or a
  // key ccteams never wrote, is never touched.
  const settings = readSettings(dotClaudeDir);
  const anyRemainingNeedsFlag = remainingNames.some((n) => teamsMap[n].agentTeams === true);
  let agentTeamsFlagSet = manifest.agentTeamsFlagSet === true;
  let envKeyRemoved = false;

  if (agentTeamsFlagSet && !anyRemainingNeedsFlag) {
    if (settings.env && typeof settings.env === 'object') {
      delete settings.env[AGENT_TEAMS_ENV];
      // Drop the env object entirely if now empty to keep settings tidy.
      if (Object.keys(settings.env).length === 0) {
        delete settings.env;
      }
      writeSettings(dotClaudeDir, settings);
    }
    agentTeamsFlagSet = false;
    envKeyRemoved = true;
  }

  // ── 4/5. Regenerate composite file, or tear down the last team ───────────
  const claudeMdPath = path.join(projectRoot, 'CLAUDE.md');
  const activeTeamMdPath = path.join(dotClaudeDir, 'active-team.md');

  if (remainingNames.length > 0) {
    fs.writeFileSync(activeTeamMdPath, generateActiveTeamMd(remainingNames), 'utf8');
    writeManifest(projectRoot, { teams: teamsMap, agentTeamsFlagSet });
  } else {
    // No teams remain: delete active-team.md, remove the import line from
    // CLAUDE.md, delete the manifest, prune .claude/ccteams/. team-lessons and
    // any settings.json keys ccteams didn't write are NEVER touched.
    if (fs.existsSync(activeTeamMdPath)) {
      fs.rmSync(activeTeamMdPath, { force: true });
    }
    if (fs.existsSync(claudeMdPath)) {
      const content = fs.readFileSync(claudeMdPath, 'utf8');
      const contentLines = content.split('\n');
      const idx = contentLines.findIndex((l) => l.trim() === ACTIVE_TEAM_IMPORT);
      if (idx !== -1) {
        contentLines.splice(idx, 1);
        fs.writeFileSync(claudeMdPath, contentLines.join('\n'), 'utf8');
      }
    }
    deleteManifest(projectRoot);
    pruneEmptyDirs(ccteamsDir);
  }

  // ── 6. Return success with restart instruction ────────────────────────────
  const lines = [
    `Team "${teamName}" removed.`,
    '',
    `  Files removed  : ${removedCount}`,
    `  Remaining teams: ${
      remainingNames.length > 0
        ? remainingNames.map((n, i) => (i === 0 ? `${n} (primary)` : n)).join(', ')
        : 'none'
    }`,
  ];

  if (envKeyRemoved) {
    lines.push(
      `  Agent teams    : DISABLED (no remaining applied team needs it; ${AGENT_TEAMS_ENV} removed from .claude/settings.json)`,
    );
  }

  lines.push(
    '',
    'ACTION REQUIRED: agents load at session start only.',
    'Restart your Claude Code session to apply this change:',
    '  /exit',
    '  claude',
  );

  return { success: true, message: lines.join('\n') };
}
