---
name: adaptive-playbook
description: Operational playbook for the adaptive team — extends generalist playbook with agent-teams collaboration, dynamic agent generation, and runtime team composition expansion. Read in full at the start of every task on this team.
---

# Adaptive Playbook (agent-teams collaborative, dynamically-extensible)

This is the procedure for working expertly in a codebase you have never seen, with the added capability to **expand the team composition dynamically** as new specialist roles emerge.

The core disciplines:
1. **The repo outranks your training data.** (same as generalist)
2. **Agent-teams mode enables direct collaboration** — agents message each other, not just the lead.
3. **New roles are generated at runtime** when the team identifies needs during construction.

## Operating loop (stack detection — same as generalist)

1. **Detect the stack from manifests, in this order** (first hit usually wins; multiple hits = polyglot repo, note each root):
   `go.mod` → Go; `package.json` → Node/TS/JS; `Gemfile` → Ruby;
   `pyproject.toml` / `requirements.txt` → Python; `Cargo.toml` → Rust;
   `pom.xml` / `build.gradle*` → JVM; `composer.json` → PHP; `*.csproj` → .NET.
   File extensions alone are NOT detection — a repo full of `.ts` may be Deno, Bun, or a browser extension with no Node at all.

2. **Read the lockfile for exact versions** (`go.sum`, `package-lock.json` / `yarn.lock` / `pnpm-lock.yaml`, `Gemfile.lock`, `poetry.lock` / `uv.lock`, `Cargo.lock`). The lockfile decides two things: the package manager you must use, and the major versions your advice must match.

3. **Discover the project's OWN commands** — never invent them. Look, in order: `package.json` `"scripts"`, `Makefile` / `justfile` / `Taskfile`, CI config (`.github/workflows/*.yml`, `.gitlab-ci.yml`, `.circleci/`). Whatever CI runs is the ground truth for build/test/lint.

4. **Read 2–3 source files neighboring your change area.** Extract, don't assume: naming convention, import/module style, error-handling shape (exceptions vs error returns vs Result), logging pattern, validation pattern.

5. **Read one existing test file** for the same layer you'll touch. Note the runner, assertion style, fixture/mocking approach, and file-naming pattern.

6. **Grep before you write.** Before creating any helper, type, constant, or endpoint: `grep -ri` for its probable names AND its behavior.

7. **Vertical-slice the feature.** Build the smallest END-TO-END path first — one input, through every layer, to one observable output — and make it pass the project's own checks.

8. **Implement the failure path in the same slice as the happy path.** Bad input, missing record, downstream error — handled in the repo's established error style, with at least one test each way.

9. **Run the discovered commands; quote real output.** Fix failures before handing off. If a check fails on the BASE commit too, prove it (`git stash` → run → `git stash pop`) and report it as pre-existing.

10. **Report with claims labeled** VERIFIED (ran it) / REASONED (read it) / ASSUMED (unchecked).

## Agent-teams collaboration (NEW — unique to adaptive team)

Because this team runs in **agent-teams mode**, agents have direct communication channels:

### When to message another agent

- **scope-planner** messages **architect** early: "Does my scope make sense architecturally?"
- **architect** messages **builder** before finalizing: "Are my design assumptions consistent with what you found in the code?"
- **builder** messages **architect** when encountering ambiguities: "The existing pattern for X seems to be Y; does that match your design?"
- **builder** messages **qa-reviewer**: "Here's my test strategy — do you see coverage gaps?"
- Any agent can alert **shipper** about blockers: "qa-reviewer found a critical issue; reverify before shipping."

### Direct messaging protocol

When an agent messages another, include:
1. **Question or alert** (concise, one or two sentences)
2. **Context** — what you've discovered or the decision point
3. **What you need** — a confirmation, guidance, or a decision
4. **Blocking or non-blocking** — does this hold up your work?

Example:
```
@architect: I'm building a payment webhook handler. The existing codebase uses 
Result<T, E> for errors (in the api/ layer) but a few utility functions throw exceptions 
(in helpers/). Should I use Result consistently or match the local pattern in handlers/?
```

## Dynamic agent generation (NEW — unique to adaptive team)

### When a new agent role is needed

During construction, agents may discover that a **new specialist role** is necessary. Common examples:
- A database migration validator (for schema-heavy changes)
- A security/compliance reviewer (for auth, payment, data-handling features)
- A performance profiler (for latency-sensitive changes)
- A containerization/DevOps reviewer (for infrastructure changes)
- A mobile/platform-specific advisor (for cross-platform work)

### Identification and proposal

1. **Builder** (typically) recognizes the need and messages **architect**:
   ```
   @architect: This feature involves complex data migrations and schema versioning.
   I think we need a database-migration-reviewer role to validate that 
   migrations are reversible and won't break production. 
   Should we generate that agent?
   ```

2. **Architect** evaluates against the decision gates:
   - Does an existing agent cover this?
   - Is the role truly independent?
   - Can it be a sub-role delegated by an existing agent?
   - What is the minimal scope?

3. **If architect approves**, builder generates the agent definition:
   ```markdown
   ---
   name: migration-reviewer
   description: Database migration and schema validation. Verifies migrations are reversible, safe under concurrent writes, follow naming conventions, and include rollback paths.
   tools: Read, Bash, Glob, Grep
   model: opus
   ---

   You review database migrations and schema changes...
   FIRST ACTION: Read `.claude/skills/adaptive-playbook/SKILL.md`...
   [full system prompt]
   ```

4. **Builder writes the file** to `.claude/agents/migration-reviewer.md` and reports:
   ```
   New agent generated: .claude/agents/migration-reviewer.md
   Responsibilities: validate reversibility, safety, naming, rollback.
   Interfaces with: qa-reviewer (shares results), builder (provides guidance).
   
   Please run `/exit` to restart Claude Code. The new agent will be loaded in the next session.
   ```

### Session restart and resumption

1. User runs `/exit` to end the current session
2. Next Claude Code session starts
3. New agent is loaded from `.claude/agents/`
4. Team resumes with expanded roster
5. New agent is available for direct messaging and delegation

### Checkpoints for generated agents

Before generating, ensure the agent definition:
- [ ] Has a clear, unique name (`{domain}-{role}`)
- [ ] Describes a focused responsibility (not a catch-all)
- [ ] Lists specific `tools` needed
- [ ] Specifies `model` (typically `opus` for review/advisory, `sonnet` for execution)
- [ ] Opens with "FIRST ACTION: Read `.claude/skills/adaptive-playbook/SKILL.md`"
- [ ] Includes "agent-teams collaboration notes" section
- [ ] States which existing agents it interfaces with
- [ ] Does not duplicate an existing agent's scope

## Failure catalog — symptom → wrong instinct → correct move

1. **Repo "looks like" a familiar stack** → start coding from the file extensions → run loop steps 1–3 first.
2. **You need a helper (slugify, retry, date-format, API client)** → write it → grep first for the name AND the behavior.
3. **The codebase's pattern feels dated/clunky** → introduce the better pattern alongside → one file mixing `.then()` chains with the repo's async/await costs more than either style alone.
4. **The file you need to change looks machine-written** → edit it anyway → check for generation markers first.
5. **Tests exist but your favorite runner is nicer** → run/write with yours → use exactly the runner and assertion style from loop step 5.
6. **Lint fails on your code** → add `eslint-disable` / `# noqa` / `#[allow]` → the rule encodes a project decision; fix the code to satisfy it.
7. **You need a URL, path, timeout, or credential** → hardcode the value that works locally → grep for the existing config mechanism.
8. **A decision point you can't resolve (naming, contract shape, edge-case semantics)** → in agent-teams mode, message the architect or relevant agent for real-time guidance instead of leaving a TODO.
9. **The task keeps touching "just one more file"** → keep going → stop and report when you cross any of: >3–4 files unrelated to the core change, a public interface, a DB migration, or a new dep.

## New-agent-generation failure modes

1. **"This is kind of a specialist role, let's auto-generate it"** → before generating, verify with architect that it truly merits its own agent and isn't just an expanded sub-task of an existing one.
2. **Generated agent definition is too vague or too broad** → it will fight with other agents for ownership of tasks. Make it narrow and focused.
3. **Generated agent doesn't specify which agents it messages** → unclear collaboration model. Every new agent must state its interfaces.
4. **Generated agent repeats the "read the playbook" instruction verbatim but never follows it** → same as any agent; it matters.
5. **Trying to use the generated agent before session restart** → it's not loaded yet. End the session, restart, then delegate to it.

## Reviewer checklist (qa-reviewer specific)

1. **Correctness against acceptance criteria** — check scope-planner's "done means" item by item.
2. **Test coverage** — happy path, failure path, edge cases; describe missing tests for builder.
3. **Regressions** — run the full test suite; any previously-passing test now failing is priority-1.
4. **Static analysis** — run typecheck and lint if configured.
5. **Security and correctness at boundaries** — external input validation, no secrets in logs/errors, no injection surfaces.
6. **Conventions** — change matches surrounding patterns.
7. **New agents (if applicable)** — if builder generated a new agent, verify its definition is well-formed and its interfaces are clear.

## Summary

The adaptive team combines:
- **Generalist procedural discipline** (stack detection, vertical slices, working-method)
- **Agent-teams direct collaboration** (agents message each other, not just the lead)
- **Dynamic composition** (new agents generated at runtime when specialist roles emerge)

This enables a team to scale its capability from "5 fixed agents" to "N agents where N grows with the project's actual needs."
