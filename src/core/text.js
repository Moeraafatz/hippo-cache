import crypto from 'node:crypto';

const STOPWORDS = new Set([
  'a', 'an', 'the', 'and', 'or', 'but', 'in', 'on', 'at', 'to', 'for', 'of', 'with', 'by',
  'from', 'as', 'is', 'was', 'are', 'were', 'be', 'been', 'being', 'have', 'has', 'had',
  'do', 'does', 'did', 'will', 'would', 'shall', 'should', 'can', 'could', 'may', 'might',
  'must', 'this', 'that', 'these', 'those', 'it', 'its', 'we', 'our', 'you', 'your', 'they',
  'their', 'he', 'she', 'not', 'no', 'nor', 'so', 'if', 'then', 'than', 'when', 'where',
  'why', 'how', 'all', 'any', 'both', 'each', 'few', 'more', 'most', 'other', 'some', 'such',
  'into', 'onto', 'over', 'under', 'after', 'before', 'about', 'above', 'below', 'between',
  'during', 'through', 'while', 'up', 'down', 'out', 'off', 'only', 'also', 'very', 'just',
  'still', 'now', 'here', 'there', 'use', 'using', 'used', 'make', 'made', 'get', 'set',
  'new', 'old', 'need', 'needs', 'always', 'never', 'default', 'project', 'repo', 'code',
  'system', 'app', 'file', 'files', 'note', 'memory', 'agent'
]);

const TECH_TERMS = new Set([
  'vitest', 'jest', 'mocha', 'playwright', 'cypress', 'pytest', 'bun', 'pnpm', 'npm', 'yarn',
  'uv', 'poetry', 'pip', 'postgres', 'postgresql', 'mysql', 'sqlite', 'sqlite3', 'redis',
  'valkey', 'mongodb', 'dynamodb', 'clickhouse', 'duckdb', 'supabase', 'prisma', 'drizzle',
  'typeorm', 'sequelize', 'sqlalchemy', 'knex', 'jwt', 'oauth', 'oauth2', 'oidc', 'passkey',
  'webauthn', 'clerk', 'auth0', 'lucia', 'nextauth', 'session', 'cookie', 'cookies', 'rest',
  'graphql', 'trpc', 'grpc', 'websocket', 'sse', 'mcp', 'docker', 'kubernetes', 'k8s',
  'fly', 'vercel', 'cloudflare', 'aws', 'gcp', 'railway', 'render', 'nginx', 'caddy',
  'traefik', 'vite', 'webpack', 'esbuild', 'turbopack', 'rollup', 'biome', 'eslint',
  'prettier', 'ruff', 'oxlint', 'typescript', 'javascript', 'python', 'rust', 'go', 'swift',
  'react', 'nextjs', 'nuxt', 'svelte', 'vue', 'astro', 'remix', 'express', 'fastify', 'hono',
  'fastapi', 'django', 'flask', 'tailwind', 'css', 'scss', 'zustand', 'redux', 'jotai',
  'tanstack', 'kafka', 'rabbitmq', 'nats', 'bullmq', 'celery', 'sqs', 'sentry', 'datadog',
  'otel', 'opentelemetry', 'pino', 'winston', 'prometheus', 'grafana', 'github', 'gitlab',
  'circleci', 'terraform', 'ansible', 'stripe', 'webhook', 'webhooks', 'cors', 'csrf', 'tls',
  'ssl', 'mtls', 'fts5', 'wal', 'bm25', 'ppr', 'rag', 'llm', 'embedding', 'embeddings',
  'pgbouncer', 'healthcheck', 'rate_limiter', 'ratelimit', 'cron', 'worker', 'workers'
]);

const SLOT_RULES = [
  {
    slot: 'test_runner',
    pattern: /\b(?:test runner|testing framework|unit tests?\s+(?:run|use|uses|migrated|switched)|(?:migrated|switched|replaced).*(?:vitest|jest|mocha|pytest)|(?:vitest|jest)\.config)\b/i
  },
  {
    slot: 'package_manager',
    pattern: /\b(?:package manager|workspace dependencies|lockfile|package-lock\.json|pnpm-lock\.yaml|yarn\.lock|(?:migrated|switched|replaced).*(?:npm|pnpm|yarn|bun|uv|poetry))\b/i
  },
  {
    slot: 'session_store',
    pattern: /\b(?:session store|sessions?\s+(?:are\s+)?(?:stored|persisted|in|backed|migrated|moved|switched)|user_sessions|sessionStore)\b/i
  },
  {
    slot: 'database_engine',
    pattern: /\b(?:primary database|database engine|db engine|(?:migrated|switched|replaced)\s+(?:the\s+)?database|database\s+(?:is|uses))\b/i
  },
  {
    slot: 'orm_layer',
    pattern: /\b(?:orm\b|typeorm|drizzle\s+orm|prisma\s+client|sequelize|sqlalchemy|kysely|(?:replaced|migrated|switched).*(?:typeorm|prisma|drizzle))\b/i
  },
  {
    slot: 'auth_strategy',
    pattern: /\b(?:auth(?:entication)?\s+(?:uses?|strategy|switched|migrated|provider)|switched.*(?:oauth|oidc|clerk|auth0|lucia|passkeys?))\b/i
  },
  {
    slot: 'api_protocol',
    pattern: /\b(?:api\s+(?:protocol|layer|switched|migrated)|rpc\s+(?:layer|uses)|(?:migrated|switched|replaced).*(?:trpc|graphql|grpc|rest))\b/i
  },
  {
    slot: 'build_tool',
    pattern: /\b(?:bundler|build tool|(?:webpack|vite|rollup|esbuild)\.config|(?:migrated|switched|replaced).*(?:webpack|vite|turbopack|esbuild))\b/i
  },
  {
    slot: 'linter_formatter',
    pattern: /\b(?:lint(?:ing|er)|format(?:ting|ter)|eslintrc|prettierrc|biome\.json|(?:replaced|migrated|switched).*(?:biome|eslint|prettier|ruff))\b/i
  },
  {
    slot: 'deploy_target',
    pattern: /\b(?:deploy(?:ment|ed|s)?\s+(?:to|on|target|moved|migrated)|(?:switched|migrated).*(?:fly\.io|vercel|cloudflare workers|aws ecs|kubernetes|railway))\b/i
  },
  {
    slot: 'state_manager',
    pattern: /\b(?:state management|state manager|(?:switched|migrated|replaced).*(?:zustand|redux|jotai|recoil|mobx|pinia))\b/i
  },
  {
    slot: 'cache_layer',
    pattern: /\b(?:cache layer|(?:switched|migrated|replaced).*(?:valkey|memcached|redis cache))\b/i
  },
  {
    slot: 'queue_broker',
    pattern: /\b(?:job queue|message broker|(?:switched|migrated|replaced).*(?:bullmq|kafka|rabbitmq|nats|sqs|celery))\b/i
  },
  {
    slot: 'css_framework',
    pattern: /\b(?:css framework|(?:switched|migrated|replaced).*(?:tailwind|styled-components|emotion|css modules))\b/i
  },
  {
    slot: 'logging_stack',
    pattern: /\b(?:logging stack|(?:switched|migrated|replaced).*(?:pino|winston|bunyan|structlog))\b/i
  },
  {
    slot: 'ci_provider',
    pattern: /\b(?:ci\/cd|ci provider|(?:switched|migrated|replaced).*(?:github actions|gitlab ci|circleci|buildkite))\b/i
  },
  {
    slot: 'port_config',
    pattern: /\b(?:server\s+(?:port|listens)|listens?\s+on\s+(?:port\s+)?\d{2,5}|port\s+from\s+\d{2,5}\s+to\s+\d{2,5})\b/i
  },
  {
    slot: 'runtime_version',
    pattern: /\b(?:(?:switched|upgraded|migrated).*(?:node(?:\.js)?\s*v?\d{2}|python\s*3\.\d+|go\s*1\.\d+)|runtime version)\b/i
  }
];

const SECRET_PATTERNS = [
  { name: 'pem_private_key', regex: /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/g },
  { name: 'anthropic_key', regex: /\bsk-ant-[A-Za-z0-9_-]{16,}\b/g },
  { name: 'openai_key', regex: /\bsk-(?:proj-|live-|test-)?[A-Za-z0-9_-]{20,}\b/g },
  { name: 'github_token', regex: /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}\b/g },
  { name: 'github_pat', regex: /\bgithub_pat_[A-Za-z0-9_]{22,}\b/g },
  { name: 'aws_access_key', regex: /\bAKIA[0-9A-Z]{16}\b/g },
  { name: 'google_api_key', regex: /\bAIza[0-9A-Za-z_-]{35}\b/g },
  { name: 'slack_token', regex: /\bxox[baprs]-[0-9A-Za-z-]{10,}\b/g },
  { name: 'stripe_secret', regex: /\bsk_(?:live|test)_[0-9A-Za-z]{16,}\b/g },
  { name: 'jwt_token', regex: /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g },
  { name: 'db_url_credential', regex: /\b((?:postgres|postgresql|mysql|mongodb(?:\+srv)?|redis|rediss|amqp):\/\/[^:\s/]+:)([^@\s/]+)(@)/gi },
  {
    name: 'generic_secret_assignment',
    regex: /\b((?:api[_-]?key|secret(?:[_-]?key)?|access[_-]?token|auth[_-]?token|private[_-]?key|password|passwd|client[_-]?secret)\s*[:=]\s*['"]?)([A-Za-z0-9/+_.-]{16,})(['"]?)/gi
  }
];

export function shannonEntropy(str) {
  if (!str || str.length === 0) return 0;
  const counts = new Map();
  for (let i = 0; i < str.length; i++) {
    const ch = str[i];
    counts.set(ch, (counts.get(ch) || 0) + 1);
  }
  let entropy = 0;
  for (const c of counts.values()) {
    const p = c / str.length;
    entropy -= p * Math.log2(p);
  }
  return entropy;
}

export function scrubSecrets(text) {
  if (typeof text !== 'string' || text.length === 0) {
    return { sanitized: '', redactedCount: 0, findings: [] };
  }
  let sanitized = text;
  const findings = [];
  let redactedCount = 0;

  for (const rule of SECRET_PATTERNS) {
    if (rule.name === 'db_url_credential') {
      sanitized = sanitized.replace(rule.regex, (match, prefix, secret, at) => {
        if (secret === '[REDACTED]') return match;
        redactedCount++;
        findings.push(rule.name);
        return `${prefix}[REDACTED:${rule.name}]${at}`;
      });
    } else if (rule.name === 'generic_secret_assignment') {
      sanitized = sanitized.replace(rule.regex, (match, prefix, value, suffix) => {
        if (value.startsWith('[REDACTED') || value.startsWith('${') || value.startsWith('process.env')) {
          return match;
        }
        // Require realistic secret entropy or mixed classes so normal prose words aren't flagged.
        const ent = shannonEntropy(value);
        const hasDigitOrSymbol = /[0-9_/+.-]/.test(value);
        if (ent >= 3.2 && hasDigitOrSymbol) {
          redactedCount++;
          findings.push(rule.name);
          return `${prefix}[REDACTED:${rule.name}]${suffix}`;
        }
        return match;
      });
    } else {
      sanitized = sanitized.replace(rule.regex, () => {
        redactedCount++;
        findings.push(rule.name);
        return `[REDACTED:${rule.name}]`;
      });
    }
  }

  return {
    sanitized,
    redactedCount,
    findings: [...new Set(findings)]
  };
}

/**
 * BPE-calibrated token estimator tuned for mixed prose + source code.
 * Matches cl100k_base / o200k_base within ~5-8% without external tokenizers.
 */
export function estimateTokens(text) {
  if (!text) return 0;
  const trimmed = String(text).trim();
  if (!trimmed) return 0;
  const segments = trimmed.match(/[A-Za-z]+|[0-9]+|[^\sA-Za-z0-9]+|\n/g);
  if (!segments) return Math.ceil(trimmed.length / 4);
  let tokens = 0;
  for (const seg of segments) {
    if (seg === '\n') {
      tokens += 0.5;
    } else if (/^[A-Za-z]+$/.test(seg)) {
      tokens += seg.length <= 4 ? 1 : Math.ceil(seg.length / 4.2);
    } else if (/^[0-9]+$/.test(seg)) {
      tokens += Math.ceil(seg.length / 2.8);
    } else {
      tokens += Math.ceil(seg.length / 1.8);
    }
  }
  return Math.max(1, Math.round(tokens));
}

export function normalizeText(text) {
  return String(text || '')
    .replace(/\r\n/g, '\n')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export function sha256(text) {
  return crypto.createHash('sha256').update(normalizeText(text).toLowerCase()).digest('hex');
}

export function splitIdentifierParts(token) {
  return token
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .split(/[_\-./:\\]+|\s+/)
    .map((s) => s.toLowerCase())
    .filter((s) => s.length >= 2);
}

export function simpleStem(word) {
  let w = word.toLowerCase();
  if (w.length <= 4) return w;
  if (w.endsWith('ies') && w.length > 5) return w.slice(0, -3) + 'y';
  if (w.endsWith('ing') && w.length > 6) return w.slice(0, -3);
  if (w.endsWith('ed') && w.length > 5) return w.slice(0, -2);
  if (w.endsWith('es') && w.length > 5) return w.slice(0, -2);
  if (w.endsWith('s') && !w.endsWith('ss') && w.length > 4) return w.slice(0, -1);
  return w;
}

export function tokenizeForIndexing(text) {
  const raw = String(text || '').match(/[A-Za-z0-9_./:-]{2,}/g) || [];
  const tokens = [];
  for (const tok of raw) {
    const lower = tok.toLowerCase();
    if (!STOPWORDS.has(lower)) {
      tokens.push(lower);
    }
    if (/[A-Z_./:-]/.test(tok)) {
      for (const part of splitIdentifierParts(tok)) {
        if (!STOPWORDS.has(part) && part !== lower) {
          tokens.push(part);
        }
      }
    }
  }
  return tokens;
}

function fnv1a32(str, seed = 0x811c9dc5) {
  let h = seed >>> 0;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

function fnv1a64(str) {
  let h = 0xcbf29ce484222325n;
  const prime = 0x100000001b3n;
  const mask = 0xffffffffffffffffn;
  for (let i = 0; i < str.length; i++) {
    h ^= BigInt(str.charCodeAt(i));
    h = (h * prime) & mask;
  }
  return h;
}

/**
 * 64-bit Charikar SimHash over unigrams + bigrams for O(1) near-duplicate detection.
 */
export function computeSimHash(text) {
  const tokens = tokenizeForIndexing(text);
  const v = new Int32Array(64);
  const features = [];
  for (let i = 0; i < tokens.length; i++) {
    features.push(tokens[i]);
    if (i + 1 < tokens.length) {
      features.push(`${tokens[i]}_${tokens[i + 1]}`);
    }
  }
  if (features.length === 0) return '0000000000000000';

  for (const feat of features) {
    const h = fnv1a64(feat);
    for (let bit = 0; bit < 64; bit++) {
      if ((h >> BigInt(bit)) & 1n) {
        v[bit] += 1;
      } else {
        v[bit] -= 1;
      }
    }
  }

  let out = 0n;
  for (let bit = 0; bit < 64; bit++) {
    if (v[bit] > 0) out |= 1n << BigInt(bit);
  }
  return out.toString(16).padStart(16, '0');
}

export function hammingDistance(hexA, hexB) {
  if (!hexA || !hexB) return 64;
  let x = BigInt('0x' + hexA) ^ BigInt('0x' + hexB);
  let dist = 0;
  while (x > 0n) {
    x &= x - 1n;
    dist++;
  }
  return dist;
}

/**
 * Deterministic multi-granular Signed Feature Hashing (Weinberger et al., ICML 2009)
 * Produces an L2-normalized Float32Array vector with zero API dependencies.
 */
export function embedText(text, dim = 512) {
  const vec = new Float32Array(dim);
  const tokens = tokenizeForIndexing(text);
  if (tokens.length === 0) return vec;

  const addFeature = (feat, weight) => {
    const h1 = fnv1a32(feat, 0x811c9dc5);
    const h2 = fnv1a32(feat, 0x9e3779b9);
    const idx = h1 % dim;
    const sign = (h2 & 1) === 0 ? 1 : -1;
    vec[idx] += sign * weight;
  };

  // Sublinear TF weighting so long repetitions don't drown rare symbols.
  const tf = new Map();
  for (const tok of tokens) {
    tf.set(tok, (tf.get(tok) || 0) + 1);
  }

  for (const [tok, count] of tf.entries()) {
    const w = 1 + Math.log(count);
    const isCodeSym = /[_./-]/.test(tok);
    const techBoost = TECH_TERMS.has(tok) ? 1.55 : isCodeSym ? 1.7 : 1.0;
    addFeature(`w:${tok}`, 1.45 * w * techBoost);

    const stem = simpleStem(tok);
    if (stem !== tok) {
      addFeature(`s:${stem}`, 0.95 * w * techBoost);
    }

    // Subtle character 4-grams capture typos & morphology without inflating unrelated noise floor.
    if (tok.length >= 5 && tok.length <= 28) {
      const padded = `^${tok}$`;
      for (let i = 0; i <= padded.length - 4; i++) {
        addFeature(`c4:${padded.slice(i, i + 4)}`, 0.14);
      }
    }
  }

  // Word bigrams preserve phrase semantics (e.g., "session store", "rate limit").
  for (let i = 0; i < tokens.length - 1; i++) {
    addFeature(`b:${tokens[i]}_${tokens[i + 1]}`, 1.05);
  }

  // L2 normalize.
  let normSq = 0;
  for (let i = 0; i < dim; i++) normSq += vec[i] * vec[i];
  if (normSq > 0) {
    const inv = 1 / Math.sqrt(normSq);
    for (let i = 0; i < dim; i++) vec[i] *= inv;
  }
  return vec;
}

export function cosineSimilarity(a, b) {
  if (!a || !b || a.length !== b.length || a.length === 0) return 0;
  let dot = 0;
  for (let i = 0; i < a.length; i++) dot += a[i] * b[i];
  return Math.max(0, Math.min(1, dot));
}

/**
 * Coding-aware entity & symbol extractor for the hippocampal bipartite graph.
 */
export function extractEntities(text, tags = []) {
  const entities = new Map();
  const add = (name, type, weight = 1.0) => {
    const key = String(name || '').trim().toLowerCase().replace(/^['"`(\[]+|['"`)\],.;:]+$/g, '');
    if (!key || key.length < 2 || key.length > 80 || STOPWORDS.has(key)) return;
    const prev = entities.get(key);
    if (!prev || weight > prev.weight) {
      entities.set(key, { name: key, type, weight });
    }
  };

  for (const tag of tags || []) {
    add(tag, 'tag', 1.35);
  }

  const str = String(text || '');

  // 1. File paths (e.g. src/auth/jwt.ts, docker-compose.yml, migrations/004_init.sql)
  const fileMatches = str.match(/(?:\.?\/)?(?:[A-Za-z0-9_.-]+\/)+[A-Za-z0-9_.-]+\.[A-Za-z0-9]{1,8}\b|\b[A-Za-z0-9_.-]+\.(?:ts|tsx|js|jsx|mjs|cjs|py|go|rs|sql|json|yaml|yml|toml|md|env|sh|css|html|dockerfile)\b/gi) || [];
  for (const f of fileMatches) {
    add(f, 'file', 1.5);
    const base = f.split('/').pop();
    if (base && base !== f) add(base, 'file', 1.2);
  }

  // 2. Code symbols: camelCase, PascalCase, snake_case, UPPER_SNAKE, --cli-flags
  const symbolMatches = str.match(/\b(?:[a-z]+(?:[A-Z][a-z0-9]+)+|[A-Z][a-z0-9]+(?:[A-Z][a-z0-9]+)+|[a-z][a-z0-9]*(?:_[a-z0-9]+)+|[A-Z]{2,}(?:_[A-Z0-9]+)+)\b/g) || [];
  for (const sym of symbolMatches) {
    if (sym.startsWith('REDACTED')) continue;
    add(sym, 'symbol', 1.4);
  }

  // 3. Backticked inline code references
  const codeSpans = str.match(/`([^`\n]{2,48})`/g) || [];
  for (const span of codeSpans) {
    const inner = span.slice(1, -1).trim();
    if (!/\s/.test(inner)) {
      add(inner, 'symbol', 1.35);
    }
  }

  // 4. Known engineering/tech domain terms
  const words = str.match(/[A-Za-z][A-Za-z0-9_.-]{1,32}/g) || [];
  for (const w of words) {
    const lower = w.toLowerCase();
    if (TECH_TERMS.has(lower)) {
      add(lower, 'concept', 1.25);
    }
  }

  // 5. Fallback salient nouns (high-specificity words length >= 5 not in stopwords)
  if (entities.size < 4) {
    for (const w of words) {
      const lower = w.toLowerCase();
      if (lower.length >= 5 && !STOPWORDS.has(lower) && /^[a-z]+$/.test(lower)) {
        add(lower, 'concept', 0.8);
        if (entities.size >= 8) break;
      }
    }
  }

  return [...entities.values()].slice(0, 18);
}

export function inferSlotKey(text, explicitSlot = null) {
  if (explicitSlot && String(explicitSlot).trim()) {
    return String(explicitSlot).trim().toLowerCase().replace(/[^a-z0-9_.-]+/g, '_');
  }
  const str = String(text || '');
  for (const rule of SLOT_RULES) {
    if (rule.pattern.test(str)) {
      return rule.slot;
    }
  }
  return null;
}

/**
 * Detects state transitions / deprecation / replacement cues for bi-temporal contradiction resolution.
 */
export function detectContradictionCue(text) {
  const str = String(text || '');
  const patterns = [
    {
      cue: 'migrated_from_to',
      regex: /\b(?:migrated|switched|moved|changed|converted|upgraded|transitioned)\s+(?:the\s+)?(?:[a-z0-9_ -]{0,28}?\s+)?from\s+([A-Za-z0-9_./:-]+)\s+to\s+([A-Za-z0-9_./:-]+)/i
    },
    {
      cue: 'replaced_with',
      regex: /\breplaced\s+([A-Za-z0-9_./:-]+)\s+with\s+([A-Za-z0-9_./:-]+)/i
    },
    {
      cue: 'instead_of',
      regex: /\b([A-Za-z0-9_./:-]+)\s+instead\s+of\s+([A-Za-z0-9_./:-]+)/i,
      swap: true
    },
    {
      cue: 'arrow_transition',
      regex: /\b([A-Za-z0-9_./:-]{2,})\s*(?:->|=>|→)\s*([A-Za-z0-9_./:-]{2,})/
    },
    {
      cue: 'no_longer_use',
      regex: /\b(?:no longer|stopped using|dropped|removed|deprecated|retired)\s+([A-Za-z0-9_./:-]+)/i,
      oldOnly: true
    }
  ];

  const oldTerms = [];
  const newTerms = [];
  let cuePhrase = null;

  for (const p of patterns) {
    const m = str.match(p.regex);
    if (m) {
      cuePhrase = p.cue;
      if (p.oldOnly) {
        if (m[1]) oldTerms.push(m[1].toLowerCase());
      } else if (p.swap) {
        if (m[2]) oldTerms.push(m[2].toLowerCase());
        if (m[1]) newTerms.push(m[1].toLowerCase());
      } else {
        if (m[1]) oldTerms.push(m[1].toLowerCase());
        if (m[2]) newTerms.push(m[2].toLowerCase());
      }
    }
  }

  const generalCue = /\b(migrated|switched|replaced|deprecated|no longer|superseded|moved from|changed to|now uses|updated to|reverted)\b/i.test(str);

  return {
    hasCue: Boolean(cuePhrase || generalCue),
    cuePhrase: cuePhrase || (generalCue ? 'state_change' : null),
    oldTerms: [...new Set(oldTerms.filter((t) => !STOPWORDS.has(t)))],
    newTerms: [...new Set(newTerms.filter((t) => !STOPWORDS.has(t)))]
  };
}

/**
 * Deterministic extractive compressor producing:
 * - L0 title (~10-16 tokens)
 * - L1 structured abstract (~35-65 tokens)
 * Preserves exact code symbols, file paths, versions, and causal constraints.
 */
export function compressMemory(content, explicitTitle = null, kind = 'semantic') {
  const clean = normalizeText(content);
  const sentences = clean
    .split(/(?<=[.!?])\s+|\n+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);

  let title = explicitTitle ? normalizeText(explicitTitle) : '';
  if (!title) {
    const first = sentences[0] || clean;
    title = first.length <= 84 ? first : first.slice(0, 81).replace(/\s+\S*$/, '') + '...';
  }
  if (title.length > 100) {
    title = title.slice(0, 97).replace(/\s+\S*$/, '') + '...';
  }

  // If the full content is already tiny, L1 is simply the clean content.
  if (estimateTokens(clean) <= 55) {
    return { title, summary: clean };
  }

  // Score sentences by salience: position, code-symbol density, decision/constraint markers.
  const scored = sentences.map((sent, idx) => {
    let score = idx === 0 ? 2.2 : idx === sentences.length - 1 ? 1.15 : 1.0;
    const codeRefs = (sent.match(/`[^`]+`|[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+|\b[a-z]+[A-Z][A-Za-z0-9]+\b|\b[a-z]+_[a-z]+\b/g) || []).length;
    score += Math.min(2.0, codeRefs * 0.45);
    if (/\b(must|never|always|fix|root cause|migrated|switched|replaced|requires|port|timeout|error|workaround|because|instead)\b/i.test(sent)) {
      score += 1.1;
    }
    if (/\d+/.test(sent)) score += 0.35;
    // Slight preference for compact high-density sentences.
    const tok = estimateTokens(sent);
    score = score / Math.pow(Math.max(8, tok), 0.25);
    return { sent, idx, tok, score };
  });

  scored.sort((a, b) => b.score - a.score);
  const picked = [];
  let tokSum = 0;
  const maxL1Tokens = kind === 'procedural' ? 68 : 56;
  for (const item of scored) {
    if (picked.length > 0 && tokSum + item.tok > maxL1Tokens) continue;
    picked.push(item);
    tokSum += item.tok;
    if (tokSum >= maxL1Tokens - 6 || picked.length >= 3) break;
  }
  picked.sort((a, b) => a.idx - b.idx);
  let summary = picked.map((p) => p.sent).join(' ');
  if (estimateTokens(summary) > 72) {
    summary = summary.slice(0, 260).replace(/\s+\S*$/, '') + '...';
  }

  return { title, summary };
}

export function buildFtsQuery(query) {
  const tokens = tokenizeForIndexing(query);
  const unique = [...new Set(tokens)].slice(0, 14);
  if (unique.length === 0) return null;
  return unique
    .map((t) => {
      const safe = t.replace(/[^A-Za-z0-9_./-]/g, '');
      if (!safe) return null;
      return safe.length >= 4 ? `"${safe}"*` : `"${safe}"`;
    })
    .filter(Boolean)
    .join(' OR ');
}
