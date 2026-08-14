/**
 * hash.js — sha256 helpers used to record and compare a "baseline" for every
 * file ccteams places, so migrate.js's ownedFilesStep (Issue #18 phase 2) can
 * tell "the user edited this ccteams-owned file" apart from "this file is
 * unchanged since ccteams placed it".
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
