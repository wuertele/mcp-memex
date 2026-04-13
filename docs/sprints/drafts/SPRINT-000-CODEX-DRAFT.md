# Sprint 000: Test Platform and CI Scaffolding

## 1. Overview

Sprint 000 establishes the first executable infrastructure in
`mcp-memex`: an offline, reproducible test platform that mirrors the
two external boundaries every later sprint depends on, PostgreSQL with
pgvector and an OpenAI-compatible inference API. It matters now because
sprint 001 cannot validate migrations without a disposable database,
and later server/daemon sprints need a shared fixture corpus, a stable
mock inference contract, and one test entrypoint that behaves the same
locally and in CI.

The sprint should deliver one source of truth for test execution:
`./tests/run-tests.sh` starts Docker Compose, waits for readiness, runs
the smoke test, and tears everything down. GitHub Actions should invoke
that same script rather than reimplementing the test flow.

## 2. Use Cases

| Scenario | Inputs | Expected Behavior |
|---|---|---|
| Fresh local test run | Operator runs `./tests/run-tests.sh` from a clean clone with Docker/Colima and Deno installed | Script validates prerequisites, starts Compose, waits for PostgreSQL and mock inference readiness, runs the smoke test, tears down cleanly, and exits `0` |
| PostgreSQL readiness | Compose starts `pgvector/pgvector:pg16` bound to `127.0.0.1:55432` | Database accepts connections on `55432`; later sprints can reuse the same port and runner without changing test harness code |
| Mock health check | `GET http://127.0.0.1:58000/health` | Returns `200` with a small JSON body indicating the mock service is healthy |
| Deterministic embeddings | Two identical `POST /embeddings` requests with the same `input` and `model` | Both responses are byte-identical JSON with a 1536-element embedding vector and the same model echo |
| Embedding failure trigger | `POST /embeddings` with `input == "__fail_embed__"` | Returns `500` with a JSON error payload; no outbound network calls are attempted |
| Slow embedding trigger | `POST /embeddings` with `input == "__slow_embed__"` | Responds successfully only after an intentional ~5 second delay so later sprints can test timeout handling |
| Canned chat response | `POST /chat/completions` matching a known fixture request | Returns the exact canned JSON response associated with that fixture |
| Missing chat fixture | `POST /chat/completions` with a request not present in fixtures | Returns `400` with a deterministic request hash in the error payload so the operator can add a new fixture intentionally |
| Canonicalization corpus sanity | Smoke test loads `tests/fixtures/canonicalization-cases.json` | JSON parses successfully and contains the required Section 6.4 rule coverage cases for later SQL, TypeScript, and Python implementations |
| Clean state between runs | Operator runs `./tests/run-tests.sh` twice in succession | Second run starts from empty containers and fresh volumes; no leftover state from the first run affects results |
| CI on push and PR | GitHub Actions runs on `push` and `pull_request` events, including forks | Workflow succeeds without secrets and uses the same runner/Compose path as local development |

## 3. Architecture

### 3.1 Test Platform Shape

Sprint 000 creates a minimal test harness around the same boundaries
the real system will use later:

1. `tests/compose.yaml` starts two containers:
   - `postgres` using `pgvector/pgvector:pg16`
   - `mock-inference` built from `tests/mock-inference/Dockerfile`
2. `tests/run-tests.sh` is the orchestrator:
   - validates local prerequisites
   - brings the Compose stack up
   - waits for service readiness
   - exports common test env vars
   - runs Deno-based smoke tests
   - prints logs on failure
   - tears the stack down with volumes removed
3. `tests/unit/smoke.test.ts` is the first executable test suite:
   - it hits the live mock service over HTTP
   - it validates the canonicalization fixture file
   - it proves the runner works end-to-end before any feature code exists
4. `.github/workflows/test.yml` runs the same shell entrypoint in CI.

This mirrors the architecture boundary from `memex-architecture.md`
Section 4 without prematurely introducing application code. The real
MCP server and sync daemon do not exist yet, but the database and
inference dependencies they will consume are available now under fixed,
documented ports.

### 3.2 Repository Layout After Sprint 000

Sprint 000 should leave the repository in this shape:

```text
mcp-memex/
├── .github/
│   └── workflows/
│       └── test.yml
├── docs/
│   └── sprints/
│       └── ...
├── README.md
├── ROADMAP.md
├── memex-architecture.md
└── tests/
    ├── README.md
    ├── compose.yaml
    ├── run-tests.sh
    ├── fixtures/
    │   └── canonicalization-cases.json
    ├── integration/
    │   └── .gitkeep
    ├── mock-inference/
    │   ├── Dockerfile
    │   ├── main.ts
    │   └── fixtures/
    │       ├── chat.json
    │       └── embeddings.json
    └── unit/
        └── smoke.test.ts
```

Reserved for later sprints, but not created here unless the executor
chooses to add empty directories intentionally:

- `migrations/` in sprint 001
- `mcp-server/` in sprint 002
- `sync-daemon/` in sprint 005

The only placeholder directory Sprint 000 should create proactively is
`tests/integration/`, because sprint 001 immediately adds database
integration tests there and the path should already exist in the test
layout.

### 3.3 Compose Topology and Runtime Conventions

- Omit the Compose `version:` field. Compose v2 is the project
  baseline; current best practice is to rely on the latest spec.
- Bind ports to `127.0.0.1` only:
  - PostgreSQL: `127.0.0.1:55432 -> 5432`
  - Mock inference: `127.0.0.1:58000 -> 8000`
- Use fixed defaults rather than random ports so later tests and docs
  can rely on stable addresses.
- Treat the runner as serial-only in sprint 000. Do not add parallel
  test execution or dynamic project naming complexity yet.
- Ensure teardown is always `docker compose down -v --remove-orphans`
  so every run starts clean.

`tests/run-tests.sh` should export a small, future-proof environment
contract for later tests:

- `MEMEX_TEST_DB_HOST=127.0.0.1`
- `MEMEX_TEST_DB_PORT=55432`
- `MEMEX_TEST_DB_NAME=memex_test`
- `MEMEX_TEST_DB_USER=memex_test`
- `MEMEX_TEST_DB_PASSWORD=memex_test`
- `MEMEX_TEST_INFERENCE_BASE=http://127.0.0.1:58000`

### 3.4 Mock Inference Service API Contract

The mock service should be intentionally small and deterministic. It is
not trying to emulate a real provider in full; it only needs the
surface memex will consume.

#### `GET /health`

- No request body
- Response: `200 OK`
- Response body:

```json
{
  "status": "ok",
  "service": "mock-inference"
}
```

#### `POST /embeddings`

Request body should be OpenAI-compatible enough for later memex use:

```json
{
  "model": "openai/text-embedding-3-small",
  "input": "hello world"
}
```

Support both `input: string` and `input: string[]`. For an array input,
return one embedding object per item in the same order.

Success response shape:

```json
{
  "object": "list",
  "data": [
    {
      "object": "embedding",
      "index": 0,
      "embedding": [0.123, -0.456]
    }
  ],
  "model": "openai/text-embedding-3-small",
  "usage": {
    "prompt_tokens": 0,
    "total_tokens": 0
  }
}
```

Required runtime behavior:

- Every returned embedding must be exactly 1536 floats.
- Output must be deterministic across runs and platforms.
- Implement determinism with a pure hash-based algorithm, not
  `Math.random()`.
- Recommended algorithm: UTF-8 encode each input string, derive
  repeated SHA-256 blocks from `input + ":" + block_index`, expand
  until 1536 bytes are available, then map each byte to a float in
  `[-1, 1]` with fixed rounding such as six decimal places.
- If any input element is exactly `"__fail_embed__"`, fail the entire
  request with `500` and a JSON error payload.
- If any input element is exactly `"__slow_embed__"`, delay the
  response by roughly 5000 ms before returning the normal deterministic
  success payload.

Error response for the failure trigger:

```json
{
  "error": {
    "type": "mock_embedding_failure",
    "message": "Triggered mock embedding failure"
  }
}
```

`tests/mock-inference/fixtures/embeddings.json` should contain a small
golden set of request/response pairs used by the smoke test to prove
the algorithm has not changed accidentally.

#### `POST /chat/completions`

Request body should accept the normal OpenAI-style fields memex will
eventually send, at minimum:

```json
{
  "model": "openai/gpt-4o-mini",
  "messages": [
    { "role": "system", "content": "..." },
    { "role": "user", "content": "..." }
  ]
}
```

Fixture lookup contract:

1. Parse the request body as JSON.
2. Canonicalize it by recursively sorting object keys while preserving
   array order.
3. Stable-stringify the canonicalized JSON.
4. Compute SHA-256 of that canonical string.
5. Match the hash against entries in `tests/mock-inference/fixtures/chat.json`.

Recommended `chat.json` shape:

```json
[
  {
    "name": "metadata-basic",
    "request": { "model": "...", "messages": [] },
    "response": { "id": "chatcmpl-mock-001", "object": "chat.completion" }
  }
]
```

Success behavior:

- Return the exact `response` object from the matching fixture.
- Preserve the response body's fields and values exactly as stored in
  the fixture. JSON whitespace formatting does not matter.

Missing-fixture behavior:

- Return `400`.
- Response body must include the computed request hash and a short
  message that the operator needs to add a fixture intentionally.

Example error shape:

```json
{
  "error": {
    "type": "mock_chat_fixture_missing",
    "message": "No chat fixture found for request hash 0123abcd..."
  }
}
```

The mock service must never call real network services. All responses
must come from deterministic local logic or checked-in fixtures.

## 4. Implementation Plan

### Phase 1: Create the Test Harness Skeleton

Files to create:

- `tests/integration/.gitkeep`

Tasks:

- Create `tests/`, `tests/unit/`, `tests/integration/`,
  `tests/fixtures/`, `tests/mock-inference/`, and
  `tests/mock-inference/fixtures/`.
- Keep the scope limited to test-platform scaffolding; do not create
  `mcp-server/`, `sync-daemon/`, or `migrations/` yet.
- Reserve `tests/integration/` now so sprint 001 can drop migration
  tests into a stable path immediately.

### Phase 2: Author the Compose Environment

Files to create:

- `tests/compose.yaml`

Tasks:

- Define a `postgres` service using `pgvector/pgvector:pg16`.
- Configure `POSTGRES_DB=memex_test`,
  `POSTGRES_USER=memex_test`, and `POSTGRES_PASSWORD=memex_test`.
- Bind PostgreSQL to `127.0.0.1:55432`.
- Define a `mock-inference` service built from
  `tests/mock-inference/Dockerfile`.
- Bind the mock service to `127.0.0.1:58000`.
- Omit the Compose `version:` field explicitly.
- Use a named or anonymous volume that is always removed by
  `down -v`.
- Keep the file small and readable; no extra services belong in sprint
  000.

### Phase 3: Implement the Mock Inference Runtime

Files to create:

- `tests/mock-inference/Dockerfile`
- `tests/mock-inference/main.ts`

Tasks:

- Use a minimal Deno image or install Deno in the container.
- Keep `main.ts` close to the roadmap intent: small, direct, and free
  of framework overhead.
- Implement `GET /health`.
- Implement `POST /embeddings` with the deterministic hash-expansion
  algorithm and the two special input triggers.
- Implement `POST /chat/completions` using canonical-request hashing
  against checked-in fixtures.
- Reject unknown routes with `404`.
- Reject malformed JSON with `400`.
- Add an inline comment referencing architecture Section 9 and noting
  that the mock is deliberately incomplete by design.

### Phase 4: Add Mock Service Fixtures

Files to create:

- `tests/mock-inference/fixtures/embeddings.json`
- `tests/mock-inference/fixtures/chat.json`

Tasks:

- Add at least two golden embedding fixture cases:
  - one simple ASCII input
  - one multiline or Unicode input
- Store full expected JSON responses in `embeddings.json` so the smoke
  test can compare exact payloads.
- Add at least two chat completion fixtures in `chat.json`:
  - one minimal metadata-style extraction request
  - one variant request proving the hash lookup distinguishes different
    request bodies
- Keep fixture requests and responses human-readable and stable.
- Document in the fixture content itself that new responses must be
  added intentionally, never auto-recorded during test runs.

### Phase 5: Create the Shared Canonicalization Fixture Corpus

Files to create:

- `tests/fixtures/canonicalization-cases.json`

Tasks:

- Keep the file as an array of simple `{ "input": "...", "expected": "..." }`
  objects so SQL, TypeScript, and Python tests can all consume it with
  trivial parsers.
- Seed the file with a minimum of 24 cases. At minimum include cases
  for:
  - already-canonical LF content
  - empty string becoming exactly `"\n"`
  - BOM stripping
  - lone `\r` normalization to `\n`
  - CRLF normalization to LF
  - trailing newline collapse from many to exactly one
  - leading newlines preserved
  - trailing spaces preserved
  - markdown double-space line breaks preserved
  - tabs preserved
  - indentation preserved in code-block-like content
  - NFC no-op on already composed text
  - NFD to NFC normalization such as `"Cafe\u0301"` -> `"Café\n"`
  - emoji preserved
  - combining character sequences preserved after NFC
  - mixed BOM + CRLF + NFD in one input
  - very long single-line content
  - very long multiline content
  - Unicode beyond BMP
  - content ending without newline
  - content ending with one newline
  - content ending with many newlines
  - multiple blank lines in the middle preserved
  - indented markdown list or code sample preserved
- Make the expected outputs match Section 6.4 exactly:
  UTF-8 text, BOM stripped, LF-only, exactly one trailing newline,
  NFC, internal whitespace preserved.

### Phase 6: Write the End-to-End Smoke Test

Files to create:

- `tests/unit/smoke.test.ts`

Tasks:

- Use Deno for the smoke test so sprint 000 has one runtime for both
  the mock service and the initial test code.
- Read `MEMEX_TEST_INFERENCE_BASE` from the environment, defaulting to
  `http://127.0.0.1:58000` for local runs.
- Validate `/health` returns `200` and the expected JSON payload.
- Replay every request in `tests/mock-inference/fixtures/embeddings.json`
  and assert deep equality on the response.
- Send the same non-fixture embedding request twice and assert deep
  equality to prove deterministic generation outside the golden cases.
- Send a different embedding request and assert the response differs.
- Assert the returned embedding length is 1536.
- Verify `__fail_embed__` returns `500`.
- Verify `__slow_embed__` takes at least 5 seconds and then succeeds.
- Replay every request in `tests/mock-inference/fixtures/chat.json` and
  assert the exact fixture response is returned.
- Send one intentionally unknown chat request and assert `400` plus the
  missing-fixture hash error.
- Parse `tests/fixtures/canonicalization-cases.json` and assert:
  - the file is valid JSON
  - every entry contains string `input` and string `expected`
  - the file contains at least 24 entries
  - sentinel cases for every Section 6.4 rule are present

### Phase 7: Build the One-Button Runner and Contributor Docs

Files to create:

- `tests/run-tests.sh`
- `tests/README.md`

Tasks:

- Implement `tests/run-tests.sh` with `set -euo pipefail`.
- Fail fast if `docker`, `docker compose`, `curl`, or `deno` are
  missing.
- Do not require host `pg_isready`; the runner must work with only
  Docker/Colima and Deno installed.
- Run `docker compose -f tests/compose.yaml config` before startup to
  catch syntax issues early.
- Always run `docker compose -f tests/compose.yaml down -v --remove-orphans`
  before exit via `trap`.
- On failure, print `docker compose logs --no-color` before teardown.
- Wait for PostgreSQL readiness with
  `docker compose ... exec -T postgres pg_isready`.
- Wait for mock inference readiness with host-side `curl`.
- Export the common `MEMEX_TEST_*` variables before invoking
  `deno test --allow-net --allow-read tests/unit/smoke.test.ts`.
- Keep execution serial. Do not add concurrency flags or background
  test shards.
- In `tests/README.md`, document:
  - Colima as the recommended macOS runtime
  - Docker Desktop as acceptable alternative
  - Deno installation
  - fixed ports `55432` and `58000`
  - how to run the full suite
  - how to run only the smoke test
  - how to add canonicalization fixtures
  - how to add chat or embedding fixtures
  - how to manually inspect the running services

### Phase 8: Add GitHub Actions CI

Files to create:

- `.github/workflows/test.yml`

Tasks:

- Trigger on both `push` and `pull_request`.
- Keep permissions minimal, ideally `contents: read`.
- Check out the repository.
- Install Deno via an action rather than a custom shell script.
- Run `./tests/run-tests.sh` exactly as local development does.
- Do not configure secrets; sprint 000 should be fork-safe by design.
- Do not split CI into separate service-container and Compose paths;
  use the same `tests/compose.yaml` file as local development.
- Keep the workflow small and easy to debug.

## 5. Verification Plan

### 5.1 Automated Checks

| Check | What It Validates | File | Executor Implementation Notes |
|---|---|---|---|
| Compose config validation | `tests/compose.yaml` is syntactically valid and all build/image references resolve before startup | `tests/run-tests.sh` | Run `docker compose -f tests/compose.yaml config >/dev/null` before `up -d --build`; fail immediately if invalid |
| Clean startup and teardown | The stack can be started and always torn down with volumes removed, even on failure | `tests/run-tests.sh` | Use `trap` to call `docker compose -f tests/compose.yaml down -v --remove-orphans`; run the same cleanup before startup to remove leftovers from aborted runs |
| PostgreSQL readiness | The `pgvector/pgvector:pg16` container is accepting connections before tests begin | `tests/run-tests.sh` | Poll `docker compose -f tests/compose.yaml exec -T postgres pg_isready -U memex_test -d memex_test` with a timeout and clear failure message |
| Mock service readiness | The mock HTTP server is reachable on the documented host port before tests begin | `tests/run-tests.sh` | Poll `curl -fsS http://127.0.0.1:58000/health` until success or timeout |
| Health endpoint contract | `/health` returns `200` and the expected JSON body | `tests/unit/smoke.test.ts` | Use `fetch`; assert status code and exact parsed JSON |
| Embedding golden fixtures | Known requests continue returning the exact saved JSON payloads | `tests/unit/smoke.test.ts` and `tests/mock-inference/fixtures/embeddings.json` | Load the fixture file, replay each request against `/embeddings`, and deep-compare the full response body |
| Embedding determinism | Non-fixture embedding generation is stable and 1536-dimensional | `tests/unit/smoke.test.ts` | Send the same request twice and assert deep equality; assert `data[0].embedding.length === 1536`; send a different request and assert inequality |
| Failure-mode triggers | The mock service exposes the two documented embedding failure modes | `tests/unit/smoke.test.ts` | Assert `__fail_embed__` returns `500`; measure elapsed wall time for `__slow_embed__` and require a delay threshold of at least ~5000 ms before success |
| Chat fixture replay | Known chat requests return the exact canned responses and unknown requests fail deterministically | `tests/unit/smoke.test.ts` and `tests/mock-inference/fixtures/chat.json` | Replay every fixture request and deep-compare responses; then send one unknown request and assert `400` plus the computed hash in the error JSON |
| Canonicalization fixture sanity | The shared corpus is valid JSON, cross-language-friendly, and covers every authoritative canonicalization rule | `tests/unit/smoke.test.ts` and `tests/fixtures/canonicalization-cases.json` | Parse the file, assert every entry is `{input, expected}` with strings, assert minimum case count, and assert sentinel cases for BOM, CRLF, trailing newline collapse, NFC normalization, preserved whitespace, emoji, and very long content exist |
| CI parity | CI executes the same local runner path, not a second bespoke test path | `.github/workflows/test.yml` | Workflow must invoke `./tests/run-tests.sh` directly; no separate service-container-only implementation |

The automated-check strategy answers the intent's open questions as
follows:

- Smoke test language: use Deno, because the mock service already uses
  Deno and the smoke test needs only HTTP and JSON assertions.
- CI topology: use Docker Compose in CI, not a split service-container
  design, to keep one source of truth.
- Canonicalization coverage: require a minimum 24-case corpus plus
  explicit sentinel checks for every Section 6.4 rule.
- Compose version pinning: omit `version:` and validate with
  `docker compose config`.
- Test-runner concurrency: keep the automated path serial in sprint
  000.

### 5.2 Manual Verification Steps

1. Start the local container runtime if needed.

   Command:

   ```bash
   colima start
   ```

   Expected result: Colima starts successfully, or Docker Desktop is
   already running.

2. Run the full test harness.

   Command:

   ```bash
   ./tests/run-tests.sh
   ```

   Expected result: the script prints startup, readiness, test, and
   teardown phases; exits `0`; and leaves no running sprint-000
   containers afterward.

3. Bring the stack up manually for inspection.

   Command:

   ```bash
   docker compose -f tests/compose.yaml up -d --build
   ```

   Expected result: both `postgres` and `mock-inference` containers are
   running.

4. Verify PostgreSQL readiness.

   Commands:

   ```bash
   docker compose -f tests/compose.yaml exec -T postgres pg_isready -U memex_test -d memex_test
   pg_isready -h 127.0.0.1 -p 55432
   ```

   Expected result: the first command must succeed and report
   "accepting connections". The second command is optional host-side
   validation for operators who have PostgreSQL client tools installed.

5. Verify the mock health endpoint.

   Command:

   ```bash
   curl -sS http://127.0.0.1:58000/health
   ```

   Expected result:

   ```json
   {"status":"ok","service":"mock-inference"}
   ```

6. Verify deterministic embeddings by replaying the same request twice
   and diffing the results.

   Commands:

   ```bash
   curl -sS -X POST http://127.0.0.1:58000/embeddings \
     -H 'content-type: application/json' \
     -d '{"model":"openai/text-embedding-3-small","input":"determinism check"}' \
     > /tmp/memex-embed-a.json

   curl -sS -X POST http://127.0.0.1:58000/embeddings \
     -H 'content-type: application/json' \
     -d '{"model":"openai/text-embedding-3-small","input":"determinism check"}' \
     > /tmp/memex-embed-b.json

   diff -u /tmp/memex-embed-a.json /tmp/memex-embed-b.json
   ```

   Expected result: `diff` prints nothing.

7. Verify the failure and slow-path triggers.

   Commands:

   ```bash
   curl -sS -o /tmp/memex-fail.json -w '%{http_code}\n' \
     -X POST http://127.0.0.1:58000/embeddings \
     -H 'content-type: application/json' \
     -d '{"model":"openai/text-embedding-3-small","input":"__fail_embed__"}'

   time curl -sS -X POST http://127.0.0.1:58000/embeddings \
     -H 'content-type: application/json' \
     -d '{"model":"openai/text-embedding-3-small","input":"__slow_embed__"}' \
     > /tmp/memex-slow.json
   ```

   Expected result: the first command prints `500`. The second command
   succeeds, and wall time is roughly 5 seconds or more.

8. Verify a canned chat fixture.

   Command:

   ```bash
   deno eval 'const f = JSON.parse(Deno.readTextFileSync("tests/mock-inference/fixtures/chat.json")); console.log(JSON.stringify(f[0].request));' \
     | curl -sS -X POST http://127.0.0.1:58000/chat/completions \
         -H 'content-type: application/json' \
         --data-binary @-
   ```

   Expected result: the response body matches
   the parsed JSON object stored in
   `tests/mock-inference/fixtures/chat.json` entry `.[0].response`.

9. Verify cleanup.

   Commands:

   ```bash
   docker compose -f tests/compose.yaml down -v --remove-orphans
   docker compose -f tests/compose.yaml ps
   ```

   Expected result: the first command removes containers and volumes;
   the second command shows no running services.

10. Verify CI manually after pushing the branch.

    Expected result: GitHub Actions runs the `test` workflow on both
    branch pushes and pull requests, including forked PRs, without any
    secrets configuration.

### 5.3 Regression Scenarios

None in sprint 000. This sprint introduces the first executable code in
the repository, so the checks above are acceptance tests rather than
regression tests. Later sprints should treat this platform as the
baseline and add regression coverage on top of it.

### 5.4 Sprint-Specific Gotchas

- Determinism is non-negotiable. Verify it with two identical requests
  and `diff`, not just by eyeballing values.
- The mock service must remain offline. No fallback HTTP calls, no
  proxying, no "record once" fixture behavior.
- `tests/run-tests.sh` must not require a host PostgreSQL client. The
  documented optional host-side `pg_isready` command is for manual
  debugging only.
- Keep Compose serial in sprint 000. Fixed ports plus parallel runs are
  a recipe for flaky failures.
- Omit `version:` in `tests/compose.yaml` and call this out in
  `tests/README.md` so the operator understands the Compose v2
  expectation.
- Port collisions are possible but unlikely. If `55432` or `58000` are
  already in use locally, stop the conflicting process during manual
  verification; do not silently change repository defaults.

## 6. Files Summary

### Orchestration and CI

- `.github/workflows/test.yml`
- `tests/compose.yaml`
- `tests/run-tests.sh`
- `tests/README.md`

### Mock Inference Service

- `tests/mock-inference/Dockerfile`
- `tests/mock-inference/main.ts`
- `tests/mock-inference/fixtures/embeddings.json`
- `tests/mock-inference/fixtures/chat.json`

### Shared Test Fixtures

- `tests/fixtures/canonicalization-cases.json`

### Test Code and Reserved Paths

- `tests/unit/smoke.test.ts`
- `tests/integration/.gitkeep`

## 7. Definition of Done

- [ ] `tests/compose.yaml` starts `pgvector/pgvector:pg16` on
      `127.0.0.1:55432` and the mock inference service on
      `127.0.0.1:58000`.
- [ ] `tests/compose.yaml` omits the Compose `version:` field.
- [ ] `tests/mock-inference/main.ts` implements `GET /health`,
      `POST /embeddings`, and `POST /chat/completions` with no outbound
      network dependency.
- [ ] `POST /embeddings` returns deterministic 1536-dimensional vectors
      for repeated identical requests.
- [ ] `POST /embeddings` returns `500` for `__fail_embed__` and delays
      about 5 seconds for `__slow_embed__`.
- [ ] `POST /chat/completions` returns exact canned fixture responses
      and returns `400` with a request hash for unknown requests.
- [ ] `tests/fixtures/canonicalization-cases.json` contains at least 24
      valid `{input, expected}` cases covering every Section 6.4 rule.
- [ ] `tests/unit/smoke.test.ts` passes locally against the live Compose
      stack.
- [ ] `./tests/run-tests.sh` succeeds from a clean clone with Docker or
      Colima and Deno installed, and leaves no leftover containers or
      volumes after completion.
- [ ] `.github/workflows/test.yml` runs on `push` and `pull_request`
      and invokes `./tests/run-tests.sh` directly.
- [ ] `tests/README.md` documents prerequisites, local execution,
      manual inspection commands, and fixture-maintenance workflow.

## 8. Risks & Mitigations

| Risk | Why It Matters | Mitigation |
|---|---|---|
| Choosing a different runtime for the smoke test later | Open Question 1: changing runtimes early creates avoidable scaffolding churn | Use Deno now for both the mock service and smoke test; keep the test simple and standalone so replacing it later is cheap if needed |
| CI drift from local behavior | Open Question 2: separate CI service definitions would create two test platforms to maintain | Run the same Compose file and the same `tests/run-tests.sh` entrypoint in CI |
| Canonicalization undercoverage | Open Question 3: later SQL, TS, and Python implementations could disagree silently | Require a minimum 24-case corpus, include explicit weird-content cases, and gate the fixture file in smoke tests |
| Compose compatibility confusion | Open Question 4: operators may expect a `version:` field or older Compose behavior | Omit `version:` intentionally, validate with `docker compose config`, and document Compose v2 expectation in `tests/README.md` |
| Port conflicts on `58000` | Open Question 5: a local service may already occupy the mock API port | Keep `58000` as the repository default, bind to `127.0.0.1`, and document manual preflight checks if a workstation collision occurs |
| Port conflicts on `55432` | Open Question 6: a local PostgreSQL instance could already bind the chosen port | Keep `55432` as the default because it avoids the common `5432` collision; document collision troubleshooting instead of changing the repo default casually |
| CI behavior on forked PRs | Open Question 7: secrets restrictions can break workflows unexpectedly | Use no secrets, no write permissions, and only public images/actions so forked PRs work unchanged |
| Premature parallel test execution | Open Question 8: concurrency adds complexity without current value and conflicts with fixed ports | Keep the runner serial in sprint 000 and revisit only when the test suite becomes materially slow |
| Mock service contract drift | Future server code may expect a slightly different OpenAI-compatible payload shape | Use conventional OpenAI-style request/response JSON now, and enforce it with fixture replay tests |
| Flaky teardown leaving state behind | Leftover containers or volumes will poison later test runs | Clean up before and after every run, and print logs before teardown on failure so issues can be debugged without preserving state |

## 9. Dependencies

### Must Exist Before Sprint 000 Starts

- The current repository baseline:
  `README.md`, `ROADMAP.md`, `memex-architecture.md`, and the
  `docs/sprints/` infrastructure
- Local Docker-compatible runtime for execution:
  Colima on macOS is recommended; Docker Desktop is acceptable
- Deno available locally and installable in CI
- GitHub Actions enabled for the `wuertele/mcp-memex` repository

There are no code dependencies from earlier sprints; sprint 000 is the
first implementation sprint.

### Produced by Sprint 000 for Later Sprints

- Disposable PostgreSQL test environment on a stable port
- Deterministic mock inference API with documented failure modes
- Shared canonicalization fixture corpus consumed by sprints 001, 003,
  and 005
- `tests/integration/` path reserved for sprint 001 migration tests
- One-button local runner reused by every later sprint
- CI workflow proving the repository can test itself on every push and
  PR

## 10. Open Questions

These are the remaining operator decisions to confirm before or during
execution. Recommended defaults are included.

1. Smoke test language: default to Deno. Confirm there is no strong
   reason to introduce a second runtime this early.
2. CI topology: default to Docker Compose in CI using the same
   `tests/compose.yaml` file as local development.
3. Canonicalization corpus size: default to 24 seeded cases. Confirm
   whether the operator wants additional known-weird real-world content
   patterns included now.
4. Fixed-port viability: confirm `58000` and `55432` do not collide on
   the operator's workstation during manual verification. Keep those
   defaults unless a common collision emerges.
5. Fork-safe CI: confirm the repository should accept the default
   secret-free workflow behavior on PRs from forks.
6. Serial runner policy: confirm sprint 000 should stay single-threaded
   even if future sprints later add optional parallelism.
