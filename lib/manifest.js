/**
 * manifest.js — read/write .claude/.ccteams-manifest.json in the user's project.
 *
 * The manifest tracks what ccteams placed so applying/removing teams can clean
 * up without touching hand-written agent files.
 *
 * Schema (v4 — multi-team + per-file hash baseline):
 * {
 *   "version": "4",
 *   "teams": {
 *     "<team-name>": {
 *       "appliedAt": "<ISO-8601>",
 *       "placedFiles": ["<project-relative path>", ...],
 *       "fileHashes": { "<project-relative path>": "<sha256 hex>", ... },
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
 * DESIGN NOTE — why fileHashes is a SIBLING key to placedFiles rather than a
 * change to placedFiles' own shape (e.g. `[{path, hash}, ...]`): every
 * existing consumer of placedFiles (resolvePlacedFiles, unionPlacedFiles,
 * unuse.js's refcount deletion, the collision guard, `ccteams current`'s
 * placedFiles.length) reads it as a plain array of path strings. Keeping that
 * shape untouched means none of those call sites had to change for this
 * upgrade, and unuse's deletion logic in particular is guaranteed unaffected
 * — it never looks at fileHashes at all. An entry with no recorded hashes
 * (v3 and earlier, or a future entry a caller builds without hashes) simply
 * has an empty/absent fileHashes — "no hash recorded" and "hash is empty"
 * are the same state, never distinguished.
 *
 * v4 adds fileHashes; v3 (multi-team, no hashes) and v1/v2 (single appliedTeam)
 * are all normalized to the same in-memory shape by readManifest():
 *   v3 shape:    {version:"3", teams:{...no fileHashes...}, agentTeamsFlagSet}
 *   becomes:     the same object with each team entry's fileHashes left absent
 *                (resolveFileHashes() treats "absent" as "empty" — see below).
 *   v1/v2 shape: {appliedTeam, placedFiles, agentTeamsFlagSet, appliedAt}
 *   becomes:     {version:"4", teams:{[appliedTeam]:{appliedAt, placedFiles,
 *                 agentTeams: agentTeamsFlagSet === true}}, agentTeamsFlagSet}
 *   (v1/v2 predate per-team agentTeams tracking, so agentTeamsFlagSet is the
 *   best available signal for whether that single team needed it; neither
 *   version ever recorded hashes, so fileHashes is absent there too.)
 *
 * v1 stored placedFiles as absolute paths, which broke when a project was
 * cloned to a different absolute location (the collision guard then treated
 * every ccteams-placed file as hand-written). v2+ store project-relative
 * paths; resolvePlacedFiles() (and resolveFileHashes(), which applies the
 * identical re-rooting rule to fileHashes' keys) handle reading both formats.
 */

import fs from 'fs';
import path from 'path';

const MANIFEST_VERSION = '4';

/**
 * Resolve the manifest path inside the given project root.
 */
export function manifestPath(projectRoot) {
  return path.join(projectRoot, '.claude', '.ccteams-manifest.json');
}

/**
 * Normalize a raw parsed manifest (any known version) to the in-memory v4
 * shape. Returns null if the shape is unrecognized.
 *
 * v3 manifests are accepted as-is (their team entries simply have no
 * fileHashes key) — there is nothing to backfill, because "absent" and
 * "empty" are the same state to every consumer (see the schema comment
 * above and resolveFileHashes() below).
 */
function normalizeManifest(raw) {
  if (!raw || typeof raw !== 'object') return null;

  if ((raw.version === '4' || raw.version === '3') && raw.teams && typeof raw.teams === 'object') {
    return raw;
  }

  // v1/v2: single appliedTeam.
  if (typeof raw.appliedTeam === 'string' && raw.appliedTeam.length > 0) {
    return {
      version: '4',
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
 * Read the manifest from disk, normalized to the v4 shape. Returns null if it
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
 * Resolve a single placedFiles-style path entry to an absolute path under
 * projectRoot. Shared by resolvePlacedFiles() (below) and resolveFileHashes()
 * so the two can never disagree about what a given stored path resolves to —
 * a fileHashes key and the matching placedFiles entry must always resolve to
 * the identical absolute path.
 *
 * v2+ manifests store project-relative paths, so a project cloned or moved to
 * a new absolute location still resolves correctly. v1 manifests stored
 * absolute paths; when one was written under a different root (prefix does
 * not match projectRoot), re-root it on its ".claude/" segment — every file
 * ccteams has ever placed lives under <projectRoot>/.claude/, so this
 * migration is complete.
 */
export function resolvePlacedPath(f, projectRoot) {
  if (!path.isAbsolute(f)) return path.join(projectRoot, f);
  if (f.startsWith(projectRoot + path.sep)) return f;
  const marker = `${path.sep}.claude${path.sep}`;
  const i = f.indexOf(marker);
  return i === -1 ? f : path.join(projectRoot, f.slice(i + 1));
}

/**
 * True when an already-resolved absolute path (the output of
 * resolvePlacedPath) still lives inside projectRoot. This is the single
 * containment predicate for this module: writeManifest() uses it to decide
 * what may be stored, resolvePlacedFiles()/resolveFileHashes() use it to
 * decide what may be handed to callers. Sharing one predicate across all
 * three is what guarantees a placedFiles entry and its fileHashes counterpart
 * can never disagree — both go through resolvePlacedPath() and then through
 * this same test.
 *
 * It is applied AFTER resolvePlacedPath(), never before, for two reasons: a
 * stale-root absolute path containing a ".claude/" segment is legitimately
 * re-rooted onto projectRoot and must be kept rather than rejected; and the
 * re-rooting can itself MANUFACTURE an escape when the ".claude/" segment is
 * followed by "../..", so only the post-re-rooting path is worth testing.
 *
 * Written on path.relative() rather than a string-prefix comparison so it is
 * separator-agnostic: on Windows path.relative() yields "..\\..\\x", and for
 * a path on a different drive it yields an absolute path — both escape
 * projectRoot and both must be rejected. The ".." test matches whole path
 * segments only, so a legitimately named entry like "..keep.md" is not
 * mistaken for a climb-out. An empty relative path means the entry resolved
 * to projectRoot itself, which is a directory, never a placed file.
 */
function isContained(resolved, projectRoot) {
  const rel = path.relative(projectRoot, resolved);
  if (rel === '' || path.isAbsolute(rel)) return false;
  return rel !== '..' && !rel.startsWith('..' + path.sep);
}

/**
 * Resolve one team's placedFiles array to absolute paths under projectRoot.
 * See resolvePlacedPath() for the per-entry normalization rule.
 *
 * Entries that resolve outside projectRoot (see isContained) are dropped
 * rather than returned, silently. This is defence in depth for the callers
 * that act on this list destructively — unuse.js deletes every path it
 * returns — so a manifest written by an older version (or edited by hand)
 * cannot steer a delete at a path outside the project.
 *
 * The silence here rests on a DIFFERENT argument than writeManifest()'s (do
 * not carry that one over: this function is called identically in dry-run and
 * real runs, so reporting from here would not break dry-run parity). What is
 * claimed is only what the code does: a dropped entry is never returned, so no
 * caller can act on it. Nothing surfaces it to the user, and nothing here
 * repairs the stored manifest — the bad entry stays on disk until the next
 * writeManifest() drops it.
 */
export function resolvePlacedFiles(placedFiles, projectRoot) {
  return (placedFiles ?? [])
    .map((f) => resolvePlacedPath(f, projectRoot))
    .filter((resolved) => isContained(resolved, projectRoot));
}

/**
 * Resolve one team's manifest entry's fileHashes to a Map<absolutePath, hash>,
 * using the SAME per-key normalization resolvePlacedFiles() applies to
 * placedFiles (see resolvePlacedPath) — a v1-style absolute key re-roots onto
 * projectRoot exactly like its placedFiles counterpart would.
 *
 * Returns an empty Map when entry.fileHashes is absent (v3 and earlier never
 * recorded hashes) — "no baseline was ever recorded for this team" and "the
 * baseline is an empty set" are treated as the same fact everywhere in this
 * module (see the schema comment at the top of the file).
 *
 * Keys that resolve outside projectRoot are dropped, exactly as
 * resolvePlacedFiles() drops the matching placedFiles entry (see
 * isContained) — the two must stay in agreement about which entries exist.
 *
 * @param {{ fileHashes?: Record<string, string> } | null | undefined} entry
 * @param {string} projectRoot
 * @returns {Map<string, string>}
 */
export function resolveFileHashes(entry, projectRoot) {
  const map = new Map();
  const fileHashes = entry?.fileHashes;
  if (!fileHashes || typeof fileHashes !== 'object') return map;
  for (const [f, hash] of Object.entries(fileHashes)) {
    const resolved = resolvePlacedPath(f, projectRoot);
    if (!isContained(resolved, projectRoot)) continue;
    map.set(resolved, hash);
  }
  return map;
}

/**
 * Write the full v4 manifest to disk.
 *
 * teams: an object keyed by team name (insertion order = application order,
 * first key = primary team), each entry
 * { appliedAt, placedFiles, fileHashes, agentTeams }.
 * placedFiles may be passed as absolute paths; they are stored project-relative
 * (see resolvePlacedFiles for why). fileHashes keys get the identical
 * treatment so a fileHashes key and its placedFiles counterpart always land
 * on the same stored string. An entry with no fileHashes writes `{}` — that
 * is the honest statement "no baseline is recorded for this team's files",
 * not a claim that the files are unchanged.
 * agentTeamsFlagSet tracks whether ccteams itself injected the experimental env
 * key so it can be removed later without clobbering a user's pre-existing value.
 *
 * Entries that still resolve outside projectRoot after resolvePlacedPath()
 * (a corrupted or hand-edited manifest carrying an out-of-project absolute
 * path with no ".claude/" segment to re-root on, a relative entry like
 * "../../x.md", or an entry whose ".claude/" segment is followed by "../.."
 * so that re-rooting itself manufactures an escape) are SILENTLY dropped —
 * not written, not warned about, not thrown on.
 *
 * The dry-run argument for that silence applies to THIS function only:
 * migrate.js calls writeManifest() under `if (!dryRun)`, so a warning or a
 * throw raised in here would fire on the real run and be structurally
 * impossible in the `--dry-run` preview of the same run. This project's rule
 * is that dry-run and real runs never differ in behaviour or wording, and
 * dropping the entry is the only response that reads identically in both
 * modes. Do NOT reuse this argument for the read side — resolvePlacedFiles()
 * and resolveFileHashes() run in both modes alike, and state their own
 * (weaker, purely factual) reason for being silent.
 */
export function writeManifest(projectRoot, { teams, agentTeamsFlagSet = false }) {
  const mPath = manifestPath(projectRoot);
  const outTeams = {};
  for (const [name, entry] of Object.entries(teams)) {
    // resolvePlacedPath() first, THEN relativize: an absolute path from a
    // DIFFERENT root (e.g. a manifest entry carried over from before a
    // project rename/move) must be re-rooted onto projectRoot's ".claude/"
    // segment before path.relative() ever sees it. Skipping resolvePlacedPath
    // here would relativize the stale root directly (producing "../../old/
    // .claude/..."), and once stored that way resolvePlacedPath()'s own
    // re-rooting rescue can never fire again on the next read — the path no
    // longer even contains an absolute "<oldRoot>/.claude/" prefix to detect.
    // isContained() runs on the re-rooted result for the same reason: a stale
    // root that WAS rescued is contained and must be kept.
    const outFileHashes = {};
    for (const [f, hash] of Object.entries(entry.fileHashes ?? {})) {
      const resolved = resolvePlacedPath(f, projectRoot);
      if (!isContained(resolved, projectRoot)) continue;
      outFileHashes[path.relative(projectRoot, resolved)] = hash;
    }
    const outPlacedFiles = [];
    for (const f of entry.placedFiles ?? []) {
      const resolved = resolvePlacedPath(f, projectRoot);
      if (!isContained(resolved, projectRoot)) continue;
      outPlacedFiles.push(path.relative(projectRoot, resolved));
    }
    outTeams[name] = {
      appliedAt: entry.appliedAt ?? new Date().toISOString(),
      placedFiles: outPlacedFiles,
      fileHashes: outFileHashes,
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
