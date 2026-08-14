/**
 * diff.js — shows a project file against ccteams' own shipped source for it,
 * for the `[d] show diff` choice in `ccteams migrate`'s interactive
 * confirmation flow (Issue #18 phase 2, D-4).
 *
 * Shells out to `git diff --no-index` rather than shipping a hand-written
 * unified-diff implementation: the design doc this module implements chose
 * that trade-off explicitly (an LCS-based diff is ~100 lines of code to
 * maintain for a feature that is not this package's job).
 */

import { spawnSync } from 'child_process';

/**
 * Show a diff between the project's current copy of a file and the package
 * source ccteams would place there.
 *
 * Argument order is deliberate: OLD = the project's file (what is there now),
 * NEW = the package source (what overwriting would replace it with) — so the
 * diff reads as "what would change if you overwrite".
 *
 * PAGER: `git diff` is a pager-eligible command (`pager.diff` defaults to
 * true), so an interactive terminal's `git` would normally hand the output to
 * `less` (or whatever `GIT_PAGER`/`core.pager` resolves to). This function is
 * ONLY ever reached from the `[d]` choice in ownedFilesStep's interactive
 * flow (lib/migrate.js), which by definition only runs while
 * lib/prompt.js's readline interface is open on stdin in raw mode — a pager
 * launched at that moment would fight the still-open readline interface for
 * control of the same TTY (both want to read raw keystrokes from the same
 * stdin), corrupting either the pager's or the next prompt's input. `git
 * --no-pager` disables the pager unconditionally, independent of the user's
 * own `pager.diff`/`core.pager` config, which is the correct behavior here:
 * this is a programmatic diff view embedded in a larger prompt, not a
 * standalone `git diff` invocation the user ran directly.
 *
 * stdio is deliberately NOT 'inherit', and the reason is stdin alone: leaving
 * it disconnected ('ignore') is what guarantees git can never itself read
 * from the TTY readline already owns. stdout/stderr are captured ('pipe')
 * and written straight back out below — a RELAY, not a filter: nothing is
 * dropped or reformatted on the way through.
 *
 * The one place capturing differs from 'inherit': spawnSync buffers, so a
 * diff larger than `maxBuffer` (1 MiB by default) aborts with ENOBUFS and
 * lands in the fallback below instead of streaming through. A single
 * unified diff of one Markdown agent definition is orders of magnitude
 * under that, so the limit is left at its default rather than raised on
 * speculation — but the fallback distinguishes that case from a missing
 * git so it can never claim "git not available" about a git that ran, and
 * so it never tells the user to install a git that is already installed.
 *
 * @param {string} projectFile absolute path to the file as it exists in the project
 * @param {string} packageSrcFile absolute path to ccteams' own source for it
 * @param {{ gitBin?: string, maxBuffer?: number }} [opts] gitBin overrides the
 *   git executable name. It exists so the git-unavailable fallback below is
 *   reachable from a test (pass a name that cannot resolve); without it that
 *   branch could only be exercised on a machine with no git installed at all —
 *   i.e. never, in the environments this suite actually runs in. maxBuffer
 *   exists for the same reason and only that reason: it makes the OTHER
 *   fallback branch (a git that ran but whose spawn failed anyway) reachable,
 *   by letting a test shrink the capture buffer until a real git overflows it
 *   with ENOBUFS. No production call site passes either option, so the
 *   spawnSync defaults — `git` on PATH and the 1 MiB maxBuffer discussed
 *   above — still govern every real invocation.
 * @returns {{ shown: boolean }} shown is true iff git ran and its output was
 *   relayed; false means the fallback one-liner was printed instead.
 */
export function showFileDiff(projectFile, packageSrcFile, { gitBin = 'git', maxBuffer } = {}) {
  const spawnOpts = { stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8' };
  // Set the key only when a caller actually supplied a limit, so the default
  // stays the default rather than depending on how spawnSync treats an
  // explicitly-undefined `maxBuffer`.
  if (maxBuffer !== undefined) spawnOpts.maxBuffer = maxBuffer;

  const result = spawnSync(
    gitBin,
    ['--no-pager', 'diff', '--no-index', '--', projectFile, packageSrcFile],
    spawnOpts,
  );

  // `git diff --no-index` exits 1 when the two files differ — that is the
  // NORMAL case here (we are showing a diff precisely because they differ),
  // not a failure. A failure to RUN git (as opposed to a non-zero exit) shows
  // up as `result.error` instead: ENOENT when the binary is missing, ENOBUFS
  // when the diff exceeded maxBuffer, and so on.
  if (!result.error) {
    if (result.stdout) process.stdout.write(result.stdout);
    if (result.stderr) process.stderr.write(result.stderr);
    return { shown: true };
  }

  // Fall back to naming the two files without fabricating diff content we did
  // not actually compute. The heading names only what this branch established:
  // ENOENT means the git binary could not be found, while any other spawn
  // failure (ENOBUFS on an oversized diff, EACCES, ...) means git may well be
  // installed and working — claiming "git not available" there would assert
  // something never checked.
  const gitMissing = result.error.code === 'ENOENT';
  console.log(
    gitMissing
      ? '(git not available — cannot show a diff)'
      : `(could not run git diff: ${result.error.code ?? result.error.message} — cannot show a diff)`,
  );
  console.log(`  project file : ${projectFile}`);
  console.log(`  ccteams ships: ${packageSrcFile}`);
  // The advice is bound to the SAME distinction as the heading above it, not
  // printed unconditionally underneath it. "Install git" is true advice only
  // for ENOENT; on any other spawn failure git is very likely installed and
  // working, so telling the user to install it would send them after a problem
  // this branch never observed. There the actionable move is to run the same
  // diff by hand, outside this process's captured-output limits.
  console.log(
    gitMissing
      ? '  Install git to see the actual diff.'
      : '  Run "git diff --no-index" on the two files above to see the actual diff.',
  );
  return { shown: false };
}
