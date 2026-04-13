# Sprint 000: Test Platform and CI Scaffolding

**Status:** Planned
**Based on:** Codex draft with Claude's verification rigor merged in, informed by operator interview
**Prerequisites:** None (first sprint)
**Produces for later sprints:** Disposable PostgreSQL + pgvector test environment, deterministic mock inference API, shared canonicalization fixture corpus, one-button runner, GitHub Actions CI

---

## 1. Overview

Sprint 000 establishes the first executable infrastructure in mcp-memex: an offline, reproducible test platform that mirrors the two external boundaries every later sprint depends on — PostgreSQL with pgvector and an OpenAI-compatible inference API. Sprint 001 cannot validate its migrations without a disposable database, and later server and daemon sprints need a shared fixture corpus, a stable mock inference contract, and one test entrypoint that behaves identically locally and in CI.

The sprint delivers a single source of truth for test execution: `./tests/run-tests.sh` starts Docker Compose, waits for readiness, runs a smoke test, and tears everything down. GitHub Actions invokes that same script rather than reimplementing the test flow. Cross-implementation consistency between the future SQL trigger (sprint 001), TypeScript `canonicalize.ts` (sprint 003), and Python `canonicalize.py` (sprint 005) is anchored by a shared JSON file of canonicalization test vectors introduced in this sprint.

The sprint does **not** produce any application code. It does not create `migrations/`, `mcp-server/`, or `sync-daemon/` directories. Its deliverable is the test platform itself and a placeholder smoke test that validates the platform works before any feature code exists.

## 2. Use Cases

| # | Scenario | Inputs | Expected Behavior |
|---|---|---|---|
| 1 | Fresh local test run | Operator runs `./tests/run-tests.sh` from a clean clone with Colima (or Docker Desktop) and Deno installed | Script validates prerequisites, starts Compose, waits for PostgreSQL and mock inference readiness, runs the smoke test, tears down cleanly, and exits 0 |
| 2 | PostgreSQL readiness from the host | After `./tests/run-tests.sh` brings Compose up, the smoke test opens a TCP connection to `127.0.0.1:55432` | Connection succeeds; proves the host port binding is real, not just container-internal |
| 3 | Mock health check | `GET http://127.0.0.1:58000/health` | Returns 200 with a small JSON body indicating the mock service is healthy |
| 4 | Deterministic embeddings | Two identical `POST /embeddings` requests with the same `input` and `model` | Both responses are byte-identical JSON with a 1536-element embedding vector and the same model echo |
| 5 | Different inputs produce different embeddings | Two `POST /embeddings` requests with different `input` values | The returned `embedding` arrays differ; proves the generator isn't a degenerate constant function |
| 6 | Embedding failure trigger | `POST /embeddings` with `input == "__fail_embed__"` | Returns 500 with a JSON error payload; no outbound network calls |
| 7 | Slow embedding trigger | `POST /embeddings` with `input == "__slow_embed__"` | Responds successfully after approximately 5000ms delay; elapsed wall time is ≥4500ms and <15000ms |
| 8 | Canned chat response | `POST /chat/completions` matching a known fixture request | Returns the exact canned response associated with that fixture, matched via canonical JSON hashing of the request |
| 9 | Missing chat fixture | `POST /chat/completions` with a request not in fixtures | Returns 400 with a deterministic request hash in the error body, so the operator can add a new fixture by copying the hash into `chat.json` |
| 10 | Canonicalization corpus sanity | Smoke test loads `tests/fixtures/canonicalization-cases.json` | File parses, contains ≥22 valid entries, covers every authoritative rule from `memex-architecture.md` Section 6.4, and has each boundary case (empty string, single newline, whitespace-only) present |
| 11 | Clean state between runs | Operator runs `./tests/run-tests.sh` twice in succession | Second run starts from empty containers and fresh volumes; leftover state from the first run cannot affect results |
| 12 | CI on push and PR | GitHub Actions runs on `push` and `pull_request` events, including forks | Workflow succeeds without secrets, uses the same runner and Compose path as local development, and completes within the 10-minute timeout |

## 3. Architecture

### 3.1 Test Platform Shape

Sprint 000 creates a minimal test harness around the same boundaries the real system will use later:

1. **`tests/compose.yaml`** starts two containers:
   - `postgres` using `pgvector/pgvector:pg16`, bound to `127.0.0.1:55432`
   - `mock-inference` built from `tests/mock-inference/Dockerfile`, bound to `127.0.0.1:58000`

2. **`tests/run-tests.sh`** is the one-button orchestrator:
   - Validates local prerequisites (docker, docker compose, deno, reachable Docker daemon)
   - Pre-flight port availability check via `bash /dev/tcp`
   - Brings the Compose stack up
   - Waits for service readiness
   - Exports common test environment variables
   - Runs the Deno smoke test
   - Prints logs on failure
   - Tears down with `down -v --remove-orphans`

3. **`tests/unit/smoke.test.ts`** is the first executable test suite:
   - Hits the live mock service over HTTP
   - Opens a TCP connection to the PostgreSQL host port
   - Validates the canonicalization fixture file
   - Proves the runner works end-to-end before any feature code exists

4. **`.github/workflows/test.yml`** runs the same shell entrypoint in CI.

This mirrors the architectural boundary from `memex-architecture.md` Section 4 without prematurely introducing application code. The real MCP server and sync daemon do not exist yet, but the database and inference dependencies they will consume are available under fixed, documented ports.

### 3.2 Repository Layout After Sprint 000

```text
mcp-memex/
├── .github/
│   └── workflows/
│       └── test.yml                       # CI workflow (new)
├── deno.json                              # repo-root Deno config (new)
├── docs/
│   └── sprints/
│       └── ...                            # existing
├── tests/                                 # new
│   ├── README.md                          # contributor docs
│   ├── compose.yaml                       # Docker Compose definition
│   ├── run-tests.sh                       # one-button runner
│   ├── lib/
│   │   └── wait-for.sh                    # defensive wait helper
│   ├── fixtures/
│   │   └── canonicalization-cases.json    # shared cross-language vectors
│   ├── integration/
│   │   └── .gitkeep                       # reserved for sprint 001+
│   ├── mock-inference/
│   │   ├── Dockerfile
│   │   ├── main.ts
│   │   └── fixtures/
│   │       ├── chat.json                  # canonical-hash keyed fixtures
│   │       └── embeddings.json            # golden replay fixtures
│   └── unit/
│       └── smoke.test.ts                  # platform-validation smoke test
├── LICENSE
├── README.md
├── ROADMAP.md
└── memex-architecture.md
```

The only new placeholder directory proactively created is `tests/integration/`, because sprint 001 lands migration tests there immediately and the path should already exist. Sprint 000 does **not** create `migrations/`, `mcp-server/`, or `sync-daemon/`; those belong to their respective sprints.

### 3.3 Compose Topology and Runtime Conventions

- Omit the Compose `version:` field. Compose v2 is the project baseline; current best practice is to rely on the latest spec.
- Bind both services to `127.0.0.1` only (never `0.0.0.0`), to prevent accidental LAN exposure of the test database:
  - PostgreSQL: `127.0.0.1:55432 → 5432`
  - Mock inference: `127.0.0.1:58000 → 8000`
- Use fixed default ports so later tests and docs can rely on stable addresses.
- Use a named Docker network (`memex-test-net`) to keep containers isolated.
- Use an anonymous volume for PostgreSQL data that `down -v` removes cleanly.
- The runner always invokes Compose with `-p memex-test` so concurrent local invocations fail loudly on container name collision rather than silently reusing another run's state.
- Teardown is always `docker compose -p memex-test -f tests/compose.yaml down -v --remove-orphans` (via `trap`), so every run starts clean even after an interrupted previous run.

**`tests/run-tests.sh` exports the following environment contract** for consumption by the smoke test and by future sprints:

```
MEMEX_TEST_DB_HOST=127.0.0.1
MEMEX_TEST_DB_PORT=55432
MEMEX_TEST_DB_NAME=memex_test
MEMEX_TEST_DB_USER=memex_test
MEMEX_TEST_DB_PASSWORD=memex_test
MEMEX_TEST_INFERENCE_BASE=http://127.0.0.1:58000
```

### 3.4 Mock Inference Service API Contract

The mock service is intentionally small and deterministic. It does not try to emulate a real provider in full; it implements only the surface mcp-memex will consume.

#### `GET /health`

- No request body
- Response: `200 OK`
- Response body:
  ```json
  {
    "status": "ok",
    "service": "mock-inference",
    "version": "0.1.0"
  }
  ```

#### `POST /embeddings`

Request body (OpenAI-compatible):

```json
{
  "model": "openai/text-embedding-3-small",
  "input": "hello world"
}
```

Support both `input: string` and `input: string[]`. For array inputs, return one embedding object per array element in the same order.

Success response shape:

```json
{
  "object": "list",
  "data": [
    {
      "object": "embedding",
      "index": 0,
      "embedding": [0.0123456789, -0.0234567891, /* ... 1534 more floats ... */]
    }
  ],
  "model": "openai/text-embedding-3-small",
  "usage": { "prompt_tokens": 0, "total_tokens": 0 }
}
```

**Special inputs** (checked as exact string equality before running the embedding algorithm):

- `input == "__fail_embed__"` or any array element equal to `"__fail_embed__"`: respond with 500 and this body:
  ```json
  {
    "error": {
      "type": "mock_embedding_failure",
      "message": "Triggered mock embedding failure"
    }
  }
  ```
- `input == "__slow_embed__"` or any array element equal to `"__slow_embed__"`: delay with `await new Promise(r => setTimeout(r, 5000))`, then return the normal deterministic success payload. Total wall time must be approximately 5000ms; the smoke test asserts ≥4500ms AND <15000ms.

#### Embedding Algorithm — Pinned Specification

The algorithm is specified exactly so future sprints can predict vectors for a given input and so cross-runtime reproducibility is guaranteed. **Implementers must not deviate from this specification without a migration plan.**

**Inputs:** a UTF-8 string `input_text`.

**Steps:**

1. **Compute the seed.** Let `seed = SHA-256(utf8_bytes(input_text))`. This is 32 bytes.

2. **Expand to 6144 bytes.** For `counter in 0..192` (exclusive), compute:
   ```
   block[counter] = SHA-256(seed || counter_big_endian_u32_bytes)
   ```
   where `counter_big_endian_u32_bytes` is a 4-byte big-endian encoding of `counter`. Each block is 32 bytes. Concatenate all 192 blocks to produce exactly 192 × 32 = 6144 bytes of expanded material.

3. **Decode to 1536 floats.** For each `i in 0..1536` (exclusive):
   - Extract 4 bytes starting at offset `i * 4` from the expanded material.
   - Interpret as a big-endian unsigned 32-bit integer `u`.
   - Compute `f = (u / 4294967295.0) * 2.0 - 1.0` — mapping `u` from `[0, 2^32 - 1]` to the closed interval `[-1.0, 1.0]`.
   - Append `f` to the output vector.

4. **L2-normalize** the resulting 1536-dim vector:
   ```
   norm = sqrt(sum(f[i]^2 for i in 0..1536))
   for i in 0..1536: f[i] = f[i] / norm
   ```
   Real OpenAI `text-embedding-3-small` returns L2-normalized vectors, so the mock does too.

5. **Serialize** using JavaScript's default JSON number formatting (no custom rounding). Golden fixtures are generated by running the algorithm once and checking in the exact output; any future refactor that changes output bytes (e.g., a different Deno version or a Number.prototype.toString difference) will be caught by the fixture replay tests in the smoke suite.

**Why this exact algorithm:** SHA-256 is cryptographically secure and deterministic across all runtime implementations. Counter expansion is standard practice for stretching a seed to any length. Big-endian is chosen for canonical byte ordering. L2 normalization matches real model output. The algorithm is pinned here so Sprint 003 (MCP server implementing `capture_thought`) and any future test that asserts specific vectors can depend on reproducibility.

#### `POST /chat/completions`

Request body (OpenAI-compatible):

```json
{
  "model": "openai/gpt-4o-mini",
  "messages": [
    { "role": "system", "content": "..." },
    { "role": "user", "content": "..." }
  ]
}
```

**Fixture lookup contract:**

1. Parse the request body as JSON.
2. Canonicalize it: recursively sort object keys (arrays preserve insertion order).
3. Stable-stringify the canonicalized JSON (no whitespace between tokens).
4. Compute `SHA-256` of the UTF-8 bytes of that canonical string.
5. Match the hex-encoded hash against entries in `tests/mock-inference/fixtures/chat.json`.

**At service startup**, the mock reads `chat.json`, canonicalizes each entry's `request` field using the same function, computes the hash, and builds an in-memory `Map<hash, response>`. Lookups against incoming requests use the same canonicalization function, so key order in the stored fixtures does not affect matching.

**`chat.json` schema:**

```json
[
  {
    "name": "metadata-basic",
    "request": {
      "model": "openai/gpt-4o-mini",
      "messages": [
        { "role": "system", "content": "Extract metadata..." },
        { "role": "user", "content": "Hello world" }
      ]
    },
    "response": {
      "id": "chatcmpl-mock-001",
      "object": "chat.completion",
      "model": "openai/gpt-4o-mini",
      "choices": [
        {
          "index": 0,
          "message": {
            "role": "assistant",
            "content": "{\"topics\":[\"greeting\"],\"people\":[],\"type\":\"observation\"}"
          },
          "finish_reason": "stop"
        }
      ]
    }
  }
]
```

**Success behavior:** return the exact `response` object from the matching fixture.

**Missing-fixture behavior:** return 400 with:

```json
{
  "error": {
    "type": "mock_chat_fixture_missing",
    "message": "No chat fixture found for request hash 0123abcd...",
    "request_hash": "0123abcd..."
  }
}
```

This makes adding a new fixture mechanical: copy the returned hash into a new entry in `chat.json`, add the expected response, restart the service.

#### Unknown Routes and Malformed Requests

- Unknown routes return 404 with a structured JSON error body.
- Malformed JSON returns 400 with a structured JSON error body.
- The service **never** makes outbound network calls. No fallback, no proxy, no "record once" behavior.

### 3.5 Runner Flow

`tests/run-tests.sh` (`bash`, `set -euo pipefail`):

```
1. Resolve REPO_ROOT via git rev-parse --show-toplevel; cd there.
2. Preflight:
   - docker binary exists
   - docker compose subcommand exists
   - deno binary exists
   - docker info succeeds (i.e., Colima/Docker Desktop is running)
   - ports 55432 and 58000 are not bound (bash /dev/tcp check)
3. COMPOSE="docker compose -p memex-test -f tests/compose.yaml"
4. trap cleanup EXIT INT TERM
   where cleanup runs $COMPOSE down -v --remove-orphans >/dev/null 2>&1 || true
5. Pre-run cleanup: call cleanup once before starting, to catch leftover state.
6. Validate compose config: $COMPOSE config > /dev/null.
7. Bring up: $COMPOSE up -d --build --wait.
8. Belt-and-suspenders: source tests/lib/wait-for.sh, wait_for_http
   http://127.0.0.1:58000/health 60 and
   $COMPOSE exec -T postgres pg_isready -U memex_test -d memex_test with polling.
9. Export MEMEX_TEST_* environment variables.
10. Run: deno test --allow-net --allow-read --allow-env tests/unit/
11. Exit with the test runner's exit code; trap handles teardown.
12. On failure, print $COMPOSE logs --no-color before trap-driven teardown.
```

No parallelism. No test selection flags. One run, one result.

### 3.6 `tests/lib/wait-for.sh` Contract

Exposes two shell functions:

- `wait_for_port HOST PORT TIMEOUT_SECONDS` — uses `bash /dev/tcp/HOST/PORT` in a loop. No `nc` dependency. Returns non-zero on timeout.
- `wait_for_http URL TIMEOUT_SECONDS` — uses `curl -fsS` in a loop. Returns non-zero on timeout.

These are fallbacks for when `docker compose --wait` is unavailable or a service's healthcheck hasn't been declared yet. On modern Compose versions with `--wait`, these functions become no-ops in practice.

## 4. Implementation Plan

Eight phases, each independently reviewable. Each phase lists the files it creates or modifies and the tasks within it.

### Phase 1 — Directory Skeleton and Placeholders

**Files created:**
- `tests/integration/.gitkeep`
- `tests/lib/.gitkeep` (to be replaced by `wait-for.sh` in Phase 7)
- `tests/mock-inference/fixtures/.gitkeep` (to be replaced by real fixture files in Phase 4)

**Tasks:**

1. Create `tests/`, `tests/unit/`, `tests/integration/`, `tests/fixtures/`, `tests/lib/`, `tests/mock-inference/`, and `tests/mock-inference/fixtures/` as empty directories.
2. Add `.gitkeep` to paths that will be empty at commit time.
3. Do **not** create `mcp-server/`, `sync-daemon/`, or `migrations/`.
4. Commit.

### Phase 2 — Canonicalization Fixture

**Files created:**
- `tests/fixtures/canonicalization-cases.json`

**Schema** (each entry):

```json
{
  "name": "short-kebab-case-id",
  "rule": "bom-stripping | crlf-to-lf | trailing-newline-collapse | nfc | internal-whitespace | boundary",
  "input": "JSON-escaped string",
  "expected": "JSON-escaped string after canonicalization per memex-architecture.md Section 6.4"
}
```

The `name` and `rule` fields are memex-specific additions to enable rule-coverage assertions in the smoke test. Sprint 001's SQL tests and later sprints' TS/Python tests will consume only `input` and `expected`.

**Required test vectors** (minimum 22; add more if obvious edge cases surface):

| Name | Rule | Input | Expected |
|---|---|---|---|
| `already-canonical` | `no-op` | `"hello\n"` | `"hello\n"` |
| `bom-stripped` | `bom-stripping` | `"\uFEFFhello\n"` | `"hello\n"` |
| `crlf-to-lf` | `crlf-to-lf` | `"a\r\nb\r\nc\n"` | `"a\nb\nc\n"` |
| `cr-to-lf` | `crlf-to-lf` | `"a\rb\rc\n"` | `"a\nb\nc\n"` |
| `trailing-newlines-collapsed` | `trailing-newline-collapse` | `"a\n\n\n"` | `"a\n"` |
| `missing-trailing-newline-added` | `trailing-newline-collapse` | `"a"` | `"a\n"` |
| `leading-newlines-preserved` | `internal-whitespace` | `"\n\nhello\n"` | `"\n\nhello\n"` |
| `nfd-to-nfc-accented` | `nfc` | `"Cafe\u0301\n"` | `"Café\n"` |
| `already-nfc-unchanged` | `nfc` | `"café\n"` | `"café\n"` |
| `emoji-preserved` | `nfc` | `"hi 😀\n"` | `"hi 😀\n"` |
| `emoji-zwj-family` | `nfc` | `"👨‍👩‍👧\n"` | `"👨‍👩‍👧\n"` |
| `internal-whitespace-preserved` | `internal-whitespace` | `"a    b\n"` | `"a    b\n"` |
| `trailing-double-space-markdown-break` | `internal-whitespace` | `"line  \n"` | `"line  \n"` |
| `tab-indent-preserved` | `internal-whitespace` | `"\tcode\n"` | `"\tcode\n"` |
| `blank-lines-internal-preserved` | `internal-whitespace` | `"a\n\nb\n"` | `"a\n\nb\n"` |
| `windows-notepad-combined` | `combined` | `"\uFEFFa\r\nb\r\n"` | `"a\nb\n"` |
| `nfd-plus-crlf-combined` | `combined` | `"Cafe\u0301\r\n"` | `"Café\n"` |
| `empty-string-boundary` | `boundary` | `""` | `"\n"` |
| `single-newline-idempotent` | `boundary` | `"\n"` | `"\n"` |
| `whitespace-only-content` | `boundary` | `"   \n   "` | `"   \n   \n"` |
| `very-long-content` | `internal-whitespace` | 10000-char ASCII line + `"\n"` | same |
| `beyond-bmp` | `nfc` | `"\uD834\uDD1E\n"` (G-clef U+1D11E) | `"\uD834\uDD1E\n"` |

**Out of scope:** NUL byte handling. PostgreSQL `text` columns reject NUL bytes, so any NUL-containing test vector cannot round-trip through sprint 001's SQL trigger tests. A comment at the top of the fixture file (in a companion `README.md` under `tests/fixtures/` or as a leading metadata entry) explicitly states this.

**Tasks:**

1. Create `tests/fixtures/canonicalization-cases.json` with the schema above and at minimum the 22 vectors listed.
2. Use JSON escape sequences (`\uFEFF`, `\r\n`, `\u0301`) so the file is pure 7-bit ASCII and editor-safe.
3. Hand-verify each `expected` value against memex-architecture.md Section 6.4 rules.
4. Add a `README.md` or leading metadata comment explaining the schema and the NUL-byte out-of-scope decision.
5. Commit.

### Phase 3 — Mock Inference Service Source

**Files created:**
- `tests/mock-inference/main.ts`
- `tests/mock-inference/deno.json`

**Tasks:**

1. Write `main.ts` using `Deno.serve` and a simple `switch` on `url.pathname`. No web framework.
2. Implement `GET /health` returning the shape from Section 3.4.
3. Implement `POST /embeddings`:
   - Parse JSON body; handle both `input: string` and `input: string[]`.
   - Check for special inputs (`__fail_embed__`, `__slow_embed__`) before the embedding algorithm.
   - Implement the exact algorithm from Section 3.4 (SHA-256 seed → counter expansion → big-endian u32 decode → L2 normalization).
   - Return the OpenAI-compatible response shape.
4. Implement `POST /chat/completions`:
   - At startup, load `tests/mock-inference/fixtures/chat.json` (path resolved from the container's working directory or an env var).
   - Canonicalize each entry's `request` field using a recursive-key-sort + stable-stringify function.
   - Compute SHA-256 hashes and build an in-memory `Map<string, Response>`.
   - On incoming request, canonicalize and hash the body the same way, look up the map, return the matching response or 400 with the hash.
5. Implement 404 for unknown routes and 400 for malformed JSON.
6. Log one line per request to stdout (`METHOD path status elapsed_ms`), no request bodies.
7. Add an inline header comment referencing `memex-architecture.md` Section 9 and noting that the mock is deliberately incomplete by design.
8. `deno.json` declares a `start` task: `"start": "deno run --allow-net --allow-read --allow-env main.ts"`.
9. Verify locally: `cd tests/mock-inference && deno task start &` responds to `curl localhost:8000/health`.
10. Commit.

### Phase 4 — Mock Inference Dockerfile and Golden Fixtures

**Files created:**
- `tests/mock-inference/Dockerfile`
- `tests/mock-inference/fixtures/chat.json`
- `tests/mock-inference/fixtures/embeddings.json`

**Tasks:**

1. Write `Dockerfile` using `denoland/deno:alpine-2.x` (pin the minor version). Copy source, run `deno cache main.ts` at build time to warm the module cache. `EXPOSE 8000`. `CMD ["run", "--allow-net", "--allow-read", "--allow-env", "main.ts"]`.
2. Write `chat.json` with at least two fixture entries:
   - `metadata-basic` — a simple metadata extraction request
   - `metadata-variant` — a different request that proves the canonical-hash lookup distinguishes request bodies
3. **Generate `embeddings.json` from the committed algorithm.** Do not hand-author the golden vectors.
   - Build and run the mock service locally.
   - `curl` each golden input and capture the exact response body.
   - Paste the captured responses into `embeddings.json` as `{ "request": {...}, "response": {...} }` pairs.
   - Include at least three golden cases:
     - Simple ASCII input (`"hello world"`)
     - Multi-line input with newlines
     - Array input with two elements (tests the `input: string[]` path)
4. Document in `embeddings.json` (either as a leading metadata entry or in a companion comment) that these are golden replay fixtures generated by running the committed algorithm, and that any change to the algorithm requires regenerating them.
5. Verify locally: `docker build -t mock-inference:test tests/mock-inference && docker run --rm -p 58000:8000 mock-inference:test` responds to `curl localhost:58000/health`.
6. Commit.

### Phase 5 — Compose File

**Files created:**
- `tests/compose.yaml`

**Tasks:**

1. Define two services: `postgres` and `mock-inference`.
2. `postgres`:
   - `image: pgvector/pgvector:pg16`
   - `environment:` `POSTGRES_DB=memex_test`, `POSTGRES_USER=memex_test`, `POSTGRES_PASSWORD=memex_test`
   - `ports: ["127.0.0.1:55432:5432"]` (bind to localhost only)
   - `healthcheck:` `pg_isready -U memex_test -d memex_test`, `interval: 2s`, `timeout: 2s`, `retries: 30`, `start_period: 5s`
3. `mock-inference`:
   - `build: ./mock-inference` (context)
   - `ports: ["127.0.0.1:58000:8000"]`
   - `healthcheck:` `wget -qO- http://localhost:8000/health || exit 1`, same interval/timeout/retries/start_period
4. Named network: `memex-test-net` (default driver).
5. No bind mounts. Use anonymous volumes so `down -v` disposes cleanly.
6. **Omit the `version:` field.** Compose v2 ignores it and modern linters flag it.
7. Verify locally: `docker compose -p memex-test -f tests/compose.yaml up -d --wait` succeeds; both containers report healthy.
8. `docker compose -p memex-test -f tests/compose.yaml down -v --remove-orphans` cleans up.
9. Commit.

### Phase 6 — Smoke Test

**Files created:**
- `tests/unit/smoke.test.ts`
- `deno.json` (repository root — **not** `tests/deno.json`)

**Tasks:**

1. Write `deno.json` at the repo root with:
   - Pinned standard library import map
   - A `test` task: `"test": "deno test --allow-net --allow-read --allow-env tests/unit/"`
   - `fmt` and `lint` config (optional but recommended)
2. Write `smoke.test.ts` with the following `Deno.test` steps:
   - **`pg reachable from host`** — open a TCP connection to `127.0.0.1:55432` via `Deno.connect({ hostname: "127.0.0.1", port: 55432, transport: "tcp" })`. Close immediately. Proves host port binding works; no PostgreSQL client dependency.
   - **`mock /health`** — `fetch("http://127.0.0.1:58000/health")`; assert 200, parse JSON, assert `json.status === "ok"` and `json.service === "mock-inference"`.
   - **`mock /embeddings golden replay`** — load `tests/mock-inference/fixtures/embeddings.json`, replay each request, `assertEquals` on the full response body (deep equality).
   - **`mock /embeddings deterministic`** — POST the same input twice; deep-equal the responses. Also assert `data[0].embedding.length === 1536` and that the vector is approximately unit-length (`|||v||₂ - 1| < 1e-6`).
   - **`mock /embeddings varies by input`** — POST two different inputs; assert the resulting vectors differ in at least one element (overwhelming probability).
   - **`mock __fail_embed__`** — POST with `input: "__fail_embed__"`; assert status 500 and the error body shape.
   - **`mock __slow_embed__`** — measure elapsed time with `performance.now()` around the POST; assert `elapsed >= 4500 && elapsed < 15000`; give the test a 20s per-test timeout.
   - **`mock /chat/completions golden replay`** — load `chat.json`, replay each fixture request, deep-equal the response.
   - **`mock /chat/completions missing fixture`** — POST a non-matching chat request, assert 400 and that the error body includes `request_hash`.
   - **`canonicalization fixture well-formed`** — read `tests/fixtures/canonicalization-cases.json`, parse, assert:
     - Top level is an array
     - ≥22 entries
     - Every entry has string `name`, `rule`, `input`, `expected`
     - Names are unique
     - Rule-coverage sentinels: at least one entry with each of `bom-stripping`, `crlf-to-lf`, `trailing-newline-collapse`, `nfc`, `internal-whitespace`, `boundary`
3. Keep the file focused; use `assertEquals`, `assert`, `assertExists` from `@std/assert`. No helper libraries.
4. Verify locally by running the test against a hand-started Compose stack.
5. Commit.

### Phase 7 — Runner Script and Wait Helpers

**Files created:**
- `tests/run-tests.sh` (`chmod +x`)
- `tests/lib/wait-for.sh`

**Tasks:**

1. Write `tests/lib/wait-for.sh` with two functions: `wait_for_port` and `wait_for_http` (see Section 3.6). No `nc` dependency; use `bash /dev/tcp` and `curl -fsS`.
2. Write `tests/run-tests.sh` implementing the flow from Section 3.5:
   - `set -euo pipefail`
   - Preflight: check `docker`, `docker compose`, `deno` binaries exist; check `docker info` succeeds; check ports 55432 and 58000 are not already bound via `bash /dev/tcp` probe.
   - Set `COMPOSE="docker compose -p memex-test -f tests/compose.yaml"`.
   - `trap cleanup EXIT INT TERM`.
   - Pre-run cleanup.
   - `$COMPOSE config > /dev/null` to validate.
   - `$COMPOSE up -d --build --wait` with `COMPOSE_HTTP_TIMEOUT=120`.
   - Source `tests/lib/wait-for.sh` and call `wait_for_http http://127.0.0.1:58000/health 60` as a safety net.
   - Poll `$COMPOSE exec -T postgres pg_isready -U memex_test -d memex_test` as a belt-and-suspenders check.
   - Export `MEMEX_TEST_*` variables.
   - Run `deno task test` (which runs `deno test` against `tests/unit/`).
   - On failure, print `$COMPOSE logs --no-color` before the trap fires.
   - Exit with the test runner's exit code.
3. Print clear banners: `[run-tests] preflight`, `[run-tests] bringing up stack`, `[run-tests] waiting for readiness`, `[run-tests] running tests`, `[run-tests] tearing down`, `[run-tests] OK` / `[run-tests] FAILED`.
4. Verify locally: `./tests/run-tests.sh` from a clean checkout, exit code 0.
5. Verify Ctrl-C path: start the runner, SIGINT after `up`, confirm `docker compose ls` shows no `memex-test` project.
6. Commit.

### Phase 8 — CI Workflow and README

**Files created:**
- `.github/workflows/test.yml`
- `tests/README.md`

**Tasks:**

1. Write `.github/workflows/test.yml`:
   - Triggers on `push` and `pull_request`
   - `permissions: contents: read`
   - `timeout-minutes: 10`
   - Single job on `ubuntu-latest`
   - Steps:
     - `actions/checkout@v4`
     - `denoland/setup-deno@v1` (pin the major version)
     - `./tests/run-tests.sh`
   - No secrets. Fork-safe by design.
   - No separate service-container path; use the same `tests/compose.yaml` as local development.
2. Write `tests/README.md` documenting:
   - **Prerequisites**: Colima (`brew install colima docker`) on macOS or Docker Desktop; Deno (`brew install deno`); no host PostgreSQL client required.
   - **Starting Colima**: `colima start` (with optional `--cpu 4 --memory 4` sizing guidance; defaults work).
   - **Running tests**: `./tests/run-tests.sh`.
   - **Fixed ports**: 55432 (PostgreSQL) and 58000 (mock inference). What to do if they collide.
   - **Manual inspection**: `docker compose -p memex-test -f tests/compose.yaml up -d` and how to poke at services with `curl` and `psql` (if installed).
   - **Adding canonicalization fixtures**: schema, required fields, coverage rules.
   - **Adding chat fixtures**: the canonical-hash lookup model, how to add a new fixture by running the missing-fixture error path.
   - **Adding embedding golden fixtures**: regenerate by running the committed algorithm, never hand-author.
   - **Colima troubleshooting**: `docker info` as the canonical "is it running?" check; socket path if weird behavior; arm64 vs x86_64 image selection (auto via multi-arch manifests).
   - **Known quirks**: compose `version:` is intentionally omitted, serial execution only, no `--no-teardown` flag (use `docker compose up -d` directly for debugging).
3. Commit.

## 5. Verification Plan

### 5.1 Automated Checks

| # | Check | What It Validates | File | Executor Notes |
|---|---|---|---|---|
| 1 | Compose config validation | `tests/compose.yaml` is syntactically valid and all build/image references resolve | `tests/run-tests.sh` | `docker compose -p memex-test -f tests/compose.yaml config >/dev/null` before `up` |
| 2 | Pre-flight port availability | Ports 55432 and 58000 are not already bound on the host | `tests/run-tests.sh` | `bash /dev/tcp` probe with a clear error message pointing at `lsof -i :PORT` for diagnosis |
| 3 | Docker daemon reachable | Colima or Docker Desktop is actually running | `tests/run-tests.sh` | `docker info >/dev/null 2>&1 \|\| { echo "Docker not reachable — start Colima with 'colima start'"; exit 1; }` |
| 4 | Clean startup and teardown | Stack starts cleanly and always tears down, even on failure | `tests/run-tests.sh` | `trap` calling `$COMPOSE down -v --remove-orphans`; pre-run cleanup catches leftover state |
| 5 | PostgreSQL readiness (container-internal) | Postgres container is accepting connections | `tests/run-tests.sh` | `$COMPOSE exec -T postgres pg_isready -U memex_test -d memex_test` with polling |
| 6 | PostgreSQL readiness (host port binding) | The host port binding actually works | `tests/unit/smoke.test.ts` | `Deno.connect({ port: 55432 })` and close |
| 7 | Mock service readiness (host) | Mock HTTP server is reachable on the documented host port | `tests/run-tests.sh` and `tests/unit/smoke.test.ts` | `curl -fsS http://127.0.0.1:58000/health` in runner; `fetch` in smoke test |
| 8 | Health endpoint contract | `/health` returns 200 and expected body shape | `tests/unit/smoke.test.ts` | `fetch`, parse JSON, `assertEquals` on status and shape |
| 9 | Embedding golden fixture replay | Known requests return exact saved JSON payloads (algorithm stability) | `tests/unit/smoke.test.ts` + `tests/mock-inference/fixtures/embeddings.json` | Load fixture, replay each request, deep-compare |
| 10 | Embedding determinism (in-process) | Repeated identical requests produce byte-identical responses | `tests/unit/smoke.test.ts` | Same request twice, `assertEquals` |
| 11 | Embedding determinism (out-of-process) | Manual determinism via `curl | diff` (covered in 5.2) | manual | See 5.2 step 6 |
| 12 | Embedding dimensionality | Every embedding is exactly 1536 floats and unit-length | `tests/unit/smoke.test.ts` | `assertEquals(data[0].embedding.length, 1536)`; compute L2 norm, assert `|norm - 1| < 1e-6` |
| 13 | Embedding variation | Different inputs produce different embeddings | `tests/unit/smoke.test.ts` | Send two different requests, assert at least one element differs |
| 14 | `__fail_embed__` trigger | Error path returns 500 with structured error | `tests/unit/smoke.test.ts` | Assert status 500, parse error body, check `type === "mock_embedding_failure"` |
| 15 | `__slow_embed__` timing | Delay is within bounds | `tests/unit/smoke.test.ts` | `performance.now()` delta; assert `4500 <= elapsed < 15000`; per-test timeout 20s |
| 16 | Chat fixture replay | Known chat requests return exact canned responses | `tests/unit/smoke.test.ts` + `tests/mock-inference/fixtures/chat.json` | Replay every fixture, deep-compare responses |
| 17 | Chat missing fixture | Unknown requests fail with hash in error body | `tests/unit/smoke.test.ts` | Send unknown request, assert 400, assert `error.request_hash` is a 64-char hex string |
| 18 | Canonicalization fixture well-formedness | Corpus parses and has required structure | `tests/unit/smoke.test.ts` + `tests/fixtures/canonicalization-cases.json` | Parse, assert array, assert ≥22 entries, assert schema, assert rule-coverage sentinels |
| 19 | CI parity | GitHub Actions invokes the same runner as local | `.github/workflows/test.yml` | Workflow step directly invokes `./tests/run-tests.sh`; no duplicated test flow |
| 20 | CI timeout guard | Workflow cannot exceed 10 minutes | `.github/workflows/test.yml` | `timeout-minutes: 10` at job level |
| 21 | Fork-safe CI | Workflow runs on PRs from forks without secrets | `.github/workflows/test.yml` | No secrets referenced; `permissions: contents: read` |

### 5.2 Manual Verification Steps

1. **Start the container runtime.**

   ```bash
   colima start
   ```

   **Expected:** Colima starts successfully. If already running, no-op.

2. **Run the full test harness.**

   ```bash
   ./tests/run-tests.sh
   ```

   **Expected:** Script prints preflight, bring-up, readiness, tests, teardown phases. Exits 0. No running `memex-test` containers afterward. Output includes lines like `[run-tests] OK`.

3. **Bring up the stack manually for inspection.**

   ```bash
   docker compose -p memex-test -f tests/compose.yaml up -d --build --wait
   docker compose -p memex-test -f tests/compose.yaml ps
   ```

   **Expected:** Both `postgres` and `mock-inference` services are in `running` / `healthy` status.

4. **Verify PostgreSQL readiness from inside the container.**

   ```bash
   docker compose -p memex-test -f tests/compose.yaml exec -T postgres pg_isready -U memex_test -d memex_test
   ```

   **Expected:** Exit code 0, output like `/var/run/postgresql:5432 - accepting connections`.

5. **Verify the mock health endpoint.**

   ```bash
   curl -sS http://127.0.0.1:58000/health
   ```

   **Expected:** `{"status":"ok","service":"mock-inference","version":"0.1.0"}`.

6. **Verify deterministic embeddings via out-of-process `diff`.**

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
   echo "exit: $?"
   ```

   **Expected:** `diff` prints nothing; exit code 0.

7. **Verify the failure trigger.**

   ```bash
   curl -sS -o /tmp/memex-fail.json -w 'HTTP %{http_code}\n' \
     -X POST http://127.0.0.1:58000/embeddings \
     -H 'content-type: application/json' \
     -d '{"model":"openai/text-embedding-3-small","input":"__fail_embed__"}'
   cat /tmp/memex-fail.json
   ```

   **Expected:** `HTTP 500`; body contains `{"error":{"type":"mock_embedding_failure", ...}}`.

8. **Verify the slow trigger.**

   ```bash
   time curl -sS -X POST http://127.0.0.1:58000/embeddings \
     -H 'content-type: application/json' \
     -d '{"model":"openai/text-embedding-3-small","input":"__slow_embed__"}' \
     > /tmp/memex-slow.json
   ```

   **Expected:** Elapsed real time is approximately 5s (at least 4.5s, at most 15s). Response body is a normal successful embedding response.

9. **Verify a canned chat fixture replay.**

   ```bash
   deno eval '
     const f = JSON.parse(Deno.readTextFileSync("tests/mock-inference/fixtures/chat.json"));
     console.log(JSON.stringify(f[0].request));
   ' | curl -sS -X POST http://127.0.0.1:58000/chat/completions \
       -H 'content-type: application/json' \
       --data-binary @-
   ```

   **Expected:** Response body matches `f[0].response` from the fixture file exactly.

10. **Verify the missing-fixture error includes a hash.**

    ```bash
    curl -sS -o /tmp/memex-chat-miss.json -w 'HTTP %{http_code}\n' \
      -X POST http://127.0.0.1:58000/chat/completions \
      -H 'content-type: application/json' \
      -d '{"model":"openai/gpt-4o-mini","messages":[{"role":"user","content":"not a fixture"}]}'
    cat /tmp/memex-chat-miss.json
    ```

    **Expected:** `HTTP 400`; body contains `error.type === "mock_chat_fixture_missing"` and `error.request_hash` is a 64-character hex string.

11. **Verify cleanup.**

    ```bash
    docker compose -p memex-test -f tests/compose.yaml down -v --remove-orphans
    docker compose -p memex-test -f tests/compose.yaml ps
    docker volume ls | grep memex-test
    ```

    **Expected:** `down` removes containers and volumes. `ps` shows no services. `volume ls | grep` returns nothing.

12. **Verify CI triggers on push and PR.**

    Push a throwaway branch to GitHub and open a draft PR against `main`. Check the GitHub Actions tab.

    **Expected:** Workflow runs on both the push and the PR. Completes within 10 minutes. Green check. No secrets are used. If a fork of the repo existed, the same workflow would run on forked PRs.

### 5.3 Regression Scenarios

**None.** Sprint 000 introduces the first executable code in the repository. The checks above are acceptance tests, not regression tests. Later sprints treat this platform as the baseline and add regression coverage on top of it.

### 5.4 Sprint-Specific Gotchas

- **Determinism is non-negotiable.** Verify it three ways: golden replay + in-process repeat + out-of-process `curl | diff`. Eyeballing is not enough.
- **The embedding algorithm is pinned in this document.** Do not deviate. If a future sprint needs a different algorithm, write a new sprint that explicitly migrates the algorithm and regenerates all golden fixtures.
- **Golden embedding fixtures must be generated from the committed algorithm**, not hand-authored. Phase 3 (algorithm) must complete before Phase 4 (fixtures); the fixture values come from running the Phase 3 service against the chosen golden inputs.
- **The mock service must remain offline.** No fallback HTTP calls, no proxying, no "record once" behavior. Any attempt at outbound network traffic during tests is a bug.
- **`tests/run-tests.sh` must not require a host PostgreSQL client.** The optional `pg_isready` on the host from manual step 4 is informational only, not part of the runner's prerequisites.
- **Keep Compose serial in Sprint 000.** Fixed ports plus parallel runs is a recipe for flaky failures. Use `-p memex-test` explicitly so concurrent invocations fail loudly on container name collision.
- **`deno.json` lives at the repo root**, not under `tests/`. `deno test` from the repo root picks it up automatically.
- **Omit the `version:` field in `tests/compose.yaml`** and document this in `tests/README.md` so operators understand the Compose v2 expectation.
- **Port collisions are possible but unlikely.** If 55432 or 58000 are already bound locally, stop the conflicting process during manual verification; do not silently change the repository defaults.
- **NUL bytes are out of scope for canonicalization.** The fixture file has a comment explaining why (PostgreSQL `text` columns cannot store them).
- **Git remote is out of scope for Sprint 000.** Sprint 005 (sync daemon wiki→DB) will introduce the git-remote test fixtures when the sync daemon first needs one. ROADMAP.md mentions a "local bare git remote" in the Testing Strategy section; that belongs to sprint 005, not here.

## 6. Files Summary

### Orchestration and CI

- `.github/workflows/test.yml`
- `tests/compose.yaml`
- `tests/run-tests.sh`
- `tests/README.md`
- `tests/lib/wait-for.sh`

### Mock Inference Service

- `tests/mock-inference/Dockerfile`
- `tests/mock-inference/main.ts`
- `tests/mock-inference/deno.json`
- `tests/mock-inference/fixtures/chat.json`
- `tests/mock-inference/fixtures/embeddings.json`

### Shared Test Fixtures

- `tests/fixtures/canonicalization-cases.json`

### Test Code and Reserved Paths

- `tests/unit/smoke.test.ts`
- `tests/integration/.gitkeep`
- `deno.json` (repository root)

## 7. Definition of Done

- [ ] `tests/compose.yaml` starts `pgvector/pgvector:pg16` on `127.0.0.1:55432` and the mock inference service on `127.0.0.1:58000`.
- [ ] `tests/compose.yaml` omits the `version:` field.
- [ ] `tests/mock-inference/main.ts` implements `GET /health`, `POST /embeddings`, and `POST /chat/completions` with no outbound network dependency.
- [ ] The embedding algorithm matches the pinned specification in Section 3.4 byte-for-byte.
- [ ] `POST /embeddings` returns deterministic 1536-dimensional, L2-normalized vectors for repeated identical requests.
- [ ] Golden embedding fixtures in `embeddings.json` were generated from the committed algorithm and the smoke test replays them successfully.
- [ ] `POST /embeddings` returns 500 for `__fail_embed__` and delays approximately 5 seconds for `__slow_embed__`.
- [ ] `POST /chat/completions` returns exact canned fixture responses via canonical-JSON hash lookup.
- [ ] `POST /chat/completions` returns 400 with a deterministic `request_hash` for unknown requests.
- [ ] `tests/fixtures/canonicalization-cases.json` contains at least 22 valid entries covering every memex-architecture Section 6.4 rule plus the three boundary cases (empty string, single newline, whitespace-only).
- [ ] The canonicalization fixture documents NUL bytes as explicitly out of scope with rationale.
- [ ] `tests/unit/smoke.test.ts` passes locally against the live Compose stack.
- [ ] The smoke test validates PostgreSQL host port binding via TCP connect (not just container-internal `pg_isready`).
- [ ] The smoke test asserts `__slow_embed__` elapsed time is `≥4500ms AND <15000ms`.
- [ ] `./tests/run-tests.sh` succeeds from a clean clone with Colima (or Docker Desktop) and Deno installed, exits 0, and leaves no leftover containers or volumes.
- [ ] The runner includes pre-flight checks for `docker info` and port availability on 55432 and 58000.
- [ ] The runner invokes Compose with `-p memex-test` so concurrent runs fail loudly instead of silently colliding.
- [ ] `tests/lib/wait-for.sh` provides `wait_for_port` and `wait_for_http` functions usable with `bash /dev/tcp` and `curl` only (no `nc` dependency).
- [ ] `.github/workflows/test.yml` runs on both `push` and `pull_request`, has `timeout-minutes: 10`, uses `permissions: contents: read`, and invokes `./tests/run-tests.sh` directly.
- [ ] The GitHub Actions workflow passes on a throwaway branch push.
- [ ] `tests/README.md` documents prerequisites (Colima and Deno), local execution, fixed ports, manual inspection commands, fixture maintenance, and the NUL byte out-of-scope decision.
- [ ] `deno.json` at the repo root defines the `test` task and is picked up by `deno test` without requiring `--config`.
- [ ] No `migrations/`, `mcp-server/`, or `sync-daemon/` directories are created.
- [ ] The ledger has Sprint 000 marked `in_progress` during execution and `completed` when all items above are checked.

## 8. Risks & Mitigations

| # | Risk | Why It Matters | Mitigation |
|---|---|---|---|
| 1 | Colima not running when runner starts | Produces confusing `docker: command not found` or connection-refused errors | `docker info` precheck in runner fails fast with a clear message pointing at `colima start` |
| 2 | Port 55432 or 58000 already bound locally | Runner fails with cryptic Compose errors | Pre-flight `bash /dev/tcp` check fails fast with a message pointing at `lsof -i :PORT` |
| 3 | Leftover containers from a previous interrupted run | Causes port-in-use errors or stale state | Pre-run `down -v --remove-orphans` + `-p memex-test` project naming so stale state is always under a known name |
| 4 | `docker compose --wait` missing on older Compose | `up -d --wait` fails on old Compose binaries | `wait-for.sh` helper as belt-and-suspenders; poll `pg_isready` and `curl /health` explicitly regardless |
| 5 | Mock service algorithm drifts between Deno versions | Golden fixtures go stale, smoke test fails mysteriously | Pin Deno version in Dockerfile; CI uses `setup-deno@v1` with pinned version; document regeneration procedure for fixtures |
| 6 | Canonicalization test vectors diverge from `memex-architecture.md` Section 6.4 | Future SQL/TS/Python implementations would silently disagree | Hand-verify every `expected` value against the rule table before committing; sprint 001's SQL tests will validate the fixture against the real trigger and surface any drift |
| 7 | CI hangs on `__slow_embed__` or a stalled Compose pull | Burns GitHub Actions minutes | `timeout-minutes: 10` at the workflow job level; smoke test has per-test timeout of 20s |
| 8 | Forked PRs can't access secrets | Not applicable because the workflow uses no secrets, but operators may assume it should | Document in `tests/README.md` that the workflow is intentionally secret-free |
| 9 | Deno version skew between mock service and smoke test | Behavioral differences could mask algorithm issues | Pin both to the same Deno 2.x minor version; revisit if CI flakes |
| 10 | Colima arm64 vs CI x86_64 produce different golden vectors | Would fail fixture replay in CI | SHA-256 is byte-deterministic across architectures; the only risk is floating-point serialization — use Deno's default `JSON.stringify` (no locale-dependent formatting) and verify goldens were generated once and committed |
| 11 | Port collisions force repo default changes | Churn and loss of muscle memory | Keep defaults; document collision recovery in README; prefer stopping conflicting local processes over changing ports |
| 12 | Mock service contract drift during later sprints | Future server code expects different shapes | Keep the mock's response shapes OpenAI-compatible; enforce via fixture replay tests in smoke suite; changes require bumping fixtures |
| 13 | Chat fixture canonical-hash collisions or mismatches | New fixtures don't match because key order differs | Build the lookup map at service startup from the stored fixtures using the same canonicalization function used for requests; guarantees order-independence |
| 14 | Operators forget that NUL bytes are out of scope | Future test vectors attempting to include NUL break sprint 001 | Document in the fixture file and in `tests/README.md` |

## 9. Dependencies

### Must Exist Before Sprint 000 Starts

- Current repository baseline: `README.md`, `ROADMAP.md`, `memex-architecture.md`, `LICENSE`, `.gitignore`, and the `docs/sprints/` infrastructure
- Local container runtime: Colima (`brew install colima docker`) or Docker Desktop
- Deno installed locally (`brew install deno`)
- GitHub Actions enabled for `wuertele/mcp-memex`

No code dependencies from prior sprints. This is the first implementation sprint.

### Produced by Sprint 000 for Later Sprints

- **Disposable PostgreSQL 16+ with pgvector on a stable port**, consumed by sprint 001 (migration tests) and every sprint thereafter.
- **Deterministic mock inference API with documented failure modes**, consumed by sprint 003 (server capture path tests) and every server/daemon test that needs inference.
- **Shared canonicalization fixture corpus**, consumed by sprint 001 (SQL trigger tests), sprint 003 (server `canonicalize.ts` tests), and sprint 005 (daemon `canonicalize.py` tests). This is the cross-implementation consistency anchor.
- **`tests/integration/` path**, consumed by sprint 001 migration tests immediately.
- **One-button local runner**, reused by every subsequent sprint.
- **`MEMEX_TEST_*` environment variable contract**, consumed by sprint 001 and beyond.
- **GitHub Actions CI workflow**, validates every push and PR from sprint 001 forward.

## 10. Open Questions

These are remaining operator decisions to confirm during execution. Recommended defaults are included; all can be resolved during Phase 8 (README writing) without reopening earlier phases.

1. **Colima resource sizing guidance in `tests/README.md`.** Default Colima (2 CPU, 2 GB) should be sufficient for `pgvector/pgvector:pg16` + the tiny Deno mock service. Confirm during execution; if the Compose stack OOMs, document a `colima start --cpu 4 --memory 4` recommendation.

2. **Deno minor version pin.** Default to whatever is current stable 2.x at execution time. Pin in `Dockerfile` and in `.github/workflows/test.yml` via `setup-deno` version string. Bump deliberately in a future sprint.

3. **Whether to include `metadata-with-array-input` as a golden embedding fixture.** The roadmap mentions `input: string[]` support but doesn't require golden coverage. Recommendation: include at least one string[] golden fixture so the array path is validated by the replay check. Confirm during Phase 4 execution.

4. **`chat.json` initial fixture count.** Phase 4 requires at least 2 fixtures. Recommendation: start with 2 and add more as sprint 003 (which will use chat completions for metadata extraction) surfaces specific prompts that need canned responses. Keeping the initial set small reduces maintenance.

5. **Whether to add a `tests/fixtures/README.md`** documenting the fixture-maintenance workflow in more detail than `tests/README.md` can accommodate. Recommendation: yes, if Phase 8 finds `tests/README.md` becoming unwieldy. Can be added during Phase 8 without restarting earlier phases.

6. **Whether to echo the mock service's Deno version in the `/health` response.** Would help debug version-skew issues. Recommendation: yes, add a `version: "0.1.0"` field (corresponds to the mock service version, not the Deno version). Already specified in Section 3.4.

7. **Whether `tests/README.md` should include a "known collisions" table** listing common macOS services that use ports 55432 or 58000. Recommendation: not worth the maintenance; rely on the runner's pre-flight check to produce a clear error at runtime.
