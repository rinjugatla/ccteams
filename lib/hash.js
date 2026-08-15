/**
 * hash.js — sha256 helpers used to record and compare a "baseline" for every
 * file ccteams places, so migrate.js's ownedFilesStep (Issue #18 phase 2) can
 * tell "the user edited this ccteams-owned file" apart from "this file is
 * unchanged since ccteams placed it".
 *
 * Two FAMILIES of helper live here and must not be mixed up:
 *   - hashBytes()/hashFileSync()                 — raw bytes, no normalization
 *   - hashTextNormalized()/hashFileNormalizedSync() — utf8 text with CRLF → LF
 * See each function's doc comment for which question it answers.
 */

import crypto from 'crypto';
import fs from 'fs';

/**
 * sha256 of raw bytes, as lowercase hex.
 *
 * Deliberately hashes the RAW bytes with no EOL normalization. useTeam()
 * writes every dest file via fs.copyFileSync(), which copies bytes verbatim,
 * so at the moment a file is placed, src and dest are byte-identical and a
 * raw-byte hash captures that baseline exactly. Normalizing EOLs here would
 * risk masking a real difference (e.g. a src file that legitimately differs
 * only in line endings from what shipped before). The cost of NOT
 * normalizing is a possible false positive if git's autocrlf rewrites a
 * checked-out file's line endings on the user's machine — but that just
 * makes the file look "user-edited" (hash mismatch), which is the SAFE
 * direction to fail in: it means "don't overwrite" rather than "overwrite
 * something the user actually changed".
 *
 * @param {Buffer} buf
 * @returns {string} lowercase hex sha256 digest
 */
export function hashBytes(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

/**
 * sha256 of the file at absPath, as lowercase hex, or null if it cannot be
 * read (missing, a directory, permission error, etc.) — callers treat "no
 * hash" as "no baseline recorded" rather than propagating an fs error.
 *
 * @param {string} absPath
 * @returns {string | null}
 */
export function hashFileSync(absPath) {
  try {
    return hashBytes(fs.readFileSync(absPath));
  } catch {
    return null;
  }
}

/**
 * sha256 of `text` with every CRLF collapsed to a bare LF, encoded utf8, as
 * lowercase hex.
 *
 * WHY THIS EXISTS ALONGSIDE hashBytes()/hashFileSync(). The raw-byte hashes
 * above answer "is this file byte-identical to the baseline ccteams recorded
 * when it placed the file?", and they deliberately fail toward "don't
 * overwrite" (see hashBytes's own note): a CRLF rewrite makes a file look
 * user-edited, which is the safe direction for THAT question.
 *
 * The team-lessons template ledger (lib/team-lessons-template.js) asks a
 * different question: "is this file verifiably an UNEDITED version ccteams once
 * shipped?" A checkout whose line endings git rewrote (core.autocrlf=true on
 * Windows) is not a user edit, and the ledger's hashes are computed once, from
 * git blobs, which are always LF. Without normalization the ledger would match
 * on Linux and never match on Windows — i.e. it would silently stop working for
 * half the users. Normalizing is what makes one ledger correct on both.
 *
 * What normalization does NOT rescue: a file a formatter has reflowed. Running
 * prettier 3 over scaffold/team-lessons/scripts/gen-lessons.mjs changes 245 of
 * its 321 lines (measured in Issue #60), and prettier's default
 * `trailingComma: "all"` adds and removes real comma TOKENS — so no
 * whitespace-only normalization, however aggressive, can recover the original
 * digest. That case is handled by a functional signature check instead (see
 * signatureIsOutdated in lib/team-lessons-template.js), never by hashing.
 *
 * @param {string} text
 * @returns {string} lowercase hex sha256 digest
 */
export function hashTextNormalized(text) {
  return crypto.createHash('sha256').update(text.replace(/\r\n/g, '\n'), 'utf8').digest('hex');
}

/**
 * hashTextNormalized() of the file at absPath read as utf8, or null if it
 * cannot be read (missing, a directory, permission error, ...) — same
 * "no hash rather than an fs error" contract as hashFileSync().
 *
 * Reading as utf8 (not as bytes) is part of the contract: the ledger's values
 * were computed from utf8 text, so a file whose bytes are not valid utf8 hashes
 * as its replacement-character decoding — which simply means "matches no ledger
 * entry", the correct answer for a file ccteams never shipped.
 *
 * @param {string} absPath
 * @returns {string | null}
 */
export function hashFileNormalizedSync(absPath) {
  try {
    return hashTextNormalized(fs.readFileSync(absPath, 'utf8'));
  } catch {
    return null;
  }
}
