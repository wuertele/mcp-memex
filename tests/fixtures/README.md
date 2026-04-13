# Test Fixtures

`canonicalization-cases.json` is the shared cross-runtime corpus for the
content canonicalization rules in [memex-architecture.md](../../memex-architecture.md).
Each entry is an object with:

- `name`: stable test case id
- `rule`: rule bucket for smoke-test coverage assertions
- `input`: raw content before canonicalization
- `expected`: canonicalized content after applying the Section 6.4 rules

The fixture file is kept as pure ASCII JSON. Unicode inputs and expected
values use `\uXXXX` escapes so the corpus stays editor-safe and consistent
across platforms.

NUL bytes are intentionally out of scope. PostgreSQL `text` columns cannot
store `\u0000`, so a NUL-bearing fixture would not round-trip through the
Sprint 001 SQL trigger tests that also consume this corpus.
