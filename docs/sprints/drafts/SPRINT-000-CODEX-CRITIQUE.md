# Sprint 000 Draft Critique (Codex)

## Overall Judgment

The **Claude draft is the stronger starting point**. It treats Sprint
000 as real platform work instead of paperwork, and its verification
plan is much closer to the quality bar implied by `ROADMAP.md`.

The **Gemini draft is cleaner and probably easier to execute in 2-3
days**, but it is too thin in the places that matter most for a
foundation sprint: canonicalization vectors, mock-service contract,
failure-mode verification, and CI details.

My recommendation is:

- Use **Claude** as the base.
- Cut unnecessary contract surface and fix a few concrete technical
  problems before execution.
- Borrow Gemini's restraint on optional extras.

One cross-draft note: both drafts silently omit the **local bare git
remote** described in the roadmap's Testing Strategy. I would not force
that into Sprint 000's smoke test, but the chosen plan should say
explicitly that it is deferred until a later sprint rather than leaving
the platform story ambiguous.

## Claude Draft

### 1. Architectural soundness

Mostly sound. The draft uses one Compose stack for local and CI, keeps
the mock inference service deterministic and offline, and treats the
canonicalization fixture as a cross-implementation contract. Those are
the right architectural instincts for Sprint 000.

The main problem is that it adds too much contract surface that the
roadmap does not require. The roadmap asks for a minimal mock and a
fixture file of `{input, expected}` pairs. Claude turns that into a
larger protocol with extra schema fields, selector semantics, extra
helper scripts, debug flags, and additional config files. Some of that
is useful; some of it is just more future compatibility burden.

There are also two real technical flaws in the proposed design:

- The plan says `tests/deno.json` will exist, but the runner executes
  `deno test` from the repo root without `--config tests/deno.json`.
  That config would not reliably be picked up.
- The runner says it will use `docker compose up ... --wait` and then
  fall back to explicit polling if `--wait` is absent. That fallback
  does not work as written; if `--wait` is unsupported, the command
  fails before the fallback runs.

### 2. Completeness against `ROADMAP.md` Sprint 000 scope

Very complete on the required deliverables. It covers:

- `tests/compose.yaml`
- `tests/mock-inference/` plus `Dockerfile`
- `tests/fixtures/canonicalization-cases.json`
- `tests/run-tests.sh`
- `.github/workflows/test.yml`
- `tests/README.md`
- `tests/unit/smoke.test.ts`

It also covers the roadmap validation items better than the roadmap
itself does.

The main completeness issue is not omission; it is **deviation**:

- The roadmap says canonicalization cases are `{input, expected}`.
  Claude changes the schema to `{name, rule, input, expected}`. That is
  not obviously wrong, but it is a spec change, not just a plan detail.
- The roadmap says the mock service is deliberately minimal. Claude
  pushes it toward a fuller contract test surface than Sprint 000
  strictly needs.

### 3. Phasing and ordering

Good overall. The order is rational: fixture first, mock service,
compose, smoke test, runner, then CI and docs.

One minor issue: Phase 1/2/3 are split more finely than necessary for a
2-3 day sprint. That is not harmful, but it does signal a plan that is
optimized for thoroughness over speed.

### 4. Risk coverage

Strong. This is where the draft is best.

It explicitly covers:

- deterministic embedding verification
- stale stack cleanup
- SIGINT teardown
- GitHub Actions fork PR behavior
- Colima vs Docker Desktop context handling
- `pull_request` vs `pull_request_target`
- runtime offline behavior
- port overrides

The best risk callout is the insistence on an **out-of-process
determinism check**. That is exactly the kind of failure mode a
foundational test platform should guard against.

The weak spot is canonicalization-case design: the proposed
`null-byte-preserved` vector is a bad fit for a shared fixture that
Sprint 001 must use against PostgreSQL text. PostgreSQL cannot store NUL
bytes in `text`, so this case would either become untestable in SQL or
force annoying per-runtime exceptions.

### 5. Feasibility in 2-3 days

Borderline. The draft is achievable if execution is disciplined, but it
is no longer a "minimal scaffolding" sprint. The amount of manual
verification, optional hardening, and extra file surface makes it easy
to spill past the estimate.

The time risks are:

- too many manual validation steps
- extra helper/config files that are not strictly required
- scope drift in the mock service
- trying to solve future ergonomics (`--no-teardown`, env-overridable
  ports, concurrency-grouping, lockfiles) before later sprints need them

### 6. Verification plan quality

Excellent, with a few overreaches.

This draft has the best verification plan of the two by a large margin.
The checks are specific, actionable, and likely to catch real
regressions. In particular it correctly verifies:

- `/embeddings` determinism
- embedding shape and norm
- batch-order behavior
- `__fail_embed__`
- `__slow_embed__`
- `/chat/completions` default and selector path
- canonicalization fixture parseability and rule coverage
- cleanup behavior
- CI behavior

Two caveats:

- It relies on rule tags and a minimum count to prove canonicalization
  coverage. That is useful, but the real value is in the actual
  contents. A bad vector set can still satisfy ">= 20 cases" and "all
  tags present."
- Some checks are stronger than Sprint 000 needs. That is mostly fine,
  but it contributes to the feasibility problem.

### 7. Definition of Done testability

Very good. Most DoD items are directly observable and independently
testable.

The weaker DoD items are the ones that depend on awkward simulation
rather than an ordinary sprint close-out:

- "fork-PR simulation" is more ceremony than value for Sprint 000
- "image builds offline after first `deno cache`" is extra scope, not a
  core acceptance criterion

### 8. Handling of the intent's open questions

This draft handles the intent's open questions better than Gemini's.

- **Smoke test language:** answered clearly in favor of Deno.
- **CI approach:** answered clearly in favor of compose-in-job.
- **Canonicalization coverage:** answered with a specific case list.
- **Compose `version:` key:** handled correctly; omit it.
- **Ports 58000 / 55432:** handled pragmatically with defaults and
  overrides.
- **Fork PRs:** handled correctly; no secrets, no `pull_request_target`.
- **Runner concurrency:** handled correctly; keep it serial.

It also raises additional open questions where the seed is genuinely
underspecified, especially around empty-string canonicalization. That is
useful.

### Strongest ideas

- The out-of-process determinism check is the single best idea in either
  draft.
- Using the same Compose path locally and in GitHub Actions is the right
  CI choice for this sprint.
- The draft takes canonicalization vectors seriously as a shared
  contract, not just a JSON file.
- Colima-specific risk handling is concrete instead of hand-wavy.
- The smoke test actually behaves like a platform smoke test.

### Weaknesses and gaps

- Too much scope for a 2-3 day sprint.
- Changes the canonicalization fixture schema from the roadmap's
  `{input, expected}` contract without justification.
- Includes at least one bad vector candidate (`null-byte-preserved`)
  that will not round-trip through PostgreSQL `text`.
- The `tests/deno.json` plan is technically inconsistent with the
  runner command.
- The `--wait` fallback story is technically wrong as written.
- Adds optional ergonomics that are nice to have, not foundational.

### Concrete recommendations

- Keep the draft's verification rigor, but trim the implementation
  surface.
- Revert the canonicalization fixture to the roadmap contract:
  `{input, expected}` only. If you want labels, keep them in comments in
  the sprint doc, not in the fixture schema.
- Drop the NUL-byte vector from Sprint 000.
- Fix the Deno config story: either use a repo-root `deno.json` or pass
  `--config`.
- Fix the Compose readiness story: either detect `--wait` support before
  using it, or skip `--wait` entirely and rely on explicit polling.
- Keep the manual determinism diff, SIGINT cleanup check, and CI/fork-PR
  handling. Those are worth the time.
- Cut lower-value extras like offline image-build guarantees and fork-PR
  simulation if the sprint starts to slip.

## Gemini Draft

### 1. Architectural soundness

Sound at a high level, but too underspecified for a foundation sprint.

The big architectural choices are correct:

- use Compose
- use `pgvector/pgvector:pg16`
- use a deterministic offline Deno mock
- run the same test runner in CI

The problem is that the draft leaves too many details open in places
where later sprints need a stable contract. Canonicalization vectors,
mock API behavior, and verification expectations are all described too
loosely.

### 2. Completeness against `ROADMAP.md` Sprint 000 scope

Partially complete. The draft includes most of the named deliverables,
but it does not fully cover the required behavior.

The biggest scope gaps are:

- `/chat/completions` is mentioned, but not meaningfully specified or
  verified.
- `__slow_embed__` is called out in use cases, but not carried through
  into the smoke-test tasks or DoD.
- The roadmap validation requires the compose environment to expose
  services on `127.0.0.1:55432` and `127.0.0.1:58000`; the draft does
  not make that binding explicit.
- The workflow summary says "run `./tests/run-tests.sh`" but does not
  mention installing Deno, which is required on GitHub Actions.

### 3. Phasing and ordering

Good. The phase order is simple and credible.

This is one place where Gemini beats Claude: it does not bury the sprint
under too much phase ceremony.

### 4. Risk coverage

Thin.

It covers a few obvious operational risks:

- port collisions
- Deno version drift
- Colima not running
- mock/API divergence

But it misses or underplays several Sprint 000-specific risks:

- stale stack cleanup before reruns
- interrupted-run cleanup verification
- deterministic responses across separate processes
- incomplete canonicalization vector coverage
- GitHub Actions behavior for PRs from forks
- the temptation to let the mock accidentally reach the real network

### 5. Feasibility in 2-3 days

Good. This draft is the safer one on schedule.

The problem is that it is feasible partly because it punts details that
need to be decided now. That is fine for a feature spike, not for a
platform sprint whose artifacts become cross-sprint dependencies.

### 6. Verification plan quality

Weak to moderate.

The checks are not bad; they are just not complete enough.

What it does well:

- local full-run check
- manual determinism diff
- fixture parseability check

What it misses:

- no explicit `/chat/completions` verification
- no explicit `__fail_embed__` or `__slow_embed__` coverage in the
  smoke test
- no explicit check that embeddings are length 1536
- no check for byte-identical JSON bodies
- no check that services are bound to `127.0.0.1`
- no check for cleanup on interruption
- no check that the canonicalization vectors cover all Section 6.4 rules
- no check that `pgvector` is actually available

For Sprint 000, that is too much missing coverage.

### 7. Definition of Done testability

Mixed.

Some DoD items are crisp:

- local runner exits 0
- GitHub Actions is green
- cleanup occurs

Others are vague or incomplete:

- "covers all rules in `memex-architecture.md` 6.4" is not testable
  unless the draft also defines what those cases are
- `tests/README.md` "correctly lists" prerequisites is subjective
- no DoD item for `/chat/completions`
- no DoD item for `__slow_embed__`
- no DoD item for port binding to `127.0.0.1`

### 8. Handling of the intent's open questions

Incomplete.

It answers only a subset:

- **Smoke test language:** answered, Deno.
- **CI approach:** answered, compose-in-job.
- **Deno version:** answered, pin it.

But it does not really handle:

- **Canonicalization vector count/coverage**
- **Compose `version:` key**
- **ports 58000 / 55432**
- **fork PR behavior**
- **runner concurrency**

For this prompt, that is a meaningful gap.

### Strongest ideas

- The plan stays close to the roadmap and does not invent much.
- The phase ordering is practical.
- The CI choice is right: use the same Compose path in CI and locally.
- The draft is likely to fit in the estimated 2-3 day window.

### Weaknesses and gaps

- Too underspecified for a platform sprint.
- Verification plan does not cover the full mock-service contract.
- Canonicalization vector coverage is far too loose given Section 6.4.
- CI workflow is incomplete as written because it does not mention Deno
  setup.
- Colima considerations are acknowledged but not operationalized.
- Open questions from the intent are only partially answered.

### Concrete recommendations

- Keep the draft's restrained scope, but import much more of Claude's
  verification discipline.
- Make the canonicalization vector set explicit. At minimum it needs
  cases for BOM stripping, CRLF normalization, exactly one trailing
  newline, leading-newline preservation, NFC normalization,
  markdown-significant trailing spaces, indentation preservation,
  internal whitespace preservation, emoji, and long content.
- Expand the smoke test to cover `/chat/completions`,
  `__fail_embed__`, `__slow_embed__`, embedding length 1536, and cleanup
  invariants.
- Flesh out the GitHub Actions job with actual setup steps, especially
  Deno installation.
- Add explicit handling for fork PRs, Compose `version:` omission, and
  serial runner execution.
- Add at least one manual or out-of-process determinism check; same
  input in one in-process test is not enough by itself.

## Final Recommendation

If I had to choose one draft to execute, I would choose **Claude** and
edit it down.

The right hybrid is:

- Claude's verification plan
- Claude's open-question handling
- Claude's attention to determinism, CI, Colima, and cleanup
- Gemini's tighter scope discipline

The wrong move would be to take Gemini as-is and discover in Sprint 001
that the "authoritative" fixture set and mock-service contract were not
actually specified tightly enough to prevent drift.
