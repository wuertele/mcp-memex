# Sprint 000 Pre-Round Validation (Round 1)

Pre-review validation run by the orchestrator. This document captures
what could and could not be verified automatically on the operator's
workstation before reviewers run.

## Environment

- Host: macOS (Darwin 25.3.0)
- Python: 3.12.3
- Bash: 3.2.57 (system)
- Ruby: 2.6.10 (system)
- Deno: **NOT INSTALLED**
- Colima: **NOT INSTALLED**
- Docker CLI: present at `/usr/local/bin/docker`
- Docker daemon: **NOT REACHABLE** (expected — Colima is not installed/running)

## Commands Run

### 1. Repo state

```
$ cd /Users/dave/mcp-memex && ls tests/ .github/ deno.json
deno.json
.github/: workflows
tests/: compose.yaml fixtures integration lib mock-inference README.md run-tests.sh unit
```

**Result:** All sprint 000 deliverable directories and top-level files are
present. Repository matches the layout specified in SPRINT-000.md Section 3.2.

### 2. Bash syntax check

```
$ bash -n tests/run-tests.sh && echo "run-tests.sh: syntax ok"
$ bash -n tests/lib/wait-for.sh && echo "wait-for.sh: syntax ok"
```

**Result:**
- `tests/run-tests.sh`: syntax ok
- `tests/lib/wait-for.sh`: syntax ok

### 3. JSON validity

```
$ python3 -c "import json; [json.load(open(f)) for f in [...]]"
```

**Result:**
- `tests/fixtures/canonicalization-cases.json`: JSON ok
- `tests/mock-inference/fixtures/chat.json`: JSON ok
- `tests/mock-inference/fixtures/embeddings.json`: JSON ok
- `tests/mock-inference/deno.json`: JSON ok
- `deno.json`: JSON ok (repository root)

### 4. YAML validity

```
$ ruby -e 'require "yaml"; YAML.load_file(...)'
```

**Result:**
- `tests/compose.yaml`: YAML ok
- `.github/workflows/test.yml`: YAML ok

### 5. Canonicalization fixture structure

```
$ python3 -c "parse canonicalization-cases.json and check invariants"
```

**Result:**

- Total cases: **22** (meets the ≥22 requirement from the sprint plan)
- Unique rules present: `['bom-stripping', 'boundary', 'combined', 'crlf-to-lf', 'internal-whitespace', 'nfc', 'no-op', 'trailing-newline-collapse']`
- Required rule-coverage sentinels present: bom-stripping ✓, crlf-to-lf ✓, trailing-newline-collapse ✓, nfc ✓, internal-whitespace ✓, boundary ✓
- Required boundary cases present: `empty-string-boundary` ✓, `single-newline-idempotent` ✓, `whitespace-only-content` ✓
- All entries have required `{name, rule, input, expected}` fields
- All `name` values are unique

**Note:** Reviewers should spot-check that each `expected` value actually
matches the canonicalization rules in memex-architecture.md Section 6.4.
Automated structural validation alone does not verify semantic correctness.

### 6. Docker daemon reachability

```
$ docker info >/dev/null 2>&1
$ echo $?
1
```

**Result:** Docker daemon is not reachable (expected — Colima is not
installed on the host). This blocks all dynamic validation of the
Compose stack.

### 7. Deno availability

```
$ which deno
(not found)
```

**Result:** Deno is not installed. This blocks running `deno test`
against the smoke test and blocks starting the mock inference service
outside Docker.

## What Could NOT Be Validated

The following checks from the sprint's Verification Plan (Section 5.1)
could not be executed by the orchestrator because Colima/Docker and
Deno are not installed on the workstation:

- **Automated Check #1**: `docker compose ... config` — docker daemon not reachable
- **Automated Check #2**: pre-flight port availability (would only fire if runner started)
- **Automated Check #3**: docker info preflight (fails as expected; runner short-circuits before any compose calls)
- **Automated Check #4**: clean startup and teardown
- **Automated Check #5**: PostgreSQL readiness (container-internal)
- **Automated Check #6**: PostgreSQL readiness (host port binding via TCP connect)
- **Automated Check #7**: mock service readiness (host curl)
- **Automated Check #8**: `/health` endpoint contract
- **Automated Check #9**: embedding golden fixture replay
- **Automated Check #10**: embedding determinism (in-process)
- **Automated Check #11**: embedding determinism (out-of-process `curl | diff`)
- **Automated Check #12**: embedding dimensionality (1536 + unit-length)
- **Automated Check #13**: embedding variation across inputs
- **Automated Check #14**: `__fail_embed__` trigger
- **Automated Check #15**: `__slow_embed__` timing
- **Automated Check #16**: chat fixture replay
- **Automated Check #17**: chat missing-fixture hash
- **Automated Check #18**: canonicalization fixture well-formedness (partial — structural check passed but smoke test could not run)
- **Automated Check #19**: CI parity (can only be verified by pushing to GitHub)
- **Automated Check #20**: CI timeout guard (ditto)
- **Automated Check #21**: fork-safe CI (ditto)

## What Static Verification Covers

For the checks that could not run dynamically, the executor ran static
verification of the committed handler code by importing the request
handler into Node and invoking it directly (without binding a TCP
port). The executor report documents these direct verifications:

- Health handler returned the expected JSON shape
- Embedding handler returned 1536-dim unit vectors (L2 norm within 1e-6)
- Same input → byte-identical responses
- Different inputs → different first elements
- `__fail_embed__` → 500 with structured error
- `__slow_embed__` → elapsed time 5006ms (confirmed ≥4500ms and <15000ms)
- Chat handler replayed 2 fixtures successfully
- Chat missing-fixture returned 400 with 64-char hex `request_hash`

These static verifications confirm the handler logic matches the spec
but do not confirm the full Docker/Deno runtime path works
end-to-end. That confirmation requires Colima and Deno to be
installed, which is a post-review operator task.

## Recommendation to Reviewers

Evaluate the committed code against the sprint plan, paying special
attention to:

1. Whether the embedding algorithm implementation in
   `tests/mock-inference/main.ts` matches the pinned byte-layout
   specification in SPRINT-000.md Section 3.4 exactly
2. Whether the canonicalization test vectors in
   `tests/fixtures/canonicalization-cases.json` actually match the
   Section 6.4 rules (semantic correctness, not just structural
   well-formedness)
3. Whether the runner script's preflight checks, trap cleanup, and
   wait-for logic are correct (bash syntax passes but semantics need
   review)
4. Whether the CI workflow's Deno setup step will produce a working
   environment for `./tests/run-tests.sh`
5. Whether golden fixtures in `embeddings.json` could have been
   produced by the committed algorithm given the algorithm's byte
   layout (no Deno runtime is available to regenerate and diff,
   but the algorithm is deterministic enough that reviewers can
   reason about whether any specific golden value looks plausible)

Reviewers should treat dynamic-verification gaps as "blocked by missing
prerequisites, not by implementation flaws" unless they find a specific
reason to believe the code would fail if the prerequisites were
installed.
