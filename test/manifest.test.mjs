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
  resolvePlacedPath,
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

describe('manifest entries are confined to projectRoot', () => {
  // An absolute path OUTSIDE the project with no ".claude/" segment for
  // resolvePlacedPath() to re-root on — the case its rescue cannot save.
  const outsideAbs = () => path.join(tmpdir(), 'ccteams-outside-project', 'stolen.md');
  // A relative entry that climbs out of the project.
  const outsideRel = () => path.join('..', '..', 'escaped.md');

  test('an out-of-project absolute entry is not written to the manifest', () => {
    const root = makeProject();
    const escapee = outsideAbs();

    writeManifest(root, {
      teams: {
        generalist: {
          appliedAt: new Date().toISOString(),
          placedFiles: [escapee],
          fileHashes: { [escapee]: 'deadbeef' },
          agentTeams: false,
        },
      },
    });

    const entry = JSON.parse(readFileSync(manifestPath(root), 'utf8')).teams.generalist;
    assert.deepEqual(entry.placedFiles, []);
    assert.deepEqual(Object.keys(entry.fileHashes), []);
  });

  test('a relative entry that climbs out of the project is not written either', () => {
    const root = makeProject();
    const escapee = outsideRel();

    writeManifest(root, {
      teams: {
        generalist: {
          appliedAt: new Date().toISOString(),
          placedFiles: [escapee],
          fileHashes: { [escapee]: 'deadbeef' },
          agentTeams: false,
        },
      },
    });

    const entry = JSON.parse(readFileSync(manifestPath(root), 'utf8')).teams.generalist;
    assert.deepEqual(entry.placedFiles, []);
    assert.deepEqual(Object.keys(entry.fileHashes), []);
  });

  test('legitimate entries survive alongside escaping ones — only the escapees are dropped', () => {
    const root = makeProject();
    const goodAbs = path.join(root, '.claude', 'agents', 'builder.md');
    const goodRel = path.join('.claude', 'skills', 'working-method', 'SKILL.md');
    const goodRelExpected = goodRel;
    const goodAbsExpected = path.join('.claude', 'agents', 'builder.md');

    writeManifest(root, {
      teams: {
        generalist: {
          appliedAt: new Date().toISOString(),
          placedFiles: [goodAbs, outsideAbs(), goodRel, outsideRel()],
          fileHashes: {
            [goodAbs]: 'aaa',
            [outsideAbs()]: 'bbb',
            [goodRel]: 'ccc',
            [outsideRel()]: 'ddd',
          },
          agentTeams: false,
        },
      },
    });

    const entry = JSON.parse(readFileSync(manifestPath(root), 'utf8')).teams.generalist;
    assert.deepEqual(entry.placedFiles, [goodAbsExpected, goodRelExpected]);
    assert.deepEqual(entry.fileHashes, { [goodAbsExpected]: 'aaa', [goodRelExpected]: 'ccc' });
    for (const key of [...Object.keys(entry.fileHashes), ...entry.placedFiles]) {
      assert.ok(!key.startsWith('..'), `stored path must not climb out of projectRoot: ${key}`);
    }
  });

  test('placedFiles and fileHashes reach the SAME verdict for the same entry', () => {
    const root = makeProject();
    const entries = [
      path.join(root, '.claude', 'agents', 'builder.md'),
      path.join('.claude', 'agents', 'reviewer.md'),
      path.join(tmpdir(), 'some-other-original-location', '.claude', 'agents', 'x.md'),
      outsideAbs(),
      outsideRel(),
    ];

    writeManifest(root, {
      teams: {
        generalist: {
          appliedAt: new Date().toISOString(),
          placedFiles: entries,
          fileHashes: Object.fromEntries(entries.map((f) => [f, 'deadbeef'])),
          agentTeams: false,
        },
      },
    });

    const entry = JSON.parse(readFileSync(manifestPath(root), 'utf8')).teams.generalist;
    // Neither list may keep an entry the other dropped.
    assert.deepEqual(new Set(Object.keys(entry.fileHashes)), new Set(entry.placedFiles));
    assert.equal(entry.placedFiles.length, 3);
  });

  test('an entry merely NAMED with leading dots (..keep.md) directly in the project root is kept', () => {
    const root = makeProject();

    writeManifest(root, {
      teams: {
        generalist: {
          appliedAt: new Date().toISOString(),
          placedFiles: ['..keep.md'],
          agentTeams: false,
        },
      },
    });

    // The relative form here IS "..keep.md" — it begins with ".." yet never
    // leaves the project. This is the case that separates the whole-segment
    // test (rel === '..' || rel.startsWith('..' + sep)) from a plain
    // rel.startsWith('..') prefix test, which would wrongly drop this file.
    // Nesting it under ".claude/" would NOT test that: the relative form
    // becomes ".claude\\..keep.md", which no longer starts with "..".
    const entry = JSON.parse(readFileSync(manifestPath(root), 'utf8')).teams.generalist;
    assert.deepEqual(entry.placedFiles, ['..keep.md']);
  });

  test('a leading-dots name nested under .claude/ is kept too', () => {
    const root = makeProject();
    const nested = path.join('.claude', '..keep.md');

    writeManifest(root, {
      teams: {
        generalist: {
          appliedAt: new Date().toISOString(),
          placedFiles: [nested],
          agentTeams: false,
        },
      },
    });

    const entry = JSON.parse(readFileSync(manifestPath(root), 'utf8')).teams.generalist;
    assert.deepEqual(entry.placedFiles, [nested]);
  });

  test('an absolute entry whose ".claude/" segment is followed by "../.." is re-rooted INTO an escape, and is dropped', () => {
    const root = makeProject();
    // Built by joining with path.sep rather than path.join(), on purpose:
    // path.join() would collapse the "../.." at construction time and strip
    // the ".claude" segment out of the string entirely, so the input would
    // never reach resolvePlacedPath()'s re-rooting branch — the very branch
    // under test. A manifest read from disk is an arbitrary string that has
    // had no such normalization applied to it.
    const escapee = [tmpdir(), 'evil', '.claude', '..', '..', '..', 'stolen.md'].join(path.sep);

    // Establishes the premise: the re-rooting rescue fires here and MANUFACTURES
    // a path outside the project (root/.claude/../../../stolen.md climbs out).
    // Containment is what turns that into a dropped entry.
    const rerooted = resolvePlacedPath(escapee, root);
    assert.ok(!rerooted.startsWith(root + path.sep), 're-rooting must have produced an escaping path');

    writeManifest(root, {
      teams: {
        generalist: {
          appliedAt: new Date().toISOString(),
          placedFiles: [escapee],
          fileHashes: { [escapee]: 'deadbeef' },
          agentTeams: false,
        },
      },
    });

    const entry = JSON.parse(readFileSync(manifestPath(root), 'utf8')).teams.generalist;
    assert.deepEqual(entry.placedFiles, []);
    assert.deepEqual(Object.keys(entry.fileHashes), []);
    assert.deepEqual(resolvePlacedFiles([escapee], root), []);
  });

  test('an absolute entry that starts with projectRoot but climbs out via ".." segments is dropped', () => {
    const root = makeProject();
    // Built by joining with path.sep rather than path.join(), on purpose:
    // path.join() would collapse the ".." at construction time and leave an
    // ordinary in-project path, so the branch under test would never be hit.
    // A manifest read from disk is an arbitrary string with no such
    // normalization applied to it.
    const sneaky = [root, '.claude', '..', '..', 'stolen.md'].join(path.sep);

    // Establishes the premise, and pins the design decision recorded in
    // isContained()'s doc comment: as a STRING this entry looks project-local,
    // so resolvePlacedPath() takes its "already under this root" early return
    // and hands the value back verbatim, WITHOUT normalizing it. A containment
    // check written as `resolved.startsWith(projectRoot + path.sep)` would
    // therefore wave it through. Only path.relative()'s normalization sees the
    // "../.." climb — which is exactly why isContained() is written on
    // path.relative() and not on a string-prefix comparison.
    assert.ok(sneaky.startsWith(root + path.sep), 'premise: the string looks project-local');
    assert.equal(
      resolvePlacedPath(sneaky, root),
      sneaky,
      'premise: returned verbatim by the early-return branch, unnormalized',
    );

    writeManifest(root, {
      teams: {
        generalist: {
          appliedAt: new Date().toISOString(),
          placedFiles: [sneaky],
          fileHashes: { [sneaky]: 'deadbeef' },
          agentTeams: false,
        },
      },
    });

    const entry = JSON.parse(readFileSync(manifestPath(root), 'utf8')).teams.generalist;
    assert.deepEqual(entry.placedFiles, []);
    assert.deepEqual(Object.keys(entry.fileHashes), []);
    assert.deepEqual(resolvePlacedFiles([sneaky], root), []);
    assert.equal(resolveFileHashes({ fileHashes: { [sneaky]: 'deadbeef' } }, root).size, 0);
  });

  test(
    'an absolute entry on a different Windows drive is dropped (path.relative returns an absolute path)',
    { skip: process.platform !== 'win32' ? 'Windows-only: only win32 has per-drive roots' : false },
    () => {
      const root = makeProject();
      // Pick a drive letter that is NOT the project's, so path.relative()
      // cannot express the relationship and returns an absolute path — the
      // case path.isAbsolute(rel) exists to catch.
      const otherDrive = root.slice(0, 1).toUpperCase() === 'C' ? 'D:' : 'C:';
      const escapee = path.join(otherDrive + path.sep, 'ccteams-outside-project', 'stolen.md');
      assert.ok(path.isAbsolute(path.relative(root, escapee)), 'premise: rel must be absolute here');

      writeManifest(root, {
        teams: {
          generalist: {
            appliedAt: new Date().toISOString(),
            placedFiles: [escapee],
            fileHashes: { [escapee]: 'deadbeef' },
            agentTeams: false,
          },
        },
      });

      const entry = JSON.parse(readFileSync(manifestPath(root), 'utf8')).teams.generalist;
      assert.deepEqual(entry.placedFiles, []);
      assert.deepEqual(Object.keys(entry.fileHashes), []);
      assert.deepEqual(resolvePlacedFiles([escapee], root), []);
    },
  );

  test('an entry that resolves to projectRoot itself (a directory, never a placed file) is dropped', () => {
    const root = makeProject();
    const selves = ['.', '', root];

    writeManifest(root, {
      teams: {
        generalist: {
          appliedAt: new Date().toISOString(),
          placedFiles: selves,
          fileHashes: Object.fromEntries(selves.map((f) => [f, 'deadbeef'])),
          agentTeams: false,
        },
      },
    });

    const entry = JSON.parse(readFileSync(manifestPath(root), 'utf8')).teams.generalist;
    assert.deepEqual(entry.placedFiles, []);
    assert.deepEqual(Object.keys(entry.fileHashes), []);
    assert.deepEqual(resolvePlacedFiles(selves, root), []);
  });

  test('resolvePlacedFiles() drops entries that resolve outside projectRoot', () => {
    const root = makeProject();
    const goodRel = path.join('.claude', 'agents', 'builder.md');

    const resolved = resolvePlacedFiles([goodRel, outsideAbs(), outsideRel()], root);

    // unuse.js deletes every path this returns, so an escapee here would be a
    // delete outside the project.
    assert.deepEqual(resolved, [path.join(root, goodRel)]);
  });

  test('resolveFileHashes() drops keys that resolve outside projectRoot', () => {
    const root = makeProject();
    const goodRel = path.join('.claude', 'agents', 'builder.md');

    const resolved = resolveFileHashes(
      { fileHashes: { [goodRel]: 'aaa', [outsideAbs()]: 'bbb', [outsideRel()]: 'ccc' } },
      root,
    );

    assert.equal(resolved.size, 1);
    assert.equal(resolved.get(path.join(root, goodRel)), 'aaa');
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
