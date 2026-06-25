# Active Team: django (ccteams)

This project uses the **django** team: Django + Django REST Framework, batteries-included,
convention-over-configuration.

## Orchestration rules

- For models, migrations, views, forms, admin, management commands, and Django plumbing —
  delegate to **django-builder**.
- For REST API work — serializers, viewsets, routers, permissions, authentication,
  pagination, throttling — delegate to **drf-api**. If a feature is plain server-rendered
  Django (templates, forms, admin), it stays with django-builder; if it exposes JSON over
  DRF, it goes to drf-api.
- Before any change is considered done, **django-reviewer** must verify it: N+1 queries,
  migration safety and reversibility, missing model/serializer validation, permission
  gaps, and the project's test runner (`pytest` or `manage.py test`). No change ships on
  the builder's word alone.
- Fat model / thin view. Business logic lives on the model, a model manager, or a service
  function — not in the view or serializer. Redirect builders accordingly.

## Stack defaults (unless the project's settings or lockfile override)
- Django version from `pyproject.toml` / `requirements.txt` / `Pipfile.lock`. Stay within
  that version's API.
- Migrations are generated with `makemigrations`, reviewed, and never auto-applied by an
  agent — the user runs `migrate` after review.
- `select_related` / `prefetch_related` for any query that crosses an association.
- DRF for JSON APIs; serializers own field-level validation, views own permissions.
- Settings split by environment; secrets via environment variables, never committed.
