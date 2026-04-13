# Sprint 000 Critique: Test Platform and CI Scaffolding

This document provides an adversarial but honest critique of the two competing sprint plans for Sprint 000 of the `mcp-memex` project: `SPRINT-000-CLAUDE-DRAFT.md` and `SPRINT-000-CODEX-DRAFT.md`.

---

## Evaluation: Claude Draft (`SPRINT-000-CLAUDE-DRAFT.md`)

### 1. Architectural Soundness
**Strong.** The plan aligns perfectly with `memex-architecture.md`. It correctly identifies the need for a deterministic mock service and a shared fixture corpus. The choice of Deno for both the mock and the smoke tests minimizes toolchain bloat. The use of a per-process git lock for future-proofing is a nice touch.

### 2. Completeness against ROADMAP.md
**Excellent.** It covers all deliverables listed in the roadmap, including the often-overlooked `tests/lib/wait-for.sh` for robustness against older Compose versions.

### 3. Phasing and Ordering
**Very Logical.** The 8-phase approach is granular and allows for incremental validation. Starting with the skeleton and fixtures before moving to the service implementation is the right move.

### 4. Risk Coverage
**High.** The risk table is comprehensive, specifically calling out Colima socket paths and the risk of in-process caching masking determinism bugs.

### 5. Feasibility (2-3 days)
**Realistic.** The tasks are well-scoped. The mock service is kept under 100 lines as intended.

### 6. Verification Plan Quality
**Exceptional.** The inclusion of specific "Manual Verification Steps" (Section 5.b) is a standout feature. The `diff` check for determinism is exactly the kind of adversarial check needed to ensure the property holds across process restarts. The automated checks are specific and actionable.

### 7. Definition of Done Testability
**High.** The checklist is binary and verifiable.

### 8. Handling of Intent's Open Questions
Addresses all questions directly. Correctly opts for Deno for smoke tests and Compose-in-job for CI to maintain a single source of truth.

### Strongest Ideas
- **Manual Determinism Check:** Using `curl` and `diff` to verify determinism out-of-process is a critical safeguard.
- **Wait-for Helper:** Recognizing that `docker compose --wait` is a recent addition and providing a fallback (`wait-for.sh`) ensures the runner is portable across developer machines.
- **Specific Vector Enumeration:** Phase 2 lists the exact vectors needed to cover Section 6.4, including the "empty string" edge case.

### Weaknesses/Gaps
- **Empty String Interpretation:** The plan interprets `""` as canonicalizing to `"\n"`. While logical per Section 6.4, this is a significant behavioral decision that might surprise a human editor. It should be flagged more prominently for the operator.
- **Port Conflict Strategy:** While it allows overrides via environment variables, it doesn't check for collisions *before* attempting `up`, which could lead to cryptic Docker errors.

### Recommendations
- Add a pre-flight check in `run-tests.sh` that uses `lsof` or `netstat` to verify ports 55432 and 58000 are actually free before starting Compose.
- Confirm the `""` -> `"\n"` mapping with the operator explicitly in the "Open Questions" resolution during the sprint.

---

## Evaluation: Codex Draft (`SPRINT-000-CODEX-DRAFT.md`)

### 1. Architectural Soundness
**Solid.** Follows the architecture well. The "stable-stringify" approach for chat completion fixture lookup (sorting keys) is robust and better than Claude's substring match for complex requests.

### 2. Completeness against ROADMAP.md
**Good.** Covers the core deliverables. However, it misses the `wait-for.sh` utility, relying entirely on `docker compose exec ... pg_isready`, which might fail if the container isn't fully up yet.

### 3. Phasing and Ordering
**Clear.** Similar 8-phase structure. Placing the smoke test (Phase 6) after the service and fixtures is correct.

### 4. Risk Coverage
**Moderate.** The risk table covers the basics but lacks the depth of Claude's (e.g., missing the Colima socket path nuance and the in-process vs out-of-process determinism check).

### 5. Feasibility (2-3 days)
**High.** The plan is straightforward and avoids over-engineering.

### 6. Verification Plan Quality
**Good.** The "Executor Implementation Notes" are helpful but less detailed than Claude's test sketches. The manual verification steps are clear but miss the adversarial `diff` check for determinism.

### 7. Definition of Done Testability
**High.** Clear checklist.

### 8. Handling of Intent's Open Questions
Addresses all questions. Also opts for Deno and Compose-in-job.

### Strongest Ideas
- **Canonical Request Hashing:** Sorting JSON keys for chat completion fixtures (Section 3.4) is a much more reliable way to match requests than Claude's substring matching.
- **Explicit Environment Contract:** Section 3.3 defines a clear set of `MEMEX_TEST_*` environment variables that later sprints can rely on.

### Weaknesses/Gaps
- **Determinism Verification:** The verification plan relies on in-process tests. If the Deno service uses an internal cache, the test could pass while the service remains non-deterministic across restarts.
- **Compose Version Sensitivity:** Does not account for the absence of `--wait` in older Compose v2 binaries.
- **Vector Enumeration:** Lists the *types* of vectors but doesn't provide the specific inputs/outputs as clearly as Claude does in Phase 2.

### Recommendations
- Adopt Claude's manual `diff` check for determinism.
- Use Claude's wait-for polling logic to ensure compatibility with older Docker Compose versions.
- Combine the "Canonical Request Hashing" logic with Claude's detailed vector list.

---

## Summary Comparison

| Feature | Claude Draft | Codex Draft | Winner |
|---|---|---|---|
| **Determinism** | SHA-256 expansion + manual diff check | SHA-256 block expansion | **Claude** (for the diff check) |
| **Chat Fixtures** | Substring match | Canonical JSON hashing | **Codex** |
| **Portability** | `wait-for.sh` helper | Relies on `compose --wait` | **Claude** |
| **Vector Coverage** | Explicit list of ~22 cases | Count-based (24 cases) | **Claude** (for specificity) |
| **CI Approach** | Compose-in-job | Compose-in-job | **Tie** |
| **Risk Table** | Deep, technical | Standard | **Claude** |

### Final Recommendation

**The Claude draft is the superior plan for execution**, primarily due to its superior verification strategy (Section 5.b) and its defensive handling of Docker/Colima environment variances. However, the executor should **incorporate Codex's "Canonical Request Hashing"** (sorting JSON keys) for the mock service's chat completion endpoint, as it is a more robust implementation for that specific feature.

The executor should also pay special attention to Claude's "Open Question 9" regarding the empty string canonicalization, as this will set the precedent for the entire project's content handling.
