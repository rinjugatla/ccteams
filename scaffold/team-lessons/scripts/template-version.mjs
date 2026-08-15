/**
 * template-version.mjs — the single source of truth for which GENERATION of the
 * ccteams-owned team-lessons template a project currently has on disk.
 *
 * What the number means
 * --------------------
 * A monotonically increasing integer, bumped by ONE, and only when a
 * ccteams-OWNED team-lessons template file actually changes:
 *   AUTHORING.md, scripts/gen-lessons.mjs, scripts/lessons-index.mjs,
 *   scripts/template-version.mjs
 * The user-owned files (SKILL.md, lessons/**) are deliberately NOT part of the
 * generation — ccteams never rewrites them, so their content can never make a
 * project's template "old".
 *
 * Why it is NOT package.json's version
 * ------------------------------------
 * Syncing this to the package version would make EVERY ccteams release look
 * like a template change, even releases that touch nothing under
 * scaffold/team-lessons/. `ccteams migrate` would then rewrite these files on
 * every single release — and in a project that runs prettier (or any formatter)
 * over `.claude/**`, each of those rewrites clobbers the project's own
 * formatting and has to be undone by re-running the formatter. A dedicated
 * counter that moves only on a real template change keeps that cost
 * proportional to the actual churn.
 *
 * Why a bare number literal
 * -------------------------
 * The value is written as a plain integer literal with no quotes, no template
 * string, and no expression, so a formatter cannot change it: prettier may move
 * the whitespace around `=`, but it will not rewrite the digits into anything
 * else. `ccteams migrate` therefore extracts the value with a regex that is
 * tolerant of spacing but anchored on the declaration
 * (`export\s+const\s+TEAM_LESSONS_TEMPLATE_VERSION\s*=\s*(\d+)` — see
 * TEMPLATE_VERSION_RE in lib/team-lessons-template.js). The `export const`
 * prefix is what keeps prose from being mistaken for the declaration: the
 * escaped spelling above does not match, because the regex needs real
 * whitespace where the text has a literal `\s+`. It is not a general defence —
 * a comment containing the declaration verbatim, with real spaces and a real
 * number, WOULD match and would win if it came first. So do not write one:
 * keep this file to exactly one unescaped assignment, the last line.
 * The regex is used rather than importing the project's copy of this file
 * because importing would
 * execute a file from the user's project inside the CLI, and would break on any
 * hand-edit that leaves the file unparseable, when all migrate actually needs is
 * one integer.
 *
 * Maintainers: bumping this number ALSO requires appending a matching entry to
 * TEAM_LESSONS_HASH_LEDGER in lib/team-lessons-template.js — the test suite
 * fails otherwise.
 */
export const TEAM_LESSONS_TEMPLATE_VERSION = 8;
