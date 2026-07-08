/**
 * manifest.js — read/write .claude/.ccteams-manifest.json in the user's project.
 *
 * The manifest tracks what ccteams placed so applying/removing teams can clean
 * up without touching hand-written agent files.
 *
 * Schema (v3 — multi-team):
 * {
 *   "version": "3",
 *   "teams": {
 *     "<team-name>": {
 *       "appliedAt": "<ISO-8601>",
 *       "placedFiles": ["<project-relative path>", ...],
 *       "agentTeams": <boolean>   // this team required/opted into agent-teams mode
 *     },
 *     ...
 *   },
 *   "agentTeamsFlagSet": <boolean> // true if ccteams itself wrote the experimental env key
 * }
 *
 * Key order of `teams` is significant: the FIRST key is the primary team (the
 * first one applied). JS object insertion order preserves this — callers must
 * update an existing team's entry in place (never delete+re-insert) so its
 * primary status never changes on re-apply.
 *
 * Older manifests are normalized to v3 in memory by readManifest():
 *   v1/v2 shape: {appliedTeam, placedFiles, agentTeamsFlagSet, appliedAt}
 *   becomes:     {version:"3", teams:{[appliedTeam]:{appliedAt, placedFiles,
 *                 agentTeams: agentTeamsFlagSet === true}}, agentTeamsFlagSet}
 *   (v1/v2 predate per-team agentTeams tracking, so agentTeamsFlagSet is the
 *   best available signal for whether that single team needed it.)
 *
 * v1 stored placedFiles as absolute paths, which broke when a project was
 * cloned to a different absolute location (the collision guard then treated
 * every ccteams-placed file as hand-written). v2+ store project-relative
 * paths; resolvePlacedFiles() handles reading both formats.
 */

import fs from 'fs';
import path from 'path';

const MANIFEST_VERSION = '3';

/**
 * Resolve the manifest path inside the given project root.
 */
export function manifestPath(projectRoot) {
  return path.join(projectRoot, '.claude', '.ccteams-manifest.json');
}

/**
 * Normalize a raw parsed manifest (any known version) to the in-memory v3 shape.
 * Returns null if the shape is unrecognized.
 */
function normalizeManifest(raw) {
  if (!raw || typeof raw !== 'object') return null;

  if (raw.version === '3' && raw.teams && typeof raw.teams === 'object') {
    return raw;
  }

  // v1/v2: single appliedTeam.
  if (typeof raw.appliedTeam === 'string' && raw.appliedTeam.length > 0) {
    return {
      version: '3',
      teams: {
        [raw.appliedTeam]: {
          appliedAt: raw.appliedAt ?? new Date(0).toISOString(),
          placedFiles: Array.isArray(raw.placedFiles) ? raw.placedFiles : [],
          agentTeams: raw.agentTeamsFlagSet === true,
        },
      },
      agentTeamsFlagSet: raw.agentTeamsFlagSet === true,
    };
  }

  return null;
}

/**
 * Read the manifest from disk, normalized to the v3 shape. Returns null if it
 * does not exist, is invalid JSON, or is an unrecognized shape.
 */
export function readManifest(projectRoot) {
  const mPath = manifestPath(projectRoot);
  if (!fs.existsSync(mPath)) return null;
  try {
    const raw = JSON.parse(fs.readFileSync(mPath, 'utf8'));
    return normalizeManifest(raw);
  } catch {
    // Corrupted manifest — treat as absent so we start fresh.
    return null;
  }
}

/**
 * Resolve one team's placedFiles array to absolute paths under projectRoot.
 *
 * v2+ manifests store project-relative paths, so a project cloned or moved to
 * a new absolute location still resolves correctly. v1 manifests stored
 * absolute paths; when one was written under a different root (prefix does
 * not match projectRoot), re-root it on its ".claude/" segment — every file
 * ccteams has ever placed lives under <projectRoot>/.claude/, so this
 * migration is complete.
 */
export function resolvePlacedFiles(placedFiles, projectRoot) {
  const marker = `${path.sep}.claude${path.sep}`;
  return (placedFiles ?? []).map((f) => {
    if (!path.isAbsolute(f)) return path.join(projectRoot, f);
    if (f.startsWith(projectRoot + path.sep)) return f;
    const i = f.indexOf(marker);
    return i === -1 ? f : path.join(projectRoot, f.slice(i + 1));
  });
}

/**
 * Write the full v3 manifest to disk.
 *
 * teams: an object keyed by team name (insertion order = application order,
 * first key = primary team), each entry { appliedAt, placedFiles, agentTeams }.
 * placedFiles may be passed as absolute paths; they are stored project-relative
 * (see resolvePlacedFiles for why).
 * agentTeamsFlagSet tracks whether ccteams itself injected the experimental env
 * key so it can be removed later without clobbering a user's pre-existing value.
 */
export function writeManifest(projectRoot, { teams, agentTeamsFlagSet = false }) {
  const mPath = manifestPath(projectRoot);
  const outTeams = {};
  for (const [name, entry] of Object.entries(teams)) {
    outTeams[name] = {
      appliedAt: entry.appliedAt ?? new Date().toISOString(),
      placedFiles: (entry.placedFiles ?? []).map((f) =>
        path.isAbsolute(f) ? path.relative(projectRoot, f) : f,
      ),
      agentTeams: entry.agentTeams === true,
    };
  }
  const data = {
    version: MANIFEST_VERSION,
    teams: outTeams,
    agentTeamsFlagSet: agentTeamsFlagSet === true,
  };
  fs.mkdirSync(path.dirname(mPath), { recursive: true });
  fs.writeFileSync(mPath, JSON.stringify(data, null, 2) + '\n', 'utf8');
}

/**
 * Delete the manifest file (used once the last applied team is removed).
 * No-op if it does not exist.
 */
export function deleteManifest(projectRoot) {
  const mPath = manifestPath(projectRoot);
  if (fs.existsSync(mPath)) {
    fs.rmSync(mPath, { force: true });
  }
}
