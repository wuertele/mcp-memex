# Review: Sprint 001 - Round 1 (codex)

## Plan Adherence

Phases 1 through 5 are all present in the repo and the implementation order matches the sprint plan: `migrations/0001` through `0009` plus `migrations/README.md`, then `scripts/memex-migrate`, then `deno.json` and `tests/run-tests.sh`, then the Deno integration suite in `tests/integration/test_migrations.ts`. The migration SQL stays within the sprint scope and the additive-only rule from Architecture Section 5.4. The `memex_mcp` `sync_state` grant deviation is the correct one and should not be re-flagged.

What is incomplete is operability, not file presence. Phase 3 and Phase 4 were supposed to produce first-class runnable integration coverage, but the committed task path does not actually execute any integration tests: `deno.json:8` points Deno at `tests/integration/`, while the only file is `tests/integration/test_migrations.ts:1`, which does not match Deno's default `{*_,*.}test.{ts,...}` discovery glob. Even after that is fixed, the same task is still missing `--allow-write` for the suite's temp-dir and temp-file work. So the implementation exists, but the documented verification path is only partially complete.

## Implementation Quality

The SQL itself is strong. `migrations/0001_initial_schema.sql` through `migrations/0009_add_roles.sql` are a faithful transcription of Architecture Section 6, and `migrations/0009_add_roles.sql:9-12,23-25` matches the Section 6.9 grant matrix line-by-line, including the correct SELECT-only grant on `sync_state` and the deliberate absence of any `thought_relations` grant to `memex_mcp`. `migrations/README.md` also covers the manual apply path, runner usage, failure recovery, additive-only rule, and test-password policy the plan asked for.

The runner in `scripts/memex-migrate:1-284` is readable and mostly correct. It discovers `NNNN_*.sql` lexically, rejects gaps and duplicate versions, computes raw-byte SHA-256 checksums, validates stored checksums before new work, applies each migration in a single transaction, and cleanly separates exit codes 0/1/2/3. `MEMEX_MIGRATE_DIR` is read-only from the runner's perspective and a non-existent directory fails fast with exit 3. Apply-time `psql` failures all collapse to exit 1, which is a little coarse for transport/auth failures but still consistent enough for the current contract.

The integration test body is also well structured. `tests/integration/test_migrations.ts:226-238` uses fresh databases with `DROP DATABASE ... WITH (FORCE)`, the suite is a single `Deno.test` with awaited `t.step`s so execution stays serial, `tests/integration/test_migrations.ts:352-380` uses the byte-safe `pg_read_file` injection path correctly, and `tests/integration/test_migrations.ts:695-705` keeps `BEGIN`, `SET LOCAL`, writes, and `COMMIT` in one `psql` session so the daemon-suppression assertion is meaningful. The quality problems here are the task wiring around the suite, not the suite's internal structure.

## System Impact
### Callers and Consumers Traced

`scripts/memex-migrate` is consumed by `tests/integration/test_migrations.ts:256-274` through `runMigration()`. `tests/run-tests.sh:102-126` does not call the runner directly; it exports `MEMEX_TEST_DB_*`, the two role passwords, and `PSQL`, then invokes `deno task test:unit` and `deno task test:integration`. `PSQL` is therefore a shared contract between the Bash runner and the Deno helpers, and the Deno side additionally derives a container exec prefix from it for `pg_dump`, `/tmp/content.txt` writes, and role-boundary `psql` calls.

Migration-to-assertion mapping is uneven:

- `0001` is covered by fresh-apply, no-op rerun, and staged-vs-full schema checks, but `match_thoughts` is not executed.
- `0002` is only indirectly exercised because later insert/delete paths depend on `ob_uuid`, but there is no direct uniqueness/default assertion.
- `0003` has no direct runtime assertion for the `source` generated column.
- `0004` is intended to be covered well by canonicalization fixtures plus fingerprint assertions.
- `0005` is intended to be covered by the `updated_at` trigger assertion.
- `0006` has no direct runtime assertion for `thought_relations`.
- `0007` is intended to be covered well by `sync_log` emit and daemon-suppression assertions.
- `0008` has no direct runtime assertion for `sync_state`.
- `0009` has a live DELETE-boundary check, but the rest of the grant matrix is only statically reviewed.

Because of the Deno discovery bug, all of those intended runtime checks are still pending in practice.

### Invariants and Contracts Checked

Sprint 000 invariants look preserved. `tests/compose.yaml`, `tests/fixtures/canonicalization-cases.json`, and `.github/workflows/test.yml` are unchanged. The orchestrator already confirmed that the 10 Sprint 000 smoke tests still pass against the live stack, mock-inference stayed healthy, and the existing teardown/error-handling path still behaved correctly when the integration phase failed to load.

The additive-only rule from Architecture Section 5.4 holds across all nine migrations: CREATE EXTENSION, CREATE TABLE, ADD COLUMN, CREATE INDEX, CREATE OR REPLACE FUNCTION, CREATE TRIGGER, CREATE ROLE, and GRANT only. No destructive DDL or rollback scaffolding was introduced.

The runner contract is mostly correct in code. Exit 0 is success/no-op, exit 2 is checksum drift, exit 3 is prereq/setup failure, and exit 1 is apply-time failure. `MEMEX_MIGRATE_DIR`, `MEMEX_MIGRATE_MAX`, `PSQL`, and checksum validation are all implemented in the expected places. `migrations/0009_add_roles.sql:9-12,23-25` also matches Architecture Section 6.9 line-by-line: `memex_mcp` gets `SELECT, INSERT, UPDATE` on `thoughts`, `SELECT` on `sync_log` and `sync_state`, `USAGE, SELECT` on `thoughts_id_seq`, and `EXECUTE` on `match_thoughts`, with no `thought_relations` grant and no `DELETE`.

### Failure Modes

If a migration fails mid-apply, `scripts/memex-migrate:230-250` pipes the file plus the `schema_migrations` insert through a single `psql --single-transaction` call, captures the non-zero status under `set +e`, logs `failed version NNNN`, and exits 1. That gives the correct forward-only outcome: earlier versions remain applied, the failing version is not recorded, and partial work inside the failed migration transaction rolls back.

If `MEMEX_MIGRATE_DIR` points at a non-existent directory, `scripts/memex-migrate:135-148` exits 3 immediately. If `psql` returns non-zero during the preflight reads, the runner also exits 3. If `psql` returns non-zero during a migration apply for any reason, including connection/auth failures, the runner exits 1 and attributes it to the version being applied. That classification is slightly blunt, but it is at least deterministic.

`SET LOCAL app.sync_source = 'daemon'` is used correctly: `tests/integration/test_migrations.ts:695-705` keeps `BEGIN`, `SET LOCAL`, writes, and `COMMIT` inside one `psql` stdin session, so the session variable survives for the entire transaction.

There are two hidden failure paths the executor did not account for. First, once the discovery bug is fixed, the current `deno.json:8` task will still fail because the suite performs `Deno.makeTempDir`, `Deno.copyFile`, `Deno.writeTextFile`, and `Deno.remove` in `tests/integration/test_migrations.ts:288`, `:303`, `:489`, `:510`, `:522`, and `:554` without `--allow-write`. Second, the fresh-DB-per-scenario guarantee is environment-sensitive today: `tests/run-tests.sh:102-110` exports only `MEMEX_TEST_DB_*`, `tests/integration/test_migrations.ts:244-253` forwards the ambient environment into `runMigration()`, and `scripts/memex-migrate:90-118` prefers `PG*` over `MEMEX_TEST_DB_*`. A caller with `PGDATABASE` or `PGUSER` already exported can therefore make the runner target the wrong database.

### Regression Risk

R1 is verified: the orchestrator already ran the live Sprint 000 smoke suite and all 10 tests passed. R3 is verified because the compose stack still validates and came up cleanly. R5 and R9 are effectively verified by the live smoke run plus healthy compose services. R6 and R7 are verified because the fixture corpus and CI workflow are unchanged. R8 is verified by the orchestrator's confirmed failure-path behavior when the integration phase failed to load.

R2 and R4 are not actually verified in Round 1. The port-preflight code and signal trap remain unchanged in `tests/run-tests.sh:18-24` and `:66-73`, so the regression risk is modest, but those two scenarios were not re-exercised.

### Validation Gaps

The dominant gap is that none of the integration tests have run. `deno.json:8` asks Deno to discover tests under `tests/integration/`, but `tests/integration/test_migrations.ts:1` does not match Deno's default test filename glob. The practical effect is exactly what the orchestrator observed: `deno task test:integration` exits with `No test modules found`, so every Sprint 001 runner/schema assertion remains static review only.

That is not the only gap. After the file naming/wiring issue is fixed, the suite is still not runnable as wired because `test:integration` lacks `--allow-write`. The checksum-drift and bad-migration scenarios, plus their cleanup paths, will fail on Deno permissions before they can validate the runner.

Coverage is also thinner than the sprint narrative suggests even after those two wiring fixes. `source`, `thought_relations`, `sync_state`, and most of the `memex_mcp` grant matrix are not explicitly asserted at runtime in the current suite. Given the current code, those items are being accepted primarily on static review of the SQL, not on live evidence.

## Required Fixes
1. [P1] Fix the integration test discovery bug. `deno.json:8` currently relies on Deno's default directory glob, but `tests/integration/test_migrations.ts` does not match it, so no integration tests run at all. The two acceptable fixes are: rename the file to `tests/integration/migrations.test.ts`, or keep the filename and change `test:integration` to pass the file path explicitly. The rename is the cleaner option because it matches the existing `smoke.test.ts` convention.
2. [P2] Add `--allow-write` to the integration Deno task. The suite writes temp directories and temp files in `tests/integration/test_migrations.ts:288`, `:303`, `:489`, `:510`, `:522`, and `:554`, so the current `deno.json:8` task is under-permissioned and will still fail after the P1 fix.
3. [P3] Make the test harness deterministic with respect to `PG*` environment variables. Right now `tests/run-tests.sh:102-110` exports `MEMEX_TEST_DB_*`, but `tests/integration/test_migrations.ts:244-253` forwards the ambient environment and `scripts/memex-migrate:90-118` prefers `PG*`. A shell with `PGDATABASE` or `PGUSER` already set can bypass the intended per-scenario database and invalidate the isolation model. Either export matching `PG*` values in the harness or scrub/override them in `runMigration()`.

## Verdict
ISSUES_FOUND
