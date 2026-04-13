# Review: Sprint 000 - Round 1 (claude)

## Plan Adherence

All eight phases described in SPRINT-000.md Section 4 are present:

- Phase 1 skeleton: `tests/integration/.gitkeep` exists; no `migrations/`, `mcp-server/`, or `sync-daemon/` directories were created.
- Phase 2: `tests/fixtures/canonicalization-cases.json` with 22 entries plus `tests/fixtures/README.md`.
- Phase 3: `tests/mock-inference/main.ts` and `tests/mock-inference/deno.json`.
- Phase 4: `tests/mock-inference/Dockerfile`, `chat.json`, `embeddings.json`, fixtures README.
- Phase 5: `tests/compose.yaml`.
- Phase 6: repo-root `deno.json` and `tests/unit/smoke.test.ts`.
- Phase 7: `tests/run-tests.sh` (executable) and `tests/lib/wait-for.sh`.
- Phase 8: `.github/workflows/test.yml` and `tests/README.md`.

The only deviation from the plan is that per-phase commits did not happen; the executor documented this as a sandbox-imposed blocker (`.git/index.lock` EPERM). Orchestrator can commit the whole thing as one unit. No tasks were skipped.

## Implementation Quality

The code is readable, narrowly scoped, and stays within Sprint 000's deliberate "no application code" boundary. `tests/mock-inference/main.ts` is organized as pure helper functions plus an exported `createApp()` factory, which makes it straightforward for Node-side static verification to exercise the handler without touching `Deno.serve`. Error paths are consistent (`errorResponse` wrapper), logging is structured, and the chat fixture index is built at startup rather than per-request. Good separation.

One minor readability note: `main.ts` is authored as plain JS with a `.ts` extension — no type annotations on parameters. Deno will accept this, but the file advertises itself as TypeScript and later sprints will likely add types here. Not blocking for Sprint 000.

The smoke test uses `@std/assert` only, no helper libraries, matches the plan's intent. The one-shot `withTimeout` wrapper for `__slow_embed__` is cleaner than relying on Deno's per-test sanitizer config.

## System Impact

### Pinned Spec Compliance

Traced the embedding algorithm in `tests/mock-inference/main.ts` line-by-line against SPRINT-000.md Section 3.4:

- Step 1 (seed = SHA-256 of UTF-8 input): `sha256Bytes(toUtf8Bytes(inputText))` at `embeddingVectorForInput` line 103. Correct.
- Step 2 (expand to 6144 bytes via 192 blocks of `SHA-256(seed || u32_be(counter))`): `expandSeed()` lines 89-100. Loop runs 0..192 exclusive; each block writes 32 bytes at `counter * 32`; counter is encoded via `encodeU32Be` which uses `>>> 24, >>> 16, >>> 8, & 0xff` in big-endian order. Output is `EXPANSION_BLOCKS * 32 = 6144` bytes. Correct.
- Step 3 (1536 floats, big-endian u32 at offset `i*4`, mapped `(u / 4294967295.0) * 2.0 - 1.0`): lines 108-114 use `DataView.getUint32(index * 4, false)` where `false` means big-endian. Mapping formula matches spec exactly. Correct.
- Step 4 (L2 normalize): lines 116-119. Correct.
- Step 5 (default JSON serialization): `jsonResponse` uses `JSON.stringify(body)` with no replacer/spacing. Correct.

Embedding algorithm is byte-exact against the pinned spec.

Canonical JSON hashing for chat: `canonicalizeJsonValue` recursively sorts object keys and preserves array order. `stableStringify = JSON.stringify(canonicalize(value))` — no whitespace. `requestHashHex` = SHA-256 hex of UTF-8 bytes of that string. Both startup indexing (`buildChatFixtureIndex`) and per-request lookup (`/chat/completions` handler) call the same `requestHashHex`. Key-order invariance is preserved. Correct.

`tests/fixtures/canonicalization-cases.json` spot-check:

- `nfd-to-nfc-accented`: input `"Cafe\u0301\n"` (C-a-f-e + combining acute) → expected `"Caf\u00e9\n"` (precomposed é U+00E9). U+00E9 is the canonical NFC form of `e + U+0301`. Correct.
- `nfd-plus-crlf-combined`: `"Cafe\u0301\r\n"` → `"Caf\u00e9\n"`. CRLF→LF and NFC both applied. Correct.
- `empty-string-boundary`: `""` → `"\n"`. Matches Section 6.4's empty-string rule (trailing newline ensured).
- `single-newline-idempotent`: `"\n"` → `"\n"`. Correct.
- `whitespace-only-content`: `"   \n   "` → `"   \n   \n"`. Trailing newline added, internal whitespace preserved. Correct.
- `cr-to-lf`: `"a\rb\rc\n"` → `"a\nb\nc\n"`. Lone CR handled. Correct.
- `beyond-bmp`: U+1D11E (G-clef) surrogate pair preserved through NFC. Correct (no canonical decomposition for this codepoint).
- `very-long-content`: 10000 'a's + `\n` → same. Input length = 10001 matches. Correct.

No NUL-byte vectors present (aligned with operator decision), and `tests/fixtures/README.md` documents the out-of-scope rationale. 22 entries meets the minimum. All six required rule buckets covered.

### Runner Script Correctness

`tests/run-tests.sh`:

- `set -euo pipefail` ✓
- Preflight: `require_command docker`, `require_command deno`, `docker compose version`, `docker info`, port availability via `(: >/dev/tcp/127.0.0.1/PORT)` probe ✓
- Compose invoked as array `(docker compose -p memex-test -f tests/compose.yaml)` so `-p memex-test` is always present ✓
- Trap: `trap cleanup EXIT` plus separate `trap handle_signal INT TERM` that calls `cleanup` then `exit 130`. The `cleanup_done` guard prevents double-teardown when both signal and EXIT fire. Fires on EXIT, INT, and TERM as required ✓
- Pre-run cleanup: `"${COMPOSE[@]}" down -v --remove-orphans` before first `up` ✓
- `config` validation before `up` ✓
- `up -d --build --wait` with `COMPOSE_HTTP_TIMEOUT=120` ✓
- Sources `wait-for.sh` and calls `wait_for_http http://127.0.0.1:58000/health 60` ✓
- PostgreSQL belt-and-suspenders via `pg_isready -U memex_test -d memex_test` polling (60s) ✓
- Exports `MEMEX_TEST_*` variables BEFORE `deno task test` ✓
- On failure, dumps `$COMPOSE logs --no-color` before trap-driven teardown ✓
- Clear operator-facing error message for unreachable Docker pointing at `colima start` ✓

Port collision check is a real `bash /dev/tcp` probe, not a stub. Docker info check short-circuits with a clear message. Environment variables are exported on lines 88-93 before `deno task test` on line 96.

One minor nit: banner set lacks an explicit `[run-tests] preflight done` / `[run-tests] OK` pair symmetry, but `[run-tests] OK` is printed on success and `[run-tests] FAILED` on failure. Not blocking.

### Smoke Test Coverage

All Phase 6 test cases are present in `tests/unit/smoke.test.ts`:

- `pg reachable from host` — uses `Deno.connect({ hostname: "127.0.0.1", port: 55432, transport: "tcp" })`. Matches plan.
- `mock /health` — asserts 200, `status`, `service`, `version`.
- `mock /embeddings golden replay` — loads `embeddings.json`, replays each fixture, deep-equals response.
- `mock /embeddings deterministic` — sends same request twice, deep-equals bodies, asserts 1536 length and `|norm - 1| < 1e-6`.
- `mock /embeddings varies by input` — sends two different inputs, asserts `firstVector.some((v, i) => v !== secondVector[i])`.
- `mock __fail_embed__` — asserts 500 and error type.
- `mock __slow_embed__` — wraps in 20s timeout, asserts **both** `elapsed >= 4500` AND `elapsed < 15000`. Two-sided bound. Correct.
- `mock /chat/completions golden replay` — replays chat fixtures.
- `mock /chat/completions missing fixture` — asserts 400, 64-char hex request_hash.
- `canonicalization fixture well-formed` — array, ≥22 entries, required fields, unique names, rule-coverage sentinels, required boundary cases by name.

Determinism test: sends the **same** request (not two different requests). Correct.
Variation test: asserts inequality on at least one element via `.some(...)`. Correct.
PostgreSQL TCP check: uses `127.0.0.1` and `55432` via env-var default. Correct.
Slow-embed test: two-sided bound. Correct.

Coverage is complete.

### Dockerfile and Compose

`tests/mock-inference/Dockerfile`:

- `FROM denoland/deno:alpine-2.1.4` — specific minor version pinned ✓
- `RUN deno cache main.ts` at build time — container starts offline ✓
- `EXPOSE 8000` ✓
- `CMD ["run", "--allow-net", "--allow-read", "--allow-env", "main.ts"]` ✓

`tests/compose.yaml`:

- No top-level `version:` field ✓
- `postgres`: `pgvector/pgvector:pg16`, bound to `127.0.0.1:55432:5432` (localhost only) ✓
- Postgres healthcheck uses `pg_isready -U memex_test -d memex_test` (not default user) ✓
- `mock-inference`: `build: ./mock-inference`, bound to `127.0.0.1:58000:8000` (localhost only) ✓
- Mock healthcheck: `wget -qO- http://localhost:8000/health || exit 1`. `denoland/deno:alpine` is Alpine-based and includes BusyBox wget, so this will resolve in-container. (Not dynamically verifiable here; acceptable.)
- Named network `memex-test-net` ✓
- Anonymous volume for Postgres data path ✓

All compose requirements from the plan are met.

### CI Workflow

`.github/workflows/test.yml`:

- Triggers on `push:` and `pull_request:` (both present) ✓
- `permissions: contents: read` ✓
- `timeout-minutes: 10` ✓
- Runs on `ubuntu-latest` ✓
- Uses `actions/checkout@v4` and `denoland/setup-deno@v1` with `deno-version: 2.1.4` ✓
- Invokes `./tests/run-tests.sh` directly — no reimplementation ✓
- No `secrets.` references — fork-safe ✓

The YAML uses `"on":` (quoted key) which is a common workaround for YAML 1.1 parsers treating unquoted `on` as a boolean. GitHub Actions accepts this. Acceptable.

### Verification Gap Audit

Static verification ran the handler via Node's `--experimental-strip-types`, which cannot exercise:

1. **`Deno.serve` lifecycle and signal handling.** The handler factory is tested in isolation, but the top-level `Deno.serve({ port }, createApp(...))` call, the `import.meta.main` branch, and environment-based port selection were never executed. Severity: low — this is a small amount of boilerplate, and any failure would surface immediately on first live run.
2. **`Deno.connect` to PostgreSQL host port.** The TCP connect test in `smoke.test.ts` can only succeed once Compose is up; this exercises the full host port binding path that is Sprint 000's main Section 5.1 Check #6. Severity: medium — not runnable without Colima, but the code shape is trivially correct.
3. **Docker network-interface binding semantics.** `127.0.0.1:55432:5432` and `127.0.0.1:58000:8000` cannot be validated without running the Compose stack. Severity: medium.
4. **Compose `--wait` and container healthcheck interplay.** Whether the BusyBox `wget` in `denoland/deno:alpine` actually runs inside the built image was not verifiable. Severity: low-medium.
5. **Trap/signal cleanup on Ctrl-C.** Manual Phase 7 Task 5 (SIGINT mid-run) was not executed. Severity: low — shell logic is straightforward and reviewable.
6. **`deno task test` end-to-end.** Neither the import map resolution (`jsr:@std/assert@1.0.13`) nor the `--allow-*` permission set were runtime-validated. Severity: low — standard Deno idioms.
7. **GitHub Actions runtime.** Only YAML parse-validated. Severity: low — the workflow is a three-step shell-out.

Of the seven gaps above, the most consequential is #3 (host port binding) because later sprints will assume `127.0.0.1:55432` is reachable. That single gap is blocked by the orchestrator's missing Colima, not by anything in the reviewed code. The static-only approach used by the executor is sufficient to trust the code given that a live run is a post-review operator task and all static signals (handler verification, byte-exact algorithm trace, fixture structural validation, shell syntax check, YAML/JSON parse, TypeScript type-check via Node strip-types) point the same direction.

No verification gap rises to [P1] or [P2].

### Deviations and Blockers

All four blockers (Docker daemon unreachable, Deno not installed, git commits blocked by sandbox, local TCP listener blocked by sandbox) are codex-sandbox limitations. The executor's workarounds are reasonable:

- For missing Deno/Docker: imported the request handler into Node via `--experimental-strip-types` and exercised it directly. This validates the handler code but not the Deno/Docker transport path.
- For blocked local listener: could not regenerate `embeddings.json` via a live HTTP round-trip. The fixture was instead populated from direct handler invocation. Because the committed algorithm is deterministic and the handler's JSON.stringify path is the same one used at runtime, this is acceptable as long as the first live run replays cleanly. If it does not, the fix is mechanical (regenerate from live service).
- For blocked git commits: per-phase commits were skipped. Orchestrator can make a single commit post-review.

These deviations do not compromise the sprint's foundation for later sprints.

## Required Fixes

None.

## Verdict
PASS
