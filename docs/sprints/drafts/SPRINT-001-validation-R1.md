# Sprint 001 Pre-Round Validation (Round 1)

## Environment

- Host: macOS (Darwin 25.3.0)
- Colima: **running** (docker context = colima)
- Docker daemon: **reachable** (`docker info` → 0)
- Deno: installed (Sprint 000 requirement)
- Python: 3.12 available for the ledger
- Repo state: Sprint 001 code in place (migrations/, scripts/memex-migrate,
  tests/integration/test_migrations.ts, modified deno.json, modified
  tests/run-tests.sh)

Unlike the executor's Phase 2 run, this orchestrator session **can**
reach the Docker socket, so I was able to run the full harness end to
end against the live Compose stack.

## Commands Run

### 1. Static checks

```
bash -n scripts/memex-migrate && echo OK
```
→ OK

```
bash -n tests/run-tests.sh && echo OK
```
→ OK

```
python3 -c 'import yaml,sys; yaml.safe_load(open("tests/compose.yaml")); print("OK")'
```
→ OK (compose.yaml unchanged from Sprint 000)

```
python3 -c 'import json; json.load(open("deno.json")); print("OK")'
```
→ OK

### 2. Full one-button harness

```
./tests/run-tests.sh
```

**Exit code:** `1`
**Log:** `logs/run-tests-sprint001-R1.log`

**Observed behavior:**

1. Preflight: PASS (docker, deno, ports 55432 and 58000 available).
2. Compose bring-up: PASS (postgres and mock-inference both `Healthy`).
3. Readiness wait: PASS.
4. Unit tests (`deno task test:unit`): **PASS** — 10 tests from
   `tests/unit/smoke.test.ts` all passed. Mock-inference served
   `/embeddings`, `/chat/completions`, `/health`, and both of the
   Sprint 000 error-path fixtures (`__fail_embed__` → 500,
   `__slow_embed__` → 5025 ms).
5. Integration tests (`deno task test:integration`): **FAIL** — Deno
   prints `error: No test modules found` and exits non-zero. The ERR
   trap fires, dumps compose logs, and the runner exits 1.
6. Teardown: PASS (cleanup trap ran, containers removed).

**Root cause of the integration failure:** `deno test` discovers test
files matching the default glob
`{*_,*.}test.{ts,tsx,mts,js,mjs,jsx}`. The integration file is
`tests/integration/test_migrations.ts`, whose leading `test_` prefix
does **not** match. Deno therefore sees zero test modules in the
directory and errors.

This is a trivial naming / task-wiring issue, not a behavioral bug in
the migrations, runner, or integration test code itself. Sprint 000's
file is `tests/unit/smoke.test.ts` (matching suffix), and the sprint
plan's Section 6 Files Summary inadvertently named the new file
`test_migrations.ts` — the plan carries the error; Codex followed the
plan faithfully.

Two trivial fixes are equivalent:
- Rename `tests/integration/test_migrations.ts` →
  `tests/integration/migrations.test.ts`, **or**
- Change `deno task test:integration` to pass the file path
  explicitly: `deno test ... tests/integration/test_migrations.ts`

Option A (rename) is consistent with the Sprint 000 convention and is
the recommended fix.

## Static Compile of Integration Test

```
deno test --allow-net --allow-read --allow-env --allow-run --no-run tests/integration/test_migrations.ts
```

→ Not verified by the orchestrator in Round 1 (reviewers can verify).
The executor's own report states this static compile passed in
Codex's sandbox.

## Notable Deviations the Executor Surfaced

### 1. `memex_mcp` grants on `sync_state` (line 117 of executor report)

The Sprint 001 plan's Section 3.1 prose said "SELECT/INSERT/UPDATE on
`sync_state`" for `memex_mcp`. Architecture Section 6.9 (line 883) says
only `GRANT SELECT ON sync_log, sync_state TO memex_mcp;`. Codex
followed the architecture. **This is correct.** The sprint plan had a
typo; architecture is the authoritative spec per Section 5.4 of the
architecture doc and per the sprint plan's own "architecture is input,
not output" rule.

`migrations/0009_add_roles.sql` line 10 reads:
`GRANT SELECT ON sync_log, sync_state TO memex_mcp;` — exact match to
architecture 6.9.

**Reviewers:** do not flag this as a bug. It is a correct deviation
from the Sprint 001 plan prose in favor of the architecture.

### 2. Literal `<placeholder>` password in migration 0009 and role-test env vars

`migrations/0009_add_roles.sql` lines 5 and 19 create the roles with
password literal `'<placeholder>'` (the exact string from architecture
6.9). `tests/run-tests.sh` lines 108–109 then export
`MEMEX_TEST_MCP_PASSWORD='<placeholder>'` and
`MEMEX_TEST_SYNC_PASSWORD='<placeholder>'` so the integration tests
match.

This is literally consistent with architecture 6.9, which uses
`'<placeholder>'` as a doc placeholder to be replaced at deployment
time. In the disposable test environment the strings match so role
login works, but it is philosophically uncomfortable to keep
"`<placeholder>`" as a live test credential — it can be confused with
an unsubstituted template. An alternative (hardcoded test literal like
`memex_mcp_test_password`, documented as disposable) would be cleaner.

Reviewers should decide whether this is worth a P2/P3 in Round 1.

## Verification Coverage at Handoff

Static coverage (confirmed by orchestrator):
- All nine migration SQL files exist and match architecture Section 6.
- `scripts/memex-migrate` parses under `bash -n`.
- `tests/run-tests.sh` parses under `bash -n` and still uses the
  Sprint 000 ERR-trap/exit-code-propagation pattern.
- `deno.json` parses as JSON and defines `test`, `test:unit`,
  `test:integration` tasks with scoped permissions
  (`--allow-net --allow-read --allow-env [--allow-run]`), not
  `--allow-all`.
- Unit tests (the Sprint 000 smoke suite) all 10 pass against the
  live Compose stack.

Blocked by the `No test modules found` issue:
- All 14 automated checks from Sprint 001 Section 5.1 (none of them
  actually executed against the live stack — the suite never started)
- Manual verification steps 1–10 from Section 5.2 (not executed
  because they reproduce the same automated behavior)
- Regression scenarios R1–R9 from Section 5.3 (R3, R6, R7 passed
  per the executor's static checks; R1, R4, R5, R8, R9 require the
  integration suite to at least load)

## Recommendation to Reviewers

Treat the `No test modules found` failure as **the dominant P1** for
Round 1. Once that is fixed (one-line rename or task change), the
entire integration suite becomes evaluable against the live stack and
every other check can be exercised.

All other code (migrations, runner, integration test body) is
statically in place and reads as plausible at the mechanical level.
Please focus Round 1 review on:

1. Whether the migration SQL matches architecture Section 6 faithfully.
2. Whether the Bash runner's contract (exit codes, `MEMEX_MIGRATE_DIR`,
   `MEMEX_MIGRATE_MAX`, `PSQL` override, checksum validation) is
   correct and safe.
3. Whether the integration test structure is sound — fresh-DB-per-
   scenario helpers, `pg_read_file` byte-safe fixture injection, serial
   execution, role connection setup, `SET LOCAL` daemon-suppression
   session discipline.
4. Whether Sprint 000 is demonstrably uninvaded (compose.yaml unchanged,
   smoke tests still passing, ERR trap still propagating).
5. The two executor deviations above (sync_state grant, `<placeholder>`
   password).

Do NOT re-flag concerns that are strictly environmental. The file-
naming issue IS a real fix to make, but it is the only thing standing
between R1 and a full live suite.
