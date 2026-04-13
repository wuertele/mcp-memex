# Sprint 000 — Test Platform and CI Scaffolding (Claude draft)

## 1. Overview

Sprint 000 establishes the test infrastructure that every subsequent
sprint depends on. It lands:

- An ephemeral Docker Compose stack with `pgvector/pgvector:pg16`
  and a custom mock inference service.
- A deterministic, offline, Deno-based mock inference HTTP server
  implementing an OpenRouter-compatible API surface.
- The shared canonicalization test-vector fixture that sprints 001,
  003, and 005 will all test against.
- A one-button `tests/run-tests.sh` runner that boots the stack,
  runs the suite, and tears down on exit (including on failure).
- A GitHub Actions workflow that runs the exact same runner on
  every push and PR.
- A contributor README for the test platform.
- A placeholder smoke test that proves the whole pipeline works
  end-to-end before any real code exists.

It matters *now* because sprint 001 (schema migrations) cannot
validate that its canonicalization trigger produces the right bytes
without both (a) a PostgreSQL 16 + pgvector instance it can apply
migrations to and (b) the authoritative canonicalization vectors.
Both are deliverables of this sprint.

## 2. Use Cases

| # | Scenario | Input | Expected behavior |
|---|---|---|---|
| U1 | Fresh clone, local run | `git clone && ./tests/run-tests.sh` | Compose up, smoke test passes, compose down, exit 0 |
| U2 | Re-run after previous failure | A stale `tests-memex` stack from a killed run | Runner tears down any prior stack before starting, then runs cleanly |
| U3 | Runner interrupted (Ctrl-C) | SIGINT mid-run | Trap fires `docker compose down -v`; no orphan containers or volumes |
| U4 | CI on push | Commit pushed to `main` or a PR branch | GitHub Actions runs `tests/run-tests.sh` on a fresh runner and reports green |
| U5 | PR from a fork | External contributor PR | Workflow runs read-only (no secrets needed) and reports green |
| U6 | Determinism check | Two identical `POST /embeddings` calls | Byte-identical JSON response bodies |
| U7 | Embedding call | `POST /embeddings` with body `{"input": "hello world", "model": "..."}` | 200 OK, response shape matches OpenAI embeddings API, `data[0].embedding` is a length-1536 `number[]` |
| U8 | Chat completion call | `POST /chat/completions` with any prompt | 200 OK, canned response drawn from `fixtures/chat.json` (keyed by a stable selector; falls back to a default fixture) |
| U9 | Health probe | `GET /health` on mock service | 200 OK, small JSON body |
| U10 | Failure-mode trigger: hard fail | `POST /embeddings` input containing `"__fail_embed__"` | 500 response with a structured error body |
| U11 | Failure-mode trigger: slow | `POST /embeddings` input containing `"__slow_embed__"` | Response after a ~5s delay, otherwise a normal 200 |
| U12 | PostgreSQL reachable | `pg_isready -h 127.0.0.1 -p 55432` after startup | `accepting connections` |
| U13 | pgvector present | `CREATE EXTENSION IF NOT EXISTS vector;` in the test DB | Succeeds without installing anything |
| U14 | Canonicalization fixture consumed | Future sprint reads `tests/fixtures/canonicalization-cases.json` | Parses as JSON array of `{name, input, expected}`; at least one case per Section 6.4 rule |
| U15 | Canonicalization fixture well-formed (this sprint) | Smoke test parses it | Parse succeeds, schema checks pass, every case has a unique `name` |

## 3. Architecture

### 3.1 Component layout

```
mcp-memex/
├── .github/
│   └── workflows/
│       └── test.yml               # CI: runs tests/run-tests.sh on ubuntu-latest
├── tests/
│   ├── README.md                  # Contributor docs: prereqs, how to run, how to add fixtures
│   ├── compose.yaml               # Docker Compose stack (postgres + mock-inference)
│   ├── run-tests.sh               # One-button runner (bash, set -euo pipefail, traps)
│   ├── lib/
│   │   └── wait-for.sh            # Polling helpers used by run-tests.sh
│   ├── fixtures/
│   │   └── canonicalization-cases.json  # Authoritative Section 6.4 vectors
│   ├── mock-inference/
│   │   ├── Dockerfile             # denoland/deno:alpine-based image
│   │   ├── main.ts                # ~50-100 line HTTP server
│   │   ├── deno.json              # Pinned Deno task + lockfile pointer
│   │   ├── deno.lock              # Locked std-lib dependency hashes
│   │   └── fixtures/
│   │       ├── embeddings.json    # Reserved for future canned embeddings (empty stub)
│   │       └── chat.json          # Canned chat completion responses
│   ├── unit/
│   │   └── smoke.test.ts          # Deno test: validates the whole pipeline
│   └── integration/
│       └── .gitkeep               # Reserved for sprint 001+ (empty this sprint)
└── docs/sprints/drafts/
    └── SPRINT-000-CLAUDE-DRAFT.md  # This file
```

Source directories (`mcp-server/`, `sync-daemon/`, `migrations/`)
are **not** created in sprint 000. Their respective sprints add
them. This sprint only creates `tests/` and `.github/workflows/`.

### 3.2 Compose topology

Two services on a private bridge network, both published to
`127.0.0.1` for host-side tools:

- `postgres`: image `pgvector/pgvector:pg16`. Published on
  `127.0.0.1:55432 → 5432`. Env: `POSTGRES_DB=memex_test`,
  `POSTGRES_USER=memex`, `POSTGRES_PASSWORD=memex`. Healthcheck
  uses `pg_isready -U memex -d memex_test`. No bind mount — the
  volume is anonymous and disposed on `docker compose down -v`.
- `mock-inference`: built from `./mock-inference` (context). Port
  `127.0.0.1:58000 → 8000`. Env: `MOCK_CHAT_FIXTURES=/app/fixtures/chat.json`.
  Healthcheck: `wget -qO- http://localhost:8000/health || exit 1`.

No `version:` key (Compose v2 ignores it and modern lint
flags it). Project name pinned via `-p memex-test` inside the
runner script so parallel runs on different branches don't
collide.

### 3.3 Mock inference service contract

All endpoints are OpenAI/OpenRouter-compatible enough for a typed
OpenAI client to call them. No auth enforced (any `Authorization:
Bearer ...` accepted, including absent).

**`POST /embeddings`**

Request:
```json
{ "input": "string or string[]", "model": "any-string" }
```

Response (200):
```json
{
  "object": "list",
  "data": [
    { "object": "embedding", "index": 0, "embedding": [/* 1536 f32 */] }
  ],
  "model": "mock-embed-1536",
  "usage": { "prompt_tokens": 0, "total_tokens": 0 }
}
```

Vector algorithm (deterministic):

1. Compute SHA-256 of the UTF-8 bytes of the input string.
2. Treat the 32 digest bytes as a seed; expand deterministically
   to 1536 × 4 bytes by repeatedly hashing `sha256(seed || counter_le_u32)`
   and concatenating.
3. Interpret each 4-byte chunk as a little-endian `uint32`, divide
   by `2**32 - 1`, and map to `[-1.0, 1.0]` via `2*x - 1`.
4. L2-normalize the resulting 1536-vector.

This gives stable unit vectors for any string, with no dependence
on process start time, PID, or wall clock. Array inputs produce
one vector per element, in order.

**Special inputs** (checked *before* hashing, as substring match on
the concatenated input):

- Contains `"__fail_embed__"` → `500` with body
  `{"error": {"type": "mock_failure", "message": "forced failure: __fail_embed__"}}`.
- Contains `"__slow_embed__"` → `await new Promise(r => setTimeout(r, 5000))`
  before returning the normal 200 response.

**`POST /chat/completions`**

Returns a canned OpenAI chat-completion-shaped response from
`fixtures/chat.json`. Selection rule: the fixtures file is an
object of the form `{ "default": {...}, "by_substring": [ {"match": "...", "response": {...}}, ... ] }`.
The first `by_substring` entry whose `match` appears in the
concatenation of all message `content` fields wins; otherwise
`default` is used. Selection is deterministic and commutative.

**`GET /health`** → `200` with body
`{"status":"ok","service":"mock-inference","version":"0.1.0"}`.

**Unknown routes** → `404` with a structured error body.

Logging: one line per request to stdout (`METHOD path status ms`),
no request bodies, so CI logs stay compact.

### 3.4 Test runner flow

`tests/run-tests.sh` (bash, `set -euo pipefail`):

1. Resolve `REPO_ROOT` via `git rev-parse --show-toplevel`; cd there.
2. `COMPOSE="docker compose -p memex-test -f tests/compose.yaml"`.
3. `trap cleanup EXIT INT TERM` where `cleanup` runs
   `$COMPOSE down -v --remove-orphans >/dev/null 2>&1 || true`.
4. Preemptively call `cleanup` once before `up` to catch stale
   stacks from prior runs.
5. `$COMPOSE up -d --build --wait` (use the built-in `--wait`
   flag, which blocks until healthchecks pass; timeout via
   `COMPOSE_HTTP_TIMEOUT=120`).
6. Extra belt-and-suspenders: `tests/lib/wait-for.sh` polls
   `pg_isready` and `curl .../health` with a 60s budget, in case
   `--wait` is absent on an old compose binary.
7. Run `deno test --allow-net --allow-env --allow-read tests/unit/`.
8. Exit with the test runner's exit code; the trap handles teardown.

No parallelism. No test selection flags. One run, one result.

## 4. Implementation Plan

Eight phases, each independently reviewable. Each phase lists the
files it creates/modifies and the tasks. A phase is "done" when
its files exist, are committed, and — where applicable — the
smoke path through that phase works.

### Phase 1 — Directory skeleton and placeholders

Files created:
- `tests/.gitkeep`-style empties where needed
- `tests/integration/.gitkeep`
- `tests/lib/.gitkeep`
- `tests/mock-inference/fixtures/.gitkeep`

Tasks:
1. `mkdir -p tests/{unit,integration,lib,fixtures,mock-inference/fixtures}`.
2. Add `.gitkeep` to empty dirs that must exist for later phases.
3. Commit.

### Phase 2 — Canonicalization fixture

Files created:
- `tests/fixtures/canonicalization-cases.json`

Tasks:
1. Author ~22 test vectors, at minimum one per Section 6.4 rule
   plus combinations. Each entry:
   `{"name": "...", "rule": "...", "input": "...", "expected": "..."}`.
2. Encode tricky characters using JSON escapes (`\uFEFF`, `\r\n`,
   `\u0301`, emoji via `\uD83D\uDE00`, etc.) so the file is
   pure 7-bit ASCII and safe across editors.
3. Required cases:
   - `bom-stripped`: `"\uFEFFhello\n"` → `"hello\n"`
   - `crlf-to-lf`: `"a\r\nb\r\nc\n"` → `"a\nb\nc\n"`
   - `cr-to-lf`: `"a\rb\rc\n"` → `"a\nb\nc\n"` (old-Mac line endings)
   - `trailing-newlines-collapsed`: `"a\n\n\n"` → `"a\n"`
   - `missing-trailing-newline-added`: `"a"` → `"a\n"`
   - `leading-newlines-preserved`: `"\n\nhello\n"` → `"\n\nhello\n"`
   - `nfd-to-nfc-single`: `"e\u0301\n"` → `"\u00e9\n"`
   - `nfd-to-nfc-multi`: a longer NFD string → same in NFC
   - `already-nfc-unchanged`: `"café\n"` → `"café\n"`
   - `emoji-preserved`: `"hi 😀\n"` → `"hi 😀\n"`
   - `emoji-zwj-sequence`: family emoji preserved intact
   - `combining-mark-on-emoji`: preserved (weird but legal)
   - `internal-whitespace-preserved`: `"a    b\n"` → `"a    b\n"`
   - `trailing-double-space-markdown-break`: `"line  \n"` → `"line  \n"`
   - `indented-code-block`: 4-space indent preserved
   - `tab-indent-preserved`: `"\tcode\n"` → `"\tcode\n"`
   - `blank-lines-internal-preserved`: `"a\n\nb\n"` → `"a\n\nb\n"`
   - `windows-notepad-doc`: BOM + CRLF + trailing CRLF →
     LF, one trailing `\n`, no BOM
   - `very-long-content`: 100 KB of repeating text + `\n`
   - `empty-string`: `""` → `"\n"` (canonicalized to exactly one
     trailing newline per Section 6.4; call this out as the
     interpretation — see Open Questions)
   - `only-newlines`: `"\n\n\n"` → `"\n"`
   - `null-byte-preserved`: content with an embedded `\u0000`
     preserved unchanged (Postgres will reject it later; that is
     sprint 001's problem, not ours, but the vector documents
     intent)
4. Commit.

### Phase 3 — Mock inference service source

Files created:
- `tests/mock-inference/main.ts`
- `tests/mock-inference/deno.json`
- `tests/mock-inference/fixtures/chat.json`
- `tests/mock-inference/fixtures/embeddings.json` (stub: `{}`)

Tasks:
1. Write `main.ts` using `Deno.serve` and the standard library's
   router-free approach (`switch` on `url.pathname`).
2. Implement deterministic embedding generator from Section 3.3.
3. Implement special-input handling *before* normal embedding
   path. Substring match on the raw input string.
4. Implement chat completion endpoint reading `chat.json` at boot
   (cache in memory; reload is a future concern).
5. Implement `/health` and 404 fallback.
6. Log one line per request.
7. Populate `chat.json` with a minimal default response plus one
   `by_substring` entry (e.g., match `"topic"` → returns a
   metadata-extraction-shaped JSON the later sprints will need).
8. `deno.json` declares a `start` task: `deno run --allow-net --allow-read main.ts`.
9. Commit.

### Phase 4 — Mock inference Dockerfile

Files created:
- `tests/mock-inference/Dockerfile`
- `tests/mock-inference/.dockerignore`

Tasks:
1. Base image `denoland/deno:alpine-2.x` pinned to a specific
   minor. Copy source, `RUN deno cache main.ts` at build time
   (warms the module cache so container start is offline).
2. `EXPOSE 8000`. `CMD ["run", "--allow-net", "--allow-read",
   "--allow-env", "main.ts"]`.
3. `.dockerignore` excludes `fixtures/*.md` and editor droppings.
4. Verify locally: `docker build -t mock-inference:test
   tests/mock-inference && docker run --rm -p 58000:8000
   mock-inference:test` responds to `curl localhost:58000/health`.
5. Commit.

### Phase 5 — Compose file

Files created:
- `tests/compose.yaml`

Tasks:
1. Two services (`postgres`, `mock-inference`) as described in §3.2.
2. Both publish to `127.0.0.1:` explicitly (not `0.0.0.0`) to
   avoid exposing test DBs on LAN.
3. Healthchecks with `interval: 2s`, `timeout: 2s`, `retries: 30`,
   `start_period: 5s`.
4. Named network `memex-test-net`.
5. No bind mounts.
6. Verify locally: `docker compose -f tests/compose.yaml -p
   memex-test up -d --wait` succeeds and both `pg_isready` and
   `curl /health` pass.
7. `docker compose -p memex-test down -v` cleans up.
8. Commit.

### Phase 6 — Smoke test

Files created:
- `tests/unit/smoke.test.ts`
- `tests/deno.json` (workspace-level: pins std-lib, defines
  `task test`)

Tasks:
1. Deno test file with these steps:
   - `Deno.test("pg reachable", ...)` — open a TCP socket to
     `127.0.0.1:55432`, close it. No `pg` client dependency in
     sprint 000; the real DB test lives in sprint 001.
   - `Deno.test("mock /health", ...)` — fetch, assert 200 and
     `json.status === "ok"`.
   - `Deno.test("mock /embeddings deterministic", ...)` — POST
     the same input twice, assert responses are byte-identical
     and `data[0].embedding.length === 1536`, and that the
     vector is unit-length to within `1e-6`.
   - `Deno.test("mock /embeddings differs by input", ...)` —
     different inputs yield different first elements (with
     overwhelming probability). Asserts the generator is not
     accidentally constant.
   - `Deno.test("mock __fail_embed__", ...)` — POST with input
     containing `"__fail_embed__"`, assert status 500 and error
     shape.
   - `Deno.test("mock __slow_embed__", ...)` — measure elapsed
     time, assert ≥ 4500 ms and < 8000 ms. Give the test a 15s
     per-test timeout so CI is forgiving.
   - `Deno.test("mock /chat/completions default", ...)` — POST
     a non-matching prompt, assert the `default` fixture is
     returned.
   - `Deno.test("mock /chat/completions by_substring", ...)` —
     POST a prompt that contains the configured match token;
     assert the matching fixture is returned.
   - `Deno.test("canonicalization fixture well-formed", ...)` —
     read `tests/fixtures/canonicalization-cases.json`, assert:
     array, ≥ 20 entries, every entry has string `name`,
     `rule`, `input`, `expected`; names are unique; every rule
     from Section 6.4 appears at least once (hard-coded list
     of rule tags).
2. Keep the file under ~200 lines; no helper library needed.
3. Commit.

### Phase 7 — Runner script

Files created:
- `tests/run-tests.sh` (chmod +x)
- `tests/lib/wait-for.sh`

Tasks:
1. Implement §3.4 flow.
2. `wait-for.sh` exposes `wait_for_port HOST PORT TIMEOUT` and
   `wait_for_http URL TIMEOUT` using `bash /dev/tcp` and `curl`
   respectively. No `nc` dependency.
3. Runner prints a clear banner at start (`[run-tests] bringing
   up stack…`) and a green/red line at the end.
4. Runner accepts `--no-teardown` for debugging (documented in
   `tests/README.md`) — it sets a flag that skips the trap's
   `down` step. Default behavior is always full teardown.
5. Verify locally: `./tests/run-tests.sh` from a clean checkout,
   exit code 0.
6. Verify Ctrl-C path: start the runner, SIGINT after `up`,
   confirm `docker compose ls` shows no `memex-test` project.
7. Commit.

### Phase 8 — CI workflow and README

Files created:
- `.github/workflows/test.yml`
- `tests/README.md`

Tasks:
1. Workflow triggers: `push` to any branch, `pull_request`
   targeting `main`. One job `test` on `ubuntu-latest`.
2. Steps:
   - `actions/checkout@v4`
   - `denoland/setup-deno@v1` pinning a specific Deno version
   - `docker compose version` (sanity; Docker and compose v2 are
     preinstalled on `ubuntu-latest`)
   - `./tests/run-tests.sh`
3. No secrets referenced. `permissions: contents: read`. Fork
   PRs run the same job with no special handling.
4. Concurrency group per ref to cancel superseded runs.
5. `tests/README.md`:
   - Prerequisites: Colima (macOS) or Docker Desktop, Deno
     (with pinned version), `docker compose` v2.
   - Colima bootstrap: `brew install colima docker docker-compose
     && colima start`.
   - How to run: `./tests/run-tests.sh`.
   - How to debug: `./tests/run-tests.sh --no-teardown`, then
     `docker compose -p memex-test logs -f mock-inference`.
   - How to add a new canonicalization fixture: edit
     `tests/fixtures/canonicalization-cases.json`, add a
     `{name, rule, input, expected}` entry with JSON escapes,
     re-run tests.
   - How to add a new chat fixture: edit
     `tests/mock-inference/fixtures/chat.json`, either swap
     `default` or add a `by_substring` entry.
   - Ports: 55432 (pg) and 58000 (mock) bound to `127.0.0.1`
     only. If a port is already in use, set
     `MEMEX_TEST_PG_PORT` / `MEMEX_TEST_MOCK_PORT` before
     running. (Compose file reads these with defaults.)
6. Push to a throwaway branch, confirm CI is green.
7. Commit and merge.

## 5. Verification Plan

### 5.a Automated checks

Every check below is a discrete `Deno.test` in
`tests/unit/smoke.test.ts` unless otherwise noted. The executor
should implement each one as a single test with a descriptive
name; do not combine them.

| Check | Validates | Location | Implementation sketch |
|---|---|---|---|
| `pg tcp reachable` | Compose brought Postgres up on the expected host/port | `tests/unit/smoke.test.ts` | `await Deno.connect({hostname:"127.0.0.1", port:55432}).then(s=>s.close())` |
| `mock health 200` | Mock service is up and reachable | smoke.test.ts | `fetch("http://127.0.0.1:58000/health")` → `res.status === 200`, body `.status === "ok"` |
| `embedding shape` | Response matches OpenAI embeddings schema | smoke.test.ts | POST `{input:"hi", model:"x"}`; assert `data[0].embedding.length === 1536`, all elements `number` |
| `embedding unit norm` | Generator L2-normalizes | smoke.test.ts | sum of squares ≈ 1.0 ± 1e-6 |
| `embedding deterministic` | Same input → identical bytes | smoke.test.ts | Call twice, `JSON.stringify(a) === JSON.stringify(b)` |
| `embedding varies` | Different input → different vector | smoke.test.ts | Two distinct inputs; first elements differ |
| `embedding batch order` | Array input preserves order | smoke.test.ts | `input:["a","b"]` vs `["b","a"]`; first of one equals second of other |
| `__fail_embed__ returns 500` | Failure trigger works | smoke.test.ts | POST; assert `res.status === 500`, body `.error.type === "mock_failure"` |
| `__slow_embed__ delays ≥4.5s` | Slow trigger works | smoke.test.ts | `performance.now()` delta assertion; `--deno-timeout` 15s |
| `chat default` | Fallback fixture path | smoke.test.ts | POST with unmatched content; response deep-equals `fixtures/chat.json.default` |
| `chat by_substring` | Selector path | smoke.test.ts | POST with the configured match token; response deep-equals the matching entry |
| `canonicalization fixture parses` | JSON well-formed | smoke.test.ts | `JSON.parse(Deno.readTextFileSync(...))` succeeds |
| `canonicalization fixture schema` | Every entry has required fields | smoke.test.ts | Loop, `assertEquals(typeof e.name, "string")` etc. |
| `canonicalization fixture unique names` | No accidental duplicates | smoke.test.ts | `new Set(names).size === names.length` |
| `canonicalization fixture covers every rule` | Every Section 6.4 rule has ≥1 vector | smoke.test.ts | Hard-coded rule-tag allowlist; `assert(tagsSeen.has(rule))` for each |
| `canonicalization fixture count ≥ 20` | Minimum bar for usefulness | smoke.test.ts | `assert(cases.length >= 20)` |
| `CI green on push` | Runner works on a fresh GitHub runner | `.github/workflows/test.yml` | Workflow calls `./tests/run-tests.sh`; conclusion is `success` |

### 5.b Manual verification steps

Executor runs each of these by hand and records the observed
output in the sprint close-out:

1. **Clean local run.** From a fresh `git clone`, after installing
   Colima + Deno:
   ```bash
   ./tests/run-tests.sh
   ```
   Expected: exit code 0; last line reads `[run-tests] all tests
   passed`. `docker compose ls` shows no `memex-test` project
   afterward. `docker volume ls` shows no leaked volumes matching
   `memex-test_*`.

2. **Port exposure sanity check.** While the stack is up (run
   with `--no-teardown`):
   ```bash
   pg_isready -h 127.0.0.1 -p 55432
   curl -s http://127.0.0.1:58000/health
   lsof -iTCP:55432 -sTCP:LISTEN
   lsof -iTCP:58000 -sTCP:LISTEN
   ```
   Expected: `pg_isready` prints `accepting connections`; `curl`
   returns `{"status":"ok",...}`; both `lsof` lines show a
   docker process bound to `127.0.0.1` (not `*`).

3. **pgvector present.** With the stack up:
   ```bash
   docker compose -p memex-test exec postgres \
     psql -U memex -d memex_test -c 'CREATE EXTENSION IF NOT EXISTS vector; SELECT extname FROM pg_extension WHERE extname = '"'"'vector'"'"';'
   ```
   Expected: one row, `vector`.

4. **Determinism diff.** Two separate curl calls:
   ```bash
   curl -s -X POST http://127.0.0.1:58000/embeddings \
     -H 'content-type: application/json' \
     -d '{"input":"hello world","model":"x"}' > /tmp/a.json
   curl -s -X POST http://127.0.0.1:58000/embeddings \
     -H 'content-type: application/json' \
     -d '{"input":"hello world","model":"x"}' > /tmp/b.json
   diff /tmp/a.json /tmp/b.json
   ```
   Expected: empty diff, exit 0. This is the sprint-specific
   gotcha from the intent doc — the property that makes later
   sprints debuggable — and must be verified out-of-band of the
   Deno tests, because an in-process test could share a cache
   and accidentally pass.

5. **Failure-mode spot check.**
   ```bash
   curl -s -o /dev/null -w '%{http_code}\n' -X POST \
     http://127.0.0.1:58000/embeddings \
     -H 'content-type: application/json' \
     -d '{"input":"please __fail_embed__ now","model":"x"}'
   ```
   Expected: `500`.

6. **Slow-mode spot check.**
   ```bash
   time curl -s -o /dev/null -X POST \
     http://127.0.0.1:58000/embeddings \
     -H 'content-type: application/json' \
     -d '{"input":"__slow_embed__","model":"x"}'
   ```
   Expected: `real` ≥ 5.0s, response 200.

7. **Interrupted run leaves no residue.**
   ```bash
   ./tests/run-tests.sh &
   pid=$!; sleep 8; kill -INT $pid; wait $pid || true
   docker compose ls
   ```
   Expected: no `memex-test` project listed.

8. **CI green.** Push to a branch, open a draft PR; the `test`
   check runs and reports success within ~3 minutes.

9. **README walkthrough.** Follow `tests/README.md` top-to-bottom
   on a machine that has never seen the repo. Must reach a
   passing `run-tests.sh` without consulting any other document.

### 5.c Regression scenarios

None. Sprint 000 is the first code in the repository, so there is
nothing to regress. Record this explicitly in the sprint close-out
so the absence is deliberate, not an oversight. Every later sprint
must add regression checks when it reuses any of these artifacts.

### 5.d Sprint-specific gotchas

- **Determinism must be verified out-of-process.** The automated
  `embedding deterministic` check is run inside one Deno process,
  which could (in a future refactor) mask a cached response. The
  manual diff in step 4 runs two separate `curl` invocations and
  is the authoritative check. Keep it in the executor's manual
  checklist even after the automated test passes.
- **`__slow_embed__` timing is not CPU-bound.** The 5s delay is
  a `setTimeout`, so it's robust to slow CI runners, but the
  upper bound in the automated check should be generous (≤ 8s)
  to avoid flakiness under GitHub Actions scheduling jitter.
- **Compose `--wait` is only in v2.17+.** The runner uses it but
  must not rely on it alone — the explicit `wait-for.sh` polling
  step catches older compose binaries on contributor machines.
- **macOS Docker socket paths differ between Colima and Docker
  Desktop.** The runner must not hard-code `/var/run/docker.sock`
  or `$HOME/.colima/docker.sock`; it should let the `docker` CLI
  resolve the context. Test on at least one Colima machine before
  declaring the sprint done.
- **Deno permission flags leak between tests.** Always pass
  `--allow-net=127.0.0.1:55432,127.0.0.1:58000` rather than
  bare `--allow-net`, so accidental calls to a real network are
  rejected and the tests stay provably offline.
- **Canonicalization fixture is read by future sprints but not
  executed here.** Sprint 000 validates the *file*, not the
  *rules*. Do not attempt to canonicalize anything in this
  sprint; there is nothing to canonicalize with.
- **Port collisions.** 55432 and 58000 are non-standard and
  unlikely to collide, but the compose file reads
  `${MEMEX_TEST_PG_PORT:-55432}` and `${MEMEX_TEST_MOCK_PORT:-58000}`
  so a contributor can override without editing the file. See
  Open Questions 5 and 6.
- **GitHub Actions from fork PRs.** `pull_request` (not
  `pull_request_target`) runs with the fork's tree and no
  secrets. Since sprint 000 needs no secrets, this is safe;
  the workflow must not grow a `pull_request_target` trigger
  later without a security review.

## 6. Files Summary

**CI**
- `.github/workflows/test.yml`

**Test runner + libs**
- `tests/run-tests.sh`
- `tests/lib/wait-for.sh`
- `tests/deno.json`

**Compose stack**
- `tests/compose.yaml`

**Mock inference service**
- `tests/mock-inference/Dockerfile`
- `tests/mock-inference/.dockerignore`
- `tests/mock-inference/deno.json`
- `tests/mock-inference/main.ts`
- `tests/mock-inference/fixtures/chat.json`
- `tests/mock-inference/fixtures/embeddings.json` (stub)

**Shared fixtures**
- `tests/fixtures/canonicalization-cases.json`

**Tests**
- `tests/unit/smoke.test.ts`
- `tests/integration/.gitkeep`

**Docs**
- `tests/README.md`

Total: ~14 new files. No existing files modified.

## 7. Definition of Done

Checklist — every item must be independently testable and
observed by the executor before closing the sprint.

- [ ] `./tests/run-tests.sh` on a clean checkout exits 0.
- [ ] `./tests/run-tests.sh` leaves no `memex-test` compose
      project, no dangling containers, no named volumes.
- [ ] SIGINT during `run-tests.sh` triggers clean teardown.
- [ ] `pg_isready -h 127.0.0.1 -p 55432` passes while the stack
      is up.
- [ ] `CREATE EXTENSION vector;` succeeds in the test DB.
- [ ] `curl http://127.0.0.1:58000/health` returns 200 with
      `.status == "ok"`.
- [ ] Two identical `/embeddings` calls return byte-identical
      bodies (verified via `diff`, not only via in-process test).
- [ ] `/embeddings` returns a length-1536 numeric array, unit
      norm to 1e-6.
- [ ] `__fail_embed__` returns 500 with structured error body.
- [ ] `__slow_embed__` delays ≥ 5s.
- [ ] `/chat/completions` returns the `default` fixture for
      unmatched prompts and the configured `by_substring` entry
      for matched prompts.
- [ ] `tests/fixtures/canonicalization-cases.json` has ≥ 20
      entries, unique names, and covers every Section 6.4 rule.
- [ ] The smoke test runs each automated check from §5.a and
      all pass.
- [ ] `.github/workflows/test.yml` runs on push and PR, reports
      green on a trial run.
- [ ] A fork-PR simulation (branch with no access to secrets)
      also reports green.
- [ ] `tests/README.md` walks from "fresh machine" to "tests
      pass" without referring to any other file.
- [ ] `docker compose -f tests/compose.yaml config` validates
      (no warnings about the deprecated `version:` key).
- [ ] The mock inference image builds offline after the first
      `deno cache` — no network at container start.
- [ ] `run-tests.sh --no-teardown` leaves the stack up for
      debugging.
- [ ] Executor records the manual verification output from §5.b
      in the sprint close-out.

## 8. Risks & Mitigations

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Colima not installed / not started on contributor machine | High | Confusing error | `tests/README.md` lists Colima install + `colima start` as step 1; runner prints a clear "is Docker reachable?" error via `docker info` precheck |
| Colima Docker socket path differs from Docker Desktop | Medium | Runner picks wrong context | Use `docker` CLI's context resolution, never a literal socket path; test on Colima before sprint close |
| `docker compose --wait` not present on older v2 binaries | Medium | Runner hangs or misreports ready | Keep explicit `wait-for.sh` polling as a belt-and-suspenders layer regardless of `--wait` |
| GitHub Actions runner slower than local; `__slow_embed__` test flakes | Medium | CI red for non-reasons | Upper bound 8s, not 6s; single retry disabled (flaky tests must be fixed, not retried) |
| Port 55432 or 58000 collides with something on a contributor machine | Low | `docker compose up` fails | Compose reads env overrides `MEMEX_TEST_PG_PORT` / `MEMEX_TEST_MOCK_PORT`; documented in README |
| macOS filesystem semantics on bind mounts cause permission grief | Low | Container can't read fixtures | No host bind mounts at all; fixtures are `COPY`'d into the image at build time |
| Determinism bug hides behind in-process caching | Medium | Tests pass locally, fail across process restarts in future sprints | Manual `curl`-diff check is mandatory in §5.b; it runs two fresh processes |
| Compose stack left running across test runs leaks into local dev | Medium | Confusing state on developer box | Runner runs `down -v --remove-orphans` before `up`; trap catches all exit paths; use unique project name `memex-test` |
| Canonicalization fixture drifts from Section 6.4 as architecture evolves | Low (now) / High (over time) | Cross-sprint test inconsistency | Each entry carries a `rule` tag; smoke test asserts every rule from a hard-coded list appears; architecture change → grep → update |
| Fork PRs try to access secrets | N/A | Would break CI | Sprint 000 uses zero secrets; workflow uses `pull_request`, not `pull_request_target`; `permissions: contents: read` |
| Deno version drift between local and CI | Medium | Subtle API differences | Pin Deno version in both `tests/README.md` and `setup-deno` step; bump together |
| `pgvector/pgvector:pg16` image tag moves | Low | Hash drift | Pin to a specific digest (`@sha256:...`) if reproducibility matters; default to floating tag for now, flag in Open Questions |
| `denoland/deno:alpine` startup imports stdlib from network on first run | Medium | Mock service slow/offline failure in CI | `RUN deno cache main.ts` at image build time; runtime is fully offline |
| Test runner doesn't clean up on `kill -9` | Low | Stale stack | Unavoidable for SIGKILL; runner's preemptive `down` at start recovers on next run |
| Operator's local `docker compose` is v1 (`docker-compose`) | Low | Command not found | README specifies v2 (`docker compose`, space, not hyphen) and the runner uses that; Colima + recent Docker Desktop both ship v2 |

## 9. Dependencies

**Upstream (required before this sprint can start):** none. This
is the first sprint; the repo currently contains only docs,
`.gitignore`, `LICENSE`, and the sprint ledger scaffolding.

**Downstream (what this sprint produces for later sprints):**

- **Sprint 001** consumes:
  - `tests/compose.yaml` as the PostgreSQL instance it applies
    migrations against.
  - `tests/fixtures/canonicalization-cases.json` as the input to
    its SQL trigger test.
  - `tests/run-tests.sh` as the runner it adds its integration
    tests into.
- **Sprint 002+** consumes:
  - The mock inference service as the embedding/chat endpoint
    for server and daemon tests, keyed to the same fixtures
    files (which can grow, without changing the service code).
- **Sprint 003** (TypeScript server) consumes:
  - `tests/fixtures/canonicalization-cases.json` for
    `canonicalize.ts`'s test suite.
- **Sprint 005** (Python sync daemon) consumes:
  - Same fixture for `canonicalize.py`'s test suite.
- **All sprints** consume the CI workflow and smoke-test pattern
  as the baseline for how tests are structured and run.

Any future sprint that wants to modify `tests/compose.yaml`,
`tests/fixtures/canonicalization-cases.json`, or `tests/run-tests.sh`
should explicitly call that out in its own sprint plan, because
those files are a cross-sprint contract.

## 10. Open Questions

These are items the operator should resolve before or during
execution. The first eight map to the Open Questions section of
the intent document; the last three are new items the plan
surfaced.

1. **Smoke test language.** Proposed: Deno (consistent with the
   mock service, no extra toolchain). Shell would be lighter but
   obscures assertions and makes JSON comparisons painful. Default
   to Deno unless the operator objects. (Intent Q1.)

2. **CI: compose-in-job vs service containers.** Proposed: use
   the same `tests/compose.yaml` in CI as locally, via
   `run-tests.sh`. Single source of truth; one path to debug. The
   "GitHub service containers" shortcut saves ~20s of startup but
   splits the config. Default to compose-in-job. (Intent Q2.)

3. **Canonicalization vector count.** Proposed: the ~22 cases in
   Phase 2. Operator should add any "known-weird" real content
   from their existing Supabase OB1 memex before sprint close —
   the plan reserves room for this but cannot write those vectors
   without operator input. (Intent Q3.)

4. **Compose spec `version:` key.** Proposed: omit (Compose v2
   ignores and warns). This plan commits to omitting. (Intent Q4.)

5. **Mock inference port 58000.** Not a standard port for any
   common macOS service this plan is aware of. Proposed: keep
   58000, make it overridable via `MEMEX_TEST_MOCK_PORT`.
   (Intent Q5.)

6. **PostgreSQL port 55432.** Same treatment as Q5 via
   `MEMEX_TEST_PG_PORT`. (Intent Q6.)

7. **Fork PRs and secrets.** Sprint 000 needs no secrets; use
   `on: pull_request` (not `pull_request_target`). Confirmed
   in-plan. (Intent Q7.)

8. **Runner concurrency.** Serial only. No parallel test flags.
   (Intent Q8.)

9. **Canonicalization of the empty string.** Section 6.4's rules
   are "strip BOM, normalize line endings, exactly one trailing
   newline, NFC." Applied to `""`, the literal reading yields
   `"\n"`. This plan encodes that as the expected output of the
   `empty-string` vector. The operator should confirm this
   interpretation before sprint 001 implements the SQL trigger —
   the alternative (empty stays empty) would require a rule
   carve-out.

10. **pgvector image digest pinning.** Should `compose.yaml` pin
    `pgvector/pgvector:pg16` to a specific digest for
    reproducibility? Pro: hermetic CI. Con: manual bumps. Plan
    default: floating tag, revisit if a silent image bump
    breaks CI.

11. **Deno version.** Pin to a specific minor (e.g., `2.1.x`) in
    both `setup-deno` and `tests/README.md`. Which minor? Plan
    defers to whatever is current at sprint execution time, then
    hard-pins it.
