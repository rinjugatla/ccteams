---
name: django-playbook
description: Operational playbook for Django + DRF — settings/version detection, ORM loading strategy, migration discipline, serializer field hygiene, timezone rules, and exact verification commands. Read in full at the start of every task on this team.
---

# Django Playbook

This is the literal procedure a frontier model follows on a Django/DRF
codebase. Follow it in order; most Django defects come from skipping the
reconnaissance steps and writing "generic Django" instead of THIS project's
Django.

## Operating loop

1. **Pin the stack before writing a line.** Read the dependency file
   (`requirements.txt`, `pyproject.toml`, `Pipfile.lock`, or `poetry.lock`):
   - Django version: the `django` / `Django` pin. Stay inside that version's
     API — no Django 5.x features (`GeneratedField`, `db_default`) in a 4.2
     project. Mark any version-specific advice with the version.
   - DRF version: the `djangorestframework` pin, if present. If DRF is not in
     the deps, this is a plain-Django task — do not add serializers.
   - Test runner and lint: `pytest`/`pytest-django` + a `pytest.ini`/`[tool.pytest]`
     → `pytest`; otherwise `python manage.py test`. `ruff`/`flake8`/`black` in
     deps + a config → part of verification.
2. **Read `settings.py` (or the `settings/` package) before touching code.**
   - `INSTALLED_APPS`: which of your apps exist, which third-party apps are
     wired (`rest_framework`, `django_filters`, `debug_toolbar`).
   - `USE_TZ`: if `True` (set in generated settings for years; the global
     default flipped to `True` in Django 5.0), all naive datetimes are a bug —
     see failure catalog #6.
   - `AUTH_USER_MODEL`: never hard-code `auth.User`; reference
     `settings.AUTH_USER_MODEL` in FKs and `get_user_model()` in code.
   - `REST_FRAMEWORK`: default permission/auth/pagination classes — they change
     what an omitted `permission_classes` actually does.
3. **Detect the project's layout and MIRROR it, don't impose.** Read one
   neighboring app's `models.py`, `views.py`, `serializers.py`, `urls.py`:
   - Fat models (logic on models/managers) vs a `services.py`/`selectors.py`
     split — match whichever this repo already uses (decision tree c).
   - App structure (`apps/<name>/` vs flat), CBV vs FBV, viewsets+routers vs
     `APIView`. Convention in THIS repo beats convention in general.
4. **Run `python manage.py check` early** — before and after your change. It
   catches app-config, model, and admin errors that tests lazy-load past.
5. **Build in this order:** model (fields, `on_delete`, `Meta.indexes`,
   `Meta.constraints`) → `makemigrations` → manager/service → view → serializer
   → url wiring. Each layer is testable before the next exists.
6. **Migration discipline:**
   - One migration = schema change OR data change, never both.
   - After ANY model change, run `makemigrations` and read the generated file.
     A model edit without a migration is a runtime error waiting for deploy.
   - Data migrations use `RunPython` with a real `reverse` function
     (`RunPython.noop` only when truly irreversible — say so in a comment) and
     the historical model via `apps.get_model('app', 'Model')`, never the
     imported `app.models` class (it drifts).
7. **Run the verification recipe (below) and paste real output** before
   reporting. A diff without executed commands is a claim, not a result.

## Failure catalog — symptom → wrong instinct → correct move

1. **Page/endpoint slow, log shows repeated near-identical SELECTs** → add
   caching → it's an N+1: a template loop or serializer traverses a relation
   per row. Add `select_related`/`prefetch_related` (decision tree a) on the
   ORIGINATING queryset (`get_queryset`), not per object. Detect with
   `assertNumQueries` or `django-debug-toolbar`.
2. **Nested DRF serializer or `SerializerMethodField` is slow** → optimize the
   serializer → the serializer runs a query PER ROW. Fix it upstream:
   `prefetch_related` the nested relation in the view's `get_queryset`; the
   serializer then reads from the prefetch cache with zero extra queries.
3. **"How many rows?"** → `len(qs)` → `len(qs)` loads every row into memory
   and instantiates each model. Use `qs.count()` (SQL `COUNT`). Inverse trap:
   if you already need the rows AND the count, `len()` on the evaluated list is
   correct — don't add a second `.count()` query.
4. **"Is there any row?"** → `if qs:` or `qs.count() > 0` → `if qs:` evaluates
   and caches the whole queryset; `.count()` is a wasted `COUNT`. Use
   `qs.exists()` (`SELECT 1 ... LIMIT 1`).
5. **New `filter()`-ed or `order_by()`-ed field is slow** → "the DB will
   handle it" → add `db_index=True` on the field or a `Meta.indexes` entry, in
   a migration. Unindexed filters on user-facing paths are full scans.
6. **Storing/parsing a datetime** → `datetime.now()` / `datetime.today()` →
   with `USE_TZ=True` these produce naive datetimes and raise
   `RuntimeWarning` / compare wrongly. Use `django.utils.timezone.now()` and
   `timezone.make_aware(...)`; import `from django.utils import timezone`.
7. **"On save, also email/sync/recount"** → a `post_save` signal → signals put
   logic far from the caller, fire during tests/loaddata/bulk ops, and are
   invisible at the call site. Put the logic in the caller (a service function
   or the view) unless it must run for EVERY save from every path — and even
   then prefer overriding `save()`. `bulk_create`/`bulk_update` don't fire
   signals anyway.
8. **`Model.objects.get(...)`** → assume it returns → `get()` raises
   `DoesNotExist` (and `MultipleObjectsReturned`). Wrap it, use
   `get_object_or_404` in views, or `filter(...).first()` when absence is
   normal. An unhandled `get()` is a 500.
9. **Changed a model, tests still pass** → ship it → tests may run against an
   out-of-date migration state. Run `makemigrations --check --dry-run`; a
   nonzero exit means a migration is missing. Model change without a migration
   breaks on the next `migrate`.
10. **Multi-row write that must all-or-nothing** (transfer, order+line items)
    → sequential `.save()` calls → a mid-sequence exception leaves half-written
    state. Wrap the invariant in `with transaction.atomic():`. Note:
    `ATOMIC_REQUESTS` wraps the request but not management commands or Celery
    tasks — be explicit there.
11. **`ModelSerializer` with `fields = '__all__'`** → convenient → it serializes
    (and on write, mass-assigns) every column, leaking new fields the moment
    someone adds one. Use an explicit `fields = [...]`; mark server-controlled
    fields `read_only`. Separate read/write serializers when shapes diverge.
12. **Dynamic SQL condition** → `.raw("... WHERE x = '%s'" % val)` or
    `.extra(where=[f"x = {val}"])` → SQL injection. Pass params:
    `.raw("... WHERE x = %s", [val])`, or use ORM `filter(x=val)`. Grep for
    `.raw(` and `.extra(` with f-strings/`%`/`.format` in review.
13. **API view has no `permission_classes`** → rely on the default → the
    effective permission is `DEFAULT_PERMISSION_CLASSES` (often `AllowAny` if
    unset). Declare `permission_classes` explicitly on every view/viewset.
14. **User can fetch another user's object by id** → trust the URL → scope
    `get_queryset()` (or `get_object`) by `request.user` wherever ownership
    matters; object-level access can't rely on unguessable ids.

## Discriminating checks (cheap, in rising order of cost)

- **Does the project check clean?** `python manage.py check` (~seconds) —
  before you start, so you know a later failure is yours.
- **Is a migration missing?** `python manage.py makemigrations --check --dry-run`
  — nonzero exit = missing migration; the dry-run also prints what it WOULD
  generate.
- **What SQL does this queryset produce?** `str(qs.query)` in
  `python manage.py shell` — settles most `select_related`/`prefetch_related`
  and filter arguments instantly.
- **How many queries does this path run?** Wrap the code in
  `self.assertNumQueries(n)` in a test, or read `django-debug-toolbar` — the
  definitive N+1 check.
- **Which signals are wired?** `grep -rn '@receiver\|\.connect(' <app>/` before
  changing any `save`/`delete` path.
- **Is the datetime aware?** `python manage.py shell` →
  `from django.utils import timezone; timezone.now().tzinfo` is not `None`.

## Decision trees

**(a) Loading a relation — `select_related` vs `prefetch_related`:**
- Forward `ForeignKey` or `OneToOneField`? → `select_related('fk')` — one SQL
  JOIN, no extra query.
- `ManyToManyField`, or reverse FK (the "many" side of a `related_name`)? →
  `prefetch_related('items')` — a second query, joined in Python (a JOIN would
  multiply rows).
- Chaining across both? → combine: `select_related('a').prefetch_related('a__bs')`.
- Apply it on the queryset that ORIGINATES the data (a view's `get_queryset`,
  a manager method), never in a loop or serializer.

**(b) DRF endpoint shape — ViewSet+router vs APIView/generics:**
- Full CRUD on a model, standard REST semantics? → `ModelViewSet` +
  `DefaultRouter`. Least code, consistent URLs.
- A subset of CRUD, or list/detail with custom logic? → `generics`
  (`ListCreateAPIView`, `RetrieveUpdateDestroyAPIView`).
- Bespoke endpoint that isn't a resource (an action, a report, a webhook)? →
  `APIView` with explicit methods, or a `@action` on an existing viewset if it
  hangs off a resource. Don't force a non-resource into a router.

**(c) Business-logic placement — match the existing project style:**
- Logic touching ONE model's own data (derived field, a status transition,
  a query fragment)? → a model method, a custom `Manager`, or a `QuerySet`
  method.
- Logic ORCHESTRATING MULTIPLE models / external calls (place an order,
  register a user + send email + charge)? → a service function, only if the
  project already has a services layer. If the repo is fat-model with no
  `services.py`, put it in a manager/model method and don't introduce a new
  layer unannounced.
- Input shape/validation? → a Form (server-rendered) or a serializer (DRF),
  never `request.POST`/`request.data` straight onto a model.

## Verification recipe (in order; paste real output)

1. **Config:** `python manage.py check` — must pass clean.
2. **Migrations present:** `python manage.py makemigrations --check --dry-run`
   — nonzero exit means a model change has no migration; generate it. (If
   project policy says agents don't apply migrations, still run this check and
   report the generated file — do not run `migrate`.)
3. **Tests:** the runner detected in loop step 1 — `pytest` or
   `python manage.py test`. Failures pre-dating your change must be proven
   pre-existing (run on the base commit), not waved away. Add an
   `assertNumQueries` around any path you touched for N+1.
4. **Lint:** `ruff check <changed files>` / `flake8` / `black --check` if
   configured. Report offenses; do not auto-format other people's code.

## Reviewer checklist (priority-ordered hunt list)

1. `.raw(`/`.extra(` with f-string/`%`/`.format` interpolation, or raw request
   data reaching a model write — instant FAIL.
2. API view/viewset without explicit `permission_classes`, or `get_queryset`
   not scoped by `request.user` where ownership matters — FAIL.
3. `ModelSerializer` with `fields = '__all__'` on anything writable — FAIL
   (field leak / mass-assignment).
4. N+1: relation traversal in a template loop or serializer without
   `select_related`/`prefetch_related` on the originating queryset. Name the
   exact call and where to add it. Watch nested/`SerializerMethodField`.
5. Model change without a matching migration
   (`makemigrations --check --dry-run` nonzero).
6. `len(qs)` for a count, `if qs:`/`.count() > 0` for existence,
   `.get()` without `DoesNotExist`/`get_object_or_404` handling.
7. Multi-write invariant without `transaction.atomic`.
8. `datetime.now()`/`.today()` in app code with `USE_TZ=True` (use
   `timezone.now()`).
9. New filtered/ordered column without an index; missing `on_delete` intent;
   invariant enforced only in Python, not a `Meta.constraint`.
10. Signal used for logic that belongs in the caller.
11. Verification recipe output actually pasted — commands, not summaries. No
    output → not verified → not done.
