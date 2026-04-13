# Review: Sprint 001 - Round 2 (codex)

## Plan Adherence

All six Round 1 items are addressed in the current repo state.

- The integration suite was renamed to `tests/integration/migrations.test.ts`, and the active sprint-plan / roadmap references now point at the new filename (`docs/sprints/SPRINT-001.md:24,178,458-469`, `ROADMAP.md:367-370`).
- `deno.json` adds `--allow-write` only to `test:integration`, while `test:unit` stays unchanged (`deno.json:6-8`).
- The password-literal follow-up is implemented in the migration, harness, integration defaults, and migration README (`migrations/0009_add_roles.sql:5,19`, `tests/run-tests.sh:113-115`, `tests/integration/migrations.test.ts:43-46`, `migrations/README.md:80-86`).
- The role-boundary assertion and daemon-suppression future-proofing both landed in the expected test locations (`tests/integration/migrations.test.ts:704-756`).
- The PG* determinism fix is present in both the harness export path and the per-scenario child-runner env path (`tests/run-tests.sh:102-115`, `tests/integration/migrations.test.ts:246-260`).

No material scope drift showed up in runtime code. The only surrounding changes I found were the expected filename-reference updates in the sprint docs and roadmap.

## Implementation Quality

The rework is correct and internally consistent.

- `tests/integration/` now contains only `migrations.test.ts`, so Deno discovery reaches the suite without special task wiring.
- `test:integration` is now permissioned for the temp-dir/temp-file scenarios, and `test:unit` did not pick up that broader permission (`deno.json:7-8`).
- The three runtime touchpoints for the new test credentials agree exactly: migration SQL creates `memex_mcp` / `memex_sync` with `memex_mcp_test_password` / `memex_sync_test_password` (`migrations/0009_add_roles.sql:5,19`), the harness exports those same literals (`tests/run-tests.sh:113-114`), and the integration suite defaults match them (`tests/integration/migrations.test.ts:43-46`). `migrations/README.md:80-86` documents the choice as explicit disposable test credentials, not placeholders.
- The role-boundary assertion is now version-independent without weakening the check. `assert(mcpDelete.code !== 0)` still requires a failing client exit, and `assertMatch(mcpDelete.stderr, /42501/)` keeps the permission-denial path authoritative (`tests/integration/migrations.test.ts:737-756`).
- The daemon-suppression comment is attached directly to the single-session heredoc that depends on `SET LOCAL` transaction scope, which is the right place to future-proof the test (`tests/integration/migrations.test.ts:704-714`).
- The PG* leakage fix is correctly targeted. The harness exports deterministic `PG*` values for the one-button path (`tests/run-tests.sh:102-111`), while `migrationEnv()` overwrites `PGDATABASE` and the rest of the runner connection env per scenario before launching `scripts/memex-migrate` (`tests/integration/migrations.test.ts:246-260`). The runner itself still preserves its documented manual contract of `PG*` first, `MEMEX_TEST_DB_*` fallback second (`scripts/memex-migrate:90-117`), so manual invocation behavior was not broken.

I also ran lightweight local checks against the current tree:

- `bash -n scripts/memex-migrate` → pass
- `bash -n tests/run-tests.sh` → pass
- `deno check tests/integration/migrations.test.ts` → pass

## System Impact

### Callers and Consumers Traced

- `deno task test` still chains `test:unit` then `test:integration` (`deno.json:6`).
- `tests/run-tests.sh` remains the only one-button harness entrypoint and still preserves the Sprint 000 unit/integration exit propagation (`tests/run-tests.sh:117-139`).
- `tests/integration/migrations.test.ts` still owns all migration-runner and live-schema assertions; the rename did not change the suite shape, only Deno discoverability.
- `scripts/memex-migrate` kept its existing operator-facing env contract; the determinism fix was applied in the harness and child-process env construction rather than by changing runner precedence.

### Invariants and Contracts Checked

- `--allow-write` appears only on `test:integration`, not on `test:unit` (`deno.json:7-8`).
- The role-password literal is consistent across migration SQL, harness exports, and integration defaults (`migrations/0009_add_roles.sql:5,19`, `tests/run-tests.sh:113-114`, `tests/integration/migrations.test.ts:43-46`).
- The role-boundary test still checks the actual permission contract via SQLSTATE `42501` (`tests/integration/migrations.test.ts:755-756`).
- The daemon-path test still depends on one transaction in one psql session, and the new comment accurately captures that constraint (`tests/integration/migrations.test.ts:704-714`).
- Sprint 000 behavior stayed intact: the unit task permissions are unchanged, and the provided Round 2 validation shows all 10 unit tests and all 18 integration steps green.

### Failure Modes

- The prior discovery failure is closed by the filename rename.
- The prior Deno permission failure is closed by the integration-task `--allow-write`.
- The prior harness nondeterminism from ambient `PG*` values is closed for both `./tests/run-tests.sh` and `runMigration()` child invocations.
- I did not find a new failure mode introduced by the password swap, the relaxed role-boundary exit assertion, or the session-scope comment.

### Regression Risk

Low. The changes are narrow, they stay inside the rework surface plus doc-reference updates, and the provided Round 2 live run already exercised the full one-button path successfully.

### Validation Gaps

No new material gaps. The only remaining unexecuted items are the same unchanged Sprint 000 regression scenarios the orchestrator already called out as low risk: R2 (pre-bound port) and R4 (SIGINT teardown).

## Required Fixes
None.

## Verdict
PASS
