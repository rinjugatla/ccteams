---
name: react-native-playbook
description: Operational playbook for Expo + React Native + TypeScript — SDK/workflow detection first, the native escalation ladder, mobile-specific failure catalog (lists, keyboard, safe areas, Expo Go limits), and a two-platform verification recipe. Read in full at the start of every task on this team.
---

# React Native Playbook (Expo + TypeScript)

This is the literal procedure for working in an Expo + React Native codebase.
The single most expensive class of mistake in this stack is treating it like
web React: the second most expensive is proposing native changes without first
knowing whether the project runs in Expo Go or a dev client. Both are killed
by following the loop in order.

## Operating loop

1. **Read the project's identity files before any opinion.** In this order:
   - `package.json` — the `expo` package version tells you the SDK line
     (e.g. `~51.x` → SDK 51). Note whether `expo-dev-client`,
     `@shopify/flash-list`, `react-native-reanimated`, and
     `react-native-safe-area-context` are installed.
   - `app.json` / `app.config.ts|js` — existing `plugins` array, permissions
     (`ios.infoPlist`, `android.permissions`), `bundleIdentifier`/`package`,
     `newArchEnabled` if present.
   - Repo root — `ios/` or `android/` directories present means the native
     projects are checked in (bare or prebuilt); absent means CNG/managed.
   - Lockfile — `pnpm-lock.yaml`/`yarn.lock`/`package-lock.json` decides the
     package manager. Never create a second lockfile.
2. **Classify the runtime before proposing any native change.**
   - No `expo-dev-client`, no `ios/`/`android/` dirs → the team runs **Expo
     Go**: only Expo SDK modules and pure-JS libraries work. Anything else is
     an escalation (see decision tree A) and must be stated as one.
   - `expo-dev-client` present or `eas.json` with build profiles → **dev
     client**: config plugins and native modules work, but every change to
     `app.json` plugins or native deps requires a **rebuild**, not a reload.
3. **Detect the router.** `app/` directory + `expo-router` in `package.json`
   → Expo Router (file-based; new screens are new files under `app/`).
   Otherwise `@react-navigation/native` → React Navigation (screens register
   in a navigator; params typed in the param list).
4. **Read 2–3 neighboring screens/components** in the area you're changing.
   Match their styling approach (`StyleSheet.create` vs a styling lib),
   import order, and data-fetching pattern. Do not import a pattern the repo
   doesn't already use.
5. **Install dependencies only via `npx expo install <pkg>`** — it pins the
   version compatible with the project's SDK. A bare `npm install` of an
   RN-adjacent package is how version-mismatch build failures start.
6. **Build the smallest slice, then run the checks** (see Verification
   recipe). Any change touching layout, lists, keyboard, or navigation gets
   named per-platform verification steps in your report — iOS and Android
   differ on exactly those four things.
7. **In your report, separate JS-reloadable changes from rebuild-required
   changes.** Editing a component = reload. Adding a native dep, a config
   plugin, or changing `app.json` native keys = new build (`npx expo
   prebuild` + native run, or an EAS build). Saying which one applies is part
   of being done.

## Failure catalog — symptom → wrong instinct → correct move

1. **Long/unbounded list is janky or eats memory** → tune the `ScrollView`
   → `.map` inside `ScrollView` mounts every item at once. Replace with
   `FlatList` (or `FlashList` if `@shopify/flash-list` is installed — it
   needs `estimatedItemSize` set to a measured number, not a guessed 100).
2. **List re-renders visibly on every state change** → add `React.memo`
   everywhere → first remove the churn source: an inline arrow
   `renderItem={({item}) => …}` and inline style objects create new
   references every render, defeating memoization. Hoist `renderItem` with
   `useCallback` and styles into `StyleSheet.create`; only then memo the item.
3. **List items lose state / animate wrongly when the array changes** →
   blame the list component → the key is the array index. Set `keyExtractor`
   to a stable unique ID from the data. Index-as-key breaks on insert/remove.
4. **`localStorage is not defined` / `document is not defined`** → polyfill
   it → there is no DOM in RN. Persistence is
   `@react-native-async-storage/async-storage` (or `expo-secure-store` for
   secrets); DOM measurement is `onLayout`; `window.alert` is `Alert.alert`.
5. **Content sits under the notch / status bar / home indicator** → hardcode
   a top padding (e.g. 44) → that number is wrong on other devices and on
   Android. Use `useSafeAreaInsets()` or `<SafeAreaView>` from
   `react-native-safe-area-context`, with `<SafeAreaProvider>` at the root.
6. **Keyboard covers the focused input** → wrap everything in
   `KeyboardAvoidingView` with one behavior → the behavior differs per
   platform: `behavior="padding"` for iOS, and on Android the OS usually
   handles it via `adjustResize` (Expo: `android.softwareKeyboardLayoutMode`
   in `app.json`) — so `Platform.OS === 'ios' ? 'padding' : undefined` is the
   common correct shape. Test on BOTH platforms; a fix verified on one
   routinely breaks the other.
7. **Android hardware/gesture back exits the app or skips your modal** →
   ignore it (iOS has no back button) → handle it: React Navigation screens
   get back for free, but custom modals/flows need `BackHandler` (or
   navigation's `beforeRemove` listener) to close instead of exit.
8. **Small icon/button is hard to tap** → make the icon bigger → keep the
   visual size, extend the target: `hitSlop={{top:10,bottom:10,left:10,
   right:10}}` or `minWidth/minHeight: 44`. Touch targets under ~44pt fail
   both users and store review guidelines.
9. **Remote image renders as nothing** → check the URL → RN's `Image` does
   NOT size itself to remote content; without explicit `width`/`height` (or
   flex sizing) it renders at 0×0. Local `require()` images have intrinsic
   size; network images never do.
10. **New library throws `null is not an object` / "native module not
    found" in Expo Go** → reinstall node_modules → the library has native
    code that Expo Go doesn't contain. It needs a dev build (decision tree
    A). Check first: does an `expo-*` SDK module cover the need? If not,
    state the dev-build requirement instead of assuming Expo Go will cope.
11. **"Text strings must be rendered within a `<Text>` component"** → wrap
    random things in `<Text>` → find the stray string: usually
    `{condition && "label"}` or `{count && <View/>}` where `count` is `0` —
    RN renders the bare `0`/string and crashes. Fix the conditional
    (`count > 0 && …`) or wrap the actual string.
12. **Edited `app.json` (plugin, permission, icon) but nothing changed in
    the running app** → edit harder / clear cache → native config is baked
    at build time. Reload updates JS only; config changes need `npx expo
    prebuild` + rebuild or a new EAS/dev-client build. Say so in the report.
13. **Shadow shows on iOS but not Android (or vice versa)** → stack more
    shadow props → iOS uses `shadowColor/Offset/Opacity/Radius`; Android uses
    `elevation`. Set both (or use a helper the repo already has).
14. **Metro serves stale/contradictory module errors after dependency
    changes** → debug your import logic → clear the bundler cache first:
    `npx expo start -c`. Ten seconds, and it's the actual cause surprisingly
    often after dep or babel-config changes.
15. **Installed/upgraded a package and the build broke with version
    complaints** → pin versions by hand → run `npx expo install --check`
    (and `--fix`) to align every Expo-adjacent package with the SDK's
    expected versions; `npx expo-doctor` names remaining mismatches.

## Discriminating checks (cheap, in rising order of cost)

- **Which runtime?** — `grep expo-dev-client package.json; ls ios android
  2>/dev/null` (~5 s). Decides whether a native suggestion is even runnable.
- **Is it JS or native?** — does the failing behavior change after a JS-only
  edit + reload? If yes, the bug is in JS; if only a rebuild changes it, it's
  config/native.
- **Is the lib Expo-Go-safe?** — does its install doc say "requires
  `expo-dev-client`", "config plugin", or `pod install`? Any of those →
  dev build rung.
- **Is it a platform-specific bug?** — reproduce on the other platform
  before theorizing. Same on both → JS logic. One platform only → suspect
  keyboard config, safe areas, shadows, back handling, or `Platform` code.
- **Is it render churn?** — add a `console.log(item.id)` at the top of the
  list item component; scroll; excessive repeated logs for on-screen items
  localizes the churn before you optimize anything.
- **Is Metro the problem?** — `npx expo start -c`; if the symptom vanishes,
  stop investigating code.

## Decision trees

### A. The native escalation ladder (does this need a dev build?)
- Need is covered by pure JS/TS (state, layout, fetch, navigation)?
  → **Expo Go rung.** Build it; no escalation.
- Need is device capability (camera, location, notifications, sensors,
  haptics, secure storage)? → check for an `expo-*` SDK module first
  (`npx expo install expo-camera`, etc.). Exists → **still Expo Go rung**
  (SDK modules are bundled in Expo Go).
- Need requires a third-party lib with native code, or an `app.json` config
  plugin? → **dev-client rung**: works with `expo-dev-client` + a rebuild
  (local prebuild or EAS). Never merely "install and reload". If the project
  is currently Expo-Go-only, escalate to rn-advisor/the human before adding
  the first native dependency — it changes the team's whole dev loop.
- Need requires hand-editing `ios/`/`android/` files with no config-plugin
  equivalent? → **bare rung.** Last resort; flag it explicitly, always via
  rn-advisor.

### B. ScrollView vs FlatList/FlashList
- Content is a fixed, small set of heterogeneous sections (a form, a detail
  screen, a settings page)? → `ScrollView`.
- Content is an array whose length you don't control (API results, user
  data, anything paginated)? → `FlatList`, or `FlashList` if installed.
  There is no "it's usually short" exception — data grows.
- Horizontal carousel of a bounded handful of items? → `ScrollView
  horizontal` is fine; unbounded → horizontal `FlatList`.

### C. Where platform-specific code goes
- One or two values differ (an offset, a behavior prop, a color)? →
  `Platform.select({ ios: …, android: … })` inline.
- The component's structure/logic differs substantially between platforms?
  → split files: `Thing.ios.tsx` / `Thing.android.tsx` with a shared types
  file; the importer stays platform-agnostic.
- Scattered `Platform.OS === 'ios'` conditionals accumulating in one file
  (3+)? → that's the signal to promote to the split-file form.

## Verification recipe (before declaring any change done)

1. `npx tsc --noEmit` — must exit 0. Type errors in RN frequently ARE
   runtime crashes (missing props on `FlatList`, wrong navigation params).
2. `npx expo-doctor` (Expo projects) — must report no failed checks; a
   dependency-version failure here predicts a native build failure later.
   Also run the project's own `lint` script if `package.json` has one.
3. Boot the app on an iOS simulator AND an Android emulator when the
   environment allows (`npx expo run:ios` / `run:android`, or `npx expo
   start` + Expo Go). If you cannot run devices, say so explicitly and list
   the exact screens/interactions the human must check on each platform —
   never imply device verification happened when it didn't.
4. List smoke test for any screen with a list: scroll to the end of a
   realistic dataset; watch for blank cells, jank, and items recycling with
   wrong content (the index-as-key signature).
5. Keyboard smoke test for any screen with inputs: focus the bottom-most
   input on both platforms; it must remain visible above the keyboard.
6. If the change added a native dep or touched `app.json` native keys:
   state "requires a new dev-client/EAS build" in the report, with the
   command (`eas build --profile development --platform all` or
   `npx expo prebuild && npx expo run:ios`).

## Reviewer checklist (rn-reviewer's hunt list, in priority order)

1. Any `.map()` over data inside a `ScrollView`, or a `FlatList` keyed by
   index / missing `keyExtractor`? (Instant FAIL for unbounded data.)
2. Inline arrow functions or object literals passed to `renderItem`, list
   item props, or other hot paths?
3. Any web API — `localStorage`, `document`, `window.`, `navigator.` (except
   RN-provided ones) — in non-web code paths?
4. Hardcoded status-bar/notch offsets instead of safe-area insets? Bottom
   controls ignoring the home-indicator inset?
5. New dependency: does it contain native code or a config plugin while the
   project targets Expo Go? Was it installed with `npx expo install`? Is the
   rebuild requirement stated in the builder's report?
6. Screens with `TextInput`s: keyboard handling present, and is the
   `KeyboardAvoidingView` behavior platform-forked (see catalog #6)?
7. Custom modals/overlays: Android back handled (`BackHandler`/
   `beforeRemove`)?
8. Touch targets: interactive elements ≥44pt or `hitSlop` present?
   `accessibilityLabel`/`accessibilityRole` on custom touchables?
9. Remote images: explicit dimensions or flex sizing?
10. Shadows: both `shadow*` (iOS) and `elevation` (Android) handled?
11. Did the builder actually run `npx tsc --noEmit` and `npx expo-doctor`
    (output quoted, not asserted)? Are per-platform manual checks named if
    devices weren't run?
