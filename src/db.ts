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
      -- RETIRED. Briefly gated an "assistant replies to emoji reactions"
      -- feature that was removed; reactions are now always ignored. Kept, and
      -- kept in the migration list below, so fresh and upgraded instances stay
      -- schema-identical — dropping a column on a live SQLite file is a worse
      -- trade than carrying an unread one. Nothing reads it.
      reactions_on INTEGER DEFAULT 1,
      sub_account_id TEXT, analysis_instruction TEXT, send_tool_id TEXT,
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
    CREATE TABLE IF NOT EXISTS assets (
      id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, name TEXT NOT NULL,
      description TEXT NOT NULL, kind TEXT NOT NULL, url TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      UNIQUE (tenant_id, name)
    );
    -- Keyed on CONTACT, not conversation: a contact owns several threads and
    -- which one search ranks first flips between calls, so a conversation key
    -- would let the same asset go out twice to one person. asset_name rather
    -- than an id so deleting and re-adding an asset does not reset its
    -- already-sent history and re-spam the contact.
    CREATE TABLE IF NOT EXISTS media_sends (
      id INTEGER PRIMARY KEY AUTOINCREMENT, tenant_id TEXT NOT NULL,
      contact_id TEXT NOT NULL, asset_name TEXT NOT NULL, channel TEXT NOT NULL,
      at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_media_sends
      ON media_sends(tenant_id, contact_id, at DESC);
  `);
  // Idempotent migrations for instances created before a column existed.
  // node:sqlite has no "ADD COLUMN IF NOT EXISTS", so we probe and ignore the
  // duplicate-column error on an already-migrated DB.
  for (const stmt of [
    "ALTER TABLE tenants ADD COLUMN sub_account_id TEXT",
    "ALTER TABLE tenants ADD COLUMN analysis_instruction TEXT",
    // Retired — see the note on the column above. Kept so an instance that
    // already took it and a fresh install stay schema-identical.
    "ALTER TABLE tenants ADD COLUMN reactions_on INTEGER",
    "ALTER TABLE tenants ADD COLUMN send_tool_id TEXT",
  ]) {
    try { db.exec(stmt); } catch { /* column already present */ }
  }

  // One tenant per GHL location. Without it a double-submitted onboarding form
  // leaves two rows for the same location, each with its OWN waker cursor and
  // its own processed-message set: every conversation is woken twice and every
  // attachment is downloaded and billed to the AI provider twice, silently.
  // Added as an index rather than a table constraint so existing deployments
  // pick it up on restart.
  try {
    db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_tenants_location ON tenants(location_id)");
  } catch {
    // An instance that ALREADY holds duplicates cannot take the index. Merging
    // them automatically would destroy a token that is baked into a live tool
    // URL, so name them instead and let a human pick the survivor.
    let detail = "(could not list them)";
    try {
      const dupes = db.prepare(
        "SELECT location_id, COUNT(*) AS n FROM tenants GROUP BY location_id HAVING n > 1"
      ).all() as Array<{ location_id: string; n: number }>;
      detail = dupes.map((d) => `${d.location_id} (x${d.n})`).join(", ");
    } catch { /* keep the placeholder — the warning still needs to fire */ }
    console.warn(
      "[media-mcp] duplicate tenants share a GHL location; each one wakes and bills " +
      `independently. Delete the stale row(s) for: ${detail}`
    );
  }
  return db;
}
