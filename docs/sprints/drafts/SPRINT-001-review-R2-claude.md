# Review: Sprint 001 - Round 2 (claude)

## Plan Adherence

All six Round 1 required fixes landed at the expected surface, and no
scope drift is visible outside the rework targets (`migrations/`,
`scripts/memex-migrate`, `tests/`, `deno.json`, the single
`ROADMAP.md` line update, and `migrations/README.md`).

Fix-by-fix confirmation:

1. **[P1] Rename** — `tests/integration/migrations.test.ts` exists;
   `tests/integration/test_migrations.ts` no longer present. The
   filename now matches Deno's default test glob and the Sprint 000
   `tests/unit/smoke.test.ts` convention. `ROADMAP.md:367` updated to
   reference the new filename.

2. **[P2] `--allow-write`** — `deno.json:8` adds `--allow-write` to
   `test:integration` only. `test:unit` at `deno.json:7` remains
   `--allow-net --allow-read --allow-env` with no write flag, so the
   unit suite stays narrowly scoped as required.

3. **[P3] Password literal consistency** — all three locations agree
   byte-for-byte on `memex_mcp_test_password` /
   `memex_sync_test_password`:
   - `migrations/0009_add_roles.sql:5,19`
   - `tests/run-tests.sh:113-114`
   - `tests/integration/migrations.test.ts:43-46` (defaults)
   - `migrations/README.md:80-86` documents the policy explicitly
     stating these are not placeholder values and not deployment
     credentials.
   Grep across the repo finds zero remaining `<placeholder>` literals
   in non-doc code (architecture doc text is untouched, correctly).

4. **[P3] Role-boundary exit-code assertion** —
   `tests/integration/migrations.test.ts:755` now uses
   `assert(mcpDelete.code !== 0)` instead of
   `assertEquals(mcpDelete.code, 1)`. Line 756 retains the
   authoritative `assertMatch(mcpDelete.stderr, /42501/)` check. The
   assertion is now version-independent while still gating both
   non-zero exit and the SQLSTATE 42501 signal on stderr. Meaningful
   coverage preserved.

5. **[P3] Session-scope comment** —
   `tests/integration/migrations.test.ts:704` carries the comment
   `// SET LOCAL is transaction-scoped, so this must stay one psql
   session or the test becomes a false-positive.` immediately above
   the heredoc at line 709. Useful and specific.

6. **[P3] PG* determinism** — executor applied *both* (a) and (b)
   from the feedback, which is the most defensive posture:
   - **(a)** `tests/run-tests.sh:107-111` exports `PGHOST`, `PGPORT`,
     `PGDATABASE`, `PGUSER`, `PGPASSWORD` using bash parameter
     expansion from the `MEMEX_TEST_DB_*` values exported immediately
     above at lines 102-106. Byte-for-byte match is guaranteed by
     construction.
   - **(b)** `tests/integration/migrations.test.ts:255-259`
     (`migrationEnv()`) explicitly overrides `PGHOST`, `PGPORT`,
     `PGUSER`, `PGPASSWORD`, `PGDATABASE` in the child process env for
     every `runMigration()` call, so even if an operator invokes
     `deno task test:integration` directly with stray `PG*` in their
     shell, the per-scenario fresh database targeting remains
     deterministic.
   Both the automated runner path and the manual invocation path are
   covered.

## Implementation Quality

The rework is surgical. No unrelated edits are visible in the focused
files, and the Round 1 fixes are applied at exactly the locations the
feedback specified. The double-application of the PG* fix (both the
shell export and the child-env override) is a small but welcome
belt-and-suspenders choice for a test harness that multiple reviewers
will invoke in mixed-shell environments.

The `migrations/README.md` documentation paragraph is short, factual,
and explicitly contradicts the architecture doc's "placeholders
replaced at deployment time" phrasing for the Sprint 001 test
environment, which is correct: those are two different layers and
the README is now the authoritative source for the test fixtures.

## System Impact

### Callers and Consumers Traced

- `deno task test:integration` → `tests/integration/migrations.test.ts`
  (new filename, matched by default glob).
- `tests/run-tests.sh` → exports full `MEMEX_TEST_DB_*` +
  matching `PG*` + test role passwords → invokes unit then
  integration tasks.
- `scripts/memex-migrate` → inherits child env from `runMigration()`
  in the test, which now always passes deterministic `PG*` values.
- `ROADMAP.md:367` one-line reference update to the new filename.
  No other ROADMAP edits.

### Invariants and Contracts Checked

- Unit test permission scope unchanged (`deno.json:7`).
- Integration test permission scope additively extended with
  `--allow-write` only (`deno.json:8`).
- SQLSTATE 42501 remains the authoritative role-boundary check.
- Password literals are consistent across the migration file, the
  shell exports, the test defaults, and the documentation.
- `SET LOCAL app.sync_source='daemon'` heredoc stays single-session
  and is now commented against accidental future splitting.

### Failure Modes

No new failure modes introduced by the rework. The rework surface is
narrow and each change is a strict improvement over Round 1.

### Regression Risk

- Sprint 000 smoke test path unaffected: `tests/unit/smoke.test.ts`
  remains under the unchanged `test:unit` task.
- `tests/run-tests.sh` additions at lines 107-111 are pure exports;
  they do not touch compose bring-up, preflight, teardown, or the
  ERR trap.
- No migration files mutated in-place; `0009_add_roles.sql` was the
  only migration touched, and only for the two password literals.

### Validation Gaps

None beyond what Round 2 validation already exercised. The
orchestrator's Round 2 run confirmed 10 unit tests and 18 integration
steps across all 6 scenarios (full-apply, staged-apply,
checksum-drift, bad-migration, behavior, role-boundary) green
against the live Colima + Docker stack. Every Section 5.1 automated
check is now verified.

## Required Fixes

None.

## Verdict
PASS
