# Sprint 000 Pre-Round Validation (Round 2)

Round 2 validation after the rework pass fixed the two [P2] issues
Codex found in Round 1.

## Round 1 Summary (for context)

- Claude: PASS
- Codex: ISSUES_FOUND — two [P2] bugs in `tests/run-tests.sh`
- Gemini: PASS

## Round 2 Scope

The rework pass targeted only `tests/run-tests.sh`. No other files
were modified.

## Executor Handoff Note

Round 1 rework was originally attempted by codex (the sprint's primary
executor), but codex hit its OpenAI usage limit before it could start
the rework. The operator authorized switching to claude for this one
rework round via the Agent tool in the sprint-execute orchestrator.
Codex remains the primary executor for the sprint; if additional
rework rounds are needed after codex's quota resets, codex will
resume.

The Round 2 review pool is **Claude + Gemini only**. Codex is skipped
for Round 2 because it is still rate-limited. Per the sprint-execute
skill: "A round passes only if at least one review is parseable and
every parseable review says PASS." Round 2 will pass if both Claude
and Gemini return PASS.

## Environment

Same as Round 1:
- Host: macOS
- Python: 3.12.3
- Bash: 3.2.57 (system)
- Ruby: 2.6.10 (system)
- Deno: **NOT INSTALLED**
- Colima: **NOT INSTALLED**
- Docker daemon: **NOT REACHABLE**

Dynamic validation is still blocked for the same reasons as Round 1.

## Commands Run

### 1. Rework artifacts present

```
$ ls -la tests/run-tests.sh docs/sprints/drafts/SPRINT-000-executor-response-R1.md
-rw-r--r--  docs/sprints/drafts/SPRINT-000-executor-response-R1.md (8986 bytes)
-rwxr-xr-x  tests/run-tests.sh (2846 bytes)
```

**Result:** Both artifacts exist. `tests/run-tests.sh` grew from 2383
bytes to 2846 bytes (+463 bytes, +19 lines) — consistent with the
scope of the rework (add ERR trap infrastructure, preserve test exit
code, add `set -E`).

### 2. Bash syntax check

```
$ bash -n tests/run-tests.sh && echo ok
ok
```

**Result:** Syntax is valid.

### 3. Inspection of changes to `tests/run-tests.sh`

The orchestrator inspected the updated script end-to-end. Key observed
changes:

- **Line 3:** Added `set -E` (so the ERR trap is inherited by
  functions, command substitutions, and subshells). This is required
  for the ERR trap to fire on failures inside function calls.
- **Line 44:** Added `compose_started=0` state flag.
- **Lines 56-64:** New `handle_err()` function that prints the
  `[run-tests] FAILED` banner, dumps `docker compose logs` only if
  `compose_started == 1` (avoids dumping logs when the stack has not
  been brought up yet), and re-exits with the captured exit code.
- **Line 73:** `trap handle_err ERR` installed after the existing
  `cleanup` EXIT trap and `handle_signal` INT/TERM trap.
- **Line 79:** `compose_started=1` set *immediately before*
  `"${COMPOSE[@]}" up -d --build --wait`, so a failure during the
  up-and-wait step still dumps logs if the stack was at least
  partially created.
- **Lines 110-118:** The `deno task test` call is now wrapped in
  `set +e` / capture `$?` / `set -e`, and the runner exits with the
  captured `test_exit_code` instead of a hardcoded `1`.

### 4. Mental walkthrough of failure paths

For each failure path the orchestrator traced the expected behavior:

| Failure point | Current behavior |
|---|---|
| `require_command docker` fails at line 26 | Explicit `exit 1` from `require_command`; no ERR trap fires (explicit exit, not a failing command); EXIT trap runs cleanup. No compose logs (correct — compose not started). |
| `require_command deno` fails at line 27 | Same as above. |
| `docker compose version` fails at line 29 | Explicit `if ! ... ; then ... exit 1; fi` path; no ERR trap fires; EXIT trap runs cleanup. No compose logs. |
| `docker info` fails at line 34 | Same — explicit exit 1 inside the guarded `if`. |
| `assert_port_available` fails at line 39/40 | Explicit `exit 1` inside the function; no ERR trap fires. |
| `"${COMPOSE[@]}" config` fails at line 76 | Runs under `set -e`. Compose command returns non-zero → ERR trap fires → `handle_err` prints `[run-tests] FAILED`. `compose_started` is still 0 at this point, so logs are NOT dumped (nothing to dump yet). Exit code propagated. Then EXIT trap runs cleanup. **This is the Round 1 regression case that Codex flagged; now fixed.** |
| `"${COMPOSE[@]}" up -d --build --wait` fails at line 80 | Runs under `set -e` with `compose_started=1` already set. ERR trap fires → prints FAILED + dumps logs (compose was attempting to start, partial state may exist). Exit code propagated. EXIT trap runs cleanup. **Another Round 1 regression case, now fixed.** |
| `wait_for_http` fails at line 84 | Runs under `set -e` with `compose_started=1`. ERR trap fires → prints FAILED + dumps logs. Exit code propagated. EXIT trap runs cleanup. **Another Round 1 regression case, now fixed.** |
| `pg_isready` loop times out at lines 95-100 | Explicit `if (( postgres_ready == 0 )); then ... exit 1; fi` branch. This code path still uses an explicit `echo FAILED` + `compose logs` + `exit 1` (pre-existing from Round 1; not changed). Note: this hardcodes `exit 1` which is not the actual command's exit code, but since the loop itself succeeds or times out (not a propagated command failure), there is no meaningful exit code to preserve from a subcommand. This is consistent with Round 1 behavior and was not flagged as an issue. |
| `deno task test` fails at lines 110-118 | `set +e` around the test invocation captures `$?` into `test_exit_code`. If non-zero, prints FAILED, dumps logs, exits with the captured code. **This was the exit-code-preservation issue from Round 1; now fixed.** |
| Signal (SIGINT / SIGTERM) | `handle_signal` trap fires, calls cleanup, exits 130. Unchanged from Round 1. |

All four failure paths that Round 1 flagged as broken (`config`, `up
--wait`, `wait_for_http`, and `deno task test` exit code) now emit
the proper operator diagnostics.

### 5. Trap ordering

Order matters because multiple traps can fire on a failure:

- On ERR: `handle_err` runs first. It prints FAILED, dumps logs, and
  calls `exit "${exit_code}"`. Because `exit` triggers the EXIT trap,
  `cleanup` runs next.
- On INT/TERM: `handle_signal` runs first. It calls `cleanup`
  directly (no logs dumped), then `exit 130`.
- On normal exit: only `cleanup` runs (via EXIT trap).

The `cleanup_done` guard prevents `cleanup` from running twice
(signal path calls it explicitly; EXIT trap would call it again).
This is sound.

### 6. Response file well-formedness

```
$ head docs/sprints/drafts/SPRINT-000-executor-response-R1.md
```

Response file has the required sections (Executor Handoff Note,
Changes Made, Feedback Addressed, Recommendations Declined, Trade-Off
Decisions, Remaining Blockers, Static Validation After Changes).

## Recommendation to Reviewers

Evaluate whether the two [P2] issues from Round 1 are fully resolved:

1. **Issue 1 (test exit code):** Verify that lines 110-118 preserve
   the `deno task test` exit code and that line 118 exits with the
   captured code. Reviewers should confirm the `set +e` / `set -e`
   dance is correctly bracketed and that `test_exit_code` is assigned
   immediately after the failing command (before any other command
   that would overwrite `$?`).

2. **Issue 2 (early failure diagnostics):** Verify that the ERR trap
   at line 73 fires for the three failure paths Codex flagged
   (`config`, `up --wait`, `wait_for_http`). Check that the
   `compose_started` flag correctly gates the log dump. Check that
   the ERR trap is installed AFTER the initial preflight `exit 1`
   paths, so it does not fire on the expected `docker info` preflight
   failure (note: in the current code, `docker info` is wrapped in an
   `if ! ... ; then exit 1; fi` block, so ERR never fires there
   regardless of trap installation order — but the installation
   order still matters if a later revision changes preflight to use
   a bare call).

Do NOT re-flag the Round 1 concerns unless the rework fails to
address them. Focus on whether the fixes are correct, whether they
introduce any new failure modes, and whether the `set -E` addition
has any side effects that could break other parts of the script.

## What Still Could NOT Be Validated

Same as Round 1: dynamic validation of the compose stack is still
blocked because Colima/Deno are not installed on the host. The rework
can only be statically verified. Any runtime behavior that depends on
actual bash trap semantics (ERR trap firing, set -E inheritance,
cleanup trap chaining) must be evaluated by reading the code rather
than running it.

This is acceptable for Sprint 000 closure because the rework is small
and the fix pattern is well-known. When the operator eventually
installs Colima and Deno and runs `./tests/run-tests.sh` for real, any
residual issues can be addressed as a sprint-001 side-quest.
