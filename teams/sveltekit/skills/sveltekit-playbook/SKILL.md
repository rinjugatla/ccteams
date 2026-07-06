---
name: sveltekit-playbook
description: Operational playbook for SvelteKit 2 + Svelte 5 + TypeScript — version detection, reactive patterns, form action discipline, SSR boundaries, type safety, and exact verification commands. Read in full at the start of every task on this team.
---

# SvelteKit Playbook

This is the literal procedure a frontier model follows on a SvelteKit 2 + Svelte 5 codebase.
Follow it in order; most SvelteKit defects come from skipping the reconnaissance
steps and writing "generic SvelteKit" instead of THIS project's SvelteKit.

## Operating loop

1. **Pin the stack before writing a line.** Read `package.json`, `pnpm-lock.yaml`, and `svelte.config.js`:
   - SvelteKit version: the `@sveltejs/kit` version. Stay inside that version's API.
   - Svelte version: the `svelte` version. Confirm it's Svelte 5.x for runes support.
   - Adapter: read `svelte.config.js` for the `adapter` import (e.g., `@sveltejs/adapter-node`, `adapter-static`, `adapter-vercel`). This determines deployment constraints (e.g., static = no server routes).
   - TypeScript: check `tsconfig.json` for `strict` mode and any custom paths.
   - Test runner: check `package.json` scripts for `vitest`, `playwright`, or `jest`.
   - Linter: check for `.eslintrc.*`, `eslint.config.js`, and `.prettierrc` files.
   - AI tooling: check if Svelte MCP server is configured (via `npx sv add mcp`) — if so, **svelte-autofixer** is mandatory before completion.
2. **Check reality before adding to it.**
   - Routes: list `src/routes/**` to see existing structure before creating a new route — may already exist.
   - Env vars: check `src/lib/server/` or `.env` files for existing secrets; never expose them to the client.
   - Existing components: read `src/lib/components/` for naming and structure conventions.
3. **Read one neighboring route or component in the same area** and mirror its patterns: state management, load function structure, form action style, error handling. Convention in THIS repo beats convention in general.
4. **Place and name files exactly per SvelteKit conventions:**
   - Routes: `src/routes/[slug]/+page.svelte`, `+page.server.ts`, `+layout.svelte`, `+server.ts`.
   - Components: `src/lib/components/` or similar, imported via `$lib/...`.
   - Server utilities: `src/lib/server/` (never imported in client code).
5. **Build in this order:** route structure → server-side load/actions → component → client-side enhancement. Each layer is testable before the next exists.
6. **Form action discipline:**
   - One action per logical operation; named actions (`?/login`, `?/register`) or single default.
   - Validate all inputs from `request.formData()` before processing.
   - Return `{ success: true, data?: ... }` or `fail(status, { message, errors })`.
   - Use `use:enhance` for progressive enhancement, not to replace server-side validation.
7. **Run the verification recipe (below) and paste real output** before reporting. A diff without executed commands is a claim, not a result.

## Failure catalog — symptom → wrong instinct → correct move

1. **"Component state not updating"** → add more `$:` → Svelte 5 uses runes: replace `let x = ...` with `let x = $state(...)` for reactive state, `let y = $derived(...)` for computed values. `$:` is legacy.
2. **"Need to run code on mount"** → `onMount(() => ...)` → in Svelte 5, use `$effect(() => { ... })` for side effects. `onMount` still works but `$effect` is the idiomatic approach for lifecycle logic.
3. **"Props not updating"** → `export let prop` → in Svelte 5, use `let { prop } = $props()` for type-safe props. For two-way binding, use `let { value = $bindable() } = $props()`.
4. **Secrets leaked to client** → "just import the env var" → server-only vars (DB URLs, API keys) MUST be imported from `$env/static/private` or `$env/dynamic/private`, and ONLY in `.server.ts` files. Client code sees the bundle; anything imported there is public.
5. **Form action bypasses validation** → "client-side validation is enough" → always validate on the server. Client validation is UX; server validation is security. Use `fail(400, { errors })` for validation failures.
6. **"Need to redirect after form submit"** → `return { location: '/...' }` → use `redirect(303, '/...')` from `@sveltejs/kit` in server-side code (load functions, actions). Do not return a location object.
7. **SSR hydration mismatch** → "ignore the warning" → server HTML differs from client render. Common causes: `window`/`document` at top level, dates without time zone handling, random IDs. Guard browser APIs with `browser` check from `$app/environment` or run them in `$effect()`.
8. **"Need to throw an error"** → `throw new Error('...')` → use `error(status, message)` from `@sveltejs/kit` for HTTP errors. It triggers the nearest `+error.svelte` page with proper status code.
9. **Load function fetching data** → direct `fetch('https://...')` → use the `fetch` passed to the load function: `export const load = async ({ fetch }) => { await fetch('...') }`. It works on both server and client, with cookie forwarding and relative URLs.
10. **"Component needs data from parent"** → pass everything as props → consider using `setContext`/`getContext` for deeply nested shared state (theme, user session), or a store (`$state.raw()` exported from a module) for global app state.
11. **"Type error in load function"** → add `any` → type it properly with `PageServerLoad`, `PageLoad`, `LayoutServerLoad`, or `LayoutLoad` from `.svelte-kit/types/`. The types are generated; if missing, run `npm run dev` or `npm run build` once.
12. **API route returns wrong content type** → manual headers → use `json(data)` from `@sveltejs/kit` for JSON responses; it sets `Content-Type: application/json` automatically. For other types, `new Response(body, { headers: { 'Content-Type': '...' } })`.
13. **"Form data not reaching action"** → FormData structure wrong → use `formData.get('fieldName')` for single values, `formData.getAll('fieldName')` for multiple (checkboxes). Field names must match `<input name="...">`.
14. **"Component flickers on navigation"** → force client-side → that's a layout issue or missing loading state. Use `+layout.svelte` to preserve shared UI across routes, or `{#await data.promise}` for async data in the component.

## Discriminating checks (cheap, in rising order of cost)

- **Does the route exist?** `ls src/routes/[path]/+page.svelte` (~instant).
- **What's the Svelte version?** `grep '"svelte":' package.json` — if 5.x, use runes; if 4.x or lower, use legacy syntax.
- **Which adapter is configured?** `grep adapter svelte.config.js` — adapter-static = no server routes; adapter-node = full SSR; adapter-vercel = serverless.
- **Is this a server-only file?** Filename ends with `.server.ts` or `.server.js` → safe for secrets.
- **Which env vars are available?** Check `.env` or `.env.example`; distinguish `PUBLIC_*` (client-safe) from private vars.
- **Is svelte-autofixer available?** Check for Svelte MCP server configuration — if present, run it on all modified `.svelte` files before finishing.
- **What does this load function return?** `pnpm dev`, then inspect Network tab for the `+page.server.ts` or `+page.ts` response — settles most data-fetching arguments instantly.
- **Is the form action correct?** Run the dev server, submit the form, check the action response in Network tab and server logs.

## Decision trees

**(a) Where to put this code — server vs client:**
- Needs access to DB, filesystem, secrets, or server-only APIs? → `.server.ts` file (load function, form action, or API route).
- Runs on user interaction without server roundtrip (UI state, animations, local storage)? → `.svelte` component (client-side).
- Needs to run on both (fetch data, compute derived values)? → universal load function (`+page.ts`) or shared utility in `$lib` (no secrets).

**(b) Which rune to use (Svelte 5):**
- Mutable state that triggers re-renders? → `$state()`.
- Computed value derived from other state? → `$derived()` or `$derived.by(() => ...)` for complex logic.
- Side effect (logging, subscriptions, DOM manipulation)? → `$effect()`. Return a cleanup function if needed.
- Component props? → `$props()` for read-only, `$bindable()` inside `$props()` for two-way binding.

**(c) Load function — server vs universal:**
- Needs access to DB, private env vars, or server-only modules? → `+page.server.ts` (`PageServerLoad`).
- Can run on both server (SSR) and client (navigation), uses only public APIs/data? → `+page.ts` (`PageLoad`).
- Unsure? → Start with server-side (`+page.server.ts`); easier to relax than to tighten.

**(d) Form action — default vs named:**
- Single logical operation per form? → default action: `export const actions = { default: async ({ request }) => { ... } }`.
- Multiple operations from different forms on same page? → named actions: `export const actions = { login: async (...) => {...}, register: async (...) => {...} }`. Post to `?/login` or `?/register`.

## Verification recipe (in order; paste real output)

1. **svelte-autofixer** (if Svelte MCP server is configured): run on all modified `.svelte` files — must be clean. This is non-negotiable for AI-written Svelte code per official docs.
2. **Type check:** `pnpm check` — pass = no TypeScript or Svelte errors. If it fails, fix the types before proceeding.
3. **Build:** `pnpm build` — pass = production build succeeds. Catches import errors, missing exports, SSR issues.
4. **Tests:** `pnpm test` if configured (Vitest, Playwright, etc.). Failures that pre-date your change must be proven pre-existing (run on the base commit), not waved away.
5. **Lint:** `pnpm lint` if configured (ESLint); `pnpm format` if Prettier is set up. Report offenses; do not auto-fix code you didn't write.
6. **Manual verification (for routes/forms):** Run `pnpm dev`, open the affected route in a browser, exercise the feature (submit forms, navigate, interact). Paste relevant screenshots or describe observed behavior if critical.

## Reviewer checklist (priority-ordered hunt list)

1. **svelte-autofixer** (if available) runs clean on all `.svelte` files — instant FAIL if not run or if it reports issues. Official Svelte AI docs mandate this for AI-written code.
2. Secrets or server-only env vars imported in `.svelte` files or `+page.ts` (client code) — instant FAIL. Must be `.server.ts` only.
3. Form actions without input validation — FAIL; always validate server-side.
4. Untyped load functions or actions (missing `PageServerLoad`, `Actions` types) — FAIL unless types are genuinely unavailable.
5. Legacy Svelte syntax in Svelte 5 project: `export let`, `let x = ...` + `$:`, `onMount`/`beforeUpdate` instead of runes — flag for migration to `$props()`, `$state()`, `$derived()`, `$effect()`.
6. Browser APIs (`window`, `document`, `localStorage`) at top level of `.svelte` files without `browser` guard — causes SSR errors.
7. `throw new Error(...)` instead of `error(status, message)` or `redirect(status, path)` from `@sveltejs/kit` in server code.
8. Direct `fetch('https://...')` in load functions instead of using the provided `fetch` parameter.
9. Verification recipe output actually pasted — commands, not summaries. No output → not verified → not done.
