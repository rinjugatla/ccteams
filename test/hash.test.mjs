/**
 * Tests for lib/hash.js — hashBytes() and hashFileSync(). hashBytes() is
 * exported but (before this file) had no direct test — it was only ever
 * exercised indirectly through hashFileSync()'s callers.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { hashBytes, hashFileSync } from '../lib/hash.js';

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
