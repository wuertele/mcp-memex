# Sprint 001 Merge Notes

## Claude Draft Strengths
- `MEMEX_MIGRATE_MAX` and `MEMEX_MIGRATE_DIR` as runner test hooks — makes
  the split-apply test and the checksum-drift test trivially expressible
  from Deno without touching the committed `migrations/` tree.
- `pg_read_file`-based binary-safe fixture injection into the
  canonicalization trigger — bypasses `psql -c` shell/byte escaping and
  lets every one of the 22 fixtures be asserted byte-for-byte.
- Dense Sprint 000 regression coverage: R1–R9 explicitly test smoke
  still passes, port preflight, Compose config, SIGINT teardown, mock
  inference health, fixture file unchanged, CI workflow unchanged, ERR
  trap propagation, and mock-inference healthcheck (including the
  post-sprint-000 wget fix).
- Distinct runner exit codes for OK / migration-failed / tamper /
  prereq (0/1/2/3). Clearer for scripts that consume the runner.
- Risk #11: `MEMEX_MIGRATE_DIR` test-side invariant that the override
  only affects the runner's read path, not the committed tree.
- Use of `DROP DATABASE ... WITH (FORCE)` to avoid flakes from lingering
  connections during per-scenario DB reset.

## Codex Draft Strengths
- Per-scenario fresh databases on the shared PostgreSQL server, with
  explicit serial execution because roles are server-scoped.
- `pg_dump --schema-only --no-owner --no-privileges` as the
  staged-vs-full equivalence oracle — catches tables, columns, indexes,
  functions, triggers, and grants in one comparison.
- `PSQL` command override in the runner so automated tests use
  `docker compose exec -T postgres psql` without requiring a host
  `psql` client (preserves Sprint 000's no-host-tooling contract).
- Twenty-item Definition of Done focused on observable outcomes.
- Cleaner 5-phase structure (SQL → runner → harness wiring → runner
  mechanics tests → behavioral schema tests) that is independently
  reviewable at phase granularity.
- Byte-for-byte canonicalization assertion against stored values,
  not reconstructed expected output in TypeScript.
- `CREATE ROLE` idempotency via `DO` blocks against `pg_roles` with
  unconditional `GRANT` reissue (grants are safe to rerun).
- Deliberate decision to run the runner as a `run-tests.sh` step,
  not a Compose service — keeps Sprint 000 topology unchanged.

## Gemini Draft Strengths
- Explicit NFC-normalization-mismatch risk (SQL `normalize()` vs Deno
  `String.prototype.normalize()`) — caught by neither Codex nor Claude
  as a named risk.
- Explicit `memex_test` `CREATEROLE` precondition risk.
- Concise framing and use-case enumeration.

## Consensus Critiques (multiple reviewers agreed)
- **Gemini draft is third-ranked.** Both Claude-critic and Codex-critic
  rank Gemini below the other two. Reasons named by both: Python
  runner + Deno tests is the worst-of-both-worlds toolchain choice;
  staged-vs-full equivalence is missing from the plan; checksum test
  mutates files in the real `migrations/` tree; risk register is thin
  (3 risks); verification plan has 7 checks with no executor notes.
- **Codex base + Claude ports is the merge recipe.** Claude-critic
  explicitly recommends this: "Take Codex as the base draft and port
  in from Gemini... Then close Codex's own gaps." Gemini-critic says
  the same thing in different words: "A merge of these two will
  produce a bulletproof Sprint 001."
- **Fresh DB per scenario beats hybrid TRUNCATE.** All three critiques
  (including Claude's own critic) prefer Codex's isolation model.
- **`pg_dump --schema-only` is the right equivalence oracle.** Both
  Codex-critic and Gemini-critic call this out explicitly; it
  dominates hand-rolled catalog queries.

## Valid Critiques Accepted
- **Strip Claude's `thought_relations` grant for `memex_mcp`.**
  Architecture Section 6.9 grants `memex_mcp` SELECT/INSERT on
  `thoughts`, `sync_log`, `sync_state`, `thoughts_id_seq`, and
  `match_thoughts` only. Adding `thought_relations` is out of scope
  and establishes a "plan modifies spec" precedent the sprint is
  supposed to avoid.
- **Minimal file-level idempotency, not universal.** The runner owns
  idempotency via `schema_migrations`. Only `0009_add_roles.sql` needs
  file-level guards, because PostgreSQL roles are cluster-scoped and
  can outlive any per-database `schema_migrations` row. Codex's
  approach is correct; Claude's universal `IF NOT EXISTS` / `CREATE
  OR REPLACE` push is dropped.
- **Add a synthetic bad-migration test.** Codex's plan tests
  checksum-drift failure but not apply-time SQL failure. Claude has
  this (DoD line for "failed-migration rollback" via DoD 20). Merge
  adds an explicit verification row using `MEMEX_MIGRATE_DIR` to
  point the runner at a temp dir containing a deliberately broken
  migration file. Confirms failed migrations leave no
  `schema_migrations` row and runner exits non-zero.
- **Port Claude's Sprint 000 regression table (R1–R9).** Codex's
  regression coverage is a short bullet list; Claude's is a nine-row
  table that explicitly protects each Sprint 000 property. The
  Claude table is strictly richer and costs nothing to adopt.
- **Port Claude's `pg_read_file` binary-safe canonicalization
  injection.** Codex says "byte-for-byte" but doesn't prescribe a
  mechanism. Claude's approach (write raw bytes via `docker compose
  exec -T ... sh -c 'cat > /tmp/content.txt'` then
  `pg_read_file('/tmp/content.txt')::text`) bypasses shell/`psql -c`
  escaping entirely. This is the only way to safely inject fixtures
  containing backslashes, CR bytes, and combining characters.
- **Port Claude's `MEMEX_MIGRATE_MAX` and `MEMEX_MIGRATE_DIR` runner
  hooks.** Both are test-only read-path overrides; neither mutates
  production behavior. They make the split-apply test and the
  synthetic bad-migration test expressible from Deno without touching
  the real `migrations/` tree.
- **Port Claude's distinct runner exit codes** (0 OK, 1 migration
  failed, 2 tamper, 3 prereq). Makes harness behavior unambiguous.

## Critiques Rejected (with reasoning)
- **Universal file-level idempotency** (Claude's original position).
  Rejected per the interview decision: runner owns idempotency, SQL
  files stay declarative. Only `0009` carries a DO-block existence
  check.
- **Claude's `thought_relations` grant for `memex_mcp`.** Rejected per
  the interview decision: follow architecture Section 6.9 strictly.
- **Python runner** (Gemini's position). Rejected: adds a new runtime
  and package-management story to a repo that currently ships only
  Docker and Deno. Bash + `sha256sum` + `psql`-via-compose-exec is
  strictly smaller.
- **Dropping `public` schema between tests** (Gemini's isolation
  model). Rejected: does not reset cluster-scoped roles and does not
  enable the staged-vs-full equivalence test.
- **`--allow-all` Deno permissions** (Claude's expansion). Rejected:
  keep scoped permissions (`--allow-net --allow-read --allow-env
  --allow-run`). Minor note — if `--allow-run` proves insufficient
  for a specific test harness need, expand narrowly rather than
  broadly.
- **`--check` flag on the runner** (Gemini's addition). Rejected:
  not in the intent's scope, not required by any ROADMAP validation
  bullet. Can be added later if operator workflow calls for it.
- **`migrations/README.md`** (Claude's inclusion). Accepted as a
  small deliverable — the runner contract plus failure-recovery
  narrative deserves a place to live outside the sprint plan. Kept.

## Declined Gap Fixes (per interview)
The interview offered four gap fixes; only one was selected. These are
intentionally NOT in the final sprint plan:
- **`pg_hba.conf` verification for role-based password auth.** Not
  planned. If the compose pgvector image's default `pg_hba.conf` does
  not permit password login for `memex_mcp` and `memex_sync` from
  inside the container, the role-boundary tests will surface a
  real error during execution and we'll address it then. Recording
  the decision here so it's not a silent gap.
- **Concrete `pg_dump` noise-stripping rules.** Not pre-specified.
  Executor will enumerate what needs stripping (likely: version
  comment, `SET` block) during implementation; if the comparison
  turns out noisy, that's a normal iteration during Phase 4.
- **Explicit NFC-mismatch risk entry.** Not added. Risk #6 already
  covers "canonicalization diverges from the shared fixtures" and
  the byte-for-byte assertion is the enforcement mechanism; naming
  the specific `normalize()` divergence as a separate row was
  judged not worth the length.

## Interview Refinements Applied
1. Codex base with Claude ports — see acceptance list above.
2. Strict architecture Section 6.9 grants — no `thought_relations`
   for `memex_mcp`.
3. Minimal file-level idempotency — DO blocks in `0009` only.
4. One gap fix accepted: synthetic bad-migration test via
   `MEMEX_MIGRATE_DIR` override.

## Final Decisions
- **Base draft:** Codex structure and 5-phase plan.
- **Runner language:** Bash.
- **Integration test language:** Deno.
- **Checksum algorithm:** SHA-256 over raw file bytes.
- **Credentials:** reuse `MEMEX_TEST_DB_*` env vars from Sprint 000,
  map to standard `PG*` semantics inside the runner when explicit
  `PG*` values are absent.
- **Role idempotency:** `CREATE ROLE` inside `DO` block with
  `pg_roles` existence check; `GRANT` statements unconditional.
- **Test isolation:** fresh database per scenario on the shared
  PostgreSQL server; suite runs serially.
- **Runner topology:** separate `run-tests.sh` step, not a Compose
  service.
- **Failure recovery:** forward-only, rerun-from-last-success.
- **Runner test hooks:** `MEMEX_MIGRATE_MAX` and `MEMEX_MIGRATE_DIR`,
  both test-only read-path overrides.
- **Canonicalization injection:** `pg_read_file` from a
  container-local temp file to bypass shell escaping.
- **Sprint 000 regression coverage:** 9-row table derived from
  Claude's R1–R9.
- **Equivalence oracle:** normalized `pg_dump --schema-only
  --no-owner --no-privileges`.
- **Runner exit codes:** 0 OK, 1 migration failed, 2 tamper,
  3 prereq error.
- **SQL file style:** declarative, matching architecture Section 6
  verbatim. No universal `IF NOT EXISTS` / `CREATE OR REPLACE`.
- **`memex_mcp` grants:** strictly per Section 6.9. No
  `thought_relations`.
- **Deno permissions:** scoped (`--allow-net --allow-read --allow-env
  --allow-run`), not `--allow-all`.
- **Deliverables include `migrations/README.md`** with manual
  apply, runner usage, failure recovery, and test-password policy.
