---
name: next-ts-playbook
description: Operational playbook for Next.js App Router + TypeScript + Tailwind — server/client boundary placement, caching decisions, hydration failure catalog, build-based verification. Read in full at the start of every task on this team.
---

# Next.js App Router Playbook

This is the literal procedure to follow for any change in a Next.js (App Router)
+ TypeScript + Tailwind project. The single most expensive class of mistake in
this stack is putting code on the wrong side of the server/client boundary —
so the loop forces you to locate that boundary before you write anything.

## Operating loop

1. **Pin the versions before anything else.** Read `package.json` for the
   `next` and `react` versions and skim `next.config.(js|mjs|ts)` for
   redirects, rewrites, `images.remotePatterns`, and experimental flags.
   Caching defaults flipped between majors (see decision tree C) — advice
   that is correct for 14 is wrong for 15.
2. **Map the route segment.** For the route you're touching, list which of
   `page.tsx`, `layout.tsx`, `loading.tsx`, `error.tsx`, `not-found.tsx`,
   `route.ts` exist (`ls app/<segment>/`). A `route.ts` and a `page.tsx`
   cannot coexist in the same segment. Note whether `loading.tsx`/`error.tsx`
   are missing — async pages without them hang blank or crash the segment.
3. **Locate the change on the RSC/client boundary.** Before writing, record
   the baseline: `grep -rn '"use client"' app/ src/ 2>/dev/null | wc -l`.
   Decide which side your change lives on using decision tree A. Every
   `"use client"` you add must be justified in your report.
4. **Read two sibling files** (a neighboring page and a neighboring
   component) and mirror their naming, import style, and data-fetching
   pattern. Do not introduce a second convention.
5. **Data on the server.** Initial data is fetched in the Server Component
   with `async/await`. Mutations go through Server Actions that (a) validate
   their input and (b) call `revalidatePath`/`revalidateTag`. `useEffect`
   fetching is only for data that genuinely depends on client-only state.
6. **Write cache intent explicitly.** Every `fetch` for data that matters
   carries `{ cache: 'force-cache' | 'no-store' }` or
   `next: { revalidate: N }` — never rely on the default, because the
   default changed between Next 14 and 15.
7. **Type the boundaries.** Props, Server Action inputs, and route-handler
   payloads get explicit types. External input (`searchParams`, `FormData`,
   fetched JSON) is narrowed or zod-parsed, never cast.
8. **Run the verification recipe** (below) and report real output. `next
   build` is part of it — it statically catches boundary violations that
   `tsc` cannot.

## Failure catalog — symptom → wrong instinct → correct move

1. **One button needs an onClick** → put `"use client"` at the top of the
   page → extract the button into its own leaf component, mark only that
   file client, keep the page a Server Component. The directive marks a
   *boundary*: everything the client file imports becomes client too.
2. **Hydration mismatch warning** (`Text content does not match…`) → slap
   `suppressHydrationWarning` on it → find the nondeterminism: `Date.now()`,
   `new Date()` formatting, `Math.random()`, `toLocaleString` (server and
   browser locales differ), or `typeof window` branches in render. Compute
   the value on the server and pass it as a prop, or render it only after
   mount (`useEffect` + state). Also check for invalid HTML nesting
   (`<div>` inside `<p>`) — the browser rewrites it and hydration diverges.
3. **Build error: server module imported into a client component** → copy
   the needed code into the client file → keep the module on the server and
   pass its *data* down as props across the boundary. Add `import
   'server-only'` at the top of modules that touch secrets or the DB so the
   build fails loudly on the next attempt.
4. **`process.env.MY_KEY` is `undefined` in the browser** → rename it to
   `NEXT_PUBLIC_MY_KEY` → only if the value is genuinely public. Env vars
   without the prefix are server-only by design; `NEXT_PUBLIC_` values are
   inlined into the JS bundle at build time and visible to every visitor.
   If it's a secret, move the code that uses it to the server.
5. **Initial page data fetched in `useEffect`** → add a loading spinner →
   delete the effect; fetch in the Server Component with `await` and stream
   with `loading.tsx`/`<Suspense>`. Client fetching of initial data buys a
   request waterfall and a layout flash for nothing.
6. **Mutation succeeds but the UI shows stale data** → sprinkle
   `router.refresh()` or `window.location.reload()` in the client → call
   `revalidatePath('/the/route')` or `revalidateTag('tag')` inside the
   Server Action itself, after the write.
7. **Server Action works in testing** → ship it as-is → every exported
   `"use server"` function is a public POST endpoint callable with
   arbitrary arguments by anyone, not just your form. Parse and validate
   the input (zod if present) and check authorization inside the action.
8. **Error: "Functions cannot be passed directly to Client Components"** →
   mark the parent `"use client"` → either move the handler *into* the
   client component, or pass a Server Action (functions marked
   `"use server"` are the one legal function type across the boundary).
9. **Need an image** → `<img src=...>` → `next/image`: it needs
   `width`/`height` (or `fill` + a sized parent), and external hosts must
   be listed in `next.config` `images.remotePatterns`. Only fall back to
   `<img>` if the project already standardizes on it.
10. **`tsc` complains at a boundary** → `as any` / `@ts-ignore` → type it:
    `unknown` + a narrowing function, a zod schema's inferred type, or a
    generic. Every `any` at a props/action/route boundary is an untyped
    public interface.
11. **Data is stale in production but fine in dev** → add cache-busting
    query params → state the cache intent explicitly on the `fetch`
    (`no-store` or `revalidate`). Next.js 14: `fetch` defaults to cached.
    Next.js 15: `fetch` and GET route handlers are uncached by default.
    Never diagnose caching behavior in `next dev` — verify with
    `next build && next start`.
12. **Build error: "useSearchParams() should be wrapped in a suspense
    boundary"** → export `dynamic = 'force-dynamic'` for the whole page →
    wrap only the component that reads the params in `<Suspense>`; the rest
    of the page stays static.
13. **`redirect()` inside a `try/catch` never redirects** → retry it or add
    flags → `redirect()` and `notFound()` work by *throwing*; your `catch`
    swallowed the control-flow error. Call them outside the `try`, or
    rethrow anything you didn't specifically expect.
14. **`error.tsx` added but the build rejects it** → convert it to a plain
    page → `error.tsx` must start with `"use client"`; it receives
    `{ error, reset }` props. That is the one file where the directive is
    mandatory, not a smell.
15. **Tailwind class has no effect** → add `!important` or inline styles →
    check for dynamically-built class names first:
    `` `bg-${color}-500` `` is never generated because Tailwind scans
    source for complete literal strings. Write the full class names and
    switch between them, or use a lookup map of literals.

## Discriminating checks

- **Which side is this component on?** Add `console.log('SIDE-CHECK')` in
  its body. Terminal only → Server Component. Browser console → client
  (client components also log in the terminal during SSR, so the browser
  console is the discriminator). Remove the probe after.
- **Can this module ever reach the client?** Put `import 'server-only'` at
  its top and run `next build`. A failure prints the exact import chain
  that crosses the boundary; a pass proves isolation. Keep the import — it
  is a permanent guard, not a probe.
- **Is this route static or dynamic?** Read the `next build` output legend:
  `○` = static, `ƒ` (older versions: `λ`) = server-rendered on demand. If
  a route you expected static shows dynamic, hunt for `cookies()`,
  `headers()`, uncached `fetch`, or `searchParams` usage in it.
- **Did a secret leak into the bundle?** After `next build`, run
  `grep -rl 'THE_ACTUAL_SECRET_VALUE' .next/static/` (search by value —
  `NEXT_PUBLIC_` inlining replaces the name with the value). Any hit is a
  leak.
- **Hydration-risk sweep of changed files:**
  `git diff --name-only | xargs grep -nE 'Date\.now|Math\.random|toLocale|new Date\(|typeof window'`
  — every hit inside render output is a mismatch candidate.
- **Is `"use client"` creep happening?** Compare
  `git diff | grep -c '^\+.*use client'` against
  `git diff | grep -c '^-.*use client'`. A net increase needs one sentence
  of justification per directive.

## Decision trees

**A. Server Component vs `"use client"`**
- Uses `useState`/`useEffect`/`useRef`, event handlers, browser APIs
  (`window`, `localStorage`, observers), or context consumption? → client.
- Everything else — data fetching, secrets, heavy dependencies, markup —
  → server (the default; no directive).
- Needs both? → split: server parent fetches and owns the data, client leaf
  gets it as props. Put the directive at the smallest leaf that contains
  the interactivity.
- A client wrapper (theme/provider) must contain server content? → accept
  Server Components via `children`/props — a client component may *render*
  server-rendered children it did not import.

**B. Where does data access live?**
- Initial render data → the Server Component itself (`async` page or
  component, `await` directly).
- Mutation from a form or button → Server Action (`"use server"`), with
  input validation + `revalidatePath`/`revalidateTag`.
- An external client (mobile app, webhook, third party) must call it → route
  handler (`route.ts`).
- Data that only exists on the client (viewport, live cursor, polling tied
  to visibility) → client fetch — the only case where `useEffect`/SWR/query
  hooks earn their place for reads.

**C. Caching / revalidation choice**
- Data may be stale for N seconds and is shared by all users → `next:
  { revalidate: N }` (or `export const revalidate = N` on the segment).
- Data must be fresh per-request or is user-specific →
  `cache: 'no-store'` (user-specific data also usually reads `cookies()`,
  which makes the route dynamic anyway).
- Data changes only on deploy → `cache: 'force-cache'`.
- Version note — defaults if you write nothing: **Next.js 14 caches
  `fetch` by default; Next.js 15 does not, and GET route handlers are also
  uncached by default in 15.** Writing the intent explicitly makes the
  version difference irrelevant — so always write it.
- Next.js 15 only: `params` and `searchParams` are Promises (`await` them),
  and `cookies()`/`headers()` are async. In 14 they are synchronous.

## Verification recipe

Run in this order; each step gates the next. Report exact commands + output.

1. `npx tsc --noEmit` (or the project's `typecheck` script). Fail → fix
   types; do not proceed with casts.
2. The project's `lint` script. Fail → fix; a11y and hooks rules run here.
3. `npm run build` (pnpm/yarn per lockfile). This is the step that
   statically catches: server-only imports reachable from client code,
   `useSearchParams` without Suspense, `metadata` exported from a client
   file, invalid segment exports. A build that passes with these mistakes
   does not exist — so a passing build is real evidence.
4. Read the build output route table: confirm each touched route's `○`/`ƒ`
   marker matches your caching intent from decision tree C.
5. `git diff | grep '^\+.*use client'` — list each added directive with its
   one-sentence justification.
6. If a secret-adjacent file changed: the bundle grep from Discriminating
   checks.
7. Project tests, if a `test` script exists.

## Reviewer checklist (priority-ordered hunt list)

1. **Boundary trace by hand.** For every added/changed `"use client"`: does
   that component actually use state/effects/handlers/browser APIs? Flag
   any directive above the smallest interactive leaf. Tooling will not
   catch a directive that is merely *too high* — only you will.
2. **Server Action audit.** Every `"use server"` export: input parsed/
   validated? Authorization checked inside the action? `revalidatePath`/
   `revalidateTag` called after the write? Missing any → FAIL.
3. **Secret/env sweep.** `grep -n 'process\.env\.' <changed client files>`
   — any non-`NEXT_PUBLIC_` var in a client file is dead code or a leak
   attempt; any `NEXT_PUBLIC_` var holding a secret is a leak.
4. **Cache intent.** Every `fetch` in the diff has explicit `cache` or
   `revalidate`. Implicit default → flag with the 14-vs-15 default note.
5. **Hydration-risk grep** on changed files (`Date.now|Math.random|
   toLocale|new Date\(|typeof window` in render paths).
6. **Data-fetch placement.** New `useEffect` that fetches initial data →
   flag with the server-component rewrite.
7. **Type escapes.** `grep -nE 'as any|@ts-ignore|@ts-expect-error|: any' `
   over the diff; each hit needs a written reason or a fix.
8. **Route plumbing.** Async pages without `loading.tsx`; segments doing
   risky IO without `error.tsx`; `redirect()`/`notFound()` inside `try`.
9. **Ran, not read:** you personally ran `tsc --noEmit` and the build, and
   your report quotes their output. A review without a build run is not a
   review.
