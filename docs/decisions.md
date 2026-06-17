# Decision Log — ccpm

## 2026-06-17 — Phase 0 verified: subagent + CLAUDE.md load mechanism works

- Manually placed a sample `frontend` team into `.claude/` and restarted the session.
- **Confirmed:** subagents loaded from a **subdirectory** `.claude/agents/ccpm/` (not just the top level), so ccpm can isolate its managed agents in a `ccpm/` subdir — eliminating any collision with hand-written agents.
- **Confirmed:** hand-written agents in `.claude/agents/` were untouched.
- **Confirmed:** `CLAUDE.md` `@.claude/active-team.md` import loaded the orchestration rules.
- This validates the core ccpm design: physical copy into `.claude/` → restart → load.

## 2026-06-17 — Tech choice: Node/npm for the CLI

- CLI distributed via Node/npm (`npx ccpm`). Rationale: Claude Code users almost
  always have Node; best affinity with the plugin layer (JS/JSON); zero-install via npx.

## 2026-06-17 — Phase 3: marketplace + README (shipping artifacts)

- CONFIRMED via docs: npm publish and Claude Code plugin install are INDEPENDENT. There is
  no auto-coupling — `npm install -g ccpm` gives only the CLI; the plugin installs via a
  marketplace (`/plugin marketplace add toffyui/ccpm` + `/plugin install ccpm@ccpm`).
- Moved plugin `plugin/` → `plugins/ccpm/` (conventional `plugins/<name>/` layout).
- Added repo-root `.claude-plugin/marketplace.json` (source → ./plugins/ccpm) so the repo is
  its own marketplace. package.json gained repository/keywords/license/engines; `files`
  stays bin+lib+teams (plugin ships via git/marketplace, not npm).
- README documents: two-install model, CLI + slash commands, the mandatory session restart,
  what `use` does to a project, commit-or-gitignore `.claude/`, and how to author a team.
- Athena caught a correctness bug in the README: the custom-agent frontmatter example used
  fictional `role:`/`expertise:` fields. Fixed to the real `name`/`description`/`tools`
  schema matching the sample teams and Claude Code's subagent spec.

## 2026-06-17 — SendMessage / team coordination mode policy

- Two team archetypes for ccpm-distributed packages:
  - **orchestrated (default):** members do NOT get `SendMessage` in their `tools:`.
    A single lead spawns members and drives them. Most teams are this.
  - **collaborative (opt-in):** when a team genuinely benefits from member-to-member
    messaging, members get `SendMessage`. ccpm will ship at least one such sample team.
- Rationale: least-privilege by default; SendMessage on every member invites
  orchestration drift. Reserve it for teams where back-and-forth is the point.
- CONFIRMED via official docs (sub-agents.md / agent-teams.md): `SendMessage` and
  member-to-member messaging exist ONLY under the experimental "agent teams" feature,
  enabled by `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1`. Regular subagents never talk to
  each other. This is architectural, not plugin- vs physical-copy related.
- DECISION: collaborative teams are supported by having `ccpm use` AUTO-ENABLE the flag.
  - team.json gains `"requiresAgentTeams": true` for collaborative teams.
  - `ccpm use` then merges `env.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS="1"` into the
    project's `.claude/settings.json` (preserving existing settings), records it in the
    manifest, and REMOVES it on switch to a team that doesn't need it (only if ccpm set it).
  - The flag NAME is a single source-of-truth constant so a future Claude Code rename is
    a one-line change (experimental flag = version-volatile).
  - Restart still required; completion message must say so.

## 2026-06-17 — Phase 2: plugin layer (3 skills + plugin.json)

- Plugin lives in `plugin/`: `.claude-plugin/plugin.json` + `skills/{choose,list,use}-team/SKILL.md`.
- Plugin name `ccpm` → slash prefix `/ccpm:`. Skills invoke the global `ccpm` CLI via Bash
  (user installs `npm i -g ccpm` so the bare command is on PATH — confirmed with user).
- All three skills relay ccpm output verbatim AND repeat the session-restart instruction;
  choose-team does NL matching over `ccpm list --json` and refuses to force a bad match.
- Structure + frontmatter validated deterministically (plugin.json parses, required fields,
  .claude-plugin/ holds only the manifest, each SKILL.md has valid frontmatter).
- LIMIT: runtime slash-command invocation is NOT verifiable by Claude/subagents — requires a
  human in a fresh interactive session (`claude --plugin-dir ./plugin`). Left to the user.

## 2026-06-17 — Phase 1.5 built & verified: settings.json flag automation + collaborative team

- `ccpm use` now auto-manages `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS` in
  `.claude/settings.json` (set for teams with `requiresAgentTeams:true`, removed on
  switch only if ccpm's own manifest recorded setting it). Manifest gains
  `agentTeamsFlagSet`. Added collaborative sample team `design-council` (3 read-only
  members with SendMessage: pragmatist / skeptic / maintainer).
- Artemis: all correctness/ownership/preservation/idempotency tests PASS. Flagged two
  silent-data-loss risks on already-corrupt input. FIXED: corrupt settings.json is now
  backed up to `settings.json.ccpm-bak` with a stderr warning before overwrite; a
  non-object `env` warns before replacement. Happy path emits no warnings. Re-verified.

## 2026-06-17 — Phase 1 CLI built & verified (Artemis)

- `ccpm list / list --json / use / current` implemented in Node (ESM, zero deps).
- Manifest schema: `{ version, appliedTeam, appliedAt, placedFiles[] }`.
- CLAUDE.md import target = repo-root `./CLAUDE.md` (not `.claude/CLAUDE.md`).
- Artemis: 8/8 scenarios PASS. Found one bug — CLAUDE.md import check used a
  substring `includes()`, so a prose mention of `@.claude/active-team.md` would
  suppress the real directive. Fixed to a line-boundary match; re-verified.

## 2026-06-17 — Agent placement: direct in .claude/agents/ + collision guard (SUPERSEDES subdir)

- REVERSED the earlier `ccpm/` subdirectory decision at the user's request. ccpm now copies
  agents DIRECTLY to `.claude/agents/<file>.md` so the applied team is visible where users expect.
- Safety is preserved by TWO mechanisms (not the subdir):
  1. Manifest `placedFiles` (absolute paths) — switch-cleanup deletes ONLY tracked files.
  2. Collision guard — before ANY mutation, abort (non-zero, project untouched) if an incoming
     agent filename would overwrite a file not in the previous manifest (= hand-written).
- Artemis: 8/8 PASS including atomic-abort on both simple and mixed (ccpm-owned + hand-written)
  collisions — no half-apply. Verdict SHIP.
- Cleaned the Phase-0 relic from this repo's own .claude/ (the old `agents/ccpm/`,
  `active-team.md`, and the CLAUDE.md import line) since this repo is not a ccpm target.
