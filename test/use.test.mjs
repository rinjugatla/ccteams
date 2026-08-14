/**
 * Tests for lib/use.js's useTeam() hash recording (Issue #18 phase 1, D-2):
 * every file placed on disk gets a sha256 baseline recorded in the manifest's
 * fileHashes, computed from the file that actually landed on disk.
 *
 * These tests independently recompute each expected hash with node:crypto
 * rather than importing hashFileSync() from lib/hash.js, so a bug shared
 * between the implementation and the test's own hashing could not hide a
 * mismatch.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { useTeam } from '../lib/use.js';
import { readManifest, writeManifest, manifestPath, resolveFileHashes, resolvePlacedFiles } from '../lib/manifest.js';

const makeProject = () => mkdtempSync(path.join(tmpdir(), 'ccteams-use-'));

/** Independent sha256, deliberately NOT reusing lib/hash.js. */
const sha256 = (absPath) => createHash('sha256').update(readFileSync(absPath)).digest('hex');

describe('useTeam() — fileHashes recording', () => {
  test('every placedFiles entry gets a fileHashes entry matching the on-disk content', () => {
    const root = makeProject();

    const result = useTeam('generalist', root);
    assert.equal(result.success, true, result.message);

    const manifest = readManifest(root);
    const entry = manifest.teams.generalist;
    const placedAbs = resolvePlacedFiles(entry.placedFiles, root);
    const hashesAbs = resolveFileHashes(entry, root);

    assert.ok(placedAbs.length > 0, 'sanity check: useTeam() actually placed files');
    assert.equal(hashesAbs.size, placedAbs.length, 'every placed file must have a recorded hash');

    for (const abs of placedAbs) {
      assert.ok(existsSync(abs), `placed file missing on disk: ${abs}`);
      assert.equal(hashesAbs.get(abs), sha256(abs), `hash mismatch for ${abs}`);
    }
  });

  test('re-applying the same team recomputes fileHashes against the freshly-copied files', () => {
    const root = makeProject();

    useTeam('generalist', root);
    const firstManifest = readManifest(root);
    const firstHashes = resolveFileHashes(firstManifest.teams.generalist, root);

    const result = useTeam('generalist', root); // re-apply
    assert.equal(result.success, true, result.message);

    const secondManifest = readManifest(root);
    const secondEntry = secondManifest.teams.generalist;
    const placedAbs = resolvePlacedFiles(secondEntry.placedFiles, root);
    const secondHashes = resolveFileHashes(secondEntry, root);

    assert.equal(secondHashes.size, placedAbs.length);
    for (const abs of placedAbs) {
      assert.equal(secondHashes.get(abs), sha256(abs), `hash mismatch after re-apply for ${abs}`);
      // Same source, same dest, so the content — and therefore the hash — is
      // unchanged across the re-apply; this also confirms fileHashes was
      // actually rebuilt (not just carried over stale) on the second call.
      assert.equal(secondHashes.get(abs), firstHashes.get(abs), `hash drifted for unchanged content: ${abs}`);
    }
  });

  test('applying a second team preserves the first team\'s recorded fileHashes untouched', () => {
    const root = makeProject();

    useTeam('generalist', root);
    const beforeManifest = readManifest(root);
    const beforeHashes = resolveFileHashes(beforeManifest.teams.generalist, root);

    const result = useTeam('sveltekit', root);
    assert.equal(result.success, true, result.message);

    const afterManifest = readManifest(root);
    const afterHashes = resolveFileHashes(afterManifest.teams.generalist, root);

    assert.deepEqual([...afterHashes.entries()].sort(), [...beforeHashes.entries()].sort());
    assert.ok(afterManifest.teams.sveltekit.fileHashes, 'sveltekit must also get its own fileHashes recorded');
    assert.ok(Object.keys(afterManifest.teams.sveltekit.fileHashes).length > 0);
  });

  /**
   * Reproduces the staleness `ccteams migrate` (lib/migrate.js's
   * ownedFilesStep) can be fooled by: a shared dest (working-method) is
   * claimed by two teams' manifest entries, but until this fix, re-applying
   * ONE of them only rebuilt its OWN fileHashes — the other team's entry kept
   * whatever hash it recorded last, even after this run overwrote the actual
   * file. ownedFilesStep unions every claiming team's recorded hash into its
   * "known baseline" set, so a stale entry here would still count as a valid
   * past baseline forever, letting migrate silently overwrite a file the user
   * intentionally rolled back to that stale content.
   */
  test('re-applying one of two teams sharing a file syncs BOTH teams\' recorded hash to what is actually on disk', () => {
    const root = makeProject();
    useTeam('generalist', root);
    const applyResult = useTeam('sveltekit', root); // shares working-method with generalist
    assert.equal(applyResult.success, true, applyResult.message);

    const workingMethodPath = path.join(root, '.claude', 'skills', 'working-method', 'SKILL.md');
    assert.ok(existsSync(workingMethodPath), 'sanity check: both teams share working-method');

    // Simulate the staleness this fix targets: sveltekit's OWN recorded hash
    // for the shared file falls out of sync with what generalist last wrote
    // for it (e.g. the package's shared source changed between two applies) —
    // without touching the file on disk itself.
    const manifestBefore = readManifest(root);
    const staleHashesAbs = resolveFileHashes(manifestBefore.teams.sveltekit, root);
    staleHashesAbs.set(workingMethodPath, 'stale-hash-from-before-a-package-update');
    const staledTeamsMap = {
      ...manifestBefore.teams,
      sveltekit: { ...manifestBefore.teams.sveltekit, fileHashes: Object.fromEntries(staleHashesAbs) },
    };
    writeManifest(root, { teams: staledTeamsMap, agentTeamsFlagSet: manifestBefore.agentTeamsFlagSet === true });

    // Re-apply only generalist — this rewrites the shared file's bytes (to the
    // identical content, since the package source has not actually changed).
    const reapplyResult = useTeam('generalist', root);
    assert.equal(reapplyResult.success, true, reapplyResult.message);

    const actualHash = sha256(workingMethodPath);
    const manifestAfter = readManifest(root);
    const generalistHashesAbs = resolveFileHashes(manifestAfter.teams.generalist, root);
    const sveltekitHashesAbs = resolveFileHashes(manifestAfter.teams.sveltekit, root);

    assert.equal(generalistHashesAbs.get(workingMethodPath), actualHash);
    assert.equal(
      sveltekitHashesAbs.get(workingMethodPath),
      actualHash,
      'sveltekit\'s stale hash for the shared file must be synced by generalist\'s re-apply',
    );
  });
});

/**
 * Tests for useTeam()'s collision guard (lib/use.js step "2.8"): the sole
 * mechanism that keeps ccteams from ever overwriting a hand-written file. Had
 * NO direct test before this file (verified by grepping the whole test/
 * suite for "collision" / "refusing to overwrite hand-written" — the only
 * hit was mergeOwnedSourceIndex's unrelated primary-wins tie-break in
 * test/placement.test.mjs). This module's Issue #18 phase-2 work refactored
 * the guard's predicates (agentFiles.filter → agentPairs.filter(...).map
 * (path.basename), fs.existsSync(orchSrc) → orch !== null) without changing
 * its behavior — these tests pin that behavior down mechanically so a future
 * refactor of the same guard cannot silently break it unnoticed.
 */
describe('useTeam() — collision guard (never overwrite a hand-written file)', () => {
  test('a hand-written .claude/agents/builder.md blocks the apply, byte-for-byte unchanged, no manifest written', () => {
    const root = makeProject();
    const handWrittenPath = path.join(root, '.claude', 'agents', 'builder.md');
    mkdirSync(path.dirname(handWrittenPath), { recursive: true });
    const handWrittenContent = 'MY OWN builder.md — never written by ccteams\n';
    writeFileSync(handWrittenPath, handWrittenContent, 'utf8');

    const result = useTeam('generalist', root);

    assert.equal(result.success, false);
    assert.match(
      result.message,
      /refusing to overwrite hand-written file\(s\): .*\.claude\/agents\/builder\.md/,
    );
    assert.equal(
      readFileSync(handWrittenPath, 'utf8'),
      handWrittenContent,
      'the hand-written file must be byte-for-byte unchanged after a refused apply',
    );
    assert.equal(existsSync(manifestPath(root)), false, 'a refused apply must not write a manifest');
  });

  test('a hand-written .claude/ccteams/generalist.md (orchestration) blocks the apply, byte-for-byte unchanged', () => {
    const root = makeProject();
    const handWrittenPath = path.join(root, '.claude', 'ccteams', 'generalist.md');
    mkdirSync(path.dirname(handWrittenPath), { recursive: true });
    const handWrittenContent = 'MY OWN orchestration notes — never written by ccteams\n';
    writeFileSync(handWrittenPath, handWrittenContent, 'utf8');

    const result = useTeam('generalist', root);

    assert.equal(result.success, false);
    // The orchestration path in the message is OS-native (path.relative()'s
    // own separator — unlike the agent-file list, which is hardcoded with
    // forward slashes; see lib/use.js's collision-guard message assembly),
    // so match on the path segments rather than a literal forward-slash path.
    assert.match(result.message, /refusing to overwrite hand-written file\(s\): /);
    assert.match(result.message, /\.claude.*ccteams.*generalist\.md/);
    assert.equal(readFileSync(handWrittenPath, 'utf8'), handWrittenContent);
    assert.equal(existsSync(manifestPath(root)), false);
  });
});
