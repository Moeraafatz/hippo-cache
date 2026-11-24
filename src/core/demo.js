/**
 * Realistic multi-session software engineering demo seed for `hippo-cache seed`
 * and instant exploration in `hippo-cache ui`.
 */
export function seedDemoMemories(engine, namespace = 'default') {
  const baseTime = Date.now() - 10 * 86_400_000; // 10 days ago
  const day = 86_400_000;

  const events = [
    {
      offset: 0,
      kind: 'semantic',
      slotKey: 'test_runner',
      importance: 0.8,
      tags: ['testing', 'jest'],
      content: 'Unit tests run with Jest via npm test using jest.config.cjs and ts-jest transformer.'
    },
    {
      offset: 0.2 * day,
      kind: 'semantic',
      slotKey: 'session_store',
      importance: 0.85,
      tags: ['auth', 'postgres', 'sessions'],
      content: 'User sessions are stored in PostgreSQL inside the user_sessions table managed by src/auth/sessionStore.ts.'
    },
    {
      offset: 0.5 * day,
      kind: 'semantic',
      slotKey: 'port_config',
      importance: 0.75,
      tags: ['server', 'docker'],
      content: 'Backend API server listens on port 3000 in local development and inside docker-compose.yml.'
    },
    {
      offset: 1 * day,
      kind: 'procedural',
      importance: 0.9,
      tags: ['postgres', 'migrations', 'prisma'],
      content: 'Never edit historical Prisma migration SQL files in prisma/migrations/. Always create a new forward migration with pnpm prisma migrate dev --name <slug> so production checksum validation does not abort deploy.'
    },
    {
      offset: 2 * day,
      kind: 'episodic',
      importance: 0.65,
      tags: ['redis', 'docker', 'deploy'],
      content: 'Observed 502 startup spikes on Fly.io when container booted before Redis finished AOF replay. Added a 15-second healthcheck start_period in docker-compose.yml and fly.toml.'
    },
    {
      offset: 3 * day,
      kind: 'semantic',
      slotKey: 'session_store',
      importance: 0.92,
      tags: ['auth', 'redis', 'sessions'],
      content: 'Migrated session store from PostgreSQL to Redis (valkey-compatible) in src/auth/sessionStore.ts to eliminate write locks on token refresh; TTL is 7 days with sliding renewal.'
    },
    {
      offset: 4 * day,
      kind: 'semantic',
      slotKey: 'test_runner',
      importance: 0.9,
      tags: ['testing', 'vitest'],
      content: 'Migrated unit test runner from Jest to Vitest for native ESM speed. Run tests via pnpm vitest run; vitest.config.ts replaces jest.config.cjs.'
    },
    {
      offset: 5 * day,
      kind: 'procedural',
      importance: 0.88,
      tags: ['auth', 'jwt', 'security'],
      content: 'In src/auth/jwtVerifier.ts, always verify both aud and iss claims and reject alg=none tokens. Refresh tokens rotate on every /api/auth/refresh call with reuse detection.'
    },
    {
      offset: 6 * day,
      kind: 'semantic',
      slotKey: 'port_config',
      importance: 0.8,
      tags: ['server', 'docker'],
      content: 'Switched backend API server port from 3000 to 4040 in src/server.ts and docker-compose.yml to avoid colliding with Next.js frontend dev server.'
    },
    {
      offset: 7 * day,
      kind: 'episodic',
      importance: 0.72,
      tags: ['stripe', 'webhooks', 'security'],
      content: `Webhook verification failed because Express JSON parser consumed raw body before Stripe signature check. Fixed in src/webhooks/stripe.ts by mounting express.raw({ type: "application/json" }) before body parsers. Accidentally pasted synthetic key ${['sk', 'test', 'DEMO00000000000000000000'].join('_')} in scratch log — must stay in env.`
    },
    {
      offset: 8 * day,
      kind: 'working',
      importance: 0.35,
      tags: ['scratch', 'css'],
      content: 'Temporary note: double check button padding on settings modal before Friday demo.'
    },
    {
      offset: 9 * day,
      kind: 'procedural',
      importance: 0.86,
      tags: ['redis', 'rate_limiter', 'api'],
      content: 'API rate_limiter in src/middleware/rateLimit.ts uses a Redis Lua sliding-window script. Always pass failOpen=true on health endpoints so Redis restarts never block Kubernetes liveness probes.'
    }
  ];

  const results = [];
  for (const ev of events) {
    results.push(
      engine.remember({
        namespace,
        kind: ev.kind,
        slotKey: ev.slotKey,
        importance: ev.importance,
        tags: ev.tags,
        content: ev.content,
        source: 'demo-seed',
        nowMs: baseTime + ev.offset
      })
    );
  }

  // Simulate realistic spaced recall to showcase ACT-R telemetry & savings.
  engine.recall({
    namespace,
    query: 'deploy timeout healthcheck session store',
    budgetTokens: 450,
    nowMs: Date.now() - 2 * day
  });
  engine.recall({
    namespace,
    query: 'how do we run unit tests',
    budgetTokens: 400,
    nowMs: Date.now() - 1 * day
  });

  return { seeded: results.length, namespace };
}
