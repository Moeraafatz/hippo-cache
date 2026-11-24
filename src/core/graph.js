/**
 * Hippocampal Associative Indexing via Personalized PageRank (PPR).
 *
 * Grounded in:
 * - HippoRAG (Gutiérrez et al., OSU/Stanford, arXiv:2405.14831)
 * - HippoRAG 2 (Gutiérrez et al., arXiv:2502.14802)
 * - A-MEM Zettelkasten Associative Linking (Xu et al., Rutgers, arXiv:2502.12110)
 *
 * Builds an IDF-weighted bipartite graph (Memory <-> Entity) augmented with
 * direct Zettelkasten memory-to-memory edges (excluding SUPERSEDES so stale
 * facts do not steal associative probability mass from current truth).
 */

export function runPersonalizedPageRank({
  memoryIds,
  entityLinks,    // Array<{ memory_id, entity_id, weight, df_count }>
  memoryEdges,    // Array<{ source_id, target_id, relation, weight }>
  seedScores,     // Map<memory_id, number>
  totalMemories,
  damping = 0.35, // Teleport probability alpha
  iterations = 18
}) {
  const result = new Map();
  if (!memoryIds || memoryIds.length === 0 || !seedScores || seedScores.size === 0) {
    return result;
  }

  // Assign contiguous integer indices for fast power iteration.
  // Nodes 0..M-1 are memories; nodes M..M+E-1 are entities.
  const memIndex = new Map();
  const M = memoryIds.length;
  for (let i = 0; i < M; i++) {
    memIndex.set(memoryIds[i], i);
  }

  const entIndex = new Map();
  let nextIdx = M;
  for (const link of entityLinks) {
    if (!memIndex.has(link.memory_id)) continue;
    if (!entIndex.has(link.entity_id)) {
      entIndex.set(link.entity_id, nextIdx++);
    }
  }

  const N = nextIdx;
  const adj = Array.from({ length: N }, () => []);
  const outWeight = new Float64Array(N);

  const addUndirected = (u, v, w) => {
    if (w <= 0) return;
    adj[u].push([v, w]);
    adj[v].push([u, w]);
    outWeight[u] += w;
    outWeight[v] += w;
  };

  const docCount = Math.max(2, totalMemories || M);

  // 1. Bipartite Memory <-> Entity edges weighted by smooth IDF
  // Rare specific symbols (e.g. `pgbouncer`, `src/auth/jwt.ts`) carry much higher associative power.
  for (const link of entityLinks) {
    const u = memIndex.get(link.memory_id);
    const v = entIndex.get(link.entity_id);
    if (u === undefined || v === undefined) continue;
    const df = Math.max(1, link.df_count || 1);
    const idf = Math.log(1 + docCount / (df + 0.5));
    const w = (link.weight || 1.0) * Math.max(0.15, idf);
    addUndirected(u, v, w);
  }

  // 2. Direct Zettelkasten memory-to-memory edges (skip SUPERSEDES to avoid leaking mass to dead facts)
  const relationBoost = {
    FIXES: 1.35,
    DEPENDS_ON: 1.25,
    DERIVED_FROM: 1.15,
    RELATES_TO: 0.95,
    CO_OCCURS: 0.75
  };

  for (const edge of memoryEdges) {
    if (edge.relation === 'SUPERSEDES') continue;
    const u = memIndex.get(edge.source_id);
    const v = memIndex.get(edge.target_id);
    if (u === undefined || v === undefined || u === v) continue;
    const boost = relationBoost[edge.relation] ?? 0.8;
    addUndirected(u, v, (edge.weight || 0.5) * boost);
  }

  // 3. Build normalized personalization vector s over seed memories
  const s = new Float64Array(N);
  let seedSum = 0;
  for (const [memId, score] of seedScores.entries()) {
    const idx = memIndex.get(memId);
    if (idx !== undefined && score > 0) {
      s[idx] = score;
      seedSum += score;
    }
  }
  if (seedSum <= 0) return result;
  for (let i = 0; i < N; i++) s[i] /= seedSum;

  // 4. Power iteration: r^(k+1) = alpha * s + (1 - alpha) * P^T r^(k)
  let r = Float64Array.from(s);
  let next = new Float64Array(N);
  const alpha = damping;
  const oneMinusAlpha = 1 - alpha;

  for (let iter = 0; iter < iterations; iter++) {
    next.fill(0);
    let danglingMass = 0;

    for (let u = 0; u < N; u++) {
      const ru = r[u];
      if (ru === 0) continue;
      const deg = outWeight[u];
      if (deg <= 0) {
        danglingMass += ru;
        continue;
      }
      const scale = (oneMinusAlpha * ru) / deg;
      const neighbors = adj[u];
      for (let k = 0; k < neighbors.length; k++) {
        const [v, w] = neighbors[k];
        next[v] += scale * w;
      }
    }

    let diff = 0;
    const teleportFactor = alpha + oneMinusAlpha * danglingMass;
    for (let i = 0; i < N; i++) {
      next[i] += teleportFactor * s[i];
      diff += Math.abs(next[i] - r[i]);
    }

    const tmp = r;
    r = next;
    next = tmp;
    if (diff < 1e-5) break;
  }

  // Extract propagated associative mass: a_i = max(0, r_i - alpha * s_i)
  // Separating edge-propagated mass from the raw seed teleport spike ensures
  // 2-hop associative neighbors (zero direct lexical overlap!) surface sharply
  // instead of being drowned 20x beneath the seed's own teleport mass.
  const propagated = new Float64Array(M);
  let maxProp = 0;
  let maxRaw = 0;
  for (let i = 0; i < M; i++) {
    const p = Math.max(0, r[i] - alpha * s[i]);
    propagated[i] = p;
    if (p > maxProp) maxProp = p;
    if (r[i] > maxRaw) maxRaw = r[i];
  }
  if (maxRaw <= 0) return result;

  for (let i = 0; i < M; i++) {
    const propNorm = maxProp > 0 ? propagated[i] / maxProp : 0;
    const rawNorm = r[i] / maxRaw;
    // Seeds get their blended raw+propagated score; non-seed multi-hop neighbors shine via propNorm.
    const score = s[i] > 0 ? Math.max(rawNorm, propNorm) : propNorm;
    result.set(memoryIds[i], score);
  }
  return result;
}
