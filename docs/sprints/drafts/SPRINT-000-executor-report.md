## Tasks Completed

- Phase 1: created `tests/`, `tests/unit/`, `tests/integration/`, `tests/fixtures/`, `tests/lib/`, `tests/mock-inference/`, and `tests/mock-inference/fixtures/`; kept `migrations/`, `mcp-server/`, and `sync-daemon/` absent.
- Phase 2: added `tests/fixtures/canonicalization-cases.json` with 22 hand-verified cases, ASCII-safe escapes, the required boundary cases, and companion documentation for schema and NUL-byte exclusion.
- Phase 3: implemented `tests/mock-inference/main.ts` and `tests/mock-inference/deno.json` with `GET /health`, deterministic `POST /embeddings`, canonical-hash `POST /chat/completions`, structured errors, and request logging.
- Phase 4: added `tests/mock-inference/Dockerfile`, `tests/mock-inference/fixtures/chat.json`, `tests/mock-inference/fixtures/embeddings.json`, and fixture documentation; generated embedding goldens from the committed request handler logic.
- Phase 5: added `tests/compose.yaml` with `postgres`, `mock-inference`, localhost-only bindings, healthchecks, and `memex-test-net`.
- Phase 6: added repo-root `deno.json` and `tests/unit/smoke.test.ts` covering the Sprint 000 smoke matrix.
- Phase 7: added `tests/lib/wait-for.sh` and executable `tests/run-tests.sh` with strict preflight, `-p memex-test`, readiness waits, exported `MEMEX_TEST_*` variables, and teardown.
- Phase 8: added `.github/workflows/test.yml` and `tests/README.md`; documented prerequisites, ports, fixture maintenance, Compose conventions, and Colima troubleshooting.

## Files Changed

- `.github/workflows/test.yml`
- `deno.json`
- `docs/sprints/drafts/SPRINT-000-BLOCKERS.md`
- `docs/sprints/drafts/SPRINT-000-executor-report.md`
- `tests/README.md`
- `tests/compose.yaml`
- `tests/fixtures/README.md`
- `tests/fixtures/canonicalization-cases.json`
- `tests/integration/.gitkeep`
- `tests/lib/wait-for.sh`
- `tests/mock-inference/Dockerfile`
- `tests/mock-inference/deno.json`
- `tests/mock-inference/fixtures/README.md`
- `tests/mock-inference/fixtures/chat.json`
- `tests/mock-inference/fixtures/embeddings.json`
- `tests/mock-inference/main.ts`
- `tests/run-tests.sh`
- `tests/unit/smoke.test.ts`

## Verification Checks Implemented

1. Compose config validation: implemented in `tests/run-tests.sh`; executed `docker compose -p memex-test -f tests/compose.yaml config >/tmp/memex-compose-config.out`; result `compose-config-ok`.
2. Pre-flight port availability: implemented in `tests/run-tests.sh` via `/dev/tcp` probes and `lsof -i :PORT` guidance; static shell parse passed, dynamic occupied-port exercise not run.
3. Docker daemon reachable: implemented in `tests/run-tests.sh` via `docker info`; direct `docker info` run returned exit 1 with `Cannot connect to the Docker daemon...`.
4. Clean startup and teardown: implemented in `tests/run-tests.sh` with pre-run `down -v --remove-orphans`, `trap cleanup EXIT`, and signal cleanup; live stack start/teardown could not be executed because Docker was unreachable.
5. PostgreSQL readiness (container-internal): implemented in `tests/run-tests.sh` with `docker compose ... exec -T postgres pg_isready` polling; not runnable because Compose stack could not start.
6. PostgreSQL readiness (host port binding): implemented in `tests/unit/smoke.test.ts` via `Deno.connect`; not runnable because Deno and Compose were unavailable.
7. Mock service readiness (host): implemented in `tests/run-tests.sh` and `tests/unit/smoke.test.ts`; host-port execution was blocked, but the committed handler logic returned healthy responses in direct verification.
8. Health endpoint contract: implemented in `tests/unit/smoke.test.ts`; direct handler verification passed with `{"status":"ok","service":"mock-inference","version":"0.1.0"}`.
9. Embedding golden fixture replay: implemented in `tests/unit/smoke.test.ts` plus `tests/mock-inference/fixtures/embeddings.json`; direct handler replay passed for all 3 fixtures.
10. Embedding determinism (in-process): implemented in `tests/unit/smoke.test.ts`; direct handler verification passed with byte-identical JSON on repeated requests.
11. Embedding determinism (out-of-process): specified as a manual diff check in the plan; not runnable because no live bound service could be started in this environment.
12. Embedding dimensionality: implemented in `tests/unit/smoke.test.ts`; direct handler verification passed with 1536-d vectors and unit norm within `1e-6`.
13. Embedding variation: implemented in `tests/unit/smoke.test.ts`; direct handler verification passed with different vectors for different inputs.
14. `__fail_embed__` trigger: implemented in `tests/unit/smoke.test.ts`; direct handler verification passed with status 500 and `mock_embedding_failure`.
15. `__slow_embed__` timing: implemented in `tests/unit/smoke.test.ts`; direct handler verification passed with observed elapsed time `5006ms`.
16. Chat fixture replay: implemented in `tests/unit/smoke.test.ts` plus `tests/mock-inference/fixtures/chat.json`; direct handler replay passed for both fixtures.
17. Chat missing fixture: implemented in `tests/unit/smoke.test.ts`; direct handler verification passed with status 400 and a 64-character hex `request_hash`.
18. Canonicalization fixture well-formedness: implemented in `tests/unit/smoke.test.ts`; static verification passed with 22 entries, unique names, required rule buckets, the 3 required boundary cases, and `very-long-content.input.length === 10001`.
19. CI parity: implemented in `.github/workflows/test.yml`; YAML parse confirmed the workflow runs `./tests/run-tests.sh` directly.
20. CI timeout guard: implemented in `.github/workflows/test.yml`; YAML parse confirmed `timeout-minutes: 10`.
21. Fork-safe CI: implemented in `.github/workflows/test.yml`; YAML parse confirmed `permissions: {contents: read}` and `rg -n "secrets\\." .github/workflows/test.yml` returned no matches.

## Verification Gaps

- Full `./tests/run-tests.sh` success could not be verified because `deno` is not installed in the workspace; observed preflight failure was `[run-tests] missing required command: deno`.
- Compose bring-up, healthchecks, PostgreSQL readiness, host port binding, teardown, and all manual `docker compose ... up/ps/exec/down` checks could not be executed because `docker info` failed to reach a Docker daemon.
- Deno-native execution of `tests/mock-inference/main.ts` and `deno task test` could not be executed because `deno` is missing.
- Transport-level local HTTP verification outside Docker was blocked by the sandbox rejecting local listeners with `listen EPERM`, so direct `curl` replay against a temporary locally bound server could not be run.
- GitHub Actions runtime validation on an actual push and PR could not be executed from this local sandbox; only static workflow validation was possible.
- Per-phase `git commit` tasks in the sprint could not be executed because the sandbox denies `.git/index.lock` creation.

## Validation Run

1. `docker compose -p memex-test -f tests/compose.yaml config >/tmp/memex-compose-config.out && echo compose-config-ok`
   Observed: `compose-config-ok`.
2. `bash -n tests/run-tests.sh tests/lib/wait-for.sh`
   Observed: exit 0.
3. `ruby -e "require 'yaml'; YAML.load_file('tests/compose.yaml'); YAML.load_file('.github/workflows/test.yml'); puts 'yaml-ok'"`
   Observed: `yaml-ok`.
4. `node -e "JSON.parse(...deno.json...canonicalization...chat...embeddings...)"`
   Observed: `json-ok`.
5. `node --experimental-strip-types --check tests/mock-inference/main.ts`
   Observed: exit 0.
6. `node --experimental-strip-types --check tests/unit/smoke.test.ts`
   Observed: exit 0.
7. `node` canonicalization verifier against `tests/fixtures/canonicalization-cases.json`
   Observed: `verified 22 canonicalization cases`.
8. Direct handler verification script for `/health`, `/embeddings`, `/chat/completions`, canonicalization coverage, and slow/fail triggers
   Observed: passed; summary output was `{"health":{"status":"ok","service":"mock-inference","version":"0.1.0"},"chatFixtures":2,"embeddingFixtures":3,"slowElapsedMs":5006,"canonicalizationCases":22}`.
9. `./tests/run-tests.sh`
   Observed: `[run-tests] preflight` then `[run-tests] missing required command: deno`; exit 1.
10. Manual step 1 `colima start`
    Observed: not run; `command -v colima` returned no path and Docker remained unreachable.
11. Manual steps 3-11 (`docker compose up/ps/exec/down`, `curl`, `diff`, `time curl`)
    Observed: blocked by unreachable Docker daemon and sandbox refusal to bind a local fallback listener.
12. Regression scenarios
    Observed: none to run; Sprint 000 defines no regressions because this is the first executable code in the repository.

## Open Blockers

- Docker daemon unreachable: `docker info` failed with `Cannot connect to the Docker daemon at unix:///Users/dave/.docker/run/docker.sock`.
- `deno` missing: `deno --version` returned `deno: command not found`.
- Git commits blocked by sandbox: `git commit` failed with `fatal: Unable to create '/Users/dave/mcp-memex/.git/index.lock': Operation not permitted`.
- Local listener blocked by sandbox: temporary HTTP server startup failed with `listen EPERM: operation not permitted 127.0.0.1`.

## Deviations From Plan

- The sprint asked for per-phase commits. Those were not possible because the sandbox blocks Git index writes.
- The sprint asked for local Deno startup and Docker verification. Those were replaced with static checks plus direct invocation of the committed request handler because Deno and Docker are unavailable here.
- `tests/mock-inference/fixtures/embeddings.json` was generated from the committed mock handler logic without binding a real local port, because the sandbox forbids local listeners. The algorithm and response assembly came from the committed service code, but transport-level generation remains to be re-run once Deno or Docker is available.
