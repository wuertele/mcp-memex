# Review Feedback - Round 1

## Validation Results

See `docs/sprints/drafts/SPRINT-000-validation-R1.md` for the full
orchestrator validation record. Summary:

- Bash syntax check passed for both shell scripts
- JSON validity confirmed for all 5 JSON files
- YAML validity confirmed for compose.yaml and test.yml
- Canonicalization fixture has 22 entries, all 6 required rule
  buckets, all 3 boundary cases, unique names
- Dynamic validation was blocked because Colima and Deno are not
  installed on the host (expected — installing them is a post-sprint
  operator task)

## Reviewer Verdict Breakdown

| Reviewer | Verdict |
|----------|---------|
| Claude   | PASS    |
| Codex    | ISSUES_FOUND |
| Gemini   | PASS    |

Because one reviewer found issues, this round does not pass. A rework
pass is required before the round-2 review can run.

## Consensus Issues (Raised by Multiple Reviewers)

None. Claude and Gemini reported no [P1]/[P2] issues. The fixes below
are Codex-specific, but they are correct findings the other reviewers
missed and must be addressed.

## Agent-Specific Issues

### From Codex (two [P2] issues in `tests/run-tests.sh`)

#### Issue 1: Test exit code not preserved [P2]

**Location:** `tests/run-tests.sh:96-100`

```bash
if ! deno task test; then
  echo "[run-tests] FAILED" >&2
  "${COMPOSE[@]}" logs --no-color || true
  exit 1
fi
```

**Problem:** The runner always exits with code `1` when the test suite
fails, regardless of what `deno task test` actually returned. The
sprint plan's Section 3.5 step 11 explicitly says "Exit with the test
runner's exit code." Callers (CI, future shell scripts that invoke
`./tests/run-tests.sh`, the operator) cannot distinguish between a
test failure (Deno returns 1 for test failure), a Deno panic (returns
2+), or a signal-induced termination.

**Fix:** Capture the deno exit code and propagate it:

```bash
set +e
deno task test
test_exit=$?
set -e

if (( test_exit != 0 )); then
  echo "[run-tests] FAILED" >&2
  "${COMPOSE[@]}" logs --no-color 2>/dev/null || true
  exit "${test_exit}"
fi
```

The `set +e` / `set -e` dance is needed because otherwise the non-zero
exit of `deno task test` would terminate the script before we can
capture `$?`. This pattern is documented in
`memex-architecture.md` as the standard way to catch a non-zero exit
code under `set -e`.

#### Issue 2: Log dump and FAILED banner skipped on early failures [P2]

**Location:** `tests/run-tests.sh:63-70`

```bash
"${COMPOSE[@]}" down -v --remove-orphans >/dev/null 2>&1 || true
"${COMPOSE[@]}" config >/dev/null           # line 63: can fail under set -e

echo "[run-tests] bringing up stack"
COMPOSE_HTTP_TIMEOUT=120 "${COMPOSE[@]}" up -d --build --wait  # line 66: can fail under set -e

echo "[run-tests] waiting for readiness"
source tests/lib/wait-for.sh
wait_for_http "http://127.0.0.1:58000/health" 60  # line 70: can fail under set -e
```

**Problem:** If any of these commands fail, `set -e` kills the script
immediately. The EXIT trap (`cleanup`) still runs and tears down the
stack, but:

1. No `[run-tests] FAILED` banner is printed to stderr
2. No `docker compose logs` are dumped

The sprint plan says failures should emit both. Right now, only the
`pg_isready` (lines 81-86) and `deno task test` (lines 96-100) paths
do this; everything before them fails silently (from an operator-UX
perspective).

**Fix:** Add an ERR trap that dumps logs and prints FAILED, then
re-raises the exit code. Install the trap AFTER the preflight checks
complete (so that the expected `docker info` failure during preflight
does not trigger it). Example:

```bash
# Install after preflight, before "${COMPOSE[@]}" config
compose_up=0

report_error() {
  local exit_code=$?
  echo "[run-tests] FAILED" >&2
  if (( compose_up == 1 )); then
    "${COMPOSE[@]}" logs --no-color 2>/dev/null || true
  fi
  exit "${exit_code}"
}
trap report_error ERR

# ... then later:
"${COMPOSE[@]}" config >/dev/null

echo "[run-tests] bringing up stack"
compose_up=1
COMPOSE_HTTP_TIMEOUT=120 "${COMPOSE[@]}" up -d --build --wait
# ... etc
```

The `compose_up` flag prevents attempting to dump logs before the
stack has been started (during `config` validation, for example),
which would produce a confusing "no such services" error.

Alternatively, the fix could wrap each command with explicit
failure handling, but that produces more boilerplate. The ERR trap
approach is cleaner.

## Contradictions

None. All three reviewers agree on the overall shape of the work;
only Codex found specific runner-script bugs that the others missed.

## Required Next Actions (ordered)

1. **[P2]** Fix `tests/run-tests.sh` to preserve the actual
   `deno task test` exit code (Issue 1 above).
2. **[P2]** Fix `tests/run-tests.sh` so all post-preflight failures
   emit the `[run-tests] FAILED` banner and dump compose logs (Issue
   2 above).
3. After fixing both: verify `bash -n tests/run-tests.sh` still
   parses cleanly.
4. After fixing both: verify the ERR trap does not interfere with
   the EXIT trap's cleanup invocation.
5. Write `docs/sprints/drafts/SPRINT-000-executor-response-R1.md`
   documenting the changes.

## Source Review Files

- `docs/sprints/drafts/SPRINT-000-review-R1-claude.md` (PASS)
- `docs/sprints/drafts/SPRINT-000-review-R1-codex.md` (ISSUES_FOUND)
- `docs/sprints/drafts/SPRINT-000-review-R1-gemini.md` (PASS)
