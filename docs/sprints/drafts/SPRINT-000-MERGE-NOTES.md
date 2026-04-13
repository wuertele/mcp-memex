# Sprint 000 Merge Notes

## Decisions From the Interview

1. **Base draft:** Codex base, merge Claude's rigor (Recommended, accepted)
2. **Canonicalization edge cases:** All boundaries, no NUL (document NUL as out of scope, cite PostgreSQL text column limitation)
3. **Local git remote:** Defer to Sprint 005
4. **Embedding algorithm spec:** Pinned exactly in the sprint document

## Claude Draft Strengths (to pull into the merge)

- **`tests/lib/wait-for.sh` helper** for defensive portability against older Docker Compose versions lacking `--wait`. Keep as a belt-and-suspenders fallback alongside the `exec -T pg_isready` and host-side `curl /health` probes.
- **Pre-flight port check** in `run-tests.sh` using `bash /dev/tcp` to confirm 55432 and 58000 are not already bound by another process. Fail fast with a clear error message.
- **`COMPOSE_PROJECT_NAME=memex-test`** (via `-p memex-test` or environment) to prevent collisions with concurrent local invocations or with unrelated stacks on the same Docker daemon.
- **Tight slow-embed timing bounds** (≥4500ms lower bound, <15000ms upper bound) rather than a single-sided assertion. Catches both "delay not implemented" and "delay hung indefinitely" failure modes.
- **Explicit `deno.json`** at the repository root (not `tests/deno.json`) so `deno test` picks it up without requiring `--config`. Fixes the inconsistency the Codex critique caught in Claude's own draft.
- **Unit-vector embedding output** (L2-normalized) matching real OpenAI `text-embedding-3-small` behavior more faithfully than un-normalized bytes.
- **Explicit named list of test vectors** in the canonicalization fixture enumeration (Claude's Phase 2 lists each one), rather than Codex's count-plus-rule-tags approach.
- **TCP socket connect to 127.0.0.1:55432** from the smoke test — proves the host port binding actually works, which `pg_isready` inside the container does not validate.

## Codex Draft Strengths (the base we're keeping)

- **Canonical JSON hashing for chat fixtures.** Sort object keys recursively, stable-stringify, SHA-256 the result, match by hash. Immune to key-order differences in request JSON. Superior to Claude's substring matching, which has ambiguous behavior when multiple fixtures' match strings appear in the same request.
- **`MEMEX_TEST_*` environment variable contract** exported by the runner. Sprint 001 can consume these without renegotiating.
- **Runner discipline.** `set -euo pipefail`, `trap` cleanup, `down -v --remove-orphans`, pre-run stale cleanup, `compose config` validation before startup, log dump on failure, no host `pg_isready` dependency.
- **Three-pronged determinism verification.** (a) golden fixture replay, (b) repeat-request equality, (c) different-input inequality. Catches algorithm drift, in-process nondeterminism, and degenerate constant functions independently.
- **Open questions addressed individually with rationale.** Every Q1–Q8 from the intent gets a specific answer, not hand-waved.
- **`tests/integration/.gitkeep`** as the only proactively reserved path.
- **Clean 10-scenario use case table** that maps to the Definition of Done line-for-line.
- **Missing-fixture error echoes the request hash**, making "add a new fixture" a mechanical copy-paste operation.
- **Scope discipline** — the plan stays within 2–3 days of work.

## Gemini Draft Strengths (minimal borrow)

- **Host-side TCP check on PostgreSQL port** in the smoke test. This is already covered by pulling in Claude's "TCP socket to 127.0.0.1:55432" test, but Gemini was the first to surface the idea that the in-container `pg_isready` alone is insufficient to prove the host port binding is actually working.
- **`docker info` precheck in the runner** to detect "Colima not started" before `docker compose` produces a confusing error. Small but valuable.

## Consensus Critiques (Multiple Reviewers Agreed)

1. **Neither Claude nor Codex includes the local bare git remote** from the Testing Strategy section of ROADMAP.md. **Resolution (operator decision):** defer to Sprint 005 explicitly. Document the decision in Sprint 000's "Out of Scope" section and note in ROADMAP.md that the git remote helper lives in Sprint 005, not Sprint 000.

2. **Embedding algorithm must be pinned exactly, not "recommended."** Cross-sprint verification (particularly future sprints that assert specific captured embeddings) depends on deterministic reproducibility across hosts and Deno versions. **Resolution (operator decision):** pin the algorithm with full byte-layout detail in the sprint document.

3. **Canonicalization boundary cases need operator decisions.** Empty string, single newline, whitespace-only content, NUL bytes. **Resolution (operator decision):** include boundary cases for empty string, single newline, whitespace-only; document NUL bytes as explicitly out of scope (PostgreSQL `text` columns cannot store them).

4. **CI workflow needs `timeout-minutes`** to prevent runaway jobs when `__slow_embed__` or a Compose pull stalls. **Resolution:** add `timeout-minutes: 10` to the CI job.

5. **`COMPOSE_PROJECT_NAME` should be set explicitly** to prevent collisions. **Resolution:** use `-p memex-test` in all runner invocations.

## Valid Critiques Accepted

- **Claude's `tests/deno.json` / runner invocation mismatch** is a real bug. **Resolution:** place `deno.json` at the repository root, not under `tests/`.
- **Claude's `docker compose up --wait` fallback logic** is written in a way that won't work on older Compose versions. **Resolution:** use `--wait` as the primary mechanism (all modern Compose supports it), with `tests/lib/wait-for.sh` as belt-and-suspenders for the edge case.
- **Claude's NUL-byte vector** can't round-trip through PostgreSQL `text`. **Resolution:** drop NUL byte from the fixture; document as out of scope.
- **Claude's fixture schema change** (`{name, rule, input, expected}` vs `{input, expected}`) deviated from the ROADMAP without justification. **Resolution:** keep Claude's enriched schema because it enables rule-coverage assertions in the smoke test, but document the schema change explicitly in the sprint document.
- **Codex's embedding algorithm is "recommended"** not specified. **Resolution:** promote to required and pin exactly.
- **Codex's missing boundary cases** (single newline, whitespace-only). **Resolution:** add explicit vectors.
- **Codex's slow-embed one-sided timing.** **Resolution:** require ≥4500ms AND <15000ms.

## Critiques Rejected (with Reasoning)

- **Claude's recommendation that `run-tests.sh` support `--no-teardown` for debugging.** Deferred. Sprint 000's goal is a working platform, not a feature-rich runner. Operators who want to keep containers up can invoke `docker compose ... up -d` directly. Adding flags to the runner now creates scope creep.
- **Claude's recommendation to include "offline image builds guaranteed after first deno cache".** Nice ergonomics but not foundational for sprint 000. Deferred.
- **Claude's Phase 4 (separate Dockerfile phase).** Merged into Phase 3 for simplicity. The Dockerfile is ~10 lines; it doesn't need its own phase.
- **Codex's use of `docker compose exec -T postgres pg_isready` alone.** Kept, but augmented with a host-side TCP check in the smoke test because internal `pg_isready` doesn't prove the host port binding works.
- **Gemini's Deno 1.42 minimum version pin.** Rejected — use current stable Deno (2.x) which has `Deno.serve` and modern stdlib.

## Interview Refinements Applied

1. **Base = Codex with Claude's rigor merged in.** See structure below.
2. **Canonicalization boundaries + NUL out of scope.** Vectors include empty string → `"\n"`, single newline → `"\n"`, whitespace-only content; document NUL as out of scope with a comment pointing at PostgreSQL text limits.
3. **Git remote deferred to Sprint 005.** Out-of-scope section explicitly names this. ROADMAP update is a separate small task, not part of Sprint 000 execution.
4. **Algorithm pinned exactly.** Sprint 000 section 3.4 contains the full byte-layout specification: SHA-256 seed from UTF-8 input, big-endian u32 counter, 192 blocks of 32 bytes, big-endian u32 extraction per float, mapping to [-1, 1], L2 normalization.

## Final Decisions

- **Structure follows Codex's 10-section layout** (Overview → Open Questions).
- **Implementation Plan uses 8 phases** matching Codex's ordering with Claude's specific per-phase enumerations merged in where they add value.
- **Canonicalization fixture schema is `{name, rule, input, expected}`** (Claude's enrichment), with an explicit note that sprint 001's SQL tests and later sprints' TS/Python tests consume only `input` and `expected`.
- **`deno.json` lives at the repository root**, not under `tests/`.
- **Embedding algorithm is L2-normalized**, matching real OpenAI `text-embedding-3-small` behavior.
- **Runner uses `COMPOSE_PROJECT_NAME=memex-test`** via `-p memex-test`.
- **Pre-flight port availability check** via `bash /dev/tcp` in the runner.
- **Pre-flight `docker info` check** to catch "Colima not started" early.
- **`wait-for.sh` helper** exists for defensive portability.
- **CI has `timeout-minutes: 10`** and a `permissions: contents: read` block.
- **Slow-embed timing assertion is `≥4500ms AND <15000ms`.**
- **Golden embedding fixtures are generated from the committed algorithm**, not hand-authored. This is documented in the phase ordering: Phase 3 (algorithm) → Phase 4 (generate goldens).
- **Chat fixture lookup uses canonical JSON hashing.** Fixture file stores `request` as a JSON object; the service hashes and indexes at startup.
- **Sprint 000 does NOT create `migrations/`, `mcp-server/`, or `sync-daemon/`.** Those belong to their respective sprints.
