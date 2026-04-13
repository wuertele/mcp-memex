# memex: Architecture

**Version:** draft 1 (split from memex-design.md draft 3)
**Last updated:** 2026-04-12
**Status:** pre-implementation, design locked for MVP
**Author:** Dave Wuertele, with collaborative design by Claude Opus 4.6

This document describes the architecture of a **memex** — an
LLM-accessible personal knowledge management system that uses git as
its canonical store and exposes content to AI agents via the Model
Context Protocol (MCP). It is deployment-independent: a reference
implementation (mcp-memex) can be built on any infrastructure that
provides PostgreSQL, git, and a reverse proxy with TLS.

This document covers **what a memex is and how it's designed**. It does
not specify how to deploy one on any particular platform. Deployment
guides are separate documents maintained by whichever adopter
implements the reference.

---

## 1. Purpose

A memex is a personal knowledge store that combines three things:

1. A **git-backed markdown wiki** that a human operator reads and edits
2. A **PostgreSQL + pgvector database** that an AI agent queries via MCP
3. A **sync daemon** that keeps those two representations consistent

Its purpose is to make the contents of a personal wiki accessible to AI
agents for semantic search, and to make AI-captured content available
to the human operator as human-readable wiki files — with git as the
canonical store for both directions.

A memex is not a note-taking application, not a productivity tool, not
an LLM chat frontend, and not a content management system. It is
specifically a connector: wiki content goes in one side, AI agents
query and capture on the other side, and the system keeps both in sync
through a single canonical git repository.

## 2. Philosophy

### 2.1 "memex" as a Common Noun

This document uses "memex" (lowercase) as a category name for this
class of system, not as a brand. The term is borrowed from Vannevar
Bush's 1945 essay *"As We May Think,"* which described a hypothetical
personal knowledge device that stored a person's books, records, and
communications with associative links between them. Bush's memex was
never built; the word entered the academic hypertext and personal
knowledge management literature as a concept rather than a product.

The intent is that "I have a memex" becomes parseable as "I have an
LLM-accessible personal wiki database" the way "I have a wiki" parses
as a category. Different people's specific implementations are each
"a memex." No brand name is claimed for the pattern.

Variants of a memex are distinguished by inference backend:

- **memex-R** — remote inference (a hosted API is called for embedding
  and metadata extraction)
- **memex-L** — local inference (an on-site model service handles
  embedding and metadata extraction)

### 2.2 Git as Source of Truth

The canonical store for all thought content is a git repository of
markdown files with YAML frontmatter. The PostgreSQL database is a
derived cache that can be rebuilt from the git repo at any time. This
principle has several consequences:

- The memex instance is **not precious state**. If the database or
  running VM is destroyed, it is recreated, the git repo is cloned,
  and the database is rebuilt by re-ingesting every file. No backup of
  the database is strictly required for correctness.
- Changes to the wiki are changes to git. Every edit — whether by the
  human operator or by an AI agent — produces a git commit. `git log`
  is the complete history of the memex.
- Rebuilding the memex with a different embedding model is a matter of
  updating the configuration and running the re-ingest job. The wiki
  content is unchanged.
- The memex cannot hold information that is not representable as
  markdown in git. This is a deliberate constraint that keeps the
  system simple and portable.

The "git is source of truth" invariant is operationally meaningful
only if it holds even in the brief window between an AI capture and
the sync daemon's next cycle. For this reason, the capture path writes
content to git **before** returning success to the MCP client (Section
5.1 and Section 9.2). Content that has been acknowledged to an AI
client is therefore always in git, never held in memory or in
PostgreSQL alone.

### 2.3 Personal Data Sovereignty

A memex stores private thought content. It is designed to keep that
content on infrastructure the operator controls. The database lives on
the operator's hardware. The git repo lives on the operator's git
host. The MCP endpoint accepts connections only from authenticated
clients on the operator's network. In memex-L mode, even the embedding
and metadata extraction stay on-premises; in memex-R mode, only
stateless API calls (not content retention) cross the network boundary.

The design explicitly supports air-gapped operation in memex-L mode.
memex-R mode requires internet access for inference but does not
require any hosted service to retain user content.

### 2.4 Relationship to Open Brain (OB1)

A memex builds on primitives from the
[Open Brain (OB1)](https://github.com/NateBJones-Projects/OB1) project.
OB1 is a community-maintained open-source project that defines a
schema for semantic search over captured thoughts, an MCP protocol
for AI clients to query and write that schema, and a set of import
recipes, dashboards, and extensions.

A memex is **schema- and protocol-compatible with OB1**. Specifically:

- A memex uses the OB1 `thoughts` table structure (from
  `OB1/integrations/kubernetes-deployment/k8s/init.sql`) as the
  baseline for its schema. A memex adds columns and tables beyond the
  baseline but never modifies or conflicts with it.
- A memex implements the four OB1 MCP tools (`search_thoughts`,
  `list_thoughts`, `thought_stats`, `capture_thought`) with identical
  semantics as seen from the client side. Any MCP client that works
  with an OB1 server also works with a memex.
- A memex uses the same embedding model and metadata extraction prompt
  conventions that OB1 uses, so captured thoughts are semantically
  interoperable.

A memex is **not an OB1 wrapper or an OB1 fork**. The reference memex
MCP server is memex-native code, written to match the OB1 protocol and
schema but not derived from OB1 source code. A memex adds layers that
OB1 does not currently include:

- Git-backed canonical storage with bidirectional sync
- Human editing as a first-class write path alongside AI capture
- Explicit conflict detection and resolution semantics
- Multi-user deployment and isolation
- Write-through capture for durability

These additions reflect a design philosophy that is complementary to,
not a replacement for, OB1's simpler database-centric model. OB1 is
the right tool for a user who wants AI-mediated personal memory with
minimal operational complexity. A memex is the right tool for a user
who additionally wants git as their canonical store, human authorship
as a primary path, and multi-user operation.

A memex may contribute specific improvements back to OB1 over time —
the `updated_at` column, the vector index, and similar generally
useful additions. These contributions flow from memex to OB1 as normal
upstream submissions from a related project, not as a merger of the
two projects. See Section 11 for the compatibility story.

### 2.5 Small and Focused

A memex does one thing: bridges a wiki to an MCP endpoint. It does not
try to also be Obsidian, Notion, Todoist, Anki, or a chat client.
Features that would pull it toward being a different kind of tool are
rejected even when individually valuable. The narrow mission is what
keeps the system understandable and maintainable.

Features that extend what the wiki can hold or what AI can do with
wiki content (task tracking, attachments, rollups, backlinks) are
candidates for future addition. Features that duplicate Obsidian's or
Notion's human-facing UX (canvas, graph view, spaced repetition) are
not.

This principle applies at the product boundary. The operational
boundary — PostgreSQL, pgvector, a server, a sync daemon, migrations,
a git host, secret management, TLS, and (optionally) a local
inference service — is larger than "small" implies and the design
does not claim otherwise. "Small and focused" means narrow scope, not
minimal moving parts.

## 3. Terminology

- **memex** — the category of system and, in context, a specific
  implementation. Lowercase, used with indefinite articles and
  plurals.
- **mcp-memex** — this specific reference implementation, which
  exposes a memex via the Model Context Protocol.
- **memex-R** — a memex running with remote inference (an external
  API provides embeddings and metadata extraction).
- **memex-L** — a memex running with local inference (an on-site
  service provides embeddings and metadata extraction).
- **OB1** — the upstream Open Brain project. A memex uses OB1's
  schema baseline and MCP protocol but implements its own server code.
- **the wiki** — a git repository of markdown files that serves as
  the canonical store for a memex's content.
- **the sync daemon** — a process that periodically reconciles the
  wiki and the PostgreSQL database.
- **the memex server** — the HTTP server that exposes MCP tools to
  AI clients.
- **a thought** — an atomic unit of stored content. One row in the
  `thoughts` table, one markdown file in the wiki repo.
- **the inference service** — an optional external or local service
  that provides embedding and text generation capabilities. External
  (memex-R) or on-site (memex-L).
- **the operator** — the person deploying and maintaining a memex
  instance.
- **a user** — a person whose memex is hosted somewhere. The operator
  is often one user among many on a multi-user deployment.

## 4. System Overview

### 4.1 Conceptual Architecture

At the highest level, a memex is a single instance running five
services:

```
┌───────────────────────────────────────────────────┐
│                  memex instance                   │
│                                                   │
│  ┌─────────────┐   ┌────────────┐   ┌──────────┐  │
│  │  PostgreSQL │   │  memex MCP │   │   Sync   │  │
│  │  +pgvector  │◄──┤   Server   │   │  Daemon  │  │
│  │             │   │            │   │          │  │
│  └──────┬──────┘   └─────┬──────┘   └─────┬────┘  │
│         │                │                │       │
│         │                ▼                │       │
│         │        HTTPS (via proxy)        │       │
│         │                │                │       │
│         │            [MCP clients]        │       │
│         │                                 │       │
│         └───────── SQL ───────────────────┘       │
│                                                   │
│              git clone (pull/push)                │
│                    │                              │
└────────────────────┼──────────────────────────────┘
                     │
                     ▼
              ┌─────────────┐
              │ git remote  │  (wiki repo)
              └─────────────┘
                     ▲
                     │ git push/pull
                     │
              ┌─────────────┐
              │ Operator    │  (editing in any editor)
              └─────────────┘
```

- **PostgreSQL + pgvector** stores the thoughts table and related
  tables. Listens on localhost only.
- **memex MCP Server** is a server that implements the MCP protocol
  and exposes OB1-compatible tools plus memex-specific extensions.
- **Sync daemon** is a process that periodically pulls the wiki repo,
  detects changes in both directions via a trigger-populated sync_log
  table, applies them, and pushes back.
- **Reverse proxy with TLS** (nginx, caddy, or equivalent) terminates
  TLS for the MCP endpoint.
- **Secret delivery** (not shown) fetches per-user credentials and
  delivers them to the other services at startup.

The exact implementation of each component is flexible. The database
must be PostgreSQL 13+ with pgvector. The sync daemon and MCP server
can be written in any language that supports MCP and PostgreSQL. The
reverse proxy is operator choice. Secret delivery is operator choice.

### 4.2 Data Flow

**Operator edit path:**

1. Operator edits a markdown file in their local clone of the wiki repo
2. Operator commits and pushes to the git remote
3. On the next sync cycle, the memex instance's sync daemon fetches
4. Sync daemon detects the changed file (wiki → DB direction)
5. Sync daemon canonicalizes content, re-embeds, re-extracts metadata,
   updates the row in PostgreSQL (which updates `content_fingerprint`
   and `updated_at` automatically via generated column and trigger)
6. AI clients querying via MCP immediately see the updated content

**AI capture path (B3 parallelized commit-before-respond):**

1. An AI client calls `capture_thought` via MCP with new content
2. The memex server generates a UUID for the new thought client-side
3. In parallel, the server starts:
   - Embedding API call (to remote or local inference service)
   - Metadata extraction API call
   - Wiki file write with content and stub frontmatter
   - `git add && git commit && git push` of the new file
4. When all parallel operations complete successfully, the server
   does an `INSERT` into PostgreSQL with the content, embedding,
   metadata, and the pre-generated UUID
5. The server returns success to the MCP client
6. On the next sync cycle, the sync daemon sees the new row in
   sync_log and updates the wiki file's frontmatter `auto:` section
   to populate the full metadata (until then, the file has stub
   metadata)

The capture path ensures that once `capture_thought` returns success,
the content is durable in the git remote. Instance loss does not lose
acknowledged captures.

**Bidirectional conflict path:**

If both the wiki file content and the PostgreSQL row content have
changed since the last sync — detected via three-way comparison of
content fingerprints — the sync daemon does not automatically resolve.
It creates a conflict marker file in `conflicts/{uuid}.conflict.md`
containing ancestor, wiki, and DB versions, commits that file, and
leaves the original file and the database row untouched until the
operator resolves manually. See Section 8.6.

### 4.3 Key Properties

- **Not precious state (with a qualification).** The memex database
  can be destroyed and rebuilt. PostgreSQL state is rebuilt from the
  wiki repo. No backup is strictly required for correctness. The
  write-through capture path ensures that acknowledged captures are
  durable in git before return.
- **Single source of truth.** Git is canonical. The database is a
  derived cache that can be rebuilt from git at any time.
- **Schema-compatible with OB1.** OB1 import recipes that write to
  the `thoughts` table work against a memex. OB1 client tools that
  query via MCP work against the memex server unchanged.
- **Multi-user.** Multiple users can share a deployment, each with
  their own isolated instance. Users cannot access each other's
  memexes. See Section 5.8 for the explicit isolation contract.
- **Inference-backend agnostic.** memex-R and memex-L share the same
  schema, the same server code, and the same sync daemon. They
  differ only in the values of the embedding API base URL, the chat
  API base URL, and the model name strings.

## 5. Architectural Decisions

This section records the major architectural decisions and the
reasoning behind them.

### 5.1 Git as Source of Truth, PostgreSQL as Derived Cache, Write-Through Captures

**Decision:** The wiki git repo is the authoritative store.
PostgreSQL is a derived cache, rebuildable by re-ingesting the wiki.
AI captures write to git before returning success to the MCP client
(B3 parallelized commit-before-respond).

**Rationale:** Makes the memex instance disposable — a destroyed
instance can be recreated and will rebuild its database from git.
Eliminates the need to back up PostgreSQL for correctness. Provides
plain-text, human-readable, git-versioned history of every thought.

The "write-through" refinement ensures that AI captures cannot be
lost in the window between capture and the next sync cycle. Without
it, an instance failure in that window would lose data the MCP client
had been told was saved.

**Consequence:** The capture path is more complex than a simple
database INSERT. It must coordinate an in-memory UUID generation, two
parallel inference API calls, a wiki file write, a git commit, and a
git push, all before the INSERT and return. Parallelization hides
most of this latency under the existing inference round-trip time.
Section 9.2 describes the capture path in detail.

**Consequence:** The memex server process needs git access: a local
wiki checkout, a deploy key, and the ability to push to the git
remote at capture time. These are operational requirements for the
deployment layer.

### 5.2 Sync Daemon as Pure Sidecar

**Decision:** The sync daemon is a separate process from the memex
MCP server. They communicate only through PostgreSQL (for change
detection) and the shared wiki repo clone (for file state). Neither
invokes the other directly.

**Rationale:** Keeps the capture path's latency bounded (the server
does its own git work rather than synchronously waiting for the
daemon). Keeps the daemon's recovery story clean. Preserves the
option of running the daemon independently — for example, during
rebuild from git, the daemon populates the database without the
server running at all.

**Consequence:** Both the server and the daemon have their own
git-operation code paths. These must agree on the wiki directory
layout, the filename convention, the frontmatter format, and the
canonicalization rules. Duplication is accepted in exchange for
independence.

### 5.3 memex-Native Server Using OB1 Schema Baseline

**Decision:** The memex MCP server is memex-native code, written to
implement the OB1 MCP protocol and operate on the OB1 k8s-deployment
schema baseline. It is not a fork of or wrapper around OB1 upstream
code.

**Rationale:** Adversarial review of an earlier draft determined that
the upstream k8s-deployment server has no extension hooks, so any
memex modifications (B3 capture, list_conflicts, role separation)
require modifying upstream source. If upstream is being modified
anyway, owning the code outright is cleaner than maintaining a fork.
Writing from scratch buys: cleaner code structure for future memex
features, freedom to evolve the server without tracking upstream,
and a cleaner contribution story.

The server implements the same four MCP tools with the same external
behavior as OB1's k8s-deployment variant, so AI clients see an
OB1-compatible endpoint. The difference is purely in whose code is
running.

**Consequence:** The memex project owns ~400-500 lines of server
code. Bugs are memex bugs. OB1 improvements do not flow into the
memex automatically; the maintainer reviews OB1 changes periodically
and ports useful ones.

### 5.4 Additive-Only Extension of the OB1 Schema

**Decision:** A memex uses the OB1 k8s-deployment schema as the
baseline and extends it additively. Memex additions are either new
columns implemented as PostgreSQL generated columns, new columns
with defaults and triggers, or entirely new tables.

**Rationale:** Schema compatibility with OB1 means OB1 import recipes
can write to the `thoughts` table without adapter code. Schema
additions that live in new columns or new tables are invisible to
OB1's code paths. The memex gets additional capabilities (ob_uuid
for external identity, content_fingerprint for dedup, updated_at for
change tracking, thought_relations for relationships, sync_log for
change detection) without breaking compatibility.

**Consequence:** The memex schema is a superset of OB1's. Migrations
are additive and forward-only. Future OB1 changes can be adopted by
adding corresponding memex migrations without conflicts.

### 5.5 Per-Instance Isolation

**Decision:** Multiple users on a single deployment each have their
own memex instance: their own database, their own wiki repo, their
own credentials, their own endpoint. Users cannot access each
other's memexes at any layer. The specific mechanism (VMs,
containers, processes, namespaces) depends on the deployment target;
the architectural requirement is isolation, not VMs specifically.

**Rationale:** Personal knowledge content is private. Isolation by
instance rather than by row-level security is simpler to reason
about, harder to get wrong, and survives bugs in the memex code.
Each user's database is a separate physical store; there's no way
for a bug in the server to leak one user's content to another's
session.

**Consequence:** Resource usage scales linearly with user count. A
deployment that supports N users runs N instances. This is
appropriate for small, personal, or family-scale deployments. Very
large deployments would require a different approach.

**Consequence:** The deployment layer is responsible for provisioning
per-user instances, per-user credentials, and per-user secrets.
Deployment guides should document how this is done on their target
platform.

### 5.6 Multiple Inference Backends

**Decision:** A memex supports two primary inference backends via
configuration, not separate code paths:

- **memex-R** uses a remote hosted inference API (e.g., OpenRouter,
  OpenAI API, or similar). The network path carries content to the
  API for embedding and metadata extraction; the API returns vectors
  and JSON.
- **memex-L** uses a local on-site inference service (e.g., Ollama)
  running locally.

Both variants run the same server code, the same schema, the same
sync daemon. They differ only in the values of four environment
variables: `EMBEDDING_API_BASE`, `CHAT_API_BASE`, `EMBEDDING_MODEL`,
`CHAT_MODEL`.

**Rationale:** Most operators will start with memex-R because it
requires less infrastructure and lets them validate the memex itself
before investing in local inference. memex-L is appropriate when
data sovereignty requirements rule out hosted APIs or when latency
and cost matter enough to justify local GPUs.

**Consequence:** Migrating from memex-R to memex-L is a
configuration change plus re-embedding all rows with the new model.
The re-embed is a background job; the schema and code are unchanged.

**Consequence:** Users cannot mix inference backends within a single
instance. All rows must be embedded by the same model for search
results to be coherent. (A single memex instance could be switched
between models, but in doing so it re-embeds all its content with
the new model.)

### 5.7 Conflict Flagging for Human Review

**Decision:** When the sync daemon detects a three-way conflict
(both wiki and database changed since the last sync), it does not
automatically resolve. It creates a conflict marker file in
`conflicts/{uuid}.conflict.md` containing all three versions
(ancestor, wiki, DB), commits it to the wiki, and leaves both the
original file and the DB row untouched until the operator resolves
manually.

**Rationale:** Conflicts should be rare in practice — AI captures
create new thoughts, not edits to existing ones — and when they do
occur they may indicate a sync daemon bug rather than genuine
concurrent editing. Automated resolution (wiki-wins, last-writer-wins)
would enable bugs to silently destroy information. Flagging for
human review preserves the "don't automate decisions that could
cause data loss" principle.

**Consequence:** The operator must periodically check for
outstanding conflicts. A `list_conflicts` MCP tool exposes them to
AI agents so they can be surfaced during normal interaction.

**Consequence:** A new conflict blocks sync for the affected thought
until resolved. Other thoughts continue to sync normally. The memex
remains functional during an unresolved conflict; only that specific
thought is frozen.

### 5.8 Isolation Contract

A memex's multi-user model relies on per-instance separation plus
per-user credentials and per-user repos. This subsection enumerates
the specific isolation guarantees at the architectural level.
Deployment guides specify how these are enforced on their target
platform.

**Strong guarantees (architectural requirements for any deployment):**

| Layer | Guarantee | Architectural mechanism |
|---|---|---|
| Database content | User A's `thoughts` table is not readable from user B's instance | Per-user database instances; no shared database schema |
| Wiki content | User A's wiki repo is not readable by user B's credentials | Per-user git repositories with access control at the git host |
| Credentials | User A's credentials are not readable by user B's instance | Per-user credential storage with per-instance access control |
| MCP endpoint | User A's MCP endpoint is not accessible with user B's access key | High-entropy access keys per user; constant-time comparison in auth middleware |
| Database DELETEs | No client other than the sync daemon can delete rows | Separate database roles: the MCP server has SELECT/INSERT/UPDATE only; the sync daemon has DELETE |

**Weaker guarantees (enforcement depends on operator discipline):**

| Layer | Guarantee | Notes |
|---|---|---|
| DNS | Instance hostnames may be discoverable | Hostnames do not grant access; the MCP key is the actual barrier |
| Per-instance logs | Logs don't contain content from other users | Follows from per-instance isolation but depends on the deployment not aggregating logs in a cross-user way |
| Operator access | The operator can access any user's data | This is by design; the isolation boundary is "between users," not "between users and operator" |

**Guarantees that depend on the inference service (memex-L):**

| Layer | Guarantee | Notes |
|---|---|---|
| Inference requests | User A's content is not visible to user B via the shared inference service | The inference service must process each request in isolation. Session-level isolation at the inference layer is the inference service's responsibility, not the memex's. Deployments using shared inference services must verify this property. |

**What's NOT guaranteed:**

- Deployment configuration errors (e.g., a misconfigured Vault policy
  or GitLab permission) will not be caught automatically by the
  architecture. Deployment guides should specify automated validation
  checks for whatever enforcement mechanisms they use.
- Compromised client-side credentials (MCP access keys leaked via
  logging, shell history, or AI client misuse).
- Bugs in the memex server's access key comparison.
- Changes to shared infrastructure (git host permission model, DNS
  zone visibility) that affect isolation at the enforcement layer.

**Deployment responsibility:** Each deployment guide must document
its specific enforcement mechanisms for the guarantees above and
include automated validation where possible. The reference mcp-memex
Mycofu integration includes an `enable-memex-user.sh` script that
validates all isolation invariants at user provisioning time.

## 6. Schema Design

The memex schema is declared by a sequence of forward-only SQL
migrations. Each migration is a plain SQL file named
`NNNN_description.sql` and applied by a migration runner at service
start. The migrations are deployment-agnostic — they run against any
PostgreSQL 13+ with pgvector.

The full schema consists of 9 migrations:

- `0001_initial_schema.sql` — OB1 baseline + HNSW vector index
- `0002_add_ob_uuid.sql` — external UUID identifier
- `0003_add_source_column.sql` — generated column from metadata
- `0004_add_content_fingerprint.sql` — canonicalization trigger and fingerprint
- `0005_add_updated_at.sql` — change timestamp with trigger
- `0006_add_thought_relations.sql` — relationship table (reserved for future use)
- `0007_add_sync_log.sql` — CDC feed for the sync daemon
- `0008_add_sync_state.sql` — daemon persistent state
- `0009_add_roles.sql` — PostgreSQL role separation

### 6.1 Initial Schema (Migration 0001)

Establishes the OB1 baseline with the HNSW vector index included
from day one. (The upstream OB1 k8s-deployment variant omits the
vector index; the memex adds it because semantic search is a core
operation that needs to be fast.)

```sql
CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE IF NOT EXISTS schema_migrations (
    version text PRIMARY KEY,
    applied_at timestamptz NOT NULL DEFAULT now(),
    checksum text
);

CREATE TABLE IF NOT EXISTS thoughts (
    id BIGSERIAL PRIMARY KEY,
    content TEXT NOT NULL,
    embedding vector(1536),
    metadata JSONB DEFAULT '{}'::jsonb,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_thoughts_created_at
    ON thoughts (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_thoughts_metadata
    ON thoughts USING GIN (metadata);
CREATE INDEX IF NOT EXISTS idx_thoughts_embedding
    ON thoughts USING hnsw (embedding vector_cosine_ops);

CREATE OR REPLACE FUNCTION match_thoughts(
    query_embedding vector(1536),
    match_threshold FLOAT DEFAULT 0.5,
    match_count INT DEFAULT 10,
    filter JSONB DEFAULT '{}'::jsonb
)
RETURNS TABLE (
    id BIGINT,
    content TEXT,
    metadata JSONB,
    similarity FLOAT,
    created_at TIMESTAMP WITH TIME ZONE
)
LANGUAGE plpgsql
AS $$
BEGIN
    RETURN QUERY
    SELECT t.id, t.content, t.metadata,
           (1 - (t.embedding <=> query_embedding))::FLOAT AS similarity,
           t.created_at
    FROM thoughts t
    WHERE 1 - (t.embedding <=> query_embedding) >= match_threshold
    ORDER BY t.embedding <=> query_embedding
    LIMIT match_count;
END;
$$;
```

### 6.2 ob_uuid External Identifier (Migration 0002)

External identity is a memex-specific UUID column. Internal
references use `id BIGSERIAL`; external references (wiki frontmatter,
conflict filenames, MCP tool arguments, cross-system links) use
`ob_uuid`.

```sql
ALTER TABLE thoughts
    ADD COLUMN ob_uuid uuid NOT NULL DEFAULT gen_random_uuid();

CREATE UNIQUE INDEX idx_thoughts_ob_uuid ON thoughts(ob_uuid);
```

The memex server's `capture_thought` tool generates a UUID
client-side (required for parallelization in the capture path) and
explicitly sets `ob_uuid` in the INSERT. Other writers (OB1 import
recipes, manual SQL sessions, operator-created files without an
ob_id in frontmatter) get an automatic UUID via the DEFAULT.

**Frontmatter name:** `ob_id` in wiki file frontmatter, not
`ob_uuid`. The frontmatter field is shorter and semantically named
("identifier"); the database column is precisely typed.

### 6.3 Source Generated Column (Migration 0003)

The `source` field lives in `metadata` JSONB (OB1's convention).
The memex adds a top-level generated column that surfaces it for
indexed filtering.

```sql
ALTER TABLE thoughts
    ADD COLUMN source text
    GENERATED ALWAYS AS (metadata->>'source') STORED;

CREATE INDEX idx_thoughts_source ON thoughts(source);
```

**Values:**
- `human` — created by direct edit in the wiki
- `mcp` — created by an AI agent via `capture_thought`
- `import` — created by an import recipe (e.g., Gmail, ChatGPT)
- `rollup` — generated summary (future)
- `transcription` — from voice capture (future)
- `clipping` — from web clipping (future)
- `attachment` — extracted from an attachment (future)
- `system` — created by a system process

### 6.4 Content Canonicalization and Fingerprint (Migration 0004)

Content is canonicalized on INSERT/UPDATE via a trigger, and a
generated column computes the SHA-256 fingerprint of the
canonicalized content.

```sql
CREATE OR REPLACE FUNCTION canonicalize_thought_content()
RETURNS TRIGGER AS $$
BEGIN
    NEW.content := regexp_replace(NEW.content, E'^\uFEFF', '');
    NEW.content := regexp_replace(NEW.content, E'\r\n?', E'\n', 'g');
    NEW.content := regexp_replace(NEW.content, E'\n+$', '') || E'\n';
    NEW.content := normalize(NEW.content, NFC);
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER thoughts_canonicalize_content
    BEFORE INSERT OR UPDATE OF content ON thoughts
    FOR EACH ROW
    EXECUTE FUNCTION canonicalize_thought_content();

ALTER TABLE thoughts
    ADD COLUMN content_fingerprint text
    GENERATED ALWAYS AS (encode(sha256(content::bytea), 'hex')) STORED;

CREATE INDEX idx_thoughts_content_fingerprint
    ON thoughts(content_fingerprint);
```

**Canonicalization rules (authoritative):**

| Aspect | Rule |
|---|---|
| Encoding | UTF-8 |
| BOM | Stripped if present |
| Line endings | LF only |
| Trailing newlines | Exactly one |
| Leading newlines | Preserved |
| Unicode form | NFC |
| Internal whitespace | Preserved (markdown-significant) |
| Trailing whitespace on lines | Preserved (markdown uses trailing double-space) |
| Indentation | Preserved |

**Sync daemon responsibility:** The daemon, when hashing file content
for comparison against the database's `content_fingerprint`, must
apply the same canonicalization in its own code before hashing. A
`canonicalize()` helper in the daemon source mirrors the SQL function
exactly. Both locations must carry a comment referencing the
authoritative rule table above.

### 6.5 updated_at Column (Migration 0005)

```sql
ALTER TABLE thoughts
    ADD COLUMN updated_at timestamptz NOT NULL DEFAULT now();

CREATE OR REPLACE FUNCTION update_thoughts_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = now();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER thoughts_updated_at_trigger
    BEFORE UPDATE ON thoughts
    FOR EACH ROW
    EXECUTE FUNCTION update_thoughts_updated_at();

CREATE INDEX idx_thoughts_updated_at ON thoughts(updated_at);
```

### 6.6 thought_relations Table (Migration 0006)

Added from day one, even though the MVP sync daemon does not
populate it, so the table exists when future features (backlinks,
rollup provenance, task extraction, near-duplicate clusters) begin
using it.

```sql
CREATE TABLE thought_relations (
    source_id bigint NOT NULL REFERENCES thoughts(id) ON DELETE CASCADE,
    target_id bigint NOT NULL REFERENCES thoughts(id) ON DELETE CASCADE,
    relation_type text NOT NULL,
    created_at timestamptz DEFAULT now(),
    PRIMARY KEY (source_id, target_id, relation_type)
);

CREATE INDEX idx_thought_relations_target
    ON thought_relations (target_id, relation_type);
```

**Relation types reserved for future features:**
- `links_to` — wiki-link reference
- `summarizes` — rollup provenance
- `extracted_from` — task extraction provenance
- `contains_attachment` — attachment reference
- `responds_to` — reply chain
- `similar_to` — near-duplicate cluster
- `cites` — citation

### 6.7 sync_log Table (Migration 0007)

The sync_log table is the memex's change data capture mechanism. A
trigger on `thoughts` writes a row to `sync_log` on every INSERT,
UPDATE, and DELETE, except when the daemon itself is the writer
(loop prevention via session variable).

```sql
CREATE TABLE sync_log (
    seq BIGSERIAL PRIMARY KEY,
    thought_id bigint NOT NULL,
    ob_uuid uuid NOT NULL,
    operation text NOT NULL CHECK (operation IN ('INSERT', 'UPDATE', 'DELETE')),
    occurred_at timestamptz NOT NULL DEFAULT now(),
    processed_at timestamptz
);

CREATE INDEX idx_sync_log_unprocessed
    ON sync_log (seq) WHERE processed_at IS NULL;

CREATE OR REPLACE FUNCTION log_thoughts_changes()
RETURNS TRIGGER AS $$
DECLARE
    src text;
BEGIN
    src := current_setting('app.sync_source', TRUE);
    IF src IS NOT DISTINCT FROM 'daemon' THEN
        RETURN NULL;
    END IF;

    IF TG_OP = 'INSERT' THEN
        INSERT INTO sync_log (thought_id, ob_uuid, operation)
        VALUES (NEW.id, NEW.ob_uuid, 'INSERT');
    ELSIF TG_OP = 'UPDATE' THEN
        INSERT INTO sync_log (thought_id, ob_uuid, operation)
        VALUES (NEW.id, NEW.ob_uuid, 'UPDATE');
    ELSIF TG_OP = 'DELETE' THEN
        INSERT INTO sync_log (thought_id, ob_uuid, operation)
        VALUES (OLD.id, OLD.ob_uuid, 'DELETE');
    END IF;
    RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER thoughts_sync_log_trigger
    AFTER INSERT OR UPDATE OR DELETE ON thoughts
    FOR EACH ROW
    EXECUTE FUNCTION log_thoughts_changes();
```

**Loop prevention:** The daemon sets `app.sync_source = 'daemon'`
before any writes it performs. The trigger skips logging for these
writes, preventing ping-pong between wiki and DB.

**No foreign key to thoughts:** intentional. DELETE events need to
survive the DELETE of the row they reference.

**Periodic pruning:** A scheduled job deletes processed entries
older than a retention window (7 days default). Keeps sync_log from
growing unbounded while preserving a recent audit trail.

### 6.8 sync_state Table (Migration 0008)

Stores the sync daemon's persistent state. Used for crash recovery
and for tracking the last-processed wiki commit.

```sql
CREATE TABLE sync_state (
    key text PRIMARY KEY,
    value jsonb NOT NULL,
    updated_at timestamptz NOT NULL DEFAULT now()
);
```

**Keys used by the MVP daemon:**
- `last_wiki_commit` — SHA of the most recent wiki commit the daemon
  has fully processed
- `last_successful_sync_at` — timestamp of the last successful cycle
  completion
- `last_error` — most recent error message, if any
- `in_flight_conflicts` — array of `ob_uuid`s currently flagged as
  conflicted

### 6.9 PostgreSQL Roles (Migration 0009)

Two database roles enforce the deletion-invariant from Section 5.8:

```sql
-- Role for the memex MCP server: can query and write, cannot delete
CREATE ROLE memex_mcp LOGIN PASSWORD '<placeholder>';
GRANT SELECT, INSERT, UPDATE ON thoughts TO memex_mcp;
GRANT SELECT ON sync_log, sync_state TO memex_mcp;
GRANT USAGE, SELECT ON SEQUENCE thoughts_id_seq TO memex_mcp;
GRANT EXECUTE ON FUNCTION match_thoughts TO memex_mcp;
-- Deliberately NOT granted: DELETE on any table

-- Role for the sync daemon: full control
CREATE ROLE memex_sync LOGIN PASSWORD '<placeholder>';
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO memex_sync;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO memex_sync;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO memex_sync;
```

Passwords are placeholders replaced at deployment time by the
provisioning mechanism.

## 7. Wiki Repo Design

### 7.1 Directory Structure

```
memex-wiki/                          # git repo root
├── README.md                        # human-readable description of the repo
├── .memex/                          # reserved for memex metadata
│   └── config.yaml                  # repo-level config
├── conflicts/                       # conflict markers (Section 8.6)
│   └── {ob_uuid}.conflict.md
├── daily/                           # reserved for daily notes (future)
├── attachments/                     # reserved for attachment storage (future)
├── rollups/                         # reserved for generated rollups (future)
├── imports/                         # reserved for bulk-imported content
│   ├── email/
│   ├── chatgpt/
│   └── obsidian/
└── *.md                             # everything else at top level (default)
```

**Reserved subdirectories:** `.memex/`, `conflicts/`, `daily/`,
`attachments/`, `rollups/`, `imports/`. The MVP sync daemon reads and
writes the top level and `conflicts/`. Other subdirectories are
reserved for future features.

### 7.2 Filename Convention

Files generated by the sync daemon follow org-roam-style naming:

```
YYYYMMDDHHMMSS-slug.md
```

- Timestamp is the thought's `created_at` in UTC, packed to 14 digits
- Slug is a kebab-cased, lowercased version of the first ~5 words of
  content, with non-alphanumeric characters stripped
- Collisions resolved by appending `-2`, `-3`, etc.

**Case-insensitive filesystems:** slugs are always lowercased to
prevent collisions on macOS and Windows workstations.

**Files created by the operator** can use any filename. The sync
daemon sees them as new thoughts on ingestion and inserts them into
the database with a fresh UUID, populating `ob_id` in frontmatter.

**Filename changes** are safe because the thought's identity lives
in frontmatter (`ob_id`), not the filename.

### 7.3 Frontmatter Structure

```yaml
---
ob_id: 550e8400-e29b-41d4-a716-446655440000
ob_fingerprint: sha256:abc123def456...
ob_synced_at: 2026-04-12T14:30:00Z
auto:
  type: observation
  topics: [Mycofu, architecture]
  people: []
  action_items: []
  dates_mentioned: []
user:
  tags: []
  notes: ""
---

Mycofu stack: NixOS VMs managed via OpenTofu, GitLab CI/CD, HashiCorp Vault...
```

**Top-level fields:**
- `ob_id` — UUID of the corresponding database row (the `ob_uuid`
  column value). Stable across renames.
- `ob_fingerprint` — SHA-256 hash of the canonicalized content body
  (not including frontmatter) at the last successful sync. Used for
  three-way change detection.
- `ob_synced_at` — ISO 8601 timestamp of the last successful sync
  for this file.

**`auto` section:** populated by the sync daemon from LLM-extracted
metadata. Regenerated on every content change. The operator should
not edit this section — any edits are overwritten on the next sync.

**`user` section:** populated by the operator. Never touched by the
sync daemon. This is the "curated metadata" area.

### 7.4 Git Workflow

The wiki repo lives on a git host (GitLab, GitHub, Gitea, bare
repo) with per-user access control. Permissions:

- **The user (owner)** — full read/write via personal credentials
- **The memex instance** — full read/write via deploy key
- **Everyone else** — no access

**Branching:** single `main` branch. No dev/prod separation for wiki
content.

### 7.5 Commit Attribution

The memex server and sync daemon use a distinct author identity:

```
Author: memex-sync <memex-sync@<domain>>
Committer: memex-sync <memex-sync@<domain>>
```

**Commit message templates:**

Captures from the memex server:
```
[memex-capture] <first line of content>

ob_id: <uuid>
source: mcp
```

Sync daemon commits:
```
[memex-sync] Process N updates

- Updated frontmatter for <file>
- Regenerated metadata for <file>

thought-count: N
```

Conflict marker commits:
```
[memex-conflict] Conflict detected for <ob_uuid>

Detected at: <timestamp>
Wiki file: <path>
```

## 8. Sync Daemon Design

The sync daemon is specified here as an explicit state machine. The
design addresses change detection, deletion handling, crash
recovery, and git concurrency.

### 8.1 Daemon Lifecycle

The daemon runs on a periodic schedule (the reference implementation
uses a 2-minute interval). Each run is a single cycle.

Each cycle:
1. Acquires a local lock to prevent concurrent runs
2. If the lock is held, exits immediately (logs a warning)
3. Otherwise runs the full sync cycle described in Section 8.2
4. Releases the lock on exit

### 8.2 Sync Cycle State Machine

Each phase is idempotent: re-running after a crash produces the
same result as running once.

```
Phase 1: Fetch
  git fetch origin
  git reset --hard origin/main

Phase 2: Process Wiki Changes (wiki → DB)
  Compare HEAD with sync_state.last_wiki_commit
  For each changed/added/deleted file in the diff:
    - Parse frontmatter and body
    - Dispatch to handler (thought/conflict/...)
    - Apply changes to PostgreSQL
  Check for three-way conflicts (Section 8.6)

Phase 3: Process DB Changes (DB → wiki)
  Query sync_log WHERE processed_at IS NULL
  For each entry (within a transaction):
    - Generate/update/delete the corresponding wiki file
    - Mark the entry as processed
  Commit the transaction

Phase 4: Stage and Commit
  git status --porcelain
  If changes exist:
    git add .
    git commit with memex-sync author identity

Phase 5: Push
  git push origin main
  On rejection (non-fast-forward):
    Go to Phase 1, retry up to 3 times
    On final failure, log error and exit non-zero

Phase 6: Advance Watermark
  Update sync_state.last_wiki_commit to current HEAD
  Update sync_state.last_successful_sync_at to now()
  Clear sync_state.last_error
```

### 8.3 Change Detection via sync_log

The sync daemon reads database changes through the `sync_log` table,
not by polling `updated_at`. This closes the race window where
captures during a sync run could be skipped or duplicated.

**Read pattern:**

```sql
BEGIN;
SET LOCAL app.sync_source = 'daemon';

SELECT seq, thought_id, ob_uuid, operation, occurred_at
FROM sync_log
WHERE processed_at IS NULL
ORDER BY seq
LIMIT 100
FOR UPDATE SKIP LOCKED;

-- process each entry, apply to wiki

UPDATE sync_log
SET processed_at = now()
WHERE seq IN (...);

COMMIT;
```

The `FOR UPDATE SKIP LOCKED` serializes access. The `ORDER BY seq`
guarantees in-order processing. The transaction atomically
reads-and-marks, so crash recovery is automatic: entries remain
unprocessed until successfully committed.

### 8.4 Deletion Handling

Deletions are wiki-originated only. The `memex_mcp` role has no
DELETE permission, so the memex server cannot delete rows. The sync
daemon (running as `memex_sync`) is the only path to row deletion,
and it deletes rows only in response to wiki file deletions.

**Wiki → DB deletion:**

1. Operator runs `git rm <file>` and commits, then pushes
2. Sync daemon fetches, sees the deletion in the diff
3. Daemon looks up the `ob_id` from the file's history
4. Daemon executes `DELETE FROM thoughts WHERE ob_uuid = ...`
5. The trigger would write a DELETE entry to sync_log, but the
   daemon's session variable skips writing it (loop prevention)

**Recovery:** if the operator deletes a file by mistake, they restore
it from git history. The sync daemon on its next cycle sees the
file reappear, generates a new UUID, and re-inserts the row. The
original `ob_uuid` is lost but content is preserved.

**No soft delete.** The memex does not use a `deleted_at` column or
archive directory. Recovery is via git history.

### 8.5 Git Concurrency: Pull-Then-Commit With Bounded Retry

The daemon and the operator both push to the same git repo. If the
operator pushes during the daemon's cycle, the daemon's push is
rejected as non-fast-forward. The daemon handles this by restarting
from Phase 1, up to 3 retries before giving up.

**Why retry and not rebase:** rebasing the daemon's commits onto a
new remote HEAD could produce merge conflicts the daemon can't
resolve automatically. Re-running the whole cycle is cleaner
because each cycle is idempotent.

### 8.6 Conflict Handling

A conflict is defined as: both the wiki file content and the DB row
content have changed since the last sync. At sync time:

- `wiki_hash` = SHA-256 of canonicalized current file content
- `db_hash` = DB row's `content_fingerprint`
- `ancestor_hash` = file's `ob_fingerprint` from frontmatter
- **Conflict if:** `wiki_hash ≠ ancestor_hash` AND
  `db_hash ≠ ancestor_hash` AND `wiki_hash ≠ db_hash`

**Response:** The daemon writes a conflict marker at
`conflicts/{ob_uuid}.conflict.md` containing:

```markdown
---
conflict_id: <ob_uuid>
detected_at: 2026-04-12T14:30:00Z
ancestor_hash: sha256:abc123...
wiki_hash: sha256:def456...
db_hash: sha256:ghi789...
wiki_file: <filename>
status: unresolved
---

# Conflict detected for thought <ob_uuid>

Both the wiki file and the database have been modified since the last
sync. The sync daemon did not automatically resolve. Please review
the three versions below and resolve manually:

1. Edit the original wiki file to the version you want to keep
2. Delete this conflict marker file
3. Commit and push

## Ancestor (last synced version)

<content>

## Wiki version

<content>

## Database version

<content>
```

**Effect on sync:**

- The conflict marker file is committed to the wiki repo
- The original wiki file is **not** modified
- The database row is **not** modified
- The `ob_uuid` is added to `sync_state.in_flight_conflicts`
- Subsequent sync cycles skip the conflicted thought
- Other thoughts continue to sync normally

**Resolution:** operator edits the original file, deletes the
conflict marker, commits. The daemon detects the resolution on its
next cycle and clears the in-flight state.

**Authoritative state:** the conflict state lives in
`sync_state.in_flight_conflicts`, not in the marker file. Deleting
the marker without editing the original does not silently clear
state.

### 8.7 Loop Prevention

The daemon's own writes to PostgreSQL would normally generate
sync_log entries. These entries would be re-processed on the next
cycle, causing the daemon to regenerate files it just wrote.

**Prevention:** the daemon sets `app.sync_source = 'daemon'` via
`SET LOCAL` at the start of its database transaction. The sync_log
trigger checks this variable and skips writing entries when the
source is 'daemon'.

### 8.8 Crash Recovery

Every phase is idempotent and watermarks advance only after
successful completion:

- **Crash in Phase 1 (fetch):** next cycle re-fetches. No state lost.
- **Crash in Phase 2 (wiki → DB):** transaction rolls back. Next
  cycle re-reads the same diff.
- **Crash in Phase 3 (DB → wiki):** sync_log transaction rolls back,
  entries remain unprocessed. Next cycle re-reads them.
- **Crash in Phase 4 (commit):** uncommitted files discarded by
  Phase 1's `git reset --hard` next cycle.
- **Crash in Phase 5 (push):** local commits exist but not remotely.
  Phase 1 discards them; Phase 3 re-reads unprocessed sync_log;
  new commits are re-created and pushed.
- **Crash in Phase 6 (watermark advance):** next cycle re-processes
  the same diff and sync_log entries. Idempotent.

## 9. MCP Server

### 9.1 Configuration Interface

The memex MCP server is a long-running HTTP application that
implements the MCP protocol. Configuration is via environment
variables:

| Variable | Purpose |
|---|---|
| `MEMEX_DB_HOST` | PostgreSQL host |
| `MEMEX_DB_PORT` | PostgreSQL port |
| `MEMEX_DB_NAME` | Database name |
| `MEMEX_DB_USER_MCP` | MCP role name |
| `MEMEX_DB_PASSWORD_MCP` | MCP role password |
| `EMBEDDING_API_BASE` | Embedding endpoint URL |
| `EMBEDDING_API_KEY` | Embedding API authentication |
| `EMBEDDING_MODEL` | Embedding model name |
| `CHAT_API_BASE` | Chat endpoint URL |
| `CHAT_API_KEY` | Chat API authentication |
| `CHAT_MODEL` | Chat model name |
| `MCP_ACCESS_KEYS_FILE` | Path to valid keys file |
| `WIKI_REPO_PATH` | Local wiki clone path |
| `WIKI_REMOTE_URL` | git remote URL |
| `GIT_DEPLOY_KEY_PATH` | SSH key path for git push |
| `PORT` | HTTP listen port |

Switching between memex-R and memex-L is a configuration change to
four environment variables (`EMBEDDING_API_BASE`, `CHAT_API_BASE`,
`EMBEDDING_MODEL`, `CHAT_MODEL`) plus optional credential changes.
The server code is identical in both modes.

### 9.2 MCP Tools

The server implements four OB1-compatible tools plus memex
extensions.

**`search_thoughts(query, limit?, threshold?)`:** vector similarity
search via the `match_thoughts` SQL function. Identical external
behavior to OB1.

**`list_thoughts(limit?, type?, topic?, person?, days?)`:** filtered
recent-thoughts query.

**`thought_stats()`:** aggregated statistics.

**`capture_thought(content)`:** the parallelized capture path:

```
1. Generate ob_uuid client-side (required for parallelization)
2. Canonicalize content (match the SQL trigger)
3. In parallel:
   a. Embedding API call
   b. Metadata extraction API call
   c. Write wiki file with content and stub frontmatter
   d. git add, git commit, git push
4. When all parallel operations complete:
   INSERT into thoughts (ob_uuid, content, embedding, metadata)
5. Return success to the MCP client
```

**Key properties:**

- Client-generated UUID enables parallelization
- Canonicalization happens in the server, matching the SQL trigger,
  so wiki and DB content are byte-identical
- Inference API calls run in parallel with git work, so total wall
  time is approximately max(inference_time, git_time) rather than
  their sum
- Wiki commit-and-push happens before the DB INSERT, so content is
  durable in the git remote before MCP success is returned
- The wiki file has stub `auto:` metadata at commit time; the full
  metadata is populated later by the sync daemon
- A per-process git lock serializes concurrent captures

**Failure mode: simple abort-on-failure.** If any step fails,
attempt to roll back all side effects and return an error to the
client. This guarantees no inconsistent state at the cost of
occasional client-visible errors.

**`list_conflicts()`:** memex-specific MCP tool. Returns the
contents of `sync_state.in_flight_conflicts`. AI agents use this
to surface outstanding conflicts to the operator.

### 9.3 Authentication and Key Rotation

The server supports multiple valid MCP access keys simultaneously
to enable zero-downtime key rotation.

**Key file format:** newline-delimited, comments allowed with `#`
prefix:

```
# current generation, rotated 2026-04-12
k7xN9pQm3vTfR5wLb2zH8jC1sY6dE0aU
# previous generation, deprecated, remove after all clients updated
a3fY2nW7rK4bG9pV6mJ8xQ0sL1zE5dC
```

**Validation:** the auth middleware compares `x-brain-key` header
against each valid key using constant-time comparison. Any match
authorizes the request.

**Reload on change:** the server watches the keys file for
modifications and reloads on change, or on SIGHUP. Key rotation is
zero-downtime.

### 9.4 Health Endpoint

The server exposes a `/health` HTTP endpoint from day one.

**Endpoint:** `GET /health`

**Response (200 OK):**

```json
{
    "status": "ok",
    "version": "memex-mvp-1.0.0",
    "uptime_seconds": 12345,
    "database": { "reachable": true, "latency_ms": 2 },
    "inference": {
        "embedding_reachable": true,
        "chat_reachable": true
    },
    "sync_daemon": {
        "last_successful_sync": "2026-04-12T14:28:30Z",
        "seconds_since_last_sync": 90,
        "in_flight_conflicts_count": 0,
        "last_error": null
    },
    "git": {
        "wiki_repo_clean": true,
        "unpushed_commits": 0
    }
}
```

**Response (503 Service Unavailable):** if any critical component
is unhealthy (database unreachable, wiki repo inaccessible, or last
successful sync >10 minutes ago).

**Authentication:** the health endpoint does not require the
`x-brain-key` header. It returns only operational status, never
content. Rate-limited to prevent DoS.

### 9.5 Role-Based Database Connection

The server connects to PostgreSQL as the `memex_mcp` role. This
role has SELECT, INSERT, and UPDATE privileges on `thoughts` but
**no DELETE privilege**. Any DELETE attempt fails with a permission
error.

This enforces the deletion invariant from Section 5.8 at the
database level, independent of application code correctness.

The sync daemon runs as a separate process and connects as
`memex_sync` with full privileges. The two processes never share a
database connection pool.

## 10. Inference Backends

### 10.1 memex-R: Remote Inference

memex-R is the default and minimum-infrastructure configuration. The
memex server calls a remote inference API (OpenRouter, OpenAI API,
or equivalent) for embedding generation and metadata extraction.

**Configuration:** `EMBEDDING_API_BASE` and `CHAT_API_BASE` point at
the remote provider's OpenAI-compatible API endpoint. API keys are
set via the authentication variables.

**Typical models:**
- Embedding: `openai/text-embedding-3-small` (1536 dimensions)
- Chat: `openai/gpt-4o-mini` or similar cost-effective model

**Two API calls per captured thought:**
- Embedding — produces a 1536-dim vector
- Metadata extraction — returns JSON with topics, people,
  action_items, type, dates_mentioned

**One API call per search query:** embedding for the query string.

**Failure mode:** if the API is unreachable, `capture_thought` fails
and returns an error. Existing content remains queryable (stored
vectors are unaffected). On recovery, operations resume.

### 10.2 memex-L: Local Inference

memex-L uses an on-site inference service (Ollama, vLLM, or similar)
for embedding generation and metadata extraction. The memex server
is unchanged; only the configured API endpoints change.

**Configuration:** `EMBEDDING_API_BASE` and `CHAT_API_BASE` point at
the local service's OpenAI-compatible API endpoint. API keys are
usually empty or placeholder values since local services do not
require authentication.

**Typical models:**
- Embedding: `nomic-embed-text` (768 dims) or `mxbai-embed-large`
  (1536 dims, preferred for schema compatibility with memex-R)
- Chat: any 7B-14B model with structured JSON output support
  (Llama 3.1 8B, Qwen 2.5 7B, Mistral 7B)

**Dependency:** memex-L requires an inference service to be
operational and reachable from the memex instance. The inference
service is an independent deployment concern, not part of the memex
itself.

### 10.3 Migration Path Between Variants

Switching between memex-R and memex-L is a configuration change
plus re-embedding. No code changes, no schema changes (if the
embedding dimension is preserved at 1536).

**Steps:**

1. Deploy or verify the target inference service is reachable
2. If dimensions differ, write a schema migration for the new
   dimension and plan re-embedding
3. Update the four configuration variables
4. Deploy the updated configuration
5. Run re-embed job: iterate every row, regenerate embedding with
   the new model, update the row
6. Verify via test queries

**Re-embed time:** dominated by inference latency. A few thousand
thoughts takes minutes at local speeds; tens of thousands takes an
hour or so.

**Reversibility:** fully reversible by reverting the configuration
and re-embedding again. Wiki content is unchanged; only vectors are
regenerated.

## 11. Relationship to Open Brain (OB1)

### 11.1 Compatibility Matrix

| OB1 component | Compatibility | Notes |
|---|---|---|
| `thoughts` table schema | Baseline | memex uses OB1's init.sql as a starting point and extends additively |
| `match_thoughts` function | Compatible | memex uses the same signature |
| MCP protocol | Compatible | Same four tools with same external behavior |
| Import recipes (Gmail, ChatGPT, etc.) | Compatible | They write to the schema directly; memex's generated columns and triggers auto-populate memex-specific fields |
| OB1 extensions (CRM, meal planning, etc.) | Compatible | They run as separate services with their own schemas |
| OB1 skills (prompt packs) | Compatible | Client-side only |
| OB1 dashboards | Compatible | They query the schema; memex additions are invisible |
| OB1 main Supabase server | N/A | memex has its own server |
| OB1 k8s-deployment server | N/A | Same |

### 11.2 Conceptual Differences

| Axis | OB1 | memex |
|---|---|---|
| Source of truth | Database | Git-backed wiki |
| Primary write path | AI via MCP | Wiki editing + AI via MCP |
| Sync model | None (single store) | Bidirectional wiki ↔ DB |
| Conflict handling | N/A | Explicit detection and operator resolution |
| Multi-user model | Single-user assumed | Per-instance isolation |
| Infrastructure assumptions | Supabase / Docker / K8s | Flexible (depends on adopter) |
| Brand promise | "One database, any AI" | "Git is canonical, any AI can read" |

### 11.3 Planned Contributions from memex to OB1

Some memex-specific improvements are general enough to benefit any
OB1 user:

- **`updated_at` column** for the k8s-deployment schema
- **HNSW vector index** in the k8s-deployment `init.sql`
- **`content_fingerprint` as a generated column**
- **Documentation improvements**
- **Bug fixes** discovered while implementing the memex server

Contributions that are memex-specific are not submitted upstream:

- B3 capture path (depends on git infrastructure)
- `list_conflicts` tool (depends on sync daemon)
- Sync daemon, sync_log, thought_relations

The contribution process: once a memex deployment is stable, reach
out to the OB1 maintainer, discuss which improvements would be
welcome, submit focused PRs.

## 12. Future Features (Not in MVP Scope)

These features are explicitly out of scope for the MVP but are
designed to be addable without architectural restructuring.

### 12.1 Task Lifecycle Tracking

Extract action items from thoughts (memex server already does this
via metadata extraction), then track their state (open, in_progress,
done, blocked, dropped). New `tasks` table with FK to `thoughts`,
new MCP tools, sync daemon handling for a task markdown section.

### 12.2 Attachments

Allow thoughts to reference binary content (images, PDFs, audio).
OCR for PDFs, transcription for audio, description for images.

### 12.3 Rollup Views

AI-generated summaries of recent or topical thoughts. Scheduled job
iterates filtered thoughts, generates summaries, writes back as new
thoughts with `relation_type=summarizes` links to source thoughts.

### 12.4 Backlinks Derivation

Sync daemon parses wiki files for wiki-link syntax and populates
`thought_relations` with `relation_type=links_to` entries. New MCP
tool `find_related_thoughts(id)` combines semantic similarity with
explicit links.

### 12.5 Lexical Search

PostgreSQL `tsvector` column plus GIN index. New MCP tool
`search_thoughts_lexical` for exact-string match. Complements
semantic vector search.

### 12.6 Daily Notes

Sync daemon automatically creates `daily/YYYY-MM-DD.md` at midnight
from a template. AI captures during the day accumulate into this
file.

### 12.7 Near-Duplicate Detection

Periodic job finds thoughts with high cosine similarity to other
thoughts, presents them as near-duplicate clusters for manual merge.

### 12.8 Typed Notes

Frontmatter declares a `type` field beyond the base OB1 types
(`book_review`, `meeting_notes`, `decision_log`, `recipe`,
`contact`). Each type has its own schema.

### 12.9 LISTEN/NOTIFY Real-Time Sync

Replace polling with PostgreSQL LISTEN/NOTIFY. Daemon reacts within
seconds instead of minutes.

### 12.10 Voice Capture

Endpoint that accepts audio uploads, transcribes via Whisper on the
inference service, captures the transcript as a new thought.

### 12.11 Web Clipping

Browser extension or bookmarklet that sends "capture this page" to
a memex endpoint. Server fetches, extracts main content, stores as
a new thought.

### 12.12 Upstream OB1 Contributions

Submit memex-specific improvements (updated_at, HNSW index,
content_fingerprint pattern) as PRs to OB1's k8s-deployment variant.

## 13. Reference Implementations

The mcp-memex project provides the reference implementation of this
architecture. Adopters who want to run a memex on their own
infrastructure should:

1. Read this document (memex-architecture.md) to understand the
   system design
2. Consult their chosen deployment target's integration guide to
   understand how to provision instances, manage secrets, and
   configure networking

**Known deployment integrations:**

- **Mycofu integration** (Dave Wuertele's reference deployment):
  specific to the Mycofu GitOps framework for Proxmox clusters.
  Documents how to deploy mcp-memex as a Mycofu application VM
  with Vault secret delivery, GitLab-hosted wiki repos, and per-user
  isolation. Lives in a separate repository (home-infrastructure).

Additional deployment integrations may be added over time. The
architecture itself is deployment-target-agnostic; only the specific
integration guide is platform-specific.

## 14. Open Questions and Known Unknowns

- **Embedding dimension strategy for memex-L.** Deferred until a
  specific inference service is chosen. Does not affect memex-R.

- **Sync daemon language.** The design describes the daemon in
  pseudocode without committing to a specific implementation
  language. To be decided during implementation. The
  canonicalization function must stay in sync with the server's
  version regardless of language choice.

- **Multi-user operational overhead.** How much friction does
  provisioning new users produce in practice? Depends on deployment
  target.

- **OB1 import recipe compatibility.** OB1 recipes write to the
  schema directly. The memex's additive extensions and generated
  columns should make recipes work unchanged, but this needs
  verification as recipes are actually run against a memex.

- **Mobile access.** How operators access their memex from phones
  and tablets. Options: lightweight web UI, dedicated mobile app,
  Obsidian mobile pointed at the wiki repo, or an MCP client on
  mobile.

## 15. Change Log

| Version | Date | Summary |
|---|---|---|
| draft 1 | 2026-04-12 | Initial draft, extracted from memex-design.md draft 3 (home-infrastructure). Reframed as deployment-independent architecture specification. |

---

*This document is a living design record. Updates should be
committed with clear change log entries and reviewed against
implementation state.*
