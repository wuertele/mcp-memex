# Review: Sprint 001 - Round 1 (gemini)

## Plan Adherence
- **Phases:** The executor completed all five phases in order.
- **Tasks:** All tasks were addressed. The schema was implemented as additive-only, and the migration runner follows the specified contract.
- **Deviations:** The executor correctly prioritized the Architecture Section 6.9 schema for `memex_mcp` sync_state grants over the conflicting prose in Sprint 001 Section 3.1. This was confirmed as correct by the orchestrator.

## Implementation Quality
- **Migrations:** The nine SQL migrations are faithful to the architecture specification. `0009_add_roles.sql` correctly uses `DO` blocks for idempotency in the cluster-scoped role creation.
- **Runner (`scripts/memex-migrate`):** The runner is robustly implemented with `set -euo pipefail`. It correctly handles lexical ordering, gap/duplicate detection, SHA-256 checksum validation, and transactional application. It provides clear exit codes (0/1/2/3) and supports necessary test hooks (`MEMEX_MIGRATE_DIR`, `MEMEX_MIGRATE_MAX`, `PSQL`).
- **Integration Tests:** The test suite in `tests/integration/test_migrations.ts` is comprehensive, covering fresh apply, staged apply, checksum drift, failure modes, and behavioral assertions. The use of `pg_read_file` for byte-safe fixture injection is correctly implemented.
- **Deno Configuration:** `deno.json` correctly defines tasks for unit and integration testing with appropriate permissions.

## System Impact
### Callers and Consumers Traced
- `tests/run-tests.sh` correctly exports environment variables and handles the `PSQL` override for the migration runner.
- The aggregator task `deno task test` correctly chains unit and integration tests.

### Invariants and Contracts Checked
- **Additive-only Rule:** The migrations follow the Section 5.4 additive-only mandate.
- **Grant Matrix:** The `memex_mcp` and `memex_sync` roles are granted exactly the permissions specified in Architecture Section 6.9.
- **Deletion Invariant:** The role-boundary tests verify that `memex_mcp` cannot delete, while `memex_sync` can.

### Failure Modes
- **Runner Robustness:** The runner handles SQL errors within a transaction and refuses to proceed if checksum drift is detected in previously applied migrations.
- **Session Discipline:** The integration tests use single-session heredocs for `SET LOCAL app.sync_source = 'daemon'` to ensure the session variable persists across the write operation.

### Regression Risk
- **Sprint 000 Smoke Tests:** The existing unit tests (`tests/unit/smoke.test.ts`) are preserved and continue to pass against the live stack.
- **ERR Trap:** The `run-tests.sh` script preserves the `ERR` trap and cleanup logic from Sprint 000.

### Validation Gaps
- **[P1] Integration Test Discovery:** The file `tests/integration/test_migrations.ts` does not match Deno's default test discovery glob (e.g., `*.test.ts` or `*_test.ts`). Consequently, `deno task test:integration` fails to find any tests, meaning the integration suite has not actually executed against the live stack.

## Required Fixes
1. [P1] **Rename Integration Test File:** Rename `tests/integration/test_migrations.ts` to `tests/integration/migrations.test.ts` to match Deno's default test discovery pattern. Alternatively, update the `test:integration` task in `deno.json` to point directly to the file path.
2. [P2] **Test Password Literal:** Consider replacing the literal `'<placeholder>'` password in `0009_add_roles.sql` and `run-tests.sh` with a dedicated test-only password (e.g., `'memex_test_password'`) to avoid confusion with unsubstituted templates.

## Verdict
ISSUES_FOUND

Severity: [P1] = blocking, [P2] = important. The blocking issue is a naming convention that prevents the integration tests from running. Once addressed, the implementation is solid.

---

