---
name: hippo-cache
description: Token-frugal cognitive memory protocol for AI coding agents (Claude Code, Codex CLI, Cursor, Windsurf, Antigravity). Uses ACT-R activation decay, HippoRAG Personalized PageRank, bi-temporal contradiction resolution, and submodular knapsack token packing over local SQLite.
---

# hippo-cache — Cognitive Memory Protocol

Use `hippo-cache` instead of dumping entire files, transcripts, or bloated `CLAUDE.md` histories into context.

## Core Rules (Token-Frugal Memory Discipline)

1. **Recall Before Re-Reading (`memory_recall`)**
   - At session start or before touching an unfamiliar module, call `memory_recall` with `disclosure: "auto"` and a tight budget (`budget_tokens: 450` to `700`).
   - Do NOT ask for `disclosure: "l2"` up front. Read compact `L0` handles (~14 tokens) and `L1` abstracts (~48 tokens) first.

2. **Expand Selectively (MIT RLM Pattern — `memory_expand`)**
   - Only call `memory_expand` on the specific `mem_*` IDs whose exact commands, file paths, or full rationale you need for the active edit.
   - Leave peripheral memories at `L0`/`L1` to avoid context rot.

3. **Write High-Signal Memories Only (`memory_remember`)**
   - Store four distinct memory kinds cleanly:
     - `semantic`: architectural decisions, stack choices, API contracts, service ports, invariants.
     - `procedural`: recurring bug root-causes, exact fix playbooks, non-obvious build/test commands, repo pitfalls.
     - `episodic`: specific debugging discoveries, incident findings, failed experiments to avoid repeating.
     - `working`: temporary multi-step task checkpoints (decays fast unless promoted).
   - Never dump raw file contents, diffs, or credentials. (The write-path scrubber automatically redacts leaked keys/tokens, but avoid passing secrets.)

4. **Resolve Contradictions Explicitly (Bi-Temporal Truth)**
   - When the codebase changes (e.g. migrating frameworks, changing ports, swapping databases), write the update with explicit transition phrasing (`"Migrated unit tests from Jest to Vitest"`) and/or pass `slot_key` (e.g. `test_runner`, `session_store`, `auth_strategy`, `port_config`).
   - `hippo-cache` automatically marks the old fact `superseded` (`valid_until = now`) and preserves audit history without polluting future recalls.

5. **Run Periodic Sleep Consolidation (`memory_consolidate`)**
   - After large refactors or long debugging sessions, run `memory_consolidate` to refresh ACT-R decay scores, merge near-duplicate episodes, promote recurring patterns to procedural/semantic rules, and archive stale noise.

## CLI Fallback (When MCP Is Not Connected)

If MCP tools are unavailable in the current shell environment, invoke the local CLI directly:

```bash
# Budgeted recall (returns compact L0/L1 context block)
hippo-cache recall "auth session store timeout" --budget 500

# Expand verbatim L2 payload for specific IDs
hippo-cache expand mem_a1b2c3d4e5

# Store a decision or bug-fix playbook
hippo-cache remember "Migrated unit test runner from Jest to Vitest; run with pnpm vitest run." \
  --kind semantic --slot test_runner --tags testing,vitest

# Run cognitive sleep cycle
hippo-cache sleep
```

## Indicator Legend (Strict Monochrome + Traffic-Light Semantics)

- **GREEN (`ACTIVE`)**: High ACT-R activation ($\sigma \ge 0.55$) and currently valid. Trust and use directly.
- **YELLOW (`DECAYING` / `SUPERSEDED`)**: Fading activation or replaced by a newer fact. Verify or inspect supersession chain before relying on it.
- **RED (`STALE` / `ARCHIVED` / `SECRET_REDACTED`)**: Cold-archived noise or blocked credential leak. Excluded from default recall.
