# Active Team: react-native (ccteams)

This project uses the **react-native** team: Expo + React Native + TypeScript.

## Orchestration rules

- For any new feature or any decision touching native capabilities (camera, push
  notifications, BLE, IAP, background tasks, permissions, EAS Build/Submit, store
  submission, or uncertainty about managed vs dev build): **start with rn-advisor**.
  It makes and explains the native-leaning decision, then hands off to rn-builder
  with a concrete instruction.
- For straightforward in-Expo UI work (a new screen, component, or styling change
  with no native uncertainty): go directly to **rn-builder**.
- Before any change is considered done, **rn-reviewer** must verify it. No change
  ships on the builder's word alone.

## Workflow

```
Native uncertainty?
  YES → rn-advisor (recommendation + checklist) → rn-builder (implement) → rn-reviewer (verify)
  NO  →                                            rn-builder (implement) → rn-reviewer (verify)
```

## Detecting the project type

- Assume **Expo managed workflow** unless `ios/` or `android/` directories are
  present in the repo root — those indicate a bare React Native project.
- Detect the router from the presence of an `app/` directory + `expo-router` in
  `package.json` (Expo Router), or `@react-navigation/native` (React Navigation).
- Detect the package manager from the lockfile before running any install command.

## Hard rules

- Nothing ships without rn-reviewer's PASS verdict.
- Prefer staying in Expo managed workflow. Any recommendation that forces a dev
  build or ejects from managed must be called out explicitly by rn-advisor before
  rn-builder implements it.
- rn-advisor is read-only — it produces recommendations, not code. Never ask it
  to write or edit files.
- Prefer editing existing files over creating new ones. Match the project's existing
  conventions before introducing new patterns.

## Stack defaults (unless the repo overrides them)

- TypeScript `strict`, no `any` at boundaries.
- Expo SDK modules over raw native APIs; community libs as a fallback when an
  Expo SDK equivalent does not exist.
- Expo Router (file-based, `app/` dir) if present; React Navigation otherwise.
- `StyleSheet.create` for static styles; `useSafeAreaInsets` / `<SafeAreaView>`
  for notch and home-indicator clearance.
- `FlatList` or `FlashList` for variable-length lists — never `.map` in `ScrollView`.
