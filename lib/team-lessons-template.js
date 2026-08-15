/**
 * team-lessons-template.js — everything `ccteams migrate` needs to decide WHICH
 * GENERATION of the ccteams-owned team-lessons template a project has on disk,
 * and whether ccteams may refresh it.
 *
 * Ownership split (Issue #60). `.claude/skills/team-lessons/` used to be
 * user-owned in its entirety, which meant a project that installed it once
 * could never receive a fixed generator again. That was too broad: `scripts/**`
 * and `AUTHORING.md` are ccteams' own tool implementation and authoring rules,
 * not content the user writes. The split is now:
 *
 *   ccteams-owned (this module's business, refreshed by migrate):
 *     AUTHORING.md, scripts/gen-lessons.mjs, scripts/lessons-index.mjs,
 *     scripts/template-version.mjs
 *   user-owned (NEVER touched, unchanged from before):
 *     SKILL.md, lessons/**
 *
 * SKILL.md staying user-owned is not a nicety: in ccteams 0.2.0-era installs
 * SKILL.md itself was the canonical home of every lesson, so overwriting it
 * would destroy exactly the knowledge the skill exists to accumulate.
 *
 * Three detection mechanisms, in decreasing order of certainty:
 *   1. the generation MARKER   — scripts/template-version.mjs (see that file)
 *   2. the known-hash LEDGER   — for installs that predate the marker
 *   3. the functional SIGNATURE — for pre-marker installs a formatter reflowed
 * classifyTemplateGeneration() below is the single place their precedence is
 * decided, and it is a pure function so every combination is unit-testable.
 */

import fs from 'fs';
// Single source of truth: the number migrate compares against is read from the
// very file it ships into the project, exactly as lib/use.js imports the
// catalog markers from the generator it ships (never a second copy that could
// drift).
import { TEAM_LESSONS_TEMPLATE_VERSION } from '../scaffold/team-lessons/scripts/template-version.mjs';

export { TEAM_LESSONS_TEMPLATE_VERSION };

/**
 * Every ccteams-owned file under `.claude/skills/team-lessons/`, as
 * forward-slash paths relative to that directory, sorted so processing (and
 * therefore an interactive session's prompt order) is deterministic.
 *
 * This list — not a directory walk of the scaffold — is what defines ccteams
 * ownership. A file present in the template but absent here (SKILL.md,
 * lessons/.gitkeep) stays user-owned and is only ever PLACED-IF-MISSING by
 * scaffoldTeamLessons(), never updated.
 */
export const TEAM_LESSONS_OWNED_FILES = Object.freeze([
  'AUTHORING.md',
  'scripts/gen-lessons.mjs',
  'scripts/lessons-index.mjs',
  'scripts/template-version.mjs',
]);

/**
 * The subset of TEAM_LESSONS_OWNED_FILES the hash ledger records — i.e. all of
 * them EXCEPT the marker file.
 *
 * Why the marker is excluded: it carries the generation number itself, so
 * hashing it into its own ledger entry would be self-referential — bumping the
 * number changes the file, which changes the hash, which forces another edit of
 * the entry that was just written. And it would add no detection power: an
 * install that HAS the marker is identified by reading the marker, never by
 * matching a hash, so a ledger row for it could never be the thing that decides
 * anything. The ledger's entire job is identifying installs from BEFORE the
 * marker existed, where this file is absent by definition.
 */
export const TEAM_LESSONS_LEDGER_FILES = Object.freeze(
  TEAM_LESSONS_OWNED_FILES.filter((rel) => rel !== 'scripts/template-version.mjs'),
);

/**
 * Every generation of the ccteams-owned team-lessons template ccteams has ever
 * shipped, ascending by `version`, as EOL-NORMALIZED sha256 digests
 * (hashTextNormalized — see lib/hash.js for why raw-byte hashes cannot be used
 * here). Each entry's `files` lists only the paths that EXISTED in that
 * generation, so a file added later simply has no key in the older entries.
 *
 * The values were computed from this repository's own git history — the commit
 * each generation was taken from is noted on its entry — so they describe real
 * shipped bytes rather than a reconstruction.
 *
 * MAINTAINER NOTE: when you change ANY file listed in TEAM_LESSONS_LEDGER_FILES,
 * append a new entry here with the new hashes AND bump
 * TEAM_LESSONS_TEMPLATE_VERSION in
 * scaffold/team-lessons/scripts/template-version.mjs to match. The tests in
 * test/migrate-team-lessons-template.test.mjs fail otherwise — deliberately:
 * a bumped template with a stale ledger silently loses the ability to recognize
 * the version it just replaced.
 */
export const TEAM_LESSONS_HASH_LEDGER = Object.freeze([
  // v1 — b95bd74: the scaffold's introduction. scripts/lessons-index.mjs did
  // not exist yet, so it is absent from `files` rather than recorded as null.
  Object.freeze({
    version: 1,
    files: Object.freeze({
      'AUTHORING.md': 'e43d1e6d25bc1bd4b18cd9e7b331285e3a7601cf48c5c5f298a06264a8107a6d',
      'scripts/gen-lessons.mjs': 'c85683f00f40e6b16fbcc9f12414f5e2afe54fe16267e809f75891ea53d20a2d',
    }),
  }),
  // v2 — b2a4694
  Object.freeze({
    version: 2,
    files: Object.freeze({
      'AUTHORING.md': '6ddb1b61ae90f1c030d00724a200ff1ebb1a5fdcaf5d8016eae227b9032b6333',
      'scripts/gen-lessons.mjs': '7550526b49dac45c15c88a6703bdf7934d683bae2d3b583735cdbf9ae972c489',
      'scripts/lessons-index.mjs': '87c9fb5a2132687a96727c974283fdec7ee6ae1c8b93bbe033984baa5da94eb5',
    }),
  }),
  // v3 — a01454c: `applies_when` introduced (the fact OUTDATED_SIGNATURE keys on).
  Object.freeze({
    version: 3,
    files: Object.freeze({
      'AUTHORING.md': 'bcca4f0a897ca3764ebe01f5fd253c965661c2b56c33039546cd4fc4dbc9c22e',
      'scripts/gen-lessons.mjs': '4ff3df831f4fec4036bc1a6ee5ff899cb50e9555f27542c9871bebce12b24817',
      'scripts/lessons-index.mjs': '87c9fb5a2132687a96727c974283fdec7ee6ae1c8b93bbe033984baa5da94eb5',
    }),
  }),
  // v4 — f8b57dd
  Object.freeze({
    version: 4,
    files: Object.freeze({
      'AUTHORING.md': '48f12b6d618eebe7e2d5cccd31466d4784c6f90db4640464a10099b0568ec39d',
      'scripts/gen-lessons.mjs': '4ff3df831f4fec4036bc1a6ee5ff899cb50e9555f27542c9871bebce12b24817',
      'scripts/lessons-index.mjs': '87c9fb5a2132687a96727c974283fdec7ee6ae1c8b93bbe033984baa5da94eb5',
    }),
  }),
  // v5 — 4efdf37
  Object.freeze({
    version: 5,
    files: Object.freeze({
      'AUTHORING.md': '48f12b6d618eebe7e2d5cccd31466d4784c6f90db4640464a10099b0568ec39d',
      'scripts/gen-lessons.mjs': 'd2a66d8874c1dda6f67e6edd422b74b4342eb9c931afd4938d7efb63eaa42548',
      'scripts/lessons-index.mjs': 'f024fc07d7ef0efa3a2c742ab58615cc49506471ff0e1c22b45b828f7f96364b',
    }),
  }),
  // v6 — a8559e7
  Object.freeze({
    version: 6,
    files: Object.freeze({
      'AUTHORING.md': '04ca2015071ea5ba8dcda760d1ab594ab3991abc8f4bbdbf9e10ed35b72acb50',
      'scripts/gen-lessons.mjs': 'd2a66d8874c1dda6f67e6edd422b74b4342eb9c931afd4938d7efb63eaa42548',
      'scripts/lessons-index.mjs': 'f024fc07d7ef0efa3a2c742ab58615cc49506471ff0e1c22b45b828f7f96364b',
    }),
  }),
  // v7 — ec66e53
  Object.freeze({
    version: 7,
    files: Object.freeze({
      'AUTHORING.md': '9dfb1167f56af59df04a6a4c705ad719baa094b2669e7edb4c398970119951da',
      'scripts/gen-lessons.mjs': 'd2a66d8874c1dda6f67e6edd422b74b4342eb9c931afd4938d7efb63eaa42548',
      'scripts/lessons-index.mjs': 'f024fc07d7ef0efa3a2c742ab58615cc49506471ff0e1c22b45b828f7f96364b',
    }),
  }),
  // v8 — d4f7e33 (Issue #63): the `applies_when`-missing warning gained AI
  // remediation steps and warning colour. Only gen-lessons.mjs changed;
  // AUTHORING.md and lessons-index.mjs carry their v7 digests forward.
  //
  // This entry is also the worked example of the maintainer note above: #63
  // landed on master while this ledger was being written, and the
  // "shipped scaffold matches the last entry" test caught the stale v7 row on
  // the very next run — which is exactly the version-bump-forgotten failure it
  // exists to catch.
  Object.freeze({
    version: 8,
    files: Object.freeze({
      'AUTHORING.md': '9dfb1167f56af59df04a6a4c705ad719baa094b2669e7edb4c398970119951da',
      'scripts/gen-lessons.mjs': 'feb495db26941686af9a81f208c0e9cbf6198c0a94d17488930bf63091588fe5',
      'scripts/lessons-index.mjs': 'f024fc07d7ef0efa3a2c742ab58615cc49506471ff0e1c22b45b828f7f96364b',
    }),
  }),
  // v9 (Issue #68): gen-lessons.mjs fixed to stop deadlocking with prettier —
  // a blank line now separates the catalog body from the end marker
  // (buildSkill), and the index heading dropped its `**…**` bold wrapper
  // (renderCatalog). The bold wrapper made an `applies_when` that quotes a
  // glob in a code span (e.g. `` `.claude/**` ``) unrepresentable
  // byte-for-byte once prettier 3.8.3 escaped the heading's closing `**`
  // next to it (version-dependent — 3.9.6 round-trips that case untouched;
  // see renderCatalog's doc comment for the verified writeup), and it did
  // nothing for the version-independent risk of a bare `*`/`*em*` inside the
  // value itself, so it is dropped rather than escaped or pinned to a
  // prettier version. AUTHORING.md changed too (the authoring caveat this
  // fix leaves in place — see its own doc comment); only lessons-index.mjs
  // carries its v8 digest forward.
  Object.freeze({
    version: 9,
    files: Object.freeze({
      'AUTHORING.md': '50cd08ca8329f653ff525c1873ccada8d27c4da28c43f0031dba9424f2dd4dde',
      'scripts/gen-lessons.mjs': '7d0dafcbc770cd28d2d28b18d7c272a6e339ea478eb51685e3760cf714e22a91',
      'scripts/lessons-index.mjs': 'f024fc07d7ef0efa3a2c742ab58615cc49506471ff0e1c22b45b828f7f96364b',
    }),
  }),
]);

/**
 * The pattern the marker's value is extracted with.
 *
 * Tolerant of FORMATTING (`\s+`/`\s*` absorb whatever spacing a formatter
 * chooses around `export`, `const` and `=`) but NOT of context: the full
 * `export const` prefix is required, so a doc comment that merely mentions an
 * example assignment — e.g. this repo's own marker file, whose header explains
 * the regex — cannot win the match ahead of the real declaration. The
 * identifier itself is unique to this file, and prettier never renames
 * identifiers, so together these make the extraction both stable and unforgeable.
 */
export const TEMPLATE_VERSION_RE =
  /export\s+const\s+TEAM_LESSONS_TEMPLATE_VERSION\s*=\s*(\d+)/;

/**
 * The ledger generation in which OUTDATED_SIGNATURE first appeared (v3,
 * a01454c). A copy of gen-lessons.mjs that lacks the token therefore predates
 * THIS generation — the precise claim the 'outdated-signature' notice is
 * allowed to make, and the reason it is stated as a named constant rather than
 * a literal buried in a string.
 */
export const OUTDATED_SIGNATURE_INTRODUCED_IN = 3;

/**
 * Read the generation marker out of a project's own
 * `scripts/template-version.mjs` WITHOUT importing it (see that file's doc
 * comment for why importing a file from the user's project is not an option).
 *
 * @param {string} absPath
 * @returns {number | null} the integer, or null when the file is missing,
 *   unreadable, or contains no TEAM_LESSONS_TEMPLATE_VERSION assignment. All
 *   three collapse to null on purpose: every one of them means "this install
 *   carries no usable generation marker", which is the only distinction the
 *   caller acts on.
 */
export function readTemplateVersion(absPath) {
  let text;
  try {
    text = fs.readFileSync(absPath, 'utf8');
  } catch {
    return null;
  }
  const match = TEMPLATE_VERSION_RE.exec(text);
  return match ? Number.parseInt(match[1], 10) : null;
}

/**
 * The generation number of the template THIS package ships. A function (rather
 * than only the re-exported constant) so call sites read symmetrically against
 * readTemplateVersion(diskPath) — "the package's version" vs "the project's
 * version" — and so a test can stub it by injection rather than by module
 * surgery.
 *
 * @returns {number}
 */
export function packageTemplateVersion() {
  return TEAM_LESSONS_TEMPLATE_VERSION;
}

/**
 * The highest ledger generation whose recorded files ALL match what is on disk.
 *
 * A pure function of already-gathered hashes, so no fixture is needed to test
 * it. An entry matches only when every path IT lists has a non-null disk hash
 * equal to the recorded one — a null (missing/unreadable) disk hash can never
 * satisfy an entry, because "we could not read it" is not evidence that the
 * bytes match. Scanning for the HIGHEST match rather than the first matters
 * whenever consecutive generations share a file's content (v3 and v4 ship the
 * identical gen-lessons.mjs, for instance): the newest generation consistent
 * with the whole file set is the honest answer.
 *
 * @param {Map<string, string|null>} diskHashes relPath -> normalized hash
 * @param {ReadonlyArray<{version:number, files:Record<string,string>}>} [ledger]
 * @returns {number | null}
 */
export function findLedgerVersion(diskHashes, ledger = TEAM_LESSONS_HASH_LEDGER) {
  let best = null;
  for (const entry of ledger) {
    const paths = Object.keys(entry.files);
    const allMatch = paths.every((rel) => {
      const onDisk = diskHashes.get(rel);
      return typeof onDisk === 'string' && onDisk === entry.files[rel];
    });
    if (allMatch && (best === null || entry.version > best)) best = entry.version;
  }
  return best;
}

/**
 * Whether `hash` is a digest ccteams itself shipped for `relPath` at SOME
 * generation — the per-file version of "this copy is verifiably unedited".
 *
 * Used to decide whether one file of an outdated install may be refreshed
 * silently: matching a historical digest proves nobody changed it since ccteams
 * wrote it, so there is nothing of the user's to lose. Pure function.
 *
 * @param {string} relPath forward-slash path relative to the skill dir
 * @param {string | null} hash normalized digest of the on-disk file
 * @param {ReadonlyArray<{version:number, files:Record<string,string>}>} [ledger]
 * @returns {boolean}
 */
export function isKnownShippedHash(relPath, hash, ledger = TEAM_LESSONS_HASH_LEDGER) {
  if (typeof hash !== 'string') return false;
  return ledger.some((entry) => entry.files[relPath] === hash);
}

/**
 * The identifier whose ABSENCE from gen-lessons.mjs proves the copy predates
 * the `applies_when` generation (v3, commit a01454c).
 *
 * This works where hashing cannot because of two measured facts (Issue #60):
 * prettier never renames identifiers and never rewrites the contents of a
 * string literal, so however aggressively a project reformats the file, this
 * token survives verbatim; and a user has no reason to delete it — removing it
 * would break their own generator. So "the token is missing" is a sound proof
 * of "older than v3", independent of formatting.
 */
export const OUTDATED_SIGNATURE = 'applies_when';

/**
 * Whether `genLessonsText` is a gen-lessons.mjs from before the
 * `applies_when` generation. Null/undefined (unreadable or absent file) is NOT
 * outdated: nothing was read, so nothing was established — the same
 * "a finding must name only what its own branch checked" rule the migrate
 * notices follow.
 *
 * @param {string | null | undefined} genLessonsText
 * @returns {boolean}
 */
export function signatureIsOutdated(genLessonsText) {
  if (typeof genLessonsText !== 'string') return false;
  return !genLessonsText.includes(OUTDATED_SIGNATURE);
}

/**
 * Decide which generation an on-disk team-lessons install belongs to. PURE —
 * every input is a fact the caller already gathered, so all six outcomes are
 * directly unit-testable without fixtures.
 *
 * Precedence, strongest evidence first:
 *   1. THE MARKER, when present, decides outright ('newer' / 'current' /
 *      'outdated-marker'). It is ccteams' own bookkeeping written by ccteams
 *      itself, so it beats any inference from content. This is also why the
 *      marker must never be placed into a project before this check runs — see
 *      teamLessonsTemplateStep's position in MIGRATION_STEPS.
 *   2. THE LEDGER, for a marker-less install whose files still match bytes
 *      ccteams shipped ('outdated-ledger'). Certain, but only reachable while
 *      the files are untouched by a formatter.
 *   3. THE SIGNATURE, for a marker-less install the ledger missed
 *      ('outdated-signature'). Weaker (it proves only "older than v3"), but
 *      immune to reformatting — which is exactly the case the ledger loses.
 *   4. Otherwise 'outdated-unknown'. Still OUTDATED BY CONSTRUCTION: every
 *      install that ships the marker has the marker, so a marker-less install
 *      necessarily predates it. What is unknown is only WHICH old generation it
 *      is, and whether its content is untouched — so callers must treat this as
 *      "outdated, nothing verified about the content" and never overwrite
 *      anything on its strength alone.
 *
 * 'newer' exists for a downgraded CLI (the project was migrated by a newer
 * ccteams than the one now installed). Rewriting newer files with older ones
 * would be a silent regression of the user's tooling, so it is report-only.
 *
 * @param {{ markerVersion: number|null, packageVersion: number,
 *   ledgerVersion: number|null, signatureIsOld: boolean }} input
 * @returns {'newer'|'current'|'outdated-marker'|'outdated-ledger'|'outdated-signature'|'outdated-unknown'}
 */
export function classifyTemplateGeneration({
  markerVersion,
  packageVersion,
  ledgerVersion,
  signatureIsOld,
}) {
  if (markerVersion !== null && markerVersion !== undefined) {
    if (markerVersion > packageVersion) return 'newer';
    if (markerVersion === packageVersion) return 'current';
    return 'outdated-marker';
  }
  if (ledgerVersion !== null && ledgerVersion !== undefined) return 'outdated-ledger';
  if (signatureIsOld === true) return 'outdated-signature';
  return 'outdated-unknown';
}
