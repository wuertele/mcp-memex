# Sprint 000 Plan Critique (Claude)

Two drafts under review: `SPRINT-000-CODEX-DRAFT.md` and
`SPRINT-000-GEMINI-DRAFT.md`. Verdict up front: **Codex is the
stronger base.** Gemini is a reasonable skeleton but skips the hard
parts (determinism verification strategy, fixture corpus enumeration,
canonicalization rule mapping, runner cleanup discipline, fork-safe
CI, open-question disposition). Most of Gemini's good ideas are also
present in Codex. The merged final sprint should start from Codex and
borrow only a couple of Gemini items.

---

## Codex Draft

### Strengths worth keeping

- **End-to-end coverage of the intent.** Every in-scope deliverable
  from ROADMAP Sprint 000 is named, with a path, a phase, and a DoD
  checkbox. Nothing important is missing.
- **The mock service contract is fully specified.** Request shape,
  response shape, error shape, support for `input: string | string[]`,
  hash-based determinism algorithm (SHA-256 expanded to 1536 floats
  with fixed rounding), explicit "no `Math.random`" instruction. This
  is exactly the level of detail the executor needs.
- **Chat-completions fixture lookup by canonical-JSON hash** is a
  genuinely good design call. It means fixture matching is
  whitespace-insensitive and key-order-insensitive, and the
  missing-fixture 400 echoes the hash so adding a new fixture is a
  copy-paste operation. Worth keeping verbatim.
- **Determinism is verified three ways**, not one: replay golden
  fixtures (catches algorithm drift across runs/hosts), repeat a
  non-fixture request and deep-equal (catches in-process
  nondeterminism), and a different request must differ (catches the
  degenerate "always returns the same vector" bug). Gemini only does
  the second one.
- **Runner discipline.** `set -euo pipefail`, `trap` teardown with
  `down -v --remove-orphans`, pre-run cleanup of leftover state,
  `compose config` validation before `up`, log dump on failure, no
  host `pg_isready` requirement (uses `exec -T pg_isready` inside the
  container). This is the right shape.
- **Env-var contract** (`MEMEX_TEST_DB_*`, `MEMEX_TEST_INFERENCE_BASE`)
  is a small but valuable forward-compatibility move — sprint 001 can
  consume it without renegotiating.
- **Open questions are addressed individually with rationale**, not
  ignored. Each Q1–Q8 from the intent gets an explicit answer in §5.1
  and §10. This is what the intent asked for.
- **`tests/integration/.gitkeep`** as the only proactively reserved
  path is the right call: sprint 001 lands migration tests there
  immediately, so the path should already exist.
- **Section 6.4 rule mapping is concrete.** ~24-case minimum with an
  enumerated checklist that includes the easy-to-miss cases (lone
  `\r`, NFD→NFC with the Café example, BMP-overflow, leading newlines
  preserved, mixed BOM+CRLF+NFD).

### Weaknesses and gaps

- **Canonicalization checklist has two cases that are not strictly
  required by Section 6.4 and one item that's slightly misaligned.**
  - "trailing spaces preserved" and "markdown double-space line
    breaks preserved" are correct per the rule table — keep.
  - "leading newlines preserved" is correct per the rule table —
    keep.
  - The plan does not call out **the empty string → `"\n"`** case
    *and* the **single `"\n"` → `"\n"`** case as distinct, but both
    are interesting boundary conditions for the SQL regex
    `regexp_replace(content, E'\n+$', '') || E'\n'`. The empty-string
    case is listed; the single-newline case isn't. Add it.
  - Missing: **a case where the input has *only* whitespace** (e.g.
    `"   \n   "`). The SQL trigger would canonicalize to
    `"   \n   \n"`. Worth pinning so cross-implementation drift is
    caught.
  - Missing: **NUL byte handling**. Section 6.4 doesn't mention it,
    but PostgreSQL `text` columns reject NUL, so the test vectors
    should either include a NUL case marked as expected-failure or
    explicitly document that NUL is out of scope. Either is fine; the
    plan is silent.
- **The hash-expansion algorithm is *recommended*, not mandated.** The
  draft says "Recommended algorithm: ...SHA-256 blocks from
  `input + ":" + block_index`...". Because sprints 003 and later may
  need to *predict* what the mock will return for a given input
  (e.g., to assert that a captured embedding round-trips correctly),
  the algorithm needs to be **specified exactly and pinned**, not
  recommended. Otherwise the executor picks one and a future sprint
  has to reverse-engineer it. Promote to MUST and pin the exact byte
  layout (UTF-8 of input, separator byte, big-endian u32 block index,
  rounding rule, mapping `byte → (byte/127.5) - 1` or whatever is
  chosen) in the plan itself.
- **`__slow_embed__` timing assertion is fragile.** "at least ~5000
  ms" is fine in principle, but on a cold Colima VM the *first* HTTP
  request to the mock can take 200–500 ms of TLS/handshake/JIT warmup
  on top. Recommend asserting `>= 4500 ms` (allow a small undershoot,
  since a 5s `setTimeout` in Deno can fire at ~4.99s under load) and
  `< 15000 ms` (catch a hung response). The plan only says "at
  least".
- **No assertion that the slow path doesn't block other requests.**
  Sprint-000 doesn't strictly need this, but a one-line concurrent
  test (`Promise.all([slow, fast])` and assert the fast one returns
  in <1s) would catch a single-threaded mock that breaks parallel
  embedding tests in later sprints. Optional.
- **CI workflow timeout is not specified.** A hung `__slow_embed__`
  or a Compose pull stall could burn 6 hours of free runner time.
  Add `timeout-minutes: 10` to the job.
- **`docker compose up -d --build` in CI has no layer caching.** The
  Deno mock image will rebuild from scratch on every CI run. For
  sprint 000 it doesn't matter (image is tiny, ~10s build), but worth
  a note that Buildx caching is deferred until it actually hurts.
- **Phase 6 has the smoke test asserting on `tests/mock-inference/
  fixtures/embeddings.json` golden payloads.** That's good for
  catching algorithm drift, but it means the executor has to *first*
  pick the algorithm, *then* generate the goldens, *then* check them
  in. The plan doesn't sequence this — Phase 4 (fixtures) comes
  before Phase 6 (smoke test), but the goldens can only be authored
  *after* the algorithm in Phase 3 is committed. Not a blocker,
  worth a one-line note: "generate golden vectors by running the
  Phase 3 service against the inputs and committing the output".
- **No mention of `colima` resource sizing.** Default Colima is 2
  CPU / 2 GB RAM, which is fine for `pgvector:pg16` + a Deno
  container, but it's worth one line in `tests/README.md` documenting
  the minimum (Postgres 16 alone wants ~256 MB shared_buffers
  defaults; pgvector adds a little).
- **§3.3 says "no parallel test execution or dynamic project naming
  complexity yet"** — but doesn't set a `COMPOSE_PROJECT_NAME`
  *anywhere*. Without one, two concurrent local invocations (e.g.,
  the operator forgot one is running and starts another) collide on
  container names with confusing errors. Setting
  `COMPOSE_PROJECT_NAME=memex-test` explicitly costs nothing and
  makes the failure mode visible (port collision rather than
  silent reuse).
- **The chat-fixture canonical-JSON hashing is asymmetric.** The mock
  computes SHA-256 of canonicalized request to look up the fixture,
  but `chat.json` stores `request` as a JS object — so at startup
  the mock must canonicalize-and-hash *every* fixture entry to build
  the lookup table. That's fine, but the plan doesn't say so
  explicitly, and an executor reading Phase 3 might naively hash the
  raw fixture JSON string from disk and get a different hash than
  the one computed from the incoming request. One sentence in §3.4
  fixes this: "At startup, canonicalize and hash each fixture's
  `request` field using the same function used for incoming
  requests, and build an in-memory map."

### Concrete recommendations

1. Promote the embedding algorithm from "recommended" to "specified"
   and pin the exact byte layout.
2. Add empty-string vs single-newline vs whitespace-only test
   vectors; add an explicit decision on NUL bytes.
3. Add `COMPOSE_PROJECT_NAME=memex-test` to the runner.
4. Add `timeout-minutes: 10` to the CI job.
5. Tighten the `__slow_embed__` assertion bounds (4500ms ≤ t < 15000ms).
6. Add one sentence on the chat-fixture lookup-table build at startup.
7. Note that golden embedding fixtures must be generated from the
   committed algorithm, not hand-authored.

---

## Gemini Draft

### Strengths worth keeping

- **`tests/unit/smoke.test.ts` Test 1: "Verify database connection"**
  is a useful sanity check Codex doesn't include. Codex tests
  Postgres readiness in the runner script (`pg_isready` inside the
  container) but never actually opens a TCP connection from the test
  process to `127.0.0.1:55432`. Gemini's draft pulls a Deno Postgres
  driver into the smoke test and proves the *host port binding*
  works. That's worth borrowing — if the Compose port mapping is
  wrong, the in-container `pg_isready` would still pass while every
  later sprint would fail. One-line addition to the merged smoke
  test: `await new Client(...).connect(); await client.queryArray("SELECT 1")`.
- **The "Colima state" gotcha** ("the runner should verify
  `docker info` before starting") is concrete and useful. Codex says
  "fail fast if `docker` is missing" but doesn't check that the
  daemon is *reachable*. `docker info` is the right probe. Borrow.
- **Format is compact.** For a contributor skimming, Gemini's plan
  is faster to read. (This is faint praise — it's compact because
  it omits things.)

### Weaknesses and gaps

- **Mock service contract is a stub.** §3.2 says embeddings are
  "Deterministic vectors derived from a hash of the input text" and
  stops there. No algorithm. No `1536` constant in the contract
  section (only mentioned in passing in Use Cases). No specification
  of `input: string[]` support. No error-response shape. No
  chat-fixture lookup mechanism. An executor could implement
  something that "works" but produces vectors that change between
  Deno versions, or that match by raw-string equality on chat
  requests and break the moment a key gets reordered.
- **Canonicalization fixtures are sketched, not enumerated.** §2.2
  lists six bullet categories ("BOM stripping, CRLF to LF, ...") and
  walks away. No minimum case count. No mention of NFD→NFC with a
  worked example. No "leading newlines preserved", no "internal
  whitespace preserved", no trailing-double-space markdown line break,
  no mixed-rule case. This is the deliverable that *most* matters
  for cross-sprint consistency, and it's the deliverable Gemini
  spends the least ink on.
- **Determinism verification is one assertEquals call.** §5(a) says
  "Call `/embeddings` twice, `assertEquals`". That catches the
  in-process case and nothing else. It doesn't catch the
  always-returns-same-vector bug, doesn't catch length drift,
  doesn't catch cross-host divergence, doesn't catch a missing
  fixture replay.
- **Open questions are mostly ignored.** Q4 (Compose `version:`),
  Q5/Q6 (port collisions), Q7 (forked PRs), Q8 (parallel runner) get
  no answer. Q1, Q2, Q3 get one-line answers. Q3 in particular says
  "v1.42+" — Deno 1.42 is from April 2024 and `std/http` has since
  been deprecated in favor of `Deno.serve`. Pinning a 2-year-old
  minimum is the wrong direction; the executor should target current
  stable Deno (2.x) and use `Deno.serve`.
- **Runner script discipline is hand-waved.** §4 Phase 5 says
  "handles cleanup on `SIGINT`/`SIGTERM`" but doesn't say
  `set -euo pipefail`, doesn't mention `down -v`, doesn't mention
  `--remove-orphans`, doesn't mention pre-run cleanup, doesn't
  mention log dump on failure. Codex covers all of these.
- **Manual verification step 1 uses `pg_isready -h localhost -p 55432`
  on the host.** This requires a host PostgreSQL client install, which
  the intent's constraints explicitly say must not be required. The
  prerequisites in §4 Task 1.2 also list `psql` — same problem.
  Contributors shouldn't need a host Postgres client; the runner
  doesn't and shouldn't.
- **`tests/README.md` is the very first deliverable** (Phase 1, Task
  1.2). That's backwards — you can't write accurate contributor docs
  before the script and Compose file exist. README writing belongs
  at the end, after the actual artifacts are stable. Not a blocker,
  but an iteration order that will produce stale docs on the first
  pass.
- **CI section is two sentences.** No mention of triggering on `push`
  *and* `pull_request` (the intent calls this out), no mention of
  fork-safety, no mention of permissions hardening, no mention of
  Deno install via action vs. script. The Open Question about CI
  topology gets a paragraph but the actual workflow plan is one
  bullet.
- **Risks table is generic.** "CI Latency", "Docker availability",
  "Port Collision", "Mock Divergence" — these are the risks that
  apply to every Compose-based test setup ever written. Missing the
  *project-specific* risks: determinism algorithm drift across hosts,
  cross-implementation canonicalization drift between SQL/TS/Python,
  flaky teardown leaving volumes behind, forked-PR CI failure modes,
  Deno version skew between mock service and smoke test.
- **§4 Phase 4 Task 4.2 mentions a "healthy check"** for the db
  service but doesn't specify it. Compose `healthcheck:` for
  `pgvector` needs `pg_isready -U memex_test -d memex_test` (the
  default user check fails because the user is `memex_test`, not
  `postgres`). Easy to get wrong.
- **Definition of Done item "GitHub Actions workflow is green on
  push"** — fine, but DoD should also cover *pull_request* runs
  (intent §1 use case "CI on push and PR") and the fork-safe-by-design
  constraint.
- **Compose service is named `db` in §4.2 and `postgres` is implied
  elsewhere.** Consistency matters because `docker compose exec db
  pg_isready` vs `docker compose exec postgres pg_isready` is a
  copy-paste bug waiting to happen for sprint 001.

### Concrete recommendations

1. Don't use Gemini as the base. Borrow only:
   - The host-side DB connection check in the smoke test.
   - The `docker info` precheck in the runner.
2. Drop everything that conflicts with the intent constraints
   (host `psql`/`pg_isready` requirement, ancient Deno pin, single
   determinism assertion).

---

## Cross-cutting notes (apply to the merged plan)

### Determinism verification approach

Codex's three-pronged approach (golden replay + repeat-equality +
different-input-inequality) is correct. Add one more cheap check:
**assert the same input produces the same vector across host
architectures** by checking in a golden vector for one specific input
and verifying it byte-for-byte in CI (which runs on x86_64
ubuntu-latest) and locally (likely arm64 macOS via Colima). This is
already implicit in "replay every request in `embeddings.json`" *if*
those goldens are generated once and committed — but the plan should
state this explicitly so the executor doesn't regenerate goldens
locally and silently mask an arch-dependent algorithm bug.

### Canonicalization test vector coverage vs Section 6.4

The authoritative rule table has 9 rows. Codex's enumerated 24-case
list covers all 9 rules with multiple cases each. Gemini covers ~5 of
9 explicitly. The merged plan should include a small **rule→case
matrix** in the canonicalization fixture file's header comment (or as
a top-level `metadata` field), so a reader can verify coverage at a
glance. Cases should include at minimum:

- Each rule alone (9 cases).
- Empty string, single `\n`, whitespace-only, content-with-no-final-
  newline (boundary conditions for the trailing-newline rule, which
  has the most subtle SQL regex).
- One case per rule combined with NFC normalization (because NFC
  interacts non-trivially with byte-counting BOM and CRLF logic).
- One "all rules at once" mega-case.
- One BMP-overflow case (Unicode beyond U+FFFF) to catch UTF-16
  surrogate handling bugs in any future implementation.
- Explicit decision on NUL bytes (in or out).

That lands somewhere in the 22–28 range, which matches Codex's
"minimum 24" — so Codex is in the right ballpark, just specify the
mapping.

### CI: native service containers vs docker compose

Codex's answer (single source of truth: same `compose.yaml` in CI and
local) is correct for sprint 000. The argument for native service
containers is faster startup and simpler YAML, but:

1. The mock service is custom and *must* be built in-job, so Compose
   is needed regardless.
2. Sprint 000's job is to prove the test platform works, not to
   minimize CI seconds.
3. Two paths to maintain is a real, recurring tax on every later
   sprint.

Stick with Compose-in-CI. Revisit only if CI runtime exceeds ~5
minutes per run, which sprint 000 won't approach.

### Colima-specific considerations

Neither draft fully addresses Colima specifics:

- **arm64 vs x86_64 image selection.** `pgvector/pgvector:pg16`
  publishes multi-arch manifests, so this *should* just work, but
  the `tests/README.md` should call out that arm64 images are pulled
  on Apple Silicon. The Deno base image used in
  `tests/mock-inference/Dockerfile` must also be multi-arch — check
  before pinning.
- **Default Colima resources** (2 CPU, 2 GB) are sufficient but the
  README should say so explicitly so a contributor with `colima start
  --cpu 1 --memory 1` doesn't get confusing OOMs.
- **Colima socket location.** On Colima, `DOCKER_HOST` is typically
  `unix:///Users/$USER/.colima/default/docker.sock`. The runner
  should not hardcode anything — `docker info` will use whatever the
  user has configured — but the README should mention the symptom
  ("docker: command not found / cannot connect to daemon") and the
  fix (`colima start`).
- **File sharing.** Colima auto-mounts `$HOME` by default, so
  bind-mounting `tests/mock-inference/` into the container build
  context works without configuration. Worth a one-line confirmation
  in the README so nobody adds `--mount` flags.

Codex has none of this; Gemini has one bullet. Add ~5 lines to the
merged README.

### Smoke test sensibility

Both drafts agree on Deno for the smoke test. That's the right call:
the mock service is already Deno, the smoke test needs only `fetch`
and JSON assertions, and Deno's bundled test runner means no
package.json. The "smoke test as shell script" alternative from the
intent's Open Question 1 should be rejected — once you want to assert
embedding length, deep-equal a JSON response, and measure elapsed
time on the slow path, shell becomes painful fast.

The smoke test's job in sprint 000 is not to test memex (there is no
memex yet). It's to test the *test platform*. So it should:

1. Hit `/health` (proves mock service is up, ports bind correctly).
2. Open a real DB connection from the host to `127.0.0.1:55432` and
   `SELECT 1` (proves Postgres port binding works — Gemini's idea,
   borrow it).
3. Replay golden embedding fixtures (proves algorithm is stable).
4. Send the same non-fixture request twice (proves runtime
   determinism).
5. Send a different request (proves it's not a constant function).
6. Assert `__fail_embed__` → 500 and `__slow_embed__` → ≥4.5s.
7. Replay golden chat fixtures and assert one missing-fixture 400.
8. Parse `canonicalization-cases.json`, validate shape, assert
   minimum count and rule-coverage sentinels.

Codex covers 1, 3, 4, 5, 6, 7, 8. Gemini covers 1, 4 (weakly), 8
(weakly), and *adds* 2. The merged plan should be Codex's list plus
Gemini's #2.

---

## Bottom line

**Use Codex as the base. Merge in from Gemini:** (a) a host-side
DB-connection check in the smoke test, (b) a `docker info` precheck
in the runner. **Apply the Codex-specific recommendations above:**
pin the embedding algorithm exactly, add the missing canonicalization
boundary cases, add `COMPOSE_PROJECT_NAME`, add a CI
`timeout-minutes`, tighten the slow-path timing bounds, and
explicitly sequence golden-fixture generation after algorithm
commit.

Codex is feasible in 2–3 days as written; Gemini is feasible in 2–3
days but would ship with under-specified determinism, undercoverage
of canonicalization rules, and a runner that doesn't survive its
first interrupted run. The cost of starting from Gemini and adding
the missing pieces is higher than the cost of starting from Codex
and tightening the few rough edges.
