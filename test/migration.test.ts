import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { encryptSecret } from "../src/crypto";
import { openDb } from "../src/db";
import { createTenantStore } from "../src/store/tenants";

// The columns this service has grown since its first deploy. A live instance
// upgrades in place, so the ALTERs in openDb are what actually runs on restart
// — not the CREATE TABLE. Exercise that path against a real on-disk database.
const KEY = Buffer.alloc(32, 4);
const enc = (v: string) => encryptSecret(v, KEY);

let dir: string;
let path: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "mediamcp-")); path = join(dir, "old.sqlite"); });
afterEach(() => {
  // Windows will not unlink a file with an open handle; every test closes its
  // own db, and this stays tolerant so a failure reports the assertion, not EPERM.
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
});

const OLD_SCHEMA = `
  CREATE TABLE tenants (
    id TEXT PRIMARY KEY, token TEXT UNIQUE NOT NULL, label TEXT NOT NULL,
    location_id TEXT NOT NULL, assistant_id TEXT NOT NULL,
    provider TEXT NOT NULL, v3_key_enc TEXT NOT NULL,
    ghl_pit_enc TEXT NOT NULL, ai_key_enc TEXT NOT NULL,
    waker_enabled INTEGER NOT NULL DEFAULT 1,
    tool_id TEXT, enabled INTEGER NOT NULL DEFAULT 1,
    audio_on INTEGER NOT NULL DEFAULT 1, image_on INTEGER NOT NULL DEFAULT 1,
    created_at INTEGER NOT NULL
  );`;

describe("in-place upgrade of a pre-existing instance", () => {
  it("adds the new columns and leaves the existing tenant working", () => {
    const old = new DatabaseSync(path);
    old.exec(OLD_SCHEMA);
    old.prepare(`INSERT INTO tenants
      (id, token, label, location_id, assistant_id, provider,
       v3_key_enc, ghl_pit_enc, ai_key_enc, created_at)
      VALUES ('id1','tok1','Live Tenant','loc_1','asst_1','gemini',?,?,?,1)`)
      .run(enc("v3key"), enc("pit"), enc("aikey"));
    old.close();

    const db = openDb(path); // the restart
    const row = db.prepare("SELECT * FROM tenants WHERE id = 'id1'").get() as Record<string, unknown>;
    expect(row.sub_account_id).toBeNull();
    expect(row.analysis_instruction).toBeNull();
    expect(row.reactions_on).toBeNull(); // ALTER cannot backfill a DEFAULT

    // ...and the store must still read that row as a fully working tenant with
    // reactions ON, matching a fresh install rather than silently off.
    const store = createTenantStore(db, KEY);
    const t = store.getByToken("tok1");
    expect(t?.label).toBe("Live Tenant");
    expect(t?.modalities).toEqual({ audio: true, image: true });
    expect(t?.analysisInstruction).toBeNull();
    expect(t?.v3Key).toBe("v3key"); // secrets still decrypt after the migration

    // The location index is what stops duplicate onboarding; it must exist now.
    const idx = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='index' AND name='idx_tenants_location'"
    ).all();
    expect(idx).toHaveLength(1);
    db.close();
  });

  it("is idempotent — a second restart changes nothing and does not throw", () => {
    const old = new DatabaseSync(path);
    old.exec(OLD_SCHEMA);
    old.close();
    openDb(path).close();
    expect(() => openDb(path).close()).not.toThrow();
  });

  it("survives an instance that already holds duplicate locations", () => {
    // The index cannot apply; boot must continue rather than crash-loop.
    const old = new DatabaseSync(path);
    old.exec(OLD_SCHEMA);
    for (const [id, tok] of [["a", "t1"], ["b", "t2"]]) {
      old.prepare(`INSERT INTO tenants
        (id, token, label, location_id, assistant_id, provider,
         v3_key_enc, ghl_pit_enc, ai_key_enc, created_at)
        VALUES (?,?,'Dup','loc_same','asst_1','gemini',?,?,?,1)`)
        .run(id, tok, enc("v3key"), enc("pit"), enc("aikey"));
    }
    old.close();

    const db = openDb(path);
    expect(db.prepare("SELECT COUNT(*) n FROM tenants").get()).toEqual({ n: 2 });
    const idx = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='index' AND name='idx_tenants_location'"
    ).all();
    expect(idx).toHaveLength(0); // warned about, not silently merged
    db.close();
  });
});
