# Sprint 000: Test Platform and CI Scaffolding

## 1. Overview
This is the foundational sprint for the `mcp-memex` project. It establishes the ephemeral, reproducible test infrastructure that all subsequent sprints depend on. By delivering a Docker-based environment with PostgreSQL (pgvector) and a mock inference service, along with a "one-button" test runner and GitHub Actions CI, we ensure that every code change can be validated against a consistent environment from day one.

## 2. Use Cases

| Scenario | Input | Expected Behavior |
|---|---|---|
| **Local Test Execution** | Run `./tests/run-tests.sh` | Starts Compose, waits for services, runs smoke tests, tears down, exits 0. |
| **CI Validation** | Git push to `main` or PR | GitHub Actions triggers, runs the same Compose-based suite, reports green check. |
| **Deterministic Embeddings** | `POST /embeddings` with same text twice | Both responses return identical 1536-dim vectors. |
| **Failure Mode: Error** | `POST /embeddings` with `"__fail_embed__"` | Service returns 500 Internal Server Error. |
| **Failure Mode: Latency** | `POST /embeddings` with `"__slow_embed__"` | Service delays response by 5 seconds before returning vectors. |
| **Health Check** | `GET /health` | Returns `200 OK` with JSON `{"status": "ok"}`. |
| **Canonicalization** | Parse `canonicalization-cases.json` | JSON is valid and contains cases for BOM, CRLF, NFC, and trailing newlines. |

## 3. Architecture

### 3.1 Component Layout
The test platform lives entirely within the `tests/` directory to keep the root clean.

```
tests/
├── compose.yaml                 # PostgreSQL + Mock Inference
├── README.md                    # Contributor instructions
├── run-tests.sh                 # Entry point for local/CI testing
├── fixtures/                    # Shared JSON test vectors
│   └── canonicalization-cases.json
├── mock-inference/              # Deno-based mock service
│   ├── main.ts
│   ├── Dockerfile
│   └── fixtures/                # Canned chat/embedding responses
│       ├── embeddings.json
│       └── chat.json
└── unit/                        # Infrastructure smoke tests
    └── smoke.test.ts
```

### 3.2 Mock Inference Service API Contract
The mock service (Deno) implements a subset of the OpenRouter/OpenAI API:

- **`POST /embeddings`**:
  - Input: `{ "model": string, "input": string | string[] }`
  - Output: OpenAI-compatible embedding object.
  - Logic: Deterministic vectors derived from a hash of the input text.
- **`POST /chat/completions`**:
  - Input: OpenAI-compatible chat request.
  - Output: Canned response from `fixtures/chat.json`.
- **`GET /health`**:
  - Output: `200 OK`, `{"status": "ok"}`.

### 3.3 Infrastructure Details
- **Database**: `pgvector/pgvector:pg16` on port `55432`.
- **Mock Inference**: Deno server on port `58000`.
- **Runtime**: Colima (recommended for macOS) or Docker Desktop.

## 4. Implementation Plan

### Phase 1: Documentation and Structure
- **Task 1.1**: Create `tests/` directory structure.
- **Task 1.2**: Write `tests/README.md` covering prerequisites (Colima, Deno, psql) and usage.

### Phase 2: Canonicalization Fixtures
- **Task 2.1**: Create `tests/fixtures/canonicalization-cases.json`.
- **Task 2.2**: Populate with cases from `memex-architecture.md` Section 6.4:
  - BOM stripping
  - CRLF to LF
  - Trailing newline normalization (exactly one)
  - NFC normalization
  - Emoji and combining characters
  - Very long content (10KB+)

### Phase 3: Mock Inference Service
- **Task 3.1**: Implement `tests/mock-inference/main.ts` using Deno's `std/http`.
- **Task 3.2**: Implement deterministic hashing for embeddings (SHA-256 to float array).
- **Task 3.3**: Implement special triggers (`__fail_embed__`, `__slow_embed__`).
- **Task 3.4**: Create `tests/mock-inference/Dockerfile`.

### Phase 4: Docker Compose Configuration
- **Task 4.1**: Create `tests/compose.yaml`.
- **Task 4.2**: Configure `db` service with `pgvector/pgvector:pg16` and healthy check.
- **Task 4.3**: Configure `mock-inference` service with build context and health check.

### Phase 5: Test Runner Script
- **Task 5.1**: Create `tests/run-tests.sh`.
- **Task 5.2**: Implement logic: `docker compose up -d`, wait for health, run tests, `docker compose down`.
- **Task 5.3**: Ensure it handles cleanup on `SIGINT`/`SIGTERM`.

### Phase 6: Smoke Test
- **Task 6.1**: Create `tests/unit/smoke.test.ts`.
- **Task 6.2**: Test 1: Verify database connection (`psql` or Deno driver).
- **Task 6.3**: Test 2: Verify mock inference health and deterministic embeddings.
- **Task 6.4**: Test 3: Verify canonicalization fixtures are parseable.

### Phase 7: GitHub Actions CI
- **Task 7.1**: Create `.github/workflows/test.yml`.
- **Task 7.2**: Configure job to run on `ubuntu-latest`.
- **Task 7.3**: Execute `./tests/run-tests.sh` in the workflow.

## 5. Verification Plan

### (a) Automated Checks
| Check | Validation | File | Executor Implementation |
|---|---|---|---|
| **Service Health** | DB and Mock API respond | `tests/unit/smoke.test.ts` | `deno test` inside `run-tests.sh` |
| **Determinism** | Same input -> Same vector | `tests/unit/smoke.test.ts` | Call `/embeddings` twice, `assertEquals` |
| **Fixtures Validity** | JSON schema check | `tests/unit/smoke.test.ts` | `JSON.parse` and check keys |

### (b) Manual Verification
1. **Startup Check**:
   - `cd tests && docker compose up -d`
   - `pg_isready -h localhost -p 55432` -> Expect: `accepting connections`
   - `curl http://localhost:58000/health` -> Expect: `{"status": "ok"}`
2. **Determinism Gotcha**:
   - `curl -X POST http://localhost:58000/embeddings -d '{"input": "test"}' > r1.json`
   - `curl -X POST http://localhost:58000/embeddings -d '{"input": "test"}' > r2.json`
   - `diff r1.json r2.json` -> Expect: No difference.
3. **Full Runner**:
   - `./tests/run-tests.sh` -> Expect: All green, `docker ps` empty after exit.

### (c) Regression Scenarios
- **N/A**: This is Sprint 000. No prior code exists.

### (d) Sprint-Specific Gotchas
- **Port Collisions**: If ports `55432` or `58000` are in use, Compose will fail. The runner should check for port availability or provide clear error messages.
- **Deno version**: Ensure CI and local use compatible Deno versions (pin in `tests/README.md`).
- **Colima state**: macOS users must have `colima start` running; the runner should verify `docker info` before starting.

## 6. Files Summary

### Infrastructure
- `tests/compose.yaml`
- `tests/run-tests.sh`
- `tests/README.md`
- `.github/workflows/test.yml`

### Mock Inference Service
- `tests/mock-inference/main.ts`
- `tests/mock-inference/Dockerfile`
- `tests/mock-inference/fixtures/embeddings.json`
- `tests/mock-inference/fixtures/chat.json`

### Test Fixtures & Tests
- `tests/fixtures/canonicalization-cases.json`
- `tests/unit/smoke.test.ts`

## 7. Definition of Done
- [ ] `./tests/run-tests.sh` completes successfully on local machine (macOS with Colima).
- [ ] GitHub Actions workflow is green on push.
- [ ] Mock inference service responds to `__fail_embed__` with 500.
- [ ] `canonicalization-cases.json` covers all rules in `memex-architecture.md` 6.4.
- [ ] `tests/README.md` correctly lists all prerequisites and setup steps.
- [ ] Environment is cleanly torn down (no dangling volumes/containers) after `run-tests.sh`.

## 8. Risks & Mitigations

| Risk | Impact | Mitigation |
|---|---|---|
| **CI Latency** | Slow test feedback | Use small images (`denoland/deno:alpine`, `pgvector/pgvector:pg16`). |
| **Docker availability** | Developer cannot run tests | Provide clear instructions for Colima vs Docker Desktop in `tests/README.md`. |
| **Port Collision** | Tests fail to start | Use non-standard ports (55432, 58000) as specified in `ROADMAP.md`. |
| **Mock Divergence** | Later tests pass on mock but fail on real API | Keep the mock strictly OpenAI-compatible; document divergence if any. |

## 9. Dependencies
- **Before this sprint**: None (initial repo state).
- **Produced for later sprints**:
  - `tests/compose.yaml` (Used by all)
  - `tests/fixtures/canonicalization-cases.json` (Used by 001, 003, 005)
  - CI Workflow (Used by all)

## 10. Open Questions
1. **Smoke Test Language**: Decided on **Deno** for the smoke test to maintain consistency with the mock service and upcoming MCP server.
2. **CI Strategy**: We will use **Docker Compose inside the GitHub Actions job** rather than service containers. This ensures the CI environment matches the local environment exactly (including the custom mock image).
3. **Deno Version**: Should we pin a specific Deno version? Yes, v1.42+ is recommended for stable `std/http` and `deno test`.
