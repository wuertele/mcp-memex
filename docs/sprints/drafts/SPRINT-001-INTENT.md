# Sprint 001 Intent: Schema Migrations and Migration Runner

## Seed

From `ROADMAP.md` Sprint 001 section (lines 326-400):

> Every subsequent sprint depends on a working database schema. The
> schema is specified in architecture Section 6 as nine migrations.
> This sprint lands those migrations as executable SQL files and
> builds the minimal migration runner that applies them.

**In scope:**
- Write migrations `0001_initial_schema.sql` through `0009_add_roles.sql`
  as specified in architecture Sections 6.1–6.9
- Write a minimal migration runner (Python or Bash; decided in sprint
  planning) that reads `schema_migrations`, applies pending migrations
  in order, records results with checksums
- Create a `migrations/` directory in the repo root and place all SQL
  files there
- Test migrations against the sprint 000 Docker Compose PostgreSQL
  instance
- Add schema-level database tests to `tests/integration/` that verify
  migration application, idempotency, trigger behavior, and the
  `canonicalize_thought_content()` function using the
  `tests/fixtures/canonicalization-cases.json` vectors from sprint 000
- Verify PostgreSQL role permissions via the test runner (memex_mcp
  cannot DELETE; memex_sync can)

**Out of scope:**
- Integration with any deployment target (Mycofu, Docker image, etc.)
- Rollback migrations (architecture is forward-only)
- Running migrations as part of a service startup (deferred to sprint
  002 or later)

**Validation (from the ROADMAP):**
- All 9 migrations apply cleanly against empty PostgreSQL 16+ with
  pgvector
- Re-running the runner after all migrations are applied is a no-op
- Applying 0001–0005 then 0006–0009 produces the same schema as
  applying all nine at once
- `canonicalize_thought_content()` trigger fires on INSERT and UPDATE
  and correctly normalizes content (CRLF, BOM, trailing newlines,
  Unicode NFD)
- `content_fingerprint` generated column populates correctly
- `memex_mcp` role cannot execute `DELETE FROM thoughts`
- `memex_sync` role can execute `DELETE FROM thoughts`
- `sync_log` trigger fires on INSERT/UPDATE/DELETE from non-daemon
  writers and skips when `app.sync_source = 'daemon'`

## Context

Sprint 000 is complete and validated end-to-end. The repo state
relevant to Sprint 001:

- `tests/compose.yaml` — pgvector/pgvector:pg16 bound to 127.0.0.1:55432,
  healthcheck gated. This is the authoritative PostgreSQL target for
  Sprint 001 integration tests.
- `tests/run-tests.sh` — one-button runner that brings up compose,
  runs `deno task test`, and tears down. Sprint 001 must extend this
  runner (not replace it) to include the new integration tests.
- `tests/fixtures/canonicalization-cases.json` — 22 hand-verified
  canonicalization vectors across all 6 rule buckets. Sprint 000
  verified the vectors themselves; Sprint 001 must wire them into a
  real database test that asserts `canonicalize_thought_content()`
  produces the expected output byte-for-byte.
- `tests/mock-inference/` — exists but is unrelated to the schema work;
  should not be modified.
- `tests/unit/smoke.test.ts` — the current smoke test; Sprint 001's
  integration tests should live in `tests/integration/` and be
  independently runnable, not bolted onto the smoke file.
- `docs/sprints/drafts/capture-is-pull-not-push.md` (design note) —
  out of scope for Sprint 001, but relevant context: mcp-memex will
  need client-side hooks to make capture reliable. Not a Sprint 001
  concern.

Additional constraints from `memex-architecture.md`:

- Architecture Section 5.4: **additive-only extension**. Migrations
  never drop or alter existing columns. Every migration must be
  forward-only and idempotent at the schema level.
- Architecture Section 6 (582-900): defines all nine migrations with
  complete SQL. Drafters should read this section — it is the
  authoritative source, not the ROADMAP summary.
- Architecture Section 6.4: defines canonicalization rules in SQL.
  The function must match the behavior encoded in the sprint 000
  fixtures exactly.
- Architecture Section 6.9: defines role grants. `memex_mcp` is
  read/insert/update only; `memex_sync` gets DELETE.

## Recent Sprint Context

- **Sprint 000** (completed 2026-04-12): Built the offline test
  platform — Docker Compose with pgvector + mock inference, shared
  canonicalization fixtures, one-button runner, smoke test, CI.
  Ran multi-agent review loop with Round 1 requiring rework on
  `tests/run-tests.sh` (ERR trap + exit code propagation). Final
  live run: exit 0. A small follow-up fix installed `wget` in the
  mock-inference image so its healthcheck could succeed. Sprint 001
  inherits all of this as stable infrastructure.

## Relevant Codebase Areas

- `migrations/` (new directory — does not exist yet)
- `scripts/memex-migrate` (new file — migration runner)
- `tests/integration/` (new directory — does not exist yet)
- `tests/run-tests.sh` (extend to run integration tests)
- `tests/fixtures/canonicalization-cases.json` (consumed, not modified)
- `tests/compose.yaml` (consumed, should not need modification but may
  need env var additions for role-based test connections)
- `memex-architecture.md` Section 6 (the spec)

## Constraints

- Architecture Section 5.4 additive-only rule: migrations are
  forward-only, never destructive
- Migrations must be idempotent at the runner level (re-running is a
  no-op)
- Migrations must be order-independent in the sense that applying
  0001-0005 then 0006-0009 produces the same final schema as applying
  all nine in one pass
- The runner must record checksums of applied migrations so tampering
  with an applied migration file is detectable
- The runner must be runnable from `tests/run-tests.sh` with no
  interactive prompts
- Integration tests run inside the sprint 000 Compose stack — do not
  introduce a second PostgreSQL environment
- Canonicalization function in SQL must produce the same output as the
  22 fixtures in `tests/fixtures/canonicalization-cases.json` for every
  fixture, byte-for-byte
- Role-grant tests must connect as `memex_mcp` and `memex_sync`
  separately and assert the DELETE permission boundary
- The trigger-based `sync_log` behavior must be exercised with both
  a non-daemon writer (log entry created) and a daemon writer
  (log entry suppressed via `SET LOCAL app.sync_source = 'daemon'`)
- No deployment-target-specific code (no Mycofu, no NixOS, no
  Dockerfile for a memex service)

## Success Criteria

A Sprint 001 is successful if:

1. All nine migration SQL files exist under `migrations/` and match
   architecture Section 6 in intent and behavior
2. `scripts/memex-migrate` applies them cleanly against an empty
   pgvector/pg16 and is a no-op on re-run
3. `tests/run-tests.sh` runs integration tests that cover every
   validation bullet in the ROADMAP seed above
4. The canonicalization function passes all 22 fixture vectors
5. Role-permission boundary is enforced and tested
6. The sync_log trigger is tested in both the daemon and non-daemon
   paths
7. Sprint 001 code lands without modifying `memex-architecture.md`
   (the schema spec is the input, not the output)

## Open Questions for Drafters

1. **Runner language: Python or Bash?** Python is easier for checksum
   tracking, structured error handling, and integration-test
   invocation from the same process. Bash is simpler to ship and
   depends on nothing beyond `psql`. Drafters should pick one with
   justification — do not propose both.
2. **Integration test language: Deno or Python?** Sprint 000's smoke
   test uses Deno. Keeping integration tests in Deno reduces
   toolchain sprawl; Python would better match a Python runner.
   Drafters should argue for one and explain how the choice interacts
   with the runner decision.
3. **Migration checksum algorithm?** SHA-256 of the raw file bytes is
   the obvious choice. Confirm it is sufficient (it is) or argue
   otherwise.
4. **How does the runner get its database credentials?** Via the
   `MEMEX_TEST_*` env vars that `tests/run-tests.sh` already exports,
   or via a new channel? Prefer the former to avoid inventing config
   surface.
5. **Where does role creation happen?** Migration 0009 creates the
   roles, but roles are server-scoped in PostgreSQL, not database-
   scoped. Drafters must explain how idempotency holds for CREATE
   ROLE — do they wrap it in a DO block with an existence check? Do
   they tolerate 42710 errors? Be specific.
6. **Integration test isolation.** Should each test run against a
   fresh database, or against the shared one brought up by compose?
   If shared, how do tests avoid interfering with each other? If
   per-test, how is the setup cost kept low?
7. **Does the runner belong in the sprint 000 compose stack as its
   own service, or as a separate step in `run-tests.sh`?** Drafters
   should argue one way. Keeping it out of compose is probably
   simpler but worth justifying.
8. **How does a failed migration leave the database?** If migration
   0005 fails mid-apply, what is the recovery story? The architecture
   says forward-only; there is no rollback. Drafters should explain
   the operator experience when something goes wrong.

Drafters: do not invent scope beyond the ROADMAP seed. If an idea is
tempting but not in scope, list it in "Open Questions" at the bottom
of your draft, not in the Implementation Plan.
