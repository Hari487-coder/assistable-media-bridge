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
      sub_account_id TEXT, analysis_instruction TEXT,
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
    "ALTER TABLE tenants ADD COLUMN analysis_instruction TEXT",
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
