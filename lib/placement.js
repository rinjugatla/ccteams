/**
 * placement.js — computes "if team T is applied to projectRoot, which source
 * file lands at which destination path" without touching disk.
 *
 * This is the same computation useTeam() (use.js) performs inline while it
 * copies files, extracted so it can be reused by:
 *   - useTeam() itself (via resolveTeamPlacement), so there is exactly one
 *     place that decides src→dest mapping and ordering — see use.js's own
 *     "single source of truth" comments for why duplicating this logic is
 *     the kind of drift this repo avoids.
 *   - buildOwnedSourceIndex() below, used by migrate.js's ownedFilesStep
 *     (Issue #18 phase 2) to answer "what package file produced this file on
 *     disk" for every file an ALREADY-applied team owns.
 */

import fs from 'fs';
import path from 'path';
import { findTeam, resolveSkillDir, TEAM_LESSONS_SKILL_NAME } from './teams.js';

/**
 * Compute the full set of (src → dest) placements applying `team` to
 * `projectRoot` would produce, without writing anything.
 *
 * This is a straight extraction of use.js's steps 2.5 (agent file list), 2.6
 * (skill resolution + walk) and 5 (orchestration.md) — the wording of every
 * warning and the "working-method always first" ordering are preserved
 * exactly, because useTeam() now calls this function instead of computing
 * the same thing inline; any drift here would change useTeam()'s observable
 * behavior (messages, files written, manifest contents).
 *
 * @param {{ name: string, teamDir: string, skills: string[] }} team a
 *   descriptor from teams.js's findTeam()/listTeams()
 * @param {string} projectRoot
 * @returns {{
 *   agentPairs: {src: string, dest: string}[],
 *   skillPairs: {src: string, dest: string, skillName: string}[],
 *   orch: {src: string, dest: string} | null,
 *   agentFiles: string[],
 *   placedSkillNames: string[],
 *   warnings: string[],
 * }}
 */
export function resolveTeamPlacement(team, projectRoot) {
  const dotClaudeDir = path.join(projectRoot, '.claude');
  const agentsDir = path.join(dotClaudeDir, 'agents');
  const skillsDestRoot = path.join(dotClaudeDir, 'skills');
  const ccteamsDir = path.join(dotClaudeDir, 'ccteams');

  // ── agents (use.js step 2.5) ─────────────────────────────────────────────
  const sourceAgentsDir = path.join(team.teamDir, 'agents');
  const agentFiles = fs.existsSync(sourceAgentsDir)
    ? fs.readdirSync(sourceAgentsDir).filter((f) => f.endsWith('.md'))
    : [];
  const agentPairs = agentFiles.map((agentFile) => ({
    src: path.join(sourceAgentsDir, agentFile),
    dest: path.join(agentsDir, agentFile),
  }));

  // ── skills (use.js step 2.6) ─────────────────────────────────────────────
  // working-method is always first; team.skills may add more (deduped).
  // The team-lessons name is reserved for the user-owned lessons file — a
  // team shipping a skill under that name is skipped with a warning instead
  // of placed.
  const warnings = [];
  const rawSkillNames = ['working-method', ...team.skills.filter((s) => s !== 'working-method')]
    .filter((skillName) => {
      if (skillName === TEAM_LESSONS_SKILL_NAME) {
        warnings.push(
          `  Warning: skill name "${TEAM_LESSONS_SKILL_NAME}" is reserved for the user-owned lessons file — skipped.`,
        );
        return false;
      }
      return true;
    });

  // Map each skill name to { skillName, srcDir } — filter out unresolvable
  // ones but collect a warning for each so callers can surface it.
  const resolvedSkills = rawSkillNames.flatMap((skillName) => {
    const srcDir = resolveSkillDir(team, skillName);
    if (!srcDir) {
      warnings.push(`  Warning: skill "${skillName}" not found — skipped.`);
      return [];
    }
    return [{ skillName, srcDir }];
  });

  // Build the full list of (srcFile → destFile) pairs for the resolved
  // skills. Flat skill dirs are the norm; recurse anyway in case a skill has
  // subdirs.
  const skillPairs = [];
  for (const { skillName, srcDir } of resolvedSkills) {
    const destDir = path.join(skillsDestRoot, skillName);
    const walk = (dir, relBase) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const srcPath = path.join(dir, entry.name);
        const relPath = relBase ? path.join(relBase, entry.name) : entry.name;
        if (entry.isDirectory()) {
          walk(srcPath, relPath);
        } else {
          skillPairs.push({ src: srcPath, dest: path.join(destDir, relPath), skillName });
        }
      }
    };
    walk(srcDir, '');
  }

  const placedSkillNames = resolvedSkills.map(({ skillName }) => skillName);

  // ── orchestration (use.js step 5) ────────────────────────────────────────
  const orchSrc = path.join(team.teamDir, 'orchestration.md');
  const orchDest = path.join(ccteamsDir, `${team.name}.md`);
  const orch = fs.existsSync(orchSrc) ? { src: orchSrc, dest: orchDest } : null;

  return { agentPairs, skillPairs, orch, agentFiles, placedSkillNames, warnings };
}

/**
 * Build a "destination absolute path → source absolute path" index across
 * every team recorded in `manifest.teams`, using each team's CURRENT
 * placement (i.e. resolved against the package as installed right now, not
 * whatever version placed the file originally).
 *
 * Iteration order is manifest.teams's key order, which IS application order
 * (see manifest.js's schema comment: the first key is the primary team).
 * When two teams' placements collide on the same dest, the FIRST one seen
 * wins and later ones are skipped — i.e. primary-team-wins. This matters in
 * practice for agent files: they are copied flat into .claude/agents/<file>.md
 * with no per-team subdirectory, so two teams shipping an agent of the same
 * file name would otherwise silently pick whichever team happened to be
 * walked last. Primary-first is the deterministic tie-break Issue #18 calls
 * for. As of this writing none of the 11 shipped teams actually have a
 * duplicate agent file name (verified by inspecting every team's agents/
 * directory), so this rule has no observable effect today — it exists for
 * when that stops being true.
 *
 * working-method never collides in a way this rule needs to resolve: every
 * team resolves it to the same source (shared/skills/working-method/, via
 * resolveSkillDir's fallback — see teams.js), so whichever team is walked
 * first still points the index at the identical file.
 *
 * team-lessons is structurally absent from every team's placement: use.js
 * filters the reserved skill name out of rawSkillNames before any dest is
 * computed (see resolveTeamPlacement above), and scaffoldTeamLessons() never
 * records its files in placedFiles either. There is nothing to hardcode
 * against — the exclusion falls out of resolveTeamPlacement() never
 * producing a team-lessons pair in the first place.
 *
 * @param {{ teams: Record<string, unknown> } | null} manifest normalized
 *   manifest from readManifest() (manifest.js)
 * @param {string} projectRoot
 * @returns {{ index: Map<string, string>, unknownTeams: string[] }}
 */
export function buildOwnedSourceIndex(manifest, projectRoot) {
  const unknownTeams = [];
  const teamNames = manifest?.teams ? Object.keys(manifest.teams) : [];

  const orderedPlacements = [];
  for (const name of teamNames) {
    const team = findTeam(name);
    if (!team) {
      // Package no longer ships this team (removed or renamed) — nothing to
      // resolve a source from.
      unknownTeams.push(name);
      continue;
    }
    orderedPlacements.push(resolveTeamPlacement(team, projectRoot));
  }

  return { index: mergeOwnedSourceIndex(orderedPlacements), unknownTeams };
}

/**
 * Merge an ORDERED list of team placements (application order, primary
 * first) into a single dest→src Map, first-write-wins on a dest collision.
 *
 * Split out from buildOwnedSourceIndex() as a pure function — independent of
 * findTeam()/manifest shape — specifically so the primary-wins tie-break can
 * be unit-tested directly with synthetic, deliberately-colliding placements.
 * The 11 shipped teams have no real dest collision to exercise this against
 * (see buildOwnedSourceIndex's doc comment), so testing the tie-break through
 * real team data alone could not distinguish "first wins" from "last wins" —
 * this function is what makes that distinction directly testable.
 *
 * @param {{ agentPairs: {src: string, dest: string}[], skillPairs: {src: string, dest: string}[], orch: {src: string, dest: string} | null }[]} orderedPlacements
 * @returns {Map<string, string>}
 */
export function mergeOwnedSourceIndex(orderedPlacements) {
  const index = new Map();
  for (const { agentPairs, skillPairs, orch } of orderedPlacements) {
    const pairs = orch ? [...agentPairs, ...skillPairs, orch] : [...agentPairs, ...skillPairs];
    for (const { src, dest } of pairs) {
      if (!index.has(dest)) index.set(dest, src);
    }
  }
  return index;
}
