---
name: frontend-playbook
description: Operational playbook for framework-agnostic UI/UX/a11y — semantic-element-first markup, keyboard/focus verification, responsive layout checks, reuse of existing tokens over new CSS. Read in full at the start of every task on this team.
---

# Frontend (UI / UX / a11y) Playbook

This is the literal procedure to follow for any user-facing UI change, in any
framework (React, Vue, Svelte, plain HTML). The single most expensive class of
mistake here is building UI you never watched a human operate — so the loop
forces you to run the app and drive it by keyboard before you declare anything
done. The second is inventing CSS/components that already exist in the project —
so the loop forces you to read the design system before you add to it.

## Operating loop

1. **Reproduce the current UI state first.** Run the app (`npm run dev` /
   `pnpm dev` / the project's start script) and open the actual screen you are
   changing before writing anything. A screenshot or a description is not the
   screen; render it. If you cannot run it, STOP and report what's missing
   (start command, env, seed data) rather than editing blind.
2. **Detect the stack from evidence, not assumption.** Read `package.json`
   dependencies for the framework (React/Vue/Svelte/none) and the styling
   system (Tailwind, CSS Modules, styled-components, vanilla CSS, a
   `tailwind.config`, a `tokens.*` file, a `theme.*`). Note whether TypeScript
   is in use. Do not introduce a framework or styling approach the project does
   not already use.
3. **Read the design tokens and component library BEFORE writing CSS.** Find
   the existing spacing scale, color tokens, typography scale, breakpoints, and
   any component primitives (a `Button`, `<ui/>`, shadcn, Radix, Headless UI,
   Vuetify). `grep` the codebase for the class/token you're about to invent —
   it usually already exists under a different name. New CSS is a last resort,
   justified in your report.
4. **Read two sibling components** and mirror their markup structure, naming,
   class conventions, and file placement. Do not introduce a second convention
   in a codebase that already has one.
5. **Choose the semantic element before any styling** (decision tree A). Pick
   the native element whose behavior you want (`<button>`, `<a>`, `<nav>`,
   `<label>`, `<dialog>`, `<details>`); reach for ARIA only when no native
   element fits.
6. **Colocate state at its lowest owner** (decision tree B). Do not lift state
   or hoist a value into a store/context until a second consumer actually
   exists.
7. **Reuse before you write** (decision tree C). An existing token/utility/
   component beats new CSS every time.
8. **Run the verification recipe** (below) and report real output. The
   keyboard-only walkthrough and the 320/768/1280 resize are not optional —
   they are where UI bugs actually live.

## Failure catalog — symptom → wrong instinct → correct move

1. **Element needs a click handler** → put `onClick` on a `<div>`/`<span>` →
   use `<button type="button">`. A clickable `<div>` is not focusable, not
   Enter/Space-operable, and announces nothing to a screen reader. If it
   navigates, it's an `<a href>`, not a button. Reserve `role="button"` +
   `tabindex="0"` + key handlers for the rare case you cannot use the element.
2. **Focus outline looks ugly** → `outline: none` (or `:focus { outline:
   none }`) → never remove a focus indicator without replacing it. Use
   `:focus-visible` to scope the ring to keyboard users and provide a visible
   replacement (ring, border, background shift) meeting 3:1 contrast against
   its surroundings. An `outline: none` with no replacement is an accessibility
   defect, not a style choice.
3. **Input has placeholder text so it "looks labeled"** → ship without a
   `<label>` → placeholders vanish on input and are not reliably announced.
   Add a real `<label for="id">` (or wrapping `<label>`, or `aria-labelledby`).
   `aria-label` is the fallback only when no visible text label can exist.
4. **Image causes layout shift as it loads** → leave `<img>` bare → set
   intrinsic `width` and `height` attributes (or CSS `aspect-ratio`) so the
   browser reserves space. Missing dimensions are the #1 cause of Cumulative
   Layout Shift. Decorative images still need `alt=""`; meaningful ones need
   real `alt`.
5. **Element renders behind another** → bump `z-index` to `9999` (then the
   next one to `10000`) → z-index escalation is a smell. Find the stacking
   context: a parent with `transform`, `opacity`, `filter`, or its own
   `z-index` traps children. Fix the context or use the project's existing
   layer scale; do not start an arms race.
6. **Element needs to sit "there"** → `position: absolute` with hard-coded
   top/left → prefer flow layout (flexbox/grid gap, margin) which reflows
   responsively. Absolute positioning is correct for overlays/badges/tooltips
   anchored to a `position: relative` parent — not for general layout, where
   it breaks at other viewport sizes.
7. **Designer gave sizes in px** → set every `font-size` in `px` → use `rem`
   for font sizes so they scale with the user's browser font setting; px fonts
   ignore that setting and fail users who enlarge text. Borders/hairlines in
   px are fine.
8. **Affordance only appears on `:hover`** → ship the hover-reveal (menu,
   delete button, tooltip) → hover has no keyboard or touch equivalent. Every
   hover affordance needs a `:focus`/`:focus-within` path and must be reachable
   without a pointer. "Show on hover" alone is invisible to keyboard and touch
   users.
9. **Two states distinguished only by color** (error red, valid green;
   selected tab tinted) → rely on the color alone → color must never be the
   only signal (WCAG 1.4.1). Add a second channel: an icon, text, underline,
   weight, or `aria-selected`/`aria-invalid`. ~8% of men cannot rely on
   red/green.
10. **Flex child with long text overflows its container / forces horizontal
    scroll** → set `overflow: hidden` and move on → the cause is that flex/grid
    items default to `min-width: auto`, refusing to shrink below content size.
    Set `min-width: 0` (or `min-height: 0` for column flex) on the flex child
    so it can shrink and `text-overflow: ellipsis` can engage.
11. **Modal/menu opens but keyboard leaves it** → trust the DOM order → an
    overlay needs focus moved into it on open, focus trapped inside while open,
    Escape to close, and focus returned to the trigger on close. A `<dialog>`
    with `showModal()` gives you most of this for free; a `<div>` overlay does
    not.
12. **Content is hidden with `display: none` for "screen-reader only" text** →
    use `display:none` or `visibility:hidden` → those remove it from the
    accessibility tree too. Use the project's `.sr-only`/`.visually-hidden`
    utility (clip-rect pattern) so it stays announced but invisible.
13. **Icon-only button** (hamburger, close ✕, chevron) → ship with no text →
    it announces as "button" with no name. Add an `aria-label` or a visually
    hidden text span. Verify with the keyboard walkthrough that it announces.
14. **Fixed-height container clips content when text grows** (translations,
    long names, user zoom) → pin the height in px → let content define height;
    use `min-height` and padding instead of a fixed `height`. Test with a
    doubled-length string.
15. **Heading level chosen for its size** (`<h3>` because "h3 is the size I
    want") → pick headings by appearance → heading level is document structure,
    not styling. One `<h1>` per page, no skipped levels; style the size with a
    class. Screen-reader users navigate by heading level.

## Discriminating checks

- **Is it actually keyboard-operable?** Put the mouse down. Tab to the element,
  press Enter and Space. If nothing happens, it's not a real control — it's a
  styled `<div>`. A native `<button>` responds to both keys for free.
- **Is the focus order the DOM order?** Tab through the screen and watch the
  ring. If focus jumps around unexpectedly, source order ≠ visual order
  (usually caused by CSS reordering: `order`, `flex-direction: row-reverse`,
  grid placement, or absolute positioning). Fix the DOM order, not with
  `tabindex` > 0 (which is its own anti-pattern).
- **Does it survive a resize?** Drag the window to 320px wide. Horizontal
  scrollbar appearing = overflow bug (usually a fixed width, a long unbroken
  string, or the `min-width: auto` trap from catalog #10).
- **Is this state really shared?** Before lifting state to a parent/store,
  `grep` for a second component that reads it. Zero other readers → it stays
  local.
- **Does this token/utility already exist?** `grep` the design-token file and
  existing components for the color/spacing value before writing a new class.
  A hit means reuse it; a literal hex/px in your diff that matches an existing
  token is a defect.
- **Is color the only cue?** Screenshot the change and view it grayscale (or
  imagine it desaturated). If two states become indistinguishable, you're
  violating 1.4.1 — add a non-color channel.

## Decision trees

**A. Semantic element vs ARIA**
- Is there a native HTML element with the behavior you want? Clickable action →
  `<button>`. Navigation → `<a href>`. Grouped nav → `<nav>`. Labeled field →
  `<label>` + input. Expand/collapse → `<details>`/`<summary>`. Modal →
  `<dialog>`. Use it. Native elements come with focus, keyboard, and semantics
  for free.
- No native element fits (tabs, comboboxes, tree, custom slider)? → build on
  the correct ARIA role and implement its full keyboard contract (from the
  WAI-ARIA Authoring Practices pattern). ARIA adds semantics but ZERO behavior
  — you own all the key handling.
- Never use ARIA to override a correct native element (`role="button"` on a
  `<button>`, `aria-label` shadowing visible text). The first rule of ARIA is:
  don't use ARIA if a native element will do.

**B. State colocation — where does this state live?**
- Used by exactly one component? → local state inside that component
  (`useState`/`ref`/`data()`), full stop.
- A second component needs to READ or WRITE it? → lift to the nearest common
  ancestor and pass down. Not before; a second consumer must actually exist,
  not be hypothetical.
- Many distant components across routes need it, or it's genuinely global
  (auth, theme, cart)? → context/store. A store for state that one subtree uses
  is over-engineering — it makes the component harder to move and test.
- Derived from other state (a filtered list, a formatted string)? → compute it
  during render; do not store it in a second state variable that can drift.

**C. Reuse vs new CSS**
- Does an existing utility class / token / component already express this? →
  use it. `grep` first (discriminating check above).
- It's a one-off tweak of an existing component? → use the component's props/
  variants or a modifier class, not a new bespoke component.
- It's genuinely new and will repeat? → add it to the design system in the same
  place and style as siblings (extend the token file / add a variant), not as
  an inline literal.
- It's new and truly one-off? → the smallest local style, using existing tokens
  for its values (spacing, color) even if the rule itself is new. A new hard-
  coded hex or px value that duplicates a token is the thing to avoid.

## Verification recipe

Run in this order; report exact commands/output and what you observed.

1. **Run the app and load the changed screen.** State the URL/route and that it
   rendered without console errors.
2. **Keyboard-only walkthrough** (mouse untouched): Tab through every
   interactive element. Confirm:
   - each control is reachable and shows a visible focus indicator;
   - focus order matches visual order;
   - Enter/Space activate buttons; Enter follows links;
   - Escape closes any menu/dialog/popover, and focus returns to the trigger;
   - focus is trapped inside an open modal and does not leak to the page behind.
3. **Resize at 320 / 768 / 1280 px** wide. Confirm at each: no horizontal
   scrollbar, no clipped or overlapping content, touch targets stay ≥ 24×24 CSS
   px (aim ~44×44). Note anything that breaks.
4. **Run configured tooling** if present: `npx eslint .` (its config runs any
   `eslint-plugin-jsx-a11y` rules automatically — `--plugin` is not a valid CLI
   flag), the project's `lint`/`typecheck`/`test` scripts. Report real output.
5. **axe / Lighthouse if available** (`npx @axe-core/cli <url>` or Lighthouse in
   DevTools). Report the a11y score and every violation; a violation is a
   finding, not noise. If not installed, say so and rely on the manual checks.
6. **Grayscale glance** for color-only signals (discriminating check).
7. **Diff review:** each new CSS rule / new component justified against
   decision tree C; each added `role`/`aria-*`/`tabindex` justified against
   tree A.

## Reviewer checklist (priority-ordered hunt list)

1. **Ran it by keyboard.** You personally Tab/Enter/Escape'd through the change
   and quote what you observed. A review with no keyboard walkthrough is not a
   review.
2. **Fake controls.** `grep` the diff for `onClick`/`@click`/`on:click` on
   `<div>`/`<span>` and for `role="button"`. Each is a `<button>`/`<a>` unless
   there is a written reason it cannot be.
3. **Focus visibility.** `grep` for `outline: *none` / `outline:0` with no
   `:focus-visible` replacement nearby → FAIL. Every interactive element has a
   visible focus state.
4. **Labels & names.** Every input has an associated label; every icon-only
   button has an accessible name (`aria-label` or sr-only text). Missing → FAIL.
5. **CLS / images.** Every new `<img>`/image component has `width`+`height` or
   `aspect-ratio`; every image has `alt` (or `alt=""` if decorative).
6. **Color-only signals.** Any state conveyed by color alone (error/valid,
   selected, required) has a second channel. Grayscale-check it.
7. **Responsive.** You resized to 320/768/1280 and quote what happened; flag
   any horizontal overflow, checking flex/grid children for the missing
   `min-width: 0` (catalog #10).
8. **Reuse.** New literal colors/spacings in the diff that duplicate existing
   tokens → flag with the token to use. New component that duplicates an
   existing primitive → flag.
9. **ARIA misuse.** `role`/`aria-*` overriding a correct native element, or a
   custom widget with an ARIA role but no keyboard handling → FAIL.
10. **z-index / positioning.** New `z-index: 9999`-style escalation or
    `position: absolute` used for flow layout → flag with the stacking-context
    or flexbox fix.
