/**
 * Tests for lib/hash.js — the raw-byte family (hashBytes/hashFileSync) and the
 * EOL-normalized family (hashTextNormalized/hashFileNormalizedSync) the
 * team-lessons template ledger depends on. hashBytes() is exported but (before
 * this file) had no direct test — it was only ever exercised indirectly
 * through hashFileSync()'s callers.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  hashBytes,
  hashFileSync,
  hashTextNormalized,
  hashFileNormalizedSync,
} from '../lib/hash.js';

/** Independent sha256, deliberately NOT reusing lib/hash.js's own crypto call. */
const independentSha256 = (buf) => createHash('sha256').update(buf).digest('hex');

describe('hashBytes()', () => {
  test('matches an independently computed sha256 of the same bytes', () => {
    const buf = Buffer.from('ccteams — a known byte sequence\n', 'utf8');
    assert.equal(hashBytes(buf), independentSha256(buf));
  });

  test('an empty buffer hashes to the well-known sha256("") digest', () => {
    const buf = Buffer.alloc(0);
    assert.equal(hashBytes(buf), independentSha256(buf));
    // The well-known sha256 of zero bytes — a fixed literal, independent of
    // independentSha256's own crypto call, so a bug shared between the two
    // could not hide.
    assert.equal(hashBytes(buf), 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
  });

  test('different byte sequences hash differently', () => {
    assert.notEqual(hashBytes(Buffer.from('a')), hashBytes(Buffer.from('b')));
  });

  test('is a lowercase hex string of the expected length (32 bytes = 64 hex chars)', () => {
    const digest = hashBytes(Buffer.from('anything'));
    assert.match(digest, /^[0-9a-f]{64}$/);
  });
});

describe('hashFileSync()', () => {
  const makeProject = () => mkdtempSync(path.join(tmpdir(), 'ccteams-hash-'));

  test('matches hashBytes() of the file\'s own content', () => {
    const root = makeProject();
    const filePath = path.join(root, 'sample.txt');
    writeFileSync(filePath, 'sample content\n', 'utf8');

    assert.equal(hashFileSync(filePath), hashBytes(Buffer.from('sample content\n', 'utf8')));
  });

  test('returns null for a missing file rather than throwing', () => {
    const root = makeProject();
    assert.equal(hashFileSync(path.join(root, 'does-not-exist.txt')), null);
  });

  test('returns null for a directory rather than throwing', () => {
    const root = makeProject();
    assert.equal(hashFileSync(root), null);
  });
});

describe('hashTextNormalized()', () => {
  test('CRLF and LF text hash identically — the whole point of this helper', () => {
    const lf = 'line one\nline two\nline three\n';
    assert.equal(hashTextNormalized(lf.replace(/\n/g, '\r\n')), hashTextNormalized(lf));
  });

  test('is the plain sha256 of the LF form (so a ledger value can be computed from a git blob)', () => {
    const lf = 'a\nb\n';
    assert.equal(hashTextNormalized(lf), independentSha256(Buffer.from(lf, 'utf8')));
    assert.equal(hashTextNormalized('a\r\nb\r\n'), independentSha256(Buffer.from(lf, 'utf8')));
  });

  test('differs from the raw-byte hash for CRLF input (the two families are not interchangeable)', () => {
    const crlf = 'a\r\nb\r\n';
    assert.notEqual(hashTextNormalized(crlf), hashBytes(Buffer.from(crlf, 'utf8')));
  });

  test('normalizes ONLY CRLF — a lone CR is content, not a line ending to rewrite', () => {
    // If the implementation ever replaced /\r/g instead of /\r\n/g, these two
    // would collide and a real difference would be hashed away.
    assert.notEqual(hashTextNormalized('a\rb'), hashTextNormalized('ab'));
  });

  test('non-EOL differences still change the digest', () => {
    assert.notEqual(hashTextNormalized('applies_when\n'), hashTextNormalized('applies_whee\n'));
  });

  test('is a lowercase hex string of the expected length', () => {
    assert.match(hashTextNormalized('anything'), /^[0-9a-f]{64}$/);
  });
});

describe('hashFileNormalizedSync()', () => {
  const makeProject = () => mkdtempSync(path.join(tmpdir(), 'ccteams-hash-norm-'));

  test('a CRLF checkout and an LF checkout of the same file hash the same', () => {
    const root = makeProject();
    const lfPath = path.join(root, 'lf.mjs');
    const crlfPath = path.join(root, 'crlf.mjs');
    const body = 'export const X = 1;\nexport const Y = 2;\n';
    writeFileSync(lfPath, body, 'utf8');
    writeFileSync(crlfPath, body.replace(/\n/g, '\r\n'), 'utf8');

    assert.equal(hashFileNormalizedSync(crlfPath), hashFileNormalizedSync(lfPath));
    assert.equal(hashFileNormalizedSync(lfPath), hashTextNormalized(body));
    // Sanity: the two files really are different on disk, so the equality above
    // is normalization doing its job, not the fixture writing identical bytes.
    assert.notEqual(hashFileSync(crlfPath), hashFileSync(lfPath));
  });

  test('returns null for a missing file rather than throwing', () => {
    const root = makeProject();
    assert.equal(hashFileNormalizedSync(path.join(root, 'nope.mjs')), null);
  });

  test('returns null for a directory rather than throwing', () => {
    assert.equal(hashFileNormalizedSync(makeProject()), null);
  });
});
