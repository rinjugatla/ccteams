/**
 * Tests for lib/diff.js's showFileDiff() — the `[d] show diff` implementation
 * for `ccteams migrate`'s interactive confirmation flow. Its return value
 * `{ shown }` was previously never read by any caller nor asserted on by any
 * test (a dead API) — this file pins it down in BOTH directions.
 *
 * "Both directions" is the point: a test that only checks `typeof shown ===
 * 'boolean'`, or that guards the real assertion behind `if (result.shown)`,
 * is a tautology — it passes just as happily when the function is changed to
 * always return false. Each test below asserts an exact value for a situation
 * it has actually established (git resolvable / git not resolvable).
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { showFileDiff } from '../lib/diff.js';

const makeProject = () => mkdtempSync(path.join(tmpdir(), 'ccteams-diff-'));

// Establish the precondition rather than assume it: only when git actually
// resolves here may a test assert `shown === true`. On a machine without git
// those tests are skipped instead of failing for the wrong reason.
const GIT_AVAILABLE = !spawnSync('git', ['--version'], { stdio: 'ignore' }).error;

/**
 * Run `fn` with console.log/process.stdout.write/process.stderr.write
 * captured, so a test exercising the diff/fallback output does not spray it
 * across the test runner's own report. Returns { result, out }.
 */
function captureOutput(fn) {
  const origLog = console.log;
  const origOut = process.stdout.write;
  const origErr = process.stderr.write;
  let out = '';
  console.log = (...args) => {
    out += args.join(' ') + '\n';
  };
  process.stdout.write = (chunk) => {
    out += String(chunk);
    return true;
  };
  process.stderr.write = (chunk) => {
    out += String(chunk);
    return true;
  };
  try {
    return { result: fn(), out };
  } finally {
    console.log = origLog;
    process.stdout.write = origOut;
    process.stderr.write = origErr;
  }
}

describe('showFileDiff()', () => {
  test('two files with different content: git runs, shown is true, and the diff is relayed', { skip: !GIT_AVAILABLE }, () => {
    const root = makeProject();
    const projectFile = path.join(root, 'project-copy.md');
    const packageSrcFile = path.join(root, 'package-copy.md');
    writeFileSync(projectFile, 'PROJECT VERSION\n', 'utf8');
    writeFileSync(packageSrcFile, 'PACKAGE VERSION\n', 'utf8');

    const { result, out } = captureOutput(() => showFileDiff(projectFile, packageSrcFile));

    assert.equal(result.shown, true);
    // Relaying git's actual output is the whole job — assert the diff really
    // reached the caller's stdout, not just that a boolean came back.
    assert.match(out, /PROJECT VERSION/);
    assert.match(out, /PACKAGE VERSION/);
  });

  test('identical files: git exits 0 (not 1) and shown is still true', { skip: !GIT_AVAILABLE }, () => {
    const root = makeProject();
    const projectFile = path.join(root, 'a.md');
    const packageSrcFile = path.join(root, 'b.md');
    writeFileSync(projectFile, 'SAME CONTENT\n', 'utf8');
    writeFileSync(packageSrcFile, 'SAME CONTENT\n', 'utf8');

    const { result } = captureOutput(() => showFileDiff(projectFile, packageSrcFile));

    assert.equal(result.shown, true);
  });

  test('git unavailable: shown is false and the fallback names both files without fabricating a diff', () => {
    const root = makeProject();
    const projectFile = path.join(root, 'project-copy.md');
    const packageSrcFile = path.join(root, 'package-copy.md');
    writeFileSync(projectFile, 'PROJECT VERSION\n', 'utf8');
    writeFileSync(packageSrcFile, 'PACKAGE VERSION\n', 'utf8');

    // A binary name that cannot resolve makes spawnSync set `result.error`
    // (ENOENT) — the exact condition the real "git is not installed" case
    // produces, without needing a machine that lacks git.
    const { result, out } = captureOutput(() =>
      showFileDiff(projectFile, packageSrcFile, { gitBin: 'ccteams-no-such-git-binary' }),
    );

    assert.equal(result.shown, false);
    assert.match(out, /git not available/);
    // "Install git" is the CORRECT advice here and only here — pinned in this
    // direction so the sibling test below (which forbids it) cannot be
    // satisfied by simply deleting the line for every branch.
    assert.match(out, /Install git/);
    // The mirror image of the sibling test's "no Install git" rule: the
    // manual-rerun advice belongs to the OTHER branch only. Telling someone
    // with no git to run "git diff --no-index" by hand is advice they cannot
    // follow, so a regression that emits BOTH lines unconditionally — passing
    // every other assertion in both tests — is caught here.
    assert.doesNotMatch(
      out,
      /git diff --no-index/,
      'git is missing here — advising a manual git command the user cannot run is not an actionable next step',
    );
    assert.ok(out.includes(projectFile), 'the fallback must name the project file');
    assert.ok(out.includes(packageSrcFile), 'the fallback must name the package source');
    // The fallback must never invent diff content it did not compute.
    assert.doesNotMatch(out, /^diff --git/m);
    assert.doesNotMatch(out, /PROJECT VERSION/);
  });

  test('git runs but the spawn fails (ENOBUFS): the fallback neither claims git is unavailable nor tells the user to install it', { skip: !GIT_AVAILABLE }, () => {
    const root = makeProject();
    const projectFile = path.join(root, 'project-copy.md');
    const packageSrcFile = path.join(root, 'package-copy.md');
    writeFileSync(projectFile, 'PROJECT VERSION\n', 'utf8');
    writeFileSync(packageSrcFile, 'PACKAGE VERSION\n', 'utf8');

    // A 1-byte capture buffer makes a REAL, installed git overflow it, so
    // spawnSync sets result.error to ENOBUFS: the "git ran, we just could not
    // collect its output" case, as opposed to the ENOENT case above. The whole
    // point of this test is that git IS available here (hence the skip guard),
    // so every message about a missing git is a false statement in this branch.
    const { result, out } = captureOutput(() =>
      showFileDiff(projectFile, packageSrcFile, { maxBuffer: 1 }),
    );

    assert.equal(result.shown, false);
    assert.match(out, /ENOBUFS/, 'the fallback must name the failure it actually saw');
    assert.doesNotMatch(
      out,
      /git not available/,
      'git resolved and ran here — the heading must not claim it is unavailable',
    );
    assert.doesNotMatch(
      out,
      /Install git/,
      'git is already installed here — advising an install sends the user after a problem this branch never observed',
    );
    // Naming the failure is only half the job: this branch must still hand the
    // user a next step. Every other assertion here is a "must not say" one, so
    // without this the whole advice line could vanish on the non-ENOENT path
    // and the suite would stay green — leaving the user told that ENOBUFS
    // happened and nothing else. Measured, not assumed: suppressing the advice
    // for non-ENOENT left all 205 tests green before this assertion existed.
    // Matched on the command fragment rather than the full sentence so the
    // wording stays free to change without dragging this test along.
    assert.match(
      out,
      /git diff --no-index/,
      'the non-ENOENT fallback must still offer an actionable next step, not just name the failure',
    );
    assert.ok(out.includes(projectFile), 'the fallback must name the project file');
    assert.ok(out.includes(packageSrcFile), 'the fallback must name the package source');
    // Same rule as the ENOENT fallback: never invent diff content.
    assert.doesNotMatch(out, /^diff --git/m);
    assert.doesNotMatch(out, /PROJECT VERSION/);
  });
});
