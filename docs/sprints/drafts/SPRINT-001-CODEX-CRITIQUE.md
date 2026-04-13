# Sprint 001 Draft Critique (Codex)

## Overall

Claude's draft is the better starting point. It is materially more complete, engages the intent's open questions directly, and has a verification section that is close to implementation-ready. It still needs correction in a few important places before I would accept it as the sprint plan.

Gemini's draft is not ready as the primary plan. The high-level shape is reasonable, but too many decisions stay generic or contradictory, especially around Python dependencies, migration atomicity, test isolation, and verification depth.

## Claude Draft

### Architectural soundness

Verdict: strong overall, with two real architectural overreaches.

- The draft answers the intent's major design questions directly and mostly well: Bash runner, Deno tests, existing `MEMEX_TEST_*` env vars, runner as a `run-tests.sh` step, and per-migration transaction wrapping are all argued clearly in `SPRINT-001-CLAUDE-DRAFT.md:45-143`.
- The biggest issue is the permission expansion in `0009_add_roles.sql`: it grants `SELECT, INSERT` on `thought_relations` to `memex_mcp` and justifies that as future-friendly (`SPRINT-001-CLAUDE-DRAFT.md:98-114`). That is not in the authoritative architecture, which grants `memex_mcp` only `thoughts`, `sync_log`, `sync_state`, `thoughts_id_seq`, and `match_thoughts` (`memex-architecture.md:879-893`). This is out of scope and weakens the "architecture is the input, not the output" rule from the intent.
- The second issue is the blanket push for file-level idempotency via `IF NOT EXISTS`, `DROP TRIGGER IF EXISTS`, and `CREATE OR REPLACE` across nearly every migration (`SPRINT-001-CLAUDE-DRAFT.md:323-333`, `659-666`). The intent requires runner-level no-op behavior and additive-only migrations, but not "safe to re-run every file against an arbitrary partial state." Some qualifiers are harmless; making that a universal rule changes the authoritative SQL surface and can mask drift.

### Completeness

Verdict: very complete, but one validation is under-specified in a way that matters.

- The draft covers the core scope well: all nine migrations, runner, `schema_migrations`, checksums, canonicalization fixtures, `content_fingerprint`, role boundary, `sync_log`, `tests/run-tests.sh`, CI, and Sprint 000 regressions (`SPRINT-001-CLAUDE-DRAFT.md:20-41`, `509-622`, `659-683`).
- The split-apply validation is the weak spot. The use-case table promises byte-identical schema comparison via normalized `pg_dump --schema-only` (`SPRINT-001-CLAUDE-DRAFT.md:26`), but the implementation plan later reduces that to hashing `information_schema.columns` output (`SPRINT-001-CLAUDE-DRAFT.md:378-386`). That would miss functions, triggers, indexes, constraints, generated-column expressions, grants, and the `vector` extension. For this sprint, that is not a small omission.

### Phasing and ordering

Verdict: good structure, but the test topology needs one more operational constraint.

- The phase order is sensible: migrations, runner, helpers, apply/idempotency tests, behavior tests, harness extension, docs (`SPRINT-001-CLAUDE-DRAFT.md:315-507`).
- The shared-database strategy is workable in principle (`SPRINT-001-CLAUDE-DRAFT.md:115-124`), but the plan does not explicitly serialize integration test execution. At the same time, it splits tests across multiple files and proposes `deno test --allow-all tests/integration/` (`SPRINT-001-CLAUDE-DRAFT.md:299-311`, `313`). Unless the integration task is forced to run serially, file-level `TRUNCATE` plus a shared DB is a flake source.

### Risk coverage

Verdict: the best of the two drafts.

- The risk table is broad and useful: canonicalization mismatches, quoting/byte corruption, role creation, password drift, `SET LOCAL` session scope, drop/create connection leakage, runner exit-code ambiguity, and regression against Sprint 000's ERR-trap work are all called out (`SPRINT-001-CLAUDE-DRAFT.md:685-700`).
- What is still missing is one cross-system interaction: `memex_mcp` INSERT/UPDATE permissions interact with the `sync_log` trigger. If the trigger function executes with invoker privileges, a role that can write `thoughts` but not `sync_log` may fail on write. The draft's role tests would probably catch this indirectly (`SPRINT-001-CLAUDE-DRAFT.md:440-449`, `451-473`), but the plan should name it explicitly because it is exactly the kind of architecture-level integration bug Sprint 001 needs to flush out.

### Feasibility

Verdict: mostly feasible.

- Bash + `psql` via `docker compose exec` fits the existing Sprint 000 harness better than introducing a Python driver. It aligns with current prerequisites in `tests/run-tests.sh`, which only assert `docker` and `deno` today (`tests/run-tests.sh:26-27`).
- The main feasibility concern is scope creep for test convenience: `MEMEX_MIGRATE_MAX` and `MEMEX_MIGRATE_DIR` become runner surface area solely to support tests (`SPRINT-001-CLAUDE-DRAFT.md:381-394`, `664`). They may still be worth it, but the plan should treat them as deliberate test hooks, not as obviously-free additions.
- The switch to `--allow-all` in Deno tasks (`SPRINT-001-CLAUDE-DRAFT.md:304-311`) is broader than the current `deno.json` permissions (`deno.json:5-7`). The plan should justify that regression, or better, keep unit and integration permissions scoped separately.

### Verification plan quality

Verdict: strong and mostly actionable, but not fully tight yet.

- This is the strongest section of either draft. The automated checks are concrete, mapped to files, and mostly correspond to real assertions rather than hand-wavy "verify X" claims (`SPRINT-001-CLAUDE-DRAFT.md:513-535`).
- The Sprint 000 regression section is notably good. It at least remembers that this sprint can break the harness even if the schema itself is correct (`SPRINT-001-CLAUDE-DRAFT.md:601-616`).
- The two main problems:
  - The split-apply test does not actually validate final-schema equivalence if it only compares `information_schema.columns` (`SPRINT-001-CLAUDE-DRAFT.md:378-386`).
  - Some regression scenarios are not automation-ready. Port pre-binding, SIGINT teardown, and "workflow file unchanged" are useful review prompts, but they are not the same quality of check as the rest of the table (`SPRINT-001-CLAUDE-DRAFT.md:607-615`).

### Definition of done

Verdict: detailed and measurable, but it bakes in a few things the sprint does not actually need.

- The DoD is much stronger than Gemini's because it names concrete files and behaviors (`SPRINT-001-CLAUDE-DRAFT.md:659-683`).
- The weak points mirror the earlier issues:
  - It turns the test hooks into mandatory deliverables (`SPRINT-001-CLAUDE-DRAFT.md:663-665`).
  - It codifies the file-level-idempotency push (`SPRINT-001-CLAUDE-DRAFT.md:661`).
  - It inherits the unauthorized `memex_mcp` access expansion from the plan body.

### Strongest ideas worth keeping

- The explicit, one-by-one answers to the intent's open questions (`SPRINT-001-CLAUDE-DRAFT.md:45-143`).
- The transactional failure-recovery story for mid-apply errors (`SPRINT-001-CLAUDE-DRAFT.md:130-143`).
- The byte-safe canonicalization test approach that avoids SQL-string escaping bugs (`SPRINT-001-CLAUDE-DRAFT.md:402-415`).
- The regression section aimed at protecting Sprint 000's harness, not just the new schema (`SPRINT-001-CLAUDE-DRAFT.md:601-616`).
- The explicit unit/integration phase split in `run-tests.sh` (`SPRINT-001-CLAUDE-DRAFT.md:286-311`).

### Weaknesses or gaps

- Remove the `thought_relations` grant for `memex_mcp`; it is not in the architecture (`SPRINT-001-CLAUDE-DRAFT.md:98-114`, `memex-architecture.md:879-893`).
- Tighten the split-apply test so it compares real schema state, not just column listings (`SPRINT-001-CLAUDE-DRAFT.md:26`, `378-386`).
- Make integration execution explicitly serial, or isolate tests more strongly (`SPRINT-001-CLAUDE-DRAFT.md:115-124`, `299-311`).
- Reconsider universal file-level re-runnability as a sprint requirement (`SPRINT-001-CLAUDE-DRAFT.md:323-333`, `661`).
- Avoid broadening Deno permissions to `--allow-all` unless there is no smaller viable set (`SPRINT-001-CLAUDE-DRAFT.md:304-311`, `deno.json:5-7`).

### Open questions: are they well-justified?

Mostly yes.

- Q1, Q2, Q3, Q4, Q7, and Q8 are well-justified and aligned with the current repo state (`SPRINT-001-CLAUDE-DRAFT.md:49-74`, `126-143`).
- Q5 is only partially well-justified: the DO-block approach is good, but the answer oversteps by changing granted privileges (`SPRINT-001-CLAUDE-DRAFT.md:76-114`).
- Q6 is directionally good, but it is not fully justified until the draft says how Deno integration tests avoid cross-file interference in practice (`SPRINT-001-CLAUDE-DRAFT.md:115-124`, `299-311`).

## Gemini Draft

### Architectural soundness

Verdict: weak to moderate.

- The draft aligns with the intent at a very high level: nine migrations, checksum tracking, env-var credentials, role creation in `0009`, and a separate `run-tests.sh` migration step (`SPRINT-001-GEMINI-DRAFT.md:10-15`, `72-97`, `152-157`, `246-252`).
- The runner design is under-justified. Choosing Python with `psycopg2` or `psycopg` (`SPRINT-001-GEMINI-DRAFT.md:35`, `88-90`, `242`) adds a new runtime and database client stack to a repo whose current harness only depends on Docker and Deno (`tests/run-tests.sh:26-27`). The draft never explains how CI or a clean local checkout gets that dependency.
- The atomicity story is internally inconsistent. The architecture section says each migration is wrapped in a transaction but some statements may need autocommit exceptions (`SPRINT-001-GEMINI-DRAFT.md:40`); the risk section repeats that (`SPRINT-001-GEMINI-DRAFT.md:237`); the open-question answer then says failed migrations leave the DB partially applied (`SPRINT-001-GEMINI-DRAFT.md:253`). That is not a coherent operator story.
- The test-topology reset plan is also weak. Dropping and recreating only the `public` schema (`SPRINT-001-GEMINI-DRAFT.md:51-54`) does not really model "empty database" migration application and does not reset cluster-scoped roles from `0009`.

### Completeness

Verdict: incomplete.

- The draft misses or under-specifies several intent requirements:
  - No concrete split-apply equivalence check beyond a one-line use case (`SPRINT-001-GEMINI-DRAFT.md:22`, `165-173`).
  - No explicit canonicalization-on-UPDATE test, even though the intent requires INSERT and UPDATE behavior (`SPRINT-001-GEMINI-DRAFT.md:115-123`).
  - No explicit `ob_uuid` verification at all.
  - `source` and `updated_at` are mentioned in the implementation tasks, but not elevated into the verification table or DoD (`SPRINT-001-GEMINI-DRAFT.md:121-123`, `165-173`, `222-229`).
  - No Sprint 000 regression coverage beyond "smoke test still passes" (`SPRINT-001-GEMINI-DRAFT.md:206-210`).
- The single-file integration strategy (`SPRINT-001-GEMINI-DRAFT.md:51`, `102`, `111`, `127`, `139`) also makes the plan harder to review, because coverage is buried in one evolving test file instead of separated by behavior.

### Phasing and ordering

Verdict: acceptable at a headline level, weak in execution detail.

- The phases move in a sensible order: migrations, runner, tests, harness (`SPRINT-001-GEMINI-DRAFT.md:56-157`).
- The problem is compression. There is no helper-layer design, no explanation of how Deno talks to Postgres, no install/bootstrap phase for Python dependencies, and no explicit CI adjustment plan. That makes the ordering look cleaner than it really is.

### Risk coverage

Verdict: too thin.

- Only three risks are named (`SPRINT-001-GEMINI-DRAFT.md:231-237`), and two of them are still left in "use X or ensure Y" form rather than resolved mitigation.
- Missing risks include:
  - new Python dependency/bootstrap failure,
  - shared-DB isolation and test interference,
  - `SET LOCAL` requiring same-session execution,
  - checksum-tamper testing strategy,
  - regression in `tests/run-tests.sh` ERR-trap and teardown behavior,
  - permission interactions between `thoughts` writes and the `sync_log` trigger.

### Feasibility

Verdict: the weakest part of the draft.

- `psycopg2 (or psycopg v3)` is not a decision; it is an unresolved branch (`SPRINT-001-GEMINI-DRAFT.md:35`).
- `scripts/requirements.txt` is listed as "if needed" (`SPRINT-001-GEMINI-DRAFT.md:88-90`), but the runner plainly does need a driver if it is implemented the way the draft proposes.
- The test-topology note about "separate connection pools" (`SPRINT-001-GEMINI-DRAFT.md:54`) is also vague because the draft never chooses a Deno Postgres driver or an alternative `psql`-based mechanism.

### Verification plan quality

Verdict: not sufficient for this sprint.

- The automated-check table is too generic to be implementation guidance (`SPRINT-001-GEMINI-DRAFT.md:165-173`). It names seven broad checks but omits many required assertions and does not say how those checks prove the behavior.
- It does not adequately cover regression against Sprint 000. There is only one regression scenario, and it is effectively "run the full suite and hope the smoke test still passes" (`SPRINT-001-GEMINI-DRAFT.md:206-210`).
- Important missed system interactions and failure modes:
  - canonicalization on UPDATE is not explicitly tested,
  - split-apply equivalence is not concretely tested,
  - `SET LOCAL app.sync_source = 'daemon'` may produce a false pass if not run in the same session,
  - `memex_mcp` allow-path writes may fail indirectly because of trigger side effects,
  - partial-failure cleanup is not exercised despite the draft's own uncertainty about transaction boundaries.

### Definition of done

Verdict: too high-level.

- The DoD is directionally correct (`SPRINT-001-GEMINI-DRAFT.md:220-229`), but it does not enumerate enough of the actual sprint acceptance criteria to act as a closeout checklist.
- In particular, it leaves out split-apply equivalence, canonicalization on UPDATE, `ob_uuid`, `source`, `updated_at`, Sprint 000 harness regressions, and failure-recovery behavior.

### Strongest ideas worth keeping

- The explicit decision to use the existing `MEMEX_TEST_DB_*` env vars (`SPRINT-001-GEMINI-DRAFT.md:41`, `249`).
- Keeping the runner as a step in `tests/run-tests.sh` rather than as a Compose service (`SPRINT-001-GEMINI-DRAFT.md:152-157`, `252`).
- The use of DO blocks for `CREATE ROLE` idempotency in `0009` (`SPRINT-001-GEMINI-DRAFT.md:74-83`, `250`).

### Weaknesses or gaps

- Pick one Python driver and explain how it lands in local and CI environments (`SPRINT-001-GEMINI-DRAFT.md:35`, `88-90`, `242`).
- Resolve the transactional story; right now the runner is both atomic and not atomic depending on the paragraph (`SPRINT-001-GEMINI-DRAFT.md:40`, `237`, `253`).
- Replace "drop and recreate `public` schema" with a real database-reset strategy if the sprint is supposed to validate empty-DB application (`SPRINT-001-GEMINI-DRAFT.md:51-54`).
- Expand verification substantially; the current table is not enough to protect this sprint (`SPRINT-001-GEMINI-DRAFT.md:165-173`).
- Add real Sprint 000 regression checks around `tests/run-tests.sh`, not just the smoke test (`SPRINT-001-GEMINI-DRAFT.md:206-210`).

### Open questions: are they well-justified?

Mostly no, or only partially.

- Q3, Q4, and Q7 are acceptable (`SPRINT-001-GEMINI-DRAFT.md:248-252`).
- Q1 is weakly justified; it states Python is "better" without addressing toolchain cost in this repo (`SPRINT-001-GEMINI-DRAFT.md:246`).
- Q5 is only partially answered. DO blocks cover existence, but the draft does not address password drift, repeated grants, or the fact that roles are cluster-scoped (`SPRINT-001-GEMINI-DRAFT.md:74-83`, `250`).
- Q6 is not well-justified. "Shared database, but clear the schema" is not a real isolation plan (`SPRINT-001-GEMINI-DRAFT.md:251`).
- Q8 is the weakest answer. "Partially applied; operator must fix and re-run" is neither well-defended nor aligned with the stronger recovery model the sprint should target (`SPRINT-001-GEMINI-DRAFT.md:253`).

## Recommendation

Use Claude's draft as the base, but revise it before approval:

- remove the unauthorized `memex_mcp` permission expansion,
- strengthen split-apply verification to compare real schema state,
- make integration execution serial or strengthen isolation,
- trim back the "every file must be manually re-runnable" requirement unless explicitly wanted,
- avoid broad `--allow-all` if narrower Deno permissions are sufficient.

Treat Gemini's draft as secondary input only. Its best contributions are the simpler framing and the DO-block reminder for `0009`, but it is too incomplete and under-justified to serve as the sprint plan.
