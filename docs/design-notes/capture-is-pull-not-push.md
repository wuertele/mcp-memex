# Capture is pull, not push

**Status:** Design note for Sprint 001 consideration
**Date:** 2026-04-12

## The problem

MCP tools are invoked only when the model decides to invoke them. There is
no "post-turn write" affordance in the protocol. Enabling the mcp-memex
connector in a client is necessary but not sufficient for capture to
actually happen. Observed in practice with Open Brain (OB1): LLMs do not
automatically send content to the MCP server even though the connector is
enabled and advertised.

Compare:

- **Built-in model memory** (Claude projects, ChatGPT memory): privileged
  write path baked into the model's training and system prompt. Fires
  autonomously.
- **Client-side memory files** (Claude Code `CLAUDE.md`, auto-memory skill):
  instruction is present in the context every turn, so the model writes
  reliably.
- **MCP connectors**: just a tool list. The model calls `memex.capture()`
  only when the user's request implies it. "Remember this" usually works.
  "Let me think through X" usually doesn't — even when X is exactly the
  kind of insight we'd want captured.

## What actually makes capture fire

Three mechanisms, in increasing order of reliability:

1. **Explicit user ask** ("save this to memex"). Works, defeats the purpose.
2. **System prompt / project instructions** telling the model to capture
   proactively. Works moderately. Degrades over long contexts as the
   instruction drifts out of attention.
3. **Client-side hooks** (Claude Code `PostToolUse` / `Stop` hooks, or
   equivalent). A hook shells out to a script that posts to the MCP server
   directly, bypassing the model's volition entirely. This is how Claude
   Code's auto-memory actually works in practice.

Mechanism 3 is the only reliable path. Mechanism 2 is the fallback for
clients that don't expose hooks.

## Implications for mcp-memex

The current roadmap implicitly assumes "the LLM calls `memex.capture` when
appropriate." That assumption is weak and will produce a memex that users
enable, forget, and abandon.

Two design moves to consider before or during Sprint 001:

1. **Ship a capture hook alongside the MCP server.** A Claude Code `Stop`
   hook (and equivalents for Codex / Cursor / Gemini as they grow hook
   support) that posts the last turn to memex regardless of whether the
   model asked. Users install it once; capture becomes ambient. This is
   the Karpathy-wiki insight applied to capture: the protocol is the
   filesystem/hook, not the model's goodwill.

2. **Ship a terse, directive `memex.md` contract** that users drop in
   their project root or global config. One paragraph: "On any
   substantive decision, trade-off, or insight, call `memex.capture`.
   Prefer over-capturing to under-capturing." Short enough to stay in
   attention, directive enough to actually fire.

Both are cheap. Together they turn mcp-memex from "a tool the model *can*
use" into "an ambient memory the model *does* use." Without them, the
well-designed server on the backend is invisible in practice.

## Honest framing

This is not a bug in OB1 or in any specific client. It is a structural
property of MCP today. Any MCP-based memex will have the same problem
until the protocol grows a post-turn write hook at the spec level. Until
then, the workaround lives on the client side, and the mcp-memex README
should say so on page one.

## Open questions for Sprint 001 scoping

- Does Sprint 001 (or wherever the first end-to-end capture path lands)
  include a reference hook script, or is that deferred?
- What's the minimum `memex.md` contract we can ship that works across
  Claude Code, Codex, Cursor, and Gemini CLI without per-client
  customization?
- Should mcp-memex include a "capture health" check that an operator can
  run to see whether captures are actually landing, or whether the
  connector is enabled-but-silent?
- Is there a way to detect the "enabled-but-silent" failure mode from
  the server side (e.g. a client that announces the tool list but never
  calls any tool) and warn the user?
