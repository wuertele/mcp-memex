# Sprint 001 Critique (Claude)

Critiquing the CODEX and GEMINI drafts against the intent at
`docs/sprints/drafts/SPRINT-001-INTENT.md`. I did not read the Claude
draft.

---

## Part A: CODEX Draft

### A.1 Architectural Soundness

Solid. The draft respects the intent's core constraints:

- Additive-only, forward-only (Section 3.1, 3.5) matches architecture
  Section 5.4.
- The runner is kept out of Compose as a one-shot script (Section 3.3),
  which matches the intent's preference and preserves Sprint 000's
  topology.
- Per-transaction migration apply with `ON_ERROR_STOP` and post-apply
  `schema_migrations` insertion (Section 3.2 bullet 6) is the right
  atomicity shape.
- The `PSQL` command override (Section 3.2) is a genuinely good idea:
  it preserves Sprint 000's "no host psql required" guarantee without
  adding a new Compose service. This is the draft's most useful
  architectural contribution beyond the intent.
- Per-scenario fresh databases on the shared server (Section 3.3) is
  the right isolation choice and the draft explicitly acknowledges why
  the suite must run serially (server-scoped roles).

One architectural concern: Section 3.2 bullet 6 says "Apply each
pending migration in its own transaction," but Section 3.1 also calls
out that `0009_add_roles.sql` uses `DO` blocks around `CREATE ROLE`.
The draft never explicitly discusses whether `CREATE ROLE` inside a
`DO` block in a transaction is safe on the Compose pgvector image
(it is, but Gemini's draft flags this as a concern worth naming). A
sentence confirming that `CREATE ROLE` in a `DO` block commits
cleanly inside the same transaction as the rest of 0009 would remove
ambiguity. Minor gap, not a blocker.

### A.2 Completeness vs Intent Scope

Covers all eight ROADMAP validation bullets and all intent success
criteria 1–7. Every item in the intent's "In scope" list has a
corresponding phase/task and a Verification Plan row:

- Nine SQL files: Phase 1, Files Summary, DoD line 1.
- Runner with checksums: Phase 2, Verification row 1 and 3.
- Integration tests in `tests/integration/`: Phase 4/5 and row 1–11.
- Canonicalization 22/22 on both INSERT and UPDATE: rows 5 and 6, DoD
  lines 11 and 12. Explicit byte-for-byte assertion against stored
  value (Section 3.4 last paragraph) is exactly what the intent asks
  for.
- Role boundary: Phase 5 task 7, row 11, DoD lines 17 and 18.
- `sync_log` daemon suppression: Phase 5 tasks 5 and 6, rows 9 and 10.
- `content_fingerprint` generated column: row 7 and DoD line 13.
- Staged-vs-full equivalence: row 4 and Phase 4 task 4.

Nothing from the intent is missing.

### A.3 Phasing / Ordering

Five phases in a sensible order: SQL → Runner → Harness wiring →
Migration/runner tests → Behavioral schema tests. Each phase is
independently reviewable, which matches the Sprint 000 planning style.
The split between Phase 4 (runner mechanics) and Phase 5 (schema
behavior) is a good separation — it lets a reviewer land and validate
the runner before the larger canonicalization/role/CDC test body
lands.

Small concern: Phase 3 modifies `tests/run-tests.sh` and `deno.json`
before the integration tests exist. That is fine if Phase 3 only adds
*invocation plumbing* that no-ops when `tests/integration/` is empty,
but the draft should make that explicit or accept that Phase 3 and
Phase 4 land together. As written it's a minor ordering nit.

### A.4 Risk Coverage

Eight risks, all load-bearing:

- R2 (hidden host `psql` dependency) is something a Bash runner can
  easily regress into; calling it out is valuable.
- R3 (server-scoped role interference) matches the same constraint
  that forces serial test execution — consistent reasoning.
- R4 (CRLF checksum drift) is a real Bash-runner footgun on mixed
  platforms. Good catch.
- R5 (noisy `pg_dump` comparison) is the right mitigation for the
  staged-vs-full check; the draft both names the risk and prescribes
  the `--no-owner --no-privileges` normalization.
- R8 (placeholder passwords mistaken for deployable creds) is a
  future-you risk that's worth documenting.

Missing risks I would add:
- No explicit risk for the `normalize(NFC)` semantic mismatch between
  PostgreSQL's built-in Unicode normalization and Deno's
  `String.prototype.normalize`. Gemini catches this (their risk 1);
  Codex does not. The Section 3.4 byte-for-byte assertion *would*
  catch it, but the risk register should name it so a failure's root
  cause is obvious.
- No risk covering "operator deletes `schema_migrations` row by hand"
  or "two runner invocations race on the same database." Both are
  low probability but worth a sentence each.

### A.5 Feasibility

Feasible. The Bash runner contract in Section 3.2 is small enough to
land in a few hundred lines with `set -euo pipefail`, a `find | sort`
sweep, `sha256sum`, and piped `psql` invocations. The per-scenario
database helper in Deno is straightforward. Nothing in the plan
requires libraries or tooling beyond what Sprint 000 already ships.

One concrete feasibility wrinkle the draft glosses over: comparing
`pg_dump` output between a staged-apply and full-apply database will
*also* require running `pg_dump` through `docker compose exec`
(because of the no-host-psql constraint), and `pg_dump` output
includes a version banner and `SET` statements that vary. The draft
says "strip database-specific noise before diffing" in R5 but doesn't
enumerate what to strip. Worth making this concrete before
implementation.

### A.6 Verification Plan Quality

Strong. Thirteen automated checks, every one tied to a file and an
executor note. The plan is specific and actionable:

- Row 3 (checksum drift) explicitly prescribes the temp-copy approach
  so the real `migrations/` directory is never mutated by tests. This
  is the right shape.
- Row 4 prescribes `pg_dump --schema-only --no-owner --no-privileges`
  as the equivalence oracle rather than hand-rolled catalog queries.
- Row 12 (Sprint 000 smoke regression) directly addresses the
  intent's "regression risk against Sprint 000" concern.
- Row 13 (one-button orchestration) is the end-to-end gate.

The manual verification section (10 numbered steps) is unusually
detailed and includes expected output for each step. This is exactly
the kind of "you can copy-paste this into a terminal and see if the
sprint is done" verification the Sprint 000 template values.

Gaps in the verification plan:

1. No check for the intent's "runner must record checksums" at the
   row-shape level. Rows 1 and 3 test the behavior, but nothing
   asserts that `schema_migrations` actually has the expected
   columns (`version`, `checksum`, applied-at). Add a schema-level
   assertion.
2. No explicit check that a *failing* migration does not leave a
   row in `schema_migrations` (intent's DoD implies this; Codex's
   own DoD line 8 states it). Row 3 tests checksum-drift failure,
   but no row tests apply-time SQL failure. A synthetic "bad
   migration" test (e.g. via the migrations-directory override) would
   close that gap cleanly and exercise the exact failure-recovery
   narrative Section 3.5 describes.
3. Manual step 8 assumes `memex_mcp` and `memex_sync` can connect
   from inside the container using `-h 127.0.0.1`. That will work
   only if `pg_hba.conf` allows password auth for those roles on
   that host. The draft never addresses `pg_hba.conf` or whether
   the Compose image's default config permits role-password logins.
   This is a real feasibility gap hiding inside a verification step.

### A.7 Definition of Done

Twenty checklist items. Covers every validation bullet from the
ROADMAP seed plus the Sprint 000 regression gate (DoD 19, 20). The
DoD is tightly scoped to observable outcomes, not implementation
details, which is the right shape.

One item I would add: "The failing-migration case does not record
a `schema_migrations` row and the runner exits non-zero." The draft
states this in Section 3.5 prose and DoD line 8 hints at it, but it
lacks a corresponding automated check (see A.6 gap 2).

### A.8 Open Questions Answers

All eight open questions answered in Section 10 with justification.

- Q1 Bash: justified by "small control script, no packaging overhead,
  repo has no Python toolchain." Reasonable.
- Q2 Deno: consistent with the Bash choice because Deno drives
  subprocesses anyway.
- Q3 SHA-256: correctly dismissed as sufficient.
- Q4 `MEMEX_TEST_DB_*` mapped into `PG*`: preserves Sprint 000
  contract. Good.
- Q5 `DO` blocks on `pg_roles`: matches the intent's "explain
  idempotency for CREATE ROLE" requirement and addresses 42710.
- Q6 Fresh DB per scenario, shared server, serial execution:
  justified by the global-role constraint.
- Q7 Separate `run-tests.sh` step, not a Compose service: justified.
- Q8 Forward-only with rerun-from-last-success: matches the
  architecture.

All answers are well-justified. No hand-waving.

### A.9 Summary for CODEX Draft

**(a) Strongest ideas worth keeping:**
- The `PSQL` command override so the runner works through
  `docker compose exec` without requiring host `psql`.
- Per-scenario fresh databases on the shared PostgreSQL server,
  with explicit serial execution because roles are server-scoped.
- `pg_dump --schema-only --no-owner --no-privileges` as the
  staged-vs-full equivalence oracle.
- Byte-for-byte canonicalization assertions against stored values
  rather than reconstructing expected output in TypeScript.
- Twenty-item Definition of Done with explicit Sprint 000
  regression gates.
- Temp-copy-of-`migrations/` approach for the checksum-drift test
  so the real tree is never mutated during tests.

**(b) Weaknesses or gaps:**
- No verification for apply-time migration failure (only
  checksum-drift failure is exercised). Section 3.5's failure
  narrative has no corresponding automated check.
- Risk register does not name the SQL-vs-Deno Unicode
  normalization mismatch explicitly.
- `pg_hba.conf` / password-auth requirements for `memex_mcp` and
  `memex_sync` connections are never discussed; manual step 8 may
  fail on a stock Compose image.
- Phase 3 touches `run-tests.sh` before the integration suite
  exists; minor ordering ambiguity.
- The draft does not explicitly confirm that `CREATE ROLE` inside
  a `DO` block runs cleanly under the per-migration transaction
  contract from Section 3.2 bullet 6.

**(c) Open Questions resolution:** all eight answered with concrete
justifications that match the intent's constraints.

---

## Part B: GEMINI Draft

### B.1 Architectural Soundness

Mixed. The draft covers the right surface but has two concrete
architectural tensions:

- **Runner choice conflicts with integration test choice.** Section
  3.1 picks Python 3 with `psycopg2`/`psycopg`, then Section 3.3
  picks Deno for the integration suite. The intent's open-question
  Q2 explicitly flags this tension ("Python would better match a
  Python runner") and asks drafters to argue how the two choices
  interact. Section 10 answer 1 says "Python is better for
  checksum tracking and structured error handling" and answer 2 says
  "Deno keeps toolchain sprawl low," but the draft never addresses
  that picking *both* languages is the worst of both worlds: it
  adds a Python runtime dependency (DoD and Dependencies mention
  `psycopg2` or `psycopg`) *and* keeps Deno. That is strictly more
  toolchain sprawl than either all-Bash+Deno or all-Python. The
  draft's own justifications contradict each other.

- **Section 3.1 "Atomicity" bullet:** "Wraps each individual migration
  file in a transaction. (Note: `CREATE ROLE` and some index
  operations may require `autocommit` mode; the runner handles these
  as exceptions)." This is an architectural red flag. `CREATE ROLE`
  *is* safe inside a transaction in PostgreSQL; the real footgun is
  `CREATE INDEX CONCURRENTLY`, which none of the Section 6
  migrations need. The draft is inventing a complication that
  doesn't exist and then promising the runner "handles these as
  exceptions" without specifying the mechanism. This is vague and
  opens a door to an autocommit path that would undermine the
  per-migration atomicity guarantee.

- **Section 3.3 "Fresh State" bullet:** "Each test run against the
  migration runner starts by dropping and recreating the `public`
  schema to ensure a clean slate." Dropping `public` does not reset
  server-scoped roles created by 0009. So the first test run creates
  `memex_mcp` and `memex_sync`, the second test run's `DROP SCHEMA
  public` leaves them in place, and subsequent runs of 0009 must
  rely on the `DO`-block idempotency to not fail. The draft mentions
  the `DO` block in Phase 1 task 2, so the behavior will work, but
  the "drop and recreate `public`" approach is weaker isolation than
  Codex's "fresh database per scenario" approach because it can't
  isolate role-related side effects across tests. This also means
  staged-vs-full schema equivalence (a ROADMAP validation bullet) is
  harder to test cleanly — you'd need two databases anyway. The
  Gemini architecture doesn't really solve the isolation problem
  the intent raises in Q6.

Otherwise the draft respects additive-only (Section 3.2), forward-
only, the fixture-corpus requirement, and the role boundary.

### B.2 Completeness vs Intent Scope

Partial coverage with specific gaps:

- **Staged-vs-full equivalence check is missing.** The ROADMAP
  validation explicitly requires "Applying 0001–0005 then 0006–0009
  produces the same schema as applying all nine at once." This does
  not appear in the Use Cases table (Section 2), the Implementation
  Plan (Phase 1–7), the Automated Checks table (Section 5.1), or
  the Definition of Done (Section 7). This is a first-order scope
  miss against the intent.

- **Checksum drift test exists** (Phase 3 test 3, Automated Check
  row 3) but uses the words "Manually modify a migration file" —
  that is not actually an automated test unless the integration
  code copies `migrations/` somewhere writable first. The draft
  does not say "operate on a temp copy," so as written a naive
  implementation would mutate the real `migrations/` tree.

- **`content_fingerprint` generated column** is covered in Phase 4
  task 2 and Use Case 6, but not called out in the DoD checklist
  (Section 7). The DoD is thinner than the plan.

- **`updated_at` trigger** is covered weakly in Phase 4 task 3
  ("Verify `updated_at` changes on UPDATE but not on INSERT (unless
  specified)"). The "unless specified" hedge is vague and there is
  no corresponding verification-plan row or DoD item.

- **Failure recovery story** (intent Q8) is answered in Section 10
  answer 8 with a single sentence ("Partially applied.
  `schema_migrations` tracks progress. Operator must fix and
  re-run."). There is no architectural narrative, no test, and no
  DoD item covering this. Codex has an entire Section 3.5 plus
  manual steps; Gemini has one sentence.

- **Manual verification** (Section 5.2) is three steps. Codex has
  ten. For a sprint whose whole job is "make the schema executable
  and prove it works," Gemini's manual path is too thin to actually
  validate the outcomes an operator would care about.

### B.3 Phasing / Ordering

Seven phases vs Codex's five. The split between Phase 3 (schema &
idempotency), Phase 4 (canonicalization & triggers), Phase 5 (roles),
and Phase 6 (sync log) is overly granular — all four phases modify
the same file (`tests/integration/schema.test.ts`) and are really
one logical chunk split four ways. Each split adds review overhead
without reducing risk.

Also, Phase 7 ("Runner Extension") modifies `tests/run-tests.sh`
*last*, after all tests are written. But the tests can't run
without the harness invoking the runner first, so Phases 3–6 are
actually unrunnable until Phase 7 lands. This is a real ordering
bug: it should either come before Phase 3 or be merged with it.

### B.4 Risk Coverage

Only three risks:

- R1 NFC mismatch between SQL and Deno/Python. **This is a real
  risk Codex missed.** Worth keeping.
- R2 `memex_test` might not have `CREATEROLE`. Concrete and
  worth naming — Codex never mentions this.
- R3 "Transactional DDL" with `autocommit` / `DO` block hand-waving.
  This risk is the flip side of the Section 3.1 atomicity concern
  and its mitigation is vague.

Missing risks: checksum drift from CRLF (Codex R4), noisy `pg_dump`
comparison (N/A because Gemini doesn't do a schema comparison),
Sprint 000 regression, `pg_hba.conf` password auth for custom
roles, operator confusion on forward-only failure recovery,
placeholder-password hygiene.

### B.5 Feasibility

Feasible but more work than Codex's plan. The Python runner adds a
real dependency (`psycopg2` or `psycopg`), which the draft hedges
with "(if needed, or use `std` libs)" in Phase 2 — but Python has
no `std lib` PostgreSQL client, so that parenthetical is wrong. The
runner must ship with a `requirements.txt` (or a virtualenv bootstrap
step) and Sprint 000's one-button harness needs to install it,
neither of which is in the implementation plan. This is a feasibility
gap hiding behind a hedge.

The `--check` flag in Phase 2 task 5 is new scope not in the intent.
The intent's final paragraph explicitly says "do not invent scope
beyond the ROADMAP seed." Minor but worth noting.

### B.6 Verification Plan Quality

Seven automated checks, no executor notes, no manual-verification
detail. Specific issues:

- Row 1 "Migration Application" — validates only "all 9 migrations
  apply"; no check that the runner *records them* with checksums.
- Row 2 "Idempotency" — fine.
- Row 3 "Checksum Integrity" — the Manual Verification section
  explicitly says "Append `-- comment` to
  `migrations/0001_initial_schema.sql`," which means the verification
  literally involves mutating a tracked file in the repo. This is
  wrong for an automated test and actively dangerous as a manual
  step ("remember to revert the file" is a footgun). Codex's
  temp-copy approach is strictly better.
- Row 4 "Canonicalization (22/22)" — only asserts on INSERT, not on
  UPDATE. The intent explicitly requires both paths ("trigger fires
  on INSERT and UPDATE"). Phase 4 prose does not mention UPDATE
  either. This is a coverage gap against the ROADMAP validation.
- Row 7 "Sync Log Trigger" — conflates "CDC captures non-daemon
  writes" with "daemon-source writes are suppressed" in one row.
  These are two distinct failure modes and should be two rows.

No row covers staged-vs-full schema equivalence (the scope miss
from B.2). No row covers Sprint 000 regression (though Section 5.3
has one sentence about the smoke test). No row covers apply-time
migration failure.

Verification plan is noticeably weaker than the intent asks for.

### B.7 Definition of Done

Eight checklist items. Thin. Missing items that the intent
requires:

- No item for staged-vs-full equivalence.
- No item for `content_fingerprint` behavior.
- No item for `updated_at` behavior.
- No item for applying in order (only "idempotent").
- No item for "a failed migration is not recorded in
  `schema_migrations`."
- No item for "Sprint 000 smoke suite still passes" as an explicit
  regression gate.
- "CI passes on GitHub Actions" is a good terminal gate but it
  substitutes for, rather than complements, the behavioral gates.

The DoD is substantially less complete than the intent's Success
Criteria section.

### B.8 Open Questions Answers

All eight answered in Section 10, but several are thin or
contradictory:

- Q1 Python: justified as "better for checksum tracking, structured
  error handling, future extensibility." `hashlib.sha256` vs
  `sha256sum` is not a meaningful differentiator, and "future
  extensibility" is the kind of justification the intent warns
  against ("do not invent scope beyond the ROADMAP seed").
- Q2 Deno: conflicts with Q1's Python choice — the intent's Q2
  specifically asks drafters to argue how runner and test-runtime
  choices interact, and this answer doesn't engage with the
  tension.
- Q3 SHA-256: fine.
- Q4 `MEMEX_TEST_DB_*`: fine.
- Q5 `DO` blocks: fine, but the risk register then undermines this
  with R3's "Transactional DDL" hedge.
- Q6 Isolation: "clears the schema (or drops/recreates)" — this
  doesn't actually solve cross-test interference for server-scoped
  roles (see B.1). The answer is evasive.
- Q7 Separate step: fine.
- Q8 Failure recovery: one sentence. The intent asks drafters to
  "explain the operator experience when something goes wrong" and
  this answer doesn't. No guidance on checksum-mismatch vs
  SQL-failure distinction, no rerun-from-last-success narrative.

Gemini's Open Questions section answers the letter of each question
but does not engage with the intent's actual concerns.

### B.9 Summary for GEMINI Draft

**(a) Strongest ideas worth keeping:**
- Explicit NFC-mismatch risk (R1) — Codex missed this and it is a
  genuine foot-gun the SQL-fixture assertion chain exists to
  prevent.
- Explicit `memex_test` `CREATEROLE` risk (R2) — Codex did not
  name this and it is a practical concern for any Compose image
  whose default test user lacks `CREATEROLE`.
- The Use Cases table's explicit enumeration of role-deny and
  role-allow as distinct rows (rows 7 and 8) is clean.
- Section 10 answer 8's one sentence is at least *consistent* with
  the forward-only architecture, even if thin.

**(b) Weaknesses or gaps:**
- Picks Python for the runner *and* Deno for tests, which is the
  most toolchain-sprawl option available. The justifications
  contradict each other.
- Python runner adds an external dependency (`psycopg2`/`psycopg`)
  with no installation path in the test harness. "Or use `std`
  libs" is wrong — Python has no stdlib PostgreSQL driver.
- **Staged-vs-full equivalence check is absent** from the whole
  plan. This is a ROADMAP validation bullet and a scope miss.
- Canonicalization tests only cover INSERT, not UPDATE.
  ROADMAP explicitly requires both.
- Checksum-drift test design mutates files in the real
  `migrations/` tree. Codex's temp-copy approach is strictly
  better.
- Phase 7 ordering bug: `run-tests.sh` wiring comes after the
  integration tests are written, so Phases 3–6 are unrunnable
  until Phase 7 lands.
- Phases 3–6 are over-split; they all modify the same file and
  could be one or two phases.
- DoD is thin: missing fingerprint, `updated_at`, staged-vs-full,
  apply-order, failed-migration recording, Sprint 000 regression.
- Manual verification is three steps with no per-step expected
  output beyond one block. Far too thin for "make the schema
  executable and prove it."
- Isolation story ("drop and recreate `public`") does not actually
  isolate role side effects and does not enable the staged-vs-full
  test either.
- Section 3.1 atomicity note vaguely promises "the runner handles
  these as exceptions" for `autocommit` paths without specifying
  the mechanism. This is the kind of hand-wave that becomes a
  real bug during implementation.
- Invents a `--check` flag in Phase 2 task 5 that is not in the
  intent's scope.

**(c) Open Questions resolution:** all eight answered, but Q1/Q2
contradict each other (Python runner + Deno tests = more toolchain
sprawl, not less), Q6 evades the real isolation problem, and Q8 is
one sentence where the intent asks for an operator experience
narrative. Several answers are technically present but do not
engage with the intent's actual questions.

---

## Part C: Comparative Notes

The two drafts converge on the easy answers (SHA-256, `MEMEX_TEST_DB_*`
env vars, `DO`-block role idempotency, separate-step runner) and
diverge on the load-bearing choices:

- **Runner language.** Codex: Bash, justified by "no new toolchain."
  Gemini: Python, justified by "checksum tracking and structured
  error handling." Codex's justification is stronger because
  Sprint 000 already ships Bash (`tests/run-tests.sh`) and
  `sha256sum` is already on the table.
- **Toolchain sprawl.** Codex lands at one new language (Bash, with
  Deno reused from Sprint 000). Gemini lands at two new languages
  (Python added, Deno reused). The intent's Q2 specifically asks
  drafters to argue for one runtime shape.
- **Isolation.** Codex: fresh per-scenario databases, serial
  execution. Gemini: drop `public` schema on a shared database.
  Codex's approach is strictly better because it actually isolates
  role side effects and cleanly enables the staged-vs-full check.
- **Staged-vs-full equivalence.** Codex: explicit `pg_dump`
  comparison. Gemini: absent. This is the biggest single scope
  gap between the two drafts.
- **Canonicalization coverage.** Codex: INSERT *and* UPDATE, each
  asserted byte-for-byte. Gemini: INSERT only, with UPDATE hedged
  in a half-sentence. ROADMAP requires both.
- **Checksum drift test design.** Codex: temp-copy of `migrations/`.
  Gemini: mutate the real file. Codex is right.
- **Failure recovery.** Codex: a whole Section 3.5 narrative plus
  manual steps plus R7 mitigation. Gemini: one sentence. The
  intent's Q8 asks for the operator experience.
- **Verification plan depth.** Codex: 13 automated checks with
  executor notes, 10 manual steps with expected output, explicit
  Sprint 000 regression rows. Gemini: 7 automated checks without
  executor notes, 3 manual steps, one sentence on Sprint 000
  regression.
- **Risks Codex misses that Gemini catches:** NFC normalization
  mismatch between SQL and Deno, and `memex_test` potentially
  lacking `CREATEROLE`. Both are worth incorporating into any
  merged plan.

### Recommendation for the merge

Take Codex as the base draft and port in from Gemini:
1. Gemini's R1 (NFC mismatch between SQL `normalize()` and Deno
   `String.prototype.normalize`).
2. Gemini's R2 (`memex_test` `CREATEROLE` dependency) — turn it
   into a concrete preflight check in `tests/run-tests.sh` or
   verify the Compose image default grants it.
3. Gemini's explicit split of role-deny and role-allow into
   distinct Use Case rows (already present in Codex but worth
   double-checking the test case shape).

Then close Codex's own gaps:
4. Add a verification row and a DoD item for "apply-time migration
   failure does not record `schema_migrations` and the runner
   exits non-zero," implemented via a synthetic bad-SQL migration
   fed through the migrations-directory override.
5. Name explicitly that `CREATE ROLE` inside a `DO` block is safe
   under the per-migration transaction contract, and cite the
   PostgreSQL docs in-comment in `0009`.
6. Address `pg_hba.conf` / password-auth for `memex_mcp` and
   `memex_sync` — either confirm the Compose pgvector image's
   default `pg_hba.conf` permits it, or add a Compose-level
   override, before manual step 8 is expected to work.
7. Enumerate the `pg_dump` noise-stripping rules concretely
   (banner line, `SET` statements, comments) so R5's mitigation is
   executable rather than aspirational.
