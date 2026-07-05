# Decision Log

One entry per major decision: what + why, 1–2 lines.

- **2026-07-05 — Skills distribution, hybrid delivery.** Canonical
  `shared/skills/working-method/SKILL.md` is placed for every team (dir-level copy,
  file-level manifest tracking, collision guard + empty-dir cleanup; manifest stays v1),
  plus an always-active `orchestration.md` block that injects a working-method digest
  into every delegation prompt. Why: Claude Code skills are on-demand only — a skill
  nobody invokes is inert; the digest-in-delegation is the guaranteed floor, the full
  skill file is the depth channel.
- **2026-07-05 — One shared working-method skill, not per-team skills.** The frontier
  gap is discipline/sequencing/verification, which is stack-agnostic. Per-team skills
  (debug root-cause-protocol, research tradeoff-matrix) parked in backlog until the
  shared skill proves it changes behavior. `team.json` optional `skills` array +
  per-team `skills/` dir already support them when needed.
- **2026-07-05 — `shared/` added to package.json `files`.** Without it the npm tarball
  omits the shared skill and the feature ships broken.
- **2026-07-05 — Per-team playbooks: Cassandra's deferral overruled by the human.** Every
  team gets a `<team>-playbook` skill: operating loop, failure catalog (symptom → wrong
  instinct → correct move), discriminating checks, decision trees, verification recipe,
  reviewer checklist. Platitudes banned — every line actionable or checkable. Delivered
  three-layered: skill file + FIRST ACTION read directive with inline minimums in each
  agent .md + orchestration "Team playbook" gate. debug-playbook is the hand-written
  quality exemplar.
- **2026-07-05 — Manifest v2: placedFiles stored project-relative.** v1's absolute paths
  made the collision guard refuse every switch after a project was cloned to a new
  location (guaranteed once working-method was always placed). v1 manifests from other
  machines are migrated on read by re-rooting on the `.claude/` path segment.
