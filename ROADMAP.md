# mcp-memex Roadmap

**Status:** pre-implementation
**Last updated:** 2026-04-12
**Target release:** v0.1.0 (MVP)

This roadmap breaks the mcp-memex implementation into sprint-sized
chunks. Each entry is designed to be consumable by the `sprint-plan`
skill — it contains enough scope, deliverables, validation criteria,
and architecture references to generate a full SPRINT-NNN.md
document without re-deriving the design.

The architecture itself is specified in
[`memex-architecture.md`](memex-architecture.md). This document does
not restate design; it tracks *what gets built, in what order, to
what quality bar.*

## Overview

The MVP path to v0.1.0 is eleven sprints, divided into five tracks:

1. **Test platform** (sprint 000) — establish the test infrastructure
2. **Schema** (sprint 001) — establish the database layer
3. **MCP Server** (sprints 002–004) — build the memex-native server
4. **Sync Daemon** (sprints 005–007) — build the bidirectional sync
5. **Validation and Release** (sprints 008–010) — integration test,
   document, release

After v0.1.0, a post-release stream covers OB1 contributions and the
feature backlog from architecture Section 12.

**Sprint numbering is not load-bearing.** The numbers exist for
ordering and ledger tracking, not for permanent identification.
Reality often reveals "side quests" — work that's necessary but
unanticipated — and inserting those sprints may renumber later
ones. The dependency graph below is the authoritative ordering;
numbers are aliases for convenience.

### Dependency Graph

```
000 (Test platform)
  ↓
001 (Schema)
  ↓
002 (Server: scaffold + read tools)
  ↓
003 (Server: capture tool with B3) ───┐
  ↓                                    │
004 (Server: list_conflicts + polish) ─┤
                                       ↓
005 (Daemon: scaffold + wiki→DB) ─────┤
  ↓                                    │
006 (Daemon: DB→wiki + sync_log) ─────┤
  ↓                                    │
007 (Daemon: conflicts + adversarial) ─┤
                                       ↓
                                 008 (Integration tests)
                                       ↓
                                 009 (Documentation)
                                       ↓
                                 010 (v0.1.0 release)
```

Sprint 000 is foundational and blocks everything else. Sprints
001–004 and 005–007 form two tracks that converge at 008. In
practice this is a single-operator project so the tracks run
sequentially, but the server and the daemon have no runtime
dependency on each other within a sprint — either track can be
paused and resumed.

### Effort Estimates

Rough sizing, in the operator's part-time working hours:

| Sprint | Estimated effort |
|---|---|
| 000 Test platform | 2–3 days |
| 001 Schema | 2–3 days |
| 002 Server: read tools | 3–5 days |
| 003 Server: capture (B3) | 3–5 days |
| 004 Server: list_conflicts + polish | 1–2 days |
| 005 Daemon: wiki→DB | 3–5 days |
| 006 Daemon: DB→wiki + sync_log | 3–5 days |
| 007 Daemon: conflicts + adversarial | 3–5 days |
| 008 Integration tests | 2–3 days |
| 009 Documentation | 2–3 days |
| 010 v0.1.0 release | 1 day |

Total: approximately **27–43 days of part-time work**. Actual pace
depends on the operator's availability and how often sprint reviews
surface rework.

## Testing Strategy

Tests are run against an **ephemeral, Docker-based test environment**
that spins up fresh PostgreSQL, a mock inference API, and a local
git remote on demand. This environment is established in sprint 000
and extended by subsequent sprints as their testing needs grow.

### Why Ephemeral, Not Existing Infrastructure

The operator has an existing GitLab instance and a PostgreSQL
database on the NAS. Neither is used for routine testing. Using
them would create:

- **Shared state across test runs**, causing tests to see leftovers
  from previous runs and concurrent runs to interfere with each
  other.
- **Test pollution on real infrastructure**, where failed cleanup
  leaves cruft on production services.
- **Coupling tests to the operator's specific setup**, which
  prevents external contributors (and future-self setting up a new
  laptop) from running the test suite.
- **Credential management overhead** for real services when a local
  test environment needs no credentials at all.
- **Slower feedback** from tests that push to a remote server
  versus tests that use a local `file://` git remote.

The existing infrastructure remains valuable for **manual smoke
testing** after the MVP is deployed (sprint 008 includes a manual
run against the real Mycofu deployment) and for **scale
validation** with realistic corpus sizes. Both are occasional
activities, not routine CI.

### Test Platform Components

- **PostgreSQL 16+ with pgvector** via the `pgvector/pgvector:pg16`
  Docker image. Started per test run via Docker Compose (through
  Colima on macOS). Wiped between runs.
- **Mock inference service** — a ~50-line Deno HTTP server that
  provides an OpenRouter-compatible API with deterministic
  responses. Returns pre-generated 1536-dim vectors from a hash of
  input text for embeddings, returns canned JSON for chat
  completions. Tests request specific failure modes via special
  input values (`__fail_embed__`, `__slow_embed__`).
- **Local bare git remote** — created per test run in a tmpdir
  with `git init --bare /tmp/test-wiki-$$.git`. No network, no
  auth, no cleanup burden beyond `rm -rf`.
- **Canonicalization test vectors** — a shared
  `tests/fixtures/canonicalization-cases.json` file with input /
  expected-output pairs covering CRLF, BOM, NFD Unicode, trailing
  whitespace, and edge cases. The SQL trigger, the server's
  `canonicalize.ts`, and the daemon's `canonicalize.py` all test
  against this file. Drift between the three implementations
  becomes a test failure.
- **GitHub Actions CI** — runs the same Docker Compose environment
  on every push and pull request. Free for public repositories.
- **One-button test runner** — `./tests/run-tests.sh` starts the
  compose environment, runs the suite, and tears down on exit.

### Test Categories

- **Unit tests** run in isolation with no external dependencies.
  Located in `tests/unit/`. Fast; run on every save.
- **Database integration tests** run against the Docker Compose
  PostgreSQL. Validate migrations, triggers, generated columns,
  role permissions.
- **Server integration tests** run the MCP server against the
  compose environment, exercise MCP tools over real HTTP, validate
  responses.
- **Sync daemon integration tests** run the daemon against a test
  git remote and database, validate full sync cycles.
- **End-to-end tests** (sprint 008) spin up the server and daemon
  together with a populated wiki and database, exercise realistic
  scenarios (operator edits, AI captures, conflicts, deletions,
  rebuild from git).
- **Adversarial tests** (sprint 007) specifically target edge
  cases the normal test suite doesn't exercise: crashes mid-cycle,
  concurrent operator commits during sync, three-way conflicts,
  corrupted sync_state recovery.

### Test Platform Ownership

Sprint 000 establishes the platform. Subsequent sprints extend it:

- Sprint 001 adds schema-level database tests
- Sprint 002 adds server unit and integration tests
- Sprint 003 extends the mock inference service with capture-path
  failure modes
- Sprint 005 adds wiki fixtures for sync daemon tests
- Sprint 007 adds adversarial test harnesses
- Sprint 008 adds end-to-end test scenarios

The test platform is designed to be extended, not rebuilt. Each
sprint that touches it commits the extensions alongside the feature
code they test.

### Required Tools on the Developer Workstation

- **Colima** — open-source container runtime for macOS. Install
  with `brew install colima docker`. Start with `colima start`.
- **Deno** — for the server code and its tests. Install with
  `brew install deno`.
- **Python 3.10+** — for the daemon code and its tests. Already
  installed on the operator's workstation.
- **PostgreSQL client tools (psql)** — for debugging and manual
  inspection of test databases. Install with
  `brew install postgresql@16`.

Docker Desktop works as an alternative to Colima if already
installed. Colima is recommended for fresh setups because it is
open-source and has lower overhead.

---

## Sprint 000: Test Platform and CI Scaffolding

### Motivation

Every subsequent sprint runs tests. This sprint establishes the
test infrastructure all other sprints depend on: an ephemeral
Docker Compose environment with PostgreSQL and a mock inference
service, shared test fixtures, a one-button test runner, and
CI via GitHub Actions. Without this sprint, sprint 001 cannot
validate that its migrations work.

### Scope

**In scope:**

- `tests/compose.yaml` — Docker Compose file that brings up
  PostgreSQL 16+ with pgvector on port 55432 and a mock inference
  service on port 58000
- `tests/mock-inference/` — a ~50-line Deno HTTP server that
  implements an OpenRouter-compatible API:
  - `POST /embeddings` — returns deterministic 1536-dim vectors
    computed from a hash of the input text
  - `POST /chat/completions` — returns canned JSON responses from
    a fixtures file
  - `GET /health` — returns 200 OK
  - Special input handling: `"__fail_embed__"` returns a 500
    error, `"__slow_embed__"` delays the response by 5 seconds,
    etc., for testing failure modes in later sprints
- `tests/mock-inference/Dockerfile` — container image for the mock
  service
- `tests/fixtures/canonicalization-cases.json` — authoritative
  test vectors for content canonicalization. Each entry is
  `{input, expected}`. Covers CRLF, BOM, NFD Unicode, trailing
  newlines, emoji, very long content. Used by the SQL trigger test
  (in sprint 001), `canonicalize.ts` test (in sprint 003), and
  `canonicalize.py` test (in sprint 005).
- `tests/run-tests.sh` — one-button test runner that starts
  compose, runs the test suite, and tears down on exit
- `.github/workflows/test.yml` — GitHub Actions workflow that runs
  unit and integration tests on every push and pull request
- `tests/README.md` — contributor-facing documentation covering
  prerequisites (Colima, Deno), how to run tests locally, and how
  to add new test fixtures
- A placeholder unit test (`tests/unit/smoke.test.ts`) that simply
  asserts the test runner works end-to-end — this validates the
  platform itself before any real code exists to test

**Out of scope:**

- Actual migrations (sprint 001)
- Actual server or daemon code (later sprints)
- Test fixtures for wiki content (sprint 005 adds these)
- Server-specific or daemon-specific integration tests (later
  sprints)
- Performance benchmarking infrastructure (post-MVP)

### Deliverables

- `tests/compose.yaml` — Docker Compose with `pgvector/pgvector:pg16`
  and the mock inference service
- `tests/mock-inference/main.ts` — mock inference HTTP server
- `tests/mock-inference/Dockerfile` — container image
- `tests/mock-inference/fixtures/embeddings.json` — canned
  embedding responses (initially small; grows as needed)
- `tests/mock-inference/fixtures/chat.json` — canned chat
  completion responses (initially small)
- `tests/fixtures/canonicalization-cases.json` — canonicalization
  test vectors
- `tests/run-tests.sh` — runner script
- `.github/workflows/test.yml` — CI workflow
- `tests/README.md` — contributor documentation
- `tests/unit/smoke.test.ts` — placeholder smoke test

### Validation

- `./tests/run-tests.sh` starts the compose environment, runs the
  smoke test, tears down the environment, exits zero
- The compose environment exposes PostgreSQL on `127.0.0.1:55432`
  and the mock inference service on `127.0.0.1:58000`
- `pg_isready -h 127.0.0.1 -p 55432` reports ready after compose
  startup
- `curl http://127.0.0.1:58000/health` returns 200 after compose
  startup
- The mock inference service returns deterministic vectors for
  repeated requests with the same input
- Special inputs (`__fail_embed__`, `__slow_embed__`) behave as
  documented
- The GitHub Actions workflow runs to completion on a test push
  and shows a green check
- `tests/README.md` is clear enough that a contributor who has
  never seen the project can install Colima, clone the repo, and
  run the tests successfully

### Prerequisites

None. This is the first sprint.

### Architecture References

None directly — this sprint establishes test infrastructure, not
architectural components. The canonicalization test vectors
reference architecture Section 6.4 as the authoritative rule
source; later sprints (001, 003, 005) will use the vectors to
verify their implementations against the rules.

### Notes for sprint-plan

- The mock inference service is deliberately minimal. Resist the
  urge to make it "realistic." Determinism matters more than
  realism for test reliability.
- The canonicalization test vectors need the operator's input on
  edge cases they care about. Include "known-weird" content the
  operator has actually captured in their existing Supabase memex.
- Colima configuration notes should live in `tests/README.md`, not
  in scripts. Operators on non-macOS platforms will use Docker
  Desktop or podman and need the flexibility.

---

## Sprint 001: Schema Migrations and Migration Runner

### Motivation

Every subsequent sprint depends on a working database schema. The
schema is specified in architecture Section 6 as nine migrations.
This sprint lands those migrations as executable SQL files and
builds the minimal migration runner that applies them.

### Scope

**In scope:**

- Write migrations `0001_initial_schema.sql` through `0009_add_roles.sql`
  as specified in architecture Sections 6.1–6.9
- Write a minimal migration runner (Python or Bash; decided in sprint
  planning) that reads `schema_migrations`, applies pending migrations
  in order, records results with checksums
- Create a `migrations/` directory in the repo root and place all
  SQL files there
- Test migrations against the sprint 000 Docker Compose PostgreSQL
  instance
- Add schema-level database tests to `tests/integration/` that
  verify migration application, idempotency, trigger behavior, and
  the `canonicalize_thought_content()` function using the
  `tests/fixtures/canonicalization-cases.json` vectors from sprint 000
- Verify the PostgreSQL role permissions using the test runner
  (memex_mcp cannot DELETE; memex_sync can)

**Out of scope:**

- Integration with any specific deployment target (Mycofu NixOS
  module, Docker image, etc.)
- Rollback migrations (the architecture is forward-only)
- Running migrations as part of a service startup (that's sprint 002
  or later)

### Deliverables

- `migrations/0001_initial_schema.sql` through `migrations/0009_add_roles.sql`
- `scripts/memex-migrate` (runner)
- `tests/integration/test_migrations.ts` (or `.py`) — tests that
  apply migrations, verify schema, test the canonicalization
  trigger against the shared vectors, verify role permissions,
  and confirm idempotency
- Update `tests/run-tests.sh` to include the new integration tests
- `migrations/README.md` documenting how to run migrations manually

### Validation

- All 9 migrations apply cleanly against an empty PostgreSQL 16+
  with pgvector
- Re-running the migration runner after all migrations are applied is
  a no-op (idempotent)
- Applying migrations 0001–0005 then running 0006–0009 produces the
  same schema as applying all nine at once
- The `canonicalize_thought_content()` trigger fires on INSERT and
  UPDATE and correctly normalizes content (test with CRLF, BOM,
  trailing newlines, Unicode NFD content)
- The `content_fingerprint` generated column populates correctly
- The `memex_mcp` role cannot execute `DELETE FROM thoughts`
- The `memex_sync` role can execute `DELETE FROM thoughts`
- The sync_log trigger fires on INSERT/UPDATE/DELETE from non-daemon
  writers and skips when `app.sync_source = 'daemon'`

### Prerequisites

- Sprint 000 complete (test platform exists)

### Architecture References

- Section 5.4 (Additive-Only Extension)
- Section 6 in its entirety (all nine migrations with full SQL)

---

## Sprint 002: MCP Server Scaffold and Read Tools

### Motivation

The MCP server is the public interface of mcp-memex. This sprint
builds the scaffolding and the three read-only tools
(`search_thoughts`, `list_thoughts`, `thought_stats`) that don't
require the capture path's B3 parallelization. The capture tool is
held for sprint 003.

### Scope

**In scope:**

- Scaffold a Deno project with `deno.json`, import map, and the
  project directory structure from architecture Section 13.1
- Implement environment-variable configuration loading (all variables
  from architecture Section 9.1)
- Implement PostgreSQL connection pool using the `memex_mcp` role
- Implement multi-key authentication middleware (architecture Section
  9.3): read from a file, watch for changes, constant-time comparison
- Implement `/health` endpoint (architecture Section 9.4)
- Implement `search_thoughts` tool
- Implement `list_thoughts` tool
- Implement `thought_stats` tool
- Write Deno tests for each tool handler
- Minimal HTTP server setup (Hono framework, matching OB1's
  k8s-deployment choice)

**Out of scope:**

- `capture_thought` tool (sprint 003)
- `list_conflicts` tool (sprint 004)
- Canonicalization helper (sprint 003 — it's only needed for writes)
- Git subprocess helpers (sprint 003)
- End-to-end integration tests (sprint 008)

### Deliverables

- `mcp-server/` directory with Deno project scaffold
- `mcp-server/config.ts` — environment variable loading
- `mcp-server/db.ts` — PostgreSQL pool
- `mcp-server/auth.ts` — multi-key auth middleware
- `mcp-server/health.ts` — health endpoint
- `mcp-server/tools/search_thoughts.ts`
- `mcp-server/tools/list_thoughts.ts`
- `mcp-server/tools/thought_stats.ts`
- `mcp-server/index.ts` — main entry point
- `mcp-server/tests/` — unit tests for each component
- `mcp-server/README.md` — how to run the server locally against a
  test database

### Validation

- The server starts and listens on the configured port
- `/health` returns 200 with structured JSON matching architecture
  Section 9.4 shape
- `/health` returns 503 when the database is unreachable
- Multi-key auth accepts valid keys, rejects invalid ones, reloads
  the key file on change
- Unauthorized requests (missing or invalid `x-brain-key`) return 401
- `search_thoughts` against a populated database returns correctly
  ranked results matching the `match_thoughts` SQL function
- `list_thoughts` with each filter (type, topic, person, days) returns
  correct results
- `thought_stats` returns aggregated counts matching direct SQL queries
- Tests pass via `deno test`

### Prerequisites

- Sprint 001 complete (schema exists)

### Architecture References

- Section 4.1 (System Overview)
- Section 9.1 (Configuration Interface)
- Section 9.2 (MCP Tools, specifically the three read-only tools)
- Section 9.3 (Authentication)
- Section 9.4 (Health Endpoint)
- Section 9.5 (Role-Based Database Connection)

---

## Sprint 003: MCP Server Capture Tool with B3 Parallelization

### Motivation

The capture tool is the most complex part of the server because of
the B3 parallelized commit-before-respond path. This sprint
implements the capture flow specified in architecture Section 9.2
and the canonicalization helper that matches the SQL trigger from
migration 0004.

### Scope

**In scope:**

- Implement `canonicalize.ts` matching the SQL trigger from migration
  0004 byte-for-byte (NFC normalization, LF line endings, BOM
  stripping, trailing newline normalization)
- Implement `git.ts` subprocess helpers: fetch, add, commit, push,
  reset
- Implement a per-process git operation lock for concurrent captures
- Implement `capture_thought` using the B3 pattern from architecture
  Section 9.2:
  - Generate UUID client-side
  - Canonicalize content
  - Start in parallel: embedding call, metadata call, wiki file write,
    git commit, git push
  - On all success: INSERT into PostgreSQL with the pre-generated UUID
  - Return success to the MCP client
- Implement abort-on-failure error handling
- Write unit tests for `canonicalize.ts` including edge cases
  (CRLF, BOM, NFD, empty content, very long content)
- Write unit tests for the capture path using a mock embedding API
  and a temporary git repo

**Out of scope:**

- `list_conflicts` tool (sprint 004)
- Sync daemon interaction (different sprints)
- End-to-end integration tests against a real OpenRouter API (sprint
  008)

### Deliverables

- `mcp-server/canonicalize.ts` — matches the SQL trigger's behavior
- `mcp-server/git.ts` — subprocess helpers for git operations
- `mcp-server/tools/capture_thought.ts` — B3 capture path
- `mcp-server/tests/canonicalize.test.ts` — edge case coverage
- `mcp-server/tests/capture.test.ts` — capture path tests with mocks
- Comment in `canonicalize.ts` referencing the authoritative rule
  table in architecture Section 6.4 and the SQL trigger

### Validation

- Canonicalization test cases match the SQL trigger's output on the
  same input (can be tested by running both against a PostgreSQL
  instance and comparing)
- Capture test: happy path returns success, creates a commit, pushes
  to a local test remote, inserts a row in PostgreSQL
- Capture test: OpenRouter failure returns an error and leaves no
  partial state (no file, no commit, no row)
- Capture test: git push failure returns an error and resets local
  state
- Capture test: DB insert failure after successful git push is
  handled gracefully (design decision: document whether it rolls
  back the git commit or returns success and relies on daemon
  recovery — decide at sprint execution time)
- Concurrent captures serialize correctly via the git lock
- Total wall time for a successful capture is approximately
  max(OpenRouter_time, git_time) — not their sum — demonstrating the
  parallelization works

### Prerequisites

- Sprint 002 complete (server scaffold exists)

### Architecture References

- Section 5.1 (Write-Through Captures)
- Section 6.4 (Content Canonicalization)
- Section 9.2 (specifically the capture_thought subsection)

---

## Sprint 004: MCP Server list_conflicts and Polish

### Motivation

The `list_conflicts` tool is the final MCP endpoint for the MVP. It
reads `sync_state.in_flight_conflicts` and returns the list. This
sprint also polishes the server: structured logging, error messages,
documentation, and readiness for integration testing.

### Scope

**In scope:**

- Implement `list_conflicts` tool reading from `sync_state`
- Add structured logging throughout the server (JSON format for
  production use)
- Improve error messages on common failure modes
- Write README documentation for the server: configuration,
  deployment, operational considerations
- Create a `Dockerfile` or Deno compile target so the server can be
  run as a single binary in deployment scenarios that want it
- Tag the server codebase as ready for integration testing

**Out of scope:**

- Sync daemon work (sprints 005–007)
- Integration testing (sprint 008)

### Deliverables

- `mcp-server/tools/list_conflicts.ts`
- `mcp-server/logging.ts` — structured logging helpers
- `mcp-server/Dockerfile` — minimal container image
- Server-level README with configuration reference
- Cleaned-up error messages across all tools

### Validation

- `list_conflicts` returns an empty array when `sync_state.in_flight_conflicts`
  is empty
- `list_conflicts` returns structured entries matching the expected
  shape when conflicts exist
- The server's logs are JSON-parseable and contain expected fields
- The Dockerfile builds a working image
- The server passes all tests from sprints 002 and 003
- A manual smoke test against a populated database via an MCP client
  (Claude Desktop or similar) demonstrates all five tools work
  end-to-end

### Prerequisites

- Sprint 003 complete (capture tool works)

### Architecture References

- Section 8.6 (Conflict Handling — the MCP tool surfaces the data
  structure the daemon writes)
- Section 9.2 (list_conflicts specifically)

---

## Sprint 005: Sync Daemon Scaffold and Wiki → DB Direction

### Motivation

The sync daemon is a separate process (architecture Section 5.2)
that runs independently from the MCP server. This sprint scaffolds
the daemon and implements the wiki-to-database direction: detect
changes in the wiki repo, parse them, apply to PostgreSQL. The DB
direction comes in sprint 006.

### Scope

**In scope:**

- Decide on implementation language (Python or Deno). Recommendation:
  **Python** — simpler for systemd integration, easier subprocess
  management, familiar for operator debugging. Confirm at sprint
  planning time.
- Scaffold the daemon project structure
- Implement `canonicalize.py` (or `.ts`) matching the server's
  canonicalization byte-for-byte
- Implement git subprocess helpers (similar to the server's `git.ts`
  but for the daemon's own use)
- Implement the lifecycle infrastructure: lock file handling, systemd
  unit files, one-shot + timer execution model (architecture Section
  8.1)
- Implement phase 1 (fetch and reset to origin/main) of the sync cycle
- Implement phase 2 (wiki → DB): read git diff since
  `last_wiki_commit`, dispatch to handler, apply changes to PostgreSQL
- Implement the default `thought` file type handler:
  - Parse frontmatter and body
  - Canonicalize body
  - If the file has an `ob_id` that exists in DB: update the row
  - If the file has an `ob_id` that doesn't exist: insert with that
    UUID
  - If the file has no `ob_id`: generate one, insert, update frontmatter
  - Set `app.sync_source = 'daemon'` before writing to prevent
    sync_log loop
- Write unit tests for canonicalization (against the same test vectors
  as the server's tests)
- Write unit tests for the wiki → DB direction using a temporary git
  repo and a test database

**Out of scope:**

- DB → wiki direction (sprint 006)
- sync_log reading (sprint 006)
- Conflict detection (sprint 007)
- The full sync cycle (sprints 006 and 007)
- Adversarial testing (sprint 007)

### Deliverables

- `sync-daemon/` directory with project scaffold
- `sync-daemon/canonicalize.py` — matches server's canonicalize.ts
- `sync-daemon/git.py` — subprocess helpers
- `sync-daemon/handlers/thought.py` — wiki → DB handler for default
  file type
- `sync-daemon/lifecycle.py` — lock file, phase 1 fetch/reset, phase
  2 wiki → DB dispatch
- `sync-daemon/systemd/memex-sync.service` — one-shot unit
- `sync-daemon/systemd/memex-sync.timer` — timer with
  `OnUnitInactiveSec=2min`
- `sync-daemon/tests/` — unit tests
- Comment in `canonicalize.py` referencing the authoritative rule
  table in architecture Section 6.4 and the SQL trigger and
  server's canonicalize.ts

### Validation

- Canonicalization outputs match the server and the SQL trigger on
  the same inputs
- A file added to the wiki repo, committed, and pushed results in a
  new row in PostgreSQL on the next daemon run
- A file modified in the wiki repo results in an UPDATE of the
  corresponding row (identified by `ob_id`)
- A file with no `ob_id` in frontmatter gets one generated, inserted,
  and written back to frontmatter in a subsequent commit
- The daemon's writes do NOT produce sync_log entries (the session
  variable prevents it)
- Systemd timer fires every 2 minutes when the daemon is active

### Prerequisites

- Sprint 001 complete (schema and sync_log exist)
- Sprint 003 complete (canonicalize.ts exists — the daemon mirrors it)

### Architecture References

- Section 5.2 (Sync Daemon as Pure Sidecar)
- Section 6.4 (Canonicalization rules)
- Section 8.1 (Daemon Lifecycle)
- Section 8.2 (phases 1 and 2 specifically)
- Section 8.7 (Loop Prevention)

---

## Sprint 006: Sync Daemon DB → Wiki Direction and Full Cycle

### Motivation

Sprint 005 completed the wiki → DB half. This sprint completes the
DB → wiki half (reading `sync_log`, generating or updating wiki
files), wires up the full sync cycle (all six phases from
architecture Section 8.2), and implements the bounded-retry push
logic. At the end of this sprint the daemon performs a complete
round trip in both directions.

### Scope

**In scope:**

- Implement phase 3 (DB → wiki): read sync_log entries with
  `FOR UPDATE SKIP LOCKED`, generate or update wiki files, mark
  entries as processed
- Implement the filename convention from architecture Section 7.2
  (`YYYYMMDDHHMMSS-slug.md`)
- Implement frontmatter generation: `ob_id`, `ob_fingerprint`,
  `ob_synced_at`, `auto:` section from metadata, preserve `user:`
  section if the file exists
- Implement phase 4 (stage and commit) — detect changes, create
  commit with the memex-sync author identity
- Implement phase 5 (push) with the pull-then-commit bounded retry
  from architecture Section 8.5
- Implement phase 6 (advance watermark) — update
  `sync_state.last_wiki_commit` and other state keys
- Implement deletion handling from architecture Section 8.4: wiki
  file deletion triggers DB row deletion; DB-side deletes are not
  supported (role permissions prevent them)
- Integrate phases 1–6 into a cohesive sync cycle loop
- Write tests for the DB → wiki direction
- Write tests for the full cycle against a populated test environment

**Out of scope:**

- Three-way conflict detection (sprint 007)
- Conflict marker file generation (sprint 007)
- Adversarial test scenarios (sprint 007)

### Deliverables

- `sync-daemon/handlers/thought.py` extended with DB → wiki path
- `sync-daemon/filename.py` — filename generation helper
- `sync-daemon/frontmatter.py` — YAML frontmatter read/write with
  auto/user separation
- `sync-daemon/cycle.py` — the full phase-1-through-6 loop
- `sync-daemon/push.py` — pull-then-commit bounded retry
- Tests for: DB → wiki, full cycle, push retry, frontmatter
  preservation of user section

### Validation

- A new row inserted into PostgreSQL by an external writer (simulating
  an AI capture) results in a new wiki file with correct filename,
  frontmatter, and content on the next cycle
- An UPDATE to a row results in regenerated `auto:` metadata in the
  corresponding wiki file, while `user:` section is preserved
- A DELETE of a wiki file results in DELETE of the corresponding DB
  row
- A DB-side DELETE attempt via the `memex_mcp` role fails with a
  permission error (regression test for sprint 001)
- The full sync cycle (wiki → DB, then DB → wiki, then commit and
  push) completes without errors on a populated environment
- Push rejection triggers retry; after 3 failed retries the daemon
  exits cleanly with a non-zero status for the next timer tick to
  pick up

### Prerequisites

- Sprint 005 complete (daemon scaffold and wiki → DB direction)

### Architecture References

- Section 7.2 (Filename Convention)
- Section 7.3 (Frontmatter Structure — auto/user separation)
- Section 7.5 (Commit Attribution)
- Section 8.2 (all six phases)
- Section 8.3 (Change Detection via sync_log)
- Section 8.4 (Deletion Handling)
- Section 8.5 (Pull-Then-Commit)

---

## Sprint 007: Sync Daemon Conflict Detection and Adversarial Tests

### Motivation

Conflict detection and resolution is the hardest part of the sync
daemon's correctness story. This sprint implements three-way conflict
detection, conflict marker file writing, and the `sync_state.in_flight_conflicts`
management. It also runs the adversarial test suite to validate
crash recovery, race conditions, and edge cases that normal
end-to-end tests don't exercise.

### Scope

**In scope:**

- Implement three-way conflict detection from architecture Section
  8.6: compute wiki_hash, db_hash, ancestor_hash (from frontmatter),
  detect the conflict condition
- Implement conflict marker file writing to
  `conflicts/{ob_uuid}.conflict.md` with all three versions
- Manage `sync_state.in_flight_conflicts`: add to the list on detect,
  remove on resolution
- Skip conflicted thoughts during normal sync cycles
- Detect resolution: operator edited the original file, deleted the
  marker, committed — the daemon sees the wiki-side change and
  advances state
- Write adversarial tests:
  - Crash mid-cycle at each phase boundary
  - Concurrent operator commit during the daemon's cycle (triggering
    push retry)
  - Two-way simultaneous change creating a real conflict
  - Deletion of a thought during the cycle
  - Corruption of sync_state (recovery behavior)
  - Loss of the wiki checkout (recovery from remote)

**Out of scope:**

- Integration tests against a real OpenRouter API (sprint 008)
- Performance benchmarking (sprint 008)

### Deliverables

- `sync-daemon/conflict.py` — conflict detection logic
- `sync-daemon/conflict_marker.py` — marker file generation
- `sync-daemon/handlers/conflict.py` — handler for conflict files
  (no-op in MVP, but the dispatch registration exists)
- `sync-daemon/tests/adversarial/` — adversarial test suite
- Documentation of conflict recovery procedures for the operator

### Validation

- A deliberate three-way conflict (wiki file and DB row both changed
  since last sync) is detected and a marker file is written
- The `sync_state.in_flight_conflicts` array contains the `ob_uuid`
  of the conflicted thought
- Subsequent sync cycles skip the conflicted thought and process
  others normally
- When the operator edits the original file and deletes the marker,
  the daemon detects the resolution on the next cycle
- All adversarial tests pass
- Crash mid-cycle at any phase boundary results in a clean recovery
  on the next cycle (no data loss, no inconsistent state)

### Prerequisites

- Sprint 006 complete (full sync cycle works)

### Architecture References

- Section 5.7 (Conflict Flagging for Human Review)
- Section 8.6 (Conflict Handling in detail)
- Section 8.8 (Crash Recovery)

---

## Sprint 008: End-to-End Integration Testing

### Motivation

With the server and daemon both implemented, this sprint validates
that they work correctly together in a realistic end-to-end
scenario. This is the first time real OpenRouter API calls are
made; real git pushes to a real remote; real MCP clients connecting
to a real endpoint. Any integration issues surface here.

### Scope

**In scope:**

- Stand up a test environment: PostgreSQL 16+ with pgvector, the
  mcp-memex server, the sync daemon, a local test git remote
- Run end-to-end scenarios:
  - Operator creates a file in the wiki repo, commits, pushes. Daemon
    picks it up, inserts a row. MCP client searches and finds it.
  - MCP client captures a new thought. Server writes to git and
    PostgreSQL in parallel (B3). Daemon regenerates frontmatter with
    full metadata on next cycle.
  - Operator edits an existing file. Daemon updates the row. Search
    reflects the change.
  - Operator deletes a file. Daemon deletes the row.
  - Deliberate three-way conflict. Marker file is created. Operator
    resolves. Sync resumes.
  - Wipe the database entirely. Start the daemon. Verify the database
    is rebuilt from the wiki repo with all rows intact.
- Measure capture latency end-to-end, validate the B3 parallelization
  actually produces the expected wall-time savings
- Measure rebuild-from-git time at the current data volume (should
  be minutes, not hours)
- Measure sync cycle duration in steady state
- Document any issues found and file them as post-v0.1.0 work or
  in-sprint fixes

**Out of scope:**

- Performance tuning (can be done post-v0.1.0 if measurements reveal
  issues)
- Deployment to any specific platform (that's for downstream
  integration projects like mcp-memex-mycofu)

### Deliverables

- `tests/integration/` directory with end-to-end test scripts
- A `docker-compose.yml` or similar that brings up a full test
  environment
- A test results document capturing measured latencies and any
  issues discovered
- Any bug fixes found during integration testing, landed via
  in-sprint commits

### Validation

- All end-to-end scenarios pass
- Capture latency in memex-R mode is within 20% of the theoretical
  minimum (OpenRouter round-trip time, which is the critical path)
- Rebuild-from-git time is under 10 minutes for a test corpus of
  ~1000 thoughts
- No false-positive conflicts during normal operation
- Database and wiki remain consistent after all scenarios

### Prerequisites

- Sprints 004 and 007 complete (server and daemon fully implemented)

### Architecture References

- Section 4.2 (Data Flow — all three paths tested)
- Section 4.3 (Key Properties — not precious state claim validated)

---

## Sprint 009: Quick-Start Documentation and Deployment Guide

### Motivation

mcp-memex is useless to anyone but the author until there's
documentation explaining how to deploy and use it. This sprint
writes the operator-facing docs that make the project usable by
someone who has never seen it.

### Scope

**In scope:**

- Quick-start guide: how to deploy mcp-memex on a generic Linux
  host using Docker Compose or systemd, without Mycofu
- Configuration reference: every environment variable, what it does,
  what the default is, when you'd change it
- Schema reference: the tables and columns for people who want to
  query directly
- MCP tool reference: each tool, its inputs, outputs, examples
- Troubleshooting guide: common problems and their fixes
- Sync daemon operations guide: how to diagnose stuck syncs, read
  conflict markers, resolve conflicts manually
- Contributing guide: how to submit improvements to mcp-memex
- Security considerations: what the threat model is, what it isn't,
  what to do if access keys leak

**Out of scope:**

- Mycofu-specific deployment (that's in home-infrastructure/memex-integration.md)
- Future-features documentation (the architecture doc already has it)
- API reference generation from code (if wanted, post-v0.1.0)

### Deliverables

- `docs/quick-start.md` — deploy in 10 minutes on a Linux box
- `docs/configuration.md` — environment variable reference
- `docs/schema.md` — database schema reference
- `docs/mcp-tools.md` — tool reference
- `docs/troubleshooting.md` — common problems
- `docs/operations.md` — sync daemon operations
- `CONTRIBUTING.md` — contribution process
- `docs/security.md` — threat model and key management
- Updated README.md pointing at all of the above

### Validation

- A reader who has never seen mcp-memex can follow
  `docs/quick-start.md` and successfully deploy a working instance
  on a Linux box within 30 minutes
- All environment variables mentioned in the server and daemon are
  covered in `docs/configuration.md`
- Every MCP tool is documented with at least one example in
  `docs/mcp-tools.md`
- The schema reference matches the actual migrations in `migrations/`
- Cross-references between documents are correct

### Prerequisites

- Sprint 008 complete (the software works end-to-end, so docs can
  be written against a working system)

### Architecture References

- All sections — the docs are user-facing translations of the
  architecture

---

## Sprint 010: v0.1.0 Release and OB1 Contributions

### Motivation

With the software working and documented, this sprint formally
releases v0.1.0 and submits focused improvements back to OB1 as
upstream contributions. It's the smallest sprint but the one that
marks the project as publicly usable.

### Scope

**In scope:**

- Tag v0.1.0 with a release commit
- Write release notes describing what's included, what's not,
  known limitations, and how to report issues
- Create a GitHub release with the release notes
- Prepare and submit upstream contributions to OB1:
  - HNSW vector index for `integrations/kubernetes-deployment/k8s/init.sql`
  - `updated_at` column for the same schema
  - Documentation improvements if any were identified
- Announce mcp-memex to the OB1 community (via GitHub discussion or
  Discord, collegial and brief)
- Update the mcp-memex README with a "Status: v0.1.0 released" badge
  and a link to the release

**Out of scope:**

- Any new features (that's post-v0.1.0 work)
- Larger architectural contributions to OB1 (that would be a
  different conversation with the OB1 maintainer)

### Deliverables

- A `v0.1.0` git tag
- A GitHub release with release notes
- Submitted PRs to OB1 (at least the HNSW index, probably also
  `updated_at`)
- Updated README
- A short announcement post or discussion thread in the OB1 community

### Validation

- `git tag --list` shows `v0.1.0`
- The GitHub release is visible at `github.com/wuertele/mcp-memex/releases`
- The OB1 PRs are submitted and awaiting review (merging is not
  required for this sprint to complete)
- The README reflects the released state

### Prerequisites

- Sprint 009 complete (documentation ready for public release)

### Architecture References

- Section 11.3 (Planned Contributions from memex to OB1)

---

## Post-v0.1.0: Ongoing Activities

These are not sprints on the MVP path; they are continuing streams of
work after the initial release.

### OB1 Upstream Contributions

Track upstream OB1 changes and port generally-useful improvements to
the mcp-memex server. Submit PRs back to OB1's k8s-deployment variant
for improvements that benefit any OB1 user.

### Feature Backlog

The future features listed in architecture Section 12 become
candidate sprints after v0.1.0 ships:

- 12.1 Task lifecycle tracking
- 12.2 Attachments (images, PDFs, audio)
- 12.3 Rollup views
- 12.4 Backlinks derivation
- 12.5 Lexical search
- 12.6 Daily notes
- 12.7 Near-duplicate detection
- 12.8 Typed notes
- 12.9 LISTEN/NOTIFY real-time sync
- 12.10 Voice capture
- 12.11 Web clipping

Each of these becomes a sprint (or two) when scheduled. Priority
depends on operator need, not a pre-committed order.

### Maintenance

- Regular dependency updates (Deno, PostgreSQL, pgvector)
- Bug fixes reported via GitHub issues
- Documentation updates as issues surface
- Sync daemon observability improvements if operational pain
  emerges

---

## Notes on Sprint Execution

- **Sprint numbers are not load-bearing.** Numbers exist for
  ordering and ledger tracking, not permanent identification.
  Side-quest sprints — work that's necessary but unanticipated —
  will be inserted over time. When a new sprint lands between
  existing ones, either use a non-integer number (`001a`, `003b`)
  if the ledger tolerates it, or renumber downstream sprints. The
  ledger CLI supports arbitrary zero-padded IDs, so both approaches
  work. When this roadmap is updated with new sprints, review the
  dependency graph and the change log to keep them consistent.
- **The dependency graph is authoritative.** If the numbering in
  this document ever drifts from the graph, trust the graph. Sprint
  prerequisites reference specific sprints by number, but readers
  should cross-check the graph to make sure the ordering still makes
  sense.
- **Sprint granularity:** each sprint is designed to be 2–5 days of
  focused work. If a sprint turns out to need more, split it into
  two sprints rather than letting the scope grow. Scope creep
  produces sprints that never complete.
- **Architecture as authority:** if implementation reveals a conflict
  between the sprint plan and the architecture document, the
  architecture wins. Update the architecture first, then adjust the
  sprint. Never silently diverge.
- **Sync between server and daemon canonicalization:** sprint 003
  builds the server's `canonicalize.ts`; sprint 005 builds the
  daemon's `canonicalize.py`. These two must stay byte-for-byte
  equivalent. Any fix or change to one requires the same fix to the
  other. Both must be tested against the authoritative canonicalization
  test vectors from sprint 000 (`tests/fixtures/canonicalization-cases.json`)
  and against the SQL trigger from migration 0004 as the single
  source of truth.
- **Testing bar:** every sprint beyond sprint 000 writes tests
  using the platform sprint 000 established. Unit tests run per
  sprint; integration tests grow alongside features. Sprint 008 is
  the first end-to-end integration that exercises the whole system.
  If unit tests are lax in any earlier sprint, sprint 008 surfaces
  the problems, which is fine but slower than catching issues
  earlier. Lean toward writing tests.
- **Review cadence:** each sprint is executed via the `sprint-execute`
  skill, which runs multi-agent review rounds (Claude, Codex, Gemini)
  until pass or the 3-round safety cap. Plan sprints with
  `sprint-plan` before executing.
- **Do not skip sprints:** the dependency graph exists because each
  sprint needs its predecessors. Starting sprint 005 before sprint
  001 is done produces a daemon that doesn't have a schema to talk
  to.
- **Side quests are expected.** During development it is normal to
  discover that a sprint depends on infrastructure that doesn't
  exist yet, or on a fix for a bug in a completed sprint, or on a
  pattern that could be reused if extracted into its own sprint.
  When this happens, don't try to cram the side quest into the
  current sprint. Stop, file a new sprint for the side quest, and
  resume the current sprint only after the side quest is complete.
  Add the new sprint to the ledger, add it to this roadmap, update
  the dependency graph, and adjust the change log.

---

## Change Log

| Version | Date | Summary |
|---|---|---|
| draft 1 | 2026-04-12 | Initial roadmap with 10 sprints to v0.1.0 plus post-release ongoing streams. |
| draft 2 | 2026-04-12 | Added sprint 000 (Test Platform and CI Scaffolding) as a foundational sprint blocking everything else. Added a Testing Strategy section describing the ephemeral Docker Compose environment (PostgreSQL via pgvector/pgvector:pg16, mock inference service, local file:// git remote, shared canonicalization test vectors, GitHub Actions CI). Updated the dependency graph and effort estimates. Added guidance to Notes on Sprint Execution about sprint renumbering, the authoritative dependency graph, and the "side quest" pattern for unanticipated work. Tool recommendation: Colima for container runtime on macOS. |
