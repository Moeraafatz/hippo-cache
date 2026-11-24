import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { HippoCacheEngine } from '../src/core/engine.js';
import { computeBaseLevelActivation, updateStabilityOnAccess } from '../src/core/actr.js';
import { handleMcpRequest } from '../src/mcp/server.js';
import { createHttpServer } from '../src/server/http.js';
import { installAgentAdapters } from '../src/adapters/installer.js';

test('Secret scrubber redacts API keys, JWTs, and DB credentials before SQLite persistence', () => {
  const engine = new HippoCacheEngine(':memory:');
  try {
    // Assemble synthetic fixtures at runtime so static secret scanners do not false-positive on test vectors.
    const fakeOpenAi = ['sk', 'proj', 'ABCDEFGHIJKLMNOPQRSTUVWXYZ123456'].join('-');
    const fakeGithub = ['ghp', '1234567890abcdefghij1234567890abcd'].join('_');
    const fakeStripe = ['sk', 'test', 'DEMO00000000000000000000'].join('_');
    const fakeDbUrl = `postgres://admin:${['Super', 'Secret', '99'].join('')}@db.internal:5432/app`;

    const res = engine.remember({
      kind: 'episodic',
      content: `Debugged prod auth with ${fakeOpenAi}, GitHub token ${fakeGithub}, Stripe ${fakeStripe}, and ${fakeDbUrl}.`
    });

    assert.equal(res.secretsRedacted, 4);
    assert.ok(!res.memory.content.includes(fakeOpenAi));
    assert.ok(!res.memory.content.includes(fakeGithub));
    assert.ok(!res.memory.content.includes(fakeStripe));
    assert.ok(!res.memory.content.includes('SuperSecret99'));
    assert.ok(res.memory.content.includes('[REDACTED:openai_key]'));
    assert.ok(res.memory.content.includes('[REDACTED:github_token]'));
    assert.ok(res.memory.content.includes('[REDACTED:stripe_secret]'));
    assert.ok(res.memory.content.includes('[REDACTED:db_url_credential]'));
  } finally {
    engine.close();
  }
});

test('Exact SHA-256 and SimHash near-duplicate deduplication reinforce activation without bloat', () => {
  const engine = new HippoCacheEngine(':memory:');
  try {
    const t0 = 1_700_000_000_000;
    const r1 = engine.remember({
      kind: 'semantic',
      content: 'Backend API uses Hono with TypeScript strict mode enabled in tsconfig.json.',
      nowMs: t0
    });
    assert.equal(r1.action, 'created');

    const r2 = engine.remember({
      kind: 'semantic',
      content: 'Backend API uses Hono with TypeScript strict mode enabled in tsconfig.json.',
      nowMs: t0 + 3_600_000 * 6
    });
    assert.equal(r2.action, 'reinforced_exact');
    assert.equal(r2.memory.id, r1.memory.id);
    assert.equal(r2.memory.access_count, 2);
    assert.ok(r2.memory.stability > 1.0);

    const r3 = engine.remember({
      kind: 'semantic',
      content: 'Backend API uses Hono with TypeScript strict mode enabled inside tsconfig.json.',
      nowMs: t0 + 3_600_000 * 12
    });
    assert.equal(r3.action, 'reinforced_near_duplicate');
    assert.equal(engine.getStats().counts.active, 1);
  } finally {
    engine.close();
  }
});

test('Bi-temporal contradiction resolution supersedes stale facts and supports as_of time travel', () => {
  const engine = new HippoCacheEngine(':memory:');
  try {
    const day1 = 1_700_000_000_000;
    const day5 = day1 + 4 * 86_400_000;

    const oldFact = engine.remember({
      kind: 'semantic',
      slotKey: 'test_runner',
      content: 'Unit tests run with Jest via npm test using jest.config.cjs.',
      nowMs: day1
    });

    const newFact = engine.remember({
      kind: 'semantic',
      slotKey: 'test_runner',
      content: 'Migrated unit test runner from Jest to Vitest; execute tests with pnpm vitest run.',
      nowMs: day5
    });

    assert.equal(newFact.superseded.length, 1);
    assert.equal(newFact.superseded[0].older_memory_id, oldFact.memory.id);

    // Current recall must ONLY return Vitest, never stale Jest.
    const current = engine.recall({
      query: 'how do we run unit tests',
      budgetTokens: 400,
      nowMs: day5 + 1000
    });
    const idsCurrent = current.memories.map((m) => m.id);
    assert.ok(idsCurrent.includes(newFact.memory.id));
    assert.ok(!idsCurrent.includes(oldFact.memory.id));

    // Bi-temporal time travel before Day 5 must accurately reconstruct historical truth (Jest).
    const historical = engine.recall({
      query: 'how do we run unit tests',
      budgetTokens: 400,
      asOf: day1 + 86_400_000
    });
    const idsHistorical = historical.memories.map((m) => m.id);
    assert.ok(idsHistorical.includes(oldFact.memory.id));
    assert.ok(!idsHistorical.includes(newFact.memory.id));
  } finally {
    engine.close();
  }
});

test('HippoRAG Personalized PageRank surfaces 2-hop associative memories with zero lexical overlap', () => {
  const engine = new HippoCacheEngine(':memory:');
  try {
    const t0 = 1_700_000_000_000;
    // Memory A links login_throttle <-> valkey_cluster
    const memA = engine.remember({
      kind: 'semantic',
      tags: ['login_throttle', 'valkey_cluster'],
      content: 'The login_throttle middleware stores sliding counters inside valkey_cluster.',
      nowMs: t0
    });
    // Memory B links valkey_cluster <-> aof_fsync_pause (ZERO mention of login_throttle!)
    const memB = engine.remember({
      kind: 'procedural',
      tags: ['valkey_cluster', 'aof_fsync_pause'],
      content: 'Production valkey_cluster requires appendfsync everysec to avoid aof_fsync_pause stalls on NVMe disks.',
      nowMs: t0 + 1000
    });
    // Distractors
    for (let i = 0; i < 6; i++) {
      engine.remember({
        kind: 'episodic',
        content: `Unrelated frontend CSS padding adjustment #${i} on marketing banner component.`,
        nowMs: t0 + 2000 + i * 100
      });
    }

    // Query asks ONLY about login_throttle — must hop through valkey_cluster to surface memB!
    const res = engine.recall({
      query: 'login_throttle',
      budgetTokens: 450,
      nowMs: t0 + 10_000
    });
    const ids = res.memories.map((m) => m.id);
    assert.ok(ids.includes(memA.memory.id), 'Direct seed memory must be recalled');
    assert.ok(ids.includes(memB.memory.id), '2-hop associative memory must be surfaced via PPR');
  } finally {
    engine.close();
  }
});

test('Submodular knapsack strictly enforces token budget and delivers major token savings', () => {
  const engine = new HippoCacheEngine(':memory:');
  try {
    const t0 = 1_700_000_000_000;
    const topics = [
      'billing webhook HMAC signature validation in src/billing/stripe.ts with idempotent postgres webhook_events ledger and exponential retry backoff',
      'auth JWT EdDSA verification in src/auth/jwtVerifier.ts rejecting alg=none tokens and rotating refresh cookies on every session refresh',
      'redis sliding-window rate limiter Lua script in src/middleware/rateLimit.ts configured with failOpen=true for Kubernetes liveness probes',
      'postgres connection pooling through pgbouncer transaction mode requiring prepareThreshold=0 in src/db/pool.ts to prevent prepared statement collisions',
      'docker-compose healthcheck grace start_period=15s so API server waits for valkey AOF replay during cold container startup on Fly.io',
      'vite frontend bundle chunking strategy splitting vendor graphs and monaco editor assets into async chunks under dist/assets/',
      'biome linting and formatting rules in biome.json enforcing strict noUnusedImports and 2-space indentation across packages/',
      'github actions release workflow using OIDC short-lived tokens instead of static PAT secrets to publish tagged artifacts',
      'opentelemetry structured Pino tracing middleware injecting x-correlation-id into outbound gRPC and HTTP calls across microservices',
      's3 presigned multipart upload worker streaming PDF invoices directly from headless renderer with max_concurrency=2 to stop OOM kills',
      'sqlite FTS5 custom tokenizer preserving underscore slash dot hyphen characters so code paths and part SKUs resolve accurately',
      'cloudflare reverse proxy trustProxy=2 setting preserving X-Forwarded-Proto HTTPS headers for OAuth callback redirect URIs',
      'drizzle ORM schema migrations in src/db/schema.ts strictly forward-only without editing historical SQL migration files after merge',
      'playwright end-to-end checkout tests seeded via isolated tenant fixtures running headless chromium in parallel CI shards',
      'trpc v11 router batching link under src/trpc/router.ts providing end-to-end TypeScript inference between Next.js and Hono backend',
      'sentry source map upload hook stripping local filesystem paths and PII headers before transmitting production exception stack traces',
      'cron reconciliation job comparing Stripe settlement payouts against internal ledger_entries table every night at 02:00 UTC',
      'graphql legacy gateway deprecation notice returning Sunset HTTP headers and directing internal clients to tRPC endpoints'
    ];
    topics.forEach((topic, i) => {
      engine.remember({
        kind: i % 2 === 0 ? 'semantic' : 'procedural',
        content: `Production engineering invariant for ${topic}. Documented after incident review #${100 + i} to ensure coding agents preserve exact file paths, failure safeguards, and operational constraints across long-horizon refactors.`,
        nowMs: t0 + i * 1000
      });
    });

    const res = engine.recall({
      query: 'Stripe billing postgres webhook ledger settlement',
      budgetTokens: 200,
      disclosure: 'auto',
      nowMs: t0 + 50_000
    });

    assert.ok(res.tokens_used <= 200, `Expected <=200 tokens, got ${res.tokens_used}`);
    assert.ok(res.savings_pct >= 75, `Expected >=75% token savings, got ${res.savings_pct}%`);
    assert.ok(res.memories.length >= 3, 'Progressive L0/L1 disclosure should pack multiple relevant memories within tight budget');
  } finally {
    engine.close();
  }
});

test('ACT-R decay distinguishes memory tiers and rewards spaced rehearsal', () => {
  const t0 = 1_700_000_000_000;
  const day = 86_400_000;

  const workingLate = computeBaseLevelActivation({
    accessTimestamps: [t0],
    nowMs: t0 + 14 * day,
    kind: 'working',
    importance: 0.4,
    stability: 1.0
  });
  const proceduralSpaced = computeBaseLevelActivation({
    accessTimestamps: [t0, t0 + 3 * day, t0 + 9 * day],
    nowMs: t0 + 14 * day,
    kind: 'procedural',
    importance: 0.85,
    stability: updateStabilityOnAccess(updateStabilityOnAccess(1.0, t0, t0 + 3 * day), t0 + 3 * day, t0 + 9 * day)
  });

  assert.ok(proceduralSpaced.activation > workingLate.activation + 0.4);
  assert.ok(workingLate.activation < 0.35);
  assert.ok(proceduralSpaced.activation > 0.75);
});

test('Sleep-cycle consolidation promotes episodic clusters and archives cold working notes', () => {
  const engine = new HippoCacheEngine(':memory:');
  try {
    const t0 = 1_700_000_000_000;
    const day = 86_400_000;

    // 3 distinct episodic bugs sharing rare symbol `pgbouncer_pool`
    engine.remember({
      kind: 'episodic',
      content: 'Hit prepared statement collision on pgbouncer_pool in transaction pooling mode during checkout.',
      nowMs: t0 + 10 * day
    });
    engine.remember({
      kind: 'episodic',
      content: 'Disabled unnamed prepared statements for pgbouncer_pool by setting prepareThreshold=0 in src/db/client.ts.',
      nowMs: t0 + 11 * day
    });
    engine.remember({
      kind: 'episodic',
      content: 'Verified pgbouncer_pool max_client_conn=400 resolves 503 bursts under load test.',
      nowMs: t0 + 12 * day
    });

    // Stale unpinned working scratchpad from 30 days ago
    const stale = engine.remember({
      kind: 'working',
      importance: 0.15,
      content: 'Temporary scratch note: check typo on footer link tomorrow.',
      nowMs: t0 - 20 * day
    });

    const sleep = engine.consolidate('default', { nowMs: t0 + 13 * day, archiveThreshold: 0.35 });
    assert.ok(sleep.promoted_clusters >= 1, 'Should promote 3-episode cluster into semantic/procedural knowledge');
    assert.ok(sleep.archived_ids.includes(stale.memory.id), 'Should archive old low-activation working note');
  } finally {
    engine.close();
  }
});

test('MCP JSON-RPC 2.0 handler and HTTP REST/MCP routes operate end-to-end', async () => {
  const engine = new HippoCacheEngine(':memory:');
  const { handler } = createHttpServer({ engine, namespace: 'testns' });

  const invokeHttp = async (method, url, body = null) => {
    const { Readable } = await import('node:stream');
    const req = new Readable({ read() {} });
    req.method = method;
    req.url = url;
    req.headers = { host: '127.0.0.1:4747' };
    if (body !== null) req.push(JSON.stringify(body));
    req.push(null);

    return new Promise((resolve) => {
      let status = 200;
      const chunks = [];
      const res = {
        writeHead(code) { status = code; },
        write(chunk) { chunks.push(Buffer.from(chunk)); },
        end(chunk) {
          if (chunk) chunks.push(Buffer.from(chunk));
          const text = Buffer.concat(chunks).toString('utf8');
          resolve({ status, json: text ? JSON.parse(text) : null });
        }
      };
      handler(req, res);
    });
  };

  try {
    // Direct MCP protocol checks
    const init = handleMcpRequest(engine, { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }, 'testns');
    assert.equal(init.result.serverInfo.name, 'hippo-cache');

    const list = handleMcpRequest(engine, { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }, 'testns');
    assert.equal(list.result.tools.length, 8);

    const store = handleMcpRequest(
      engine,
      {
        jsonrpc: '2.0',
        id: 3,
        method: 'tools/call',
        params: {
          name: 'memory_remember',
          arguments: { content: 'Deploy uses Fly.io Frankfurt region (fra) with zero-downtime rolling strategy.', kind: 'semantic' }
        }
      },
      'testns'
    );
    const parsedStore = JSON.parse(store.result.content[0].text);
    assert.equal(parsedStore.action, 'created');

    // Hermetic HTTP API & Streamable HTTP MCP checks
    const healthRes = await invokeHttp('GET', '/api/health');
    assert.equal(healthRes.status, 200);
    assert.equal(healthRes.json.status, 'ok');

    const recallRes = await invokeHttp('POST', '/api/recall?ns=testns', {
      query: 'Fly.io deploy region',
      budget_tokens: 300
    });
    assert.equal(recallRes.status, 200);
    assert.equal(recallRes.json.memories.length, 1);
    assert.equal(recallRes.json.memories[0].id, parsedStore.id);

    const mcpHttpRes = await invokeHttp('POST', '/mcp?ns=testns', {
      jsonrpc: '2.0',
      id: 9,
      method: 'tools/call',
      params: { name: 'memory_stats', arguments: {} }
    });
    assert.equal(mcpHttpRes.status, 200);
    assert.ok(mcpHttpRes.json.result.content[0].text.includes('"active": 1'));
  } finally {
    engine.close();
  }
});

test('Agent adapter installer writes portable SKILL.md and MCP configs across all coding agents', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hippo-init-'));
  try {
    const res = installAgentAdapters({ targetDir: tmpDir, targets: ['all'] });
    assert.ok(fs.existsSync(path.join(tmpDir, '.claude/skills/hippo-cache/SKILL.md')));
    assert.ok(fs.existsSync(path.join(tmpDir, '.mcp.json')));
    assert.ok(fs.existsSync(path.join(tmpDir, '.codex/skills/hippo-cache/SKILL.md')));
    assert.ok(fs.existsSync(path.join(tmpDir, '.codex/hippo-cache.config.toml')));
    assert.ok(fs.existsSync(path.join(tmpDir, '.cursor/rules/hippo-cache.mdc')));
    assert.ok(fs.existsSync(path.join(tmpDir, '.cursor/mcp.json')));
    assert.ok(fs.existsSync(path.join(tmpDir, '.windsurf/rules/hippo-cache.md')));
    assert.ok(fs.existsSync(path.join(tmpDir, '.agent/skills/hippo-cache/SKILL.md')));

    const mcpJson = JSON.parse(fs.readFileSync(path.join(tmpDir, '.mcp.json'), 'utf8'));
    assert.ok(mcpJson.mcpServers['hippo-cache']);
    assert.equal(res.targets.length, 5);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
