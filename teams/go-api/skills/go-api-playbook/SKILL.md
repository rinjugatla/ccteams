---
name: go-api-playbook
description: Operational playbook for Go HTTP APIs — error wrapping, goroutine lifetimes, database/sql resource discipline, race-flagged verification. Read in full at the start of every task on this team.
---

# Go API Playbook

This is the literal procedure a frontier model follows when building or fixing
Go HTTP services. Follow it step by step; the order is the point. Go's compiler
catches type errors but is silent about the mistakes that actually ship bugs —
dropped errors, leaked goroutines, unclosed rows — so those checks are yours.

## Operating loop

1. **Read `go.mod` before anything else.** Note (a) the `go` directive — you may
   not use language features newer than it (loop-var semantics changed in 1.22,
   `slices`/`maps` packages need 1.21, generics need 1.18); (b) the dependency
   list — if `chi`/`gin`/`echo`/`sqlx` is there, the project uses it; if not,
   you use `net/http` and `database/sql`, never a new dependency on your own
   authority.
2. **Find the local dialect and mirror it.** Before writing a handler, read two
   existing ones: `grep -rn "http.ResponseWriter" --include="*.go" .` — copy the
   project's routing registration, error-response shape (JSON envelope? plain
   `http.Error`?), and middleware chaining style exactly. A "better" pattern
   that differs from the neighbors is a defect here.
3. **Place code where the package layout says it goes.** Match existing package
   boundaries (`internal/`, `cmd/`, handler vs service vs store layers). Do not
   invent a new package for one function.
4. **Write the smallest coherent change**, then immediately run
   `go build ./...`. Build after every file, not at the end — Go's unused
   import/variable errors compound fast.
5. **For every function you add, decide the ctx story out loud**: I/O functions
   take `ctx context.Context` as the first parameter, received from the caller
   (`r.Context()` in handlers), never `context.Background()` mid-path.
6. **For every `if err != nil` you write, decide the wrap** (see decision tree
   below) — the default is `fmt.Errorf("what I was doing: %w", err)`.
7. **Run the verification recipe** (below) and read your own diff line by line
   before handing off. Hunt specifically for `_ =`, missing `return` after
   error responses, and `defer` inside loops.

## Failure catalog — symptom → wrong instinct → correct move

1. **Function returns an error you don't need** → discard with `_` → handle or
   propagate it anyway; the only defensible `_ = f()` is on a call whose docs
   state the error is impossible or irrelevant (e.g. `(*bytes.Buffer).Write`),
   and it deserves a comment saying so.
2. **Wrapping an error for context** → `fmt.Errorf("failed: %v", err)` → use
   `%w`, not `%v`/`%s`. `%v` flattens the error to a string and every
   `errors.Is`/`errors.As` upstream silently stops matching.
3. **`err` checked but the bug persists** → stare at the logic → look for
   shadowing: `if v, err := f(); err != nil` or `err :=` inside a `for` block
   creates a NEW `err` that dies at the closing brace, leaving the outer `err`
   nil. `go vet` misses most of these; read the scopes.
4. **`panic: assignment to entry in nil map`** → wrap in a nil check at the
   crash site → initialize at creation: `m := make(map[K]V)` or a struct
   constructor that makes it. Reading a nil map is legal; writing panics — so
   the bug is wherever the map was born, not where it was written.
5. **A slice mysteriously changes after being passed elsewhere** → suspect
   concurrency → suspect `append` aliasing: sub-slices share the backing array,
   and `append` on one may write into the other while capacity remains. If the
   callee keeps or mutates the slice, copy it:
   `dst := append([]T(nil), src...)` (Go ≥1.21: `slices.Clone`).
6. **`db.Query` / `db.QueryContext` result** → range the rows and move on →
   three obligations, always: `defer rows.Close()` immediately after the error
   check, consume with `for rows.Next()`, then check `rows.Err()` after the
   loop. Skipping `Close` leaks a pooled connection; skipping `rows.Err()`
   turns a mid-iteration network failure into a silently short result set.
7. **Transaction with several steps** → call `tx.Rollback()` in each error
   branch → `defer tx.Rollback()` immediately after `BeginTx` succeeds, then
   `tx.Commit()` at the end. Rollback after a successful commit returns
   `sql.ErrTxDone` and is harmless; a missed rollback branch pins a connection
   forever.
8. **`http.Client` call** → read the body and return → `defer resp.Body.Close()`
   on every response, on every path, including when you only care about the
   status code. Unclosed bodies prevent connection reuse and leak file
   descriptors. Drain (`io.Copy(io.Discard, resp.Body)`) before close if you
   want the connection reused.
9. **Timeout inside a loop** → `select { case <-time.After(d): ... }` per
   iteration → each `time.After` allocates a timer the GC cannot reclaim until
   it fires (pre-1.23 runtime; version-mark: fixed in Go 1.23). Create one
   `time.NewTimer`/`time.NewTicker` outside the loop and `Reset`/`Stop` it.
10. **Deep helper needs a context** → `context.Background()` because threading
    ctx is tedious → plumb the parameter. A `Background()` mid-request detaches
    that call from cancellation and deadlines: the client disconnects and your
    query keeps running. `Background()` belongs in `main`, tests, and true
    fire-and-forget roots only.
11. **Goroutines in a `for` loop misbehave, all seeing the last element** →
    add sleeps → this is loop-variable capture (Go ≤1.21; fixed by per-iteration
    variables in Go 1.22 — check `go.mod`). On older versions, shadow it:
    `v := v` before the `go func(){...}()`, or pass it as an argument. Run
    `go test -race` to confirm.
12. **Handler hits an error** → `http.Error(w, msg, 500)` and keep going → add
    `return` immediately after. `http.Error` writes and returns; your handler
    doesn't, so the success path below then writes a second body onto a
    committed 500 response. Same rule after any early `w.WriteHeader`.
13. **Handler must set a status code** → `w.Write(body)` then
    `w.WriteHeader(404)` → order is fixed: header first. The first `Write`
    commits status 200 and every later `WriteHeader` is a logged no-op
    ("superfluous response.WriteHeader call").
14. **Long-lived background worker needed** → `go doWork()` and move on → run
    the goroutine launch checklist (decision tree B). If you can't name who
    cancels it, who waits for it, and where its error goes, do the work
    synchronously.
15. **Struct needs a context for later** → store `ctx` in a struct field →
    contexts are call-scoped; pass them as parameters. A stored context
    outlives its request and cancellation stops meaning anything.

## Discriminating checks

- **Which Go version am I writing for?** — `head -5 go.mod`. Decides loop-var
  semantics, generics, `slices`/`maps` availability. (~5 seconds)
- **Is this dependency already in the project?** — `grep <module> go.mod`. If
  absent, you don't add it; you use stdlib or stop and report.
- **Does my type actually satisfy the interface?** — add
  `var _ MyInterface = (*MyImpl)(nil)` next to the type; `go build ./...`
  answers definitively and the line documents the intent.
- **Is this code racy?** — write a 10-line test exercising the concurrent path
  and run `go test -race -run TestName ./pkg/...`. The race detector only sees
  executed interleavings — a pass is weak evidence, a failure is proof.
- **Does this handler behave right without a server?** —
  `httptest.NewRequest` + `httptest.NewRecorder`, call the handler directly,
  assert on `rec.Code` and `rec.Body`. No ports, no network, milliseconds.
- **Is a goroutine leaking?** — count before/after in a test:
  `runtime.NumGoroutine()` delta after your operation completes and a brief
  wait. A rising count across iterations is the finding.
- **Which side of a boundary corrupts the value?** — log at the boundary with
  `%#v` (not `%v`) so nil vs empty and pointer identity are visible.

## Decision trees

### A. Handling an error at a call site
- Caller upstream needs to react to WHAT failed (retry on not-found, map to
  404)? → the failure is an expected condition → define a sentinel in the
  owning package (`var ErrNotFound = errors.New("thing not found")`), return
  it (wrapped is fine), callers use `errors.Is`.
- Callers need DATA riding along (which field failed validation, which ID)? →
  define a typed error (`type ValidationError struct{ Field string }` with an
  `Error() string` method), callers use `errors.As`.
- Callers just need to know it failed, with a good trail? → the default:
  `return fmt.Errorf("loading user %d: %w", id, err)`. Message names the
  operation, not "error occurred"; no "failed to" stutter since the chain reads
  as one sentence.
- At the very top (handler/main)? → this is the ONE place you log the error
  and translate to a response. Log-and-also-return anywhere below duplicates
  every failure in the logs.

### B. Before launching any goroutine — three questions, no "nobody" answers
1. **Who cancels it?** → it must select on `ctx.Done()` or read from a channel
   the owner closes. No answer → it outlives the request/process gracelessly.
2. **Who waits for it?** → `sync.WaitGroup`, `errgroup.Group`, or a result
   channel someone receives from. No answer → shutdown races and lost work.
3. **Where does its error go?** → errgroup's return, an error channel, or a
   deliberate, logged decision to drop it. No answer → silent failure.
- Any answer is "nobody" → do not launch it. Do the work synchronously or
  restructure until all three have owners. `errgroup.WithContext` answers all
  three at once and is the default tool.

### C. Should this be an interface?
- Is there a second concrete implementation today, or a test that needs to
  substitute one? → No to both → use the concrete type. Speculative interfaces
  are indirection debt.
- Yes → define the interface in the CONSUMING package (the one that calls the
  methods), sized to what that consumer actually calls — usually 1–2 methods.
  Producers keep returning concrete structs; they never pre-declare interfaces
  for consumers.

## Verification recipe (in order; stop and fix at first failure)

1. `go build ./...` — must be clean. A build error means nothing else matters.
2. `go vet ./...` — must be clean. Vet findings (printf mismatches, unreachable
   code, copied locks) are bugs, not style.
3. `go test -race ./...` — the `-race` flag is non-negotiable whenever the
   change touches goroutines, channels, or shared state, and cheap enough to
   use always. A race report is a FAIL even if assertions pass.
4. `staticcheck ./...` — only if installed (`which staticcheck`); treat its
   findings as findings.
5. `git diff go.mod go.sum` — must be empty unless a dependency was added
   deliberately and stated in your report. An accidental `go get` or toolchain
   bump is a defect.
6. Re-read the full diff hunting three specifics: any `_ =` without a
   justifying comment, any error-response line not followed by `return`, any
   `defer` inside a loop body (runs at function exit, not iteration exit).

## Reviewer checklist (priority-ordered hunt list)

1. **Dropped and flattened errors** — grep the diff for `_, err` patterns
   followed by no check, bare `_ =`, and `fmt.Errorf` with `%v`/`%s` where the
   argument is an error. Each is a finding with file:line.
2. **Missing `return` after error writes** — every `http.Error(...)` and
   `w.WriteHeader(4..|5..)` in the diff must be followed by `return` before
   any further writes.
3. **Resource lifecycle** — every `Query`/`QueryContext` has
   `defer rows.Close()` + post-loop `rows.Err()`; every `BeginTx` has an
   immediate `defer tx.Rollback()`; every HTTP `resp` has
   `defer resp.Body.Close()`.
4. **Goroutine lifetimes** — for each `go ` statement in the diff, name its
   canceller, waiter, and error sink from the code. Any unanswerable → FAIL.
5. **Context discipline** — `context.Background()`/`context.TODO()` anywhere
   below `main`/tests, ctx stored in a struct field, or an I/O function without
   a ctx first parameter.
6. **Shadowed `err`** — read every `:=` inside `if`/`for` blocks in the diff
   for redeclared `err` that leaves an outer check dead.
7. **Actually run the recipe** — build, vet, `test -race`; reproduce failing
   output verbatim. A review without executed commands is not a review.
8. **`go.mod`/`go.sum` diff** — empty, or explicitly justified in the builder's
   report. Unexplained → FAIL.
