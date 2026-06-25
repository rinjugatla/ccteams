# Decision Log — ccteams

## 2026-06-17 — README: CLI-first framing, plugin optional, drop nvm comparison

- Added `ccteams --version` (reads package.json; `--version`/`-V`/`version`).
- Reframed the README: the CLI is the tool; the Claude Code plugin is an OPTIONAL
  convenience layer for slash commands (the old "two parts, both needed" was wrong —
  `ccteams use` works without the plugin). Install split into required CLI / optional
  plugin. Usage block updated (--details, --agent-teams, --version).
- Removed the `nvm` comparison everywhere (README x2, backlog) — describe ccteams in its
  own terms rather than leaning on another tool's brand.

## 2026-06-17 — `ccteams list` UX: one-line summaries, color, NO_COLOR/FORCE_COLOR

- Added a short `summary` field to every team.json (uniform noun-phrase, ~one line);
  `list` (compact, default) now shows `name + summary`, no wrapping, aligned. Full
  descriptions + tags moved to `list --verbose`. `description` is unchanged (still used
  by `--verbose` and the /choose-team matcher); `summary` falls back to it when absent.
- Team names are bold cyan; `*` marks teams needing agent-teams mode.
- Color gating: `NO_COLOR` > `FORCE_COLOR` > `process.stdout.isTTY`. Diagnosed (Daedalus)
  that color looked "missing" only because the Claude Code `!` bang-command captures
  stdout as a pipe (not a TTY) — correct behavior; `FORCE_COLOR=1` shows it anyway.
- Help text gained an "Agent teams mode" explainer (orchestrated vs. --agent-teams).
- Reframed agent-teams as an OPTIONAL add-on for ANY team (user's call): dropped the
  `*`/"needs agent-teams mode" marker from `list` (it implied some teams require it).
  Footer now states agent-teams is optional (`--agent-teams`). requiresAgentTeams stays in
  the format but isn't surfaced. Renamed `list --verbose` → `list --details`, styled the
  details view with color (bold cyan names, dim tags).


## 2026-06-17 — Phase 0 verified: subagent + CLAUDE.md load mechanism works

- Manually placed a sample `frontend` team into `.claude/` and restarted the session.
- **Confirmed:** subagents loaded from a **subdirectory** `.claude/agents/ccteams/` (not just the top level), so ccteams can isolate its managed agents in a `ccteams/` subdir — eliminating any collision with hand-written agents.
- **Confirmed:** hand-written agents in `.claude/agents/` were untouched.
- **Confirmed:** `CLAUDE.md` `@.claude/active-team.md` import loaded the orchestration rules.
- This validates the core ccteams design: physical copy into `.claude/` → restart → load.

## 2026-06-17 — Tech choice: Node/npm for the CLI

- CLI distributed via Node/npm (`npx ccteams`). Rationale: Claude Code users almost
  always have Node; best affinity with the plugin layer (JS/JSON); zero-install via npx.

## 2026-06-17 — Agent-teams opt-in flag, SendMessage clarified, generalist team, OSS license

- CONFIRMED via official docs (agent-teams.md): "Team coordination tools such as SendMessage
  and the task management tools are always available to a teammate even when `tools` restricts
  other tools." → SendMessage must NEVER be listed in an agent's `tools:`; it's auto-provided
  when agent teams are enabled. This corrected an earlier (wrong) plan to add it explicitly.
- Also confirmed: enabling the flag does NOT force team mode — Claude only spawns teammates on
  user request. So enabling it is safe/opt-in by nature.
- Added `ccteams use <team> --agent-teams` (position-agnostic) so ANY team can opt into agent-teams
  mode, not just teams declaring requiresAgentTeams. Ownership semantics unchanged. Artemis: SHIP.
- Language behavior: ccteams doesn't touch Claude's language logic — replies follow the user's
  language as normal. Team prompts are written in English (instructions to Claude), which does
  not constrain the user-facing reply language; no "always reply in user's language" line added.
- Added `generalist` team (stack-agnostic, 5 roles: scope-planner / architect / builder /
  qa-reviewer / shipper; renamed from dev-team at user's request). Artemis: SHIP. shipper gained
  Write (for creating new CHANGELOG/release files), per an Artemis observation.
- OSS: added MIT LICENSE (© toffyui, 2026); README License section points to it.
- Fixed a stale `design-council` reference in the CLI help text (found by /code-review).

## 2026-06-17 — Monorepo / multi-team: confirmed not possible, documented as a limitation

- Question: can a monorepo run a frontend team in apps/web and a backend team in apps/api at once?
- Confirmed via official docs: subagents in `.claude/agents/` are GLOBAL to the project and
  CANNOT be scoped to a subdirectory. Nested `.claude/agents/` is not loaded. Only CLAUDE.md is
  path-scoped (loaded along the path to files being edited).
- DECISION: do nothing now. README documents "one team per session" + the monorepo workaround
  (launch `claude` from the working subdirectory for its path-scoped CLAUDE.md). Future options
  (composite team / multi-team compose) parked in docs/backlog.md.
- Also refreshed README: 7-team roster table, removed all design-council references, reframed the
  orchestrated-vs-collaborative section (no collaborative team ships by default; format supports it).

## 2026-06-17 — Replaced toy sample teams with production-grade, stack-specific teams

- Insight (from the user): "fullstack" is too low-resolution — a React expert is not an
  Angular expert. Since teams are DISTRIBUTED, the right design is stack-specific teams a
  user picks via `ccteams use`, not one vague fullstack team.
- Final roster (7 teams): stack-specific — next-ts, go-api, python-fastapi, rails;
  stack-agnostic — debug, research, and frontend (repurposed as framework-agnostic UI/UX/a11y).
- Deleted the collaborative `design-council` sample (experimental-flag dependent, low daily use).
- Quality bar set by a hand-written reference team (next-ts): precise descriptions, explicit
  triggers, necessary tools, concrete & correct stack conventions, runnable verify steps,
  `file:line — problem — fix` reviewer format. No toy "I am loaded" lines, no filler persona.
- Artemis reviewed for TECHNICAL CORRECTNESS and caught real bugs, all fixed:
  - fastapi: sync `get_db()` example in an async-mandated team (would block the event loop) →
    rewritten to AsyncSession; "every handler async" over-rule relaxed.
  - frontend: 44×44 touch target mislabeled as WCAG AA (it's AAA; AA SC 2.5.8 is 24×24);
    broken `eslint --plugin` CLI command → `npx eslint .`.
  - rails: rubocop `--autocorrect-all` auto-apply → report-only.
  - go-api: added the WriteHeader silent-200 trap note.
  - frontend agent files renamed to match their `name:` (ui-builder.md, ux-reviewer.md).

## 2026-06-17 — Phase 3: marketplace + README (shipping artifacts)

- CONFIRMED via docs: npm publish and Claude Code plugin install are INDEPENDENT. There is
  no auto-coupling — `npm install -g ccteams` gives only the CLI; the plugin installs via a
  marketplace (`/plugin marketplace add toffyui/ccteams` + `/plugin install ccteams@ccteams`).
- Moved plugin `plugin/` → `plugins/ccteams/` (conventional `plugins/<name>/` layout).
- Added repo-root `.claude-plugin/marketplace.json` (source → ./plugins/ccteams) so the repo is
  its own marketplace. package.json gained repository/keywords/license/engines; `files`
  stays bin+lib+teams (plugin ships via git/marketplace, not npm).
- README documents: two-install model, CLI + slash commands, the mandatory session restart,
  what `use` does to a project, commit-or-gitignore `.claude/`, and how to author a team.
- Athena caught a correctness bug in the README: the custom-agent frontmatter example used
  fictional `role:`/`expertise:` fields. Fixed to the real `name`/`description`/`tools`
  schema matching the sample teams and Claude Code's subagent spec.

## 2026-06-17 — SendMessage / team coordination mode policy

- Two team archetypes for ccteams-distributed packages:
  - **orchestrated (default):** members do NOT get `SendMessage` in their `tools:`.
    A single lead spawns members and drives them. Most teams are this.
  - **collaborative (opt-in):** when a team genuinely benefits from member-to-member
    messaging, members get `SendMessage`. ccteams will ship at least one such sample team.
- Rationale: least-privilege by default; SendMessage on every member invites
  orchestration drift. Reserve it for teams where back-and-forth is the point.
- CONFIRMED via official docs (sub-agents.md / agent-teams.md): `SendMessage` and
  member-to-member messaging exist ONLY under the experimental "agent teams" feature,
  enabled by `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1`. Regular subagents never talk to
  each other. This is architectural, not plugin- vs physical-copy related.
- DECISION: collaborative teams are supported by having `ccteams use` AUTO-ENABLE the flag.
  - team.json gains `"requiresAgentTeams": true` for collaborative teams.
  - `ccteams use` then merges `env.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS="1"` into the
    project's `.claude/settings.json` (preserving existing settings), records it in the
    manifest, and REMOVES it on switch to a team that doesn't need it (only if ccteams set it).
  - The flag NAME is a single source-of-truth constant so a future Claude Code rename is
    a one-line change (experimental flag = version-volatile).
  - Restart still required; completion message must say so.

## 2026-06-17 — Phase 2: plugin layer (3 skills + plugin.json)

- Plugin lives in `plugins/ccteams/`: `.claude-plugin/plugin.json` + `skills/{choose,list,use}-team/SKILL.md`.
- Plugin name `ccteams` → slash prefix `/ccteams:`. Skills invoke the global `ccteams` CLI via Bash
  (user installs `npm i -g ccteams` so the bare command is on PATH — confirmed with user).
- All three skills relay ccteams output verbatim AND repeat the session-restart instruction;
  choose-team does NL matching over `ccteams list --json` and refuses to force a bad match.
- Structure + frontmatter validated deterministically (plugin.json parses, required fields,
  .claude-plugin/ holds only the manifest, each SKILL.md has valid frontmatter).
- LIMIT: runtime slash-command invocation is NOT verifiable by Claude/subagents — requires a
  human in a fresh interactive session (`claude --plugin-dir ./plugins/ccteams`). Left to the user.

## 2026-06-17 — Phase 1.5 built & verified: settings.json flag automation + collaborative team

- `ccteams use` now auto-manages `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS` in
  `.claude/settings.json` (set for teams with `requiresAgentTeams:true`, removed on
  switch only if ccteams's own manifest recorded setting it). Manifest gains
  `agentTeamsFlagSet`. Added collaborative sample team `design-council` (3 read-only
  members with SendMessage: pragmatist / skeptic / maintainer).
- Artemis: all correctness/ownership/preservation/idempotency tests PASS. Flagged two
  silent-data-loss risks on already-corrupt input. FIXED: corrupt settings.json is now
  backed up to `settings.json.ccteams-bak` with a stderr warning before overwrite; a
  non-object `env` warns before replacement. Happy path emits no warnings. Re-verified.

## 2026-06-17 — Phase 1 CLI built & verified (Artemis)

- `ccteams list / list --json / use / current` implemented in Node (ESM, zero deps).
- Manifest schema: `{ version, appliedTeam, appliedAt, placedFiles[] }`.
- CLAUDE.md import target = repo-root `./CLAUDE.md` (not `.claude/CLAUDE.md`).
- Artemis: 8/8 scenarios PASS. Found one bug — CLAUDE.md import check used a
  substring `includes()`, so a prose mention of `@.claude/active-team.md` would
  suppress the real directive. Fixed to a line-boundary match; re-verified.

## 2026-06-17 — Agent placement: direct in .claude/agents/ + collision guard (SUPERSEDES subdir)

- REVERSED the earlier `ccteams/` subdirectory decision at the user's request. ccteams now copies
  agents DIRECTLY to `.claude/agents/<file>.md` so the applied team is visible where users expect.
- Safety is preserved by TWO mechanisms (not the subdir):
  1. Manifest `placedFiles` (absolute paths) — switch-cleanup deletes ONLY tracked files.
  2. Collision guard — before ANY mutation, abort (non-zero, project untouched) if an incoming
     agent filename would overwrite a file not in the previous manifest (= hand-written).
- Artemis: 8/8 PASS including atomic-abort on both simple and mixed (ccteams-owned + hand-written)
  collisions — no half-apply. Verdict SHIP.
- Cleaned the Phase-0 relic from this repo's own .claude/ (the old `agents/ccteams/`,
  `active-team.md`, and the CLAUDE.md import line) since this repo is not a ccteams target.

## 2026-06-25 — Add `django` team (Django + DRF)

- Added a `django` team package under `teams/django/` (team.json + orchestration.md + 3 agents).
- Granularity: chose 3 agents over the usual builder+reviewer pair. The third role splits along
  Django's real seam — plain Django (ORM/migrations/views/admin) vs Django REST Framework
  (serializers/viewsets/permissions), which have distinct failure modes and idioms:
  - `django-builder` — models, migrations, CBVs, forms, admin, management commands.
  - `drf-api` — serializers, viewsets, routers, permissions, auth, pagination.
  - `django-reviewer` — verifies: N+1, migration safety/reversibility, permission gaps
    (incl. object-level + `fields='__all__'`), missing validation; runs pytest/manage.py test.
- Principles baked in: fat model / thin view; explicit `on_delete`; never auto-`migrate`;
  `select_related`/`prefetch_related` at the queryset; secrets via env.
- No registry edit needed — `lib/teams.js` discovers teams dynamically from `teams/*/team.json`.
  Added a README team-table row for parity.
- Verified: `ccteams list/--details` shows it; end-to-end `ccteams use django` in a temp project
  placed all files and `current` reports 4 files. SHIP.

## 2026-06-25 — Auto-update: notify + `ccteams upgrade` (NOT full auto-update)

- Added an update notifier and a `ccteams upgrade` subcommand so users no longer
  have to remember to `npm i -g ccteams` manually.
- Cassandra cut full-auto-update (silently rewriting a global CLI in the background):
  pre-mortem found two unacceptable failure modes — half-written binary if another
  invocation runs mid-install, and silent permission-denied on root-owned global
  dirs (CI/Docker/managed Macs). Rejected (C). Overruled her "ship notify-only first,
  add upgrade later" — the `upgrade` subcommand is ~10 lines and directly answers the
  user's "manual is annoying", so shipped both in v1.
- Design (zero runtime deps, kept): `lib/update-check.js`, two-phase to avoid racing
  `process.exit()`:
  - `maybeNotifyFromCache()` — sync, reads on-disk cache, prints ONE stderr line if the
    *previous* run found a newer version. No network.
  - `refreshCacheInBackground()` — fire-and-forget fetch of registry `/ccteams/latest`,
    1500ms AbortController timeout, 24h TTL cache in `os.tmpdir()`. Result shown next run.
  - Notice goes to stderr only (never pollutes stdout → `list --json` stays pure JSON).
  - Suppressed by NO_UPDATE_NOTIFIER, CI, non-TTY, `--version`, `list --json`.
  - All failures (network/timeout/parse/cache I/O) swallowed silently — never breaks the CLI.
  - `isNewer` is a hand-rolled MAJOR.MINOR.PATCH numeric compare; prereleases compared on
    the safe side (no spurious "upgrade to beta"). No semver dependency.
  - `ccteams upgrade` runs `npm install -g ccteams` (execSync, inherited stdio); on failure
    catches and prints sudo / version-manager guidance, exit 1.
- Artemis: 23/23 PASS, zero production issues. SHIP.
