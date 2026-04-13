# Review: Sprint 000 - Round 1 (codex)

## Plan Adherence
The implementation artifacts for Phases 1-8 are present and match the sprint scope: the new work is confined to `tests/`, `.github/workflows/test.yml`, and repo-root `deno.json`, with no out-of-scope `migrations/`, `mcp-server/`, or `sync-daemon/` trees added. The dependency chain also lines up with the plan: Phase 3 service code exists before the Phase 4 golden fixtures that replay it, Phase 6 smoke tests consume those fixtures, and Phases 7-8 wire the runner and CI around the same test entrypoint.

Two plan items were only partially completed, but both are explained by the documented environment blockers rather than by missing repo work: the per-phase commit steps were not possible because git index locking is blocked in the sandbox, and the local Deno/Docker verification steps were replaced by static verification plus direct handler invocation because Deno and Docker were unavailable.

## Implementation Quality
The code is generally readable and maintainable. `tests/mock-inference/main.ts` is split into small pure helpers for hashing, canonicalization, embedding expansion, and fixture indexing, and the smoke suite stays focused on the platform contract rather than introducing extra harness complexity.

I found one important runner-script defect and one smaller diagnosability gap. `tests/run-tests.sh:95-99` does not preserve the actual `deno task test` exit status, and `tests/run-tests.sh:63-70` relies on `set -e` for some startup failures, which means those paths skip the promised compose-log dump and `[run-tests] FAILED` banner.

## System Impact
### Pinned Spec Compliance
I inspected `tests/mock-inference/main.ts:67-87`, `89-121`, `171-188`, and `198-280`, plus `tests/fixtures/canonicalization-cases.json:45-120`, `tests/fixtures/README.md:1-18`, and `tests/mock-inference/fixtures/chat.json:3-73`. No pinned-spec deviations stood out.

The embedding path matches Section 3.4 exactly: `SHA-256(utf8(input))` seed at `main.ts:102-104`, 192 counter-expanded SHA-256 blocks with big-endian u32 counters at `89-99`, 1536 big-endian u32 decodes and `[-1, 1]` mapping at `105-114`, then L2 normalization at `116-119`. I did not find any byte-layout mismatch that would qualify as a [P1].

The chat completion lookup also follows the pinned contract. `canonicalizeJsonValue()` recursively sorts object keys while preserving array order (`67-79`), `stableStringify()` produces the whitespace-free canonical JSON string (`81-83`), `requestHashHex()` computes SHA-256 hex (`85-87`), and the same hash function is used both when indexing fixtures at startup (`171-188`) and when matching incoming requests (`266-280`).

The canonicalization corpus covers the authoritative Section 6.4 rules and the required boundaries. Spot checks passed for the NFD-to-NFC case (`nfd-to-nfc-accented`, `45-49`), the empty-string boundary (`105-109`), the single-newline idempotence case (`111-115`), the whitespace-only boundary (`117-120`), and preservation of markdown-significant trailing double-space (`75-79`). `tests/fixtures/README.md:16-18` correctly documents NUL bytes as out of scope, and I did not see any NUL-bearing fixture content in the checked-in corpus.

### Runner Script Correctness
Most of the runner contract is implemented correctly. `tests/run-tests.sh:6-7` resolves the repo root with `git rev-parse`, `17-23` implements a real `/dev/tcp` preflight that can fail, `33-35` gives a clear Docker operator message, `41` uses `-p memex-test` explicitly, `54-60` ensures teardown runs on `INT`, `TERM`, and `EXIT`, `68-86` performs the HTTP and PostgreSQL readiness waits, and `88-93` exports the `MEMEX_TEST_*` variables before the Deno test invocation.

The main defect is `95-99`: on test failure the script always exits `1` instead of returning the actual `deno task test` exit code required by Section 3.5 step 11 and Phase 7. A second issue is that failures in `config`, `up -d --build --wait`, or `wait_for_http` currently short-circuit via `set -e` at `63-70`, so those paths do not reliably emit the promised compose logs and `[run-tests] FAILED` banner.

### Smoke Test Coverage
`tests/unit/smoke.test.ts:58-223` includes all ten Phase 6 smoke cases: PostgreSQL host TCP reachability, `/health`, embedding golden replay, embedding determinism, embedding variation, `__fail_embed__`, `__slow_embed__`, chat golden replay, missing chat fixture, and canonicalization-fixture well-formedness. The slow-embed test asserts both bounds (`155-156`) and wraps the request in a 20s timeout (`141-157`). The PostgreSQL host-port check uses `Deno.connect(...)` and explicitly closes the connection (`58-65`).

No issues.

### Dockerfile and Compose
`tests/mock-inference/Dockerfile:1-13` pins a Deno minor version (`2.1.4`) and runs `deno cache main.ts` at build time. `tests/compose.yaml:1-36` binds both services to `127.0.0.1`, omits the top-level `version:` key, uses the correct PostgreSQL healthcheck user (`memex_test`), declares the named `memex-test-net` network, and uses an anonymous PostgreSQL data volume.

No issues.

### CI Workflow
`.github/workflows/test.yml:1-20` meets the sprint contract: it runs on both `push` and `pull_request`, sets minimal `contents: read` permissions, applies `timeout-minutes: 10`, installs Deno with `denoland/setup-deno@v1`, and invokes `./tests/run-tests.sh` directly instead of duplicating the flow in YAML.

No issues.

### Verification Gap Audit
I trust the executor's static verification reasonably well for the pinned mock-service logic itself. The core paths in `tests/mock-inference/main.ts` are implemented with web-standard APIs (`TextEncoder`, WebCrypto SHA-256, `DataView`, `JSON.stringify`, `setTimeout`) and the direct-import verification exercised the same request handler and pure helper functions that Deno will execute. That gives fairly high confidence in the embedding math, canonical JSON hashing, fixture replay, and fail/slow trigger behavior.

I do not consider the static-only verification sufficient for the runtime envelope around that logic. It cannot prove `Deno.serve` startup and fixture loading in `tests/mock-inference/main.ts:295-303`, the Deno-specific runtime behavior in `tests/unit/smoke.test.ts:58-223`, Compose networking and healthchecks in `tests/compose.yaml:1-36`, bash signal/trap behavior in `tests/run-tests.sh:41-102`, or end-to-end CI execution in `.github/workflows/test.yml:1-20`. In practice, trust is high for the pinned service logic, moderate for the static artifact shape, and still low for the Docker/Deno orchestration path until the operator reruns the blocked dynamic checks on a machine with Colima/Deno installed.

### Deviations and Blockers
The documented blockers are reasonable and unavoidable in this environment. Docker daemon unreachability, missing Deno, sandbox refusal to create `.git/index.lock`, and sandbox refusal to bind a local TCP listener are executor-environment limitations, not mcp-memex design problems.

The executor's workarounds were also appropriate. Replacing blocked live verification with YAML/JSON/shell syntax checks plus direct request-handler invocation is a credible substitute for reviewing the pinned algorithm and fixture logic, but it is not a substitute for transport-level, Compose-level, or CI-level verification. The only material plan deviations were the blocked per-phase commits and the blocked live Deno/Docker runs.

## Required Fixes
1. [P2] Preserve the actual `deno task test` exit status in `tests/run-tests.sh:95-99` instead of collapsing every test failure to `exit 1`; the sprint contract explicitly requires the runner to exit with the test runner's code.
2. [P2] Make all post-Compose failure paths in `tests/run-tests.sh` emit `[run-tests] FAILED` and `docker compose ... logs --no-color`, not just the `pg_isready` and `deno task test` branches. As written, failures in `config`, `up --wait`, or `wait_for_http` at `63-70` can exit via `set -e` without the required operator diagnostics.

Severity: [P1] = blocking (must fix), [P2] = important (should fix), [P3] = minor (consider fixing)

## Verdict
ISSUES_FOUND
