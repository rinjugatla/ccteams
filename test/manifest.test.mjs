/**
 * Tests for lib/manifest.js — the v4 manifest schema (fileHashes added
 * alongside placedFiles) and its normalization of older manifest versions.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  manifestPath,
  readManifest,
  writeManifest,
  resolvePlacedFiles,
  resolveFileHashes,
} from '../lib/manifest.js';

const makeProject = () => mkdtempSync(path.join(tmpdir(), 'ccteams-manifest-'));

/** Write a raw (unnormalized) manifest file directly, bypassing writeManifest(). */
const writeRawManifest = (root, data) => {
  const mPath = manifestPath(root);
  mkdirSync(path.dirname(mPath), { recursive: true });
  writeFileSync(mPath, JSON.stringify(data, null, 2) + '\n', 'utf8');
};

describe('manifest v4 — read/write round trip', () => {
  test('writeManifest() writes version "4"', () => {
    const root = makeProject();
    writeManifest(root, {
      teams: { generalist: { appliedAt: new Date().toISOString(), placedFiles: [], agentTeams: false } },
    });

    const raw = JSON.parse(readFileSync(manifestPath(root), 'utf8'));
    assert.equal(raw.version, '4');
  });

  test('fileHashes round-trips through write then read', () => {
    const root = makeProject();
    const agentAbs = path.join(root, '.claude', 'agents', 'builder.md');
    writeManifest(root, {
      teams: {
        generalist: {
          appliedAt: new Date().toISOString(),
          placedFiles: [agentAbs],
          fileHashes: { [agentAbs]: 'deadbeef' },
          agentTeams: false,
        },
      },
    });

    const manifest = readManifest(root);
    const entry = manifest.teams.generalist;
    assert.deepEqual(entry.fileHashes, {
      [path.join('.claude', 'agents', 'builder.md')]: 'deadbeef',
    });

    const resolved = resolveFileHashes(entry, root);
    assert.equal(resolved.get(agentAbs), 'deadbeef');
    assert.equal(resolved.size, 1);
  });

  test('an entry with no fileHashes writes {} (not absent, not null)', () => {
    const root = makeProject();
    writeManifest(root, {
      teams: { generalist: { appliedAt: new Date().toISOString(), placedFiles: [], agentTeams: false } },
    });

    const manifest = readManifest(root);
    assert.deepEqual(manifest.teams.generalist.fileHashes, {});
  });
});

describe('manifest v3 (no fileHashes) is still readable', () => {
  test('a v3 manifest ({version:"3"}, no fileHashes key) normalizes and proceeds', () => {
    const root = makeProject();
    writeRawManifest(root, {
      version: '3',
      teams: {
        generalist: {
          appliedAt: new Date(0).toISOString(),
          placedFiles: [path.join('.claude', 'agents', 'builder.md')],
          agentTeams: false,
        },
      },
      agentTeamsFlagSet: false,
    });

    const manifest = readManifest(root);
    assert.ok(manifest, 'v3 manifest must be readable');
    assert.deepEqual(Object.keys(manifest.teams), ['generalist']);
  });

  test('resolveFileHashes() returns an empty Map for a v3 entry (absent fileHashes)', () => {
    const root = makeProject();
    writeRawManifest(root, {
      version: '3',
      teams: {
        generalist: {
          appliedAt: new Date(0).toISOString(),
          placedFiles: [path.join('.claude', 'agents', 'builder.md')],
          agentTeams: false,
        },
      },
      agentTeamsFlagSet: false,
    });

    const manifest = readManifest(root);
    const resolved = resolveFileHashes(manifest.teams.generalist, root);
    assert.equal(resolved.size, 0);
    assert.ok(resolved instanceof Map);
  });
});

describe('manifest v1/v2 (appliedTeam shape) still normalizes correctly', () => {
  test('v1 manifest (single appliedTeam, absolute placedFiles) is readable', () => {
    const root = makeProject();
    const absAgentPath = path.join(root, '.claude', 'agents', 'builder.md');
    writeRawManifest(root, {
      appliedTeam: 'generalist',
      placedFiles: [absAgentPath],
      agentTeamsFlagSet: false,
      appliedAt: new Date(0).toISOString(),
    });

    const manifest = readManifest(root);
    assert.ok(manifest);
    assert.equal(manifest.version, '4');
    assert.deepEqual(Object.keys(manifest.teams), ['generalist']);
    assert.deepEqual(manifest.teams.generalist.placedFiles, [absAgentPath]);
  });

  test('v2 manifest (appliedTeam shape, project-relative placedFiles) is readable', () => {
    const root = makeProject();
    writeRawManifest(root, {
      appliedTeam: 'generalist',
      placedFiles: [path.join('.claude', 'agents', 'builder.md')],
      agentTeamsFlagSet: true,
      appliedAt: new Date(0).toISOString(),
    });

    const manifest = readManifest(root);
    assert.ok(manifest);
    assert.equal(manifest.teams.generalist.agentTeams, true);
    assert.equal(manifest.agentTeamsFlagSet, true);
  });
});

describe('writeManifest() re-roots a stale-root absolute path before relativizing', () => {
  test('an absolute path from a DIFFERENT root is stored relative to THIS projectRoot, never as "../.."', () => {
    const root = makeProject();
    const staleRoot = path.join(tmpdir(), 'some-other-original-location');
    const staleAgentPath = path.join(staleRoot, '.claude', 'agents', 'x.md');

    writeManifest(root, {
      teams: {
        generalist: {
          appliedAt: new Date().toISOString(),
          placedFiles: [staleAgentPath],
          fileHashes: { [staleAgentPath]: 'deadbeef' },
          agentTeams: false,
        },
      },
    });

    const raw = JSON.parse(readFileSync(manifestPath(root), 'utf8'));
    const entry = raw.teams.generalist;
    const expectedRel = path.join('.claude', 'agents', 'x.md');

    assert.deepEqual(entry.placedFiles, [expectedRel]);
    assert.deepEqual(entry.fileHashes, { [expectedRel]: 'deadbeef' });
    // The concrete failure this guards against: without resolvePlacedPath()'s
    // rescue, path.relative(root, staleAgentPath) would produce a "../.."
    // climb out of root instead of landing on ".claude/agents/x.md".
    for (const key of [...Object.keys(entry.fileHashes), ...entry.placedFiles]) {
      assert.ok(!key.includes('..'), `stored path must not climb out of projectRoot: ${key}`);
    }
  });
});

describe('resolveFileHashes() applies the same re-rooting rule as resolvePlacedFiles()', () => {
  test('a v1-style absolute fileHashes key from a DIFFERENT original root is re-rooted onto projectRoot', () => {
    const root = makeProject();
    // Simulate a manifest that was written when the project lived at a
    // different absolute path (e.g. before a directory rename), the same
    // scenario resolvePlacedFiles() re-roots for placedFiles.
    const staleRoot = path.join(tmpdir(), 'some-other-original-location');
    const staleAbsPath = path.join(staleRoot, '.claude', 'agents', 'builder.md');

    const entry = { fileHashes: { [staleAbsPath]: 'cafef00d' } };
    const resolvedHashes = resolveFileHashes(entry, root);

    const placedFilesResolved = resolvePlacedFiles([staleAbsPath], root);

    // Both helpers must land on the identical absolute path for the same
    // input — this is the "fileHashes key and its placedFiles counterpart
    // always resolve to the same absolute path" guarantee.
    assert.equal(placedFilesResolved.length, 1);
    assert.ok(resolvedHashes.has(placedFilesResolved[0]));
    assert.equal(resolvedHashes.get(placedFilesResolved[0]), 'cafef00d');

    // And it must actually be re-rooted under THIS project's root, not left
    // pointing at the stale location.
    assert.ok(placedFilesResolved[0].startsWith(root + path.sep));
  });
});
