/**
 * manifest.js — read/write .claude/.ccpm-manifest.json in the user's project.
 *
 * The manifest tracks what ccpm placed so we can clean up on team switches
 * without touching hand-written agent files.
 *
 * Schema:
 * {
 *   "version": "1",                    // schema version, bump if format changes
 *   "appliedTeam": "<team-name>",      // name of the currently-applied team
 *   "appliedAt": "<ISO-8601>",         // timestamp for diagnostics
 *   "placedFiles": ["<abs-path>", ...],// every file ccpm wrote, for clean removal
 *   "agentTeamsFlagSet": <boolean>     // true if ccpm wrote the experimental env key
 * }
 */

import fs from 'fs';
import path from 'path';

const MANIFEST_VERSION = '1';

/**
 * Resolve the manifest path inside the given project root.
 */
export function manifestPath(projectRoot) {
  return path.join(projectRoot, '.claude', '.ccpm-manifest.json');
}

/**
 * Read the manifest from disk. Returns null if it does not exist or is invalid.
 */
export function readManifest(projectRoot) {
  const mPath = manifestPath(projectRoot);
  if (!fs.existsSync(mPath)) return null;
  try {
    return JSON.parse(fs.readFileSync(mPath, 'utf8'));
  } catch {
    // Corrupted manifest — treat as absent so we start fresh.
    return null;
  }
}

/**
 * Write a new manifest to disk.
 * agentTeamsFlagSet tracks whether ccpm injected the experimental env key so
 * we can remove it on switch without clobbering a user's pre-existing value.
 */
export function writeManifest(projectRoot, { appliedTeam, placedFiles, agentTeamsFlagSet = false }) {
  const mPath = manifestPath(projectRoot);
  const data = {
    version: MANIFEST_VERSION,
    appliedTeam,
    appliedAt: new Date().toISOString(),
    placedFiles,
    agentTeamsFlagSet,
  };
  fs.mkdirSync(path.dirname(mPath), { recursive: true });
  fs.writeFileSync(mPath, JSON.stringify(data, null, 2) + '\n', 'utf8');
}
