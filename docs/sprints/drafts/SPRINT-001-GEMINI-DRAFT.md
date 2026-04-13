# Sprint 001: Schema Migrations and Migration Runner

**Status:** Draft
**Based on:** Gemini draft
**Prerequisites:** Sprint 000 (Test Platform and CI Scaffolding)
**Produces for later sprints:** Executable database schema, idempotent migration runner, role-based access control, verified canonicalization trigger.

---

## 1. Overview

Sprint 001 lands the authoritative database schema for mcp-memex. While Sprint 000 provided the disposable PostgreSQL environment, this sprint populates it with the nine migrations specified in `memex-architecture.md` Section 6. It also delivers `scripts/memex-migrate`, a Python-based runner that applies these migrations idempotently and records SHA-256 checksums to detect tampering.

The sprint validates the schema's "additive-only" nature (Section 5.4) and the critical behavioral triggers: `canonicalize_thought_content()` (verified against the 22 vectors from Sprint 000), `updated_at` tracking, and `sync_log` change data capture. Finally, it enforces the security boundary between the `memex_mcp` and `memex_sync` roles, ensuring the MCP server cannot delete data.

## 2. Use Cases

| # | Scenario | Inputs | Expected Behavior |
|---|---|---|---|
| 1 | Initial Migration | Empty PostgreSQL 16 instance | Runner applies 0001–0009; `schema_migrations` table contains 9 rows with valid checksums |
| 2 | Idempotent Re-run | Existing migrated database | Runner detects all migrations are already applied; exits 0 with "No pending migrations" |
| 3 | Partial Migration | Database with 0001–0005 applied | Runner applies 0006–0009; resulting schema is identical to a full run |
| 4 | Tamper Detection | Modified `0001_initial_schema.sql` after application | Runner detects checksum mismatch; fails with error before applying any new migrations |
| 5 | Triggered Canonicalization | INSERT content with CRLF, BOM, and NFD | Trigger normalizes to LF, strips BOM, converts to NFC, and adds a single trailing newline |
| 6 | Content Fingerprinting | INSERT/UPDATE `content` | `content_fingerprint` generated column updates with SHA-256 hex string |
| 7 | Role-Based Deletion (Deny) | Connect as `memex_mcp`, execute `DELETE FROM thoughts` | PostgreSQL returns `permission denied for table thoughts` |
| 8 | Role-Based Deletion (Allow) | Connect as `memex_sync`, execute `DELETE FROM thoughts` | Deletion succeeds |
| 9 | Sync Log (Non-Daemon) | INSERT/UPDATE/DELETE as normal user | `sync_log` table gains a row reflecting the operation and `ob_uuid` |
| 10 | Sync Log (Daemon) | `SET LOCAL app.sync_source = 'daemon'`, then write | `sync_log` trigger skips logging (loop prevention) |

## 3. Architecture

### 3.1 Migration Runner (`scripts/memex-migrate`)

The runner is a Python 3 script using `psycopg2` (or `psycopg` v3) to manage the `schema_migrations` table and apply SQL files.

- **Discovery:** Scans `migrations/` for files matching `NNNN_*.sql`.
- **Validation:** Computes SHA-256 of the raw bytes of each file.
- **Idempotency:** Compares disk state against the `schema_migrations` table.
- **Atomicity:** Wraps each individual migration file in a transaction. (Note: `CREATE ROLE` and some index operations may require `autocommit` mode; the runner handles these as exceptions).
- **Security:** Connects using `MEMEX_TEST_DB_*` environment variables.

### 3.2 Schema Invariants

- **Forward-Only:** No rollback logic is implemented.
- **Additive-Only:** No `DROP COLUMN` or `ALTER COLUMN TYPE` (unless widening).
- **Deterministic Canonicalization:** The SQL `normalize(content, NFC)` must match Deno's `content.normalize("NFC")`.

### 3.3 Test Topology

Integration tests live in `tests/integration/test_schema.ts` and are executed by `deno test` via `tests/run-tests.sh`.

- **Fresh State:** Each test run against the migration runner starts by dropping and recreating the `public` schema to ensure a clean slate.
- **Role Simulation:** Tests use separate connection pools for `memex_mcp` and `memex_sync` to verify the permission boundary.

## 4. Implementation Plan

### Phase 1 — SQL Migrations

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
1. Copy SQL from `memex-architecture.md` Section 6 into individual files.
2. In `0009_add_roles.sql`, wrap `CREATE ROLE` in `DO` blocks to prevent errors on re-run:
   ```sql
   DO $$
   BEGIN
      IF NOT EXISTS (SELECT FROM pg_catalog.pg_roles WHERE rolname = 'memex_mcp') THEN
         CREATE ROLE memex_mcp LOGIN PASSWORD 'memex_mcp_test_password';
      END IF;
   END
   $$;
   ```
3. Document manual migration steps in `migrations/README.md`.

### Phase 2 — Python Migration Runner

**Files created:**
- `scripts/memex-migrate` (Python 3, executable)
- `scripts/requirements.txt` (if needed, or use `std` libs)

**Tasks:**
1. Implement `get_applied_migrations()` by querying `schema_migrations`.
2. Implement `apply_migration(path)` which reads, hashes, and executes the SQL file, then inserts into `schema_migrations`.
3. Use `hashlib.sha256` for checksums.
4. Ensure the runner uses `MEMEX_TEST_DB_*` environment variables for its connection.
5. Add a `--check` flag for CI that only validates checksums without applying.

### Phase 3 — Integration Test: Schema & Idempotency

**Files created:**
- `tests/integration/schema.test.ts`

**Tasks:**
1. Test 1: Run `scripts/memex-migrate` against a fresh DB. Verify all tables and roles exist.
2. Test 2: Run `scripts/memex-migrate` again. Verify it exits 0 and makes no changes.
3. Test 3: Manually modify a migration file and verify the runner fails with a checksum error.

### Phase 4 — Integration Test: Canonicalization & Triggers

**Files modified:**
- `tests/integration/schema.test.ts`

**Tasks:**
1. Load `tests/fixtures/canonicalization-cases.json`.
2. For each case:
   - INSERT `input` into `thoughts`.
   - SELECT `content` and `content_fingerprint`.
   - Assert `content === expected` (byte-for-byte).
   - Assert `content_fingerprint` matches the SHA-256 of `expected`.
3. Verify `updated_at` changes on UPDATE but not on INSERT (unless specified).
4. Verify `source` generated column correctly extracts from `metadata->>'source'`.

### Phase 5 — Integration Test: Role Permissions

**Files modified:**
- `tests/integration/schema.test.ts`

**Tasks:**
1. Create a connection as `memex_mcp`.
2. Attempt `DELETE FROM thoughts`. Assert it fails with `42501` (insufficient_privilege).
3. Attempt `INSERT` and `SELECT`. Assert they succeed.
4. Create a connection as `memex_sync`.
5. Attempt `DELETE FROM thoughts`. Assert it succeeds.

### Phase 6 — Integration Test: Sync Log CDC

**Files modified:**
- `tests/integration/schema.test.ts`

**Tasks:**
1. Perform INSERT/UPDATE/DELETE. Verify `sync_log` entries are created with correct `operation` and `ob_uuid`.
2. Execute `SET LOCAL app.sync_source = 'daemon'`.
3. Perform a write. Verify NO `sync_log` entry is created.

### Phase 7 — Runner Extension

**Files modified:**
- `tests/run-tests.sh`

**Tasks:**
1. Insert the migration step after PostgreSQL readiness:
   ```bash
   echo "[run-tests] applying migrations"
   python3 scripts/memex-migrate
   ```
2. Update `deno task test` to include `tests/integration/`.

---

## 5. Verification Plan

### 5.1 Automated Checks

| # | Check | What It Validates | File |
|---|---|---|---|
| 1 | Migration Application | All 9 migrations apply to an empty DB | `tests/integration/schema.test.ts` |
| 2 | Migration Idempotency | Re-running the runner is a no-op | `tests/integration/schema.test.ts` |
| 3 | Checksum Integrity | Tampering with a file triggers a failure | `tests/integration/schema.test.ts` |
| 4 | Canonicalization (22/22) | SQL trigger matches the fixture corpus | `tests/integration/schema.test.ts` |
| 5 | Role Boundary (MCP) | `memex_mcp` cannot delete | `tests/integration/schema.test.ts` |
| 6 | Role Boundary (Sync) | `memex_sync` can delete | `tests/integration/schema.test.ts` |
| 7 | Sync Log Trigger | CDC captures changes only from non-daemon sources | `tests/integration/schema.test.ts` |

### 5.2 Manual Verification Steps

1. **Destroy and rebuild the test stack:**
   ```bash
   ./tests/run-tests.sh
   ```
   **Expected Output:**
   ```text
   [run-tests] preflight
   [run-tests] bringing up stack
   [run-tests] waiting for readiness
   [run-tests] applying migrations
   Applying 0001_initial_schema.sql... OK
   ...
   Applying 0009_add_roles.sql... OK
   [run-tests] running tests
   ...
   test schema.test.ts ... ok
   [run-tests] OK
   ```

2. **Verify checksum protection:**
   - Run `./tests/run-tests.sh` once to apply migrations.
   - Append `-- comment` to `migrations/0001_initial_schema.sql`.
   - Run `python3 scripts/memex-migrate`.
   **Expected Output:** Error message indicating checksum mismatch for 0001.

3. **Verify roles in psql:**
   - `docker compose -p memex-test -f tests/compose.yaml exec postgres psql -U memex_test -d memex_test -c "\du"`
   **Expected Output:** `memex_mcp` and `memex_sync` roles listed.

### 5.3 Regression Scenarios

1. **Sprint 000 Smoke Test:**
   - Run `./tests/run-tests.sh`.
   - **Assertion:** `tests/unit/smoke.test.ts` must still pass (PostgreSQL reachable, mock inference reachable, fixtures valid).

## 6. Files Summary

- `migrations/0001_initial_schema.sql` through `0009_add_roles.sql`
- `migrations/README.md`
- `scripts/memex-migrate`
- `tests/integration/schema.test.ts`
- `tests/run-tests.sh` (modified)

## 7. Definition of Done

- [ ] All 9 SQL migrations match `memex-architecture.md` Section 6.
- [ ] `scripts/memex-migrate` is idempotent and uses SHA-256 for tampering detection.
- [ ] `scripts/memex-migrate` uses `MEMEX_TEST_DB_*` environment variables.
- [ ] Integration tests verify the schema against all 22 canonicalization fixtures.
- [ ] Integration tests verify the `memex_mcp` vs `memex_sync` DELETE permission boundary.
- [ ] Integration tests verify the `sync_log` trigger and its loop prevention.
- [ ] `tests/run-tests.sh` includes the migration step and integration tests.
- [ ] CI passes on GitHub Actions.

## 8. Risks & Mitigations

| # | Risk | Why It Matters | Mitigation |
|---|---|---|---|
| 1 | `normalize(NFC)` mismatch | SQL and Deno/Python might disagree on edge-case Unicode normalization | Use the 22-fixture corpus to verify byte-identical output across all boundaries. |
| 2 | `CREATE ROLE` permissions | The test user `memex_test` might not have permission to create roles | Use the `postgres` superuser or ensure `memex_test` has `CREATEROLE` in `tests/compose.yaml`. |
| 3 | Transactional DDL | Some PostgreSQL DDL isn't safe in transactions with roles | Use `autocommit` or specific `DO` block strategies for role creation. |

## 9. Dependencies

- **Sprint 000** must be complete (provides `tests/compose.yaml` and `tests/fixtures/canonicalization-cases.json`).
- Python 3.x with `psycopg2` or `psycopg` must be available in the test environment.

## 10. Open Questions (Answers)

1. **Runner language: Python or Bash?** Python. Better for checksum tracking, structured error handling, and future extensibility.
2. **Integration test language: Deno or Python?** Deno. Keeps toolchain sprawl low as Sprint 000 is already Deno-based.
3. **Migration checksum algorithm?** SHA-256 of the raw file bytes. Standard and sufficient.
4. **How does the runner get its database credentials?** Via `MEMEX_TEST_DB_*` environment variables. Consistent with Sprint 000.
5. **Where does role creation happen?** Migration 0009. Wrapped in `DO` blocks for idempotency.
6. **Integration test isolation.** Shared database, but the integration test suite clears the schema (or drops/recreates) to test migration application from scratch.
7. **Does the runner belong in compose or `run-tests.sh`?** Separate step in `run-tests.sh`. Simpler orchestration.
8. **How does a failed migration leave the database?** Partially applied. `schema_migrations` tracks progress. Operator must fix and re-run.
