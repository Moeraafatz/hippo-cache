import crypto from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { openStore, float32ToBuffer, bufferToFloat32 } from '../db/store.js';
import {
  scrubSecrets,
  estimateTokens,
  normalizeText,
  sha256,
  computeSimHash,
  hammingDistance,
  embedText,
  cosineSimilarity,
  extractEntities,
  inferSlotKey,
  detectContradictionCue,
  compressMemory,
  buildFtsQuery,
  tokenizeForIndexing
} from './text.js';
import {
  computeBaseLevelActivation,
  updateStabilityOnAccess,
  classifyHealth,
  sampleDecayCurve
} from './actr.js';
import { runPersonalizedPageRank } from './graph.js';
import { packSubmodularKnapsack } from './knapsack.js';

const VALID_KINDS = new Set(['working', 'episodic', 'semantic', 'procedural']);

function generateId() {
  return 'mem_' + crypto.randomBytes(5).toString('hex');
}

function safeJsonParse(str, fallback) {
  try {
    return JSON.parse(str);
  } catch {
    return fallback;
  }
}

export class HippoCacheEngine {
  constructor(dbPath = '.hippo-cache/memory.db') {
    this.dbPath = dbPath;
    this.db = openStore(dbPath);
    this.listeners = new Set();
  }

  close() {
    if (this.db) {
      this.db.close();
      this.db = null;
    }
  }

  subscribe(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  emit(event) {
    for (const fn of this.listeners) {
      try {
        fn(event);
      } catch {
        // Ignore broken SSE listeners
      }
    }
  }

  /**
   * Ingest a memory with secret scrubbing, exact + SimHash dedup, entity indexing,
   * bi-temporal contradiction resolution, and Zettelkasten associative auto-linking.
   */
  remember(input) {
    const start = performance.now();
    const now = typeof input.nowMs === 'number' ? input.nowMs : Date.now();
    const namespace = String(input.namespace || 'default').trim() || 'default';
    const kind = VALID_KINDS.has(input.kind) ? input.kind : 'semantic';
    const importance = Math.max(0.05, Math.min(1.0, Number(input.importance ?? 0.65)));
    const source = String(input.source || 'agent').trim();
    const tags = Array.isArray(input.tags)
      ? input.tags.map((t) => String(t).trim().toLowerCase()).filter(Boolean)
      : [];
    const metadata = input.metadata && typeof input.metadata === 'object' ? { ...input.metadata } : {};
    const validFrom = typeof input.validFrom === 'number' ? input.validFrom : now;

    const rawContent = normalizeText(input.content || '');
    if (!rawContent) {
      throw new Error('Memory content cannot be empty.');
    }

    // 1. Write-path Security Gate: Secret Scrubber
    const contentScrub = scrubSecrets(rawContent);
    const titleScrub = input.title ? scrubSecrets(normalizeText(input.title)) : { sanitized: '', redactedCount: 0, findings: [] };
    const cleanContent = contentScrub.sanitized;
    const secretsRedacted = contentScrub.redactedCount + titleScrub.redactedCount;
    const secretFindings = [...new Set([...contentScrub.findings, ...titleScrub.findings])];
    if (secretsRedacted > 0) {
      metadata.secrets_redacted = secretsRedacted;
      metadata.secret_types = secretFindings;
    }

    // 2. Progressive 3-Tier Compression (L0 / L1 / L2)
    // All three tiers include consistent handle framing overhead (+4 tokens) so L0 <= L1 <= L2.
    const { title, summary } = compressMemory(cleanContent, titleScrub.sanitized || null, kind);
    const tokensL2 = estimateTokens(cleanContent) + 4;
    const tokensL1 = Math.min(tokensL2, estimateTokens(summary) + 4);
    const tokensL0 = Math.min(tokensL1, estimateTokens(title) + 4);

    const contentHash = sha256(cleanContent);
    const simhash = computeSimHash(cleanContent);
    const vector = embedText(`${title} ${cleanContent} ${tags.join(' ')}`);
    const slotKey = inferSlotKey(`${title} ${cleanContent}`, input.slotKey || null);
    const cue = detectContradictionCue(`${title} ${cleanContent}`);
    const entities = extractEntities(`${title} ${cleanContent}`, tags);

    // 3. Exact Content-Addressed Deduplication
    const exactMatch = this.db
      .prepare(`SELECT * FROM memories WHERE namespace = ? AND content_hash = ? AND status = 'active' LIMIT 1`)
      .get(namespace, contentHash);

    if (exactMatch && !input.supersedes) {
      const reinforced = this._reinforceMemory(exactMatch.id, now, 1.0);
      this._recordTelemetry(namespace, 'remember_dedup', title, 0, tokensL2, tokensL2, performance.now() - start, secretsRedacted);
      this.emit({ type: 'memory_reinforced', namespace, memoryId: exactMatch.id });
      return {
        action: 'reinforced_exact',
        memory: this._hydrateRow(reinforced, now),
        secretsRedacted,
        secretFindings,
        superseded: [],
        linkedEdges: []
      };
    }

    // 4. SimHash + Cosine Near-Duplicate Deduplication (skip if contradiction cue present)
    const activeRows = this.db
      .prepare(`SELECT id, kind, title, summary, content, simhash, slot_key, vector_blob, importance, stability, last_accessed_at, access_count, valid_from FROM memories WHERE namespace = ? AND status = 'active'`)
      .all(namespace);

    if (!cue.hasCue && !input.supersedes) {
      for (const row of activeRows) {
        if (row.kind !== kind) continue;
        const hDist = hammingDistance(simhash, row.simhash);
        if (hDist <= 12) {
          const rowVec = bufferToFloat32(row.vector_blob);
          const sim = cosineSimilarity(vector, rowVec);
          if (sim >= 0.84) {
            const reinforced = this._reinforceMemory(row.id, now, 1.0);
            this._recordTelemetry(namespace, 'remember_simhash_dedup', title, 0, tokensL2, tokensL2, performance.now() - start, secretsRedacted);
            this.emit({ type: 'memory_reinforced', namespace, memoryId: row.id });
            return {
              action: 'reinforced_near_duplicate',
              memory: this._hydrateRow(reinforced, now),
              secretsRedacted,
              secretFindings,
              superseded: [],
              linkedEdges: []
            };
          }
        }
      }
    }

    // 5. Persist Memory + FTS5 + ACT-R Initial Access + Entities
    const id = generateId();
    const { activation } = computeBaseLevelActivation({
      accessTimestamps: [now],
      nowMs: now,
      kind,
      importance,
      stability: 1.0
    });

    this.db.exec('BEGIN');
    try {
      this.db
        .prepare(`
          INSERT INTO memories (
            id, namespace, kind, title, summary, content, content_hash, simhash, slot_key,
            importance, stability, activation, access_count,
            tokens_l0, tokens_l1, tokens_l2, vector_blob,
            tags_json, metadata_json, source, status, superseded_by,
            valid_from, valid_until, created_at, updated_at, last_accessed_at
          ) VALUES (
            ?, ?, ?, ?, ?, ?, ?, ?, ?,
            ?, 1.0, ?, 1,
            ?, ?, ?, ?,
            ?, ?, ?, 'active', NULL,
            ?, NULL, ?, ?, ?
          )
        `)
        .run(
          id, namespace, kind, title, summary, cleanContent, contentHash, simhash, slotKey,
          importance, activation,
          tokensL0, tokensL1, tokensL2, float32ToBuffer(vector),
          JSON.stringify(tags), JSON.stringify(metadata), source,
          validFrom, now, now, now
        );

      this.db
        .prepare(`INSERT INTO memories_fts (memory_id, namespace, title, summary, content, tags) VALUES (?, ?, ?, ?, ?, ?)`)
        .run(id, namespace, title, summary, cleanContent, tags.join(' '));

      this.db
        .prepare(`INSERT INTO access_events (memory_id, accessed_at, boost) VALUES (?, ?, 1.0)`)
        .run(id, now);

      const entityIds = new Set();
      for (const ent of entities) {
        this.db
          .prepare(`
            INSERT INTO entities (namespace, name, entity_type, df_count, created_at)
            VALUES (?, ?, ?, 1, ?)
            ON CONFLICT(namespace, name) DO UPDATE SET df_count = df_count + 1
          `)
          .run(namespace, ent.name, ent.type, now);

        const entRow = this.db
          .prepare(`SELECT id FROM entities WHERE namespace = ? AND name = ?`)
          .get(namespace, ent.name);

        if (entRow) {
          entityIds.add(entRow.id);
          this.db
            .prepare(`INSERT OR REPLACE INTO memory_entities (memory_id, entity_id, weight) VALUES (?, ?, ?)`)
            .run(id, entRow.id, ent.weight);
        }
      }

      // 6. Bi-Temporal Contradiction Resolution
      const superseded = this._resolveContradictions({
        namespace,
        newId: id,
        newKind: kind,
        newTitle: title,
        newContent: cleanContent,
        newSlotKey: slotKey,
        newVector: vector,
        newEntities: new Set(entities.map((e) => e.name)),
        cue,
        explicitSupersedes: input.supersedes || null,
        activeRows,
        now
      });

      // 7. A-MEM Zettelkasten Associative Auto-Linking
      const linkedEdges = this._autoLinkZettelkasten({
        namespace,
        newId: id,
        newContent: cleanContent,
        newVector: vector,
        newEntityIds: entityIds,
        supersededIds: new Set(superseded.map((s) => s.older_memory_id)),
        activeRows,
        now
      });

      this.db.exec('COMMIT');

      const stored = this.db.prepare(`SELECT * FROM memories WHERE id = ?`).get(id);
      this._recordTelemetry(namespace, 'remember', title, tokensL1, tokensL2, Math.max(0, tokensL2 - tokensL1), performance.now() - start, secretsRedacted);
      this.emit({ type: 'memory_created', namespace, memoryId: id, supersededCount: superseded.length, secretsRedacted });

      return {
        action: 'created',
        memory: this._hydrateRow(stored, now),
        entities: entities.map((e) => e.name),
        secretsRedacted,
        secretFindings,
        superseded,
        linkedEdges
      };
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }

  _resolveContradictions({
    namespace,
    newId,
    newKind,
    newContent,
    newSlotKey,
    newVector,
    newEntities,
    cue,
    explicitSupersedes,
    activeRows,
    now
  }) {
    const superseded = [];
    const supersededSet = new Set();

    const markSuperseded = (oldRow, reason, confidence) => {
      if (!oldRow || oldRow.id === newId || supersededSet.has(oldRow.id)) return;
      supersededSet.add(oldRow.id);

      this.db
        .prepare(`UPDATE memories SET status = 'superseded', valid_until = ?, superseded_by = ?, updated_at = ? WHERE id = ?`)
        .run(now, newId, now, oldRow.id);

      this.db
        .prepare(`
          INSERT OR REPLACE INTO memory_edges (namespace, source_id, target_id, relation, weight, reason, created_at)
          VALUES (?, ?, ?, 'SUPERSEDES', ?, ?, ?)
        `)
        .run(namespace, newId, oldRow.id, confidence, reason, now);

      this.db
        .prepare(`
          INSERT INTO contradictions (namespace, older_memory_id, newer_memory_id, slot_key, reason, confidence, detected_at)
          VALUES (?, ?, ?, ?, ?, ?, ?)
        `)
        .run(namespace, oldRow.id, newId, newSlotKey || oldRow.slot_key || null, reason, confidence, now);

      superseded.push({
        older_memory_id: oldRow.id,
        older_title: oldRow.title,
        reason,
        confidence
      });
    };

    // Case A: Explicit supersedes ID supplied by agent/user
    if (explicitSupersedes) {
      const target = activeRows.find((r) => r.id === explicitSupersedes);
      if (target) {
        markSuperseded(target, 'explicit_supersedes', 1.0);
      }
    }

    // Case B: Slot-key & migration-cue automatic bi-temporal contradiction resolution
    const newLower = newContent.toLowerCase();
    for (const oldRow of activeRows) {
      if (supersededSet.has(oldRow.id)) continue;
      const oldLower = `${oldRow.title} ${oldRow.content}`.toLowerCase();
      const oldVec = bufferToFloat32(oldRow.vector_blob);
      const sim = cosineSimilarity(newVector, oldVec);

      // B1: Explicit transition cue naming old term found in existing memory (e.g. "migrated from Jest to Vitest")
      if (cue.oldTerms.length > 0) {
        const matchedOld = cue.oldTerms.find((term) => term.length >= 2 && new RegExp(`\\b${term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i').test(oldLower));
        if (matchedOld) {
          const sameSlot = Boolean(newSlotKey && oldRow.slot_key && newSlotKey === oldRow.slot_key);
          // Avoid superseding a memory that already describes the new target state as active.
          const oldAlreadyHasNew = cue.newTerms.some(
            (nt) => nt.length >= 2 && new RegExp(`\\b${nt.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i').test(oldLower)
          );
          if ((sameSlot || sim >= 0.2) && !oldAlreadyHasNew) {
            markSuperseded(
              oldRow,
              `state_transition(${cue.cuePhrase}: ${matchedOld} -> ${cue.newTerms.join('/') || 'retired'})`,
              sameSlot ? 0.96 : 0.88
            );
            continue;
          }
        }
      }

      // B2: Same semantic slot_key with state-change cue (e.g. both are `port_config` or `session_store`)
      if (newSlotKey && oldRow.slot_key === newSlotKey) {
        const oldAlreadyMatchesNew =
          cue.newTerms.length > 0 &&
          cue.newTerms.some(
            (nt) => nt.length >= 2 && new RegExp(`\\b${nt.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i').test(oldLower)
          );
        const oldMentionsOld =
          cue.oldTerms.length === 0 ||
          cue.oldTerms.some(
            (ot) => ot.length >= 2 && new RegExp(`\\b${ot.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i').test(oldLower)
          );
        if (cue.hasCue && oldMentionsOld && !oldAlreadyMatchesNew) {
          markSuperseded(oldRow, `slot_update(${newSlotKey}, ${cue.cuePhrase})`, 0.92);
          continue;
        }
        // Check conflicting numeric ports on `port_config` slot
        if (newSlotKey === 'port_config') {
          const oldPort = oldLower.match(/\b(?:port\s+|localhost:)(\d{2,5})\b/i)?.[1];
          const newPort = newLower.match(/\b(?:port\s+|localhost:)(\d{2,5})\b/i)?.[1];
          if (oldPort && newPort && oldPort !== newPort && sim >= 0.25) {
            markSuperseded(oldRow, `port_conflict(${oldPort} -> ${newPort})`, 0.9);
            continue;
          }
        }
        // Competing declarative statements on the same explicit slot (both semantic/procedural)
        if (
          (newKind === 'semantic' || newKind === 'procedural') &&
          (oldRow.kind === 'semantic' || oldRow.kind === 'procedural') &&
          sim >= 0.28 &&
          sim < 0.86
        ) {
          // Verify there is an entity divergence (not merely additive info on the same tech)
          const oldEntRows = this.db
            .prepare(`SELECT e.name FROM memory_entities me JOIN entities e ON e.id = me.entity_id WHERE me.memory_id = ?`)
            .all(oldRow.id);
          const oldEntNames = new Set(oldEntRows.map((r) => r.name));
          let exclusiveOld = 0;
          let exclusiveNew = 0;
          for (const e of oldEntNames) if (!newEntities.has(e)) exclusiveOld++;
          for (const e of newEntities) if (!oldEntNames.has(e)) exclusiveNew++;
          if (exclusiveOld >= 1 && exclusiveNew >= 1 && /\b(uses?|is|switched|runs?|configured|default|now)\b/i.test(newLower)) {
            markSuperseded(oldRow, `slot_replacement(${newSlotKey})`, 0.82);
          }
        }
      }
    }

    return superseded;
  }

  _autoLinkZettelkasten({ namespace, newId, newContent, newVector, newEntityIds, supersededIds, activeRows, now }) {
    if (activeRows.length === 0) return [];
    const scored = [];
    const isFix = /\b(fix|fixed|resolved|workaround|patch|solved|root cause)\b/i.test(newContent);
    const isDep = /\b(requires?|depends? on|needs?|after|before|grace period|healthcheck)\b/i.test(newContent);

    // Fetch entity overlap counts in one query.
    const overlapMap = new Map();
    if (newEntityIds.size > 0) {
      const idList = [...newEntityIds];
      const placeholders = idList.map(() => '?').join(',');
      const rows = this.db
        .prepare(`
          SELECT memory_id, COUNT(*) as cnt
          FROM memory_entities
          WHERE entity_id IN (${placeholders}) AND memory_id != ?
          GROUP BY memory_id
        `)
        .all(...idList, newId);
      for (const r of rows) overlapMap.set(r.memory_id, r.cnt);
    }

    for (const row of activeRows) {
      if (row.id === newId || supersededIds.has(row.id)) continue;
      const sim = cosineSimilarity(newVector, bufferToFloat32(row.vector_blob));
      const sharedEnts = overlapMap.get(row.id) || 0;
      const affinity = 0.6 * sim + 0.4 * Math.min(1, sharedEnts / 3);
      if (affinity >= 0.28 || sharedEnts >= 2) {
        scored.push({ row, affinity, sharedEnts, sim });
      }
    }

    scored.sort((a, b) => b.affinity - a.affinity);
    const top = scored.slice(0, 3);
    const created = [];

    for (const item of top) {
      let relation = 'RELATES_TO';
      if (isFix && item.row.kind === 'episodic') relation = 'FIXES';
      else if (isDep) relation = 'DEPENDS_ON';
      else if (item.sharedEnts >= 2 && item.sim < 0.25) relation = 'CO_OCCURS';

      const weight = Number(Math.min(1.0, item.affinity).toFixed(3));
      const reason = `auto_link(sim=${item.sim.toFixed(2)}, shared_entities=${item.sharedEnts})`;
      this.db
        .prepare(`
          INSERT OR IGNORE INTO memory_edges (namespace, source_id, target_id, relation, weight, reason, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?)
        `)
        .run(namespace, newId, item.row.id, relation, weight, reason, now);

      created.push({ target_id: item.row.id, relation, weight });
    }
    return created;
  }

  /**
   * Hybrid Recall:
   *  1. SQLite FTS5 BM25 + 256-d Feature-Hashed Cosine + Direct Entity Hits -> Reciprocal Rank Fusion (RRF)
   *  2. HippoRAG Personalized PageRank (PPR) multi-hop associative spread
   *  3. Live ACT-R Base-Level Activation modulation
   *  4. Submodular Marginal-Gain Knapsack packing under hard token budget with L0/L1/L2 disclosure
   */
  recall(input) {
    const start = performance.now();
    const namespace = String(input.namespace || 'default').trim() || 'default';
    const query = normalizeText(input.query || '');
    const budgetTokens = Math.max(40, Math.min(8000, Number(input.budgetTokens ?? 600)));
    const disclosure = String(input.disclosure || 'auto').toLowerCase();
    const now = typeof input.nowMs === 'number' ? input.nowMs : Date.now();
    const asOf = typeof input.asOf === 'number' ? input.asOf : null;
    const includeSuperseded = Boolean(input.includeSuperseded);
    const reinforce = input.reinforce !== false && asOf === null;
    const kindsFilter = Array.isArray(input.kinds) && input.kinds.length > 0 ? new Set(input.kinds) : null;

    // Fetch candidate memories valid at `asOf` (bi-temporal filtering!)
    let rows;
    if (asOf !== null) {
      rows = this.db
        .prepare(`
          SELECT * FROM memories
          WHERE namespace = ?
            AND valid_from <= ?
            AND (valid_until IS NULL OR valid_until > ?)
        `)
        .all(namespace, asOf, asOf);
    } else if (includeSuperseded) {
      rows = this.db
        .prepare(`SELECT * FROM memories WHERE namespace = ? AND status != 'archived'`)
        .all(namespace);
    } else {
      rows = this.db
        .prepare(`SELECT * FROM memories WHERE namespace = ? AND status = 'active'`)
        .all(namespace);
    }

    if (kindsFilter) {
      rows = rows.filter((r) => kindsFilter.has(r.kind));
    }

    const naiveTokens = rows.reduce((acc, r) => acc + r.tokens_l2, 0);

    if (rows.length === 0) {
      const latencyMs = Number((performance.now() - start).toFixed(2));
      return {
        query,
        namespace,
        as_of: asOf,
        disclosure,
        budget_tokens: budgetTokens,
        tokens_used: 0,
        naive_tokens: 0,
        tokens_saved: 0,
        savings_pct: 0,
        latency_ms: latencyMs,
        memories: [],
        context_block: ''
      };
    }

    const rowById = new Map(rows.map((r) => [r.id, r]));
    const evalTime = asOf ?? now;

    // Preload access timestamps for live ACT-R evaluation
    const accessMap = new Map();
    const allAccesses = this.db
      .prepare(`
        SELECT ae.memory_id, ae.accessed_at
        FROM access_events ae
        JOIN memories m ON m.id = ae.memory_id
        WHERE m.namespace = ? AND ae.accessed_at <= ?
        ORDER BY ae.accessed_at DESC
      `)
      .all(namespace, evalTime);

    for (const a of allAccesses) {
      let list = accessMap.get(a.memory_id);
      if (!list) {
        list = [];
        accessMap.set(a.memory_id, list);
      }
      if (list.length < 32) list.push(a.accessed_at);
    }

    // 1A. Sparse Lexical Retrieval: SQLite FTS5 BM25
    const ftsRanks = new Map();
    const ftsQuery = buildFtsQuery(query);
    if (ftsQuery) {
      try {
        const ftsHits = this.db
          .prepare(`
            SELECT memory_id, bm25(memories_fts, 4.0, 2.0, 1.0, 2.5) AS rank_score
            FROM memories_fts
            WHERE namespace = ? AND memories_fts MATCH ?
            ORDER BY rank_score ASC
            LIMIT 40
          `)
          .all(namespace, ftsQuery);
        let rank = 1;
        for (const h of ftsHits) {
          if (rowById.has(h.memory_id)) {
            ftsRanks.set(h.memory_id, rank++);
          }
        }
      } catch {
        // Fallback smoothly to vector + entity search if unusual query syntax
      }
    }

    // 1B. Dense Vector Similarity: 256-d Feature-Hashed Cosine
    const queryVec = embedText(query);
    const vecCache = new Map();
    const denseScored = [];
    for (const r of rows) {
      const vec = bufferToFloat32(r.vector_blob);
      vecCache.set(r.id, vec);
      const sim = query ? cosineSimilarity(queryVec, vec) : 0.5;
      denseScored.push({ id: r.id, sim });
    }
    denseScored.sort((a, b) => b.sim - a.sim);
    const denseRanks = new Map();
    const denseSimMap = new Map();
    denseScored.forEach((d, idx) => {
      denseSimMap.set(d.id, d.sim);
      if (d.sim >= 0.14 && idx < 25) denseRanks.set(d.id, idx + 1);
    });

    // 1C. Direct Entity Match Boost
    const queryTokens = new Set(tokenizeForIndexing(query));
    const entityBoostMap = new Map();
    if (queryTokens.size > 0) {
      const entityLinksForQuery = this.db
        .prepare(`
          SELECT me.memory_id, e.name, e.df_count, me.weight
          FROM memory_entities me
          JOIN entities e ON e.id = me.entity_id
          WHERE e.namespace = ?
        `)
        .all(namespace);
      for (const link of entityLinksForQuery) {
        if (!rowById.has(link.memory_id)) continue;
        if (queryTokens.has(link.name) || query.toLowerCase().includes(link.name)) {
          const idf = Math.log(1 + rows.length / (link.df_count + 0.5));
          entityBoostMap.set(
            link.memory_id,
            (entityBoostMap.get(link.memory_id) || 0) + link.weight * idf
          );
        }
      }
    }

    // 1D. Reciprocal Rank Fusion (Cormack et al., 2009)
    const rrfK = 24;
    const rrfScores = new Map();
    let maxRrf = 0;
    const entityRanked = [...entityBoostMap.entries()].sort((a, b) => b[1] - a[1]);
    const entityRankMap = new Map(entityRanked.map(([id], idx) => [id, idx + 1]));

    for (const r of rows) {
      let rrf = 0;
      const fr = ftsRanks.get(r.id);
      const dr = denseRanks.get(r.id);
      const er = entityRankMap.get(r.id);
      if (fr) rrf += 1.25 / (rrfK + fr);
      if (dr) rrf += 1.0 / (rrfK + dr);
      if (er) rrf += 1.15 / (rrfK + er);
      rrfScores.set(r.id, rrf);
      if (rrf > maxRrf) maxRrf = rrf;
    }

    // 2. HippoRAG Personalized PageRank (PPR) Multi-Hop Associative Spread
    // Sharpen seed personalization (s_i ~ rrf^3) and keep only high-confidence top seeds
    // so associative random-walk mass spreads cleanly from genuine query matches rather than noise.
    const seedScores = new Map();
    const topSeeds = [...rrfScores.entries()]
      .filter(([, s]) => maxRrf > 0 && s >= maxRrf * 0.55)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3);

    for (const [id, s] of topSeeds) {
      const ratio = s / maxRrf;
      seedScores.set(id, Math.pow(ratio, 3));
    }

    const validIds = rows.map((r) => r.id);
    const entityLinks = this.db
      .prepare(`
        SELECT me.memory_id, me.entity_id, me.weight, e.df_count
        FROM memory_entities me
        JOIN entities e ON e.id = me.entity_id
        WHERE e.namespace = ?
      `)
      .all(namespace);

    const memoryEdges = this.db
      .prepare(`SELECT source_id, target_id, relation, weight FROM memory_edges WHERE namespace = ?`)
      .all(namespace);

    const pprScores = runPersonalizedPageRank({
      memoryIds: validIds,
      entityLinks,
      memoryEdges,
      seedScores,
      totalMemories: rows.length,
      damping: 0.35,
      iterations: 18
    });

    // 3. Final Cognitive Scoring (Hybrid Relevance + PPR Associative + ACT-R Base-Level Activation)
    const candidates = [];
    for (const r of rows) {
      const rrfNorm = maxRrf > 0 ? (rrfScores.get(r.id) || 0) / maxRrf : 0;
      const pprNorm = pprScores.get(r.id) || 0;
      const cosSim = denseSimMap.get(r.id) || 0;

      const { activation } = computeBaseLevelActivation({
        accessTimestamps: accessMap.get(r.id) || [r.last_accessed_at],
        nowMs: evalTime,
        kind: r.kind,
        importance: r.importance,
        stability: r.stability
      });

      const relevance = query
        ? 0.44 * rrfNorm + 0.36 * pprNorm + 0.20 * cosSim
        : 0.5 * activation + 0.5 * r.importance;

      // Filter completely irrelevant noise when a specific query is given
      if (query && relevance < 0.06 && pprNorm < 0.14) continue;

      const cognitiveFactor = 0.62 + 0.38 * activation;
      const score = Number((relevance * cognitiveFactor).toFixed(4));
      const health = classifyHealth(activation, r.status);
      const viaMultiHop = rrfNorm < 0.18 && pprNorm >= 0.16;

      candidates.push({
        id: r.id,
        kind: r.kind,
        title: r.title,
        summary: r.summary,
        content: r.content,
        slot_key: r.slot_key,
        tags: safeJsonParse(r.tags_json, []),
        status: r.status,
        health,
        activation: Number(activation.toFixed(4)),
        importance: r.importance,
        stability: r.stability,
        access_count: r.access_count,
        tokens_l0: r.tokens_l0,
        tokens_l1: r.tokens_l1,
        tokens_l2: r.tokens_l2,
        valid_from: r.valid_from,
        valid_until: r.valid_until,
        vector: vecCache.get(r.id),
        score,
        signals: {
          rrf: Number(rrfNorm.toFixed(3)),
          ppr: Number(pprNorm.toFixed(3)),
          cosine: Number(cosSim.toFixed(3)),
          actr: Number(activation.toFixed(3)),
          multi_hop: viaMultiHop
        }
      });
    }

    candidates.sort((a, b) => b.score - a.score);

    // 4. Submodular Marginal-Gain Knapsack Packing under hard budgetTokens
    const packed = packSubmodularKnapsack({
      candidates,
      budgetTokens,
      disclosure
    });

    // 5. ACT-R Spaced-Repetition Reinforcement for returned memories
    if (reinforce && packed.selected.length > 0) {
      this.db.exec('BEGIN');
      try {
        for (const item of packed.selected) {
          this._reinforceMemory(item.id, now, 1.0);
        }
        this.db.exec('COMMIT');
      } catch {
        this.db.exec('ROLLBACK');
      }
    }

    const tokensUsed = packed.tokensUsed;
    const tokensSaved = Math.max(0, naiveTokens - tokensUsed);
    const savingsPct = naiveTokens > 0 ? Number(((tokensSaved / naiveTokens) * 100).toFixed(1)) : 0;
    const latencyMs = Number((performance.now() - start).toFixed(2));

    this._recordTelemetry(namespace, 'recall', query, tokensUsed, naiveTokens, tokensSaved, latencyMs, 0);

    const outputMemories = packed.selected.map(({ vector, ...rest }) => rest);
    const contextBlock = this._formatContextBlock(outputMemories, {
      tokensUsed,
      budgetTokens,
      naiveTokens,
      savingsPct
    });

    this.emit({
      type: 'memory_recalled',
      namespace,
      query,
      returned: outputMemories.length,
      tokensUsed,
      tokensSaved,
      latencyMs
    });

    return {
      query,
      namespace,
      as_of: asOf,
      disclosure,
      budget_tokens: budgetTokens,
      tokens_used: tokensUsed,
      naive_tokens: naiveTokens,
      tokens_saved: tokensSaved,
      savings_pct: savingsPct,
      latency_ms: latencyMs,
      total_candidates: candidates.length,
      memories: outputMemories,
      context_block: contextBlock
    };
  }

  _formatContextBlock(memories, stats) {
    if (memories.length === 0) {
      return '<!-- hippo-cache: no matching active memories -->';
    }
    const lines = [
      `# hippo-cache recall (${stats.tokensUsed}/${stats.budgetTokens} tok | saved ${stats.savingsPct}% vs ${stats.naiveTokens} naive tok)`
    ];
    for (const m of memories) {
      const hopTag = m.signals.multi_hop ? ' [PPR-HOP]' : '';
      const slotTag = m.slot_key ? ` {${m.slot_key}}` : '';
      lines.push(`- [${m.id} | ${m.kind} | ${m.disclosure_tier} | ${m.health.label}${slotTag}${hopTag}] ${m.emitted_text}`);
    }
    const expandable = memories.filter((m) => m.disclosure_tier !== 'L2').map((m) => m.id);
    if (expandable.length > 0) {
      lines.push(`> Call memory_expand([${expandable.slice(0, 4).map((x) => `"${x}"`).join(', ')}]) for full verbatim L2 payload.`);
    }
    return lines.join('\n');
  }

  /**
   * MIT RLM-style on-demand verbatim L2 hydration + neighborhood edges.
   */
  expand(ids, namespace = 'default', nowMs = Date.now()) {
    const idList = Array.isArray(ids) ? ids : [ids];
    const cleanIds = idList.map((x) => String(x || '').trim()).filter(Boolean);
    if (cleanIds.length === 0) return { memories: [], tokens_used: 0 };

    const memories = [];
    let tokensUsed = 0;

    for (const id of cleanIds) {
      const row = this.db
        .prepare(`SELECT * FROM memories WHERE id = ? AND (? = '*' OR namespace = ?)`)
        .get(id, namespace, namespace);
      if (!row) continue;

      if (row.status === 'active') {
        this._reinforceMemory(row.id, nowMs, 1.2);
      }

      const hydrated = this._hydrateRow(row, nowMs);
      const entities = this.db
        .prepare(`SELECT e.name, e.entity_type FROM memory_entities me JOIN entities e ON e.id = me.entity_id WHERE me.memory_id = ?`)
        .all(row.id);

      const edges = this.db
        .prepare(`
          SELECT me.source_id, me.target_id, me.relation, me.weight, me.reason,
                 m1.title as source_title, m2.title as target_title
          FROM memory_edges me
          JOIN memories m1 ON m1.id = me.source_id
          JOIN memories m2 ON m2.id = me.target_id
          WHERE me.source_id = ? OR me.target_id = ?
          ORDER BY me.weight DESC
          LIMIT 12
        `)
        .all(row.id, row.id);

      tokensUsed += row.tokens_l2;
      memories.push({
        ...hydrated,
        entities,
        edges
      });
    }

    return { memories, tokens_used: tokensUsed };
  }

  /**
   * Cognitive Sleep-Cycle Consolidation (Complementary Learning Systems):
   *  1. Refresh ACT-R activations
   *  2. Merge near-duplicate episodic traces
   *  3. Promote frequent episodic clusters into semantic/procedural synthesis
   *  4. Demote low-activation stale memories into cold archive (respecting pinned)
   */
  consolidate(namespace = 'default', options = {}) {
    const start = performance.now();
    const now = typeof options.nowMs === 'number' ? options.nowMs : Date.now();
    const archiveThreshold = Number(options.archiveThreshold ?? 0.22);
    const minClusterSize = Number(options.minClusterSize ?? 3);

    const rows = this.db
      .prepare(`SELECT * FROM memories WHERE namespace = ? AND status = 'active'`)
      .all(namespace);

    let refreshed = 0;
    let mergedDuplicates = 0;
    let promotedClusters = 0;
    let archivedStale = 0;
    const promotedIds = [];
    const archivedIds = [];

    this.db.exec('BEGIN');
    try {
      // 1. Recompute ACT-R activation for every active memory
      const liveActivations = new Map();
      for (const r of rows) {
        const accesses = this.db
          .prepare(`SELECT accessed_at FROM access_events WHERE memory_id = ? ORDER BY accessed_at DESC LIMIT 32`)
          .all(r.id)
          .map((a) => a.accessed_at);

        const { activation } = computeBaseLevelActivation({
          accessTimestamps: accesses.length > 0 ? accesses : [r.last_accessed_at],
          nowMs: now,
          kind: r.kind,
          importance: r.importance,
          stability: r.stability
        });
        liveActivations.set(r.id, activation);
        this.db.prepare(`UPDATE memories SET activation = ?, updated_at = ? WHERE id = ?`).run(activation, now, r.id);
        refreshed++;
      }

      // 2. Merge near-duplicate episodic memories (SimHash <= 5 and cosine >= 0.82)
      const episodic = rows.filter((r) => r.kind === 'episodic');
      const archivedSet = new Set();
      for (let i = 0; i < episodic.length; i++) {
        const a = episodic[i];
        if (archivedSet.has(a.id)) continue;
        const vecA = bufferToFloat32(a.vector_blob);
        for (let j = i + 1; j < episodic.length; j++) {
          const b = episodic[j];
          if (archivedSet.has(b.id)) continue;
          if (hammingDistance(a.simhash, b.simhash) <= 12) {
            const sim = cosineSimilarity(vecA, bufferToFloat32(b.vector_blob));
            if (sim >= 0.82) {
              // Keep the longer/newer one, archive the redundant duplicate.
              const keeper = a.content.length >= b.content.length ? a : b;
              const loser = keeper.id === a.id ? b : a;
              archivedSet.add(loser.id);
              this.db
                .prepare(`UPDATE memories SET status = 'archived', valid_until = ?, superseded_by = ?, updated_at = ? WHERE id = ?`)
                .run(now, keeper.id, now, loser.id);
              this.db
                .prepare(`INSERT OR IGNORE INTO memory_edges (namespace, source_id, target_id, relation, weight, reason, created_at) VALUES (?, ?, ?, 'DERIVED_FROM', 0.9, 'sleep_dedup_merge', ?)`)
                .run(namespace, keeper.id, loser.id, now);
              this._reinforceMemory(keeper.id, now, 1.0);
              mergedDuplicates++;
            }
          }
        }
      }

      // 3. Episodic -> Semantic/Procedural Cluster Promotion
      const entityClusters = this.db
        .prepare(`
          SELECT e.id AS entity_id, e.name AS entity_name, e.df_count,
                 GROUP_CONCAT(m.id) AS mem_ids, COUNT(m.id) AS cnt
          FROM entities e
          JOIN memory_entities me ON me.entity_id = e.id
          JOIN memories m ON m.id = me.memory_id
          WHERE e.namespace = ? AND m.status = 'active' AND m.kind = 'episodic' AND e.df_count <= 15
          GROUP BY e.id
          HAVING cnt >= ?
          ORDER BY cnt DESC
          LIMIT 5
        `)
        .all(namespace, minClusterSize);

      for (const cl of entityClusters) {
        const memberIds = cl.mem_ids.split(',').filter((id) => !archivedSet.has(id));
        if (memberIds.length < minClusterSize) continue;

        // Skip if a consolidated memory already derived from this cluster's primary entity
        const existingConsolidated = this.db
          .prepare(`SELECT id FROM memories WHERE namespace = ? AND source = 'consolidator' AND status = 'active' AND title LIKE ? LIMIT 1`)
          .get(namespace, `%${cl.entity_name}%`);
        if (existingConsolidated) continue;

        const memberRows = memberIds
          .map((id) => this.db.prepare(`SELECT * FROM memories WHERE id = ?`).get(id))
          .filter(Boolean);

        const combined = memberRows.map((m) => `- ${m.summary}`).join('\n');
        const isProcedural = /\b(fix|workaround|always|never|must|step|command|run|avoid|error)\b/i.test(combined);
        const promotedKind = isProcedural ? 'procedural' : 'semantic';
        const synthTitle = `Consolidated ${promotedKind} knowledge on "${cl.entity_name}" (${memberRows.length} episodes)`;
        const synthContent = `Distilled from ${memberRows.length} episodic traces involving ${cl.entity_name}:\n${combined}`;
        const synthId = generateId();
        const { summary } = compressMemory(synthContent, synthTitle, promotedKind);
        const vec = embedText(`${synthTitle} ${synthContent}`);

        const synthL2 = estimateTokens(synthContent) + 4;
        const synthL1 = Math.min(synthL2, estimateTokens(summary) + 4);
        const synthL0 = Math.min(synthL1, estimateTokens(synthTitle) + 4);

        this.db
          .prepare(`
            INSERT INTO memories (
              id, namespace, kind, title, summary, content, content_hash, simhash, slot_key,
              importance, stability, activation, access_count,
              tokens_l0, tokens_l1, tokens_l2, vector_blob,
              tags_json, metadata_json, source, status, superseded_by,
              valid_from, valid_until, created_at, updated_at, last_accessed_at
            ) VALUES (
              ?, ?, ?, ?, ?, ?, ?, ?, NULL,
              0.82, 2.0, 0.90, 1,
              ?, ?, ?, ?,
              ?, ?, 'consolidator', 'active', NULL,
              ?, NULL, ?, ?, ?
            )
          `)
          .run(
            synthId, namespace, promotedKind, synthTitle, summary, synthContent,
            sha256(synthContent), computeSimHash(synthContent),
            synthL0, synthL1, synthL2,
            float32ToBuffer(vec),
            JSON.stringify(['consolidated', cl.entity_name]),
            JSON.stringify({ derived_count: memberRows.length, cluster_entity: cl.entity_name }),
            now, now, now, now
          );

        this.db
          .prepare(`INSERT INTO memories_fts (memory_id, namespace, title, summary, content, tags) VALUES (?, ?, ?, ?, ?, ?)`)
          .run(synthId, namespace, synthTitle, summary, synthContent, `consolidated ${cl.entity_name}`);

        this.db
          .prepare(`INSERT INTO access_events (memory_id, accessed_at, boost) VALUES (?, ?, 1.2)`)
          .run(synthId, now);

        this.db
          .prepare(`INSERT OR IGNORE INTO memory_entities (memory_id, entity_id, weight) VALUES (?, ?, 1.5)`)
          .run(synthId, cl.entity_id);

        for (const m of memberRows) {
          this.db
            .prepare(`INSERT OR IGNORE INTO memory_edges (namespace, source_id, target_id, relation, weight, reason, created_at) VALUES (?, ?, ?, 'DERIVED_FROM', 0.95, 'sleep_cluster_promotion', ?)`)
            .run(namespace, synthId, m.id, now);
        }

        promotedClusters++;
        promotedIds.push(synthId);
      }

      // 4. Archive ultra-low activation stale memories (unless pinned)
      for (const r of rows) {
        if (archivedSet.has(r.id)) continue;
        const meta = safeJsonParse(r.metadata_json, {});
        if (meta.pinned) continue;
        const act = liveActivations.get(r.id) ?? r.activation;
        const ageHours = (now - r.last_accessed_at) / 3_600_000;
        if (act < archiveThreshold && ageHours >= 24) {
          this.db
            .prepare(`UPDATE memories SET status = 'archived', valid_until = ?, updated_at = ? WHERE id = ?`)
            .run(now, now, r.id);
          archivedStale++;
          archivedIds.push(r.id);
        }
      }

      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }

    const latencyMs = Number((performance.now() - start).toFixed(2));
    this._recordTelemetry(namespace, 'consolidate', 'sleep_cycle', 0, 0, 0, latencyMs, 0);
    this.emit({ type: 'sleep_completed', namespace, refreshed, mergedDuplicates, promotedClusters, archivedStale });

    return {
      namespace,
      refreshed,
      merged_duplicates: mergedDuplicates,
      promoted_clusters: promotedClusters,
      promoted_ids: promotedIds,
      archived_stale: archivedStale,
      archived_ids: archivedIds,
      latency_ms: latencyMs
    };
  }

  forget(id, reason = 'manual_forget', nowMs = Date.now()) {
    const row = this.db.prepare(`SELECT * FROM memories WHERE id = ?`).get(id);
    if (!row) return { ok: false, error: `Memory ${id} not found.` };
    const meta = safeJsonParse(row.metadata_json, {});
    meta.forget_reason = reason;
    this.db
      .prepare(`UPDATE memories SET status = 'archived', valid_until = ?, metadata_json = ?, updated_at = ? WHERE id = ?`)
      .run(nowMs, JSON.stringify(meta), nowMs, id);
    this.emit({ type: 'memory_archived', namespace: row.namespace, memoryId: id });
    return { ok: true, id, status: 'archived', reason };
  }

  listMemories(namespace = 'default', options = {}) {
    const status = options.status || 'all';
    const kind = options.kind || 'all';
    const limit = Math.min(200, Number(options.limit || 100));
    const now = typeof options.nowMs === 'number' ? options.nowMs : Date.now();

    let sql = `SELECT * FROM memories WHERE namespace = ?`;
    const params = [namespace];
    if (status !== 'all') {
      sql += ` AND status = ?`;
      params.push(status);
    }
    if (kind !== 'all') {
      sql += ` AND kind = ?`;
      params.push(kind);
    }
    sql += ` ORDER BY CASE status WHEN 'active' THEN 0 WHEN 'superseded' THEN 1 ELSE 2 END, activation DESC, updated_at DESC LIMIT ?`;
    params.push(limit);

    const rows = this.db.prepare(sql).all(...params);
    return rows.map((r) => this._hydrateRow(r, now));
  }

  getGraph(namespace = 'default', options = {}) {
    const limit = Math.min(120, Number(options.limit || 80));
    const now = typeof options.nowMs === 'number' ? options.nowMs : Date.now();

    const rows = this.db
      .prepare(`SELECT * FROM memories WHERE namespace = ? ORDER BY activation DESC, updated_at DESC LIMIT ?`)
      .all(namespace, limit);
    const idSet = new Set(rows.map((r) => r.id));

    const nodes = rows.map((r) => {
      const h = this._hydrateRow(r, now);
      return {
        id: h.id,
        kind: h.kind,
        title: h.title,
        summary: h.summary,
        slot_key: h.slot_key,
        status: h.status,
        activation: h.activation,
        importance: h.importance,
        stability: h.stability,
        access_count: h.access_count,
        tokens_l0: h.tokens_l0,
        tokens_l1: h.tokens_l1,
        tokens_l2: h.tokens_l2,
        health: h.health,
        tags: h.tags
      };
    });

    const edges = this.db
      .prepare(`SELECT source_id, target_id, relation, weight, reason FROM memory_edges WHERE namespace = ?`)
      .all(namespace)
      .filter((e) => idSet.has(e.source_id) && idSet.has(e.target_id));

    const entities = this.db
      .prepare(`
        SELECT e.id, e.name, e.entity_type, e.df_count, COUNT(me.memory_id) as linked_count
        FROM entities e
        JOIN memory_entities me ON me.entity_id = e.id
        WHERE e.namespace = ?
        GROUP BY e.id
        ORDER BY linked_count DESC, e.df_count DESC
        LIMIT 30
      `)
      .all(namespace);

    return { namespace, nodes, edges, entities };
  }

  getTimeline(namespace = 'default', limit = 40) {
    const contradictions = this.db
      .prepare(`
        SELECT c.*, m1.title AS older_title, m2.title AS newer_title
        FROM contradictions c
        JOIN memories m1 ON m1.id = c.older_memory_id
        JOIN memories m2 ON m2.id = c.newer_memory_id
        WHERE c.namespace = ?
        ORDER BY c.detected_at DESC
        LIMIT ?
      `)
      .all(namespace, limit);

    const recent = this.db
      .prepare(`
        SELECT id, kind, title, slot_key, status, valid_from, valid_until, created_at, superseded_by
        FROM memories
        WHERE namespace = ?
        ORDER BY created_at DESC
        LIMIT ?
      `)
      .all(namespace, limit);

    return { namespace, contradictions, recent };
  }

  getStats(namespace = 'default', nowMs = Date.now()) {
    const rows = this.db.prepare(`SELECT * FROM memories WHERE namespace = ?`).all(namespace);
    const counts = { total: rows.length, active: 0, superseded: 0, archived: 0 };
    const byKind = { working: 0, episodic: 0, semantic: 0, procedural: 0 };
    const healthDist = { green: 0, yellow: 0, red: 0 };
    let totalL0 = 0;
    let totalL1 = 0;
    let totalL2 = 0;
    let avgActivation = 0;

    for (const r of rows) {
      counts[r.status] = (counts[r.status] || 0) + 1;
      byKind[r.kind] = (byKind[r.kind] || 0) + 1;
      const h = this._hydrateRow(r, nowMs);
      healthDist[h.health.color] = (healthDist[h.health.color] || 0) + 1;
      if (r.status === 'active') {
        totalL0 += r.tokens_l0;
        totalL1 += r.tokens_l1;
        totalL2 += r.tokens_l2;
        avgActivation += h.activation;
      }
    }

    const activeCount = Math.max(1, counts.active);
    const edgeCount = this.db.prepare(`SELECT COUNT(*) AS c FROM memory_edges WHERE namespace = ?`).get(namespace).c;
    const entityCount = this.db.prepare(`SELECT COUNT(*) AS c FROM entities WHERE namespace = ?`).get(namespace).c;
    const contradictionCount = this.db.prepare(`SELECT COUNT(*) AS c FROM contradictions WHERE namespace = ?`).get(namespace).c;

    const tel = this.db
      .prepare(`
        SELECT
          COUNT(*) AS total_events,
          SUM(CASE WHEN event_type = 'recall' THEN 1 ELSE 0 END) AS recalls,
          COALESCE(SUM(CASE WHEN event_type = 'recall' THEN tokens_returned ELSE 0 END), 0) AS recall_tokens_emitted,
          COALESCE(SUM(CASE WHEN event_type = 'recall' THEN tokens_naive ELSE 0 END), 0) AS recall_tokens_naive,
          COALESCE(SUM(CASE WHEN event_type = 'recall' THEN tokens_saved ELSE 0 END), 0) AS recall_tokens_saved,
          COALESCE(AVG(CASE WHEN event_type = 'recall' THEN latency_ms END), 0) AS avg_recall_ms,
          COALESCE(SUM(secrets_redacted), 0) AS secrets_redacted
        FROM telemetry_events
        WHERE namespace = ?
      `)
      .get(namespace);

    const savingsPct =
      tel.recall_tokens_naive > 0
        ? Number(((tel.recall_tokens_saved / tel.recall_tokens_naive) * 100).toFixed(1))
        : totalL2 > 0
          ? Number((((totalL2 - totalL1) / totalL2) * 100).toFixed(1))
          : 0;

    // Sample reference ACT-R curves for UI telemetry
    const sampleCurves = {
      procedural: sampleDecayCurve({ accessTimestamps: [nowMs, nowMs + 86_400_000 * 3, nowMs + 86_400_000 * 10], kind: 'procedural', importance: 0.85, stability: 2.2, startMs: nowMs, horizonDays: 30, steps: 30 }),
      semantic: sampleDecayCurve({ accessTimestamps: [nowMs, nowMs + 86_400_000 * 5], kind: 'semantic', importance: 0.7, stability: 1.4, startMs: nowMs, horizonDays: 30, steps: 30 }),
      episodic: sampleDecayCurve({ accessTimestamps: [nowMs], kind: 'episodic', importance: 0.5, stability: 1.0, startMs: nowMs, horizonDays: 30, steps: 30 }),
      working: sampleDecayCurve({ accessTimestamps: [nowMs], kind: 'working', importance: 0.4, stability: 0.8, startMs: nowMs, horizonDays: 30, steps: 30 })
    };

    return {
      namespace,
      counts,
      by_kind: byKind,
      health: healthDist,
      tokens: {
        active_l0_total: totalL0,
        active_l1_total: totalL1,
        active_l2_total: totalL2,
        compression_l1_pct: totalL2 > 0 ? Number((((totalL2 - totalL1) / totalL2) * 100).toFixed(1)) : 0,
        compression_l0_pct: totalL2 > 0 ? Number((((totalL2 - totalL0) / totalL2) * 100).toFixed(1)) : 0
      },
      graph: {
        entities: entityCount,
        edges: edgeCount,
        contradictions: contradictionCount
      },
      telemetry: {
        recalls: tel.recalls || 0,
        tokens_emitted: tel.recall_tokens_emitted || 0,
        tokens_naive: tel.recall_tokens_naive || 0,
        tokens_saved: tel.recall_tokens_saved || 0,
        savings_pct: savingsPct,
        avg_recall_ms: Number((tel.avg_recall_ms || 0).toFixed(2)),
        secrets_redacted: tel.secrets_redacted || 0
      },
      avg_active_activation: Number((avgActivation / activeCount).toFixed(3)),
      decay_curves: sampleCurves
    };
  }

  _reinforceMemory(id, nowMs, boost = 1.0) {
    const row = this.db.prepare(`SELECT * FROM memories WHERE id = ?`).get(id);
    if (!row) return null;

    this.db.prepare(`INSERT INTO access_events (memory_id, accessed_at, boost) VALUES (?, ?, ?)`).run(id, nowMs, boost);
    const accesses = this.db
      .prepare(`SELECT accessed_at FROM access_events WHERE memory_id = ? ORDER BY accessed_at DESC LIMIT 32`)
      .all(id)
      .map((a) => a.accessed_at);

    const newStability = updateStabilityOnAccess(row.stability, row.last_accessed_at, nowMs);
    const { activation } = computeBaseLevelActivation({
      accessTimestamps: accesses,
      nowMs,
      kind: row.kind,
      importance: row.importance,
      stability: newStability
    });

    this.db
      .prepare(`
        UPDATE memories
        SET access_count = access_count + 1,
            stability = ?,
            activation = ?,
            last_accessed_at = ?,
            updated_at = ?
        WHERE id = ?
      `)
      .run(newStability, activation, nowMs, nowMs, id);

    return this.db.prepare(`SELECT * FROM memories WHERE id = ?`).get(id);
  }

  _hydrateRow(row, nowMs = Date.now()) {
    const accesses = this.db
      .prepare(`SELECT accessed_at FROM access_events WHERE memory_id = ? ORDER BY accessed_at DESC LIMIT 32`)
      .all(row.id)
      .map((a) => a.accessed_at);

    const { activation } = computeBaseLevelActivation({
      accessTimestamps: accesses.length > 0 ? accesses : [row.last_accessed_at],
      nowMs,
      kind: row.kind,
      importance: row.importance,
      stability: row.stability
    });

    return {
      id: row.id,
      namespace: row.namespace,
      kind: row.kind,
      title: row.title,
      summary: row.summary,
      content: row.content,
      slot_key: row.slot_key,
      importance: row.importance,
      stability: row.stability,
      activation: Number(activation.toFixed(4)),
      access_count: row.access_count,
      tokens_l0: row.tokens_l0,
      tokens_l1: row.tokens_l1,
      tokens_l2: row.tokens_l2,
      tags: safeJsonParse(row.tags_json, []),
      metadata: safeJsonParse(row.metadata_json, {}),
      source: row.source,
      status: row.status,
      superseded_by: row.superseded_by,
      health: classifyHealth(activation, row.status),
      valid_from: row.valid_from,
      valid_until: row.valid_until,
      created_at: row.created_at,
      updated_at: row.updated_at,
      last_accessed_at: row.last_accessed_at
    };
  }

  _recordTelemetry(namespace, eventType, query, tokensReturned, tokensNaive, tokensSaved, latencyMs, secretsRedacted) {
    this.db
      .prepare(`
        INSERT INTO telemetry_events (
          namespace, event_type, query, tokens_returned, tokens_naive, tokens_saved,
          latency_ms, secrets_redacted, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .run(namespace, eventType, query || '', tokensReturned, tokensNaive, tokensSaved, latencyMs, secretsRedacted, Date.now());
  }
}
