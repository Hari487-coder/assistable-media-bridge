import { DatabaseSync } from "node:sqlite";

export type Db = DatabaseSync;

export function openDb(path: string): Db {
  const db = new DatabaseSync(path);
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec(`
    CREATE TABLE IF NOT EXISTS tenants (
      id TEXT PRIMARY KEY, token TEXT UNIQUE NOT NULL, label TEXT NOT NULL,
      location_id TEXT NOT NULL, assistant_id TEXT NOT NULL,
      provider TEXT NOT NULL, v3_key_enc TEXT NOT NULL,
      ghl_pit_enc TEXT NOT NULL, ai_key_enc TEXT NOT NULL,
      waker_enabled INTEGER NOT NULL DEFAULT 1,
      tool_id TEXT, enabled INTEGER NOT NULL DEFAULT 1,
      audio_on INTEGER NOT NULL DEFAULT 1, image_on INTEGER NOT NULL DEFAULT 1,
      sub_account_id TEXT,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS processed (
      tenant_id TEXT NOT NULL, message_id TEXT NOT NULL, at INTEGER NOT NULL,
      PRIMARY KEY (tenant_id, message_id)
    );
    CREATE TABLE IF NOT EXISTS events (
      id INTEGER PRIMARY KEY AUTOINCREMENT, tenant_id TEXT NOT NULL,
      kind TEXT NOT NULL, detail TEXT NOT NULL, at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_events_tenant ON events(tenant_id, id DESC);
  `);
  // Idempotent migrations for instances created before a column existed.
  // node:sqlite has no "ADD COLUMN IF NOT EXISTS", so we probe and ignore the
  // duplicate-column error on an already-migrated DB.
  for (const stmt of [
    "ALTER TABLE tenants ADD COLUMN sub_account_id TEXT",
  ]) {
    try { db.exec(stmt); } catch { /* column already present */ }
  }
  return db;
}
