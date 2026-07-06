# Active Team: adaptive (ccteams)

This project uses the **adaptive** team: a collaborative, dynamically-extending team for end-to-end feature work with agent-to-agent messaging and runtime agent generation.

## Collaboration Model: agent-teams mode

This team requires **agent-teams mode** (`CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1`), which enables:
- Direct agent-to-agent messaging (not just lead → agent → lead)
- Agents can request help, negotiate scope, share findings in real time
- Team composition can expand dynamically as new roles emerge

## Orchestration rules — base flow

- **New or vague work** — start with **scope-planner**: one-sentence goal, done-means criteria, minimal shippable scope, explicit deferrals. Skip if the task is already well-defined.
- **Non-trivial design decisions** — delegate to **architect** after scoping: data model, API contract, module boundaries, technology choice. Skip for straightforward changes where the existing pattern is unambiguous.
- **Implementation** — delegate to **builder**. It detects the stack and matches existing conventions.
- **Before anything ships** — **qa-reviewer** must verify: run the project's tests, lint, and typecheck; check correctness against done-means criteria.
- **Committing and releasing** — delegate to **shipper**: logical commit grouping, clear messages, release notes if needed.

## Flow (adapt as needed)
```
scope-planner → architect → builder → qa-reviewer → shipper
```

Trivial work (clear task, obvious pattern, single file) may skip scope-planner and architect and go directly to builder → qa-reviewer → shipper.

## Dynamic agent generation

When the team discovers that a **new role is necessary** during construction:

### 1. Detection
Any agent (typically **builder** or **architect**) recognizes that work requires a skill set not yet represented in the team. Examples:
- A DevOps / infrastructure-as-code verification role
- A security / compliance review role
- A performance / optimization specialist
- A mobile/native platform advisor
- A data migrations specialist

### 2. Proposal and negotiation (agent-teams direct messaging)
The discovering agent messages the **architect**:
```
"We need X-role-reviewer to handle Y task. 
 Responsibilities: [list]. 
 Interfaces with: [other agents]. 
 Success criteria: [what they verify]."
```

The **architect** evaluates:
- Is this truly a new role, or can existing agents handle it?
- What is the minimal scope to avoid over-engineering?
- What does the agent interface look like?

### 3. Definition generation
If the architect agrees, the **builder** generates the new agent definition:
- Writes `.claude/agents/{new-agent}.md` with:
  - YAML frontmatter (`name`, `description`, `tools`, `model`)
  - System prompt (how to work, what to verify, non-negotiable minimums)
  - Must follow the same discipline as existing agents

Example generated agent:
```markdown
---
name: deployment-reviewer
description: Infrastructure and deployment verification. Use for checking containerization, orchestration, CI/CD pipelines, env config, and production-readiness.
tools: Read, Glob, Grep, Bash
model: opus
---

You verify deployment and infrastructure decisions…
[full system prompt]
```

### 4. Session transition
Once the agent definition is written:
- The team reports: "New agent generated: `.claude/agents/{new-agent}.md`. Please restart Claude Code to load it."
- User runs `/exit` to end the session
- Next session loads the new agent definition
- Team resumes work with the expanded roster

### 5. Integration
The new agent is now available for:
- Direct agent-to-agent messaging with existing agents
- Delegation by the lead orchestrator
- Verification and review of its domain

## Team playbook

This team ships `.claude/skills/adaptive-playbook/SKILL.md`, which extends the generalist playbook with:
- Stack detection (same as generalist)
- Vertical-slice delivery
- New-agent-generation procedure and checkpoints
- Runtime role expansion checklist

Every delegation prompt to **any agent** must begin with: "Read `.claude/skills/adaptive-playbook/SKILL.md` first and follow its operating loop."

### Playbook gates

When reviewing agent reports:
- **Stack detection**: agents detected the project's language/framework/conventions from manifests/lockfiles
- **Regressions**: no previously-passing test now fails
- **Vertical slices**: features are end-to-end (happy + failure paths in same slice)
- **New agent generation**: if proposed, the definition is complete, realistic, and integrates cleanly with existing team structure

## Working method (mandatory — every agent on this team)

The full method is installed at `.claude/skills/working-method/SKILL.md`; read it when in doubt. When delegating, copy this digest verbatim into EVERY delegation prompt:

> Working method (non-negotiable):
> 1. Restate the goal in one sentence + a "done means" criterion before acting.
> 2. Read the actual files before forming opinions; verify every path/function you reference exists in this project.
> 3. Name your riskiest assumption and check it first, while it is cheap.
> 4. The diff is a claim; execution is evidence. Run the project's build/lint/tests and report their real output.
> 5. Label claims VERIFIED (ran it) / REASONED (read it) / ASSUMED (unchecked) — never upgrade one silently.
> 6. Before finishing: re-read the original request; every requirement met, nothing promised-but-undone.

## Decision gates for new agents

Before generating a new agent definition, the architect MUST check:

1. **Does an existing agent cover this?** Could scope-planner, architect, builder, qa-reviewer, or shipper expand to cover it?
2. **Is the role truly independent?** If it only works with one other agent, it may not merit its own definition.
3. **Can it be a sub-role (delegated by an existing agent)?** Or does it need direct lead visibility and agent-to-agent autonomy?
4. **What is the minimal scope?** Over-broad role definitions cause bloat; under-scoped ones cause re-delegation.

If all gates pass → architect approves → builder generates → session restart → resume.

## Stack defaults
- None assumed. Every agent detects the project's language, framework, and conventions from its config files before acting.
- Prefer boring technology: stdlib over library, existing dependency over new one.
- Prefer editing existing files over introducing new patterns.
