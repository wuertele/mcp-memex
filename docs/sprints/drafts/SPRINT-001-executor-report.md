## Tasks Completed

- Phase 1: created `migrations/` with `0001` through `0009` plus `migrations/README.md`, transcribing Section 6 into executable SQL and applying the role-creation DO-block exception only in `0009_add_roles.sql`.
- Phase 2: implemented `scripts/memex-migrate` as a non-interactive Bash runner with lexical discovery, gap/duplicate rejection, checksum validation, `MEMEX_MIGRATE_DIR`, `MEMEX_MIGRATE_MAX`, `PSQL` override support, and distinct exit codes `0/1/2/3`.
- Phase 3: updated `deno.json` to expose `test:unit`, `test:integration`, and aggregate `test`, and updated `tests/run-tests.sh` to export runner/role env vars and execute unit then integration phases while preserving the Sprint 000 trap/teardown shape.
- Phase 4: added migration-runner integration coverage in `tests/integration/test_migrations.ts` for fresh apply, no-op rerun, staged apply equivalence, checksum drift, and synthetic bad-migration failure.
- Phase 5: extended `tests/integration/test_migrations.ts` with behavioral schema coverage for canonicalization, fingerprinting, `updated_at`, `sync_log`, daemon suppression, and role-boundary checks using the required container-local `pg_read_file` fixture injection path.
- Added `docs/sprints/drafts/SPRINT-001-BLOCKERS.md` when the sandbox blocked Docker-backed validation.

## Files Changed

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
- `deno.json`
- `tests/run-tests.sh`
- `tests/integration/test_migrations.ts`
- `docs/sprints/drafts/SPRINT-001-BLOCKERS.md`
- `docs/sprints/drafts/SPRINT-001-executor-report.md`

## Verification Checks Implemented

1. Fresh migration apply
   Implemented in `tests/integration/test_migrations.ts` step `fresh migration apply`.
   Lives in the `full-apply scenario` using `memex_it_full_apply`.
   Result when run: implemented; live execution blocked in this sandbox. Static compile passed via `deno test --allow-net --allow-read --allow-env --allow-run --no-run tests/integration/test_migrations.ts`.
2. No-op rerun
   Implemented in `tests/integration/test_migrations.ts` step `no-op rerun`.
   Compares `schema_migrations` rows before and after a second runner invocation.
   Result when run: implemented; live execution blocked in this sandbox. Static compile passed.
3. Checksum drift detection
   Implemented in `tests/integration/test_migrations.ts` step `checksum drift detection`.
   Uses `Deno.makeTempDir()` + `MEMEX_MIGRATE_DIR` and mutates a copied applied file.
   Result when run: implemented; live execution blocked in this sandbox. Static compile passed.
4. Staged-vs-full schema equivalence
   Implemented in `tests/integration/test_migrations.ts` step `staged-vs-full schema equivalence`.
   Uses `MEMEX_MIGRATE_MAX=0005` plus normalized `pg_dump --schema-only --no-owner --no-privileges`.
   Result when run: implemented; live execution blocked in this sandbox. Static compile passed.
5. Synthetic bad-migration apply failure
   Implemented in `tests/integration/test_migrations.ts` step `synthetic bad-migration apply failure`.
   Uses a temp migration directory containing `0001`-`0004` plus `0005_bad.sql`.
   Result when run: implemented; live execution blocked in this sandbox. Static compile passed.
6. Canonicalization on insert
   Implemented in `tests/integration/test_migrations.ts` step `canonicalization on insert`.
   Uses `insertThoughtWithContent()` and validates all 22 shared fixtures byte-for-byte.
   Result when run: implemented; live execution blocked in this sandbox. Static compile passed.
7. Canonicalization on update
   Implemented in `tests/integration/test_migrations.ts` step `canonicalization on update`.
   Uses `updateThoughtContent()` and validates the same 22 fixtures on the update path.
   Result when run: implemented; live execution blocked in this sandbox. Static compile passed.
8. Fingerprint generation
   Implemented in `tests/integration/test_migrations.ts` step `fingerprint generation`.
   Compares DB `content_fingerprint` with Deno `crypto.subtle.digest("SHA-256", ...)`.
   Result when run: implemented; live execution blocked in this sandbox. Static compile passed.
9. `updated_at` trigger
   Implemented in `tests/integration/test_migrations.ts` step `updated_at trigger`.
   Confirms `created_at` stability and `updated_at` change after a delayed update.
   Result when run: implemented; live execution blocked in this sandbox. Static compile passed.
10. Sync log emit path
   Implemented in `tests/integration/test_migrations.ts` step `sync log emit path`.
   Verifies `INSERT`, `UPDATE`, and `DELETE` rows in `sync_log` with matching thought id.
   Result when run: implemented; live execution blocked in this sandbox. Static compile passed.
11. Sync log daemon suppression
   Implemented in `tests/integration/test_migrations.ts` step `sync log daemon suppression`.
   Runs `BEGIN` / `SET LOCAL app.sync_source = 'daemon'` / writes / `COMMIT` in one `psql` session.
   Result when run: implemented; live execution blocked in this sandbox. Static compile passed.
12. Role boundary
   Implemented in `tests/integration/test_migrations.ts` step `role boundary`.
   Connects separately as `memex_mcp` and `memex_sync` using the placeholder passwords.
   Result when run: implemented; live execution blocked in this sandbox. Static compile passed.
13. Sprint 000 smoke regression
   Preserved in `tests/unit/smoke.test.ts`; wired as first-class `deno task test:unit` in `deno.json` and invoked separately in `tests/run-tests.sh`.
   Result when run: live smoke execution blocked in this sandbox. Static compile passed via `deno test --allow-net --allow-read --allow-env --no-run tests/unit/smoke.test.ts`.
14. One-button orchestration
   Implemented in `tests/run-tests.sh`.
   Keeps Sprint 000 preflight/trap/teardown structure and adds separate unit/integration phases plus env exports.
   Result when run: executed in this sandbox and failed at Docker preflight because the sandbox cannot reach the Colima socket. Output recorded below under `Validation Run`.

## Verification Gaps

- Automated checks `1` through `13` were implemented but could not be executed live here because this session cannot connect to the Docker daemon socket at `unix:///Users/dave/.colima/default/docker.sock`.
- Manual verification steps from Sprint 001 section `5.2`:
  - Steps `1` through `8` and `10` could not be executed in this sandbox because each requires live `docker compose up`, `docker compose exec`, or a running disposable stack.
  - Step `9` (`./tests/run-tests.sh`) was executed; it failed during preflight with `Docker not reachable - start Colima with 'colima start' or open Docker Desktop`.
- Regression scenarios from Sprint 001 section `5.3`:
  - `R3` passed locally: `docker compose -p memex-test -f tests/compose.yaml config` exited `0`.
  - `R6` passed locally: `git diff --stat tests/fixtures/canonicalization-cases.json` produced no diff.
  - `R7` passed locally: `git diff --stat .github/workflows/test.yml` produced no diff.
  - `R1`, `R2`, `R4`, `R5`, `R8`, and `R9` require a live Compose stack or Docker-backed harness behavior and could not be executed in this sandbox.
- Live migration-application validation from Phases 2 through 5 remains pending on a Docker-capable session.

## Validation Run

```text
[run-tests] preflight
[run-tests] Docker not reachable - start Colima with 'colima start' or open Docker Desktop

[exit-code]=1
```

## Open Blockers

- Docker-backed validation is blocked in this execution environment. `docker compose up` and other daemon-backed operations fail with `permission denied while trying to connect to the Docker daemon socket at unix:///Users/dave/.colima/default/docker.sock`.
- Because approval escalation is unavailable in this session, I could not bypass the sandbox restriction to run the disposable PostgreSQL + mock-inference stack.

## Deviations From Plan

- Implementation order matched the sprint phases. The only verification deviation is environmental: live Compose-backed execution could not be completed in this sandbox.
- For `0009_add_roles.sql`, I followed `memex-architecture.md` Section `6.9` exactly for the `memex_mcp` grant matrix (`GRANT SELECT ON sync_log, sync_state TO memex_mcp;`). This takes precedence over conflicting prose in Sprint 001 section `3.1` that mentions `INSERT/UPDATE` on `sync_state`.
