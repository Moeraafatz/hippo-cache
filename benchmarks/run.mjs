#!/usr/bin/env node
/**
 * Deterministic 50-Turn Multi-Session Software Engineering Benchmark Suite.
 *
 * Compares 4 agent memory architectures head-to-head on identical corpora & queries:
 *   1. Naive Full-Context Dump (re-injecting full accumulated memory / bloated CLAUDE.md)
 *   2. Sliding Window (Recent-10 memories — simulates context truncation / compaction)
 *   3. Vector-Only Top-K RAG (flat cosine top-8 full chunks, no graph, no bi-temporal)
 *   4. hippo-cache (ACT-R + HippoRAG PPR + Bi-Temporal Supersession + Submodular Knapsack)
 *
 * Outputs verified reproducible JSON metrics to benchmarks/results.json.
 */

import fs from 'node:fs';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import { HippoCacheEngine } from '../src/core/engine.js';
import { estimateTokens, embedText, cosineSimilarity } from '../src/core/text.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT_PATH = path.join(__dirname, 'results.json');

const BASE_TIME = 1_760_000_000_000;
const DAY = 86_400_000;

// Realistic software engineering corpus spanning 14 days with migrations, multi-hop chains, duplicates, and secret leaks.
function buildCorpus() {
  return [
    // --- Early stack decisions (later contradicted / migrated!) ---
    {
      key: 'old_test_runner',
      day: 0,
      kind: 'semantic',
      slotKey: 'test_runner',
      tags: ['testing', 'jest'],
      content: 'Unit tests run with Jest via npm test using jest.config.cjs and ts-jest. Coverage threshold is 80 percent across packages/core and packages/api.'
    },
    {
      key: 'old_session_store',
      day: 0.2,
      kind: 'semantic',
      slotKey: 'session_store',
      tags: ['auth', 'postgres'],
      content: 'User sessions are persisted in PostgreSQL table user_sessions via src/auth/sessionStore.ts with row-level expiry checks on every authenticated request.'
    },
    {
      key: 'old_port',
      day: 0.4,
      kind: 'semantic',
      slotKey: 'port_config',
      tags: ['server', 'docker'],
      content: 'Backend API server listens on port 3000 in local development and inside docker-compose.yml health checks.'
    },
    {
      key: 'old_linter',
      day: 0.6,
      kind: 'semantic',
      slotKey: 'linter_formatter',
      tags: ['lint', 'eslint', 'prettier'],
      content: 'Code linting and formatting uses ESLint with Prettier plugin configured in .eslintrc.json and .prettierrc.'
    },
    {
      key: 'old_bundler',
      day: 0.8,
      kind: 'semantic',
      slotKey: 'build_tool',
      tags: ['build', 'webpack'],
      content: 'Frontend dashboard bundle compiles with Webpack 5 using webpack.config.js and babel-loader.'
    },
    {
      key: 'old_pkg',
      day: 1.0,
      kind: 'semantic',
      slotKey: 'package_manager',
      tags: ['npm', 'deps'],
      content: 'Workspace dependencies are installed with npm using package-lock.json in CI pipelines.'
    },
    {
      key: 'old_api',
      day: 1.2,
      kind: 'semantic',
      slotKey: 'api_protocol',
      tags: ['api', 'rest'],
      content: 'Client-to-server internal RPC uses hand-written REST JSON endpoints under /api/v1/ with manual Zod schemas.'
    },
    {
      key: 'old_orm',
      day: 1.4,
      kind: 'semantic',
      slotKey: 'orm_layer',
      tags: ['db', 'typeorm'],
      content: 'Database queries use TypeORM entity repositories in src/db/entities/ with reflect-metadata decorators.'
    },

    // --- Core architecture & procedural playbooks (long-lived truth!) ---
    {
      key: 'prisma_migrations',
      day: 2.0,
      kind: 'procedural',
      importance: 0.92,
      tags: ['migrations', 'sql', 'deploy'],
      content: 'Never edit historical migration SQL files after merging to main. Always append a forward-only migration with pnpm db:migrate:new so production checksum verification never aborts zero-downtime deployment.'
    },
    {
      key: 'jwt_security',
      day: 2.3,
      kind: 'procedural',
      importance: 0.92,
      tags: ['auth', 'jwt', 'security'],
      content: 'In src/auth/jwtVerifier.ts, always enforce explicit alg=EdDSA allowlist, validate both aud and iss claims, and rotate refresh tokens with reuse-detection revocation on /api/auth/refresh.'
    },
    {
      key: 'stripe_raw_body',
      day: 2.6,
      kind: 'procedural',
      importance: 0.9,
      tags: ['stripe', 'webhooks', 'billing'],
      content: 'Stripe webhook verification in src/webhooks/stripe.ts requires raw unparsed request bytes via express.raw before JSON body middleware, otherwise HMAC signature validation fails with 400 Invalid Signature.'
    },
    {
      key: 'idempotency_keys',
      day: 2.9,
      kind: 'procedural',
      importance: 0.88,
      tags: ['billing', 'postgres', 'idempotency'],
      content: 'Every mutating billing endpoint must require Idempotency-Key header stored in table billing_idempotency with unique constraint on (tenant_id, key) for 24 hours to prevent double charges during client retries.'
    },

    // --- Multi-Hop Associative Chains (Hop A -> shared entity -> Hop B) ---
    // Chain 1: checkout_latency -> pgbouncer_pool -> prepareThreshold=0
    {
      key: 'hop1_a',
      day: 3.2,
      kind: 'episodic',
      importance: 0.8,
      tags: ['checkout_latency', 'pgbouncer_pool'],
      content: 'Investigated checkout_latency p99 spikes over 1800ms during flash sales; traced bottleneck to connection starvation in pgbouncer_pool.'
    },
    {
      key: 'hop1_b',
      day: 3.4,
      kind: 'procedural',
      importance: 0.9,
      tags: ['pgbouncer_pool', 'postgres'],
      content: 'Production pgbouncer_pool runs in transaction pooling mode and requires prepareThreshold=0 in src/db/pool.ts or queries crash with prepared statement already exists.'
    },
    // Chain 2: oauth_callback_500 -> edge_proxy_headers -> trust_proxy_hops
    {
      key: 'hop2_a',
      day: 3.7,
      kind: 'episodic',
      importance: 0.8,
      tags: ['oauth_callback_500', 'edge_proxy_headers'],
      content: 'Users hit oauth_callback_500 behind Cloudflare because redirect_uri generated http instead of https due to stripped edge_proxy_headers.'
    },
    {
      key: 'hop2_b',
      day: 3.9,
      kind: 'procedural',
      importance: 0.9,
      tags: ['edge_proxy_headers', 'server'],
      content: 'Preserve edge_proxy_headers by setting trustProxy=2 in src/server/app.ts so X-Forwarded-Proto and client IP rate limiting work accurately.'
    },
    // Chain 3: worker_oom_kill -> pdf_canvas_buffer -> max_concurrency_2
    {
      key: 'hop3_a',
      day: 4.1,
      kind: 'episodic',
      importance: 0.8,
      tags: ['worker_oom_kill', 'pdf_canvas_buffer'],
      content: 'Invoice export container hit worker_oom_kill (exit 137) whenever large reports allocated uncompressed pdf_canvas_buffer bitmaps.'
    },
    {
      key: 'hop3_b',
      day: 4.3,
      kind: 'procedural',
      importance: 0.88,
      tags: ['pdf_canvas_buffer', 'bullmq'],
      content: 'Cap invoice worker concurrency to 2 jobs per pod and call explicit canvas.dispose() after flushing pdf_canvas_buffer to S3 stream.'
    },
    // Chain 4: search_zero_hits -> tokenizer_dash_split -> fts5_tokenchars
    {
      key: 'hop4_a',
      day: 4.5,
      kind: 'episodic',
      importance: 0.8,
      tags: ['search_zero_hits', 'tokenizer_dash_split'],
      content: 'Part number queries like SKU-404-XL returned search_zero_hits because default unicode61 triggered tokenizer_dash_split.'
    },
    {
      key: 'hop4_b',
      day: 4.7,
      kind: 'procedural',
      importance: 0.88,
      tags: ['tokenizer_dash_split', 'fts5'],
      content: 'Fix tokenizer_dash_split in SQLite FTS5 virtual tables by specifying tokenize="porter unicode61 tokenchars \'_./-\'" and rebuilding the index.'
    },
    // Chain 5: fly_boot_502 -> valkey_aof_replay -> start_period_15s
    {
      key: 'hop5_a',
      day: 5.0,
      kind: 'episodic',
      importance: 0.82,
      tags: ['fly_boot_502', 'valkey_aof_replay'],
      content: 'Blue-green deploys triggered transient fly_boot_502 errors because API booted before valkey_aof_replay completed.'
    },
    {
      key: 'hop5_b',
      day: 5.2,
      kind: 'procedural',
      importance: 0.88,
      tags: ['valkey_aof_replay', 'docker', 'healthcheck'],
      content: 'Configure 15-second healthcheck start_period in fly.toml and set rate_limiter failOpen=true during valkey_aof_replay warmup.'
    },

    // --- Migrations / Supersessions (NEW current truth!) ---
    {
      key: 'new_test_runner',
      day: 6.0,
      kind: 'semantic',
      slotKey: 'test_runner',
      importance: 0.92,
      tags: ['testing', 'vitest'],
      content: 'Migrated unit test runner from Jest to Vitest for native ESM speed; execute tests with pnpm vitest run using vitest.config.ts.'
    },
    {
      key: 'new_session_store',
      day: 6.3,
      kind: 'semantic',
      slotKey: 'session_store',
      importance: 0.92,
      tags: ['auth', 'redis', 'valkey'],
      content: 'Migrated user session store from PostgreSQL to Redis (valkey-compatible) in src/auth/sessionStore.ts with 7-day sliding TTL to eliminate write locks.'
    },
    {
      key: 'new_port',
      day: 6.6,
      kind: 'semantic',
      slotKey: 'port_config',
      importance: 0.88,
      tags: ['server', 'docker'],
      content: 'Switched backend API server port from 3000 to 4040 in src/server.ts and docker-compose.yml to avoid Next.js dev port collision.'
    },
    {
      key: 'new_linter',
      day: 7.0,
      kind: 'semantic',
      slotKey: 'linter_formatter',
      importance: 0.88,
      tags: ['lint', 'biome'],
      content: 'Replaced ESLint and Prettier with Biome (biome.json) for 20x faster lint and format checks via pnpm biome check --write.'
    },
    {
      key: 'new_bundler',
      day: 7.3,
      kind: 'semantic',
      slotKey: 'build_tool',
      importance: 0.88,
      tags: ['build', 'vite'],
      content: 'Migrated frontend bundler from Webpack to Vite (vite.config.ts) reducing cold dev startup from 14s to 280ms.'
    },
    {
      key: 'new_pkg',
      day: 7.6,
      kind: 'semantic',
      slotKey: 'package_manager',
      importance: 0.88,
      tags: ['pnpm', 'deps'],
      content: 'Switched workspace package manager from npm to pnpm (pnpm-lock.yaml); never commit package-lock.json.'
    },
    {
      key: 'new_api',
      day: 8.0,
      kind: 'semantic',
      slotKey: 'api_protocol',
      importance: 0.88,
      tags: ['api', 'trpc'],
      content: 'Migrated internal client RPC layer from REST to tRPC v11 under src/trpc/router.ts for end-to-end TypeScript inference.'
    },
    {
      key: 'new_orm',
      day: 8.3,
      kind: 'semantic',
      slotKey: 'orm_layer',
      importance: 0.9,
      tags: ['db', 'drizzle'],
      content: 'Replaced TypeORM with Drizzle ORM in src/db/schema.ts for zero-reflection SQL type safety and 4x smaller Lambda bundle.'
    },

    // --- Secret leak safety tests (synthesized at runtime to avoid static scanner false positives) ---
    {
      key: 'secret_leak_1',
      day: 9.0,
      kind: 'episodic',
      content: `Found accidentally committed OpenAI key ${['sk', 'proj', '9876543210abcdefghijklmnopqr'].join('-')} in scripts/eval.sh; rotated immediately and added pre-commit scan.`
    },
    {
      key: 'secret_leak_2',
      day: 9.1,
      kind: 'episodic',
      content: `Staging Redis URI redis://default:${['ProdPass', '987654321'].join('')}@cache.internal:6379/0 failed TLS handshake until rediss:// scheme was enabled.`
    },
    {
      key: 'secret_leak_3',
      day: 9.2,
      kind: 'episodic',
      content: `CI token ${['ghp', '9876543210abcdefghij9876543210abcd'].join('_')} expired on GitHub Actions release workflow; migrated to OIDC short-lived tokens.`
    },

    // --- Realistic background codebase noise & operational memories (30 items) ---
    ...Array.from({ length: 24 }, (_, idx) => ({
      key: `bg_${idx}`,
      day: 9.5 + idx * 0.15,
      kind: idx % 4 === 0 ? 'working' : idx % 3 === 0 ? 'episodic' : 'semantic',
      importance: idx % 4 === 0 ? 0.3 : 0.55,
      tags: [`module_${idx}`, 'ops'],
      content: `Service module_${idx} in src/services/service_${idx}.ts emits OpenTelemetry span metric_svc_${idx}_duration_ms and enforces 5000ms upstream socket timeout with circuit breaker threshold 5 consecutive failures before half-open probe.`
    })),

    // --- Near-duplicate episodic noise (should be deduplicated by hippo-cache!) ---
    {
      key: 'dup_1',
      day: 13.2,
      kind: 'episodic',
      content: 'Observed occasional DNS timeout in staging worker container when querying external analytics webhook.'
    },
    {
      key: 'dup_2',
      day: 13.3,
      kind: 'episodic',
      content: 'Observed occasional DNS timeout in staging worker container when querying external analytics webhook!'
    },
    {
      key: 'dup_3',
      day: 13.4,
      kind: 'episodic',
      content: 'Observed occasional DNS timeout in staging worker container while querying external analytics webhook.'
    }
  ];
}

// 50 realistic coding-agent turns: direct recalls, contradiction-sensitive queries, and multi-hop reasoning queries.
function buildQueries() {
  const base = [
    // Contradiction-sensitive queries (MUST retrieve NEW truth and MUST NOT retrieve stale superseded ghost!)
    { type: 'contradiction', query: 'how do we run unit tests in this repo', want: 'new_test_runner', forbid: 'old_test_runner' },
    { type: 'contradiction', query: 'where are user sessions stored', want: 'new_session_store', forbid: 'old_session_store' },
    { type: 'contradiction', query: 'what port does backend API server listen on', want: 'new_port', forbid: 'old_port' },
    { type: 'contradiction', query: 'which linter and formatter tool is configured', want: 'new_linter', forbid: 'old_linter' },
    { type: 'contradiction', query: 'what frontend build bundler do we use', want: 'new_bundler', forbid: 'old_bundler' },
    { type: 'contradiction', query: 'which package manager and lockfile should I use', want: 'new_pkg', forbid: 'old_pkg' },
    { type: 'contradiction', query: 'what internal client RPC protocol does the API use', want: 'new_api', forbid: 'old_api' },
    { type: 'contradiction', query: 'which database ORM library is active in src/db', want: 'new_orm', forbid: 'old_orm' },

    // Multi-hop associative queries (query names ONLY the symptom/hop A, ground truth is the root-cause fix in hop B!)
    { type: 'multihop', query: 'checkout_latency spike during flash sales', want: 'hop1_b' },
    { type: 'multihop', query: 'oauth_callback_500 behind Cloudflare redirect_uri', want: 'hop2_b' },
    { type: 'multihop', query: 'worker_oom_kill exit 137 on invoice export', want: 'hop3_b' },
    { type: 'multihop', query: 'search_zero_hits for SKU-404-XL part numbers', want: 'hop4_b' },
    { type: 'multihop', query: 'fly_boot_502 errors during blue-green deploy', want: 'hop5_b' },

    // Direct procedural / long-horizon recall (early memories that sliding window drops!)
    { type: 'direct', query: 'can I edit old SQL migration files before deploy', want: 'prisma_migrations' },
    { type: 'direct', query: 'JWT token verification algorithm and refresh rotation', want: 'jwt_security' },
    { type: 'direct', query: 'Stripe webhook signature 400 Invalid Signature fix', want: 'stripe_raw_body' },
    { type: 'direct', query: 'prevent double charge on billing retry idempotency', want: 'idempotency_keys' }
  ];

  // Expand cleanly to 50 coding-agent turns across realistic recurring session queries.
  const turns = [];
  for (let i = 0; i < 50; i++) {
    turns.push(base[i % base.length]);
  }
  return turns;
}

function percentile(sorted, p) {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return Number(sorted[idx].toFixed(2));
}

function runBenchmark() {
  const corpus = buildCorpus();
  const turns = buildQueries();
  const engine = new HippoCacheEngine(':memory:');

  // Ingest corpus into hippo-cache AND into flat baseline array (which does NOT dedup, scrub, or supersede).
  const keyToId = new Map();
  const idToKey = new Map();
  const flatStore = [];
  let secretsInjected = 3;
  let secretsBlockedByHippo = 0;

  for (const item of corpus) {
    const ts = BASE_TIME + Math.round(item.day * DAY);
    const res = engine.remember({
      namespace: 'bench',
      kind: item.kind,
      slotKey: item.slotKey || null,
      importance: item.importance ?? 0.68,
      tags: item.tags || [],
      content: item.content,
      source: 'bench',
      nowMs: ts
    });
    keyToId.set(item.key, res.memory.id);
    idToKey.set(res.memory.id, item.key);
    secretsBlockedByHippo += res.secretsRedacted;

    flatStore.push({
      key: item.key,
      content: item.content,
      tokens: estimateTokens(item.content),
      vector: embedText(item.content),
      ts
    });
  }

  const evalNow = BASE_TIME + 14.5 * DAY;
  const naivePerTurnTokens = flatStore.reduce((a, x) => a + x.tokens, 0);

  // Track cumulative curves and accuracy across 50 turns
  const methods = {
    naive_full: { label: 'Naive Full-Context Dump', cumTokens: [], hits: 0, contraClean: 0, contraTotal: 0, hopHits: 0, hopTotal: 0, latencies: [] },
    sliding_window: { label: 'Sliding Window (Recent-10)', cumTokens: [], hits: 0, contraClean: 0, contraTotal: 0, hopHits: 0, hopTotal: 0, latencies: [] },
    vector_rag: { label: 'Vector-Only Top-8 RAG', cumTokens: [], hits: 0, contraClean: 0, contraTotal: 0, hopHits: 0, hopTotal: 0, latencies: [] },
    hippo_cache: { label: 'hippo-cache (ACT-R + PPR + Knapsack)', cumTokens: [], hits: 0, contraClean: 0, contraTotal: 0, hopHits: 0, hopTotal: 0, latencies: [] }
  };

  let sumNaive = 0;
  let sumSliding = 0;
  let sumVector = 0;
  let sumHippo = 0;

  for (let t = 0; t < turns.length; t++) {
    const q = turns[t];
    // Simulate realistic session growth in naive context (agent history + memory dump grows per turn)
    const turnOverhead = Math.round(t * 28);

    // 1. Naive Full-Context Dump (injects all accumulated memories every turn)
    const tNaive = naivePerTurnTokens + turnOverhead;
    sumNaive += tNaive;
    methods.naive_full.cumTokens.push(sumNaive);
    // Full dump contains BOTH old and new contradictory facts simultaneously!
    methods.naive_full.hits += 1;
    if (q.type === 'contradiction') {
      methods.naive_full.contraTotal++;
      // Contradiction polluted: both old_X and new_X appear in prompt without validity filter
    }
    if (q.type === 'multihop') {
      methods.naive_full.hopTotal++;
      methods.naive_full.hopHits++;
    }

    // 2. Sliding Window (Recent-10 memories only)
    const recent10 = flatStore.slice(-10);
    const recentKeys = new Set(recent10.map((x) => x.key));
    const tSliding = recent10.reduce((a, x) => a + x.tokens, 0);
    sumSliding += tSliding;
    methods.sliding_window.cumTokens.push(sumSliding);
    if (recentKeys.has(q.want)) methods.sliding_window.hits++;
    if (q.type === 'contradiction') {
      methods.sliding_window.contraTotal++;
      if (recentKeys.has(q.want) && !recentKeys.has(q.forbid)) methods.sliding_window.contraClean++;
    }
    if (q.type === 'multihop') {
      methods.sliding_window.hopTotal++;
      if (recentKeys.has(q.want)) methods.sliding_window.hopHits++;
    }

    // 3. Vector-Only Top-8 RAG (flat cosine similarity, no graph, no bi-temporal filter, full L2 chunks)
    const vStart = performance.now();
    const qVec = embedText(q.query);
    const ranked = flatStore
      .map((item) => ({ item, sim: cosineSimilarity(qVec, item.vector) }))
      .sort((a, b) => b.sim - a.sim)
      .slice(0, 8);
    methods.vector_rag.latencies.push(performance.now() - vStart);
    const ragKeys = new Set(ranked.map((r) => r.item.key));
    const tVector = ranked.reduce((a, r) => a + r.item.tokens, 0);
    sumVector += tVector;
    methods.vector_rag.cumTokens.push(sumVector);
    if (ragKeys.has(q.want)) methods.vector_rag.hits++;
    if (q.type === 'contradiction') {
      methods.vector_rag.contraTotal++;
      if (ragKeys.has(q.want) && !ragKeys.has(q.forbid)) methods.vector_rag.contraClean++;
    }
    if (q.type === 'multihop') {
      methods.vector_rag.hopTotal++;
      if (ragKeys.has(q.want)) methods.vector_rag.hopHits++;
    }

    // 4. hippo-cache (Hard 340-token budget, ACT-R + HippoRAG PPR + Bi-Temporal + Submodular Knapsack)
    const hStart = performance.now();
    const hRes = engine.recall({
      namespace: 'bench',
      query: q.query,
      budgetTokens: 340,
      disclosure: 'auto',
      nowMs: evalNow + t * 60_000
    });
    methods.hippo_cache.latencies.push(performance.now() - hStart);
    const hKeys = new Set(hRes.memories.map((m) => idToKey.get(m.id)));
    sumHippo += hRes.tokens_used;
    methods.hippo_cache.cumTokens.push(sumHippo);
    if (hKeys.has(q.want)) methods.hippo_cache.hits++;
    if (q.type === 'contradiction') {
      methods.hippo_cache.contraTotal++;
      if (hKeys.has(q.want) && !hKeys.has(q.forbid)) methods.hippo_cache.contraClean++;
    }
    if (q.type === 'multihop') {
      methods.hippo_cache.hopTotal++;
      if (hKeys.has(q.want)) methods.hippo_cache.hopHits++;
    }
  }

  const hippoStats = engine.getStats('bench', evalNow + 50 * 60_000);
  engine.close();

  const summarize = (m, totalTokens) => {
    const sortedLat = [...m.latencies].sort((a, b) => a - b);
    return {
      label: m.label,
      total_tokens_50_turns: totalTokens,
      avg_tokens_per_turn: Math.round(totalTokens / turns.length),
      token_reduction_vs_naive_pct: Number((((sumNaive - totalTokens) / sumNaive) * 100).toFixed(1)),
      recall_at_budget_pct: Number(((m.hits / turns.length) * 100).toFixed(1)),
      contradiction_accuracy_pct: m.contraTotal ? Number(((m.contraClean / m.contraTotal) * 100).toFixed(1)) : 0,
      multihop_recall_pct: m.hopTotal ? Number(((m.hopHits / m.hopTotal) * 100).toFixed(1)) : 0,
      latency_p50_ms: percentile(sortedLat, 50),
      latency_p95_ms: percentile(sortedLat, 95),
      latency_p99_ms: percentile(sortedLat, 99),
      cumulative_tokens: m.cumTokens
    };
  };

  const results = {
    generated_at: new Date().toISOString(),
    corpus_size: corpus.length,
    turns: turns.length,
    hippo_budget_tokens: 340,
    secrets: {
      injected: secretsInjected,
      blocked_by_hippo: secretsBlockedByHippo,
      redaction_rate_pct: Number(((secretsBlockedByHippo / secretsInjected) * 100).toFixed(1))
    },
    hippo_dedup_active_count: hippoStats.counts.active,
    hippo_superseded_count: hippoStats.counts.superseded,
    hippo_edges_count: hippoStats.graph.edges,
    hippo_entities_count: hippoStats.graph.entities,
    summary: {
      naive_full: summarize(methods.naive_full, sumNaive),
      sliding_window: summarize(methods.sliding_window, sumSliding),
      vector_rag: summarize(methods.vector_rag, sumVector),
      hippo_cache: summarize(methods.hippo_cache, sumHippo)
    }
  };

  fs.writeFileSync(OUT_PATH, JSON.stringify(results, null, 2) + '\n', 'utf8');

  console.log('\n=== hippo-cache 50-Turn Deterministic Benchmark Results ===\n');
  for (const [, s] of Object.entries(results.summary)) {
    console.log(
      `${s.label.padEnd(38)} | ${String(s.total_tokens_50_turns).padStart(7)} tok (${String(s.token_reduction_vs_naive_pct).padStart(5)}% saved) | Recall ${String(s.recall_at_budget_pct).padStart(5)}% | FreshTruth ${String(s.contradiction_accuracy_pct).padStart(5)}% | MultiHop ${String(s.multihop_recall_pct).padStart(5)}% | p50 ${s.latency_p50_ms}ms`
    );
  }
  console.log(`\nSecrets redacted: ${results.secrets.blocked_by_hippo}/${results.secrets.injected} (${results.secrets.redaction_rate_pct}%)`);
  console.log(`Superseded stale facts cleanly quarantined: ${results.hippo_superseded_count}`);
  console.log(`Saved -> ${OUT_PATH}\n`);
}

runBenchmark();
