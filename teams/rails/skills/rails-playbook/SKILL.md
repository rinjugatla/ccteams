---
name: rails-playbook
description: Operational playbook for Ruby on Rails — version/test-framework detection, ActiveRecord loading strategy, callback boundaries, migration discipline, and exact verification commands. Read in full at the start of every task on this team.
---

# Rails Playbook

This is the literal procedure a frontier model follows on a Rails codebase.
Follow it in order; most Rails defects come from skipping the reconnaissance
steps and writing "generic Rails" instead of THIS project's Rails.

## Operating loop

1. **Pin the stack before writing a line.** Read `Gemfile.lock`:
   - Rails version: the `rails (x.y.z)` line. Stay inside that version's API —
     no Rails 7.x features in a 6.1 project.
   - Test framework: `rspec-rails` in the lockfile + a `spec/` directory →
     `bundle exec rspec`; otherwise `test/` → `bin/rails test`.
   - Lint: `rubocop` in the lockfile + `.rubocop.yml` present → rubocop is part
     of verification.
2. **Check reality before adding to it.**
   - Routes: `bin/rails routes -g <resource>` before adding any route — the
     route may already exist, or a catch-all may shadow yours.
   - Columns: read `db/schema.rb` (or `structure.sql`) for actual columns and
     indexes. Model files do not list columns; guessing them from attribute
     usage is how phantom-column bugs happen.
   - Pending migrations: `bin/rails db:migrate:status | grep down` — writing on
     top of an unmigrated schema wastes the whole session.
3. **Read one neighboring model + controller in the same area** and mirror
   them: service objects vs model methods, concerns usage, scope style,
   callback style. Convention in THIS repo beats convention in general.
4. **Place and name files exactly where generators would** even when writing
   by hand: `app/models/user_profile.rb` → `class UserProfile`, migrations via
   `bin/rails generate migration AddXToY` (the timestamp matters), tests
   mirroring `app/` paths under `test/` or `spec/`.
5. **Build in this order:** migration → model (validations, associations with
   explicit `dependent:`, scopes) → controller → view/serializer. Each layer
   is testable before the next exists.
6. **Migration discipline:**
   - One migration = schema change OR data change, never both.
   - Every foreign key column gets an index (`add_reference` does this by
     default since Rails 5; `add_column :user_id` does NOT — add it).
   - Every uniqueness validation ships with `add_index ..., unique: true` in
     the same change (see decision tree c).
   - Data migrations use raw SQL or a model class defined inside the migration
     file, never `app/models` classes — those will drift.
7. **Run the verification recipe (below) and paste real output** before
   reporting. A diff without executed commands is a claim, not a result.

## Failure catalog — symptom → wrong instinct → correct move

1. **Page/endpoint slow, log shows repeated near-identical SELECTs** → add
   caching → it's an N+1: a view/serializer traverses an association per row.
   Add `includes`/`preload`/`eager_load` (decision tree a) at the queryset
   origin, not in the view. Detect: `grep -c 'SELECT' log/test.log` around the
   action, or Bullet's log if the gem is present.
2. **"Just need to set one field"** → `update_attribute`/`update_column` →
   `update_attribute` skips validations; `update_column` skips validations AND
   callbacks AND `updated_at`. Use `update!` unless skipping is deliberate —
   and then say so in the code with a comment.
3. **Hide soft-deleted rows everywhere** → `default_scope` → it leaks into
   every query, association traversal, and join, and forces `unscoped` calls
   that themselves become bugs. Use an explicit named scope
   (`scope :kept, -> { where(deleted_at: nil) }`) applied at call sites.
4. **Duplicate rows despite `validates :x, uniqueness: true`** → "add more
   validation" → the validation is a SELECT-then-INSERT race. Add a unique
   index and rescue `ActiveRecord::RecordNotUnique` at the write site. The
   validation stays — for error messages, not enforcement.
5. **Dynamic query condition** → `where("name = '#{name}'")` → SQL injection.
   Use hash conditions `where(name: name)` or placeholders
   `where("name = ?", name)`. Grep for `where(".*#{` in review.
6. **"Is there any record?"** → `relation.present?` or `relation.count > 0` →
   `.present?` loads every row; `.count` issues an extra COUNT when you may
   already have loaded. Use `relation.exists?` (SELECT 1 ... LIMIT 1).
7. **"On save, also email/sync/charge"** → `after_save` callback → callbacks
   touching other models, mailers, or external systems create action at a
   distance and fire during tests, imports, and backfills. Move it to an
   explicit service or controller call (decision tree b).
8. **One migration adds column AND backfills it** → ship it → it can't be
   safely rerun, reversed, or deployed in stages. Split: migration 1 adds the
   column, migration 2 (or a rake task) backfills.
9. **Params straight into the model** → `Model.new(params[:user])` →
   mass-assignment hole. Always `params.require(:user).permit(:name, :email)`.
10. **"What time is it?"** → `Time.now` / `Date.today` → these use the server
    zone, not `Time.zone`. Use `Time.current`, `Date.current`,
    `Time.zone.parse(...)`, `n.days.ago` — all zone-aware.
11. **Bulk delete of associated rows** → `delete_all` for speed → it skips
    callbacks and `dependent:` rules, orphaning children. Use `destroy_all`
    when callbacks/dependents matter; use `delete_all` only when you can state
    why they don't.
12. **Validation fails on save** → `save(validate: false)` → you just wrote
    invalid data. Fix the data or fix the validation; bypassing is only for
    migrations of known-legacy rows, with a comment.
13. **New `where`-filtered column is slow** → "the DB will handle it" → check
    `db/schema.rb` for an index on that column; add one in a migration if the
    query runs on user-facing paths.
14. **Test passes locally, model constant errors in production** → blame the
    env → run `bin/rails runner "puts :ok"` with eager loading
    (`bin/rails runner -e production` if configured): tests lazy-load, so
    naming/autoload errors can hide until boot.

## Discriminating checks (cheap, in rising order of cost)

- **Does the route exist?** `bin/rails routes -g <name>` (~2 seconds).
- **Does the column/index exist?** Read `db/schema.rb`; or
  `bin/rails runner 'puts Model.column_names'`.
- **What SQL does this scope actually produce?**
  `bin/rails runner 'puts Model.my_scope.to_sql'` — settles most
  includes/joins/default_scope arguments instantly.
- **Which callbacks will fire on save?** `grep -n 'before_\|after_\|around_'
  app/models/<model>.rb` before changing any save/update call.
- **Is it an N+1?** Run the one test or request, then count queries:
  `grep -c 'SELECT' log/test.log` before vs after adding `includes`.
- **Is the schema clean?** `git diff db/schema.rb` after migrating — any
  unexpected hunk means drift from someone's unshared migration.

## Decision trees

**(a) Loading an association — `includes` vs `preload` vs `eager_load`:**
- Association appears in a `where`/`order` condition? → `eager_load` (single
  LEFT OUTER JOIN; the only one that lets you reference the association in
  SQL) — or `includes(...).references(...)`.
- Association only read after loading (views, serializers)? → `preload`
  (separate queries; no join blow-up on has_many).
- Unsure / default? → `includes` and let Rails pick; but if you then add a
  string condition on the association, you must add `.references`.

**(b) Callback vs explicit service call:**
- Does the logic keep THIS model's own data consistent (normalize a field,
  compute a derived column, set a default)? → callback is fine.
- Does it touch another model, mailer, job, or external API? → explicit
  service object or controller call. Test the service directly.
- Would it be wrong during a bulk import or backfill? → definitely not a
  callback.

**(c) Validation vs DB constraint:**
- Uniqueness or presence that must actually hold? → BOTH: model validation
  (for user-facing errors) + unique index / `null: false` (for enforcement —
  validations race, constraints don't).
- Complex cross-field rule for form feedback only? → validation alone is
  acceptable; say so.
- Referential integrity? → foreign key constraint in the migration
  (`add_foreign_key` / `foreign_key: true`), plus `dependent:` on the
  association.

## Verification recipe (in order; paste real output)

1. **Migrate:** `bin/rails db:migrate` — pass = clean run. Then
   `git diff db/schema.rb`: the diff must contain exactly the intended change;
   anything extra = drift or a wrong migration. (If project policy says agents
   don't apply migrations, report the generated file and run
   `bin/rails db:migrate:status` instead — then steps 3–5 still apply.)
2. **Reversibility:** `bin/rails db:rollback && bin/rails db:migrate` — fail
   here means an `IrreversibleMigration`; split into `up`/`down`.
3. **Tests:** the framework detected in loop step 1 — `bin/rails test` or
   `bundle exec rspec`. Failures that pre-date your change must be proven
   pre-existing (run on the base commit), not waved away.
4. **Lint:** `bundle exec rubocop <changed files>` if rubocop is configured.
   Report offenses; do not auto-correct other people's code.
5. **Boot check:** `bin/rails runner "puts :ok"` — catches autoload, constant
   naming, and initializer errors that lazy-loading tests miss.

## Reviewer checklist (priority-ordered hunt list)

1. String-interpolated SQL (`grep -rn 'where("' app/ | grep '#{'`) or raw
   `params` reaching a model write — instant FAIL.
2. Uniqueness validation without a matching unique index in `db/schema.rb` —
   FAIL; races will produce duplicates.
3. N+1: association traversal in any view/partial/serializer loop without
   `includes`/`preload` at the query origin. Name the exact call to add.
4. `update_attribute` / `update_column` / `delete_all` / `save(validate:
   false)` without a stated reason why skipping is safe.
5. Migration mixing schema + data, or irreversible `change` without
   `up`/`down`.
6. New FK or where-filtered column without an index.
7. `default_scope` introduced, or a callback reaching outside its own model.
8. `Time.now` / `Date.today` in app code (zone bugs).
9. Strong parameters present on every create/update path.
10. Verification recipe output actually pasted — commands, not summaries. No
    output → not verified → not done.
