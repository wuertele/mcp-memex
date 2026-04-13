# Sprint 001 Review: Gemini Critique

This critique evaluates the two parallel draft plans for Sprint 001 (Schema Migrations and Migration Runner). Both drafts demonstrate a high degree of alignment with the `SPRINT-001-INTENT.md` and the `ROADMAP.md`.

## 1. Evaluation: Claude Draft

### Architectural Soundness & Feasibility
The choice of **Bash** for the runner and **Deno** for integration tests is architecturally sound and minimizes dependency sprawl. The decision to run the runner outside of Compose but execute `psql` inside the container via `docker compose exec` is a pragmatic middle ground that avoids host-side `psql` requirements while keeping the topology simple.

### Completeness & Phasing
The plan is exceptionally detailed, covering 11 implementation phases. The phasing is logical, starting with the SQL files and moving through the runner, helpers, and specific feature tests.

### Risk Coverage & Verification Plan
**Strongest area of this draft.** Claude identifies a subtle but critical risk (Risk #2): binary corruption of fixtures during `psql -c` transmission. The proposed solution—using `pg_read_file` from a container-local temp file—is a high-quality engineering detail.
- **Verification hooks:** The addition of `MEMEX_MIGRATE_MAX` and `MEMEX_MIGRATE_DIR` specifically for testing is a "test-first" architectural win.
- **Regression coverage:** Section 5.3 (R1–R9) provides a rigorous checklist to ensure Sprint 000 stability is maintained.

### Definition of Done
Comprehensive and actionable. Each item is verifiable.

### Strengths to Keep
- **Automated Verification of Split-Apply:** Using `MEMEX_MIGRATE_MAX` to verify that 1-5 + 6-9 equals 1-9.
- **Binary Fixture Handling:** The `pg_read_file` strategy for byte-perfect canonicalization tests.
- **Tamper Detection Testing:** Explicitly testing the runner's exit code 2 path.

### Weaknesses or Gaps
- **Isolation Strategy:** The "Hybrid" approach (Q6) of using TRUNCATE/Transactions in a shared database is more prone to flakiness than a "fresh DB per test" approach. While faster, it increases the risk of cross-test pollution if a test fails to clean up properly.

---

## 2. Evaluation: Codex Draft

### Architectural Soundness & Feasibility
Like Claude, Codex chooses Bash and Deno. The architectural decisions are well-justified and follow the intent's constraints.

### Completeness & Phasing
The plan is concise and well-structured into 5 clear phases. It focuses heavily on the "what" and "why" of the schema behavior.

### Risk Coverage & Verification Plan
Codex's verification plan is solid but less "mechanically specific" than Claude's.
- **Schema Equivalence:** The use of normalized `pg_dump --schema-only` output (Section 3.4) to compare staged-vs-full applies is an elegant, high-signal verification method that covers more than just table lists.
- **Isolation:** The "fresh database per scenario" (Section 3.3) is a cleaner isolation model than Claude's hybrid model, even if it adds a few seconds to the test run.

### Definition of Done
Clear and mirrors the roadmap requirements.

### Strengths to Keep
- **`pg_dump` Equivalence Test:** This is a superior way to verify schema identity compared to manual catalog checks.
- **Scenario-based Database Isolation:** Creating `memex_it_behavior`, `memex_it_roles`, etc., provides excellent debuggability when tests fail.

### Weaknesses or Gaps
- **Binary Data Risk:** Codex lacks the specific "binary corruption" mitigation found in Claude's draft. Given the Unicode/BOM/CRLF nature of the fixtures, this is a real risk.
- **Runner Hooks:** Codex does not explicitly define the environment variable hooks (`MAX`, `DIR`) that would allow the Deno test suite to easily exercise the runner's edge cases (tamper, partial apply).

---

## 3. Comparison of Open Question Responses

| Question | Claude's Answer | Codex's Answer | Gemini Critique |
| :--- | :--- | :--- | :--- |
| **Runner Lang** | Bash | Bash | **Correct.** Minimizes toolchain churn. |
| **Test Lang** | Deno | Deno | **Correct.** Consistent with Sprint 000. |
| **Isolation** | Hybrid (Truncate) | Fresh DB per scenario | **Codex wins.** Much lower risk of flakes. |
| **Role Idempotency** | DO blocks | DO blocks | **Consensus.** Correct approach for server-scoped roles. |
| **Runner Location** | Separate script | Separate script | **Consensus.** Keeps Compose simple. |

## 4. Final Recommendations for the Executor

1. **Adopt Claude's Runner Hooks:** The final plan should include the `MEMEX_MIGRATE_MAX` and `MEMEX_MIGRATE_DIR` environment variables to allow the integration tests to exercise the runner's logic without "hacking" the repo state.
2. **Adopt Codex's Isolation Model:** Use fresh databases for distinct test scenarios. The performance hit on PG16 is negligible compared to the reliability gain.
3. **Adopt Codex's Schema Dump Test:** Use `pg_dump --schema-only` for the split-apply equivalence test. It's the most robust way to ensure the schema is identical.
4. **Adopt Claude's Binary Injection Strategy:** Use the `pg_read_file` or a similar robust mechanism to ensure canonicalization fixtures aren't corrupted by shell interpolation or `psql` character encoding issues.
5. **Role Passwords:** Both drafts correctly identify that these are test-only placeholders. Claude's inclusion of a `migrations/README.md` to document this is a nice touch.

Both drafts are high-quality. Claude is stronger on the **automated verification of the runner itself**, while Codex is stronger on **clean test isolation and high-signal schema comparison**. A merge of these two will produce a bulletproof Sprint 001.
