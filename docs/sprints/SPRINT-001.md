# Sprint 001: Schema Migrations and Migration Runner

**Status:** Planned
**Based on:** Sprint 001 intent (`docs/sprints/drafts/SPRINT-001-INTENT.md`), ROADMAP Sprint 001 scope, and `memex-architecture.md` Sections 5.4 and 6
**Prerequisites:** Sprint 000 complete
**Produces for later sprints:** Executable PostgreSQL schema, minimal forward-only migration runner, schema-level integration coverage for canonicalization / CDC / roles, and a reusable `schema_migrations` baseline

---

## 1. Overview

Sprint 001 turns the architecture's schema specification into executable
code. The sprint lands the nine SQL migrations from
`memex-architecture.md` Section 6 under `migrations/`, plus a minimal
Bash runner at `scripts/memex-migrate` that discovers pending files,
applies them in order, and records version/checksum rows in
`schema_migrations`. The schema remains additive-only and forward-only,
matching Section 5.4: no rollback support, no destructive alters, and
no deployment-target coupling.

The sprint reuses the Sprint 000 Docker Compose PostgreSQL stack rather
than introducing a second database environment. Verification stays
inside the existing Deno test harness by adding
`tests/integration/migrations.test.ts`, which drives the runner and
validates the live schema against the existing fixture corpus in
`tests/fixtures/canonicalization-cases.json`. The suite covers fresh
apply, no-op rerun, staged-vs-full schema equivalence, trigger
behavior, generated columns, checksum drift detection, apply-time
migration failure, and the `memex_mcp`/`memex_sync` DELETE boundary.

Two non-obvious constraints shape the plan. First, PostgreSQL roles are
cluster-scoped, not database-scoped, so the only migration that needs
file-level idempotency is `0009_add_roles.sql` — every other file stays
declarative and matches architecture Section 6 verbatim. Second, the
canonicalization fixture corpus contains BOM, CRLF, NFD, and combining
characters, so the integration tests must inject fixture content
through a byte-safe path (`pg_read_file` from a container-local temp
file) rather than through `psql -c`.

The sprint does not modify `memex-architecture.md`, does not embed
migrations into service startup, and does not add rollback machinery.
Its job is to make the architecture executable and prove the resulting
schema behaves exactly as specified.

## 2. Use Cases

| # | Scenario | Inputs | Expected Behavior |
|---|---|---|---|
| 1 | Fresh empty database bootstrap | Operator or test harness points `scripts/memex-migrate` at an empty PostgreSQL 16+ database with pgvector available | Runner applies `0001` through `0009` in lexical order, records nine `schema_migrations` rows, and exits 0 |
| 2 | Idempotent rerun | Same database after all migrations are already applied | Runner detects no pending work, verifies stored checksums against on-disk files, performs no SQL changes, and exits 0 |
| 3 | Staged schema rollout | Database receives `0001` through `0005`, then later receives `0006` through `0009` | Final schema matches the result of applying all nine migrations to a fresh database |
| 4 | Applied migration file tampered | An already-recorded migration file is edited on disk after first application | Runner stops before applying anything else and reports a checksum mismatch for the modified version, exits 2 |
| 5 | Apply-time migration failure | A migration file contains SQL that errors during apply | Failed migration is not recorded in `schema_migrations`; the runner exits 1; already-applied earlier migrations remain intact |
| 6 | Canonicalization on insert | `INSERT INTO thoughts` with BOM, CRLF, missing trailing newline, or NFD Unicode content | `canonicalize_thought_content()` rewrites `content` to the canonical form from the fixture corpus before the row is stored |
| 7 | Canonicalization on update | Existing row is updated with non-canonical content | The same trigger rewrites the updated value to the canonical form before commit |
| 8 | Fingerprint and timestamps | Inserted or updated `thoughts` row | `content_fingerprint` is populated from canonicalized content, and `updated_at` advances on update while `created_at` is stable |
| 9 | Human or MCP write path | Non-daemon writer inserts, updates, or deletes a row in `thoughts` | `sync_log` receives one corresponding CDC row per operation |
| 10 | Daemon write path | Session sets `app.sync_source = 'daemon'` before writing | `sync_log` trigger suppresses logging so the daemon does not create feedback loops |
| 11 | MCP role safety boundary | Client connects as `memex_mcp` and attempts `DELETE FROM thoughts` | PostgreSQL rejects the statement with a permissions error (SQLSTATE 42501) |
| 12 | Sync daemon delete authority | Client connects as `memex_sync` and attempts `DELETE FROM thoughts` | PostgreSQL allows the delete, preserving the architecture's deletion invariant |

## 3. Architecture

### 3.1 Migration Set and Repository Layout

Sprint 001 creates a new top-level `migrations/` directory containing:

- `0001_initial_schema.sql`
- `0002_add_ob_uuid.sql`
- `0003_add_source_column.sql`
- `0004_add_content_fingerprint.sql`
- `0005_add_updated_at.sql`
- `0006_add_thought_relations.sql`
- `0007_add_sync_log.sql`
- `0008_add_sync_state.sql`
- `0009_add_roles.sql`

These files follow the exact architectural sequence from
`memex-architecture.md` Section 6. The ordering is not cosmetic: later
migrations depend on objects created by earlier ones, and the runner
uses the numeric prefix as the sole ordering key.

The schema remains a strict additive extension of the OB1 baseline.
Sprint 001 adds new columns, triggers, indexes, functions, and tables,
but it does not drop columns, rewrite existing semantics, or add
rollback logic. `schema_migrations` remains the only bookkeeping table
the runner uses.

**File-level idempotency is intentionally minimal.** The runner owns
idempotency via `schema_migrations` and checksum comparison. Every
migration file except `0009` is written as plain declarative SQL
(`CREATE TABLE foo (...)`, not `CREATE TABLE IF NOT EXISTS foo (...)`),
matching architecture Section 6 verbatim. The one exception is
`0009_add_roles.sql`: PostgreSQL roles are cluster-scoped, not
database-scoped, so if the migration is applied against a second
database on the same cluster (which the per-scenario-DB test topology
will do), the roles from the first apply already exist cluster-wide.
`CREATE ROLE` statements in `0009` are therefore wrapped in `DO` blocks
that first check `pg_roles`. `GRANT` statements can run unconditionally
because grants are safe to reissue.

Because Sprint 001 is deployment-agnostic, the role passwords remain
the literal placeholder values from Section 6.9 for the disposable
test environment. Replacing those placeholders with deployment-specific
secrets is downstream provisioning work and is out of scope here.

**Role grants for `memex_mcp` are exactly those from architecture
Section 6.9**: SELECT/INSERT/UPDATE on `thoughts`, SELECT on `sync_log`,
SELECT/INSERT/UPDATE on `sync_state`, USAGE on `thoughts_id_seq`, and
EXECUTE on `match_thoughts`. No grant on `thought_relations`. The
architecture is input, not output; Sprint 001 must not broaden the
grant matrix.

### 3.2 Migration Runner Contract

`scripts/memex-migrate` is a Bash script. Bash is the right fit here
because the runner is intentionally small, lives close to the SQL
files, and does not justify introducing Python packaging or dependency
management into a repository that currently has none.

The runner contract is:

1. Discover migration files in version order from `migrations/` by
   default.
2. Accept an optional `MEMEX_MIGRATE_DIR` environment variable so
   tests can point the runner at a temporary copy when validating
   checksum-drift handling or synthetic bad-migration handling.
3. Accept an optional `MEMEX_MIGRATE_MAX` environment variable so
   tests can halt after a specified version (e.g. `0005`) to exercise
   staged-apply. This is a test-only read-path override; operator use
   is not yet supported.
4. Compute SHA-256 over the raw file bytes for every discovered
   migration file.
5. Read `schema_migrations` and build an in-memory map of applied
   version → checksum.
6. For each already-applied version, compare the stored checksum to
   the on-disk checksum and abort immediately on mismatch.
7. For each pending version, apply the SQL file in its own transaction
   with `ON_ERROR_STOP=1`, then insert that version/checksum into
   `schema_migrations` in the same transaction.
8. Emit clear non-interactive logs showing applied versions, skipped
   versions, and hard-stop failures.

**Runner exit codes** are distinct for machine consumption:

- `0` — success (either pending migrations applied, or nothing to do)
- `1` — a migration failed during apply
- `2` — checksum drift detected against an already-applied migration
- `3` — preflight error (bad arguments, missing environment, unreadable
  migrations directory)

Database credentials come from standard `PG*` environment variables
when present. In the Sprint 000 test harness path, the runner falls
back to the existing `MEMEX_TEST_DB_*` variables exported by
`tests/run-tests.sh`, so no new memex-specific credential channel is
needed.

The runner also honors a `PSQL` command override. In normal operator
use, that value defaults to `psql`. In the Sprint 001 automated test
path, `tests/run-tests.sh` points `PSQL` at
`docker compose -p memex-test -f tests/compose.yaml exec -T postgres psql`,
which preserves one-button execution without introducing a host
PostgreSQL-client prerequisite.

The `MEMEX_MIGRATE_DIR` override only affects the runner's *read*
path. The runner never writes to its migration directory, so tests
can safely point it at a `Deno.makeTempDir()` copy without any risk
of polluting the committed `migrations/` tree.

### 3.3 Test Topology and Isolation

Sprint 001 keeps the existing Sprint 000 Compose topology unchanged:
one PostgreSQL container and one mock inference container, both bound
to the same fixed host ports. The migration runner is not added as its
own Compose service. It remains a one-shot script invoked by
`tests/run-tests.sh` and by the integration suite.

Integration tests live in `tests/integration/migrations.test.ts` and
stay in Deno. This avoids a second test runtime, preserves
`deno task test` as the one command path, and lets the new suite
reuse the existing fixture-loading and subprocess patterns from
Sprint 000.

**Isolation happens at the database level, not at the container
level.** The suite creates a fresh database per scenario on the shared
PostgreSQL server:

- `memex_it_full_apply` — full `0001`–`0009` apply
- `memex_it_staged_apply` — `0001`–`0005` then `0006`–`0009`
- `memex_it_checksum` — checksum-drift detection
- `memex_it_failed_migration` — synthetic bad-migration apply failure
- `memex_it_behavior` — canonicalization, fingerprint, `updated_at`,
  `sync_log` behavioral tests
- `memex_it_roles` — `memex_mcp` and `memex_sync` permission boundary

Each scenario uses `CREATE DATABASE memex_it_<scenario>` at setup and
`DROP DATABASE memex_it_<scenario> WITH (FORCE)` at teardown.
`WITH (FORCE)` terminates lingering backends and avoids flakes from
connection leaks. This keeps setup cost low while preventing
interference between schema snapshots, role tests, and trigger
assertions.

**The suite runs serially.** PostgreSQL roles are server-scoped and
`0009_add_roles.sql` is intentionally cluster-global, not
per-database. Parallel scenarios could race on role creation or on
role-password state. Serial execution eliminates that class of bug
at the cost of a few seconds of test time.

### 3.4 Schema Behaviors Under Test

The live-schema verification surface for Sprint 001 is:

- Migration application and `schema_migrations` bookkeeping
- Idempotent rerun with no pending work
- Full schema equivalence between all-at-once apply and staged apply
- Checksum-drift detection on a tampered migration file
- Apply-time migration failure behavior (no `schema_migrations`
  row, earlier migrations remain, runner exits 1)
- `canonicalize_thought_content()` trigger behavior on both `INSERT`
  and `UPDATE`
- `content_fingerprint` generated column output after canonicalization
- `updated_at` trigger behavior on row updates
- `sync_log` trigger behavior for `INSERT`, `UPDATE`, and `DELETE`
- Daemon-loop suppression via `SET LOCAL app.sync_source = 'daemon'`
- Role grants for `memex_mcp` and `memex_sync`

**Schema equivalence** is validated with normalized
`pg_dump --schema-only --no-owner --no-privileges` output from two
databases rather than by hand-curated catalog spot checks. That gives
one high-signal comparison for tables, columns, indexes, functions,
triggers, and grants together. Output noise (version banner, leading
`SET` statements) is stripped before diffing; the executor enumerates
the exact stripping rules during Phase 4 implementation.

**Canonicalization fixture injection** must avoid shell- and
`psql -c`-level byte corruption. The integration test helper writes
each fixture's raw bytes into a container-local temp file via
`docker compose exec -T postgres sh -c 'cat > /tmp/content.txt'`
piping the bytes on stdin, then runs
`INSERT INTO thoughts (content) VALUES (pg_read_file('/tmp/content.txt')::text)`
(or the analogous `UPDATE`). `pg_read_file` treats the file as bytes
and bypasses every layer of shell, `psql`, and TypeScript string
escaping. The test then `SELECT`s the stored value and asserts
byte-for-byte equality against the fixture's expected output.
Reconstructing `E'...'` escape strings in Deno was rejected because
it is error-prone for fixtures containing backslashes, CR bytes, and
combining characters.

### 3.5 Failure and Recovery Model

Sprint 001 is explicitly forward-only. If migration `0005` fails, the
operator does not roll back the database to zero. Instead:

1. All earlier successful migrations remain applied.
2. The failed migration is not recorded in `schema_migrations`.
3. The runner exits non-zero (exit code 1 for SQL failure; exit code 2
   for checksum drift) and reports the version that failed.
4. The operator fixes the underlying issue and reruns the runner.
5. The rerun resumes from the first unapplied migration.

Checksum mismatch is treated differently from ordinary SQL failure. It
is an integrity violation, not a transient execution problem. The
runner halts before applying any new work and instructs the operator
to either restore the expected migration file or create a fresh
database if they intentionally changed migration history.

## 4. Implementation Plan

Five phases, each independently reviewable. Each phase lists the files
it creates or modifies and the concrete tasks within it.

### Phase 1 — Migration Directory and SQL Files

**Files created:**
- `migrations/0001_initial_schema.sql`
- `migrations/0002_add_ob_uuid.sql`
- `migrations/0003_add_source_column.sql`
- `migrations/0004_add_content_fingerprint.sql`
- `migrations/0005_add_updated_at.sql`
- `migrations/0006_add_thought_relations.sql`
- `migrations/0007_add_sync_log.sql`
- `migrations/0008_add_sync_state.sql`
- `migrations/0009_add_roles.sql`
- `migrations/README.md`

**Tasks:**

1. Create `migrations/` at the repo root and land the nine files in
   the exact Section 6 order.
2. Transcribe the SQL from `memex-architecture.md` Sections 6.1–6.9
   into those files without changing the intended behavior and without
   adding `IF NOT EXISTS` / `CREATE OR REPLACE` qualifiers beyond what
   Section 6 already specifies. The SQL files should read as
   declarative schema deltas that match the architecture spec
   verbatim.
3. In `0009_add_roles.sql` only, wrap `CREATE ROLE memex_mcp` and
   `CREATE ROLE memex_sync` in `DO $$ BEGIN IF NOT EXISTS (SELECT 1
   FROM pg_roles WHERE rolname = 'memex_mcp') THEN CREATE ROLE ... ;
   END IF; END $$;` blocks. Keep all `GRANT` statements unconditional.
   The grant matrix must match Section 6.9 exactly — no
   `thought_relations` grant for `memex_mcp`.
4. Preserve the additive-only rule from Section 5.4: no destructive
   DDL, no rollback scaffolding, no startup coupling.
5. Keep committed SQL files in LF line endings so checksum behavior is
   stable across platforms.
6. Do not modify `memex-architecture.md`; it remains the input spec.
7. Write `migrations/README.md` documenting: manual apply path, runner
   usage, failure-recovery model, additive-only rule, and test-password
   policy.

### Phase 2 — Minimal Migration Runner

**Files created:**
- `scripts/memex-migrate`

**Tasks:**

1. Write `scripts/memex-migrate` as a non-interactive Bash script with
   `set -euo pipefail`.
2. Discover `NNNN_*.sql` files, sort them lexically, and reject gaps
   or duplicate version prefixes loudly.
3. Honor `MEMEX_MIGRATE_DIR` as a read-path override for the
   migrations directory (defaults to `migrations/`). The override
   must never cause the runner to write anywhere other than
   `schema_migrations`.
4. Honor `MEMEX_MIGRATE_MAX` as an optional upper bound on applied
   versions (string comparison). When set, stop after applying the
   named version. This is a test-only hook; document it in the
   script header.
5. Compute SHA-256 on raw file bytes for every migration file before
   any apply work begins.
6. Resolve connection settings from `PG*` first, then from
   `MEMEX_TEST_DB_*` as a test-harness fallback.
7. Support a `PSQL` command override so automated tests can use the
   Compose container's client without requiring host `psql`.
8. Query `schema_migrations`, validate stored checksums, and abort
   immediately on drift with exit code 2.
9. Apply each pending migration in its own transaction (piped through
   `psql --single-transaction --set ON_ERROR_STOP=1` or equivalent)
   and only record the row in `schema_migrations` after the SQL
   succeeds. If the SQL fails, exit with code 1.
10. Print concise logs for "applied", "already applied", "checksum
    mismatch", and "failed version" outcomes.
11. Document runner exit codes at the top of the script: 0 success,
    1 migration failed, 2 tamper detected, 3 prereq error.

### Phase 3 — Test Harness Wiring

**Files modified:**
- `deno.json`
- `tests/run-tests.sh`

**Tasks:**

1. Extend `deno.json` so Sprint 000's smoke suite and Sprint 001's
   integration suite are both first-class tasks (e.g. `test:unit` and
   `test:integration`; keep the existing `test` task working). Use
   scoped permissions (`--allow-net --allow-read --allow-env
   --allow-run`), not `--allow-all`.
2. Keep the existing smoke path independently runnable; do not fold
   integration assertions into `tests/unit/smoke.test.ts`.
3. Update `tests/run-tests.sh` to invoke both suites in one flow
   without replacing its existing preflight, bring-up, readiness, or
   teardown behavior. Reuse the same `set +e` / capture / `set -e`
   pattern Sprint 000 established for the `deno task test` block.
4. Export the existing `MEMEX_TEST_DB_*` contract plus the `PSQL`
   override needed by the migration runner and Deno integration
   helpers.
5. Export role-test connection values (`MEMEX_TEST_MCP_PASSWORD`,
   `MEMEX_TEST_SYNC_PASSWORD`) matching the Section 6.9 placeholder
   passwords so the integration suite can connect separately as
   `memex_mcp` and `memex_sync`.
6. Keep `tests/compose.yaml` unchanged unless a concrete test blocker
   appears; the default plan is no Compose topology changes in
   Sprint 001.

### Phase 4 — Migration and Runner Integration Tests

**Files created:**
- `tests/integration/migrations.test.ts`

**Tasks:**

1. Add helpers that create and drop fresh per-scenario databases on
   the shared PostgreSQL server using
   `DROP DATABASE ... WITH (FORCE)` for teardown.
2. Add a **fresh apply** test that runs `scripts/memex-migrate`
   against an empty database and asserts that versions `0001` through
   `0009` are recorded in order with non-null SHA-256 checksums
   (`length(checksum) = 64`).
3. Add a **no-op rerun** test that executes the runner twice and
   asserts no additional rows or checksum changes appear on the
   second pass.
4. Add a **staged apply** test that uses `MEMEX_MIGRATE_MAX=0005` to
   apply `0001`–`0005`, then clears `MEMEX_MIGRATE_MAX` and reruns
   to apply `0006`–`0009`, then compares the normalized
   `pg_dump --schema-only --no-owner --no-privileges` output to a
   database that received all nine migrations in one pass. The
   executor enumerates the exact lines to strip (version banner,
   `SET` block, any other non-semantic noise) during implementation.
5. Add a **checksum-drift** test that copies `migrations/` to a
   `Deno.makeTempDir()` directory via `MEMEX_MIGRATE_DIR`, applies
   from that copy once, mutates an already-applied file in the temp
   copy, reruns the runner, and asserts exit code 2 with no new
   `schema_migrations` rows. The test's `finally` block removes the
   temp dir. The committed `migrations/` tree is never touched.
6. Add a **synthetic bad-migration** test that creates a temp dir
   containing the first four real migrations plus a synthetic
   `0005_bad.sql` file that errors (e.g.
   `SELECT 1/0;`), points the runner at it via `MEMEX_MIGRATE_DIR`,
   and asserts:
   - the runner exits with code 1
   - migrations `0001`–`0004` are recorded in `schema_migrations`
   - no row exists for version `0005`
   - the prior database state is otherwise intact

### Phase 5 — Behavioral Schema Tests

**Files modified:**
- `tests/integration/migrations.test.ts`

**Tasks:**

1. Add an `insertThoughtWithContent(content: Uint8Array): Promise<bigint>`
   helper that writes the content bytes to
   `/tmp/content.txt` inside the postgres container via
   `docker compose exec -T postgres sh -c 'cat > /tmp/content.txt'`
   piped stdin, then runs
   `INSERT INTO thoughts (content) VALUES (pg_read_file('/tmp/content.txt')::text) RETURNING id`.
   Add an analogous `updateThoughtContent(id, content)` helper for
   the update path.
2. Load `tests/fixtures/canonicalization-cases.json` and assert all
   22 fixtures on `INSERT` byte-for-byte against the stored
   `thoughts.content` value.
3. Repeat the same fixture corpus against `UPDATE` so trigger
   coverage is explicit for both write paths.
4. Assert that `content_fingerprint` stores the SHA-256 hex of the
   canonicalized content, not the pre-trigger input.
5. Assert that `updated_at` advances on update while `created_at`
   remains stable.
6. Assert that non-daemon `INSERT`, `UPDATE`, and `DELETE`
   operations each create the expected `sync_log` row.
7. Assert that writes wrapped in `SET LOCAL app.sync_source = 'daemon'`
   do not create `sync_log` rows. Run BEGIN/SET LOCAL/write/COMMIT in
   a single `psql` heredoc so the session variable does not lose
   scope across subprocess invocations.
8. Connect separately as `memex_mcp` and `memex_sync` using the
   Section 6.9 placeholder passwords and assert the DELETE
   permission boundary: `memex_mcp` → SQLSTATE 42501;
   `memex_sync` → successful `DELETE <n>`.

## 5. Verification Plan

### 5.1 Automated Checks

| # | Check | What It Validates | File | Executor Notes |
|---|---|---|---|---|
| 1 | Fresh migration apply | All nine SQL files execute cleanly on an empty PostgreSQL 16+ database and record `schema_migrations` rows | `tests/integration/migrations.test.ts` | Runs `scripts/memex-migrate` against a fresh per-scenario database; assert nine rows with `length(checksum) = 64` |
| 2 | No-op rerun | Re-running the runner after a full apply performs no additional work | `tests/integration/migrations.test.ts` | Compare `schema_migrations` row count and stored checksums before and after rerun |
| 3 | Checksum drift detection | Applied migration tampering is detectable and blocks future work | `tests/integration/migrations.test.ts` | Uses `MEMEX_MIGRATE_DIR` pointing at a temp copy of `migrations/`; mutates an already-applied file; expects runner exit code 2 |
| 4 | Staged-vs-full schema equivalence | `0001`–`0005` then `0006`–`0009` yields the same final schema as `0001`–`0009` in one pass | `tests/integration/migrations.test.ts` | Uses `MEMEX_MIGRATE_MAX=0005` for the staged path; compares normalized `pg_dump --schema-only --no-owner --no-privileges` output |
| 5 | Synthetic bad-migration apply failure | A migration that errors during apply is not recorded and earlier migrations remain intact | `tests/integration/migrations.test.ts` | Temp dir with synthetic `0005_bad.sql` via `MEMEX_MIGRATE_DIR`; assert runner exit code 1, `schema_migrations` has rows only for `0001`–`0004` |
| 6 | Canonicalization on insert | SQL trigger matches every shared fixture vector on `INSERT` | `tests/integration/migrations.test.ts` plus `tests/fixtures/canonicalization-cases.json` | Byte-for-byte comparison using `pg_read_file`-based injection; all 22 fixtures |
| 7 | Canonicalization on update | SQL trigger matches every shared fixture vector on `UPDATE` | `tests/integration/migrations.test.ts` plus `tests/fixtures/canonicalization-cases.json` | Start from canonical content, update with fixture input, assert stored canonical value byte-for-byte; all 22 fixtures |
| 8 | Fingerprint generation | `content_fingerprint` is derived from canonicalized content and stored as 64-char hex | `tests/integration/migrations.test.ts` | Compare DB value to independently computed `crypto.subtle.digest('SHA-256', expected_bytes)` from Deno |
| 9 | `updated_at` trigger | Row updates advance `updated_at`; `created_at` is stable | `tests/integration/migrations.test.ts` | Read row before and after update and assert monotonic increase on `updated_at` and no change on `created_at` |
| 10 | Sync log emit path | Non-daemon `INSERT`, `UPDATE`, and `DELETE` each create CDC rows | `tests/integration/migrations.test.ts` | Assert operations recorded in order with matching row identifiers |
| 11 | Sync log daemon suppression | `SET LOCAL app.sync_source = 'daemon'` suppresses CDC logging | `tests/integration/migrations.test.ts` | Perform writes inside a single-session BEGIN/SET LOCAL/write/COMMIT heredoc and assert no new `sync_log` rows |
| 12 | Role boundary | `memex_mcp` cannot delete, `memex_sync` can delete | `tests/integration/migrations.test.ts` | Open separate role connections using the Section 6.9 placeholder passwords; expect SQLSTATE 42501 for `memex_mcp`, success for `memex_sync` |
| 13 | Sprint 000 smoke regression | Existing Compose ports, mock inference behavior, and fixture sanity still pass unchanged | `tests/unit/smoke.test.ts` | Re-run the existing smoke suite as part of the aggregate test flow |
| 14 | One-button orchestration | `tests/run-tests.sh` still brings up the stack, runs all tests, and tears it down cleanly | `tests/run-tests.sh` | Preserve existing preflight, ERR trap, and cleanup behavior; add integration execution after unit coverage |

### 5.2 Manual Verification Steps

1. **Bring up the existing Sprint 000 stack.**

   ```bash
   docker compose -p memex-test -f tests/compose.yaml up -d --build --wait
   docker compose -p memex-test -f tests/compose.yaml ps
   ```

   **Expected:** `postgres` and `mock-inference` are both `running` / `healthy`. No migration service exists in Compose.

2. **Create a clean manual test database and export the runner environment.**

   ```bash
   export MEMEX_TEST_DB_HOST=127.0.0.1
   export MEMEX_TEST_DB_PORT=55432
   export MEMEX_TEST_DB_USER=memex_test
   export MEMEX_TEST_DB_PASSWORD=memex_test
   export MEMEX_TEST_DB_NAME=memex_manual
   export PSQL="docker compose -p memex-test -f tests/compose.yaml exec -T postgres psql"

   docker compose -p memex-test -f tests/compose.yaml exec -T postgres \
     psql -U memex_test -d postgres -c 'DROP DATABASE IF EXISTS memex_manual WITH (FORCE);'

   docker compose -p memex-test -f tests/compose.yaml exec -T postgres \
     psql -U memex_test -d postgres -c 'CREATE DATABASE memex_manual;'
   ```

   **Expected:** `DROP DATABASE` (or notice that it did not exist) followed by `CREATE DATABASE`.

3. **Run the migration runner against the empty database.**

   ```bash
   ./scripts/memex-migrate
   ```

   **Expected:** The runner reports nine applied versions, exits 0, and does not prompt for input.

4. **Inspect `schema_migrations`.**

   ```bash
   docker compose -p memex-test -f tests/compose.yaml exec -T postgres \
     psql -U memex_test -d memex_manual \
     -c "SELECT version, length(checksum) AS checksum_len FROM schema_migrations ORDER BY version;"
   ```

   **Expected:** Nine rows, versions `0001` through `0009`, and `checksum_len = 64` for every row.

5. **Verify rerun is a no-op.**

   ```bash
   ./scripts/memex-migrate
   ```

   **Expected:** The runner reports no pending migrations, exits 0, and leaves `schema_migrations` unchanged.

6. **Verify canonicalization and fingerprint generation on a live row.**

   ```bash
   docker compose -p memex-test -f tests/compose.yaml exec -T postgres \
     psql -U memex_test -d memex_manual <<'SQL'
   INSERT INTO thoughts (content, metadata)
   VALUES (E'a\r\nb\r\n', '{"source":"mcp"}')
   RETURNING content, length(content_fingerprint) AS fingerprint_len;
   SQL
   ```

   **Expected:** Returned `content` uses LF line endings and ends with exactly one trailing newline. `fingerprint_len` is `64`.

7. **Verify `sync_log` emit and daemon-suppression paths.**

   ```bash
   docker compose -p memex-test -f tests/compose.yaml exec -T postgres \
     psql -U memex_test -d memex_manual <<'SQL'
   TRUNCATE sync_log;
   INSERT INTO thoughts (content, metadata) VALUES ('human write', '{"source":"human"}');
   SELECT operation, count(*) FROM sync_log GROUP BY operation ORDER BY operation;
   BEGIN;
   SET LOCAL app.sync_source = 'daemon';
   UPDATE thoughts SET content = 'daemon write' WHERE id = (SELECT max(id) FROM thoughts);
   COMMIT;
   SELECT count(*) AS rows_after_daemon FROM sync_log;
   SQL
   ```

   **Expected:** The first `SELECT` shows one `INSERT` row. `rows_after_daemon` remains `1`, proving the daemon update was suppressed.

8. **Verify the role permission boundary.**

   ```bash
   docker compose -p memex-test -f tests/compose.yaml exec -T \
     -e PGPASSWORD='<memex_mcp placeholder>' postgres \
     psql -h 127.0.0.1 -U memex_mcp -d memex_manual -c 'DELETE FROM thoughts;'
   ```

   **Expected:** PostgreSQL returns a permissions error for `memex_mcp` (SQLSTATE 42501).

   ```bash
   docker compose -p memex-test -f tests/compose.yaml exec -T \
     -e PGPASSWORD='<memex_sync placeholder>' postgres \
     psql -h 127.0.0.1 -U memex_sync -d memex_manual -c 'DELETE FROM thoughts;'
   ```

   **Expected:** PostgreSQL reports `DELETE <n>` for `memex_sync`.

9. **Run the full one-button harness.**

   ```bash
   ./tests/run-tests.sh
   ```

   **Expected:** Smoke and integration suites both pass, the script exits 0, and the Compose project is torn down at the end.

10. **Clean up the manual stack.**

    ```bash
    docker compose -p memex-test -f tests/compose.yaml down -v --remove-orphans
    docker compose -p memex-test -f tests/compose.yaml ps
    ```

    **Expected:** `down` removes containers and volumes. `ps` shows no running services.

### 5.3 Regression Scenarios

Sprint 000 delivered a working test platform. Sprint 001 must not regress any of it.

| # | Sprint 000 behavior | Command | Expected |
|---|---|---|---|
| R1 | Smoke test unit suite still passes | `deno task test:unit` (after compose up) | 0 failures; Sprint 000's smoke tests all succeed |
| R2 | `tests/run-tests.sh` preflight still fires on pre-bound port | Start `./tests/run-tests.sh` with port 55432 already bound | Runner fails fast with the port-availability error message |
| R3 | Compose config still validates | `docker compose -p memex-test -f tests/compose.yaml config` | Exit 0, valid output |
| R4 | Ctrl-C teardown still works | Start `./tests/run-tests.sh`, SIGINT during the migration phase | No `memex-test` containers remain per `docker compose ls` |
| R5 | Mock inference service still reachable | `curl -fsS http://127.0.0.1:58000/health` after compose up | Returns `{"status":"ok",…}` |
| R6 | Canonicalization fixture file unchanged | `git diff --stat tests/fixtures/canonicalization-cases.json` after Sprint 001 work | No diff (Sprint 001 consumes, does not modify) |
| R7 | CI workflow file unchanged | `git diff .github/workflows/test.yml` | No diff |
| R8 | ERR trap propagates exit codes | Inject a failing `deno test` and confirm `run-tests.sh` exits non-zero with logs dumped | Non-zero exit, `[run-tests] FAILED` printed, logs printed |
| R9 | Mock inference healthcheck still works | `docker compose -p memex-test -f tests/compose.yaml ps` shows mock-inference as `healthy` | Status `healthy` (the Sprint 000 follow-up installed `wget`) |

### 5.4 Existing Tests to Re-run or Update

- Re-run `tests/unit/smoke.test.ts` unchanged after every integration-test or runner change. It remains the regression gate for Sprint 000 behavior.
- Update `deno.json` task wiring so unit and integration tests are both first-class commands, but keep the unit smoke suite independently runnable and keep the existing `test` task working.
- Update `tests/run-tests.sh` to invoke both suites while preserving its existing preflight, readiness, ERR trap, and teardown logic.
- Consume `tests/fixtures/canonicalization-cases.json` exactly as-is. Sprint 001 must not rewrite the fixture corpus unless a fixture bug is proven independently, which is outside this sprint's scope.

## 6. Files Summary

### New Schema and Runner Artifacts
- `migrations/0001_initial_schema.sql`
- `migrations/0002_add_ob_uuid.sql`
- `migrations/0003_add_source_column.sql`
- `migrations/0004_add_content_fingerprint.sql`
- `migrations/0005_add_updated_at.sql`
- `migrations/0006_add_thought_relations.sql`
- `migrations/0007_add_sync_log.sql`
- `migrations/0008_add_sync_state.sql`
- `migrations/0009_add_roles.sql`
- `migrations/README.md`
- `scripts/memex-migrate`

### Test Wiring and Integration Coverage
- `tests/integration/migrations.test.ts`

### Modified Files
- `deno.json` (new `test:unit` and `test:integration` tasks; existing `test` task preserved)
- `tests/run-tests.sh` (integration phase added; preflight / ERR trap / teardown preserved)

### Consumed, Unchanged
- `tests/compose.yaml`
- `tests/fixtures/canonicalization-cases.json`
- `tests/unit/smoke.test.ts`
- `.github/workflows/test.yml`
- `memex-architecture.md`

## 7. Definition of Done

- [ ] `migrations/` exists at the repo root with nine migration files covering `0001` through `0009`.
- [ ] The migration SQL matches `memex-architecture.md` Section 6 in intent and behavior, with no universal `IF NOT EXISTS` / `CREATE OR REPLACE` qualifiers beyond what Section 6 specifies.
- [ ] `0009_add_roles.sql` guards `CREATE ROLE` with `pg_roles` existence checks in `DO` blocks; `GRANT` statements are unconditional.
- [ ] `memex_mcp` grants exactly match Section 6.9 — no grant on `thought_relations`.
- [ ] The schema remains additive-only and forward-only per Section 5.4.
- [ ] `migrations/README.md` documents manual apply path, runner usage, failure-recovery model, additive-only rule, and test-password policy.
- [ ] `scripts/memex-migrate` exists, is executable, and applies pending migrations in lexical version order.
- [ ] The runner records version and SHA-256 checksum in `schema_migrations` after each successful migration.
- [ ] The runner aborts on checksum mismatch for any previously applied migration file (exit code 2).
- [ ] The runner aborts on apply-time SQL failure (exit code 1) without recording the failing migration.
- [ ] Re-running the runner after a full apply is a no-op (exit code 0, no new rows).
- [ ] The runner honors `MEMEX_MIGRATE_DIR` and `MEMEX_MIGRATE_MAX` as documented test-only read-path overrides.
- [ ] Runner exit codes are distinct and documented at the top of the script: 0 success, 1 migration failed, 2 tamper, 3 prereq error.
- [ ] Applying `0001`–`0005` via `MEMEX_MIGRATE_MAX=0005` and later applying the remainder yields the same final schema as applying all nine at once (verified via normalized `pg_dump --schema-only --no-owner --no-privileges`).
- [ ] `tests/integration/migrations.test.ts` uses isolated per-scenario databases on the shared Sprint 000 PostgreSQL container with `DROP DATABASE ... WITH (FORCE)` teardown.
- [ ] Integration tests run serially.
- [ ] A synthetic bad-migration test confirms that a failed migration leaves `schema_migrations` without a row for that version and that the runner exits 1.
- [ ] All 22 canonicalization fixtures pass on `INSERT` via `pg_read_file`-based byte-safe injection.
- [ ] All 22 canonicalization fixtures pass on `UPDATE` via the same injection path.
- [ ] `content_fingerprint` stores the SHA-256 hex of canonicalized content.
- [ ] `updated_at` advances on row update; `created_at` remains stable.
- [ ] `sync_log` records non-daemon `INSERT`, `UPDATE`, and `DELETE` operations.
- [ ] `sync_log` suppresses daemon writes when `app.sync_source = 'daemon'` (verified in a single-session BEGIN/SET LOCAL/write/COMMIT heredoc).
- [ ] `memex_mcp` cannot execute `DELETE FROM thoughts` (SQLSTATE 42501).
- [ ] `memex_sync` can execute `DELETE FROM thoughts`.
- [ ] `tests/run-tests.sh` still performs Sprint 000's bring-up and teardown flow while running both unit and integration suites; ERR trap behavior is preserved.
- [ ] `deno.json` defines `test:unit` and `test:integration` with scoped permissions (not `--allow-all`) and preserves the existing `test` task.
- [ ] The existing Sprint 000 smoke suite still passes (regression scenarios R1–R9 all green).
- [ ] `tests/compose.yaml`, `tests/fixtures/canonicalization-cases.json`, `.github/workflows/test.yml`, and `memex-architecture.md` are unchanged.

## 8. Risks & Mitigations

| # | Risk | Why It Matters | Mitigation |
|---|---|---|---|
| 1 | SQL drift from the architecture spec | The sprint could land executable SQL that no longer matches the reviewed design | Treat `memex-architecture.md` Section 6 as the source of truth; review each migration file against the corresponding subsection; reject any "while we're here" edits to the grant matrix or column definitions |
| 2 | Hidden host `psql` dependency | Sprint 000 deliberately avoided requiring a host PostgreSQL client for one-button testing | Use the `PSQL` override in `tests/run-tests.sh` so automated verification uses the container's client instead of assuming host `psql` |
| 3 | Server-scoped roles make tests interfere with one another | `memex_mcp` and `memex_sync` are global to the PostgreSQL server, not scoped per database | Run integration tests serially; guard `CREATE ROLE` with `DO`-block existence checks so reruns across fresh scenario databases do not fail with 42710 |
| 4 | Checksum false positives from line-ending drift | If files are rewritten with CRLF, raw-byte hashes change even when SQL semantics do not | Keep committed migration files LF-only and document that checksum comparison is intentionally byte-level, not SQL-level |
| 5 | Schema-equivalence comparison becomes noisy | Raw `pg_dump` output includes banner lines and `SET` statements that vary across runs | Compare normalized `pg_dump --schema-only --no-owner --no-privileges` output; the executor enumerates the exact noise-stripping rules during Phase 4 implementation |
| 6 | Canonicalization behavior diverges from the shared fixtures | Later server and daemon work depend on the SQL behavior matching the cross-language corpus exactly | Use the existing 22 fixtures unchanged; assert byte-for-byte output on both `INSERT` and `UPDATE`; use `pg_read_file`-based injection so test-side byte corruption cannot mask SQL-side correctness |
| 7 | `psql -c` quoting corrupts binary fixture content in transit | False canonicalization failures on fixtures with backslashes, CR bytes, or combining characters | Write raw bytes to `/tmp/content.txt` in the postgres container via `docker compose exec -T postgres sh -c 'cat > /tmp/content.txt'` piped stdin, then `INSERT ... VALUES (pg_read_file('/tmp/content.txt')::text)` |
| 8 | `SET LOCAL app.sync_source` loses scope across multiple `psql -c` invocations | Daemon-path test gives false positives | Use a single `psql` heredoc so BEGIN / SET LOCAL / write / COMMIT run in one session |
| 9 | `MEMEX_MIGRATE_DIR` override leaves test artifacts in the real `migrations/` tree | Surprising side effects, polluted commits | The override only affects the runner's read path and never mutates its input directory. Tests use `Deno.makeTempDir()` and the `finally` block removes the temp dir |
| 10 | Migration failure leaves the operator unsure how to recover | The architecture is forward-only, so rollback guidance must be explicit | Apply one file per transaction, print the failed version clearly, and document rerun-from-last-success as the only supported recovery path in `migrations/README.md` |
| 11 | Runner exit-code ambiguity between Bash ERR trap and `psql` failures | Test harness and operators can't distinguish failure classes | Runner uses distinct exit codes (0/1/2/3), documented at the top of the script and asserted by the integration suite |
| 12 | Adding a migration phase to `run-tests.sh` breaks Sprint 000's ERR trap behavior | Regression on R8 | New phase uses the same `set +e` / capture / `set -e` pattern as the existing `deno task test` block; R8 explicitly re-validates ERR-trap behavior |
| 13 | Test DB drop/create blocked by lingering connections | `dropScenarioDb` fails mid-run | Use `DROP DATABASE ... WITH (FORCE)` (PG 13+) to terminate active backends |
| 14 | Placeholder role passwords mistaken for deployable credentials | Future deployment sprints could accidentally ship test creds | Document that the placeholders live only in the disposable test environment; downstream provisioning replaces them |

## 9. Dependencies

### Must Exist Before Sprint 001 Starts
- Sprint 000 outputs: `tests/compose.yaml`, `tests/run-tests.sh`, `tests/unit/smoke.test.ts`, `deno.json`, and `tests/fixtures/canonicalization-cases.json`
- `memex-architecture.md` Section 6 as the authoritative schema specification
- `memex-architecture.md` Section 5.4 as the additive-only rule
- Docker/Compose and Deno available locally, exactly as required by Sprint 000
- The existing PostgreSQL Compose container's built-in client tooling, used through `docker compose exec` in the automated test path

### Produced by Sprint 001 for Later Sprints
- An executable database schema that Sprint 002's MCP server scaffold can query against
- `memex_mcp` and `memex_sync` roles that Sprint 002 and Sprint 005 will rely on for the read/write/delete split
- The canonicalization trigger and `content_fingerprint` contract consumed by Sprint 003 capture and Sprint 005 sync logic
- `sync_log` and `sync_state`, direct prerequisites for the sync daemon sprint
- A reusable migration runner and `schema_migrations` ledger for every later schema change
- `MEMEX_MIGRATE_DIR` and `MEMEX_MIGRATE_MAX` as a documented test-hook convention for future schema sprints
- A schema-level integration suite that becomes the regression baseline for future migrations
- `MEMEX_TEST_MCP_PASSWORD` and `MEMEX_TEST_SYNC_PASSWORD` env var conventions for role-scoped test connections
- The split `test:unit` / `test:integration` Deno task convention

## 10. Open Questions

All intent-doc open questions were resolved during planning and are
answered in Section 3 (architecture), Section 4 (implementation), and
Section 8 (risks). The following items surfaced during drafting but
are explicitly out of Sprint 001's scope:

1. **Should `scripts/memex-migrate` grow an operator-facing
   `--target <version>` flag?** The `MEMEX_MIGRATE_MAX` env var is a
   test-only hook today. An operator-facing flag might be useful
   during a future deployment sprint. Deferred — add when a
   deployment sprint needs it.

2. **Should `pg_hba.conf` in the Compose pgvector image be
   explicitly verified to permit password login for `memex_mcp` and
   `memex_sync`?** Not pre-verified in this sprint. If the image's
   default config blocks custom-role password auth from inside the
   container, the role-boundary tests (Phase 5 task 8, automated
   check 12, manual step 8) will surface a real error during
   execution and the executor can add a Compose-level override
   then.

3. **Should the risk register name the specific SQL
   `normalize()` vs Deno `String.prototype.normalize()` divergence
   as a distinct risk?** Not added. Risk #6 ("canonicalization
   diverges from the shared fixtures") and the byte-for-byte
   assertion across all 22 fixtures already enforce the contract.

4. **Should there be a `scripts/memex-migrate --check` mode
   that validates checksums without applying anything?** Not in
   scope. Recoverable via `MEMEX_MIGRATE_DIR` pointing at the
   current `migrations/` if an operator workflow needs it.

5. **Will the `match_thoughts` function need its own execution
   test in Sprint 001, or does Sprint 002 pick it up?** Sprint 002
   picks it up. Sprint 001 only needs to verify that `memex_mcp`
   has EXECUTE on `match_thoughts` via the role-boundary path.
