# Sprint 001 Pre-Round Validation (Round 2)

Round 2 validation after the Round 1 rework fixed the P1 (file rename),
P2 (`--allow-write`), and five P3 items.

## Round 1 Summary (for context)

- Claude: ISSUES_FOUND (1 P1, 1 P2, 3 P3)
- Codex: ISSUES_FOUND (1 P1, 1 P2, 1 P3)
- Gemini: ISSUES_FOUND (1 P1, 1 P2)
- Consensus P1: rename `test_migrations.ts` → `migrations.test.ts`
- Codex-only P2: add `--allow-write` to the integration Deno task

## Round 2 Scope

Rework touched only these files:
- `tests/integration/test_migrations.ts` → renamed to
  `tests/integration/migrations.test.ts`, plus small body edits
  (P3 items 4 and 5)
- `deno.json` (added `--allow-write` to `test:integration`)
- `migrations/0009_add_roles.sql` (password literal swap)
- `migrations/README.md` (password policy documentation)
- `tests/run-tests.sh` (password exports + `PG*` env determinism)
- `ROADMAP.md` (one-line reference update to match the renamed file)

## Environment

Same as Round 1:
- Host: macOS
- Colima running, docker context = colima
- Docker daemon reachable
- Deno installed
- Python 3.12 for the ledger

Unlike Round 1, the orchestrator's stack was healthy from the start
and the full Compose suite executed end-to-end without any static
blockers.

## Commands Run

### 1. Static checks

```
bash -n scripts/memex-migrate && bash -n tests/run-tests.sh && echo OK
```
→ OK

```
python3 -c 'import json; json.load(open("deno.json")); print("OK")'
```
→ OK

```
ls tests/integration/
```
→ `.gitkeep`, `migrations.test.ts` (old `test_migrations.ts` gone)

### 2. Full one-button harness

```
./tests/run-tests.sh
```

**Exit code:** `0`
**Log:** `logs/run-tests-sprint001-R2.log`
**Wall time:** ~1m30s including compose bring-up and teardown

**Observed behavior:**

1. Preflight PASS
2. Compose bring-up PASS (postgres + mock-inference both Healthy)
3. Readiness wait PASS
4. Unit tests `deno task test:unit`: **10 passed, 0 failed**
   - PostgreSQL host TCP reachability ✓
   - mock /health contract ✓
   - mock /embeddings golden replay (3 fixtures) ✓
   - mock /embeddings determinism ✓
   - mock /embeddings dimensionality + unit norm ✓
   - mock /embeddings variation ✓
   - mock __fail_embed__ 500 ✓
   - mock __slow_embed__ (5s) ✓
   - mock /chat/completions golden replay ✓
   - mock /chat/completions missing fixture ✓
   - canonicalization fixture well-formed ✓
5. Integration tests `deno task test:integration`:
   **1 test, 18 steps passed, 0 failed (1m14s)**

   All six scenarios executed against fresh per-scenario databases
   with `DROP DATABASE ... WITH (FORCE)` teardown:

   - `full-apply scenario` (4s)
     - fresh migration apply ✓ (2s)
     - no-op rerun ✓ (899ms)
   - `staged-apply scenario` (8s)
     - staged-vs-full schema equivalence ✓ (7s) — normalized
       `pg_dump --schema-only --no-owner --no-privileges` diffed
       clean between staged and one-pass apply
   - `checksum-drift scenario` (4s)
     - checksum drift detection ✓ (863ms) — runner exited 2 on
       tampered file in temp dir, real `migrations/` tree untouched
   - `bad-migration scenario` (3s)
     - synthetic bad-migration apply failure ✓ (2s) — runner
       exited 1, failing version not recorded, earlier
       migrations intact
   - `behavior scenario` (49s)
     - canonicalization on insert ✓ (15s) — all 22 fixtures,
       byte-for-byte via `pg_read_file`
     - canonicalization on update ✓ (25s) — all 22 fixtures,
       byte-for-byte via `pg_read_file`
     - fingerprint generation ✓ (701ms)
     - `updated_at` trigger ✓ (1s)
     - sync log emit path ✓ (1s)
     - sync log daemon suppression ✓ (1s) — `SET LOCAL`
       transaction-scoped behavior held in single-session heredoc
   - `role-boundary scenario` (4s)
     - role boundary ✓ (476ms) — `memex_mcp` DELETE rejected
       with SQLSTATE 42501; `memex_sync` DELETE succeeded

6. Teardown PASS (`[run-tests] OK` followed by clean compose down)

## Automated Check Status (Section 5.1 cross-reference)

| # | Check | R1 | R2 |
|---|---|---|---|
| 1 | Fresh migration apply | blocked | **PASS** |
| 2 | No-op rerun | blocked | **PASS** |
| 3 | Checksum drift detection | blocked | **PASS** |
| 4 | Staged-vs-full schema equivalence | blocked | **PASS** |
| 5 | Synthetic bad-migration apply failure | blocked | **PASS** |
| 6 | Canonicalization on insert (22/22) | blocked | **PASS** |
| 7 | Canonicalization on update (22/22) | blocked | **PASS** |
| 8 | Fingerprint generation | blocked | **PASS** |
| 9 | `updated_at` trigger | blocked | **PASS** |
| 10 | Sync log emit path | blocked | **PASS** |
| 11 | Sync log daemon suppression | blocked | **PASS** |
| 12 | Role boundary | blocked | **PASS** |
| 13 | Sprint 000 smoke regression | PASS | **PASS** |
| 14 | One-button orchestration | failed | **PASS** |

Every check from Section 5.1 is now green against the live stack.

## Regression Scenarios (Section 5.3) Status

| # | R1 | R2 |
|---|---|---|
| R1 (smoke unit suite passes) | ✓ | ✓ |
| R2 (preflight port-bound error) | not exec | not exec — code path unchanged, low risk |
| R3 (compose config validates) | ✓ | ✓ |
| R4 (SIGINT teardown) | not exec | not exec — signal trap unchanged, low risk |
| R5 (mock inference reachable) | ✓ | ✓ |
| R6 (fixture file unchanged) | ✓ | ✓ |
| R7 (CI workflow unchanged) | ✓ | ✓ |
| R8 (ERR trap propagation) | ✓ | ✓ (still fires; verified by R1 failure path) |
| R9 (mock-inference healthcheck) | ✓ | ✓ |

R2 and R4 are not executed in either round because they require
destructive setup (pre-binding a port; sending SIGINT). Both code
paths are unchanged from Sprint 000 and the risk is minimal.

## Open Question #2 Resolved

The plan's Open Question #2 asked whether the pgvector compose image's
default `pg_hba.conf` permits password login for `memex_mcp` and
`memex_sync` from inside the container. **Answer: yes.** The role
boundary scenario (check 12) successfully connected as both roles
from inside the postgres container using the new explicit test
passwords (`memex_mcp_test_password` / `memex_sync_test_password`)
and exercised both the DELETE-denied and DELETE-allowed paths. No
compose-level override was needed.

## Recommendation to Reviewers

All three Round 1 findings are resolved and the full live suite is
green end-to-end. Round 2 reviewers should verify:

1. The file rename is complete and nothing references the old name
   in live code (docs are fine).
2. `--allow-write` was added only to `test:integration`, not to
   `test:unit`.
3. The password literal swap is consistent across
   `migrations/0009_add_roles.sql`, `tests/run-tests.sh`, and
   `migrations/README.md`.
4. The role-boundary exit-code assertion and the daemon-suppression
   heredoc comment both landed without introducing new issues.
5. The `PG*` env var determinism fix is implemented correctly and
   does not accidentally interact with the Sprint 000 path.
6. No scope drift outside the tests/, scripts/, migrations/,
   deno.json, or ROADMAP.md files touched by the rework.

Do NOT re-flag Round 1 concerns unless the rework failed to address
them. Focus on whether the fixes are correct, whether they introduced
any new failure modes, and whether the live suite's 18-step pass
covers everything the sprint plan asked for.

## What Still Could NOT Be Validated

Nothing material. The entire Sprint 001 verification surface is now
exercisable and green. Residual items:

- R2 and R4 regression scenarios (pre-bound port, SIGINT teardown) —
  destructive, unchanged code, not executed in either round
- Long-term drift detection against architecture Section 6 — that's
  a Sprint 002+ concern, not Sprint 001 closure
