# Active Team: sveltekit (ccteams)

This project uses the **sveltekit** team: SvelteKit 2 + Svelte 5 + TypeScript.

See [AGENTS.md](../../AGENTS.md) for project-level AI guidelines.

## Orchestration rules

- For any implementation work — components, routes, load functions, form actions, API endpoints —
  delegate to **sveltekit-builder**.
- Before any change is considered done, **sveltekit-reviewer** must verify it: type safety,
  Svelte 5 rune usage, form action security, SSR correctness, and type checks. No change ships
  on the builder's word alone.
- Progressive enhancement: forms work without JavaScript, then enhance with `use:enhance`.
- Server-side secrets stay server-side: `$env/static/private` only in `.server.ts` files.

## Stack defaults (unless package.json or project conventions override)
- SvelteKit 2 and Svelte 5 versions from `package.json`.
- TypeScript strict mode; typed load functions and actions.
- Svelte 5 runes: `$state()`, `$derived()`, `$effect()`, `$props()` instead of legacy syntax.
- Form actions return `{ success: true }` or `fail()` with validation errors.

## AI tooling (Svelte MCP server — if installed)
If the project has Svelte MCP server configured (`npx sv add mcp`), use these tools:
- **get-documentation** — fetch relevant Svelte/SvelteKit docs before implementing unfamiliar APIs.
- **svelte-autofixer** — analyze `.svelte` files for code quality (unused vars, incorrect rune usage, reactive state issues). Non-negotiable before declaring work done.
- **list-sections** — discover available documentation sections when unsure what exists.
- **playground-link** — generate shareable code examples (only after user confirmation).

## Team playbook
This team ships `.claude/skills/sveltekit-playbook/SKILL.md`. Every delegation prompt to
sveltekit-builder or sveltekit-reviewer must begin with: "Read `.claude/skills/sveltekit-playbook/SKILL.md`
first and follow its operating loop." Hold their reports to the playbook's gates:
- No secrets or server-only env vars leaked to the client; use `$env/static/private` only in `.server.ts`.
- Every form action validates inputs and returns proper types.
- Svelte 5 rune usage: `$state`, `$derived`, `$effect` — not legacy `let`/`$:` syntax.
- **svelte-autofixer** runs clean on all `.svelte` files (if MCP server available).
- The verification recipe's real command output is pasted (type check, build, tests) — a summary is not verification.

## Working method (mandatory — every agent on this team)

The full method is installed at `.claude/skills/working-method/SKILL.md`; read it
when in doubt. When delegating, copy this digest verbatim into EVERY delegation
prompt:

> Working method (non-negotiable):
> 1. Restate the goal in one sentence + a "done means" criterion before acting.
> 2. Read the actual files before forming opinions; verify every path/function you reference exists in this project.
> 3. Name your riskiest assumption and check it first, while it is cheap.
> 4. The diff is a claim; execution is evidence. Run the project's build/lint/tests and report their real output.
> 5. Label claims VERIFIED (ran it) / REASONED (read it) / ASSUMED (unchecked) — never upgrade one silently.
> 6. Before finishing: re-read the original request; every requirement met, nothing promised-but-undone.
