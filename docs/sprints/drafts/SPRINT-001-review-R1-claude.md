# Review: Sprint 001 - Round 1 (claude)

## Plan Adherence

All five Implementation Plan phases are present and in order.

- Phase 1: `migrations/0001`–`0009` + `migrations/README.md` are in place and transcribe architecture Section 6.1–6.9 verbatim. `0009` is the only file with DO-block `CREATE ROLE` guards; every other file is plain declarative SQL exactly as the plan requires.
- Phase 2: `scripts/memex-migrate` is a `set -euo pipefail` Bash script with documented exit codes (0/1/2/3), `MEMEX_MIGRATE_DIR`, `MEMEX_MIGRATE_MAX`, `PSQL` override, SHA-256 checksumming, gap/duplicate detection, `--single-transaction` per migration, and `PG*`→`MEMEX_TEST_DB_*` fallback.
- Phase 3: `deno.json` defines `test`, `test:unit`, `test:integration` with scoped permissions. `tests/run-tests.sh` exports `MEMEX_TEST_*`, `MEMEX_TEST_{MCP,SYNC}_PASSWORD`, and `PSQL`, preserves the Sprint 000 preflight/trap/teardown shape, and now runs unit then integration with the same `set +e`/capture/`set -e` pattern.
- Phase 4: Fresh-apply, no-op rerun, staged-vs-full schema equivalence, checksum drift, and synthetic bad-migration coverage all present in one aggregate `Deno.test` with per-scenario fresh databases.
- Phase 5: Canonicalization on INSERT + UPDATE across all 22 fixtures, fingerprint, `updated_at`, `sync_log` emit, daemon suppression, and role boundary all implemented.

No phases skipped. Nothing partial. The single deviation (architecture's `sync_state` SELECT-only grant vs. sprint plan 3.1 prose) is correct per orchestrator note 1 and is not re-flagged.

## Implementation Quality

**Migrations.** All nine files match architecture Section 6 on a line-by-line read:
- 6.1 verbatim, including `IF NOT EXISTS` clauses that Section 6.1 already spec'd.
- 6.2 verbatim (`ADD COLUMN ob_uuid ... NOT NULL DEFAULT gen_random_uuid()`, unique index).
- 6.3 verbatim generated column + index.
- 6.4 verbatim canonicalization function, BEFORE INSERT OR UPDATE OF content trigger, generated fingerprint column, index.
- 6.5 verbatim updated_at column, function, trigger, index.
- 6.6 verbatim `thought_relations`.
- 6.7 verbatim `sync_log` table, function, trigger.
- 6.8 verbatim `sync_state`.
- 6.9 DO-block guarded `CREATE ROLE` for both roles (cluster-scope exception) + unconditional GRANTs exactly matching the architecture's grant matrix. `memex_mcp` has no `thought_relations` grant; `sync_state` grant is SELECT-only, matching architecture. No drift beyond the authorized DO-block exception.

**Runner.** Exit codes are correctly partitioned: `fail_prereq` → 3, `fail_tamper` → 2, `apply_migration` SQL failure → 1, success → 0. `MEMEX_MIGRATE_DIR` override is read-only (discovery walks `${MIGRATE_DIR}` via `find -maxdepth 1`, and writes only go to `schema_migrations` in the live DB). `MEMEX_MIGRATE_MAX` uses bash `[[ "${version}" > "${MIGRATE_MAX}" ]]`, which is locale-aware string comparison — safe here because all versions are fixed-width four-digit prefixes. Checksum computed over raw file bytes via `sha256sum` (Linux) or `shasum -a 256` (macOS). `schema_migrations` existence is preflighted via `to_regclass` before reading applied rows, so a fresh DB does not error. Per-migration apply pipes `cat file; printf INSERT` into `psql --single-transaction` with `ON_ERROR_STOP=1`, so the `schema_migrations` row is committed in the same transaction as the DDL — or rolled back together on failure. `PSQL` override is parsed via a `read -r -a` split; correct for space-separated argv.

**Integration test structure.** Fresh-DB-per-scenario via `withFreshDatabase` with `DROP DATABASE ... WITH (FORCE)` teardown in `finally`. Suite is a single `Deno.test` with sequential `t.step`s, so serial execution is guaranteed without relying on Deno's default concurrency. `pg_read_file('/tmp/content.txt')::text` byte-safe injection path is implemented correctly — the raw bytes go to the container via `docker compose exec -T postgres sh -c 'cat > /tmp/content.txt'` and the piped stdin is a Uint8Array. Daemon suppression test runs `BEGIN; SET LOCAL ...; writes; COMMIT;` in a single `psql` stdin heredoc, preserving session scope. Checksum-drift test copies to `Deno.makeTempDir()`, mutates in the temp copy, and cleans up in `finally` — the committed `migrations/` tree is untouched by design.

Quality issue worth flagging: `parseCommand` splits shell tokens with a regex that handles quoted/unquoted whitespace but does not strip the quote characters for escaped strings inside double quotes, and silently passes `part.slice(1,-1)` for simple-quoted tokens. For the `PSQL` values the harness will realistically set, that is fine. No fix required.

## System Impact

### Callers and Consumers Traced

- `scripts/memex-migrate` consumers: `tests/run-tests.sh` (env export path only, does not invoke directly), `tests/integration/test_migrations.ts` via `runMigration()`. No other consumers.
- `MEMEX_TEST_MCP_PASSWORD` / `MEMEX_TEST_SYNC_PASSWORD`: exported by `tests/run-tests.sh`, read by `tests/integration/test_migrations.ts`. No other consumer, and no other file in the repo references those names. Safe to introduce.
- `PSQL` env var: consumed by both the Bash runner (`PSQL_OVERRIDE`) and the Deno integration suite (`PSQL_COMMAND`). The Deno side parses the value and also derives `POSTGRES_EXEC_PREFIX` by stripping the trailing `postgres psql` tokens via `PSQL_COMMAND.slice(0, -2)`. This tight coupling between the env var's exact token shape and the derivation is a future-fragility hazard but functionally correct for the committed default.
- Migration SQL → integration assertions mapping:
  - `schema_migrations(version, checksum)` → `readSchemaMigrations` row checks in fresh/no-op/staged/checksum/bad tests.
  - `thoughts.content` canonicalization trigger → `canonicalization on insert` + `on update` steps across 22 fixtures.
  - `thoughts.content_fingerprint` generated column → `fingerprint generation` step.
  - `thoughts.updated_at` trigger → `updated_at trigger` step.
  - `sync_log` trigger → `sync log emit path` and `sync log daemon suppression` steps.
  - `memex_mcp` / `memex_sync` grants → `role boundary` step.
  - `thought_relations` (migration 0006): created and exists, but there is no integration assertion against it. This is deliberate — the sprint scope says the table is added for future use. Not a gap.
  - `match_thoughts` function: no direct execution test in Sprint 001 per the plan's Open Question #5 (Sprint 002 picks it up). The `memex_mcp` EXECUTE grant on it is not individually verified either, only implicitly via "GRANT EXECUTE ON FUNCTION match_thoughts TO memex_mcp" being present in 0009 text.

### Invariants and Contracts Checked

- **Sprint 000 ERR trap preserved.** `tests/run-tests.sh` still has `trap handle_err ERR`, `set -E`, and the `set +e` / capture / `set -e` pattern around `deno task test:unit` and `deno task test:integration`. Orchestrator R1 confirmed ERR trap still fires on the integration failure.
- **Exit code propagation.** Both the unit and integration blocks capture exit codes and re-exit with them; matches Sprint 000's pattern.
- **`compose.yaml`, fixture file, CI workflow untouched.** Orchestrator confirmed R3/R6/R7 green in R1. I re-read the directory listing and confirmed no changes to `tests/compose.yaml`, `tests/fixtures/canonicalization-cases.json`, or `.github/workflows/test.yml`.
- **Architecture Section 5.4 additive-only.** Every migration is a pure ADD: CREATE EXTENSION, CREATE TABLE, ADD COLUMN, CREATE INDEX, CREATE OR REPLACE FUNCTION, CREATE TRIGGER, CREATE ROLE, GRANT. No DROP, no ALTER...DROP, no column type change. Rule held.
- **Architecture Section 6.9 grant matrix line by line.** `migrations/0009_add_roles.sql` lines 9–12 for memex_mcp:
  - `GRANT SELECT, INSERT, UPDATE ON thoughts` ✓
  - `GRANT SELECT ON sync_log, sync_state` ✓ (SELECT-only, correct per architecture)
  - `GRANT USAGE, SELECT ON SEQUENCE thoughts_id_seq` ✓
  - `GRANT EXECUTE ON FUNCTION match_thoughts` ✓
  - No `thought_relations` grant ✓
  - No `DELETE` anywhere ✓
  
  Lines 23–25 for memex_sync: `GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES`, `USAGE, SELECT ON ALL SEQUENCES`, `EXECUTE ON ALL FUNCTIONS`. ✓
- **DO-block exception only in 0009.** Confirmed by reading every migration — 0001 uses `CREATE TABLE IF NOT EXISTS` and `CREATE INDEX IF NOT EXISTS` because Section 6.1 spec already spells those out (this is NOT drift); 0002-0008 are plain declarative. 0009 is the only file with `DO $$ BEGIN IF NOT EXISTS ... $$`. Contract held.

### Failure Modes

- **Mid-apply failure under `set -euo pipefail`.** `apply_migration` wraps the piped psql call in `set +e` / capture `status` / `set -e`, so a SQL failure in the middle of applying (say) migration 0005 will log `failed version 0005` to stderr and `exit 1` cleanly without being swallowed by the ERR trap. Verified by the synthetic bad-migration integration test. Good.
- **`MEMEX_MIGRATE_DIR` pointing at a non-existent directory.** `discover_migrations` checks `[[ ! -d "${MIGRATE_DIR}" ]]` and calls `fail_prereq` → exit 3. Good.
- **`MEMEX_MIGRATE_DIR` with a gap or duplicate prefix.** `discover_migrations` tracks `expected=1`, checks both gap (version != expected_version) and duplicate (find_migration_index >= 0) and fails with exit 3. Good.
- **psql failing for a non-SQL reason (network/permission/OOM).** `apply_migration` does not distinguish SQL failure from connection failure; both exit 1. Sprint 001 plan lists exit 1 = "migration failed during apply", which is a slight over-claim, but the runner logs `failed version $version` to stderr in every case, so operators can still diagnose. Not a fix; worth noting.
- **`SET LOCAL app.sync_source='daemon'` session scope.** The daemon-suppression test uses a single `psql` heredoc (`runPsqlScript` with `BEGIN; SET LOCAL ...; write; COMMIT;`). `SET LOCAL` is transaction-scoped, so this is correct. If anyone later splits the BEGIN/SET LOCAL/write/COMMIT into separate `-c` invocations the test would give a false-positive pass — a code comment at the heredoc would help future-proof it, but not blocking.
- **Role-test password escaping for the literal `<placeholder>` string.** In `tests/run-tests.sh`, the exports use single quotes (`'<placeholder>'`), so the shell does not expand `<` or `>`. In `tests/integration/test_migrations.ts`, the value is passed via Deno.Command argv (`-e`, `PGPASSWORD=${TEST_MCP_PASSWORD}`) with no shell in between. That path is safe. In `migrations/0009_add_roles.sql`, the password is a literal single-quoted SQL string `'<placeholder>'`, safe. The philosophical concern raised in the validation log about the placeholder being confusable with an unsubstituted template is real (see P3 below) but not a functional bug.
- **Checksum drift test cleanup.** `withFreshDatabase` runs `dropDatabase` in a `finally` and the temp-dir setup uses its own `try/finally` with `Deno.remove(tempDir, { recursive: true })`. The temp dir is a `Deno.makeTempDir()` result, not the committed `migrations/` tree, and the test only ever writes into it, so the real migrations file is never mutated. Confirmed by reading `copyMigrationsToTemp` — it uses `Deno.copyFile` from `MIGRATIONS_DIR` into the temp dir, no in-place edits. Good.
- **psql exit code from `-c 'DELETE FROM thoughts;'` as `memex_mcp`.** The role-boundary test asserts `mcpDelete.code === 1`. psql's actual exit code for a `-c` command that fails with a permission error (without `ON_ERROR_STOP`) is, in practice, `1` on modern psql, but this is a brittle assertion. If the installed psql version returns `3` here the test will fail even though the SQL behavior is correct. See P3.

### Regression Risk

- **Sprint 000 smoke: GREEN.** Orchestrator R1 confirmed all 10 smoke tests passed against the live stack.
- **ERR trap: GREEN.** Orchestrator R1 confirmed the ERR trap fired on the integration failure and dumped compose logs.
- **R1–R9 walk:**
  - R1 (smoke suite passes): ✓ confirmed by R1 orchestrator run.
  - R2 (preflight port-bound error): not executed. Low risk — `tests/run-tests.sh` still has `assert_port_available 55432 58000` unchanged.
  - R3 (compose config validates): ✓ confirmed by executor static check + orchestrator bring-up.
  - R4 (Ctrl-C teardown): not executed. Low risk — `trap handle_signal INT TERM` and `cleanup` unchanged.
  - R5 (mock inference reachable): ✓ implicitly confirmed by smoke suite calling `/embeddings` and `/chat/completions`.
  - R6 (fixtures unchanged): ✓ executor confirmed no diff.
  - R7 (CI workflow unchanged): ✓ executor confirmed no diff.
  - R8 (ERR trap propagation): ✓ confirmed — ERR trap fired and runner exited 1 when integration failed.
  - R9 (mock-inference healthcheck): ✓ confirmed by R1 orchestrator run (both containers reported Healthy).

  None regressed; five explicitly green, four unexecuted but low-risk.

### Validation Gaps

- **All 14 automated checks in Section 5.1.** Check 13 (smoke) and Check 14 (one-button up to the integration phase) ran; Checks 1–12 did not execute against the live stack because `deno test tests/integration/` found zero test modules and exited before running anything. After the P1 rename, Checks 1–12 become exercisable — every one of them is implemented in `test_migrations.ts` and the bodies match the Section 5.1 intent. I found no check that is structurally missing beyond the glob issue.
- **Manual verification steps 5.2 (1–10).** None executed. Not blocking for R1 since they reproduce the automated checks.
- **Section 7 Definition of Done lines marked `tests/integration/test_migrations.ts uses isolated per-scenario databases`, `Integration tests run serially`, and every behavioral bullet** remain structurally satisfied in code but not runtime-verified until P1 is fixed.
- **`match_thoughts` runtime execution by `memex_mcp`.** The EXECUTE grant is in 0009 text and Sprint 002 covers the runtime. Sprint 001 does not exercise it — consistent with Open Question #5.
- **pg_hba.conf compatibility for memex_mcp/memex_sync TCP auth from inside the container.** Not pre-verified. Open Question #2 explicitly deferred this to live execution. After the P1 fix, this is the highest risk remaining to actual check 12 passing.

## Required Fixes

1. **[P1] Rename `tests/integration/test_migrations.ts` → `tests/integration/migrations.test.ts`.** `deno test` with a directory argument uses the default glob `{*_,*.}test.{ts,...}`, which does not match a file starting with `test_`. As a result, `deno task test:integration` reports `No test modules found` and exits non-zero before any of Checks 1–12 can execute. One-line rename (preferred, matches `tests/unit/smoke.test.ts` convention) or, equivalently, change `deno.json` so `test:integration` passes the file path explicitly: `deno test --allow-net --allow-read --allow-env --allow-run tests/integration/test_migrations.ts`. The rename is the cleaner fix.

2. **[P2] Re-run the full live integration suite after the P1 fix.** None of Checks 1–12 have been verified against live PostgreSQL. Once renamed, `./tests/run-tests.sh` must be run and shown to pass end to end, with particular attention to Check 12 (role boundary), which is the one place where an undocumented `pg_hba.conf` default could bite (per the plan's Open Question #2). If the `memex_mcp` / `memex_sync` TCP login inside the container is rejected by `pg_hba.conf` md5/scram rules, that's a real R1 follow-up — cannot be ruled out from static inspection.

3. **[P3] Consider replacing the literal `'<placeholder>'` role passwords with an explicit disposable test literal** (for example `memex_mcp_test` / `memex_sync_test`) in `migrations/0009_add_roles.sql` and the two `tests/run-tests.sh` exports. The current value is architecturally consistent with Section 6.9's doc placeholder, but in the live test environment it looks like an unsubstituted template and will trip up any future reviewer who greps the repo for `<placeholder>` expecting provisioning breakage. Not blocking; it's cosmetic defense against a future foot-gun.

4. **[P3] Tighten the role-boundary exit-code assertion.** `assertEquals(mcpDelete.code, 1)` relies on psql's exit code for a `-c` command whose SQL statement failed with SQLSTATE 42501. The SQLSTATE match via `assertMatch(mcpDelete.stderr, /42501/)` is the authoritative check; the `code === 1` assertion is redundant and slightly brittle across psql versions. Either relax to `assert(mcpDelete.code !== 0)` or add `-v ON_ERROR_STOP=1` so the exit code is deterministically `3`.

5. **[P3] Add a one-line comment at the daemon-suppression heredoc** noting that `SET LOCAL` is transaction-scoped and the BEGIN/SET LOCAL/write/COMMIT must stay in a single psql session or the test becomes a false-positive. Cheap future-proofing against a well-meaning refactor.

## Verdict
ISSUES_FOUND
