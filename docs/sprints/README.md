# Sprints

This directory tracks the lifecycle of development sprints for mcp-memex.
It mirrors the sprint system used in the Mycofu home-infrastructure
repository.

## Layout

- `ledger.tsv` — canonical record of all sprints and their states.
  The file is TSV with columns: `sprint_id`, `title`, `status`,
  `created_at`, `updated_at`.
- `ledger.py` — CLI for managing the ledger (see usage below).
- `SPRINT-NNN.md` — one narrative document per sprint, matching an
  entry in the ledger. Created manually when a sprint is planned.
- `drafts/` — scratch space for early sprint planning that hasn't
  been formalized yet. Not tracked by the ledger.

## Sprint Lifecycle

Each sprint moves through states in the ledger:

```
planned → in_progress → completed
               ↓
            skipped
```

A sprint can transition to `skipped` from any non-terminal state.

## CLI Usage

All commands run from the repository root so the ledger path is
resolved correctly:

```bash
# Show summary statistics
python3 docs/sprints/ledger.py stats

# Show the sprint currently in progress (if any)
python3 docs/sprints/ledger.py current

# Show the next planned sprint
python3 docs/sprints/ledger.py next

# Add a new sprint
python3 docs/sprints/ledger.py add 001 "Initial MCP Server Scaffold"

# Transition a sprint to in_progress
python3 docs/sprints/ledger.py start 001

# Transition a sprint to completed
python3 docs/sprints/ledger.py complete 001

# Transition a sprint to skipped
python3 docs/sprints/ledger.py skip 001

# List all sprints (optionally filter by status)
python3 docs/sprints/ledger.py list
python3 docs/sprints/ledger.py list --status planned

# Rediscover sprints from SPRINT-*.md files and add any missing entries
python3 docs/sprints/ledger.py sync
```

## Conventions

- **Sprint IDs** are zero-padded to three digits (`001`, `002`,
  `017`, etc.) and allocated sequentially.
- **Sprint titles** are short descriptive phrases, no trailing
  punctuation.
- **Narrative documents** (`SPRINT-NNN.md`) contain the full sprint
  description, motivation, plan, validation criteria, and completion
  report. The ledger is a summary view; the document is the record
  of what was intended and what happened.
- **Draft ideas** live in `drafts/` until they are promoted to a
  real sprint. The ledger does not track drafts.
