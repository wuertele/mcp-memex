# Sprint 001: Schema Migrations and Migration Runner (Claude Draft)

**Status:** Draft
**Drafter:** Claude (1 of 3 parallel drafters — Codex and Gemini drafting independently)
**Prerequisites:** Sprint 000 complete (test platform exists, canonicalization fixture corpus committed)
**Produces for later sprints:** A working, tested PostgreSQL schema that matches `memex-architecture.md` Section 6, a reusable forward-only migration runner, and a role-scoped database environment ready for Sprint 002's MCP server scaffold.

---

## 1. Overview

Sprint 001 lands the database schema that every subsequent sprint depends on. The architecture specifies the schema as nine forward-only, additive migrations (`memex-architecture.md` Section 6.1–6.9). This sprint translates that specification into executable SQL files under `migrations/`, builds a minimal migration runner (`scripts/memex-migrate`) that applies pending migrations and records checksums, and adds schema-level integration tests under `tests/integration/` that exercise the migrations end-to-end against the Sprint 000 Compose PostgreSQL instance.

The sprint adds no application code: no MCP server, no sync daemon, no deployment target. The only executables produced are the migration runner and the integration tests. Everything runs inside the Sprint 000 Compose stack; no second PostgreSQL environment is introduced.

Canonicalization gets special attention: the SQL `canonicalize_thought_content()` trigger from Section 6.4 must produce output byte-identical to every one of the 22 shared fixtures in `tests/fixtures/canonicalization-cases.json`. Sprint 000 verified the fixtures as hand-authored expectations; Sprint 001 is the first time those expectations are run against a real database.

Role enforcement also matters: `memex_mcp` must be demonstrably unable to `DELETE FROM thoughts`, and `memex_sync` must be demonstrably able to. These are the Section 5.8 deletion-invariant's runtime teeth, and Sprint 001 is where they grow.

## 2. Use Cases

| # | Scenario | Inputs | Expected Behavior |
|---|---|---|---|
| 1 | Fresh apply | Operator runs `./tests/run-tests.sh` on an empty pgvector database | All 9 migrations apply in order, `schema_migrations` has 9 rows each with a non-null SHA-256 checksum, exit 0 |
| 2 | No-op rerun | Operator runs the runner again against the same DB | Runner reads `schema_migrations`, finds all 9 versions applied, does nothing, exits 0 with a "0 pending" line |
| 3 | Split apply | Apply 0001–0005, then apply 0006–0009 in a second invocation | Final schema is byte-identical (by `pg_dump --schema-only` normalized) to a single-pass apply of all 9 |
| 4 | Checksum tamper detection | Modify a byte in an already-applied migration file, rerun | Runner exits non-zero with a "checksum mismatch for 0004_…" error and does not re-apply |
| 5 | Canonicalization on INSERT | Insert every fixture `input` from `canonicalization-cases.json` as a thought | Stored `content` equals fixture `expected` byte-for-byte for all 22 cases |
| 6 | Canonicalization on UPDATE | Insert a canonical thought, then `UPDATE thoughts SET content = '<fixture input>'` | Trigger re-fires, stored content equals fixture `expected` |
| 7 | `content_fingerprint` generated column | Insert a thought with known post-canonical content | `content_fingerprint` equals hex-encoded SHA-256 of the stored `content` bytes |
| 8 | `ob_uuid` default | Insert a thought without specifying `ob_uuid` | Row gets a unique, non-null UUID via `gen_random_uuid()` |
| 9 | `source` generated column | Insert a thought with `metadata = '{"source":"human"}'` | `source` column equals `'human'`; reflects through updates |
| 10 | `updated_at` trigger | Insert a thought, then UPDATE it | `updated_at` moves forward; `created_at` unchanged |
| 11 | `sync_log` non-daemon writer | INSERT, UPDATE, DELETE as `memex_sync` (no session var) | One `sync_log` row per operation with the correct `operation` value |
| 12 | `sync_log` daemon writer | `SET LOCAL app.sync_source = 'daemon'`, then INSERT/UPDATE/DELETE | No `sync_log` rows created |
| 13 | `memex_mcp` DELETE forbidden | Connect as `memex_mcp` and attempt `DELETE FROM thoughts` | PostgreSQL raises a permission error (SQLSTATE 42501) |
| 14 | `memex_mcp` SELECT/INSERT/UPDATE allowed | Connect as `memex_mcp` and perform each | Succeeds; `match_thoughts()` callable |
| 15 | `memex_sync` full control | Connect as `memex_sync` and `DELETE FROM thoughts` | Succeeds |
| 16 | `match_thoughts` smoke | Insert two thoughts with mock embeddings, call `match_thoughts(<query>, 0.0, 10, '{}')` | Returns rows ordered by cosine distance, no error |
| 17 | CI execution | GitHub Actions runs `./tests/run-tests.sh` on PR | Smoke + integration tests both run; CI passes within the Sprint 000 10-minute budget |
| 18 | Regression: Sprint 000 smoke still passes | `deno task test` unit suite | Every Sprint 000 smoke assertion still succeeds |

## 3. Architecture

### 3.1 Decisions on the Intent Doc's Open Questions

These are answered up front — the rest of the sprint plan assumes them.

**Q1. Runner language — Python or Bash?** **Bash.**

Justification: the runner's surface area is tiny — enumerate files, diff against `schema_migrations`, compute SHA-256, shell out to `psql`, insert a row. Bash + `psql` + `sha256sum` nails all of that in ~120 lines with zero dependency footprint. Python would add a Python runtime and probably a `psycopg` dependency to the test environment just for this one script, and Sprint 002's MCP server is Deno, not Python — so choosing Python here would install a language that nothing else in Sprint 001/002 uses. `psql` is already needed by the integration tests regardless (see Q2), so Bash piggybacks on an already-required tool.

The Bash runner runs inside the Compose Postgres container via `docker compose exec -T postgres psql`, so it does not even require the host to have `psql` installed — only the `sha256sum` and `stat` coreutils that Bash already assumes. This keeps the host prerequisite story the same as Sprint 000 (docker + deno).

**Q2. Integration test language — Deno or Python?** **Deno.**

Justification: Sprint 000 standardized on Deno for tests. Keeping the integration tests in Deno:
- Reuses the existing `deno.json` `test` task that `tests/run-tests.sh` already invokes
- Keeps one toolchain — no Python interpreter needed in CI
- Sprint 002's MCP server will be Deno, so the integration test infrastructure built here directly serves Sprint 002's tests

Deno's `@std/assert` plus `Deno.Command("docker", ["compose", …, "exec", "-T", "postgres", "psql", …])` is the concrete DB-driver pattern: integration tests shell out to `psql` inside the Postgres container and parse tab-separated output. No Deno PostgreSQL driver is introduced. This choice interacts with Q1 cleanly: runner is Bash-via-psql, tests are Deno-via-psql, both hit the same container, neither needs a host client.

*Why not add a Deno Postgres driver?* It would be a new dependency, increase CI download time, and the test patterns we need (exit code + stdout parse + ERRCODE capture) are fine over `psql`. Sprint 002 can revisit when it needs connection pooling.

**Q3. Checksum algorithm?** **SHA-256 of the raw file bytes, hex-encoded.**

SHA-256 is cryptographically strong, widely available (`sha256sum` on Linux, `shasum -a 256` as a fallback), matches the `content_fingerprint` algorithm used elsewhere in the schema (aesthetic consistency), and is sufficient for tamper detection. No rationale to pick anything else.

**Q4. Runner DB credentials?** **Reuse `MEMEX_TEST_*` env vars already exported by `tests/run-tests.sh`.**

The runner reads `MEMEX_TEST_DB_HOST`, `MEMEX_TEST_DB_PORT`, `MEMEX_TEST_DB_NAME`, `MEMEX_TEST_DB_USER`, `MEMEX_TEST_DB_PASSWORD` and uses them to construct `psql` invocations. This avoids inventing a new config surface. The runner accepts optional override flags (`--db-name`, `--db-user`) for future operator use, but defaults come from the environment.

*Clarification:* the runner runs the migrations as the superuser `memex_test` (which owns the test database). It does NOT run as `memex_mcp` or `memex_sync` — those roles don't exist until migration 0009 creates them, and they lack permission to create extensions or DDL anyway.

**Q5. Role creation idempotency?** **Wrap `CREATE ROLE` in `DO $$` blocks with `pg_catalog.pg_roles` existence checks; set passwords unconditionally via `ALTER ROLE`; grants are inherently idempotent.**

Migration 0009 looks like:

```sql
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'memex_mcp') THEN
    CREATE ROLE memex_mcp LOGIN PASSWORD 'memex_mcp_test_password';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'memex_sync') THEN
    CREATE ROLE memex_sync LOGIN PASSWORD 'memex_sync_test_password';
  END IF;
END
$$;

ALTER ROLE memex_mcp WITH PASSWORD 'memex_mcp_test_password';
ALTER ROLE memex_sync WITH PASSWORD 'memex_sync_test_password';

GRANT CONNECT ON DATABASE memex_test TO memex_mcp, memex_sync;
GRANT USAGE ON SCHEMA public TO memex_mcp, memex_sync;

GRANT SELECT, INSERT, UPDATE ON thoughts TO memex_mcp;
GRANT SELECT ON sync_log, sync_state TO memex_mcp;
GRANT SELECT, INSERT ON thought_relations TO memex_mcp;
GRANT USAGE, SELECT ON SEQUENCE thoughts_id_seq TO memex_mcp;
GRANT EXECUTE ON FUNCTION match_thoughts(vector, float, int, jsonb) TO memex_mcp;

GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO memex_sync;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO memex_sync;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO memex_sync;
```

*Why DO-block and not "tolerate 42710"?* DO-block keeps the idempotency visible at the SQL level rather than pushed into the runner. It means a DBA running the migration by hand (`psql -f migrations/0009_add_roles.sql`) gets the same idempotent behavior without needing the Bash runner. This matches the "migrations apply cleanly via psql alone" principle implicit in the architecture.

*Passwords:* hardcoded test placeholders in the committed file, explicitly named `*_test_password`. The architecture's "placeholders replaced at deployment time by the provisioning mechanism" note is a deployment-sprint concern; for Sprint 001 they are just test fixtures. The passwords are documented in `migrations/README.md` as test-only and never to be used in production. Sprint 002+ deployment work will replace them via a provisioning layer.

*Why grant `thought_relations` to `memex_mcp`?* The MCP server will write relations in later sprints; the grant is additive and hurts nothing.

**Q6. Integration test isolation — shared DB or per-test fresh?** **Hybrid: one migration apply per test-file, but tests within a file use transactions (BEGIN/ROLLBACK) or clean up their own rows.**

Rationale: dropping and recreating the entire `memex_test` database between every `Deno.test()` case adds seconds × dozens of tests = slow. Instead:

1. `tests/run-tests.sh` resets the test DB **once** at the start of the integration phase: drops and recreates `memex_test`, then runs `scripts/memex-migrate` against it to get to the fully-migrated state.
2. Each test file begins with a `TRUNCATE thoughts, sync_log, thought_relations, sync_state RESTART IDENTITY CASCADE` (as superuser) in its `beforeAll` so tests can assume empty tables.
3. Individual tests within a file either (a) use explicit TRUNCATE in setup, or (b) use unique identifying content to avoid cross-test collisions.
4. A dedicated "from empty" test file (`test_migrations_apply.test.ts`) handles the "fresh apply" and "no-op rerun" scenarios — it drops/recreates the DB itself before running.

This costs ~1s setup per file and keeps the whole integration suite under 30 seconds. Per-test DB creation is rejected as overkill for schema-level tests.

**Q7. Runner as Compose service or separate step?** **Separate step in `run-tests.sh`, not a Compose service.**

Justification: making the runner a Compose service means tying it to startup ordering, `depends_on`, and Compose healthchecks — unnecessary complexity for a script that runs once per test invocation. Keeping it as a shell step in `run-tests.sh` means the runner's output is interleaved with the test output naturally, errors surface directly, and the Compose file stays focused on the two long-running services. The runner already runs inside the Postgres container via `docker compose exec`, so it has the same network reachability as a Compose service would.

**Q8. Failed migration recovery story?** **Each migration runs inside an explicit `BEGIN`/`COMMIT` block wrapping the whole file; the runner emits a clear error and halts.**

Concretely: the runner invokes `psql` with `--single-transaction --set ON_ERROR_STOP=1 -f <migration>.sql`, which automatically wraps the file in a transaction and rolls back on any error. A partial apply is impossible at the DDL level. If migration 0005 fails:
- Migrations 0001–0004 remain fully applied and their `schema_migrations` rows remain.
- Migration 0005 leaves no partial state — its DDL is rolled back.
- Runner exits non-zero and prints: `FAILED: migration 0005_updated_at.sql — see psql output above. Fix the file and re-run.`
- Operator fixes the SQL, reruns the runner, 0005 re-applies from clean state.

*Caveats documented in `migrations/README.md`:*
1. PostgreSQL allows most DDL (including `CREATE INDEX` and `CREATE FUNCTION`) inside a transaction. `CREATE INDEX CONCURRENTLY` is the notable exception, but we don't use it — the HNSW index in 0001 is built non-concurrently on an empty table, which is fast.
2. `CREATE ROLE` in 0009 is cluster-scoped and technically transactional in PG 16 when done inside a SQL transaction, but the DO-block + existence check makes it robust regardless.
3. Side-effects that leak outside a transaction (file writes, `pg_notify`) are not used by any migration.

Operators who experience a mid-apply failure should see the rolled-back state as a feature, not a bug: the runner's "apply 0001–N-1 cleanly, fail loudly on N" behavior is exactly what forward-only migration discipline prescribes.

### 3.2 Repository Layout After Sprint 001

```text
mcp-memex/
├── migrations/                                  # NEW
│   ├── 0001_initial_schema.sql
│   ├── 0002_ob_uuid.sql
│   ├── 0003_source_generated_column.sql
│   ├── 0004_canonicalization_and_fingerprint.sql
│   ├── 0005_updated_at.sql
│   ├── 0006_thought_relations.sql
│   ├── 0007_sync_log.sql
│   ├── 0008_sync_state.sql
│   ├── 0009_add_roles.sql
│   └── README.md
├── scripts/                                     # NEW
│   └── memex-migrate                            # Bash runner
├── tests/
│   ├── compose.yaml                             # unchanged
│   ├── run-tests.sh                             # EXTENDED (integration phase added)
│   ├── fixtures/
│   │   └── canonicalization-cases.json          # consumed, unchanged
│   ├── integration/                             # NEW content
│   │   ├── lib/
│   │   │   ├── psql.ts                          # psql-via-docker-exec helper
│   │   │   └── db_reset.ts                      # drop/create/migrate helper
│   │   ├── test_migrations_apply.test.ts
│   │   ├── test_canonicalization.test.ts
│   │   ├── test_triggers.test.ts
│   │   ├── test_generated_columns.test.ts
│   │   ├── test_sync_log.test.ts
│   │   ├── test_roles.test.ts
│   │   └── test_match_thoughts.test.ts
│   └── unit/
│       └── smoke.test.ts                        # unchanged
└── deno.json                                    # task definitions extended
```

No existing file is deleted; `tests/run-tests.sh` is extended (phase 2) not rewritten.

### 3.3 Migration Runner Design

**`scripts/memex-migrate`** is a single Bash script, ~150 lines, `set -euo pipefail`.

**Invocation:**

```bash
./scripts/memex-migrate              # apply pending migrations
./scripts/memex-migrate --status     # print applied-vs-pending, exit 0
./scripts/memex-migrate --verify     # recompute checksums, compare, fail on mismatch
```

**Algorithm (apply mode):**

1. Read `MEMEX_TEST_DB_*` env vars. Require all five; error otherwise.
2. Set `COMPOSE=(docker compose -p memex-test -f tests/compose.yaml)` and `PSQL=("${COMPOSE[@]}" exec -T -e PGPASSWORD="${MEMEX_TEST_DB_PASSWORD}" postgres psql -v ON_ERROR_STOP=1 --no-psqlrc -q -h 127.0.0.1 -U "${MEMEX_TEST_DB_USER}" -d "${MEMEX_TEST_DB_NAME}")`.
3. Bootstrap: create `schema_migrations` table if it does not exist. (Migration 0001 also creates it with `IF NOT EXISTS`; the runner creates it first so it can query applied versions even on a virgin DB.)
4. Query `SELECT version FROM schema_migrations ORDER BY version` → applied set.
5. Enumerate `migrations/[0-9][0-9][0-9][0-9]_*.sql`, sorted lexicographically → all set.
6. For each migration file NOT in applied set, in order:
   a. Compute SHA-256 of file bytes → `$checksum`.
   b. Invoke `psql --single-transaction -f <file>`.
   c. On success, `INSERT INTO schema_migrations (version, checksum) VALUES ('0001_initial_schema', '<hex>')`.
   d. Print `APPLIED: 0001_initial_schema.sql (checksum: <first 12 chars>...)`.
   e. On failure, print `FAILED: <file>`, dump psql stderr, exit 1.
7. For each migration file IN applied set, verify its recomputed checksum equals the stored one. On mismatch, print `TAMPER: <file> checksum differs from applied version <stored>; refusing to continue`, exit 2.
8. Print `DONE: <N> applied this run, <M> already up-to-date`.

**Version string format:** file basename without extension, e.g., `0001_initial_schema`. Matches the architecture's `schema_migrations.version` text column.

**Bootstrap race:** not a concern — Sprint 001 has a single-writer test runner. A future deployment sprint can add `pg_try_advisory_lock` if needed.

### 3.4 Canonicalization Function Correctness

The architecture's SQL for `canonicalize_thought_content()`:

```sql
NEW.content := regexp_replace(NEW.content, E'^\uFEFF', '');
NEW.content := regexp_replace(NEW.content, E'\r\n?', E'\n', 'g');
NEW.content := regexp_replace(NEW.content, E'\n+$', '') || E'\n';
NEW.content := normalize(NEW.content, NFC);
```

Cross-checking against the 22 fixtures:
- **bom-stripping:** `^\uFEFF` strip — handled by line 1.
- **crlf-to-lf:** `\r\n?` → `\n` — handles both `\r\n` and bare `\r`. Handled by line 2.
- **trailing-newline-collapse:** strip all trailing `\n`, append exactly one — handled by line 3.
- **missing-trailing-newline-added:** `"a"` → `regexp_replace("a", '\n+$', '')` = `"a"`, then `|| '\n'` = `"a\n"`. Correct.
- **leading-newlines-preserved:** `"\n\nhello\n"` → BOM strip no-op → CRLF no-op → trailing: strip `\n`, append `\n` → `"\n\nhello\n"`. Correct.
- **nfc:** `normalize(text, NFC)` on PG 13+. Handled.
- **internal-whitespace / boundary cases:** preserved because nothing touches them.

**Edge case: empty string input.** `""` → BOM no-op → CRLF no-op → `regexp_replace("", '\n+$', '')` = `""`, then `|| '\n'` = `"\n"`. If any fixture expects `""` → `""`, the SQL will produce `"\n"` and the test will fail. **This is where the Sprint 001 test is load-bearing.** The sprint's action if the mismatch surfaces:
1. Re-verify the architecture spec's intent: does the memex want `"" → "\n"` or `"" → ""`? The architecture says "exactly one" trailing newline, implying `"\n"`.
2. If the fixture disagrees, this sprint flags it in review and proposes a fixture update (which is a change to Sprint 000 output — handled as a cross-sprint correction, not a Sprint 001 scope expansion).

**Edge case: whitespace-only input like `"   \n"`.** Handled unchanged — the function does not touch interior whitespace.

**Edge case: input containing only `"\n"`.** `regexp_replace("\n", '\n+$', '')` = `""`, then `|| '\n'` = `"\n"`. Correct (round-trip).

### 3.5 Test-Helper Shape

`tests/integration/lib/psql.ts` exports:

```typescript
export interface PsqlResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export async function psql(
  sql: string,
  opts?: { user?: string; password?: string; db?: string; rowsOnly?: boolean }
): Promise<PsqlResult>;

export async function psqlRows(sql: string, opts?: …): Promise<string[][]>;

export async function expectPsqlError(
  sql: string,
  expectedSqlState: string,
  opts?: …
): Promise<void>;
```

The helper runs `docker compose -p memex-test -f tests/compose.yaml exec -T -e PGPASSWORD=… postgres psql -v ON_ERROR_STOP=1 --no-psqlrc -At -F $'\t' -U … -d … -c "<sql>"`. `-At` = unaligned + tuples-only, `-F $'\t'` = tab-separated for easy parsing.

`expectPsqlError` runs the query and asserts the exit is non-zero AND the stderr contains `SQLSTATE <code>` (e.g., `42501` for insufficient privilege on the DELETE test). Role credentials for `memex_mcp` / `memex_sync` are supplied via the `user`/`password` options.

`tests/integration/lib/db_reset.ts` exports:

```typescript
export async function dropAndCreateTestDb(): Promise<void>;
export async function runMigrate(): Promise<void>;
export async function truncateAllDataTables(): Promise<void>;
```

`dropAndCreateTestDb` connects to the `postgres` maintenance DB as `memex_test`, runs `DROP DATABASE IF EXISTS memex_test`, then `CREATE DATABASE memex_test`. `runMigrate` shells out to `./scripts/memex-migrate`. `truncateAllDataTables` truncates `thoughts`, `sync_log`, `thought_relations`, `sync_state` with `RESTART IDENTITY CASCADE`.

### 3.6 Extension of `tests/run-tests.sh`

Add an integration phase between the existing "readiness" block and the current `deno task test` invocation:

```bash
echo "[run-tests] applying migrations"
./scripts/memex-migrate

echo "[run-tests] running unit tests"
deno task test:unit

echo "[run-tests] running integration tests"
deno task test:integration
```

The `deno.json` at the repo root gets two new tasks:

```json
{
  "tasks": {
    "test": "deno test --allow-all tests/unit/ tests/integration/",
    "test:unit": "deno test --allow-all tests/unit/",
    "test:integration": "deno test --allow-all tests/integration/"
  }
}
```

The existing `test` task keeps working (runs both) so local `deno task test` still behaves unchanged; CI's `run-tests.sh` gains explicit phase separation for better log readability. `--allow-all` is retained as the simplest policy; tightening permissions is a Sprint 002+ concern.

`test_migrations_apply.test.ts` is the only test file that calls `dropAndCreateTestDb` itself (since it tests the apply-from-empty path). All other integration test files assume the DB is already migrated by the runner invocation above.

## 4. Implementation Plan

### Phase 1 — Migration SQL Files

**Files created:** `migrations/0001_initial_schema.sql` through `migrations/0009_add_roles.sql`, `migrations/README.md`.

**Tasks:**

1. For each of the 9 migrations, transcribe the SQL verbatim from `memex-architecture.md` Section 6.N into `migrations/000N_<name>.sql`. The exact file names: `0001_initial_schema.sql`, `0002_ob_uuid.sql`, `0003_source_generated_column.sql`, `0004_canonicalization_and_fingerprint.sql`, `0005_updated_at.sql`, `0006_thought_relations.sql`, `0007_sync_log.sql`, `0008_sync_state.sql`, `0009_add_roles.sql`.
2. Each file starts with a comment header naming the migration, the architecture section it implements, and a short description.
3. Where the architecture SQL is not idempotent as-written, add `IF NOT EXISTS` / `CREATE OR REPLACE` qualifiers so that `psql -f <file>` is safe on a partially-applied DB. This is belt-and-suspenders — the runner prevents re-apply, but idempotency at the file level is the architecture's stated rule (Section 5.4).
4. For 0002 (`ADD COLUMN ob_uuid`), wrap in `ALTER TABLE thoughts ADD COLUMN IF NOT EXISTS ob_uuid uuid NOT NULL DEFAULT gen_random_uuid()`. Requires the `pgcrypto` extension for `gen_random_uuid()` on PG < 13, but pgvector/pgvector:pg16 has it built in (PG 13+ ships `gen_random_uuid` in core). Verify by inspecting the pgvector image.
5. For 0003, `ADD COLUMN IF NOT EXISTS source text GENERATED ALWAYS AS …`.
6. For 0004, `CREATE OR REPLACE FUNCTION canonicalize_thought_content() …`; `DROP TRIGGER IF EXISTS thoughts_canonicalize_content ON thoughts; CREATE TRIGGER thoughts_canonicalize_content …`; `ADD COLUMN IF NOT EXISTS content_fingerprint …`.
7. For 0005, mirror 0004's trigger pattern for `update_thoughts_updated_at`; `ADD COLUMN IF NOT EXISTS updated_at`.
8. For 0006, `CREATE TABLE IF NOT EXISTS thought_relations …`.
9. For 0007, `CREATE TABLE IF NOT EXISTS sync_log`; `CREATE OR REPLACE FUNCTION log_thoughts_changes()`; drop-and-recreate trigger pattern.
10. For 0008, `CREATE TABLE IF NOT EXISTS sync_state …`.
11. For 0009, use the DO-block pattern described in Section 3.1 Q5.
12. Write `migrations/README.md` covering: directory purpose, file naming convention, how to apply manually (`psql -f`), how to apply via the runner (`./scripts/memex-migrate`), the additive-only rule with a link to architecture Section 5.4, the failure-recovery story from Section 3.1 Q8, and the test-password placeholders in 0009.

### Phase 2 — Migration Runner

**Files created:** `scripts/memex-migrate`.

**Tasks:**

1. Create `scripts/` directory.
2. Implement the runner per Section 3.3. `set -euo pipefail; set -E; trap 'echo "[memex-migrate] FAILED at line $LINENO" >&2' ERR`.
3. Use `sha256sum` when available, fall back to `shasum -a 256` (macOS). Runner runs on the host, so both matter.
4. `chmod +x scripts/memex-migrate`.
5. Add a top-of-file usage comment covering modes, env vars, exit codes (0 = success, 1 = migration failed, 2 = checksum mismatch, 3 = prereq error).
6. Hand-test locally: bring up compose, run the script, check `schema_migrations` has 9 rows. Tear down, bring up again, run the script, confirm 9 applies. Run again, confirm 0 applies. Modify a byte in an applied file, confirm tamper detection exits 2.

### Phase 3 — Integration Test Helpers

**Files created:** `tests/integration/lib/psql.ts`, `tests/integration/lib/db_reset.ts`.

**Tasks:**

1. Implement `psql.ts` per Section 3.5. Use `Deno.Command` with stdin piping for multi-line SQL (avoids shell escaping hell).
2. Implement `db_reset.ts` per Section 3.5. `dropAndCreateTestDb` uses `PGDATABASE=postgres` as maintenance DB and issues `DROP DATABASE IF EXISTS memex_test WITH (FORCE)` to kick active connections (PG 13+).
3. Write a tiny self-test at the bottom of each helper file as a `Deno.test()` case: `psql("SELECT 1")` returns `"1"`.

### Phase 4 — Apply and Idempotency Tests

**File created:** `tests/integration/test_migrations_apply.test.ts`.

**Tasks:**

1. Test "fresh apply on empty DB":
   - `dropAndCreateTestDb()`
   - `runMigrate()`
   - Assert `schema_migrations` has exactly 9 rows with versions `0001_initial_schema` … `0009_add_roles`
   - Assert each `checksum` is a 64-character hex string
   - Assert each `applied_at` is within the last 60 seconds

2. Test "rerun is no-op":
   - After the prior test's state (or `runMigrate()` again), capture `SELECT count(*), max(applied_at) FROM schema_migrations`
   - `runMigrate()`
   - Assert count unchanged, max(applied_at) unchanged
   - Assert runner stdout contains `DONE: 0 applied this run`

3. Test "split apply equals single apply":
   - Approach: this is asserted structurally, not by running a parallel DB. Rationale: the runner applies migrations one at a time in order anyway — a "full" run is literally a sequence of single-migration applies. Instead, verify the equivalence by schema introspection:
     - `dropAndCreateTestDb()`
     - Copy `scripts/memex-migrate` invocation but with a filter env var `MEMEX_MIGRATE_MAX=0005` (runner reads this and stops after 0005). Apply 0001–0005.
     - Snapshot schema: `SELECT table_name, column_name, data_type FROM information_schema.columns WHERE table_schema='public' ORDER BY table_name, ordinal_position` → sort → hash.
     - Unset the filter, apply the remaining four.
     - Snapshot again.
     - In a fresh DB: apply all nine in one pass. Snapshot.
     - Assert the two final snapshots are identical.
   - **Runner modification required:** add an optional `MEMEX_MIGRATE_MAX` env var (string compared lexicographically against version) to halt after a specified migration. Documented in the runner usage comment. This is the only runner feature added specifically for testing — it's simple and proves the split-apply property.

4. Test "checksum tamper detection":
   - `dropAndCreateTestDb()`, `runMigrate()`
   - Programmatically append a single trailing comment line to `migrations/0004_canonicalization_and_fingerprint.sql` (file mutation is done in a `try/finally` that restores the original bytes, or against a copy in a temp dir with a custom migrations path — prefer the latter).
   - Rerun the runner
   - Assert exit code 2 and stderr contains `TAMPER` and `0004_canonicalization_and_fingerprint`.
   - **Runner modification required:** accept `MEMEX_MIGRATE_DIR` env var defaulting to `migrations/` so tests can point at a temp dir with a tampered copy. Also simple, also documented.

### Phase 5 — Canonicalization Fixture Test

**File created:** `tests/integration/test_canonicalization.test.ts`.

**Tasks:**

1. Read `tests/fixtures/canonicalization-cases.json`.
2. `beforeAll`: `truncateAllDataTables()`.
3. For each fixture:
   - INSERT a thought with `content = <fixture.input>` using a parameterized query via `psql -v`. Use `E'...'` escape strings; pipe SQL via stdin to avoid quoting.
   - Immediately `SELECT content FROM thoughts WHERE id = currval('thoughts_id_seq')`.
   - Assert `content == fixture.expected` byte-for-byte.
   - Also assert `content_fingerprint == sha256_hex(fixture.expected_bytes)` (computed in-test via Deno's `crypto.subtle`).
   - Also test UPDATE: update the same row's content to another fixture's input, re-select, assert expected output.
4. Report any fixture mismatch with a clear diff including byte arrays (not just strings).
5. If the `""` → `"\n"` edge case (Section 3.4) surfaces as a fixture mismatch, the test fails loudly and the sprint review flags it. Do not paper over.

**Note on stdin piping:** use a dedicated helper `insertThoughtWithContent(content: string): Promise<bigint>` that writes the content to a temporary file inside the postgres container via `docker compose exec -T postgres sh -c 'cat > /tmp/content.txt'` piping the raw bytes, then runs `INSERT INTO thoughts (content) VALUES (pg_read_file('/tmp/content.txt')::text)`. This fully bypasses any quoting-related byte corruption, which matters because some fixtures contain backslashes, CR bytes, and combining characters.

*Alternative considered:* `psql -c` with `E'...'` escapes. Rejected because constructing byte-perfect escape strings in Deno for every fixture is error-prone and adds an unnecessary risk of test-side bugs masking SQL-side correctness.

### Phase 6 — Generated Column and Trigger Tests

**Files created:** `tests/integration/test_generated_columns.test.ts`, `tests/integration/test_triggers.test.ts`.

**Tasks (generated columns):**

1. `ob_uuid` default: insert without specifying it; assert the row has a valid UUID; insert 10 rows, assert all UUIDs unique.
2. `source` generated column: insert with `metadata = '{"source":"human"}'`; assert `source = 'human'`. Insert with `metadata = '{}'`; assert `source IS NULL`. Update metadata to `{"source":"mcp"}`; assert `source` reflects (requires reselect since it's STORED).
3. `content_fingerprint`: insert `"hello\n"`; assert `content_fingerprint = encode(sha256('hello\n'::bytea), 'hex')` computed by the test in Deno.
4. `updated_at`: insert a row, capture `updated_at`; sleep 10 ms; UPDATE the row; re-read, assert new `updated_at > old`. Assert `created_at` unchanged.

**Tasks (triggers):**

1. Trigger fires on INSERT: insert `"\ufeffhello\r\n"`, assert stored `"hello\n"`.
2. Trigger fires on UPDATE: insert a canonical thought, UPDATE content to `"\ufeffhello\r\n"`, assert stored `"hello\n"`.
3. Trigger scoped to content: UPDATE a non-content column (e.g., `metadata`) and verify the canonicalization trigger's scope. The architecture's trigger says `BEFORE INSERT OR UPDATE OF content ON thoughts` — a metadata-only update should NOT re-run canonicalization (benign, but confirms the `OF content` clause is present).

### Phase 7 — Role Permission Tests

**File created:** `tests/integration/test_roles.test.ts`.

**Tasks:**

1. `memex_mcp` DELETE forbidden:
   - As `memex_mcp`, `DELETE FROM thoughts` → assert SQLSTATE 42501 (insufficient_privilege).
   - As `memex_mcp`, `DELETE FROM sync_log` → assert 42501.
2. `memex_mcp` SELECT allowed: `SELECT count(*) FROM thoughts` → succeeds.
3. `memex_mcp` INSERT allowed: `INSERT INTO thoughts (content) VALUES ('role-test')` → succeeds, row appears.
4. `memex_mcp` UPDATE allowed: `UPDATE thoughts SET metadata = '{"x":1}' WHERE content = 'role-test\n'` → succeeds.
5. `memex_mcp` can call `match_thoughts`: issue a `SELECT * FROM match_thoughts(<zero-vector>, 0.0, 5, '{}')` → succeeds without permission error (returns 0 rows fine).
6. `memex_sync` DELETE allowed: `DELETE FROM thoughts WHERE content = 'role-test\n'` → succeeds.
7. `memex_sync` all operations: spot-check INSERT/UPDATE/SELECT/DELETE on `thoughts`, `sync_log`, `thought_relations`, `sync_state`.
8. **Password propagation:** credentials for the two test roles come from `MEMEX_TEST_MCP_PASSWORD` and `MEMEX_TEST_SYNC_PASSWORD` env vars exported by `run-tests.sh`, defaulting to the hardcoded `memex_mcp_test_password` / `memex_sync_test_password` literals that migration 0009 sets.

### Phase 8 — sync_log Trigger Tests

**File created:** `tests/integration/test_sync_log.test.ts`.

**Tasks:**

1. Non-daemon INSERT:
   - `TRUNCATE sync_log`.
   - Insert a thought as `memex_test` (no session var set).
   - Assert `SELECT count(*), operation FROM sync_log` returns 1 row with operation `INSERT`, correct `thought_id`, `ob_uuid`.
2. Non-daemon UPDATE:
   - UPDATE the content of the thought from step 1.
   - Assert a second sync_log row with operation `UPDATE`.
3. Non-daemon DELETE (as `memex_sync`):
   - DELETE the thought.
   - Assert a third sync_log row with operation `DELETE`.
4. Daemon path:
   - `TRUNCATE sync_log`.
   - Open a psql session that runs `BEGIN; SET LOCAL app.sync_source = 'daemon'; INSERT INTO thoughts (content) VALUES ('daemon'); UPDATE thoughts SET metadata='{"k":1}' WHERE content='daemon\n'; DELETE FROM thoughts WHERE content='daemon\n'; COMMIT;` all in one `psql -c` (multi-statement).
   - Assert `SELECT count(*) FROM sync_log = 0`.
5. Mixed session safety: run a BEGIN block that omits the SET LOCAL, then another that sets it, in sequence; confirm only the non-daemon block creates sync_log rows.

**Execution detail:** `SET LOCAL` requires the statements to run inside the same transaction block. Use `psql <<EOF ... EOF` via stdin to submit one transaction; a single `psql -c "BEGIN; ...; COMMIT;"` also works.

### Phase 9 — match_thoughts Smoke Test

**File created:** `tests/integration/test_match_thoughts.test.ts`.

**Tasks:**

1. Construct two mock embedding vectors (1536-dim) deterministically in the test (e.g., `[0.1, 0.2, …]` and `[0.9, 0.8, …]`, L2-normalized).
2. INSERT two thoughts with distinct content and those embeddings.
3. `SELECT * FROM match_thoughts(<query>, 0.0, 10, '{}')` with the query equal to the first embedding.
4. Assert: two rows returned, first row has `similarity > second row's similarity`, first row's content matches the first thought's content.
5. This is a smoke test, not a search-quality test — its purpose is to verify 0001's `match_thoughts` function compiles and runs, not that HNSW is tuned correctly.

### Phase 10 — `tests/run-tests.sh` Extension and CI

**Files modified:** `tests/run-tests.sh`, `deno.json`.

**Tasks:**

1. Extend `run-tests.sh` per Section 3.6: add a `[run-tests] applying migrations` phase after readiness, invoke `./scripts/memex-migrate`, then split test runs into unit and integration phases.
2. Export `MEMEX_TEST_MCP_PASSWORD=memex_mcp_test_password` and `MEMEX_TEST_SYNC_PASSWORD=memex_sync_test_password`.
3. Update `deno.json` with `test:unit` and `test:integration` tasks while preserving the existing `test` task for backward compatibility.
4. Verify locally: `./tests/run-tests.sh` exits 0 from a clean clone. Exit code propagation still works (the Sprint 000 Round 1 rework on ERR trap must not regress).
5. Verify CI: push to a throwaway branch, confirm GitHub Actions runs the full flow within 10 minutes.
6. No changes to `tests/compose.yaml` are required.

### Phase 11 — Documentation

**Files modified:** `migrations/README.md` (created in Phase 1), `tests/README.md` (extended).

**Tasks:**

1. Finalize `migrations/README.md`: apply instructions, runner usage, failure recovery, additive-only rule link, test-password policy.
2. Extend `tests/README.md` with a new section "Integration tests": what runs in the integration phase, how to run just integration tests (`deno task test:integration` after manually bringing up compose and running the migrator), how to add new migrations and the accompanying test.

## 5. Verification Plan

### 5.1 Automated Checks

| # | Check | What It Validates | File | Executor |
|---|---|---|---|---|
| 1 | Runner applies 9 migrations from empty DB | Core success criterion: all 9 migrations apply, `schema_migrations` has 9 rows with checksums | `tests/integration/test_migrations_apply.test.ts` | Deno test |
| 2 | Runner is a no-op on rerun | Idempotency at runner level | `tests/integration/test_migrations_apply.test.ts` | Deno test |
| 3 | Runner detects checksum tampering | Protects against post-apply file edits | `tests/integration/test_migrations_apply.test.ts` | Deno test; uses `MEMEX_MIGRATE_DIR` override |
| 4 | Split 0001–0005 + 0006–0009 == single-pass | Order-independence within split points | `tests/integration/test_migrations_apply.test.ts` | Deno test; uses `MEMEX_MIGRATE_MAX` override |
| 5 | All 22 canonicalization fixtures produce expected output on INSERT | SQL trigger matches shared fixture corpus byte-for-byte | `tests/integration/test_canonicalization.test.ts` | Deno test |
| 6 | Canonicalization trigger fires on UPDATE of content | Not just INSERT path | `tests/integration/test_canonicalization.test.ts` | Deno test |
| 7 | `content_fingerprint` equals SHA-256 hex of canonical content | Generated column correctness | `tests/integration/test_generated_columns.test.ts` | Deno test |
| 8 | `ob_uuid` default populates with unique UUIDs | Migration 0002 | `tests/integration/test_generated_columns.test.ts` | Deno test |
| 9 | `source` generated column surfaces `metadata->>'source'` | Migration 0003 | `tests/integration/test_generated_columns.test.ts` | Deno test |
| 10 | `updated_at` trigger advances timestamp on UPDATE | Migration 0005 | `tests/integration/test_triggers.test.ts` | Deno test |
| 11 | Canonicalization trigger scoped to `OF content` | Metadata-only update does not re-canonicalize | `tests/integration/test_triggers.test.ts` | Deno test |
| 12 | `sync_log` gains a row for each non-daemon INSERT/UPDATE/DELETE | Migration 0007 positive path | `tests/integration/test_sync_log.test.ts` | Deno test |
| 13 | `sync_log` stays empty when `app.sync_source = 'daemon'` | Migration 0007 loop prevention | `tests/integration/test_sync_log.test.ts` | Deno test |
| 14 | `memex_mcp` DELETE on `thoughts` raises SQLSTATE 42501 | Deletion invariant | `tests/integration/test_roles.test.ts` | Deno test |
| 15 | `memex_mcp` DELETE on `sync_log` raises SQLSTATE 42501 | Deletion invariant, second table | `tests/integration/test_roles.test.ts` | Deno test |
| 16 | `memex_mcp` can SELECT, INSERT, UPDATE, and call `match_thoughts` | Read-write allow list | `tests/integration/test_roles.test.ts` | Deno test |
| 17 | `memex_sync` can DELETE from `thoughts` | Sync daemon full-control requirement | `tests/integration/test_roles.test.ts` | Deno test |
| 18 | `match_thoughts` function returns rows in similarity order | Migration 0001 function callable | `tests/integration/test_match_thoughts.test.ts` | Deno test |
| 19 | `./tests/run-tests.sh` runs migrator + unit + integration phases cleanly | End-to-end harness | `tests/run-tests.sh` | Shell smoke check in CI + local |
| 20 | Runner exits non-zero and leaks no partial DDL on a failing migration | Transactional wrapping | Hand-crafted `tests/integration/test_migrations_apply.test.ts` case that injects a deliberately broken SQL via `MEMEX_MIGRATE_DIR` override — a temp dir containing the first 4 real migrations plus a synthetic `0005_bad.sql` file that errors halfway | Deno test |
| 21 | CI parity unchanged | Sprint 000's GitHub Actions workflow still invokes `./tests/run-tests.sh` | `.github/workflows/test.yml` | Unchanged; no edit |

### 5.2 Manual Verification Steps

1. **Fresh clone, full harness.**
   ```bash
   ./tests/run-tests.sh
   ```
   **Expected:** Phases print `preflight` → `bringing up stack` → `waiting for readiness` → `applying migrations` → `running unit tests` → `running integration tests` → `tearing down` → `OK`. Exit 0.

2. **Inspect applied schema.**
   ```bash
   docker compose -p memex-test -f tests/compose.yaml up -d --wait
   ./scripts/memex-migrate
   docker compose -p memex-test -f tests/compose.yaml exec -T postgres \
     psql -U memex_test -d memex_test -c "SELECT version, substr(checksum,1,12) FROM schema_migrations ORDER BY version;"
   ```
   **Expected:** Nine rows, versions `0001_initial_schema` through `0009_add_roles`, each with a 12-char checksum prefix.

3. **Re-apply is a no-op.**
   ```bash
   ./scripts/memex-migrate
   ```
   **Expected:** Last line is `DONE: 0 applied this run, 9 already up-to-date`. Exit 0.

4. **Canonicalization spot-check.**
   ```bash
   docker compose -p memex-test -f tests/compose.yaml exec -T postgres \
     psql -U memex_test -d memex_test -c \
     $'INSERT INTO thoughts (content) VALUES (E\'\\uFEFFhello\\r\\n\\r\\n\') RETURNING content, content_fingerprint;'
   ```
   **Expected:** Returned `content` is `hello\n` (literal LF, no BOM, one trailing newline). `content_fingerprint` is the hex SHA-256 of `hello\n` (compute with `printf 'hello\n' | sha256sum` → `5891b5b522d5df086d0ff0b110fbd9d21bb4fc7163af34d08286a2e846f6be03`).

5. **Role permission check.**
   ```bash
   docker compose -p memex-test -f tests/compose.yaml exec -T postgres \
     env PGPASSWORD=memex_mcp_test_password psql -U memex_mcp -d memex_test -c "DELETE FROM thoughts;"
   ```
   **Expected:** `ERROR: permission denied for table thoughts` with SQLSTATE 42501.

6. **Daemon loop-prevention check.**
   ```bash
   docker compose -p memex-test -f tests/compose.yaml exec -T postgres \
     psql -U memex_test -d memex_test <<'SQL'
   TRUNCATE sync_log;
   BEGIN;
   SET LOCAL app.sync_source = 'daemon';
   INSERT INTO thoughts (content) VALUES ('daemon test');
   COMMIT;
   SELECT count(*) FROM sync_log;
   SQL
   ```
   **Expected:** Final count is `0`.

7. **Checksum tamper detection.**
   ```bash
   echo "-- tamper" >> migrations/0003_source_generated_column.sql
   ./scripts/memex-migrate
   echo "exit: $?"
   # Restore:
   git checkout migrations/0003_source_generated_column.sql  # or sed -i to remove last line
   ```
   **Expected:** Exit code 2. stderr contains `TAMPER: 0003_source_generated_column`.

8. **CI round-trip.** Push a throwaway branch, open a draft PR, watch GitHub Actions. **Expected:** Green within 10 minutes.

### 5.3 Regression Scenarios

Sprint 000 delivered a working test platform. Sprint 001 must not regress any of it.

| # | Sprint 000 behavior | Command | Expected |
|---|---|---|---|
| R1 | Smoke test unit suite still passes | `deno task test:unit` (after running compose up + migrate) | 0 failures; Sprint 000's smoke tests all succeed |
| R2 | `tests/run-tests.sh` preflight still fires | `./tests/run-tests.sh` with port 55432 pre-bound (`nc -l 55432 &`) | Runner fails fast with the port-availability error message |
| R3 | Compose config still validates | `docker compose -p memex-test -f tests/compose.yaml config` | Exit 0, valid output |
| R4 | Ctrl-C teardown still works | Start `./tests/run-tests.sh`, SIGINT during the migration phase | No `memex-test` containers remain per `docker compose ls` |
| R5 | Mock inference service still reachable | `curl -fsS http://127.0.0.1:58000/health` after compose up | Returns `{"status":"ok",…}` |
| R6 | Canonicalization fixture file unchanged | `git diff --stat tests/fixtures/canonicalization-cases.json` after Sprint 001 work | No diff (Sprint 001 consumes, does not modify) |
| R7 | CI workflow file unchanged | `git diff .github/workflows/test.yml` | No diff |
| R8 | ERR trap propagates exit codes | Inject a failing `deno test` and confirm `run-tests.sh` exits non-zero | Non-zero exit, logs printed |
| R9 | Mock inference healthcheck still works | `docker compose -p memex-test -f tests/compose.yaml ps` shows mock-inference as `healthy` | Status `healthy` (Sprint 000 follow-up installed wget) |

### 5.4 Existing Tests to Re-run

- `tests/unit/smoke.test.ts` — runs unchanged as part of the new `test:unit` task. Sprint 001 adds no dependency on its internal state.
- GitHub Actions workflow — unchanged, but must still go green on a push.

No existing tests require updating. Sprint 001 is purely additive to the test corpus.

## 6. Files Summary

### New Files
- `migrations/0001_initial_schema.sql`
- `migrations/0002_ob_uuid.sql`
- `migrations/0003_source_generated_column.sql`
- `migrations/0004_canonicalization_and_fingerprint.sql`
- `migrations/0005_updated_at.sql`
- `migrations/0006_thought_relations.sql`
- `migrations/0007_sync_log.sql`
- `migrations/0008_sync_state.sql`
- `migrations/0009_add_roles.sql`
- `migrations/README.md`
- `scripts/memex-migrate`
- `tests/integration/lib/psql.ts`
- `tests/integration/lib/db_reset.ts`
- `tests/integration/test_migrations_apply.test.ts`
- `tests/integration/test_canonicalization.test.ts`
- `tests/integration/test_generated_columns.test.ts`
- `tests/integration/test_triggers.test.ts`
- `tests/integration/test_sync_log.test.ts`
- `tests/integration/test_roles.test.ts`
- `tests/integration/test_match_thoughts.test.ts`

### Modified Files
- `tests/run-tests.sh` (phase additions only — no structural changes)
- `deno.json` (new `test:unit` and `test:integration` tasks alongside existing `test`)
- `tests/README.md` (new "Integration tests" section)

### Consumed, Unchanged
- `tests/compose.yaml`
- `tests/fixtures/canonicalization-cases.json`
- `.github/workflows/test.yml`
- `memex-architecture.md`

## 7. Definition of Done

- [ ] Nine files `migrations/0001_initial_schema.sql` … `migrations/0009_add_roles.sql` exist, each a faithful transcription of architecture Section 6.N with `IF NOT EXISTS` / `CREATE OR REPLACE` qualifiers for file-level idempotency.
- [ ] `migrations/README.md` documents manual apply, runner usage, failure recovery, additive-only rule, and test-password policy.
- [ ] `scripts/memex-migrate` exists, is executable, and implements apply / status / verify modes with SHA-256 checksum tracking.
- [ ] The runner accepts `MEMEX_MIGRATE_MAX` and `MEMEX_MIGRATE_DIR` env vars (test hooks) and documents them.
- [ ] The runner uses `psql --single-transaction --set ON_ERROR_STOP=1` to guarantee atomic per-migration apply.
- [ ] Running `./scripts/memex-migrate` on an empty test DB applies all 9 migrations and records 9 `schema_migrations` rows with checksums.
- [ ] Rerunning the runner against a fully-migrated DB prints `DONE: 0 applied this run, 9 already up-to-date` and exits 0.
- [ ] Tampering with any applied migration file causes the runner to exit 2 with a `TAMPER` message.
- [ ] `tests/integration/test_migrations_apply.test.ts` verifies fresh apply, no-op rerun, split apply equivalence, checksum tamper, and failed-migration rollback.
- [ ] `tests/integration/test_canonicalization.test.ts` asserts byte-identical output from the SQL trigger for all 22 fixtures on INSERT and at least 3 fixtures re-verified on UPDATE.
- [ ] `tests/integration/test_generated_columns.test.ts` verifies `ob_uuid`, `source`, `content_fingerprint`, and `updated_at` behaviors.
- [ ] `tests/integration/test_triggers.test.ts` verifies `canonicalize_thought_content` scoping (OF content) and `update_thoughts_updated_at` behavior.
- [ ] `tests/integration/test_sync_log.test.ts` verifies both non-daemon (log created) and daemon (log suppressed) paths for INSERT, UPDATE, and DELETE.
- [ ] `tests/integration/test_roles.test.ts` asserts `memex_mcp` cannot DELETE from `thoughts` or `sync_log`, can SELECT/INSERT/UPDATE/`match_thoughts`, and `memex_sync` has full control.
- [ ] `tests/integration/test_match_thoughts.test.ts` verifies `match_thoughts` callable and returns similarity-ordered results.
- [ ] `tests/integration/lib/psql.ts` and `tests/integration/lib/db_reset.ts` exist and are used by every integration test.
- [ ] `tests/run-tests.sh` gains an `applying migrations` phase and split unit/integration test phases, preserves Sprint 000's ERR trap behavior, and exits 0 from a clean clone.
- [ ] `deno.json` defines `test:unit`, `test:integration`, and preserves `test`.
- [ ] Sprint 000 smoke tests still pass (regression scenarios R1–R9 verified).
- [ ] The GitHub Actions workflow passes on a throwaway branch push within 10 minutes.
- [ ] `tests/README.md` gains an "Integration tests" section.
- [ ] `memex-architecture.md` is not modified.
- [ ] No `mcp-server/` or `sync-daemon/` directories are created.

## 8. Risks & Mitigations

| # | Risk | Why It Matters | Mitigation |
|---|---|---|---|
| 1 | Canonicalization SQL disagrees with the 22 fixtures on an edge case (e.g., empty string, single-newline) | Sprint 001's core validation would fail | Test loudly on every fixture; if disagreement surfaces, flag in sprint review — do not silently adjust either side. The fixture-vs-spec reconciliation is a cross-sprint correction, not a Sprint 001 scope creep |
| 2 | `psql -c` quoting corrupts binary fixture content in transit | False canonicalization failures | Use `pg_read_file` from a container-temp-file path written via `docker compose exec -T ... sh -c 'cat > /tmp/content.txt'` — bypasses all shell escaping |
| 3 | `CREATE ROLE` requires superuser and the runner is not a superuser | Migration 0009 fails | `memex_test` is the bootstrap user in `tests/compose.yaml`; verify it has CREATEROLE at the Postgres level. If not, either grant it in a one-time setup SQL before migration 0009 or run 0009 as the `postgres` superuser via an explicit user switch in the runner. Plan: verify upfront; the `POSTGRES_USER=memex_test` environment of the pgvector image makes it superuser-equivalent at database creation time |
| 4 | Role passwords set at migration time drift from test env vars | Role tests fail with authentication errors | Migration 0009 sets passwords unconditionally via `ALTER ROLE`; env vars default to the same literals; the drift case is caught immediately by the role tests |
| 5 | `gen_random_uuid()` not available on the pgvector image | Migration 0002 default clause fails | Pgvector/pgvector:pg16 ships PG 16, which has `gen_random_uuid` in core. If verification shows otherwise, add `CREATE EXTENSION IF NOT EXISTS pgcrypto` in 0002's first line. Verify in Phase 1. |
| 6 | `SET LOCAL app.sync_source` across multiple `psql -c` invocations loses scope | Daemon-path test gives false positives | Use a single `psql <<SQL ... SQL` heredoc so BEGIN/SET LOCAL/INSERT/UPDATE/DELETE/COMMIT run in one session. Asserted by the test's structure. |
| 7 | `CREATE INDEX ... USING hnsw` is slow on a freshly populated table | Fresh apply timing in CI | Migration 0001 creates the index on an empty table; build cost is microseconds. Later sprints populating the table will deal with HNSW rebuild cost when they get there. |
| 8 | Test DB drop/create blocked by lingering connections | `dropAndCreateTestDb` fails | Use `DROP DATABASE ... WITH (FORCE)` (PG 13+) to terminate active backends |
| 9 | Runner exit code ambiguity between Bash ERR trap and psql failures | Test harness can't distinguish check types | Runner uses distinct exit codes: 0 OK, 1 migration failed, 2 tamper, 3 prereq error. Documented in the script header. |
| 10 | Adding migration phase to `run-tests.sh` breaks Sprint 000's carefully-tuned ERR trap and exit-code propagation | Regression on R8 | New phase uses the same `set +e; command; rc=$?; set -e; if (( rc != 0 )); then ... fi` pattern as the existing `deno task test` block. Regression test R8 explicitly re-validates |
| 11 | `MEMEX_MIGRATE_DIR` override lets tests apply arbitrary SQL from temp dirs, potentially leaving test artifacts in migrations/ | Surprising side effects | The override only affects the runner's read path, never the repo's committed files. Tests use `Deno.makeTempDir` and copy real migrations into it; the test's `finally` block removes the temp dir |
| 12 | Colima arm64 normalize() produces different Unicode output than x86_64 Linux CI | Fixture mismatches in CI only | PG's `normalize()` is ICU-backed; ICU NFC is stable across architectures. Known-stable; if it flakes, add a targeted skip list with a follow-up sprint |

## 9. Dependencies

### Must Exist Before Sprint 001 Starts
- Sprint 000 complete, merged, and green on CI
- `tests/compose.yaml`, `tests/run-tests.sh`, `tests/fixtures/canonicalization-cases.json`, `tests/unit/smoke.test.ts`, `deno.json`, `.github/workflows/test.yml`
- Docker + Colima (or Docker Desktop), Deno installed locally
- `memex-architecture.md` Section 6 treated as the authoritative spec, unchanged

### Produced by Sprint 001 for Later Sprints
- Fully-migrated, role-scoped PostgreSQL schema available at `MEMEX_TEST_*` coordinates after `./tests/run-tests.sh` or `./scripts/memex-migrate` → consumed by Sprint 002 MCP server tests and every subsequent sprint
- `scripts/memex-migrate` reusable for future deployment scripting, schema-changing feature sprints, and operator hand-apply
- `tests/integration/lib/psql.ts` and `db_reset.ts` helpers reusable by Sprint 002+ integration tests
- `MEMEX_TEST_MCP_PASSWORD` and `MEMEX_TEST_SYNC_PASSWORD` env var conventions for role-scoped test connections
- The split `test:unit` / `test:integration` Deno task convention
- A precedent for integration tests that shell out to `psql` inside the Postgres container rather than introducing a Deno Postgres driver

## 10. Open Questions

All intent-doc open questions are answered decisively in Section 3.1. The questions below are items that surfaced during drafting but are explicitly out of Sprint 001's scope:

1. **Should `scripts/memex-migrate` grow a `--target <version>` flag?** The `MEMEX_MIGRATE_MAX` test hook hints at this. An operator-facing `--target` could be useful in future deployment work. Deferred — add when a deployment sprint needs it; for now, the env var is a test-only mechanism.

2. **Should migration files live under `db/migrations/` instead of `migrations/`?** The ROADMAP and intent doc both specify `migrations/` at repo root, so this draft commits to that. If a later sprint adds a separate sync-daemon schema or per-subsystem migrations, a nested layout could make sense. Not this sprint's concern.

3. **Should role passwords be loaded from a secrets file rather than hardcoded test literals in 0009?** Production deployment will need this. Sprint 001's hardcoded placeholders are deliberately test-only. The provisioning mechanism is a deployment-target concern (Mycofu, Docker, k8s), not a schema concern.

4. **Should `tests/integration/` gain a shared `beforeAll` fixture for truncation?** Deno's test runner supports `beforeAll` via `Deno.test.beforeAll` or test-step patterns. For Sprint 001 each test file does its own TRUNCATE in the first test step — simple and explicit. Could be DRYed up later.

5. **Should the sprint include a `pg_dump --schema-only` golden snapshot in-repo?** Would make schema drift from the architecture spec visible in PR diffs. Attractive but creates a maintenance burden (the snapshot must be regenerated on every migration edit). Deferred to a future sprint that explicitly adopts golden-schema testing.

6. **Should `match_thoughts` get a richer test beyond the smoke test in Phase 9?** Realistic HNSW validation would need thousands of vectors and property-based testing. Out of scope; the smoke test suffices to prove the function compiles and returns sane results.

7. **Should the runner support applying migrations to an arbitrary database (not just `MEMEX_TEST_DB_NAME`)?** Useful for future production deployment. The runner already reads all connection parameters from env vars, so the answer is essentially "yes, already supports it". No additional work for Sprint 001.

8. **Should Sprint 001 add a pre-commit hook that runs `./scripts/memex-migrate --verify` against a sample DB?** Nice to have; adds local friction. Deferred.

9. **Should the sync_log pruning job mentioned in architecture Section 6.7 be implemented here?** No — that's operational automation, not schema, and the architecture calls it a "scheduled job" which implies deployment infrastructure. Out of scope.
