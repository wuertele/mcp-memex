# Review Feedback - Round 1

## Validation Results

See `docs/sprints/drafts/SPRINT-001-validation-R1.md` for the full
orchestrator validation record. Summary:

- Preflight, compose bring-up, and Sprint 000 smoke tests (all 10) all
  **PASS** against a live Colima + Docker stack.
- `deno task test:integration` **FAILS** with `No test modules found`
  because `tests/integration/test_migrations.ts` does not match
  Deno's default test discovery glob.
- ERR trap fires correctly, compose logs dump, runner exits 1,
  teardown runs. Sprint 000 regression behavior intact.
- The executor's deviation on `memex_mcp` `sync_state` grants (SELECT
  only, per architecture Section 6.9) is **correct**. Not flagged.

## Reviewer Verdict Breakdown

| Reviewer | Verdict |
|---|---|
| Claude | ISSUES_FOUND |
| Codex  | ISSUES_FOUND |
| Gemini | ISSUES_FOUND |

All three reviewers converged on the same dominant P1.

## Consensus Issues (Raised by Multiple Reviewers)

### [P1] Integration test file name does not match Deno's default test glob

**Reporters:** Claude, Codex, Gemini (all three)

**Where:** `tests/integration/test_migrations.ts`

**Problem:** `deno test` with a directory argument uses the default
glob `{*_,*.}test.{ts,tsx,mts,js,mjs,jsx}`. A filename that *starts*
with `test_` does not match. As a result, `deno task test:integration`
reports `No test modules found` and exits non-zero before any of the
12 integration checks in Sprint 001 Section 5.1 (checks 1–12) can run.

**Fix (recommended):** Rename
`tests/integration/test_migrations.ts` →
`tests/integration/migrations.test.ts`. This matches the existing
Sprint 000 convention (`tests/unit/smoke.test.ts`).

**Alternative:** Keep the filename and update `deno.json` task
`test:integration` to pass the file path explicitly:
`deno test --allow-net --allow-read --allow-env --allow-run --allow-write tests/integration/test_migrations.ts`.

The rename is cleaner.

## Agent-Specific Issues

### From Codex

#### [P2] `deno task test:integration` lacks `--allow-write`

**Where:** `deno.json` line 8

**Problem:** After the P1 rename fix, the integration suite will
actually load and try to run. At that point it will hit a second
wall: `tests/integration/test_migrations.ts` performs `Deno.makeTempDir`,
`Deno.copyFile`, `Deno.writeTextFile`, and `Deno.remove` at lines
288, 303, 489, 510, 522, and 554 as part of the checksum-drift and
synthetic bad-migration scenarios. Without `--allow-write` on the
Deno task, every scenario that manipulates a temp migrations
directory will fail at a permission prompt.

**Fix:** Update `deno.json` task `test:integration` to include
`--allow-write` in its permission set. The unit task does not need
this addition — it is integration-suite-specific.

#### [P3] `PG*` environment variables can bypass per-scenario isolation

**Where:** `tests/run-tests.sh` lines 102–110, `tests/integration/test_migrations.ts`
lines 244–253, `scripts/memex-migrate` lines 90–118

**Problem:** `tests/run-tests.sh` exports `MEMEX_TEST_DB_*` but never
unsets or overrides `PGDATABASE`, `PGUSER`, `PGPASSWORD`, etc. The
runner's env-resolution order is `PG*` first, `MEMEX_TEST_DB_*`
second. A shell with `PGDATABASE` or `PGUSER` already set in the
operator's environment will therefore silently bypass the per-scenario
fresh database and could target an unexpected database.

**Fix:** Either (a) have `tests/run-tests.sh` explicitly export the
matching `PG*` values alongside `MEMEX_TEST_DB_*` so the runner's
environment is deterministic, or (b) have `runMigration()` in the
Deno helper scrub `PG*` from the environment it hands to the child
process. (a) is simpler; (b) is more defensive. Either is fine.

### From Claude

#### [P2] Re-run the full live suite after the P1 and P2 fixes

This is a process ask, not a code fix. After the renames/permissions
are applied, the orchestrator will re-run `./tests/run-tests.sh` end
to end in Round 2 validation. Round 2 specifically needs to confirm:

- All 12 integration-suite checks execute and pass
- Check 12 (role boundary) works against the live pgvector image's
  `pg_hba.conf` (this is the plan's Open Question #2 — not
  pre-verified by the orchestrator, and Round 2 is where it either
  works or surfaces a real follow-up)
- All 9 regression scenarios (R1–R9) end up green

Executor: you do not need to act on this directly beyond making the
P1 and P2 fixes. The orchestrator handles the re-run.

#### [P3] Replace literal `'<placeholder>'` role passwords with an explicit disposable test literal

**Where:** `migrations/0009_add_roles.sql` lines 5 and 19,
`tests/run-tests.sh` lines 108–109

**Problem:** The current implementation uses the exact string
`'<placeholder>'` as the role password in both the migration and the
env exports. This is literally consistent with architecture Section
6.9, but it looks like an unsubstituted template and will trip up any
future reviewer who greps the repo for `<placeholder>` expecting
provisioning breakage.

**Fix:** Change both occurrences in `0009_add_roles.sql` to an explicit
disposable literal like `'memex_mcp_test_password'` /
`'memex_sync_test_password'`, and change the corresponding exports in
`tests/run-tests.sh` to match. Document the decision in
`migrations/README.md` (the test-password policy paragraph).

Not blocking. Defensive against a future foot-gun.

#### [P3] Tighten the role-boundary exit-code assertion

**Where:** The role-boundary `t.step` in `tests/integration/test_migrations.ts`
(around the `mcpDelete.code === 1` assertion)

**Problem:** `assertEquals(mcpDelete.code, 1)` relies on psql's exit
code for a `-c` command whose SQL statement failed with SQLSTATE
42501. Modern psql returns `1` in this case, but it's brittle across
psql versions. The authoritative check is the `assertMatch(..., /42501/)`
against stderr.

**Fix:** Either relax to `assert(mcpDelete.code !== 0)` (preferred —
it keeps the exit-code gate without the version-specific value), or
add `-v ON_ERROR_STOP=1` to the psql invocation so the exit code is
deterministically `3` on statement failure.

#### [P3] Add a one-line comment at the daemon-suppression heredoc

**Where:** The `sync_log` daemon-suppression `t.step` in
`tests/integration/test_migrations.ts` (around lines 695–705)

**Problem:** `SET LOCAL app.sync_source='daemon'` is
transaction-scoped. The test's BEGIN/SET LOCAL/writes/COMMIT must
stay in a single psql session or the test becomes a false-positive.
A future refactor that splits the heredoc into separate `-c`
invocations would silently break the assertion.

**Fix:** Add a one-line comment at the heredoc making the session-
scope requirement explicit. Cheap future-proofing.

## Contradictions

None. All three reviewers agree on the shape of the fixes. The only
variation is coverage: Codex caught the `--allow-write` gap and the
`PG*` leakage that Claude and Gemini missed.

## Required Next Actions (ordered)

1. **[P1]** Rename `tests/integration/test_migrations.ts` →
   `tests/integration/migrations.test.ts`.
2. **[P2]** Add `--allow-write` to `deno.json` task `test:integration`.
3. **[P3]** Replace literal `'<placeholder>'` role passwords with a
   disposable test literal in `migrations/0009_add_roles.sql` and the
   matching exports in `tests/run-tests.sh`. Update
   `migrations/README.md`.
4. **[P3]** Relax or strengthen the role-boundary exit-code
   assertion so it is not version-specific.
5. **[P3]** Add a one-line comment at the daemon-suppression heredoc
   noting the `SET LOCAL` transaction-scope requirement.
6. **[P3]** Address the `PG*` env var leakage by either exporting
   matching `PG*` values in `tests/run-tests.sh` or scrubbing them
   in `runMigration()`.
7. After all fixes: run `bash -n scripts/memex-migrate` and
   `bash -n tests/run-tests.sh` to confirm syntax is still valid.
8. Write
   `docs/sprints/drafts/SPRINT-001-executor-response-R1.md`
   documenting every change with file:line citations.

The orchestrator will re-run `./tests/run-tests.sh` against the live
stack after the rework and record results in
`docs/sprints/drafts/SPRINT-001-validation-R2.md`.

## Source Review Files

- `docs/sprints/drafts/SPRINT-001-review-R1-claude.md` (ISSUES_FOUND)
- `docs/sprints/drafts/SPRINT-001-review-R1-codex.md` (ISSUES_FOUND)
- `docs/sprints/drafts/SPRINT-001-review-R1-gemini.md` (ISSUES_FOUND)
