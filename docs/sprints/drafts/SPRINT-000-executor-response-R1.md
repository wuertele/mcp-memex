## Executor Handoff Note
This rework pass was executed by claude (via the Agent tool in the sprint-execute orchestrator) instead of codex. Codex hit an OpenAI usage limit during the rework attempt and could not complete. The operator authorized switching to claude for this one rework round; the original executor (codex) remains the primary executor for the sprint and may resume if additional rounds are needed after codex's quota resets.

## Changes Made
All edits are confined to `tests/run-tests.sh`. No other files were touched.

1. **Line 3 — added `set -E`.** Inserted `set -E  # ensure ERR trap is inherited by functions, command substitutions, and subshells` immediately after `set -euo pipefail`. This is required so the new ERR trap fires for failures inside functions and command substitutions, not just the top-level script body.

2. **Line 44 — added `compose_started=0` state flag.** Sits next to the existing `cleanup_done=0` flag. It gates whether the ERR trap should attempt to dump compose logs (we should not run `docker compose logs` before we have ever issued `up`).

3. **Lines 56–64 — added `handle_err()` function.** New ERR-trap handler:
   ```bash
   handle_err() {
     local exit_code=$?
     echo "[run-tests] FAILED" >&2
     if (( compose_started == 1 )); then
       "${COMPOSE[@]}" logs --no-color >&2 || true
     fi
     # cleanup runs via the EXIT trap after this returns
     exit "${exit_code}"
   }
   ```
   It captures the actual `$?` from the failing command, prints the required `[run-tests] FAILED` banner to stderr, conditionally dumps compose logs to stderr (only if compose was started), then re-exits with the captured code. The existing `cleanup` EXIT trap then fires automatically to tear down the stack.

4. **Line 73 — installed `trap handle_err ERR`.** Added next to the existing `trap cleanup EXIT` and `trap handle_signal INT TERM` lines, after the preflight block (the preflight uses `if ! ... ; then exit 1; fi` patterns and explicit `exit 1` calls, so it would not fire ERR even if installed earlier; placing it here matches the spec guidance for clarity).

5. **Line 79 — set `compose_started=1` immediately before the `up --build --wait` call.** Set *before* the up command, not after, so that a partial-bringup failure (e.g. one container starts and emits useful logs, the other fails the healthcheck) still triggers the log dump in `handle_err`.

6. **Lines 109–119 — replaced the `if ! deno task test` block with a `set +e` / capture / `set -e` pattern.** Previously:
   ```bash
   if ! deno task test; then
     echo "[run-tests] FAILED" >&2
     "${COMPOSE[@]}" logs --no-color || true
     exit 1
   fi
   ```
   Now:
   ```bash
   set +e
   deno task test
   test_exit_code=$?
   set -e

   if (( test_exit_code != 0 )); then
     echo "[run-tests] FAILED" >&2
     "${COMPOSE[@]}" logs --no-color >&2 || true
     exit "${test_exit_code}"
   fi
   ```
   This preserves the actual `deno task test` exit status. We deliberately do *not* let the ERR trap handle the test failure path: an `if ! cmd` form suppresses ERR (per bash semantics), and we need both (a) to capture the exact exit code and (b) to emit the diagnostics ourselves so we can `exit "${test_exit_code}"` rather than `exit 1`. Log dump now goes to stderr to match the ERR-trap path. Note the `|| true` on the log dump is intentional so a flaky `docker compose logs` call cannot mask the real test exit code.

## Feedback Addressed
- **Issue 1 (test exit code not preserved):** Replaced the `if ! deno task test; then ... exit 1; fi` block with the documented `set +e` / capture / `set -e` idiom and `exit "${test_exit_code}"`. The runner now propagates `deno task test`'s exact exit status, satisfying SPRINT-000 Section 3.5 step 11. (run-tests.sh:109–119)
- **Issue 2 (log dump and FAILED banner skipped on early failures):** Installed an ERR trap (`handle_err`) that prints `[run-tests] FAILED` and, if compose has been started, dumps `docker compose ... logs --no-color` before exiting with the failing command's actual exit code. Added `set -E` so the trap is inherited reliably. The trap covers `docker compose config`, `docker compose up -d --build --wait`, `wait_for_http`, and any other `set -e`-driven failure path. (run-tests.sh:3, 44, 56–64, 73, 79)

## Recommendations Declined
None. Both [P2] fixes from the codex review were applied as recommended. The feedback file's proposed patch shape was followed; the only adaptation was sending log output to stderr (consistent with the FAILED banner) and using a state flag for `compose_started` rather than detecting compose state dynamically (faster and avoids extra docker calls in the failure path).

## Trade-Off Decisions
One small choice worth noting: the `deno task test` failure path is handled explicitly with `set +e` rather than letting the new ERR trap catch it. Two reasons:
1. We must preserve the exact `deno task test` exit code, and the cleanest way to do that without depending on `$?` survival across trap dispatch is to capture it in a local variable immediately.
2. Conceptually, a test failure is an expected outcome that the runner has a contract to surface — not an unexpected script error. Routing it through the explicit branch keeps the intent clear.

The `pg_isready` retry loop was left untouched (still emits its own FAILED banner and `exit 1`). It is wrapped in `if ... ; then` (which suppresses ERR) and already complies with the operator-diagnostics contract; no change was required by the review.

## Remaining Blockers
The original SPRINT-000-BLOCKERS items (no Docker, no Deno, no live network bind in the executor sandbox) still apply to dynamic validation of this script. They cannot be addressed from this workstation. No new blockers were introduced by this rework.

## Static Validation After Changes

**Syntax check:**
```
$ bash -n /Users/dave/mcp-memex/tests/run-tests.sh && echo SYNTAX_OK
SYNTAX_OK
```

**Mental walkthrough of each failure path:**

| # | Failure point | Line | Path through traps | stderr output | Exit code |
|---|---|---|---|---|---|
| 1 | `docker compose config` fails | 76 | ERR trap fires (`compose_started=0`, no log dump) -> EXIT trap (cleanup) | `[run-tests] FAILED` | actual `docker compose config` exit code |
| 2 | `docker compose up -d --build --wait` fails | 80 | ERR trap fires (`compose_started=1`, dumps `docker compose logs`) -> EXIT trap (cleanup) | `[run-tests] FAILED` + compose logs | actual `up --wait` exit code |
| 3 | `wait_for_http` fails (sourced from tests/lib/wait-for.sh) | 84 | ERR trap fires (`compose_started=1`, dumps logs) -> EXIT trap (cleanup). `set -E` ensures the ERR trap is inherited into the sourced function. | `[run-tests] FAILED` + compose logs | actual `wait_for_http` exit code |
| 4 | `pg_isready` never succeeds within 60 attempts | 95–100 | The `if (( postgres_ready == 0 ))` block runs (the loop body is inside `if ... ; then`, which suppresses ERR), prints its own FAILED banner, dumps logs, and `exit 1`. EXIT trap (cleanup) fires after. | `PostgreSQL did not become ready in time` + `[run-tests] FAILED` + compose logs | `1` (preserved from existing behavior) |
| 5 | `deno task test` fails | 110–119 | `set +e` block captures `test_exit_code`, `set -e` re-enabled, then explicit `if` block prints FAILED, dumps logs to stderr, and `exit "${test_exit_code}"`. EXIT trap (cleanup) fires after. ERR trap is *not* invoked because the failing command is followed immediately by `test_exit_code=$?` (no error was raised under `set +e`). | `[run-tests] FAILED` + compose logs | actual `deno task test` exit code |
| 6 | SIGINT/SIGTERM | any | `handle_signal` runs `cleanup` and `exit 130`. ERR trap does not fire on signals. | `[run-tests] tearing down` | `130` |
| 7 | Successful run | end | EXIT trap (cleanup) fires only. | `[run-tests] OK` | `0` |

**Trap ordering verification:** Bash dispatches the ERR trap first (on the failing command), and then the EXIT trap fires when the script terminates via the `exit` call inside `handle_err`. The `cleanup` function is idempotent (`cleanup_done` guard), so even if a future change accidentally calls it from both paths it will only tear down once. The signal handler also calls `cleanup` and then `exit 130`, which re-enters EXIT — again safe due to the guard.

**`set -E` necessity check:** Without `set -E`, the ERR trap would only fire on top-level commands, *not* on commands inside `wait_for_http` (which is sourced from `tests/lib/wait-for.sh` and called as a function). With `set -E` added at line 3, the ERR trap is inherited into functions, command substitutions, and subshells, so `wait_for_http` failures now reliably trigger `handle_err`.

**Scope check:** Only `tests/run-tests.sh` was modified. No edits to `tests/mock-inference/main.ts`, `tests/unit/smoke.test.ts`, `tests/compose.yaml`, `tests/lib/wait-for.sh`, the Dockerfile, the CI workflow, README files, fixtures, or the sprint plan.
