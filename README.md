# ccpm — Agent-Team Package Manager for Claude Code

Switch between pre-built Claude Code agent teams like `nvm` switches Node versions. An **agent team** is a bundle of subagents (with specific roles, expertise, and behaviors) plus orchestration rules that control how they collaborate — managed as a single unit in your project's `.claude/` directory.

## Two parts, two installs

ccpm ships as **two independent components** you install separately. Both are needed for the full experience:

| Component | What it does | How you get it |
|-----------|-------------|---|
| **CLI binary** | Commands to list, select, and apply teams | `npm install -g ccpm` (via npm) |
| **Claude Code plugin** | Slash commands for the same tasks inside Claude Code | Marketplace: `/plugin marketplace add toffyui/ccpm` + `/plugin install ccpm@ccpm` |

Installing the npm CLI **alone** does not give you the slash commands. Installing the plugin **alone** does not give you the `ccpm` command-line tool. You need both to use ccpm fully.

## Install

### Step 1: Install the CLI

```bash
npm install -g ccpm
ccpm list
```

Verify it prints available agent teams.

### Step 2: Install the Claude Code plugin

In Claude Code, run:

```
/plugin marketplace add toffyui/ccpm
/plugin install ccpm@ccpm
/reload-plugins
```

Or restart Claude Code. The slash commands `/ccpm:list-teams`, `/ccpm:use-team`, and `/ccpm:choose-team` will then be available.

## Usage

### Command Line (CLI)

```bash
ccpm list              # Show all available teams
ccpm list --json       # JSON output of teams
ccpm current           # Show the currently active team (if any)
ccpm use <team-name>   # Apply a team to the current directory
```

### Claude Code (Slash commands)

```
/ccpm:list-teams                    # List available teams
/ccpm:use-team <team-name>          # Apply a team
/ccpm:choose-team <natural-language> # Find and apply a team by description ("for backend work", "frontend-focused", etc.)
```

## ⚠️ IMPORTANT: Session restart required

After running `ccpm use`, `/ccpm:use-team`, or `/ccpm:choose-team`, **you must restart Claude Code** for the new agent team to load. The agents are instantiated at session start, not mid-session.

**To restart:** type `/exit` (or close Claude Code) and start a new session.

## How teams are applied to your project

When you apply a team with `ccpm use <team>` or `/ccpm:use-team <team>`:

1. The team's agent definitions are copied into `.claude/agents/`.
2. A `.claude/active-team.md` file is created, documenting the active team and its purpose.
3. Your project's `.claude/CLAUDE.md` is updated with an import statement (`@.claude/active-team.md`) to include the team's orchestration rules.
4. A `.claude/.ccpm-manifest.json` is written to track which team is active and allow clean switching.
5. If the team requires experimental agent-team features (member messaging, collaboration), `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1` is automatically set in `.claude/settings.json`.

ccpm includes a **collision guard**: it will refuse to apply a team if any of its agents share a name with agents you've written by hand in `.claude/agents/`. This prevents accidental overwrites.

## Committing `.claude/` — your choice

You have two options:

**Option A (shared teams):** Commit `.claude/agents/`, `.claude/active-team.md`, and `.claude/.ccpm-manifest.json` to git. Teammates pulling the repo will automatically have the same team active.

**Option B (local teams):** Add `.claude/agents/`, `.claude/active-team.md`, and `.claude/.ccpm-manifest.json` to `.gitignore`. Each developer can run `ccpm use` locally to activate their preferred team.

**Recommendation:** If your project benefits from consistent team composition (e.g., a shared code style or mandatory QA agents), commit the team. Otherwise, keep it local.

## Creating your own agent team

An agent team lives in `teams/<name>/`:

```
teams/<name>/
├── team.json               # Metadata: name, description, tags, optional flags
├── orchestration.md        # The CLAUDE.md rules to import (defines roles, goals, behavior)
└── agents/
    ├── agent1.md           # YAML frontmatter + agent system prompt
    ├── agent2.md
    └── ...
```

### `team.json` schema

```json
{
  "name": "my-team",
  "description": "A short pitch of what this team does",
  "tags": ["backend", "api", "performance"],
  "requiresAgentTeams": false
}
```

Set `"requiresAgentTeams": true` if your team uses agent-to-agent messaging or collaborative member features.

### Agent files (`.md`)

Each agent file is a standard Claude Code subagent: YAML frontmatter (`name`, `description`, and optional `tools`) followed by its system prompt:

```markdown
---
name: my-agent
description: Backend API specialist. Use for building and reviewing REST/GraphQL endpoints, data layers, and integrations.
tools: Read, Write, Edit, Bash, Glob, Grep
---

You are a Python backend expert. Your job is to...
```

The `description` is what Claude uses to decide when to delegate to this agent, so make it specific. Omit `tools` to inherit all available tools.

See `teams/frontend/agents/` and `teams/design-council/agents/` for examples.

### Two team patterns

**Orchestrated teams** (e.g., `frontend`) — one lead agent (often named after the team) that directs the flow and summons specialized subagents. Stateless and predictable.

**Collaborative teams** (e.g., `design-council`) — agents message each other, vote, and iterate together. Richer but requires the experimental agent-teams feature (`CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1`), which ccpm enables automatically.

## Development / local testing

### Test the plugin locally (session-only)

```bash
claude --plugin-dir ./plugins/ccpm
```

This loads the plugin for the current session only — no permanent install. Useful for development.

### Test the CLI locally

```bash
npm install -g .
ccpm list
```

Installs the CLI from the repo's current source.

## License

MIT
