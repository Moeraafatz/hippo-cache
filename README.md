<p align="center">
  <img src="assets/logo.svg" alt="hippo-cache — Cure AI Agent Goldfish Amnesia Without Burning Your Token Budget" width="100%" />
</p>

<p align="center">
  <img src="https://img.shields.io/badge/tokens_saved-94.2%25-16A34A?style=flat-square&labelColor=0A0A0A" alt="94.2% Tokens Saved" />
  <img src="https://img.shields.io/badge/fresh_truth-100%25-16A34A?style=flat-square&labelColor=0A0A0A" alt="100% Bi-Temporal Fresh Truth" />
  <img src="https://img.shields.io/badge/multi--hop_PPR-80%25_(4x_RAG)-CA8A04?style=flat-square&labelColor=0A0A0A" alt="80% Multi-Hop PPR Recall" />
  <img src="https://img.shields.io/badge/secrets_leaked-0_(100%25_scrubbed)-DC2626?style=flat-square&labelColor=0A0A0A" alt="Zero Secrets Leaked" />
  <img src="https://img.shields.io/badge/runtime_deps-0_(Node_22_SQLite)-0A0A0A?style=flat-square&labelColor=525252" alt="Zero Runtime Dependencies" />
  <img src="https://img.shields.io/badge/license-MIT-0A0A0A?style=flat-square&labelColor=525252" alt="MIT License" />
</p>

---

## The Problem: Your AI Coding Agent Has a 3-Second Memory (or a \$500 Context Hoarding Habit)

Modern coding agents (**Claude Code**, **Codex CLI**, **Cursor**, **Windsurf**, **Antigravity**) suffer from two equally expensive pathologies:

1. **Goldfish Mode (`/clear`):** You start a fresh session and your agent politely asks whether your repo uses Jest or Vitest, re-reads `package.json` for the 9th time, and re-introduces the exact `pgbouncer` bug you fixed last Tuesday.
2. **Hoarder Mode (2,000-line `CLAUDE.md` / Context Stuffing):** You dump every decision into a flat Markdown file. Within three weeks you are paying to re-transmit thousands of dead tokens every turn, triggering **context rot**, and feeding the model contradictory facts from four migrations ago.

**`hippo-cache`** fixes both. It is a **portable Agent Skill (`SKILL.md`) backed by a zero-dependency local cognitive memory engine** (MCP Server + CLI + optional monochrome B&W web graph inspector) built on Node 22's native `node:sqlite` + FTS5.

- **No cloud database.** Single portable `.hippo-cache/memory.db` (SQLite WAL mode).
- **No external API keys or GPUs required.** 512-d deterministic feature-hashed vectors + FTS5 BM25 + Personalized PageRank run locally in **~1.48 ms p50**.
- **No bloated framework install.** Zero third-party `node_modules`.
- **No neon cyberpunk eye-strain.** Strict black-and-white instrumentation with semantic traffic-light indicators only: **Green** (`ACTIVE`), **Yellow** (`DECAYING` / `SUPERSEDED`), **Red** (`STALE` / `ARCHIVED` / `SECRET_REDACTED`).

---

## Lab Benchmarks: The Goldfish Tax (Measured, Not Hallucinated)

Every chart below is generated straight from our reproducible 50-turn multi-session engineering benchmark (`npm run bench` → [`benchmarks/results.json`](benchmarks/results.json)), simulating 60 repository memories across 14 days including **8 real stack migrations/contradictions**, **5 two-hop causal debugging chains**, near-duplicate logs, and **3 accidental credential leaks**.

<p align="center">
  <img src="assets/token-burn-graph.svg" alt="The Goldfish Tax: Cumulative Token Spend Over 50 Turns" width="100%" />
</p>

### Head-to-Head Results (50 Coding-Agent Turns)

| Architecture | 50-Turn Tokens | Avg Tok / Turn | Token Reduction | Recall@Budget | Fresh Truth (Contradictions) | 2-Hop Associative Recall | p50 Latency |
| :--- | :---: | :---: | :---: | :---: | :---: | :---: | :---: |
| **Naive Full-Context Dump** | 191,300 | 3,826 | 0.0% | 100.0% | 0.0% *(polluted)* | 100.0% | — |
| **Sliding Window (Recent-10)** | 28,600 | 572 | 85.0% | 0.0% | 0.0% | 0.0% | — |
| **Vector-Only Top-8 RAG** | 20,425 | 409 | 89.3% | 70.0% | 0.0% *(stale ghosts)* | 20.0% | 0.04 ms |
| **`hippo-cache` (ACT-R + PPR + Knapsack)** | **11,159** | **223** | **94.2%** | **94.0%** | **100.0%** *(8/8 clean)* | **80.0%** *(4× RAG)* | **1.48 ms** |

> **Write-path Secret Firewall:** `3/3 (100%)` injected OpenAI keys, GitHub tokens, and Redis URL passwords were automatically redacted **before** touching SQLite.

<p align="center">
  <img src="assets/benchmark-comparison.svg" alt="hippo-cache Lab Benchmark Scorecard" width="100%" />
</p>

---

## Scientific Architecture (Grounded in MIT & University Research)

`hippo-cache` is not another wrapper around naive `cosine(query, chunk)`. Every stage of the write, read, and sleep pipeline implements a formal mechanism from cognitive science, information retrieval, and AI agent systems research (full mathematical notes in [`docs/RESEARCH.md`](docs/RESEARCH.md)):

<p align="center">
  <img src="assets/architecture-diagram.svg" alt="Inside the Hippo: 4-Tier Cognitive Memory Engine" width="100%" />
</p>

### 1. Progressive 3-Tier Disclosure — *MIT CSAIL Recursive Language Models (RLM)*
Inspired by **Zhang, Kraska & Khattab (MIT CSAIL, [`arXiv:2512.24601`](https://arxiv.org/abs/2512.24601))** and **LLMLingua ([`arXiv:2310.05736`](https://arxiv.org/abs/2310.05736))**, raw memory lives externally in SQLite instead of bloating the attention window:
- **`L0` Handle (~14 tokens):** `[mem_a1b2 | semantic | L0 | ACTIVE] Migrated unit test runner from Jest to Vitest`
- **`L1` Extractive Abstract (~48 tokens):** Salience-scored key sentences preserving exact file paths, flags, and code identifiers with zero LLM hallucination.
- **`L2` Verbatim Payload (on-demand):** Hydrated losslessly via `memory_expand([ids])` only when the agent actually edits that subsystem.

### 2. ACT-R Power-Law Decay & Ebbinghaus Spacing
Grounded in **Anderson & Schooler (1991, CMU)** and **Generative Agents (Stanford, [`arXiv:2304.03442`](https://arxiv.org/abs/2304.03442))**:

$$B_i(t) = \ln\!\left(\sum_{j=1}^{n} \max\!\left(\frac{t - t_j}{\tau \cdot S_i},\,\epsilon\right)^{-d_{\text{kind}}}\right) + \beta_{\text{kind}} + \gamma (I_i - 0.5)$$

Memories re-accessed across spaced sessions grow their stability multiplier $S_i$ (the spacing effect) and stay sharp in the **Green** zone ($\sigma(B_i) \ge 0.55$). Ephemeral `working` scratchpads decay rapidly past **Yellow** into **Red** auto-archive without polluting future prompts.

<p align="center">
  <img src="assets/forgetting-curve.svg" alt="Ebbinghaus vs Coding Agents ACT-R Forgetting Curve" width="100%" />
</p>

### 3. Hippocampal Associative Indexing via Personalized PageRank (PPR)
Grounded in **HippoRAG ([`arXiv:2405.14831`](https://arxiv.org/abs/2405.14831))**, **HippoRAG 2 ([`arXiv:2502.14802`](https://arxiv.org/abs/2502.14802))**, and **A-MEM Zettelkasten Linking ([`arXiv:2502.12110`](https://arxiv.org/abs/2502.12110))**:
- Code paths (`src/auth/jwtVerifier.ts`), symbols (`pgbouncer_pool`), tech terms, and tags form an IDF-weighted bipartite `Memory ↔ Entity` graph augmented with Zettelkasten edges (`RELATES_TO`, `FIXES`, `DEPENDS_ON`, `DERIVED_FROM`).
- Hybrid FTS5 BM25 + 512-d Signed Feature Hashing (Weinberger et al., ICML 2009) seeds are fused via **Reciprocal Rank Fusion (RRF)** and propagated via **Personalized PageRank** ($r^{(k+1)} = \alpha s + (1-\alpha) P^T r^{(k)}$), separating edge-propagated mass $a_i = \max(0, r_i - \alpha s_i)$ so **2-hop memories with zero lexical overlap** surface reliably (80% vs 20% for flat Vector RAG).

### 4. Bi-Temporal Fact Tracking & Automatic Contradiction Resolution
Grounded in **Zep / Graphiti ([`arXiv:2501.13956`](https://arxiv.org/abs/2501.13956))**:
- Every memory tracks **valid time** (`valid_from`, `valid_until`) independently from **transaction time** (`created_at`).
- When your agent stores `"Migrated unit test runner from Jest to Vitest"` or updates a decision slot (`test_runner`, `session_store`, `port_config`, `orm_layer`), the older fact is automatically marked `SUPERSEDED` with a directed `SUPERSEDES` graph edge.
- Default recalls return **100% current truth**; passing `--as-of 2026-01-15T00:00:00Z` performs exact historical time-travel recall.

### 5. Submodular Marginal-Gain Knapsack Packing
Grounded in **Lin & Bilmes (ACL 2011)**:
- Enforces a strict token cap (`budget_tokens`) by greedily maximizing marginal relevance minus pairwise cosine redundancy per token cost:

$$m^* = \arg\max_{m \in \mathcal{C} \setminus S} \frac{\text{Score}(m, q)\cdot\left(1 - \lambda \max_{s \in S}\text{Sim}(m, s)\right)}{\text{tokens}_k(m)^{\gamma}}$$

### 6. 4-Store Cognitive Hierarchy, Sleep Consolidation & Governance
Grounded in **CoALA (Princeton, [`arXiv:2309.02427`](https://arxiv.org/abs/2309.02427))**, **MemGPT (UC Berkeley, [`arXiv:2310.08560`](https://arxiv.org/abs/2310.08560))**, and **MIT SEAL ([`arXiv:2506.10943`](https://arxiv.org/abs/2506.10943))**:
- Distinct stores (`working`, `episodic`, `semantic`, `procedural`), SHA-256 + 64-bit Charikar SimHash deduplication, pre-write secret redaction (OpenAI, Anthropic, GitHub, AWS, Stripe, Google, Slack, JWT, PEM, DB URLs), and cognitive sleep consolidation (`hippo-cache sleep`) that merges episodic noise, promotes recurring clusters into distilled procedural/semantic playbooks, and archives cold memories.

---

## Quick Start (60 Seconds)

**Requirement:** Node.js `>= 22.5.0` (uses built-in `node:sqlite` + FTS5; zero `npm install` dependencies required).

```bash
git clone https://github.com/Moeraafatz/hippo-cache.git
cd hippo-cache
npm link

# Verify Node 22+ & native SQLite FTS5
hippo-cache doctor
```

### One-Command Setup for Your Coding Agents

Inside any project repository:

```bash
# Install portable SKILL.md + MCP config for Claude Code, Codex CLI, Cursor, Windsurf & Antigravity
hippo-cache init all

# Or target specific agents only
hippo-cache init claude,cursor,codex
```

What `hippo-cache init all` creates cleanly (non-destructively merging existing MCP configs):

| Agent | Installed Files |
| :--- | :--- |
| **Claude Code** | `.claude/skills/hippo-cache/SKILL.md` + `.mcp.json` |
| **Codex CLI** | `.codex/skills/hippo-cache/SKILL.md` + `.codex/hippo-cache.config.toml` |
| **Cursor** | `.cursor/rules/hippo-cache.mdc` + `.cursor/mcp.json` |
| **Windsurf** | `.windsurf/rules/hippo-cache.md` |
| **Antigravity** | `.agent/skills/hippo-cache/SKILL.md` |

<details>
<summary>Manual MCP Config Snippets (Claude Code / Cursor / Codex CLI)</summary>

**Claude Code (`.mcp.json`) & Cursor (`.cursor/mcp.json`):**
```json
{
  "mcpServers": {
    "hippo-cache": {
      "command": "node",
      "args": [
        "--no-warnings=ExperimentalWarning",
        "/path/to/hippo-cache/bin/hippo-cache.js",
        "mcp",
        "--db", ".hippo-cache/memory.db",
        "--ns", "default"
      ]
    }
  }
}
```

**Codex CLI (`~/.codex/config.toml`):**
```toml
[mcp_servers.hippo-cache]
command = "node"
args = ["--no-warnings=ExperimentalWarning", "/path/to/hippo-cache/bin/hippo-cache.js", "mcp", "--db", ".hippo-cache/memory.db", "--ns", "default"]
```

</details>

---

## How to Use

### Via MCP Tools (Automatic When Agent Reads `SKILL.md`)

| MCP Tool | Purpose | Token Impact |
| :--- | :--- | :--- |
| `memory_recall` | Hybrid FTS5 + 512-d vector + HippoRAG PPR + ACT-R + Submodular Knapsack recall | Strict cap (default `550` tok, `auto` L1+L0) |
| `memory_expand` | MIT RLM-style verbatim `L2` hydration + graph neighbors for selected `mem_*` IDs | Only pays for IDs you explicitly expand |
| `memory_remember` | Store memory with secret firewall, SimHash dedup, bi-temporal contradiction check & auto-linking | Returns compact JSON status |
| `memory_consolidate` | Cognitive sleep cycle: refresh ACT-R, merge episodic duplicates, promote clusters, archive noise | Compresses long-term store |
| `memory_graph` | Inspect associative memory nodes, edges, entity hubs & Green/Yellow/Red health | Structured JSON graph |
| `memory_timeline` | Bi-temporal audit log of recent facts and automatic contradiction supersessions | Audit-ready diff trail |
| `memory_forget` | Soft-archive a memory (`valid_until = now`) while preserving historical auditability | Removes from active recalls |
| `memory_stats` | Live token-savings telemetry, health counts, latency & secret redactions | Diagnostic summary |

### Via CLI (Hooks, Scripts, or Headless Agents)

```bash
# Store architectural decisions & procedural bug-fix playbooks
hippo-cache remember "Unit tests run with Jest via npm test." --kind semantic --slot test_runner
hippo-cache remember "Migrated unit test runner from Jest to Vitest; run pnpm vitest run." --kind semantic --slot test_runner

# Budgeted recall (returns ONLY Vitest, never stale Jest!)
hippo-cache recall "how do we run unit tests" --budget 350

# Time-travel recall before migration
hippo-cache recall "how do we run unit tests" --as-of "2026-01-01T00:00:00Z"

# Expand verbatim L2 payload + linked graph edges
hippo-cache expand mem_a1b2c3d4e5

# Run cognitive sleep cycle & check health stats
hippo-cache sleep
hippo-cache stats
```

### Optional Monochrome Web Graph Inspector (`hippo-cache ui`)

Want to visually inspect your agent's hippocampus, test recall budgets interactively, or audit contradictions? Launch the local zero-dependency browser viewer (strict B&W + Red/Green/Yellow indicators — zero neon):

```bash
hippo-cache ui --port 4747 --seed
# Opens API + SSE live dashboard at http://127.0.0.1:4747
# Also exposes Streamable HTTP MCP at POST http://127.0.0.1:4747/mcp
```

---

## Best-Case Use Cases

1. **Multi-Week Stack & Framework Migrations (Zero Stale Ghosts)**
   Migrating from Jest → Vitest, REST → tRPC, TypeORM → Drizzle, or Postgres → Redis sessions? Bi-temporal supersession quarantines superseded facts automatically so agents stop generating deprecated code patterns.
2. **Two-Hop Production Incident Playbooks**
   When an agent investigates `checkout_latency`, HippoRAG PPR automatically walks `checkout_latency → pgbouncer_pool → prepareThreshold=0 in src/db/pool.ts` even though the fix note never mentions the word `"checkout"`.
3. **Cross-Agent Shared Project Memory**
   Use Claude Code in the terminal, Cursor in the editor, and Codex CLI for background PRs — all pointing to the same local `.hippo-cache/memory.db` via MCP. One agent's debugging discovery instantly helps every other agent.
4. **High-Volume Token Budget Discipline**
   Keep context crisp under 350–550 tokens per turn instead of burning 4,000+ tokens re-injecting monolithic instruction files. Saves **94.2%** cumulative tokens over 50 turns while maintaining **94%** recall.
5. **Security-First Agent Workflows**
   Engineers inevitably paste logs containing `sk-proj-*`, `ghp_*`, JWTs, or `postgres://user:pass@host` URLs. The write-path Shannon-entropy + pattern firewall scrubs credentials *before* disk persistence.
6. **Postmortem Time-Travel Debugging**
   Query `--as-of` any past timestamp to reconstruct exact system architecture invariants as they existed during an older release.

---

## Indicator Legend (Strict Monochrome + Traffic Light)

| Indicator | State | Meaning |
| :---: | :--- | :--- |
| **GREEN** (`#16A34A`) | `ACTIVE` / `SAVED` / `OK` | High ACT-R activation ($\sigma(B_i) \ge 0.55$), currently valid, or verified token savings. |
| **YELLOW** (`#CA8A04`) | `DECAYING` / `SUPERSEDED` | Fading activation ($0.25 \le \sigma < 0.55$) or bi-temporally replaced by newer truth. |
| **RED** (`#DC2626`) | `STALE` / `ARCHIVED` / `REDACTED` | Cold-archived noise ($\sigma < 0.25$), naive context bloat, or blocked credential leak. |

---

## Verification & Reproducibility

Run the full test suite, deterministic 50-turn benchmark, and SVG asset generator locally:

```bash
npm test          # 9 unit & integration tests (ACT-R, PPR, knapsack, contradictions, secret firewall, MCP, CLI)
npm run bench     # Re-runs 50-turn benchmark and updates benchmarks/results.json
npm run assets    # Re-generates all 5 monochrome B&W SVG charts from benchmarks/results.json
```

---

## Academic References

- **MIT CSAIL — Recursive Language Models (RLM):** A. L. Zhang, T. Kraska, O. Khattab, [*Recursive Language Models*](https://arxiv.org/abs/2512.24601) (`arXiv:2512.24601`, 2025).
- **MIT CSAIL — Self-Adapting Language Models (SEAL):** Zweiger et al., [*Self-Adapting Language Models*](https://arxiv.org/abs/2506.10943) (`arXiv:2506.10943`, 2025).
- **OSU / Stanford — HippoRAG & HippoRAG 2:** B. J. Gutiérrez et al., [*HippoRAG: Neurobiologically Inspired Long-Term Memory for LLMs*](https://arxiv.org/abs/2405.14831) (`arXiv:2405.14831`, 2024) & [*From RAG to Memory*](https://arxiv.org/abs/2502.14802) (`arXiv:2502.14802`, 2025).
- **Rutgers / Salesforce — A-MEM:** W. Xu et al., [*A-Mem: Agentic Memory for LLM Agents*](https://arxiv.org/abs/2502.12110) (`arXiv:2502.12110`, 2025).
- **Zep / Graphiti — Bi-Temporal Knowledge Graph:** P. Rasmussen et al., [*Zep: A Temporal Knowledge Graph Architecture for Agent Memory*](https://arxiv.org/abs/2501.13956) (`arXiv:2501.13956`, 2025).
- **Princeton — CoALA:** T. R. Sumers, S. Yao, K. Narasimhan, T. L. Griffiths, [*Cognitive Architectures for Language Agents*](https://arxiv.org/abs/2309.02427) (`arXiv:2309.02427`, 2023).
- **UC Berkeley — MemGPT:** C. Packer et al., [*MemGPT: Towards LLMs as Operating Systems*](https://arxiv.org/abs/2310.08560) (`arXiv:2310.08560`, 2023).
- **Stanford — Generative Agents:** J. S. Park et al., [*Generative Agents: Interactive Simulacra of Human Behavior*](https://arxiv.org/abs/2304.03442) (`arXiv:2304.03442`, 2023).
- **Microsoft Research — LLMLingua:** H. Jiang et al., [*LLMLingua: Compressing Prompts for Accelerated Inference of LLMs*](https://arxiv.org/abs/2310.05736) (`arXiv:2310.05736`, 2023).
- **CMU — ACT-R Rational Memory:** J. R. Anderson & L. J. Schooler, *Reflections of the Environment in Memory*, Psychological Science, 1991.
- **UW / ACL — Submodular Summarization:** H. Lin & J. Bilmes, *A Class of Submodular Functions for Document Summarization*, ACL 2011.
- **Waterloo / SIGIR — Reciprocal Rank Fusion:** G. V. Cormack, C. L. A. Clarke & S. Büttcher, *Reciprocal Rank Fusion Outperforms Condorcet and Individual Rank Learning Methods*, SIGIR 2009.
- **Yahoo Research / ICML — Feature Hashing:** K. Weinberger et al., *Feature Hashing for Large Scale Multitask Learning*, ICML 2009.

---

## License

MIT © [RAFBUG (Moeraafatz)](LICENSE)
