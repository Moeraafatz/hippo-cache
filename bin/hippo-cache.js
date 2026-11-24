#!/usr/bin/env node
import process from 'node:process';
import path from 'node:path';
import fs from 'node:fs';
import { HippoCacheEngine } from '../src/core/engine.js';
import { seedDemoMemories } from '../src/core/demo.js';
import { startStdioMcpServer } from '../src/mcp/server.js';
import { createHttpServer } from '../src/server/http.js';
import { installAgentAdapters } from '../src/adapters/installer.js';

// Strict Monochrome + Semantic Traffic-Light ANSI palette (no neon!)
const ANSI = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  red: '\x1b[31m'
};

function dot(color) {
  if (color === 'green') return `${ANSI.green}●${ANSI.reset}`;
  if (color === 'yellow') return `${ANSI.yellow}●${ANSI.reset}`;
  if (color === 'red') return `${ANSI.red}●${ANSI.reset}`;
  return '○';
}

function parseArgs(argv) {
  const positional = [];
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg.startsWith('--')) {
      const key = arg.slice(2);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith('--')) {
        flags[key] = next;
        i++;
      } else {
        flags[key] = true;
      }
    } else if (arg.startsWith('-') && arg.length === 2) {
      const key = arg.slice(1);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith('-')) {
        flags[key] = next;
        i++;
      } else {
        flags[key] = true;
      }
    } else {
      positional.push(arg);
    }
  }
  return { positional, flags };
}

function printHelp() {
  console.log(`
${ANSI.bold}hippo-cache v1.0.0${ANSI.reset} — Scientific, token-frugal cognitive memory for AI coding agents
${ANSI.dim}ACT-R Decay · HippoRAG PPR · Bi-Temporal Contradictions · Submodular Knapsack · Local SQLite${ANSI.reset}

${ANSI.bold}USAGE${ANSI.reset}
  hippo-cache <command> [options]

${ANSI.bold}COMMANDS${ANSI.reset}
  init [targets]         Install portable Skill (SKILL.md) + MCP config
                         Targets: all (default), claude, codex, cursor, windsurf, antigravity
  mcp                    Start stdio MCP server (for Claude Code, Codex, Cursor, Antigravity)
  ui | serve             Start optional monochrome B&W web graph viewer + REST/MCP HTTP API
  remember "<text>"      Store memory (auto-scrubs secrets, deduplicates, resolves contradictions)
  recall "<query>"       Budgeted recall with L0/L1 progressive disclosure
  expand <id1,id2>       Hydrate full verbatim L2 payload + graph neighborhood
  sleep | consolidate    Run cognitive sleep cycle (ACT-R refresh, merge, promote, archive)
  forget <id>            Soft-archive memory while keeping bi-temporal audit log
  stats                  Show token savings, health distribution (${dot('green')} / ${dot('yellow')} / ${dot('red')}), graph metrics
  timeline               Show bi-temporal fact history & contradiction resolutions
  seed                   Seed realistic demo dataset (migrations, PPR chains, secret redaction)
  doctor                 Verify Node >=22.5, SQLite FTS5, and database health

${ANSI.bold}GLOBAL FLAGS${ANSI.reset}
  --db <path>            SQLite database path (default: .hippo-cache/memory.db)
  --ns <name>            Project namespace (default: default)
  --json                 Output raw JSON

${ANSI.bold}EXAMPLES${ANSI.reset}
  hippo-cache init all
  hippo-cache remember "Migrated tests from Jest to Vitest" --kind semantic --slot test_runner
  hippo-cache recall "how to run unit tests" --budget 400
  hippo-cache ui --port 4747 --seed
`);
}

async function main() {
  const { positional, flags } = parseArgs(process.argv.slice(2));
  const cmd = positional[0];
  const dbPath = String(flags.db || process.env.HIPPO_CACHE_DB || '.hippo-cache/memory.db');
  const ns = String(flags.ns || flags.namespace || process.env.HIPPO_CACHE_NS || 'default');
  const asJson = Boolean(flags.json);

  if (!cmd || cmd === 'help' || flags.help || flags.h) {
    printHelp();
    process.exit(0);
  }

  if (cmd === 'mcp') {
    startStdioMcpServer({ dbPath, namespace: ns });
    return;
  }

  if (cmd === 'ui' || cmd === 'serve') {
    const port = Number(flags.port || flags.p || 4747);
    const host = String(flags.host || '127.0.0.1');
    const { server, engine } = createHttpServer({ dbPath, namespace: ns });
    if (flags.seed || flags.demo) {
      const existing = engine.getStats(ns).counts.total;
      if (existing === 0) seedDemoMemories(engine, ns);
    }
    server.listen(port, host, () => {
      console.log(`${dot('green')} ${ANSI.bold}hippo-cache ui${ANSI.reset} listening at http://${host}:${port}`);
      console.log(`  db: ${path.resolve(dbPath)}  |  ns: ${ns}  |  http-mcp: POST /mcp`);
    });
    return;
  }

  if (cmd === 'init') {
    const rawTargets = positional.slice(1);
    const targets = rawTargets.length > 0 ? rawTargets.flatMap((t) => t.split(',')) : ['all'];
    const targetDir = path.resolve(String(flags.dir || process.cwd()));
    const useLocalBin = flags.npx ? false : true;
    const res = installAgentAdapters({ targetDir, targets, dbPath, namespace: ns, useLocalBin });
    if (asJson) {
      console.log(JSON.stringify(res, null, 2));
    } else {
      console.log(`${dot('green')} Installed hippo-cache Skill & MCP configs for: ${res.targets.join(', ')}`);
      for (const f of res.files) {
        console.log(`  + ${path.relative(targetDir, f) || f}`);
      }
      console.log(`\n${ANSI.dim}Next: restart Claude Code / Codex / Cursor, or run \`hippo-cache ui --seed\` to inspect.${ANSI.reset}`);
    }
    return;
  }

  if (cmd === 'doctor') {
    const nodeVer = process.versions.node;
    const major = Number(nodeVer.split('.')[0]);
    const minor = Number(nodeVer.split('.')[1]);
    const nodeOk = major > 22 || (major === 22 && minor >= 5);
    let sqliteOk = false;
    let sqliteVer = 'unavailable';
    try {
      const engine = new HippoCacheEngine(':memory:');
      sqliteVer = engine.db.prepare('SELECT sqlite_version() AS v').get().v;
      sqliteOk = true;
      engine.close();
    } catch {
      sqliteOk = false;
    }
    const dbExists = fs.existsSync(dbPath);
    console.log(`${ANSI.bold}hippo-cache doctor${ANSI.reset}`);
    console.log(`  ${dot(nodeOk ? 'green' : 'red')} Node.js: v${nodeVer} (requires >=22.5.0)`);
    console.log(`  ${dot(sqliteOk ? 'green' : 'red')} Native SQLite + FTS5: ${sqliteVer}`);
    console.log(`  ${dot(dbExists ? 'green' : 'yellow')} Database: ${path.resolve(dbPath)} (${dbExists ? 'present' : 'will initialize on first write'})`);
    process.exit(nodeOk && sqliteOk ? 0 : 1);
  }

  const engine = new HippoCacheEngine(dbPath);
  try {
    if (cmd === 'remember') {
      const content = positional.slice(1).join(' ').trim();
      if (!content) {
        console.error(`${dot('red')} Missing memory text. Example: hippo-cache remember "Switched tests from Jest to Vitest"`);
        process.exit(1);
      }
      const tags = flags.tags ? String(flags.tags).split(',').map((s) => s.trim()).filter(Boolean) : [];
      const res = engine.remember({
        namespace: ns,
        content,
        title: flags.title ? String(flags.title) : undefined,
        kind: flags.kind ? String(flags.kind) : 'semantic',
        tags,
        slotKey: flags.slot ? String(flags.slot) : null,
        importance: flags.importance !== undefined ? Number(flags.importance) : 0.65,
        supersedes: flags.supersedes ? String(flags.supersedes) : null,
        source: 'cli'
      });

      if (asJson) {
        console.log(JSON.stringify(res, null, 2));
      } else {
        const indicator = res.secretsRedacted > 0 ? 'red' : res.superseded.length > 0 ? 'yellow' : 'green';
        console.log(`${dot(indicator)} [${res.action}] ${ANSI.bold}${res.memory.id}${ANSI.reset} (${res.memory.kind}) — ${res.memory.title}`);
        console.log(`  tokens: L0=${res.memory.tokens_l0} | L1=${res.memory.tokens_l1} | L2=${res.memory.tokens_l2}  |  slot=${res.memory.slot_key || 'none'}`);
        if (res.secretsRedacted > 0) {
          console.log(`  ${dot('red')} Redacted ${res.secretsRedacted} secret(s): ${res.secretFindings.join(', ')}`);
        }
        for (const s of res.superseded) {
          console.log(`  ${dot('yellow')} Superseded ${s.older_memory_id}: "${s.older_title}" (${s.reason})`);
        }
        if (res.linkedEdges && res.linkedEdges.length > 0) {
          console.log(`  ${dot('green')} Linked ${res.linkedEdges.length} Zettelkasten edge(s)`);
        }
      }
    } else if (cmd === 'recall') {
      const query = positional.slice(1).join(' ').trim();
      const budget = Number(flags.budget || 550);
      const disclosure = String(flags.disclosure || 'auto');
      const asOf = flags['as-of'] ? Date.parse(String(flags['as-of'])) : null;
      const res = engine.recall({
        namespace: ns,
        query,
        budgetTokens: budget,
        disclosure,
        asOf: Number.isFinite(asOf) ? asOf : null,
        includeSuperseded: Boolean(flags['include-superseded'])
      });
      if (asJson) {
        console.log(JSON.stringify(res, null, 2));
      } else {
        console.log(res.context_block);
        console.log(
          `\n${dot('green')} ${res.memories.length} memories | ${res.tokens_used}/${res.budget_tokens} tokens | saved ${res.savings_pct}% (${res.tokens_saved} tok vs naive ${res.naive_tokens}) | ${res.latency_ms}ms`
        );
      }
    } else if (cmd === 'expand') {
      const ids = positional.slice(1).flatMap((x) => x.split(',')).filter(Boolean);
      const res = engine.expand(ids, '*');
      if (asJson) {
        console.log(JSON.stringify(res, null, 2));
      } else {
        for (const m of res.memories) {
          console.log(`${dot(m.health.color)} ${ANSI.bold}${m.id}${ANSI.reset} [${m.kind} | ${m.health.label} | ACT-R=${m.activation}]`);
          console.log(`Title: ${m.title}`);
          console.log(`Content:\n${m.content}`);
          if (m.entities.length) console.log(`Entities: ${m.entities.map((e) => e.name).join(', ')}`);
          if (m.edges.length) {
            console.log(`Edges: ${m.edges.map((e) => `${e.source_id} -[${e.relation}]-> ${e.target_id}`).join(' ; ')}`);
          }
          console.log('');
        }
      }
    } else if (cmd === 'sleep' || cmd === 'consolidate') {
      const res = engine.consolidate(ns, {
        archiveThreshold: flags.threshold ? Number(flags.threshold) : 0.22
      });
      if (asJson) {
        console.log(JSON.stringify(res, null, 2));
      } else {
        console.log(`${dot('green')} Sleep cycle complete (${res.latency_ms}ms)`);
        console.log(`  refreshed=${res.refreshed}  merged=${res.merged_duplicates}  promoted=${res.promoted_clusters}  archived=${res.archived_stale}`);
      }
    } else if (cmd === 'forget') {
      const id = positional[1];
      if (!id) {
        console.error(`${dot('red')} Missing memory ID.`);
        process.exit(1);
      }
      const res = engine.forget(id, String(flags.reason || 'cli_forget'));
      console.log(asJson ? JSON.stringify(res, null, 2) : `${dot(res.ok ? 'yellow' : 'red')} ${res.ok ? `Archived ${id}` : res.error}`);
    } else if (cmd === 'stats') {
      const stats = engine.getStats(ns);
      if (asJson) {
        console.log(JSON.stringify(stats, null, 2));
      } else {
        console.log(`${ANSI.bold}hippo-cache stats (${ns})${ANSI.reset}`);
        console.log(`  Memories:  total=${stats.counts.total}  active=${stats.counts.active}  superseded=${stats.counts.superseded}  archived=${stats.counts.archived}`);
        console.log(`  Health:    ${dot('green')} active=${stats.health.green}  ${dot('yellow')} decaying/superseded=${stats.health.yellow}  ${dot('red')} stale/archived=${stats.health.red}`);
        console.log(`  Stores:    semantic=${stats.by_kind.semantic}  procedural=${stats.by_kind.procedural}  episodic=${stats.by_kind.episodic}  working=${stats.by_kind.working}`);
        console.log(`  Graph:     entities=${stats.graph.entities}  edges=${stats.graph.edges}  contradictions=${stats.graph.contradictions}`);
        console.log(`  Tokens:    L0=${stats.tokens.active_l0_total}  L1=${stats.tokens.active_l1_total}  L2=${stats.tokens.active_l2_total}  (L1 compression ${stats.tokens.compression_l1_pct}%)`);
        console.log(`  Telemetry: recalls=${stats.telemetry.recalls}  saved=${stats.telemetry.savings_pct}% (${stats.telemetry.tokens_saved} tok)  avg=${stats.telemetry.avg_recall_ms}ms  secrets_blocked=${stats.telemetry.secrets_redacted}`);
      }
    } else if (cmd === 'timeline') {
      const tl = engine.getTimeline(ns, Number(flags.limit || 25));
      if (asJson) {
        console.log(JSON.stringify(tl, null, 2));
      } else {
        console.log(`${ANSI.bold}Bi-Temporal Contradictions (${tl.contradictions.length})${ANSI.reset}`);
        for (const c of tl.contradictions) {
          console.log(`  ${dot('yellow')} ${c.older_memory_id} ("${c.older_title}") -> ${c.newer_memory_id} ("${c.newer_title}") [${c.reason}]`);
        }
      }
    } else if (cmd === 'seed') {
      const res = seedDemoMemories(engine, ns);
      console.log(`${dot('green')} Seeded ${res.seeded} demo memories into namespace "${ns}" (${dbPath}).`);
    } else {
      console.error(`${dot('red')} Unknown command: ${cmd}`);
      printHelp();
      process.exit(1);
    }
  } finally {
    engine.close();
  }
}

main().catch((err) => {
  console.error(`${dot('red')} ${err.message}`);
  process.exit(1);
});
