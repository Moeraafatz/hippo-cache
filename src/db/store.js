import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export const SCHEMA_VERSION = 1;

const SCHEMA_SQL = `
PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;
PRAGMA foreign_keys = ON;
PRAGMA temp_store = MEMORY;
PRAGMA cache_size = -16000;
PRAGMA busy_timeout = 5000;

CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS memories (
  id TEXT PRIMARY KEY,
  namespace TEXT NOT NULL DEFAULT 'default',
  kind TEXT NOT NULL CHECK (kind IN ('working', 'episodic', 'semantic', 'procedural')),
  title TEXT NOT NULL,
  summary TEXT NOT NULL,
  content TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  simhash TEXT NOT NULL,
  slot_key TEXT,
  importance REAL NOT NULL DEFAULT 0.6,
  stability REAL NOT NULL DEFAULT 1.0,
  activation REAL NOT NULL DEFAULT 0.85,
  access_count INTEGER NOT NULL DEFAULT 1,
  tokens_l0 INTEGER NOT NULL,
  tokens_l1 INTEGER NOT NULL,
  tokens_l2 INTEGER NOT NULL,
  vector_blob BLOB NOT NULL,
  tags_json TEXT NOT NULL DEFAULT '[]',
  metadata_json TEXT NOT NULL DEFAULT '{}',
  source TEXT NOT NULL DEFAULT 'agent',
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'superseded', 'archived')),
  superseded_by TEXT REFERENCES memories(id) ON DELETE SET NULL,
  valid_from INTEGER NOT NULL,
  valid_until INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  last_accessed_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_memories_ns_status ON memories(namespace, status);
CREATE INDEX IF NOT EXISTS idx_memories_ns_kind ON memories(namespace, kind);
CREATE INDEX IF NOT EXISTS idx_memories_hash ON memories(namespace, content_hash);
CREATE INDEX IF NOT EXISTS idx_memories_slot ON memories(namespace, slot_key, status);
CREATE INDEX IF NOT EXISTS idx_memories_valid ON memories(namespace, valid_from, valid_until);
CREATE INDEX IF NOT EXISTS idx_memories_activation ON memories(namespace, activation DESC);

CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(
  memory_id UNINDEXED,
  namespace UNINDEXED,
  title,
  summary,
  content,
  tags,
  tokenize = 'porter unicode61 tokenchars ''_./-'''
);

CREATE TABLE IF NOT EXISTS access_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  memory_id TEXT NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
  accessed_at INTEGER NOT NULL,
  boost REAL NOT NULL DEFAULT 1.0
);

CREATE INDEX IF NOT EXISTS idx_access_events_mem ON access_events(memory_id, accessed_at DESC);

CREATE TABLE IF NOT EXISTS entities (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  namespace TEXT NOT NULL,
  name TEXT NOT NULL,
  entity_type TEXT NOT NULL DEFAULT 'concept',
  df_count INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  UNIQUE(namespace, name)
);

CREATE INDEX IF NOT EXISTS idx_entities_ns_name ON entities(namespace, name);

CREATE TABLE IF NOT EXISTS memory_entities (
  memory_id TEXT NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
  entity_id INTEGER NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
  weight REAL NOT NULL DEFAULT 1.0,
  PRIMARY KEY (memory_id, entity_id)
);

CREATE INDEX IF NOT EXISTS idx_memory_entities_entity ON memory_entities(entity_id);

CREATE TABLE IF NOT EXISTS memory_edges (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  namespace TEXT NOT NULL,
  source_id TEXT NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
  target_id TEXT NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
  relation TEXT NOT NULL CHECK (relation IN ('RELATES_TO', 'SUPERSEDES', 'DERIVED_FROM', 'DEPENDS_ON', 'FIXES', 'CO_OCCURS')),
  weight REAL NOT NULL DEFAULT 0.5,
  reason TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  UNIQUE(source_id, target_id, relation)
);

CREATE INDEX IF NOT EXISTS idx_edges_ns_src ON memory_edges(namespace, source_id);
CREATE INDEX IF NOT EXISTS idx_edges_ns_dst ON memory_edges(namespace, target_id);

CREATE TABLE IF NOT EXISTS contradictions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  namespace TEXT NOT NULL,
  older_memory_id TEXT NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
  newer_memory_id TEXT NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
  slot_key TEXT,
  reason TEXT NOT NULL,
  confidence REAL NOT NULL DEFAULT 0.85,
  detected_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_contradictions_ns ON contradictions(namespace, detected_at DESC);

CREATE TABLE IF NOT EXISTS telemetry_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  namespace TEXT NOT NULL,
  event_type TEXT NOT NULL,
  query TEXT DEFAULT '',
  tokens_returned INTEGER NOT NULL DEFAULT 0,
  tokens_naive INTEGER NOT NULL DEFAULT 0,
  tokens_saved INTEGER NOT NULL DEFAULT 0,
  latency_ms REAL NOT NULL DEFAULT 0,
  secrets_redacted INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_telemetry_ns ON telemetry_events(namespace, created_at DESC);
`;

export function openStore(dbPath) {
  if (dbPath !== ':memory:') {
    const dir = path.dirname(path.resolve(dbPath));
    fs.mkdirSync(dir, { recursive: true });
  }
  const db = new DatabaseSync(dbPath);
  db.exec(SCHEMA_SQL);
  db.prepare(`INSERT OR IGNORE INTO meta (key, value) VALUES ('schema_version', ?)`).run(
    String(SCHEMA_VERSION)
  );
  return db;
}

export function float32ToBuffer(vec) {
  return Buffer.from(vec.buffer, vec.byteOffset, vec.byteLength);
}

export function bufferToFloat32(buf) {
  if (!buf) return new Float32Array(0);
  const copy = Buffer.from(buf);
  return new Float32Array(copy.buffer, copy.byteOffset, copy.byteLength / 4);
}
