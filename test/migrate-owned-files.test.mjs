/**
 * Tests for lib/migrate.js's ownedFilesStep (Issue #18 phase 2, sub-D):
 * detecting and reconciling drift in ccteams-OWNED files — agent
 * definitions, playbook skills, and the shared working-method skill — by
 * comparing the package's current source (U), the project's on-disk content
 * (P), and the baseline hash ccteams recorded when it placed the file (B).
 *
 * Fixtures use the REAL generalist team package (via useTeam()), never a
 * synthetic manifest, per this repo's convention: it is the most faithful
 * way to reproduce the src→dest resolution ownedFilesStep itself depends on
 * (see lib/placement.js). The package's own source files are never modified
 * by any test here — doing so would dirty the repo; "upstream changed" is
 * instead simulated by moving the PROJECT's file and its recorded baseline
 * together (see simulateUpstreamChange()), which produces the identical
 * P == B, both != U condition a real upstream change would.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { migrate, formatMigrateReport, classifyOwnedFile } from '../lib/migrate.js';
import { useTeam } from '../lib/use.js';
import { unuseTeam } from '../lib/unuse.js';
import { manifestPath, readManifest, writeManifest, resolveFileHashes } from '../lib/manifest.js';
import { buildOwnedSourceIndex } from '../lib/placement.js';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BIN = path.join(REPO_ROOT, 'bin', 'ccteams.js');

const makeProject = () => mkdtempSync(path.join(tmpdir(), 'ccteams-migrate-owned-'));

/** Independent sha256, deliberately NOT reusing lib/hash.js (matches test/use.test.mjs's convention). */
const sha256 = (absPath) => createHash('sha256').update(readFileSync(absPath)).digest('hex');

/** Apply the real generalist team — the fixture every test in this file starts from. */
function makeGeneralistProject() {
  const root = makeProject();
  const result = useTeam('generalist', root);
  assert.equal(result.success, true, result.message);
  return root;
}

const agentPath = (root, name) => path.join(root, '.claude', 'agents', name);

/** Resolve the CURRENT package source ownedFilesStep would compare `destAbs` against. */
function packageSrcFor(root, destAbs) {
  const manifest = readManifest(root);
  const { index } = buildOwnedSourceIndex(manifest, root);
  return index.get(destAbs);
}

const ownedStepOf = (result) => result.steps.find((s) => s.id === 'ccteams-owned-files');

/** Overwrite `destAbs` with different bytes, WITHOUT touching the recorded
 * baseline — this is what a real hand-edit looks like: P moves, B stays put. */
function editProjectFile(destAbs, content = 'USER EDITED — hands off\n') {
  writeFileSync(destAbs, content, 'utf8');
}

/**
 * Simulate "upstream changed" without touching the package's own source
 * (forbidden — would dirty the repo): move the PROJECT's file AND its
 * recorded baseline together to some other content, leaving the real
 * package source (U) untouched. Now hash(P) === the recorded baseline, and
 * both differ from hash(U) — exactly the upstream-changed condition (the
 * project never touched the file relative to what ccteams last recorded;
 * only the package's own source moved on since).
 */
function simulateUpstreamChange(root, teamName, destAbs, content = 'PRETEND THIS PREDATES THE CURRENT PACKAGE\n') {
  writeFileSync(destAbs, content, 'utf8');
  const manifest = readManifest(root);
  const entry = manifest.teams[teamName];
  const hashesAbs = resolveFileHashes(entry, root);
  hashesAbs.set(destAbs, sha256(destAbs));
  const teamsMap = { ...manifest.teams, [teamName]: { ...entry, fileHashes: Object.fromEntries(hashesAbs) } };
  writeManifest(root, { teams: teamsMap, agentTeamsFlagSet: manifest.agentTeamsFlagSet === true });
}

/** Degrade the on-disk manifest to v3 (no fileHashes anywhere) — reproduces a
 * pre-v4 project's manifest, including the version string. */
function stripManifestToV3(root) {
  const mPath = manifestPath(root);
  const raw = JSON.parse(readFileSync(mPath, 'utf8'));
  raw.version = '3';
  for (const entry of Object.values(raw.teams)) delete entry.fileHashes;
  writeFileSync(mPath, JSON.stringify(raw, null, 2) + '\n', 'utf8');
}

/** Add a placedFiles entry with no corresponding CURRENT package source —
 * this is what "orphaned" looks like (a removed/renamed team, or a file that
 * dropped out of a still-shipped team's current file set). */
function addOrphanedFile(root, teamName) {
  const relPath = path.join('.claude', 'agents', 'nonexistent-agent-xyz.md');
  const absPath = path.join(root, relPath);
  mkdirSync(path.dirname(absPath), { recursive: true });
  writeFileSync(absPath, 'orphaned leftover file\n', 'utf8');
  const manifest = readManifest(root);
  const entry = manifest.teams[teamName];
  const teamsMap = { ...manifest.teams, [teamName]: { ...entry, placedFiles: [...entry.placedFiles, relPath] } };
  writeManifest(root, { teams: teamsMap, agentTeamsFlagSet: manifest.agentTeamsFlagSet === true });
  return absPath;
}

/** Add a whole team entry the package no longer ships — its files must never be touched. */
function addUnknownTeamEntry(root) {
  const relPath = path.join('.claude', 'agents', 'unknown-team-agent.md');
  const absPath = path.join(root, relPath);
  mkdirSync(path.dirname(absPath), { recursive: true });
  writeFileSync(absPath, 'file from a team ccteams no longer ships\n', 'utf8');
  const manifest = readManifest(root);
  const teamsMap = {
    ...manifest.teams,
    'a-team-that-was-removed': {
      appliedAt: new Date().toISOString(),
      placedFiles: [relPath],
      fileHashes: {},
      agentTeams: false,
    },
  };
  writeManifest(root, { teams: teamsMap, agentTeamsFlagSet: manifest.agentTeamsFlagSet === true });
  return absPath;
}

/**
 * Recursively snapshot every file under `dir` as { "relative/posix/path": base64 }.
 * Returns {} if the directory does not exist (same convention as test/migrate.test.mjs).
 */
function snapshotDir(dir) {
  const map = {};
  if (!existsSync(dir)) return map;
  const walk = (d, relBase) => {
    for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
      const abs = path.join(d, entry.name);
      const rel = relBase ? path.join(relBase, entry.name) : entry.name;
      if (entry.isDirectory()) {
        walk(abs, rel);
        continue;
      }
      map[rel.split(path.sep).join('/')] = fs.readFileSync(abs).toString('base64');
    }
  };
  walk(dir, '');
  return map;
}

/**
 * Direct unit tests for classifyOwnedFile() (lib/migrate.js) — no
 * filesystem, so every input combination, including the null-hash edge
 * cases hashFileSync() produces for an unreadable file, is testable without
 * fixtures. Added by a code review that found a real bug in the pre-refactor
 * inline version: `pHash === uHash` alone would treat `null === null`
 * (source AND dest both unreadable) as a verified 'unchanged' match, when no
 * byte was ever actually compared.
 */
describe('classifyOwnedFile() — pure classifier, all input combinations', () => {
  const EMPTY = new Set();
  const SOME_BASELINE = new Set(['baseline-hash']);

  test('no source at all -> orphaned, regardless of every other input', () => {
    assert.equal(
      classifyOwnedFile({ hasSource: false, exists: true, uHash: 'x', pHash: 'x', baselineHashes: SOME_BASELINE }),
      'orphaned',
    );
    assert.equal(
      classifyOwnedFile({ hasSource: false, exists: false, uHash: null, pHash: null, baselineHashes: EMPTY }),
      'orphaned',
    );
  });

  test('uHash === null (package source unreadable) -> unreadable, NEVER unchanged, even when pHash is also null', () => {
    // This is the exact bug the code review found: null === null must not
    // be mistaken for a verified content match.
    assert.equal(
      classifyOwnedFile({ hasSource: true, exists: true, uHash: null, pHash: null, baselineHashes: EMPTY }),
      'unreadable',
    );
    assert.equal(
      classifyOwnedFile({ hasSource: true, exists: false, uHash: null, pHash: null, baselineHashes: EMPTY }),
      'unreadable',
      'a missing dest must not be "restored" from a source that could not itself be read',
    );
  });

  test('pHash === null while dest exists (unreadable, not missing) -> unreadable, never unchanged', () => {
    assert.equal(
      classifyOwnedFile({ hasSource: true, exists: true, uHash: 'u-hash', pHash: null, baselineHashes: EMPTY }),
      'unreadable',
    );
  });

  test('dest absent, source readable -> missing', () => {
    assert.equal(
      classifyOwnedFile({ hasSource: true, exists: false, uHash: 'u-hash', pHash: null, baselineHashes: EMPTY }),
      'missing',
    );
  });

  test('pHash === uHash (both non-null) -> unchanged', () => {
    assert.equal(
      classifyOwnedFile({ hasSource: true, exists: true, uHash: 'same', pHash: 'same', baselineHashes: EMPTY }),
      'unchanged',
    );
  });

  test('pHash differs from uHash, and matches a recorded baseline -> upstream-changed', () => {
    assert.equal(
      classifyOwnedFile({
        hasSource: true,
        exists: true,
        uHash: 'new-upstream-hash',
        pHash: 'old-baseline-hash',
        baselineHashes: new Set(['old-baseline-hash']),
      }),
      'upstream-changed',
    );
  });

  test('pHash differs from uHash, baseline recorded but does not match -> user-modified', () => {
    assert.equal(
      classifyOwnedFile({
        hasSource: true,
        exists: true,
        uHash: 'upstream-hash',
        pHash: 'edited-hash',
        baselineHashes: new Set(['original-hash']),
      }),
      'user-modified',
    );
  });

  test('pHash differs from uHash, no baseline recorded at all -> unknown-baseline', () => {
    assert.equal(
      classifyOwnedFile({ hasSource: true, exists: true, uHash: 'upstream-hash', pHash: 'edited-hash', baselineHashes: EMPTY }),
      'unknown-baseline',
    );
  });
});

describe('ownedFilesStep — unreadable file (real filesystem, Windows-safe reproduction)', () => {
  test('a directory squatting where a file is expected is reported as unreadable, not silently skipped as unchanged', async () => {
    // hashFileSync() returns null for a directory (fs.readFileSync() throws
    // EISDIR) — this reproduces the null/null edge case classifyOwnedFile()
    // now handles, via a real fixture rather than only the pure unit tests
    // above. A permission-denied (EACCES) file is the more realistic
    // trigger in production, but chmod-based unreadable-file fixtures are
    // unreliable on Windows (no POSIX permission bits), so a directory
    // squatting on the destination is the portable way to force
    // hashFileSync() to fail on a file that nonetheless `existsSync()`s.
    const root = makeGeneralistProject();
    const dest = agentPath(root, 'builder.md');
    const baselineBefore = resolveFileHashes(readManifest(root).teams.generalist, root).get(dest);
    fs.rmSync(dest);
    mkdirSync(dest); // now exists, but is not a readable file

    const result = await migrate(root);

    const step = ownedStepOf(result);
    assert.deepEqual(step.added, []);
    assert.deepEqual(step.updated, []);
    assert.ok(
      step.notices.some((l) => l.includes('.claude/agents/builder.md')),
      `expected an unreadable-file notice, got:\n${step.notices.join('\n')}`,
    );
    assert.ok(
      step.notices.some((l) => l.includes('could not be read')),
      `expected the "could not be read" wording, got:\n${step.notices.join('\n')}`,
    );
    // Must NOT be silently recorded as if content had been verified to
    // match — the baseline recorded at useTeam()-apply time must be left
    // exactly as it was, not overwritten (with `null`, or anything else)
    // by a comparison that never actually happened.
    const manifest = readManifest(root);
    const hashesAbs = resolveFileHashes(manifest.teams.generalist, root);
    assert.equal(hashesAbs.get(dest), baselineBefore, 'the pre-existing baseline must be untouched by an unverified file');
  });
});

describe('ownedFilesStep — a write failure is reported cleanly, not as a raw fs stack trace', () => {
  test('mkdirSync failing mid-write surfaces as "Could not write ..." (same treatment as teamLessonsScaffoldStep)', async () => {
    const root = makeGeneralistProject();
    const agentsDir = path.join(root, '.claude', 'agents');
    // Delete the whole agents directory and squat a plain FILE where it used
    // to be: every agent dest now classifies as `missing` (existsSync()
    // reports false through a non-directory parent segment), and the first
    // write attempt's `fs.mkdirSync(path.dirname(dest), {recursive:true})`
    // then fails because that path is now a file, not a directory — the
    // most portable way to force a real mkdirSync/copyFileSync failure
    // without relying on POSIX permission bits (unreliable on Windows).
    fs.rmSync(agentsDir, { recursive: true, force: true });
    writeFileSync(agentsDir, 'squatting file where .claude/agents used to be\n', 'utf8');

    let result;
    await assert.doesNotReject(async () => {
      result = await migrate(root);
    });

    assert.equal(result.success, false);
    assert.match(result.message, /Could not write "\.claude\/agents\//);
    assert.ok(
      !/\n\s+at /.test(result.message),
      `message should not contain a raw stack trace:\n${result.message}`,
    );
  });
});

describe('ownedFilesStep — six-state classification', () => {
  test('unchanged: a freshly applied team reports nothing for owned files', async () => {
    const root = makeGeneralistProject();

    const result = await migrate(root);
    const step = ownedStepOf(result);

    assert.deepEqual(step.added, []);
    assert.deepEqual(step.updated, []);
    assert.deepEqual(step.notices, []);
  });

  test('missing: a deleted placed file is restored and counted as added', async () => {
    const root = makeGeneralistProject();
    const dest = agentPath(root, 'builder.md');
    const src = packageSrcFor(root, dest);
    fs.rmSync(dest);

    const result = await migrate(root);

    assert.ok(existsSync(dest), 'the file must be restored');
    assert.ok(readFileSync(dest).equals(readFileSync(src)), 'restored content must match the package source');
    assert.ok(ownedStepOf(result).added.includes('.claude/agents/builder.md'));
    assert.ok(result.pending >= 1);
  });

  test('upstream-changed: updated automatically, with no confirmation needed and no notice', async () => {
    const root = makeGeneralistProject();
    const dest = agentPath(root, 'builder.md');
    const src = packageSrcFor(root, dest);
    simulateUpstreamChange(root, 'generalist', dest);

    const result = await migrate(root); // no yes/force/prompt — must still auto-update

    assert.ok(
      readFileSync(dest).equals(readFileSync(src)),
      'content must match the CURRENT package source after the update',
    );
    const step = ownedStepOf(result);
    assert.ok(step.updated.includes('.claude/agents/builder.md'));
    assert.deepEqual(step.notices, [], 'an upstream-changed file must not need a notice');
  });

  test('user-modified: left unchanged by default, with a notice that says the user edited it', async () => {
    const root = makeGeneralistProject();
    const dest = agentPath(root, 'builder.md');
    editProjectFile(dest, 'MY OWN builder.md CHANGES\n');

    const result = await migrate(root); // default: no --yes, no --force, no prompt available

    // Byte-for-byte: the user's edit must survive verbatim.
    assert.ok(readFileSync(dest).equals(Buffer.from('MY OWN builder.md CHANGES\n', 'utf8')));
    const step = ownedStepOf(result);
    assert.deepEqual(step.updated, []);
    assert.ok(
      step.notices.some((l) => l.includes('.claude/agents/builder.md')),
      `expected a notice naming the file, got:\n${step.notices.join('\n')}`,
    );
    assert.ok(
      step.notices.some((l) => l.includes('you have edited')),
      'user-modified DID verify a baseline mismatch — it is allowed to say the user edited it',
    );
  });

  test('unknown-baseline: a v3 manifest (no fileHashes) degrades to unknown-baseline, and the file is NOT overwritten', async () => {
    const root = makeGeneralistProject();
    const dest = agentPath(root, 'builder.md');
    editProjectFile(dest, 'CONTENT THAT DIFFERS, WITH NO BASELINE RECORDED\n');
    stripManifestToV3(root);
    const before = readFileSync(dest); // Buffer — byte-level

    const result = await migrate(root);

    // Direct, byte-level, non-negotiable assertion: the file must be untouched.
    assert.ok(readFileSync(dest).equals(before), 'a v3-degraded file must not be overwritten by default');
    const step = ownedStepOf(result);
    assert.deepEqual(step.updated, []);
    assert.ok(step.notices.some((l) => l.includes('.claude/agents/builder.md')));
    // The wording invariant: this branch never established WHO changed the
    // file, only that ccteams has no baseline recorded for it — it must not
    // claim the user edited it (see buildOwnedFilesNotices()'s doc comment
    // in lib/migrate.js).
    assert.ok(
      !step.notices.some((l) => l.includes('you have edited')),
      `unknown-baseline notice must not claim the user edited the file, got:\n${step.notices.join('\n')}`,
    );
  });

  test('orphaned: a placedFiles entry with no current package source is left untouched, never deleted, and reported', async () => {
    const root = makeGeneralistProject();
    const orphanPath = addOrphanedFile(root, 'generalist');
    const before = readFileSync(orphanPath);

    const result = await migrate(root);

    assert.ok(existsSync(orphanPath), 'an orphaned file must never be deleted');
    assert.ok(readFileSync(orphanPath).equals(before), 'an orphaned file must never be rewritten');
    const step = ownedStepOf(result);
    assert.ok(
      step.notices.some((l) => l.includes('nonexistent-agent-xyz.md')),
      `expected an orphaned-file notice, got:\n${step.notices.join('\n')}`,
    );
  });

  test('unknown team: an entire team entry the package no longer ships is left untouched and reported by name', async () => {
    const root = makeGeneralistProject();
    const unknownPath = addUnknownTeamEntry(root);
    const before = readFileSync(unknownPath);

    const result = await migrate(root);

    assert.ok(existsSync(unknownPath));
    assert.ok(readFileSync(unknownPath).equals(before));
    const step = ownedStepOf(result);
    assert.ok(
      step.notices.some((l) => l.includes('a-team-that-was-removed')),
      `expected the unknown team name in a notice, got:\n${step.notices.join('\n')}`,
    );
  });
});

describe('ownedFilesStep — --yes / --force gating', () => {
  test('--force alone (no --yes) does not overwrite a user-modified file', async () => {
    const root = makeGeneralistProject();
    const dest = agentPath(root, 'builder.md');
    editProjectFile(dest, 'USER EDIT\n');
    const before = readFileSync(dest);

    await migrate(root, { force: true }); // no yes

    assert.ok(readFileSync(dest).equals(before));
  });

  test('--yes alone does not overwrite a user-modified file', async () => {
    const root = makeGeneralistProject();
    const dest = agentPath(root, 'builder.md');
    editProjectFile(dest, 'USER EDIT\n');
    const before = readFileSync(dest);

    await migrate(root, { yes: true });

    assert.ok(readFileSync(dest).equals(before));
  });

  test('--yes --force together overwrite a user-modified file', async () => {
    const root = makeGeneralistProject();
    const dest = agentPath(root, 'builder.md');
    const src = packageSrcFor(root, dest);
    editProjectFile(dest, 'USER EDIT\n');

    const result = await migrate(root, { yes: true, force: true });

    assert.ok(readFileSync(dest).equals(readFileSync(src)));
    assert.ok(ownedStepOf(result).updated.includes('.claude/agents/builder.md'));
  });

  test('--yes --force also overwrites an unknown-baseline file', async () => {
    const root = makeGeneralistProject();
    const dest = agentPath(root, 'builder.md');
    const src = packageSrcFor(root, dest);
    editProjectFile(dest, 'CONTENT WITH NO BASELINE\n');
    stripManifestToV3(root);

    const result = await migrate(root, { yes: true, force: true });

    assert.ok(readFileSync(dest).equals(readFileSync(src)));
    assert.ok(ownedStepOf(result).updated.includes('.claude/agents/builder.md'));
  });
});

describe('ownedFilesStep — non-interactive safety (no hang, no prompt)', () => {
  test('a direct migrate() call with no injected prompt never prompts (this test process is not a TTY)', { timeout: 5000 }, async () => {
    const root = makeGeneralistProject();
    const dest = agentPath(root, 'builder.md');
    editProjectFile(dest, 'USER EDIT\n');
    const before = readFileSync(dest);

    // opts.prompt is intentionally omitted — falls back to autodetection,
    // which must resolve to "no prompting" here because `node --test`'s
    // own stdin is not a TTY.
    const result = await migrate(root);

    assert.ok(readFileSync(dest).equals(before));
    assert.equal(result.success, true);
  });

  test('CLI: no --yes, non-TTY stdin — does not hang and leaves a user-modified file untouched', () => {
    const root = makeGeneralistProject();
    const dest = agentPath(root, 'builder.md');
    editProjectFile(dest, 'USER EDIT\n');
    const before = readFileSync(dest);

    const result = spawnSync(process.execPath, [BIN, 'migrate'], {
      cwd: root,
      encoding: 'utf8',
      timeout: 15000,
      env: { ...process.env, CI: '1', NO_UPDATE_NOTIFIER: '1' },
    });

    assert.equal(result.signal, null, 'the process must not have been killed by the timeout (it would hang if a prompt was incorrectly offered)');
    assert.equal(result.status, 0);
    assert.ok(readFileSync(dest).equals(before));
  });
});

describe('ownedFilesStep — --dry-run writes nothing', () => {
  test('dry-run leaves .claude/ AND the manifest byte-identical, across missing/upstream-changed/user-modified at once', async () => {
    const root = makeGeneralistProject();
    const missingDest = agentPath(root, 'shipper.md');
    const upstreamDest = agentPath(root, 'architect.md');
    const userModDest = agentPath(root, 'builder.md');
    fs.rmSync(missingDest);
    simulateUpstreamChange(root, 'generalist', upstreamDest);
    editProjectFile(userModDest, 'USER EDIT\n');

    const dotClaudeDir = path.join(root, '.claude');
    const beforeClaude = snapshotDir(dotClaudeDir);
    const beforeManifest = readFileSync(manifestPath(root));

    const dryResult = await migrate(root, { dryRun: true });

    const afterClaude = snapshotDir(dotClaudeDir);
    assert.deepEqual(afterClaude, beforeClaude, 'dry-run must not write anything under .claude/');
    assert.ok(readFileSync(manifestPath(root)).equals(beforeManifest), 'dry-run must not touch the manifest');

    const step = ownedStepOf(dryResult);
    assert.ok(step.added.includes('.claude/agents/shipper.md'));
    assert.ok(step.updated.includes('.claude/agents/architect.md'));
    assert.ok(step.notices.some((l) => l.includes('.claude/agents/builder.md')));
    assert.equal(dryResult.exitCode, 1, 'restoring a missing file and updating an upstream-changed one without asking is pending work');
  });

  // The user-modified/unknown-baseline OVERWRITE branch is the only write in
  // ownedFilesStep that the test above cannot reach: it fires solely under
  // --yes --force, which that test does not pass. `--dry-run --yes --force`
  // is a combination the CLI accepts (all three are known flags, and the
  // `force && !yes` rejection does not apply), so it is a real user-facing
  // path — and without this test, deleting that branch's `if (!dryRun)`
  // guard silently overwrites the user's edit while the suite stays green.
  test('--dry-run --yes --force reports the overwrite but writes zero bytes', async () => {
    const root = makeGeneralistProject();
    const userModDest = agentPath(root, 'builder.md');
    editProjectFile(userModDest, 'USER EDIT\n');

    const dotClaudeDir = path.join(root, '.claude');
    const beforeClaude = snapshotDir(dotClaudeDir);
    const beforeManifest = readFileSync(manifestPath(root));

    const result = await migrate(root, { dryRun: true, yes: true, force: true });

    assert.deepEqual(
      snapshotDir(dotClaudeDir),
      beforeClaude,
      '--dry-run --yes --force must not write anything under .claude/',
    );
    assert.ok(
      readFileSync(manifestPath(root)).equals(beforeManifest),
      '--dry-run --yes --force must not touch the manifest',
    );
    assert.ok(
      readFileSync(userModDest).equals(Buffer.from('USER EDIT\n')),
      'the user edit must survive a forced DRY run',
    );
    assert.ok(
      ownedStepOf(result).updated.includes('.claude/agents/builder.md'),
      'the overwrite it would have performed must still be reported',
    );
  });
});

describe('ownedFilesStep — exitCode: only unattended work counts, skips and notices never do', () => {
  test('--dry-run exitCode is 1 when only an upstream-changed file needs updating (no missing file involved)', async () => {
    const root = makeGeneralistProject();
    simulateUpstreamChange(root, 'generalist', agentPath(root, 'builder.md'));

    const result = await migrate(root, { dryRun: true });

    assert.equal(result.pending, 0, 'sanity check: nothing is MISSING in this fixture');
    assert.ok(result.updates >= 1, 'sanity check: the upstream-changed file counts as an update');
    assert.equal(result.exitCode, 1, '`updates` alone must be enough to flip exitCode to 1 under --dry-run');
  });

  test('--dry-run exitCode is 0 when the only drift is a user-modified/unknown-baseline file (skip-only, notice-only)', async () => {
    const root = makeGeneralistProject();
    editProjectFile(agentPath(root, 'builder.md'), 'USER EDIT\n');

    const result = await migrate(root, { dryRun: true });

    assert.equal(result.pending, 0);
    assert.equal(result.updates, 0);
    assert.ok(ownedStepOf(result).notices.length > 0, 'sanity check: a notice was actually produced');
    assert.equal(result.exitCode, 0, 'a skipped file needing a human decision must not flip exitCode under --dry-run');
  });
});

describe('ownedFilesStep — baseline hash bookkeeping', () => {
  test('overwriting an upstream-changed file updates its recorded baseline to the CURRENT package source hash', async () => {
    const root = makeGeneralistProject();
    const dest = agentPath(root, 'builder.md');
    const src = packageSrcFor(root, dest);
    simulateUpstreamChange(root, 'generalist', dest);

    const result = await migrate(root);

    const manifest = readManifest(root);
    const hashesAbs = resolveFileHashes(manifest.teams.generalist, root);
    assert.equal(hashesAbs.get(dest), sha256(src), 'recorded baseline must equal the package source hash, independently computed');
    assert.equal(hashesAbs.get(dest), sha256(dest), 'and must equal the file that is now actually on disk');
    assert.match(result.message, /Recorded baseline hashes for \d+ ccteams-owned file/);
  });

  test('overwriting a user-modified file (via --yes --force) updates its recorded baseline too', async () => {
    const root = makeGeneralistProject();
    const dest = agentPath(root, 'builder.md');
    const src = packageSrcFor(root, dest);
    editProjectFile(dest, 'USER EDIT\n');

    await migrate(root, { yes: true, force: true });

    const manifest = readManifest(root);
    const hashesAbs = resolveFileHashes(manifest.teams.generalist, root);
    assert.equal(hashesAbs.get(dest), sha256(src));
  });

  test('a skipped user-modified file keeps its OLD recorded baseline (never silently adopts the rejected edit)', async () => {
    const root = makeGeneralistProject();
    const dest = agentPath(root, 'builder.md');
    const manifestBefore = readManifest(root);
    const originalBaseline = resolveFileHashes(manifestBefore.teams.generalist, root).get(dest);
    editProjectFile(dest, 'USER EDIT\n');

    await migrate(root); // default: skipped

    const manifestAfter = readManifest(root);
    const baselineAfter = resolveFileHashes(manifestAfter.teams.generalist, root).get(dest);
    assert.equal(baselineAfter, originalBaseline);
  });

  test('dry-run reports the would-be baseline count but records nothing', async () => {
    const root = makeGeneralistProject();
    const dest = agentPath(root, 'builder.md');
    simulateUpstreamChange(root, 'generalist', dest);
    const manifestBefore = readFileSync(manifestPath(root));

    const result = await migrate(root, { dryRun: true });

    assert.ok(readFileSync(manifestPath(root)).equals(manifestBefore));
    assert.match(result.message, /Would record baseline hashes for \d+ ccteams-owned file/);
  });
});

describe('ownedFilesStep — team-lessons is never in scope', () => {
  test('an edited team-lessons SKILL.md is untouched and never appears in ownedFilesStep\'s report', async () => {
    const root = makeGeneralistProject();
    const skillPath = path.join(root, '.claude', 'skills', 'team-lessons', 'SKILL.md');
    const editedContent = 'HAND-WRITTEN team-lessons content — must never be touched by ownedFilesStep\n';
    writeFileSync(skillPath, editedContent, 'utf8');

    const result = await migrate(root);

    assert.equal(readFileSync(skillPath, 'utf8'), editedContent, 'byte-for-byte unchanged');
    const step = ownedStepOf(result);
    const allPaths = [...step.added, ...step.updated, ...step.notices].join('\n');
    assert.ok(!allPaths.includes('team-lessons'), `team-lessons must never appear in ownedFilesStep's report, got:\n${allPaths}`);
  });
});

describe('ownedFilesStep — playbook and working-method skills are both in scope', () => {
  test('an edited generalist-playbook file AND an edited working-method file are both reported', async () => {
    const root = makeGeneralistProject();
    const playbookPath = path.join(root, '.claude', 'skills', 'generalist-playbook', 'SKILL.md');
    const workingMethodPath = path.join(root, '.claude', 'skills', 'working-method', 'SKILL.md');
    assert.ok(existsSync(playbookPath), 'sanity check: generalist ships this file');
    assert.ok(existsSync(workingMethodPath), 'sanity check: generalist ships working-method');
    editProjectFile(playbookPath, 'USER EDIT TO PLAYBOOK\n');
    editProjectFile(workingMethodPath, 'USER EDIT TO WORKING-METHOD\n');

    const result = await migrate(root);

    const notices = ownedStepOf(result).notices.join('\n');
    assert.ok(notices.includes('generalist-playbook/SKILL.md'), `expected a generalist-playbook notice, got:\n${notices}`);
    assert.ok(notices.includes('working-method/SKILL.md'), `expected a working-method notice, got:\n${notices}`);
  });
});

describe('unuseTeam() after migrate() — refcount deletion still works', () => {
  test('applying two teams, running migrate(), then unusing one leaves the other\'s shared files intact', async () => {
    const root = makeProject();
    useTeam('generalist', root);
    useTeam('sveltekit', root); // shares working-method with generalist

    await migrate(root); // must not disturb refcounting

    const workingMethodPath = path.join(root, '.claude', 'skills', 'working-method', 'SKILL.md');
    assert.ok(existsSync(workingMethodPath));

    const unuseResult = unuseTeam('generalist', root);
    assert.equal(unuseResult.success, true, unuseResult.message);

    // working-method is still claimed by sveltekit — must survive.
    assert.ok(existsSync(workingMethodPath), 'shared working-method file must survive removing one of two teams that claim it');
    // generalist-only files must be gone.
    assert.ok(!existsSync(path.join(root, '.claude', 'skills', 'generalist-playbook')));

    const unuseResult2 = unuseTeam('sveltekit', root);
    assert.equal(unuseResult2.success, true, unuseResult2.message);
    assert.ok(!existsSync(workingMethodPath), 'once no team claims it, working-method must finally be removed');
  });
});

describe('ownedFilesStep — interactive prompt flow', () => {
  /** A promptFn stub that returns pre-scripted answers in order, and records every question it was asked. */
  function makeQueuePrompt(answers) {
    const calls = [];
    const fn = async (question) => {
      calls.push(question);
      if (answers.length === 0) throw new Error('prompt called more times than the test scripted');
      return answers.shift();
    };
    fn.calls = calls;
    return fn;
  }

  test('the unknown-baseline PROMPT never claims the user edited the file (mirrors the notice-side invariant)', async () => {
    const root = makeGeneralistProject();
    const dest = agentPath(root, 'builder.md');
    editProjectFile(dest, 'CONTENT WITH NO BASELINE\n');
    stripManifestToV3(root);

    const prompt = makeQueuePrompt(['n']);
    await migrate(root, { prompt });

    assert.equal(prompt.calls.length, 1);
    const question = prompt.calls[0];
    assert.doesNotMatch(
      question,
      /you have modified/,
      'unknown-baseline never verified WHO changed the file — the prompt must not claim the user edited it',
    );
    assert.match(question, /No baseline hash was/);
    // The exact option line Issue #18 §4 specifies verbatim — safe to assert as text.
    assert.match(question, /\[y\] overwrite {2}\[n\] keep mine {2}\[d\] show diff {2}\[a\] overwrite all {2}\[q\] quit/);
  });

  test('the user-modified PROMPT explicitly says the user edited the file (mirror of the above — kills a swapped-wording mutation either direction)', async () => {
    const root = makeGeneralistProject();
    const dest = agentPath(root, 'builder.md');
    editProjectFile(dest, 'USER EDIT\n');

    const prompt = makeQueuePrompt(['n']);
    await migrate(root, { prompt });

    assert.equal(prompt.calls.length, 1);
    assert.match(prompt.calls[0], /you have modified this file, and ccteams has a newer version/);
  });

  test('"y" overwrites just that file; "n" keeps just that file', async () => {
    const root = makeGeneralistProject();
    const architectDest = agentPath(root, 'architect.md');
    const architectSrc = packageSrcFor(root, architectDest);
    const builderDest = agentPath(root, 'builder.md');
    editProjectFile(architectDest, 'USER EDIT — architect\n');
    editProjectFile(builderDest, 'USER EDIT — builder\n');

    // Processing order is the display path's ASCII sort — architect.md
    // sorts before builder.md, so this is the deterministic answer order.
    const prompt = makeQueuePrompt(['y', 'n']);
    await migrate(root, { prompt });

    assert.ok(readFileSync(architectDest).equals(readFileSync(architectSrc)), '"y" must overwrite architect.md');
    assert.equal(readFileSync(builderDest, 'utf8'), 'USER EDIT — builder\n', '"n" must keep builder.md');
    assert.equal(prompt.calls.length, 2);
  });

  test('invalid input is re-asked, and "d" shows a diff then re-asks the SAME file', async () => {
    const root = makeGeneralistProject();
    const dest = agentPath(root, 'builder.md');
    const src = packageSrcFor(root, dest);
    editProjectFile(dest, 'USER EDIT\n');

    const prompt = makeQueuePrompt(['bogus', 'd', 'y']);
    // "d" relays git's real diff to stdout (showFileDiff is a relay, not a
    // filter — see lib/diff.js). Capture it so the test runner's own report
    // is not interleaved with a literal `diff --git ...` block, and assert
    // the diff genuinely reached stdout rather than merely not crashing.
    const origWrite = process.stdout.write;
    let out = '';
    process.stdout.write = (chunk) => {
      out += String(chunk);
      return true;
    };
    try {
      await migrate(root, { prompt });
    } finally {
      process.stdout.write = origWrite;
    }

    assert.match(out, /^diff --git/m, '"d" must actually print a diff');
    assert.ok(readFileSync(dest).equals(readFileSync(src)));
    assert.equal(prompt.calls.length, 3, 'invalid input and the diff request must each re-ask the same file');
  });

  test('"a" overwrites this file AND every remaining one without asking again', async () => {
    const root = makeGeneralistProject();
    const architectDest = agentPath(root, 'architect.md');
    const builderDest = agentPath(root, 'builder.md');
    const architectSrc = packageSrcFor(root, architectDest);
    const builderSrc = packageSrcFor(root, builderDest);
    editProjectFile(architectDest, 'USER EDIT — architect\n');
    editProjectFile(builderDest, 'USER EDIT — builder\n');

    // Only ONE scripted answer — this proves builder.md is never actually asked.
    const prompt = makeQueuePrompt(['a']);
    await migrate(root, { prompt });

    assert.ok(readFileSync(architectDest).equals(readFileSync(architectSrc)));
    assert.ok(readFileSync(builderDest).equals(readFileSync(builderSrc)));
    assert.equal(prompt.calls.length, 1);
  });

  test('"q" skips this file AND every remaining one without asking again', async () => {
    const root = makeGeneralistProject();
    const architectDest = agentPath(root, 'architect.md');
    const builderDest = agentPath(root, 'builder.md');
    editProjectFile(architectDest, 'USER EDIT — architect\n');
    editProjectFile(builderDest, 'USER EDIT — builder\n');

    const prompt = makeQueuePrompt(['q']);
    await migrate(root, { prompt });

    assert.equal(readFileSync(architectDest, 'utf8'), 'USER EDIT — architect\n');
    assert.equal(readFileSync(builderDest, 'utf8'), 'USER EDIT — builder\n');
    assert.equal(prompt.calls.length, 1);
  });

  test('EOF (prompt resolves undefined) is treated exactly like "q" — skip this and everything remaining', async () => {
    const root = makeGeneralistProject();
    const architectDest = agentPath(root, 'architect.md');
    const builderDest = agentPath(root, 'builder.md');
    editProjectFile(architectDest, 'USER EDIT — architect\n');
    editProjectFile(builderDest, 'USER EDIT — builder\n');

    const prompt = makeQueuePrompt([undefined]);
    await migrate(root, { prompt });

    assert.equal(readFileSync(architectDest, 'utf8'), 'USER EDIT — architect\n');
    assert.equal(readFileSync(builderDest, 'utf8'), 'USER EDIT — builder\n');
    assert.equal(prompt.calls.length, 1);
  });

  test('a rejected prompt is treated exactly like EOF (safe side: skip)', async () => {
    const root = makeGeneralistProject();
    const dest = agentPath(root, 'builder.md');
    editProjectFile(dest, 'USER EDIT\n');
    const before = readFileSync(dest);
    const prompt = async () => {
      throw new Error('stdin exploded');
    };

    const result = await migrate(root, { prompt });

    assert.equal(result.success, true, 'a rejected prompt must not crash migrate()');
    assert.ok(readFileSync(dest).equals(before));
  });

  test('opts.prompt: null explicitly disables prompting even where a function COULD be injected', async () => {
    const root = makeGeneralistProject();
    const dest = agentPath(root, 'builder.md');
    editProjectFile(dest, 'USER EDIT\n');

    const result = await migrate(root, { prompt: null });

    assert.ok(readFileSync(dest).equals(Buffer.from('USER EDIT\n')));
    assert.equal(result.success, true);
  });

  // The two tests below assert on the prompt's CALL COUNT, not on migrate()
  // rejecting a throwing prompt. A throwing prompt proves nothing here:
  // askAboutFile() deliberately catches every prompt rejection and treats it
  // as EOF (see its `catch { raw = null }`), so migrate() resolves whether or
  // not the prompt was ever called — an assert.doesNotReject() version of
  // these tests passes even with migrate()'s `dryRun || yes` guard deleted
  // outright. Counting calls is what actually pins that guard down.
  test('--dry-run never CALLS the prompt, even with a prompt function injected', async () => {
    const root = makeGeneralistProject();
    const dest = agentPath(root, 'builder.md');
    editProjectFile(dest, 'USER EDIT\n');
    const before = readFileSync(dest);
    let calls = 0;
    // Answers 'y' on purpose: if the guard ever breaks, this prompt APPROVES
    // the overwrite, so the byte-comparison below fails too — the test then
    // reports both the leak and its consequence.
    const prompt = async () => {
      calls++;
      return 'y';
    };

    const result = await migrate(root, { dryRun: true, prompt });

    assert.equal(calls, 0, '--dry-run must never call the prompt');
    assert.equal(result.success, true);
    assert.ok(readFileSync(dest).equals(before), 'the user edit must survive --dry-run');
  });

  test('--yes never CALLS the prompt, even with a prompt function injected', async () => {
    const root = makeGeneralistProject();
    const dest = agentPath(root, 'builder.md');
    editProjectFile(dest, 'USER EDIT\n');
    const before = readFileSync(dest);
    let calls = 0;
    const prompt = async () => {
      calls++;
      return 'y';
    };

    const result = await migrate(root, { yes: true, prompt });

    assert.equal(calls, 0, '--yes must never call the prompt');
    assert.equal(result.success, true);
    assert.ok(
      readFileSync(dest).equals(before),
      '--yes alone must never overwrite a user-modified file',
    );
  });
});

describe('ownedFilesStep — a write failure is reported as a clean, path-specific message', () => {
  test('a plain file squatting where a skill directory belongs turns a "missing" restore into a clean error, no stack trace', async () => {
    // Portable trigger: fs.mkdirSync(path.dirname(dest), {recursive:true})
    // fails (ENOTDIR/EEXIST) when a path segment it needs to create already
    // exists as a plain FILE rather than a directory. Removing the whole
    // generalist-playbook skill directory and replacing it with a plain file
    // of the same name reproduces exactly that: SKILL.md's dest then reports
    // `missing` (existsSync() on a path under a non-directory parent is
    // false), and the restore attempt is what actually fails.
    const root = makeGeneralistProject();
    const skillDirPath = path.join(root, '.claude', 'skills', 'generalist-playbook');
    fs.rmSync(skillDirPath, { recursive: true, force: true });
    writeFileSync(skillDirPath, 'a plain file squatting where a directory should be\n', 'utf8');

    const result = await migrate(root);

    assert.equal(result.success, false);
    assert.match(result.message, /generalist-playbook/, `expected the failing path in the message, got:\n${result.message}`);
    // No raw Node stack trace line ("at ...(file:...js:LINE:COL)") leaked
    // into the user-facing message — same contract teamLessonsScaffoldStep's
    // own try/catch already upholds for its own writes.
    assert.doesNotMatch(result.message, /\n\s*at .+:\d+:\d+/, `must not leak a raw stack trace, got:\n${result.message}`);
  });
});

describe('formatMigrateReport() — heading is not skipped for an updated-only step', () => {
  test('a step with `updated` but empty `added`/`kept` still prints its heading', () => {
    const message = formatMigrateReport({
      dryRun: false,
      applied: true,
      steps: [{ id: 'x', title: 'updated-only step', added: [], updated: ['some/file.md'], kept: [], notices: [] }],
    });
    assert.match(message, /updated-only step/);
    assert.match(message, /some\/file\.md/);
    assert.doesNotMatch(message, /up to date/);
  });
});
