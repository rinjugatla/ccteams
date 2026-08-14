/**
 * prompt.js — a minimal TTY prompter for `ccteams migrate`'s interactive
 * confirmation flow (Issue #18 phase 2, D-3).
 *
 * Uses node:readline/promises exclusively — no external dependency, matching
 * the package's zero-dependency policy.
 *
 * CONTRACT (see migrate.js's ownedFilesStep and the design doc it implements):
 *   - `--dry-run` never prompts — a caller must not construct a prompter for a
 *     dry run at all (that decision lives in migrate.js, not here).
 *   - Non-TTY environments (CI, piped stdin) never prompt either — again, the
 *     CALLER decides whether to invoke createTtyPrompter() at all; this module
 *     only provides the mechanism once that decision has already been made.
 *   - Whoever calls createTtyPrompter() MUST call the returned close() when
 *     done, exactly once, so the process does not hang on an open readline
 *     interface holding stdin open.
 */

import readline from 'readline/promises';

/**
 * Create a prompter backed by node:readline/promises, over `input`/`output`.
 *
 * `input`/`output` default to process.stdin/process.stdout (migrate.js's real
 * caller never passes them — see its own doc comment on ownedFilesStep — so
 * production behavior is unchanged), but are accepted as parameters so a test
 * can inject a `node:stream` PassThrough pair instead of the real TTY streams,
 * which is otherwise impossible to unit-test (process.stdin/stdout cannot be
 * scripted or observed in a `node --test` run).
 *
 * @param {{ input?: NodeJS.ReadableStream, output?: NodeJS.WritableStream }} [opts]
 * @returns {{ ask: (question: string) => Promise<string>, close: () => void }}
 */
export function createTtyPrompter({ input = process.stdin, output = process.stdout } = {}) {
  const rl = readline.createInterface({ input, output });
  return {
    ask: (question) => rl.question(question),
    close: () => rl.close(),
  };
}
