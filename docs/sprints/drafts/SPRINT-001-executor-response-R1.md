## Changes Made
- `tests/integration/test_migrations.ts` → `tests/integration/migrations.test.ts`: renamed the integration suite to match Deno's default `*.test.ts` discovery pattern; updated active rename references in `docs/sprints/SPRINT-001.md:24,178,380,420,458-469,634,663` and `ROADMAP.md:367`.
- `deno.json:8`: added `--allow-write` to `test:integration` so the temp-dir and temp-file integration scenarios can run under the task's permission set.
- `migrations/0009_add_roles.sql:5,19`, `tests/run-tests.sh:113-114`, `tests/integration/migrations.test.ts:43-46`, `migrations/README.md:82-86`: replaced the literal `'<placeholder>'` passwords with explicit disposable test literals and documented them as non-placeholder test credentials.
- `tests/run-tests.sh:107-111`, `tests/integration/migrations.test.ts:41-42,246-260`: exported and forwarded matching `PG*` values so ambient shell settings cannot redirect migrations away from the intended per-scenario database.
- `tests/integration/migrations.test.ts:704-705,755-756`: added the `SET LOCAL` transaction-scope comment at the daemon-suppression heredoc and relaxed the brittle `mcpDelete.code` assertion to `assert(mcpDelete.code !== 0)` while keeping the SQLSTATE `42501` check.

## Feedback Addressed
- `[P1]` Integration test discovery: fixed by renaming the suite to `tests/integration/migrations.test.ts` and updating active references in `docs/sprints/SPRINT-001.md:24,178,380,420,458-469,634,663` and `ROADMAP.md:367`.
- `[P2]` Missing integration write permission: fixed in `deno.json:8` by adding `--allow-write` to `test:integration`.
- `[P2]` Live rerun prerequisite work: the code-path fixes needed for the Round 2 live rerun are in place; Docker-backed execution itself is intentionally left to the orchestrator per task instruction.
- `[P3]` Placeholder role passwords: fixed in `migrations/0009_add_roles.sql:5,19`, `tests/run-tests.sh:113-114`, `tests/integration/migrations.test.ts:43-46`, and documented in `migrations/README.md:82-86`.
- `[P3]` Brittle role-boundary exit code: fixed in `tests/integration/migrations.test.ts:755-756`.
- `[P3]` Missing daemon-suppression comment: fixed in `tests/integration/migrations.test.ts:704-705`.
- `[P3]` `PG*` environment leakage: fixed in `tests/run-tests.sh:107-111` and `tests/integration/migrations.test.ts:246-260`.

## Recommendations Declined
- None. The only item not executed locally was the live Docker-backed rerun, which the orchestrator explicitly reserved for Round 2.

## Trade-Off Decisions
- Chose the reviewer-preferred deterministic export path instead of scrubbing ambient `PG*`: `tests/run-tests.sh:107-111` now exports matching `PG*` defaults, and `tests/integration/migrations.test.ts:246-260` aligns the child-process `PGDATABASE` with each scenario so a fixed runner export does not break fresh-database isolation.
- Chose the relaxed non-zero assertion instead of forcing a specific `psql` exit code: `tests/integration/migrations.test.ts:755-756` keeps the SQLSTATE `42501` check authoritative and avoids version-sensitive exit-code coupling.
- Added the future-proofing code comment at `tests/integration/migrations.test.ts:704` so the single-session `BEGIN`/`SET LOCAL` requirement stays attached to the heredoc that depends on it.

## Remaining Blockers
- None in code. The live Colima + Docker rerun is intentionally left to the orchestrator for Round 2.

## Static Validation After Changes
- `bash -n scripts/memex-migrate` → no output, exit 0.
- `bash -n tests/run-tests.sh` → no output, exit 0.
- `deno check tests/integration/migrations.test.ts` → `Check tests/integration/migrations.test.ts`, exit 0.
- `grep -r test_migrations .` → matches remained only in historical draft/review docs under `docs/sprints/drafts/`; no code or active runtime paths still referenced the old filename.
- `python3 -c 'import json; json.load(open("deno.json"))'` → no output, exit 0.
