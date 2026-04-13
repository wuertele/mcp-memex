# mcp-memex

A self-hosted personal knowledge management system that bridges a
human-editable markdown wiki and an LLM-accessible semantic database via
the Model Context Protocol (MCP).

## What It Is

Vannevar Bush's 1945 essay *"As We May Think"* described a hypothetical
device called the **memex** — a personal store of books, records, and
communications, associatively linked and searchable. Bush's memex was a
thought experiment; this project is one concrete realization of the
idea, 80 years later, built on modern primitives:

- A git repository of markdown files as the canonical store
- A PostgreSQL database with pgvector as a searchable index
- A sync daemon that keeps both representations consistent
- An MCP server that exposes the database to AI agents for semantic search
  and capture

The result is a knowledge store where **humans edit text files in git**,
**AI agents query and capture via MCP**, and both views stay in sync
automatically.

## What It Is Not

mcp-memex is not a note-taking application, a productivity tool, an LLM
chat frontend, or a content management system. It is specifically a
**bridge between a wiki and an MCP endpoint**. It does not try to be
Obsidian, Notion, Logseq, Todoist, or Anki.

It is also not a browser extension. A much older project named
[WorldBrain/Memex](https://github.com/WorldBrain/Memex) uses the term for
a web annotation tool; mcp-memex is a different kind of system that
happens to share Vannevar Bush's framing. The `mcp-` prefix in this
project's name disambiguates.

## Naming

"memex" (lowercase) is used throughout this project as a **common noun**
describing the class of system — an LLM-accessible personal wiki
database. The word is borrowed from Bush's 1945 concept and is not
trademarked by anyone.

This specific implementation is called **mcp-memex** because its
distinguishing feature is that it exposes a memex via the Model Context
Protocol to any MCP-capable AI client. Other implementations of a memex
are possible and welcome.

## Relationship to Open Brain (OB1)

mcp-memex builds on [Open Brain (OB1)](https://github.com/NateBJones-Projects/OB1)
as a foundation. Specifically, mcp-memex uses:

- OB1's `thoughts` table schema (extended additively)
- OB1's MCP protocol (same four tools with the same semantics)
- OB1's embedding model and metadata extraction approach

mcp-memex is **schema- and protocol-compatible with OB1**, which means
OB1 import recipes, OB1 dashboards, and OB1 skills all work against an
mcp-memex deployment. The MCP server itself is memex-native code, not a
fork of OB1, but it implements the same external interface.

mcp-memex is **not an OB1 wrapper or an OB1 integration**. It is a
standalone project that extends OB1's design in directions OB1 did not
go: git-backed canonical storage, bidirectional wiki sync, human
editing as a first-class write path, and explicit multi-user deployment.

Small improvements discovered while building mcp-memex (e.g., HNSW
vector index, `updated_at` column, role separation patterns) are
candidates for contribution back to OB1 as normal upstream PRs. mcp-memex
does not depend on any OB1 code running at runtime; it only depends on
OB1's schema shape and protocol contract.

## Status

**Pre-implementation.** This repository currently contains architecture
documentation only. The reference implementation has not been written
yet.

The design has gone through adversarial review by three independent
agents and is considered complete for MVP. See
[`memex-architecture.md`](memex-architecture.md) for the full design.

A reference Mycofu integration — how to deploy mcp-memex on a Mycofu
cluster — lives in a separate repository and is consumed as a
downstream adopter of mcp-memex rather than a component of it.

## Documentation

- **[memex-architecture.md](memex-architecture.md)** — the full
  architectural design, independent of any specific deployment target.

## License

MIT. See [LICENSE](LICENSE).

## Author

Dave Wuertele ([@wuertele](https://github.com/wuertele)), with
collaborative design input from Claude.
