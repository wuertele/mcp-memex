# Sprint 001: Schema Migrations and Migration Runner

**Status:** Planned
**Based on:** Sprint 001 intent, `ROADMAP.md` Sprint 001 scope, and `memex-architecture.md` Sections 5.4 and 6
**Prerequisites:** Sprint 000 complete
**Produces for later sprints:** Executable PostgreSQL schema, minimal forward-only migration runner, schema-level integration coverage for canonicalization/CDC/roles, and a reusable `schema_migrations` baseline

---

## 1. Overview

Sprint 001 turns the architecture's schema specification into executable code. The sprint lands the nine SQL migrations from `memex-architecture.md` Section 6 under `migrations/`, plus a minimal runner at `scripts/memex-migrate` that discovers pending files, applies them in order, and records version/checksum rows in `schema_migrations`. The schema remains additive-only and forward-only, matching Section 5.4: no rollback support, no destructive alters, and no deployment-target coupling.

The sprint reuses the Sprint 000 Docker Compose PostgreSQL stack rather than introducing a second database environment. Verification stays inside the existing Deno test harness by adding `tests/integration/test_migrations.ts`, which drives the runner and validates the live schema against the existing fixture corpus in `tests/fixtures/canonicalization-cases.json`. The suite covers fresh apply, no-op rerun, staged-vs-full schema equivalence, trigger behavior, generated columns, checksum drift detection, and the `memex_mcp`/`memex_sync` DELETE boundary.

The sprint does not modify `memex-architecture.md`, does not embed migrations into service startup, and does not add rollback machinery. Its job is to make the architecture executable and prove the resulting schema behaves exactly as specified.

## 2. Use Cases

| # | Scenario | Inputs | Expected Behavior |
|---|---|---|---|
| 1 | Fresh empty database bootstrap | Operator or test harness points `scripts/memex-migrate` at an empty PostgreSQL 16+ database with pgvector available | Runner applies `0001` through `0009` in lexical order, records nine `schema_migrations` rows, and exits 0 |
| 2 | Idempotent rerun | Same database after all migrations are already applied | Runner detects no pending work, verifies stored checksums against on-disk files, performs no SQL changes, and exits 0 |
| 3 | Staged schema rollout | Database receives `0001` through `0005`, then later receives `0006` through `0009` | Final schema matches the result of applying all nine migrations to a fresh database |
| 4 | Applied migration file tampered | An already-recorded migration file is edited on disk after first application | Runner stops before applying anything else and reports a checksum mismatch for the modified version |
| 5 | Canonicalization on insert | `INSERT INTO thoughts` with BOM, CRLF, missing trailing newline, or NFD Unicode content | `canonicalize_thought_content()` rewrites `content` to the canonical form from the fixture corpus before the row is stored |
| 6 | Canonicalization on update | Existing row is updated with non-canonical content | The same trigger rewrites the updated value to the canonical form before commit |
| 7 | Fingerprint and timestamps | Inserted or updated `thoughts` row | `content_fingerprint` is populated from canonicalized content, and `updated_at` advances on update |
| 8 | Human or MCP write path | Non-daemon writer inserts, updates, or deletes a row in `thoughts` | `sync_log` receives one corresponding CDC row per operation |
| 9 | Daemon write path | Session sets `app.sync_source = 'daemon'` before writing | `sync_log` trigger suppresses logging so the daemon does not create feedback loops |
| 10 | MCP role safety boundary | Client connects as `memex_mcp` and attempts `DELETE FROM thoughts` | PostgreSQL rejects the statement with a permissions error |
| 11 | Sync daemon delete authority | Client connects as `memex_sync` and attempts `DELETE FROM thoughts` | PostgreSQL allows the delete, preserving the architecture's deletion invariant |

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

These files follow the exact architectural sequence from `memex-architecture.md` Section 6. The ordering is not cosmetic: later migrations depend on objects created by earlier ones, and the runner uses the numeric prefix as the sole ordering key.

The schema remains a strict additive extension of the OB1 baseline. Sprint 001 adds new columns, triggers, indexes, functions, and tables, but it does not drop columns, rewrite existing semantics, or add rollback logic. `schema_migrations` remains the only bookkeeping table the runner uses.

`0009_add_roles.sql` requires one execution-oriented adaptation to remain idempotent at the server level: the `CREATE ROLE` statements should be wrapped in `DO` blocks that first check `pg_roles`, while the `GRANT` statements can run unconditionally because PostgreSQL grants are safe to reissue. This preserves the permissions from Section 6.9 without making role creation brittle on rerun.

Because Sprint 001 is deployment-agnostic, the role passwords remain the literal placeholder values from Section 6.9 for the disposable test environment. Replacing those placeholders with deployment-specific secrets is downstream provisioning work and remains out of scope here.

### 3.2 Migration Runner Contract

`scripts/memex-migrate` is a Bash script. Bash is the right fit here because the runner is intentionally small, lives close to the SQL files, and does not justify introducing Python packaging or dependency management into a repository that currently has none.

The runner contract is:

1. Discover migration files in version order from `migrations/` by default.
2. Accept an optional migrations-directory override so tests can point the runner at a temporary copy when validating checksum drift handling.
3. Compute SHA-256 over the raw file bytes for every discovered migration file.
4. Read `schema_migrations` and build an in-memory map of applied version -> checksum.
5. For each already-applied version, compare the stored checksum to the on-disk checksum and abort immediately on mismatch.
6. For each pending version, apply the SQL file in its own transaction with `ON_ERROR_STOP` enabled, then insert that version/checksum into `schema_migrations`.
7. Emit clear non-interactive logs showing applied versions, skipped versions, and hard-stop failures.

Database credentials come from standard `PG*` environment variables when present. In the Sprint 000 test harness path, the runner falls back to the existing `MEMEX_TEST_DB_*` variables exported by `tests/run-tests.sh`, so no new memex-specific credential channel is needed.

The runner should also honor a `PSQL` command override. In normal operator use, that value defaults to `psql`. In the Sprint 001 automated test path, `tests/run-tests.sh` can point `PSQL` at `docker compose -p memex-test -f tests/compose.yaml exec -T postgres psql`, which preserves one-button execution without introducing a host PostgreSQL-client prerequisite.

### 3.3 Test Topology and Isolation

Sprint 001 keeps the existing Sprint 000 Compose topology unchanged: one PostgreSQL container and one mock inference container, both bound to the same fixed host ports. The migration runner is not added as its own Compose service. It remains a one-shot script invoked by `tests/run-tests.sh` and by the integration suite.

Integration tests live in `tests/integration/test_migrations.ts` and stay in Deno. This avoids a second test runtime, preserves `deno task test` as the one command path, and lets the new suite reuse the existing fixture-loading and subprocess patterns from Sprint 000.

Isolation happens at the database level, not at the container level. The suite should create a fresh database per scenario on the shared PostgreSQL server, for example:

- `memex_it_full_apply`
- `memex_it_staged_apply`
- `memex_it_checksum`
- `memex_it_behavior`
- `memex_it_roles`

This keeps setup cost low while preventing interference between schema snapshots, role tests, and trigger assertions. The suite should run serially because PostgreSQL roles are server-scoped and `0009_add_roles.sql` is intentionally global, not per-database.

### 3.4 Schema Behaviors Under Test

The live-schema verification surface for Sprint 001 is:

- Migration application and `schema_migrations` bookkeeping
- Idempotent rerun with no pending work
- Full schema equivalence between all-at-once apply and staged apply
- `canonicalize_thought_content()` trigger behavior on both `INSERT` and `UPDATE`
- `content_fingerprint` generated column output after canonicalization
- `updated_at` trigger behavior on row updates
- `sync_log` trigger behavior for `INSERT`, `UPDATE`, and `DELETE`
- Daemon-loop suppression via `SET LOCAL app.sync_source = 'daemon'`
- Role grants for `memex_mcp` and `memex_sync`

Schema equivalence should be validated with normalized `pg_dump --schema-only --no-owner --no-privileges` output from two databases rather than by hand-curated catalog spot checks. That gives one high-signal comparison for tables, columns, indexes, functions, triggers, and grants together.

The canonicalization tests must consume the existing 22-case fixture corpus without modifying it. Each case should be asserted byte-for-byte against the stored database value, not by reconstructing expected output in TypeScript.

### 3.5 Failure and Recovery Model

Sprint 001 is explicitly forward-only. If migration `0005` fails, the operator does not roll back the database to zero. Instead:

1. All earlier successful migrations remain applied.
2. The failed migration is not recorded in `schema_migrations`.
3. The runner exits non-zero and reports the version that failed.
4. The operator fixes the underlying issue and reruns the runner.
5. The rerun resumes from the first unapplied migration.

Checksum mismatch is treated differently from ordinary SQL failure. It is an integrity violation, not a transient execution problem. The runner must halt before applying any new work and instruct the operator to either restore the expected migration file or create a fresh database if they intentionally changed migration history.

## 4. Implementation Plan

Five phases, each independently reviewable. Each phase lists the files it creates or modifies and the concrete tasks within it.

### Phase 1 - Migration Directory and SQL Files

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

**Tasks:**

1. Create `migrations/` at the repo root and land the nine files in the exact Section 6 order.
2. Transcribe the SQL from `memex-architecture.md` Sections 6.1-6.9 into those files without changing the intended behavior.
3. Preserve the additive-only rule from Section 5.4: no destructive DDL, no rollback scaffolding, no startup coupling.
4. Make `0009_add_roles.sql` rerunnable by guarding `CREATE ROLE` with `pg_roles` existence checks while keeping the Section 6.9 grant matrix unchanged.
5. Keep committed SQL files in LF line endings so checksum behavior is stable across platforms.
6. Do not modify `memex-architecture.md`; it remains the input spec.

### Phase 2 - Minimal Migration Runner

**Files created:**
- `scripts/memex-migrate`

**Tasks:**

1. Write `scripts/memex-migrate` as a non-interactive Bash script with `set -euo pipefail`.
2. Discover `NNNN_*.sql` files, sort them lexically, and reject gaps or duplicate version prefixes loudly.
3. Compute SHA-256 on raw file bytes for every migration file before any apply work begins.
4. Resolve connection settings from `PG*` first, then from `MEMEX_TEST_DB_*` as a test-harness fallback.
5. Support an optional migrations-directory override so tests can run against a temporary copy of the files.
6. Support a `PSQL` command override so automated tests can use the Compose container's client without requiring host `psql`.
7. Query `schema_migrations`, validate stored checksums, and abort immediately on drift.
8. Apply each pending migration in its own transaction and only record the row in `schema_migrations` after the SQL succeeds.
9. Print concise logs for "applied", "already applied", "checksum mismatch", and "failed version" outcomes.

### Phase 3 - Test Harness Wiring

**Files modified:**
- `deno.json`
- `tests/run-tests.sh`

**Tasks:**

1. Extend `deno.json` so Sprint 000's smoke suite and Sprint 001's integration suite are both first-class tasks.
2. Keep the existing smoke path independently runnable; do not fold integration assertions into `tests/unit/smoke.test.ts`.
3. Update `tests/run-tests.sh` to run unit and integration suites in the same one-button flow without replacing its existing preflight, bring-up, readiness, or teardown behavior.
4. Export the existing `MEMEX_TEST_DB_*` contract plus the `PSQL` override needed by the migration runner and Deno integration helpers.
5. Export role-test connection values derived from the Section 6.9 placeholder passwords so the integration suite can connect separately as `memex_mcp` and `memex_sync`.
6. Keep `tests/compose.yaml` unchanged unless a concrete test blocker appears; the default plan is no Compose topology changes in Sprint 001.

### Phase 4 - Migration and Runner Integration Tests

**Files created:**
- `tests/integration/test_migrations.ts`

**Tasks:**

1. Add helpers that create and drop fresh per-scenario databases on the shared PostgreSQL server.
2. Add a "fresh apply" test that runs `scripts/memex-migrate` against an empty database and asserts that versions `0001` through `0009` are recorded in order with non-null checksums.
3. Add a "rerun is a no-op" test that executes the runner twice and asserts no additional rows or checksum changes appear on the second pass.
4. Add a staged-apply test that executes `0001` through `0005`, then uses the runner to apply the remaining migrations, and compares the normalized schema dump to a database that received all nine migrations in one pass.
5. Add a checksum-drift test that copies `migrations/` to a temp directory, applies from that copy once, mutates an already-applied file in the temp copy, reruns the runner, and asserts a hard failure before any new work is attempted.

### Phase 5 - Behavioral Schema Tests

**Files modified:**
- `tests/integration/test_migrations.ts`

**Tasks:**

1. Load `tests/fixtures/canonicalization-cases.json` and assert all 22 fixtures on `INSERT` byte-for-byte against the stored `thoughts.content` value.
2. Repeat the same fixture corpus against `UPDATE` so trigger coverage is explicit for both write paths.
3. Assert that `content_fingerprint` stores the SHA-256 hex of the canonicalized content, not the pre-trigger input.
4. Assert that `updated_at` advances on update while `created_at` remains stable.
5. Assert that non-daemon `INSERT`, `UPDATE`, and `DELETE` operations each create the expected `sync_log` row.
6. Assert that writes wrapped in `SET LOCAL app.sync_source = 'daemon'` do not create `sync_log` rows.
7. Connect separately as `memex_mcp` and `memex_sync` using the Section 6.9 placeholder passwords and assert the DELETE permission boundary.

## 5. Verification Plan

### 5.1 Automated Checks

| # | Check | What It Validates | File | Executor Notes |
|---|---|---|---|---|
| 1 | Fresh migration apply | All nine SQL files execute cleanly on an empty PostgreSQL 16+ database and record `schema_migrations` rows | `tests/integration/test_migrations.ts` | Runs `scripts/memex-migrate` against a fresh per-scenario database |
| 2 | No-op rerun | Re-running the runner after a full apply performs no additional work | `tests/integration/test_migrations.ts` | Compare `schema_migrations` row count and stored checksums before and after rerun |
| 3 | Checksum drift detection | Applied migration tampering is detectable and blocks future work | `tests/integration/test_migrations.ts` | Uses a temp copy of `migrations/`, mutates an already-applied file, expects runner failure |
| 4 | Staged-vs-full schema equivalence | `0001-0005` then `0006-0009` yields the same final schema as `0001-0009` in one pass | `tests/integration/test_migrations.ts` | Compare normalized `pg_dump --schema-only --no-owner --no-privileges` output |
| 5 | Canonicalization on insert | SQL trigger matches every shared fixture vector on `INSERT` | `tests/integration/test_migrations.ts` plus `tests/fixtures/canonicalization-cases.json` | Byte-for-byte comparison against stored `content` |
| 6 | Canonicalization on update | SQL trigger matches every shared fixture vector on `UPDATE` | `tests/integration/test_migrations.ts` plus `tests/fixtures/canonicalization-cases.json` | Start from canonical content, update with fixture input, assert stored canonical value |
| 7 | Fingerprint generation | `content_fingerprint` is derived from canonicalized content and stored as 64-char hex | `tests/integration/test_migrations.ts` | Compare DB value to independently computed SHA-256 of expected fixture output |
| 8 | `updated_at` trigger | Row updates advance `updated_at` | `tests/integration/test_migrations.ts` | Read row before and after update and assert monotonic increase |
| 9 | Sync log emit path | Non-daemon `INSERT`, `UPDATE`, and `DELETE` each create CDC rows | `tests/integration/test_migrations.ts` | Assert operations recorded in order with matching row identifiers |
| 10 | Sync log daemon suppression | `SET LOCAL app.sync_source = 'daemon'` suppresses CDC logging | `tests/integration/test_migrations.ts` | Perform writes inside a transaction with the session variable set and assert no new rows |
| 11 | Role boundary | `memex_mcp` cannot delete, `memex_sync` can delete | `tests/integration/test_migrations.ts` | Open separate role connections using the Section 6.9 placeholder passwords |
| 12 | Sprint 000 smoke regression | Existing Compose ports, mock inference behavior, and fixture sanity still pass unchanged | `tests/unit/smoke.test.ts` | Re-run the existing smoke suite as part of the aggregate test flow |
| 13 | One-button orchestration | `tests/run-tests.sh` still brings up the stack, runs all tests, and tears it down cleanly | `tests/run-tests.sh` | Keep the existing preflight/trap path and add integration execution after unit coverage |

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
     -e PGPASSWORD='<placeholder>' postgres \
     psql -h 127.0.0.1 -U memex_mcp -d memex_manual -c 'DELETE FROM thoughts;'
   ```

   **Expected:** PostgreSQL returns a permissions error for `memex_mcp`.

   ```bash
   docker compose -p memex-test -f tests/compose.yaml exec -T \
     -e PGPASSWORD='<placeholder>' postgres \
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

These commands specifically protect Sprint 000 behavior from accidental regression while Sprint 001 adds schema work:

- `docker compose -p memex-test -f tests/compose.yaml up -d --build --wait && deno test --allow-net --allow-read --allow-env tests/unit/smoke.test.ts`
  Expected: the existing smoke suite still passes against the unchanged Compose stack.

- `./tests/run-tests.sh && ./tests/run-tests.sh`
  Expected: both runs exit 0, proving the added migration/integration work does not break Sprint 000's clean-start and clean-teardown guarantees.

- `docker compose -p memex-test -f tests/compose.yaml ps`
  Expected: only `postgres` and `mock-inference` are part of the stack; the migration runner remains a script, not a new service.

- `curl -sS http://127.0.0.1:58000/health`
  Expected: the Sprint 000 mock inference health payload remains unchanged when the stack is running manually.

### 5.4 Existing Tests to Re-run or Update

- Re-run `tests/unit/smoke.test.ts` unchanged after every integration-test or runner change. It remains the regression gate for Sprint 000 behavior.
- Update `deno.json` task wiring so unit and integration tests are both first-class commands, but keep the unit smoke suite independently runnable.
- Update `tests/run-tests.sh` to invoke both suites while preserving its existing preflight, readiness, and teardown logic.
- Consume `tests/fixtures/canonicalization-cases.json` exactly as-is. Sprint 001 should not rewrite the fixture corpus unless a fixture bug is proven independently, which is outside this sprint's scope.

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
- `scripts/memex-migrate`

### Test Wiring and Integration Coverage

- `tests/integration/test_migrations.ts`
- `deno.json`
- `tests/run-tests.sh`

## 7. Definition of Done

- [ ] `migrations/` exists at the repo root with nine migration files covering `0001` through `0009`.
- [ ] The migration SQL matches `memex-architecture.md` Section 6 in intent and behavior.
- [ ] The schema remains additive-only and forward-only per Section 5.4.
- [ ] `scripts/memex-migrate` applies pending migrations in lexical version order.
- [ ] The runner records version and SHA-256 checksum in `schema_migrations` after each successful migration.
- [ ] The runner aborts on checksum mismatch for any previously applied migration file.
- [ ] Re-running the runner after a full apply is a no-op.
- [ ] A failed migration file is not recorded in `schema_migrations`.
- [ ] Applying `0001-0005` and later applying the remainder yields the same final schema as applying all nine at once.
- [ ] `tests/integration/test_migrations.ts` uses isolated per-scenario databases on the shared Sprint 000 PostgreSQL container.
- [ ] All 22 canonicalization fixtures pass on `INSERT`.
- [ ] All 22 canonicalization fixtures pass on `UPDATE`.
- [ ] `content_fingerprint` stores the SHA-256 hex of canonicalized content.
- [ ] `updated_at` advances on row update.
- [ ] `sync_log` records non-daemon `INSERT`, `UPDATE`, and `DELETE` operations.
- [ ] `sync_log` suppresses daemon writes when `app.sync_source = 'daemon'`.
- [ ] `memex_mcp` cannot execute `DELETE FROM thoughts`.
- [ ] `memex_sync` can execute `DELETE FROM thoughts`.
- [ ] `tests/run-tests.sh` still performs Sprint 000's bring-up and teardown flow while running both unit and integration suites.
- [ ] The existing Sprint 000 smoke suite still passes.

## 8. Risks & Mitigations

| # | Risk | Why It Matters | Mitigation |
|---|---|---|---|
| 1 | SQL drift from the architecture spec | The sprint could land executable SQL that no longer matches the reviewed design | Treat `memex-architecture.md` Section 6 as the source of truth and review each migration file against the corresponding subsection |
| 2 | Hidden host `psql` dependency | Sprint 000 deliberately avoided requiring a host PostgreSQL client for one-button testing | Use the `PSQL` override in `tests/run-tests.sh` so automated verification uses the container's client instead of assuming host `psql` |
| 3 | Server-scoped roles make tests interfere with one another | `memex_mcp` and `memex_sync` are global to the PostgreSQL server, not scoped per database | Use serial integration execution and create fresh databases per scenario rather than parallel test databases with shared global-role setup |
| 4 | Checksum false positives from line-ending drift | If files are rewritten with CRLF, raw-byte hashes change even when SQL semantics do not | Keep committed migration files LF-only and document that checksum comparison is intentionally byte-level, not SQL-level |
| 5 | Schema-equivalence comparison becomes noisy | Raw dumps include ownership or privilege noise that can hide real differences | Compare normalized `pg_dump --schema-only --no-owner --no-privileges` output and strip database-specific noise before diffing |
| 6 | Canonicalization behavior diverges from the shared fixtures | Later server and daemon work depend on the SQL behavior matching the cross-language corpus exactly | Use the existing 22 fixtures unchanged and assert byte-for-byte output on both `INSERT` and `UPDATE` |
| 7 | Migration failure leaves the operator unsure how to recover | The architecture is forward-only, so rollback guidance must be explicit | Apply one file per transaction, print the failed version clearly, and document rerun-from-last-success as the only supported recovery path |
| 8 | Placeholder role passwords are mistaken for deployable credentials | Sprint 001 needs executable SQL, but real deployments must not keep placeholder secrets | Limit the placeholders to the disposable test environment and document that downstream provisioning replaces them |

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
- `sync_log` and `sync_state`, which are direct prerequisites for the sync daemon sprint
- A reusable migration runner and `schema_migrations` ledger for every later schema change
- A schema-level integration suite that becomes the regression baseline for future migrations

## 10. Open Questions

No planning questions remain from the Sprint 001 intent. They are resolved here so implementation can proceed without another drafting loop.

1. **Runner language: Bash or Python?** Bash. The runner is a small control script wrapped around ordered SQL files, checksum comparison, and `psql` execution. Adding Python would also add packaging and dependency-management work that is not part of Sprint 001's scope.

2. **Integration test language: Deno or Python?** Deno. Sprint 000 already established Deno as the repo's test runtime, and keeping integration tests there avoids toolchain sprawl. Deno can drive the Bash runner and the container's `psql` client through subprocesses, so test/runtime language mismatch is not a practical problem.

3. **Migration checksum algorithm?** SHA-256 over the raw file bytes. That is sufficient. It is deterministic, widely available, easy to recompute in Bash, and strong enough to detect accidental or intentional migration-history drift.

4. **How does the runner get database credentials?** From existing `MEMEX_TEST_DB_*` variables in the test harness, mapped internally to standard `PG*` semantics when explicit `PG*` values are absent. This reuses Sprint 000's environment contract instead of inventing a new credential channel.

5. **Where does role creation happen, and how does idempotency hold?** In `0009_add_roles.sql`, with `CREATE ROLE` wrapped in `DO` blocks that first check `pg_roles`. `GRANT` statements run unconditionally. Existing roles are left in place, so reruns do not fail with `42710` and do not overwrite previously set passwords.

6. **Integration test isolation: fresh database per test or shared database?** Shared PostgreSQL server, fresh database per scenario. That keeps setup fast, avoids adding a second Compose stack, and still isolates schema snapshots and trigger assertions. The suite should run serially because role creation is server-scoped.

7. **Does the runner belong in Compose or as a separate step in `run-tests.sh`?** Separate step. The runner is an ephemeral control-plane action, not a long-lived service. Keeping it out of Compose preserves Sprint 000's simple topology and keeps the migration mechanism deployment-agnostic.

8. **How does a failed migration leave the database?** At the last successfully committed version. Each file runs in its own transaction. If `0005` fails, `0001-0004` stay applied, `0005` is not recorded in `schema_migrations`, the runner exits non-zero, and the recovery path is to fix the cause and rerun. If the failure is a checksum mismatch, the operator must restore the original migration file or start with a fresh database if they intentionally changed migration history.
