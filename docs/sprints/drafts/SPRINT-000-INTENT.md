# Sprint 000 Intent: Test Platform and CI Scaffolding

## Seed

From `ROADMAP.md`, Sprint 000:

> **Motivation:** Every subsequent sprint runs tests. This sprint
> establishes the test infrastructure all other sprints depend on:
> an ephemeral Docker Compose environment with PostgreSQL and a mock
> inference service, shared test fixtures, a one-button test runner,
> and CI via GitHub Actions. Without this sprint, sprint 001 cannot
> validate that its migrations work.
>
> **In scope:**
> - `tests/compose.yaml` — Docker Compose file that brings up
>   PostgreSQL 16+ with pgvector on port 55432 and a mock inference
>   service on port 58000
> - `tests/mock-inference/` — a ~50-line Deno HTTP server that
>   implements an OpenRouter-compatible API with `POST /embeddings`
>   returning deterministic 1536-dim vectors from a hash of input
>   text, `POST /chat/completions` returning canned JSON responses
>   from a fixtures file, `GET /health` returning 200 OK, and
>   special input handling (`"__fail_embed__"` returns 500,
>   `"__slow_embed__"` delays 5s) for testing failure modes in later
>   sprints
> - `tests/mock-inference/Dockerfile` — container image for the mock
>   service
> - `tests/fixtures/canonicalization-cases.json` — authoritative
>   test vectors for content canonicalization. Each entry is
>   `{input, expected}`. Covers CRLF, BOM, NFD Unicode, trailing
>   newlines, emoji, very long content. Used by the SQL trigger test
>   (in sprint 001), `canonicalize.ts` test (in sprint 003), and
>   `canonicalize.py` test (in sprint 005).
> - `tests/run-tests.sh` — one-button test runner that starts
>   compose, runs the test suite, and tears down on exit
> - `.github/workflows/test.yml` — GitHub Actions workflow that runs
>   unit and integration tests on every push and pull request
> - `tests/README.md` — contributor-facing documentation covering
>   prerequisites (Colima, Deno), how to run tests locally, and how
>   to add new test fixtures
> - A placeholder unit test (`tests/unit/smoke.test.ts`) that simply
>   asserts the test runner works end-to-end — this validates the
>   platform itself before any real code exists to test
>
> **Out of scope:**
> - Actual migrations (sprint 001)
> - Actual server or daemon code (later sprints)
> - Test fixtures for wiki content (sprint 005 adds these)
> - Server-specific or daemon-specific integration tests (later
>   sprints)
> - Performance benchmarking infrastructure (post-MVP)

The full entry, including deliverables, validation criteria, and
notes for sprint-plan, is in `ROADMAP.md` (Sprint 000 section).
Read it before drafting.

## Context

mcp-memex is a brand-new standalone project. The repository
currently contains:

- `README.md` — project introduction and relationship to OB1
- `LICENSE` — MIT
- `memex-architecture.md` — 1,673-line authoritative architectural
  specification (deployment-target-agnostic)
- `ROADMAP.md` — 1,195-line sprint roadmap to v0.1.0
- `docs/sprints/` — ledger infrastructure (`ledger.py`, empty
  `ledger.tsv`, `drafts/` subdirectory, `README.md`)
- `.gitignore`

**There is no CLAUDE.md**, no existing sprints, no test
infrastructure, no source code, and no CI configuration. This is
the first sprint. Sprint 000 establishes infrastructure that all
subsequent sprints depend on.

The project builds on OB1 (Open Brain) primitives at the schema
and protocol level but is implemented as a standalone project with
its own repository, its own MCP server code, and its own sync
daemon. See `memex-architecture.md` for the full design.

## Recent Sprint Context

**First sprint.** No prior sprints exist in mcp-memex.

## Relevant Codebase Areas

- `memex-architecture.md` — Section 6 (Schema Design) describes
  content canonicalization rules (Section 6.4) that the test
  vectors must cover. Section 9 (MCP Server) describes the
  inference API surface the mock service must implement. Section 10
  (Inference Backends) describes what memex-R and memex-L clients
  expect from the inference API.
- `ROADMAP.md` — Sprint 000 entry (lines 207+) is the authoritative
  seed. Subsequent sprint entries (001-010) describe how the test
  platform will be extended, which informs what scaffolding and
  fixture patterns Sprint 000 should establish.
- No existing source code to extend. Sprint 000 creates the first
  code in the repository.

## Constraints

- **Stay within the mcp-memex repository.** Do not reference
  `~/home-infrastructure/` or any other sibling project. mcp-memex
  is standalone; its sprint documents, conventions, and
  infrastructure must be self-contained.
- **Follow the directory layout conventions in `memex-architecture.md`
  Section 13.1.** In particular, the `tests/` directory layout, the
  `mcp-server/`, `sync-daemon/`, and `migrations/` placeholders
  should be respected (though sprint 000 only creates `tests/` and
  related scaffolding; the source directories are empty or absent
  until their own sprints).
- **Use Colima as the recommended container runtime** on macOS.
  Docker Desktop is acceptable if already installed but not
  required. The test infrastructure must work with either.
- **PostgreSQL image: `pgvector/pgvector:pg16`.** This image
  includes pgvector pre-installed and supports HNSW indexes. Do not
  substitute a plain postgres image and install pgvector manually.
- **The mock inference service must be deterministic.** Same input
  → same output, every time, so test failures are reproducible.
- **The mock inference service must be offline.** No real network
  calls to OpenRouter or anywhere else.
- **Every test run must start from a clean state.** No shared state
  between runs. The compose teardown must be clean.
- **CI runs on GitHub Actions** (the project is hosted at
  `wuertele/mcp-memex` on GitHub). Free tier is sufficient for
  public repositories.
- **Tests must be runnable locally without any auth.** No
  credentials, no API keys, no account setup. Contributors
  (including future-Dave) should be able to clone the repo, install
  Colima and Deno, and run tests.
- **The canonicalization test vectors are the cross-implementation
  consistency mechanism.** Sprint 001 (SQL trigger), sprint 003
  (TypeScript `canonicalize.ts`), and sprint 005 (Python
  `canonicalize.py`) will all test against the same JSON file.
  Drift between implementations becomes a test failure. Sprint 000
  establishes the file; sprint 000's own tests don't verify the
  vectors against any implementation (no implementations exist
  yet), but the smoke test should validate the JSON is
  well-formed and parseable.
- **The `ob_fingerprint` concept and canonicalization rules** are
  defined in `memex-architecture.md` Section 6.4. Test vectors
  must match those rules: UTF-8 NFC, LF line endings, exactly one
  trailing newline, BOM stripped, internal whitespace preserved.

## Success Criteria

Sprint 000 is successful if:

1. `./tests/run-tests.sh` can be run from a clean clone of
   mcp-memex (assuming Colima and Deno are installed) and it:
   - Starts the Docker Compose environment
   - Waits for PostgreSQL and the mock inference service to be
     ready
   - Runs the placeholder smoke test
   - Tears down the environment cleanly
   - Exits zero on success
2. A `git push` triggers GitHub Actions, which runs the same
   suite on a fresh runner and reports a green check.
3. Sprint 001 can begin immediately without any additional test
   infrastructure setup. The schema migration work can plug into
   the existing platform by adding new database-level tests to
   `tests/integration/`.
4. The mock inference service correctly responds to:
   - `POST /embeddings` with deterministic 1536-dim vectors
   - `POST /chat/completions` with canned JSON
   - `GET /health` with 200 OK
   - The documented failure-mode triggers (`__fail_embed__`,
     `__slow_embed__`)
5. `tests/fixtures/canonicalization-cases.json` contains at least
   one test case for every rule in `memex-architecture.md` Section
   6.4 (BOM stripping, CRLF→LF normalization, trailing newline
   collapse, NFC normalization, emoji/combining character
   preservation, very long content).
6. `tests/README.md` is clear enough that a contributor following
   it can install prerequisites and run tests without having to
   read any other file.

## Open Questions

1. **Language for the smoke test.** Deno (since the mock service
   is Deno) is the natural default but the smoke test could also
   be a shell script if Deno test scaffolding would introduce
   overhead. What's the right balance?
2. **GitHub Actions: service container vs docker-compose-in-job.**
   GitHub Actions supports PostgreSQL as a native service
   container, which would be simpler than running docker compose
   inside the job. However, the mock inference service is custom
   code and must run as a docker image built in-job, so we need
   compose anyway. Should the CI workflow use the same compose
   file as local development (simpler, single source of truth) or
   use GitHub's native service containers for PostgreSQL and only
   docker for the mock service (faster, but two paths to
   maintain)?
3. **Canonicalization test vector coverage.** The architecture
   Section 6.4 lists canonicalization rules but doesn't enumerate
   every edge case. How many test vectors is enough? My initial
   answer: ~20-30 cases covering each rule plus common
   combinations plus known "gotchas" (emoji+combining character,
   indented code blocks, trailing double-space markdown line
   breaks). The drafts should propose specific test vectors.
4. **Docker Compose version pinning.** Should `compose.yaml`
   specify a Compose spec version? Modern Compose ignores
   `version:` but older versions require it. Best practice today
   is to omit `version:` (Compose v2 assumes the latest spec).
   Drafts should confirm this and call it out if not.
5. **Mock inference service port.** The roadmap specified 58000.
   Is there any reason this might conflict with anything on a
   typical macOS developer workstation? Drafts should verify or
   propose alternatives if 58000 is known to collide with common
   software.
6. **PostgreSQL port.** The roadmap specified 55432. Same question
   as above. The standard PostgreSQL port is 5432; 55432 is chosen
   to avoid collision with a locally-running PostgreSQL if any.
   Drafts should confirm or propose alternatives.
7. **CI on pull requests from forks.** GitHub Actions restricts
   secrets and some features on PRs from forks. Should the
   workflow accommodate this now or defer? For sprint 000, the
   test suite doesn't need any secrets, so this should be a
   non-issue — drafts should confirm.
8. **Test runner concurrency.** Should `run-tests.sh` support
   parallel test execution, or stick to serial for simplicity?
   Serial is fine for sprint 000; the test suite is tiny.
   Drafts should call this out but not add complexity.
