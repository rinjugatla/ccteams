---
name: python-fastapi-playbook
description: Operational playbook for FastAPI + Pydantic v2 async services — event-loop discipline, boundary validation, dependency lifetimes, response_model leaks, async ORM N+1s. Read in full at the start of every task on this team.
---

# Python FastAPI Playbook

This is the literal procedure a frontier model follows when building or fixing
FastAPI services. Follow it step by step; the order is the point. FastAPI +
async is unforgiving in one specific way: code that *works in a unit test*
(one request, no concurrency) can *stall the whole process under load* because
a single blocking call in an `async def` freezes the event loop for every
other request. The type checker will not catch that. Those checks are yours.

## Operating loop

1. **Read `pyproject.toml` / `requirements.txt` FIRST — the Pydantic major
   version changes everything.** `grep -E "pydantic" pyproject.toml
   requirements.txt` or `python -c "import pydantic; print(pydantic.VERSION)"`.
   v1 and v2 have different method names, validator decorators, and config
   styles (catalog below). Writing v2 idioms into a v1 project (or vice versa)
   produces import errors or silent no-ops. Note the package manager too:
   `poetry.lock` → `poetry run`, `uv.lock` → `uv run`, else `python -m`.
2. **Find the local dialect and mirror it.** Before writing a route, read two
   existing routers: `grep -rn "APIRouter\|@router\.\|@app\." --include="*.py" .`.
   Copy the project's router registration, response envelope, error-raising
   style (`HTTPException` vs custom handler), and dependency wiring exactly. A
   "cleaner" pattern that differs from the neighbors is a defect here.
3. **Find the schema and dependency patterns and mirror them.** Read one
   request model, one response model, and one `Depends` function. Match where
   validation lives (in the model, not the handler) and how sessions are
   acquired (`yield` dependency, not inline).
4. **Boot the app early to catch import-time errors.** Run the project's
   entrypoint (`uvicorn app.main:app` briefly, or `python -c "import app.main"`,
   adjust to the real module path). FastAPI executes decorators, dependency
   signatures, and Pydantic model definitions at import time — a bad type
   annotation or a v1/v2 mismatch fails here, before any request. Do this again
   after your change.
5. **For every path operation, decide `async def` vs `def` out loud** (tree A).
   The choice is dictated by what the body calls, not by preference.
6. **For every value crossing the HTTP boundary, put validation in a Pydantic
   model** (tree C) — not in `if` checks inside the handler.
7. **Run the verification recipe** (below) and re-read your diff hunting for
   blocking calls in `async def`, missing `await`, and handlers returning ORM
   objects without a `response_model`.

## Failure catalog — symptom → wrong instinct → correct move

1. **Endpoint is slow / times out only under concurrent load, fine in a single
   test** → add workers or raise the timeout → look for a blocking call inside
   an `async def`: `requests.get`, `time.sleep`, `open().read()`, a sync DB
   driver (`psycopg2`, sync `sqlalchemy` session), `boto3`. Any of these freezes
   the ONE event-loop thread, so every concurrent request waits. Fix: switch
   the handler to plain `def` (FastAPI runs it in the threadpool), or wrap the
   call `await asyncio.to_thread(blocking_fn, ...)`, or use an async client
   (`httpx.AsyncClient`, async DB driver).
2. **Coroutine created but nothing happens, no error** → assume the function is
   broken → you forgot `await`. `result = async_fn()` binds a coroutine object
   and never runs it; the body never executes. Python may warn
   "coroutine '...' was never awaited" late or not at all. Add `await`, and
   read every call to an `async def` in the diff.
3. **`.dict()` / `.json()` / `parse_obj` raises AttributeError or is
   deprecated** → downgrade Pydantic → these are v1 names. **Pydantic v2:**
   `.model_dump()`, `.model_dump_json()`, `Model.model_validate(data)`. Confirm
   the version (step 1) and use that version's names consistently.
4. **`@validator` "not called" or import error** → sprinkle more decorators →
   **Pydantic v2:** `@field_validator("x")` (per-field) and `@model_validator(mode="after"/"before")`
   (whole model) replace v1 `@validator`/`@root_validator`. `class Config:`
   becomes `model_config = ConfigDict(...)`. Mixing v1 decorators into v2 models
   silently skips validation or errors at import.
5. **Response includes fields you never meant to expose (password hash,
   internal flags)** → strip them by hand in the handler → declare
   `response_model=PublicSchema` on the decorator. FastAPI filters the output
   through it; returning a raw ORM object or dict leaks every attribute. Never
   ship a route whose response is an ORM instance without a `response_model`.
6. **Default argument shared/mutating across calls** (a list that keeps growing,
   a dict retaining old keys) → blame the caller → mutable default argument:
   `def f(items: list = [])` evaluates `[]` ONCE at def time and reuses it. Use
   `def f(items: list | None = None): items = items or []`. In Pydantic,
   `Field(default_factory=list)`, never `Field(default=[])`.
7. **Async ORM query is slow; N queries for N rows** → add caching → N+1 lazy
   loads. In async SQLAlchemy, lazy relationship access triggers implicit IO
   that is illegal outside a sync context and either errors or serializes. Load
   relationships eagerly: `select(User).options(selectinload(User.posts))` (or
   `joinedload` for many-to-one). Flag each relationship touched after the
   session-bound query.
8. **`except:` or `except Exception:` around an awaited call "to be safe"** →
   leave it → a bare `except:` swallows `asyncio.CancelledError`, breaking
   client-disconnect and shutdown cancellation, and hides real errors. Catch the
   specific exception you can handle; if you must catch broadly, re-raise
   `CancelledError` (`except Exception:` already excludes it in 3.8+, but `except
   BaseException:`/bare `except:` do not — never use those around `await`).
9. **Datetime comparison raises "can't compare offset-naive and offset-aware"**
   → call `.replace(tzinfo=None)` to make it go away → that discards real
   timezone info. Standardize on aware UTC everywhere:
   `datetime.now(timezone.utc)`, store aware, compare aware. **Pydantic v2**
   parses `datetime` fields as aware when the input has an offset — keep them
   aware end to end rather than stripping tzinfo at one site.
10. **Wrong HTTP status: returning 500 for bad input, or 200 with an error
    body** → pick whatever the client asked for → semantics are fixed. 422 is
    FastAPI/Pydantic's automatic code for a body/param that fails schema
    validation — do not raise it manually for business rules. 400 for a
    syntactically valid request that violates a business rule. 404 for a
    missing resource. 401 unauthenticated / 403 authenticated-but-forbidden.
    409 for a conflict (duplicate). Raise `HTTPException(status_code=...)`.
11. **Heavy work at import time** (open a DB connection, load a model, read a
    file at module top level) → leave it, it "only runs once" → it runs on every
    import including test collection and worker fork, and it has no shutdown
    hook. Move startup/shutdown into a lifespan handler:
    `@asynccontextmanager async def lifespan(app): <startup>; yield; <shutdown>`
    passed as `FastAPI(lifespan=lifespan)`. (v0.93+; older code uses
    `@app.on_event("startup"/"shutdown")`.)
12. **Dependency opens a DB session but connections leak / stay open** → close
    it in the handler → give the dependency a `yield` with cleanup after it
    (tree B): `async def get_db(): async with SessionLocal() as s: yield s`. The
    code after `yield` runs when the request finishes, even on error. A plain
    `return`ed session is never closed.
13. **`BackgroundTasks` / fire-and-forget work references the request DB
    session and fails after the response** → keep using the request session →
    the request-scoped session/dependency is torn down once the response is
    sent. Background work must open its own session. For CPU-heavy or truly
    long jobs, this is a queue's job (Celery/RQ/arq), not `BackgroundTasks`.
14. **`Depends()` called like a normal function or default recomputed per
    request unexpectedly** → call the dependency yourself → let FastAPI resolve
    it: `db: AsyncSession = Depends(get_db)`. FastAPI caches a dependency's
    result within a single request by default; the same `Depends(x)` used twice
    runs `x` once (pass `use_cache=False` only when you deliberately want two
    evaluations).
15. **Env/config read with `os.getenv` scattered across modules; type
    surprises** → keep sprinkling `os.getenv` → centralize in a
    `pydantic-settings` `BaseSettings` model (v2: the `pydantic-settings`
    package, `from pydantic_settings import BaseSettings`) that parses and
    type-coerces once. Everything downstream reads typed fields.

## Discriminating checks

- **Which Pydantic major am I writing for?** —
  `python -c "import pydantic; print(pydantic.VERSION)"`. Decides `.dict()` vs
  `.model_dump()`, `@validator` vs `@field_validator`, `Config` vs
  `model_config`. (~5 seconds; do it before writing a model.)
- **Is this call blocking?** — ask what the function does under the hood.
  Network/disk/DB with no `await` in front of it is blocking. If it's blocking
  and you're in an `async def`, it stalls the loop. `grep -n "requests\.\|time\.sleep\|\.execute(\|open(" ` the handler.
- **Does this handler actually run in the loop or the threadpool?** — `async
  def` runs IN the loop (must never block); plain `def` runs in the threadpool
  (blocking is fine). Read the keyword on the function line — that alone decides
  the rule.
- **Does the schema round-trip?** — in a REPL:
  `Schema.model_validate(sample_input)` then `.model_dump()`. Validation errors
  surface here in milliseconds, no server needed.
- **Does the app even import?** — `python -c "import app.main"` (real module
  path). Catches decorator/annotation/version errors before any request.
- **Is an endpoint correct without a live server?** — `TestClient(app)` (sync)
  or `httpx.AsyncClient(transport=ASGITransport(app=app), base_url="http://t")`
  (async) hits routes in-process; assert on `resp.status_code` and
  `resp.json()`. No ports, milliseconds.
- **Is a relationship lazy-loading?** — after the query, access a relationship
  and watch for a second query in the SQL echo (`echo=True` on the engine) or an
  async lazy-load error. A query appearing per row is the N+1.

## Decision trees

### A. `async def` vs `def` for a path operation
- Body performs **`await`-able async I/O** (async DB driver, `httpx.AsyncClient`,
  `aiofiles`)? → `async def`, and `await` every I/O call.
- Body performs **blocking I/O** with no async equivalent available (sync DB
  driver, `requests`, heavy `open().read()`, a CPU-bound loop)? → plain `def`.
  FastAPI runs it in the threadpool and the event loop stays free. This is the
  correct choice, not a fallback.
- Body is a **mix** — mostly async but one blocking call? → keep `async def`,
  wrap the blocking call: `await asyncio.to_thread(blocking_fn, ...)`.
- **Rule that overrides preference:** an `async def` body must not contain a
  blocking call (no `requests`, no `time.sleep`, no sync DB session, no
  unwrapped file IO). If it does, you chose wrong — switch to `def` or wrap it.

### B. Dependency with `yield` vs plain `return`
- Does the resource need **cleanup** after the request (DB session to close,
  file handle, lock to release, connection to return to a pool)? → `yield` it;
  put the cleanup after the `yield` (or use `async with`, which does both):
  `async def get_db(): async with SessionLocal() as s: yield s`. Code after
  `yield` runs on request teardown, including on error.
- Is it a **pure value** (parsed settings, the current user object, a validated
  query param) with nothing to release? → plain `return`.
- Rule: if you ever wrote `.close()` inside a handler, the thing being closed
  should have come from a `yield` dependency instead.

### C. Where does validation live?
- Input shape/constraints (required fields, ranges, formats, enums)? → in the
  **Pydantic request model** / `Annotated[..., Field(...)]` on the parameter.
  FastAPI returns 422 automatically; you write zero `if` checks.
- A **business rule** that needs DB state (email already taken, balance too
  low)? → in the handler/service AFTER validation, raise
  `HTTPException(400/409/...)`. This is not a Pydantic concern.
- Rule: a handler that starts with `if not body.x: raise HTTPException(422)` is
  reimplementing validation the model should own. Move the constraint into the
  model.

### D. Pydantic v1 → v2 translation (only if the project is on v2)
- `.dict()` → `.model_dump()`; `.json()` → `.model_dump_json()`;
  `parse_obj`/`parse_raw` → `model_validate`/`model_validate_json`.
- `@validator("f")` → `@field_validator("f")`; `@root_validator` →
  `@model_validator(mode="after")`; `class Config:` →
  `model_config = ConfigDict(...)`; `orm_mode=True` → `from_attributes=True`.
- If the project is on **v1**, use the v1 names — do not "upgrade" idioms mid-file.

## Verification recipe (in order; stop and fix at first failure)

1. **App imports/boots** — `python -c "import app.main"` (or briefly launch the
   project's uvicorn entrypoint). An import-time failure means nothing else
   matters. Use the detected package-manager prefix (`poetry run` / `uv run`).
2. **`pytest`** — run the suite via the project's runner. New/affected routes
   exercised with `TestClient` or `httpx.AsyncClient` (async tests need
   `pytest-asyncio` or `anyio` — check the config, don't add it silently).
3. **`ruff check .`** — only if ruff is configured (`grep -q ruff pyproject.toml`
   or a `ruff.toml`). Treat findings as findings.
4. **`mypy .`** (or `pyright`) — only if configured (`[tool.mypy]` /
   `mypy.ini` / `pyrightconfig.json`). Type errors at API boundaries are bugs.
5. **Lockfile untouched** — `git diff poetry.lock uv.lock requirements.txt` must
   be empty unless you deliberately added a dependency and said so in your
   report. An accidental install or resolver bump is a defect.
6. Re-read the full diff hunting three specifics: any blocking call inside an
   `async def`; any call to an `async def` missing `await`; any route returning
   an ORM object/dict without a `response_model`.

## Reviewer checklist (priority-ordered hunt list)

1. **Blocking calls in `async def`** — for every `async def` in the diff, scan
   the body for `requests.`, `time.sleep`, sync DB session calls, unwrapped
   `open(...)`, `boto3`, or any sync client. Each is a finding with file:line;
   fix is `def` handler or `asyncio.to_thread`. This is the highest-impact bug
   on this stack.
2. **Missing `await`** — every call to an `async def`/coroutine in the diff is
   preceded by `await` (or deliberately scheduled). An unawaited coroutine is a
   silent no-op.
3. **Pydantic version consistency** — confirm the project's major, then flag any
   v1 idiom in v2 code (`.dict()`, `@validator`, `class Config`, `orm_mode`) or
   vice versa. Mixed idioms mean skipped validation.
4. **Response leaks** — every route returning ORM/DB objects has a
   `response_model` (or explicit projection); no sensitive field (password,
   token, internal id) appears in a response schema.
5. **Dependency lifetimes** — DB sessions come from `yield` dependencies with
   cleanup after the yield, not `.close()` inside handlers; no request-scoped
   session used in background work.
6. **Status semantics** — 422 only for schema validation (automatic), 400/409
   for business rules, 404 for missing, 401/403 for auth. No 200-with-error-body.
7. **Mutable defaults & import-time work** — no `= []`/`= {}` defaults; no DB
   connect / model load / file read at module top level (belongs in `lifespan`).
8. **Actually run the recipe** — import/boot, `pytest`, and configured
   `ruff`/`mypy`; reproduce failing output verbatim. A review without executed
   commands is not a review. Lockfile diff empty or justified.
