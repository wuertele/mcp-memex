# Review: Sprint 000 - Round 2 (claude)

## Issue 1 Resolution
Fixed correctly. At tests/run-tests.sh:110-119 the script now brackets `deno task test` with `set +e` / `set -e`, captures `$?` into `test_exit_code` on the very next line (no intervening command that would clobber `$?`), dumps `docker compose logs --no-color` to stderr on non-zero, prints the `[run-tests] FAILED` banner, and then `exit "${test_exit_code}"` — propagating the runner's real exit code as Section 3.5 step 11 requires. The `set +e` window is tight (only the single test invocation), so ERR-trap behavior is preserved elsewhere. No residual concerns.

## Issue 2 Resolution
Fixed correctly via an ERR trap. Key observations:

- `set -E` (line 3) ensures the ERR trap is inherited by functions and subshells, so failures inside `wait_for_http` (sourced from tests/lib/wait-for.sh) propagate.
- `trap handle_err ERR` (line 73) is installed before any fallible compose commands (`config`, `up --build --wait`).
- `handle_err` (lines 56-64) captures `$?` on its very first line into `exit_code` before running any other command, then prints `[run-tests] FAILED`, conditionally dumps `docker compose logs` gated on `compose_started`, and finally `exit "${exit_code}"` — preserving the original failure code rather than collapsing to 1.
- The EXIT trap (`cleanup`, line 71) still fires after `handle_err` returns via `exit`, and `cleanup_done` guards against double-teardown. Cleanup runs exactly once per invocation.
- `compose_started=1` is set at line 79, BEFORE `docker compose up -d --build --wait` on line 80. This is the correct ordering: a failing `up --wait` will dump logs (the containers may exist in a failed state), while a failing `docker compose config` on line 76 will NOT try to dump logs from a stack that was never brought up. Good gating.
- The preflight explicit `exit 1` calls (require_command, docker compose version, docker info, assert_port_available, pg_isready timeout) do not trip the ERR trap because `exit` from a shell builtin is not a command failure — so those paths run cleanup via EXIT trap without an erroneous log dump, which is correct because compose_started is still 0 at that point anyway.
- The pg_isready timeout block (lines 95-100) handles its own failure explicitly with a manual FAILED banner + log dump + `exit 1`. This is slightly redundant with the ERR trap but harmless; `exit 1` does not invoke ERR and only invokes EXIT cleanup. Acceptable.

## Scope Check
Only tests/run-tests.sh was modified in the rework (confirmed by executor response and by reading the file). No other files touched by this round.

## New Concerns (if any)
None. A few notes that are not concerns:

- `set -E` could theoretically surface previously-masked subshell failures, but the only subshells in this script are `$(git rev-parse --show-toplevel)` (legitimate failure should abort anyway), `$(seq 1 60)` (cannot fail meaningfully), and the `(: >/dev/tcp/...)` subshell in `assert_port_available` which is explicitly guarded by `if ... ; then` — and commands inside an `if` condition do NOT trigger ERR. Safe.
- The pg_isready loop's `docker compose exec ... pg_isready` runs inside an `if` condition, so its failures during probing do not trip ERR. Correct.
- handle_err's log-dump `|| true` prevents a failing log dump from recursively retriggering ERR inside the trap. Good.

## Required Fixes
None.

## Verdict
PASS
