# Migrations

Sprint 001 introduces a forward-only PostgreSQL migration set for the
schema defined in `memex-architecture.md` Section 6.

## Files

Migrations live in lexical version order:

- `0001_initial_schema.sql`
- `0002_add_ob_uuid.sql`
- `0003_add_source_column.sql`
- `0004_add_content_fingerprint.sql`
- `0005_add_updated_at.sql`
- `0006_add_thought_relations.sql`
- `0007_add_sync_log.sql`
- `0008_add_sync_state.sql`
- `0009_add_roles.sql`

## Manual Apply

For manual application without the runner, connect to the target database
and run the files in order:

```bash
psql postgresql://USER:PASSWORD@HOST:PORT/DBNAME -f migrations/0001_initial_schema.sql
psql postgresql://USER:PASSWORD@HOST:PORT/DBNAME -f migrations/0002_add_ob_uuid.sql
# ...
psql postgresql://USER:PASSWORD@HOST:PORT/DBNAME -f migrations/0009_add_roles.sql
```

The SQL files are declarative schema deltas. They are not rollback
scripts, and they should not be reordered.

## Runner Usage

The supported entrypoint is `scripts/memex-migrate`:

```bash
./scripts/memex-migrate
```

The runner:

- discovers `NNNN_*.sql` files from `migrations/` by default
- records successful versions and SHA-256 checksums in
  `schema_migrations`
- validates previously applied checksums before doing new work
- applies each pending migration in its own transaction

Test-only overrides:

- `MEMEX_MIGRATE_DIR` changes the runner's migration read path
- `MEMEX_MIGRATE_MAX` stops after the named version
- `PSQL` overrides the PostgreSQL client command

## Failure Recovery

This migration set is forward-only. If a migration fails:

1. Earlier successful migrations remain applied.
2. The failing version is not recorded in `schema_migrations`.
3. The operator fixes the underlying issue and reruns the runner.

Checksum drift is treated as an integrity failure. Restore the expected
migration file or start from a fresh database if history was changed
intentionally.

## Additive-Only Rule

Sprint 001 follows the additive-only schema rule from the architecture:

- no destructive DDL
- no rollback scaffolding
- no startup-time auto-apply coupling

Later schema changes should arrive as new numbered migrations rather than
edits to already-applied history.

## Test Password Policy

`0009_add_roles.sql` uses the explicit disposable test literals
`'memex_mcp_test_password'` and `'memex_sync_test_password'` for the
Sprint 001 test environment. They are not placeholder values and are
not deployment credentials. Real deployments must provision different
secrets outside this repository.
