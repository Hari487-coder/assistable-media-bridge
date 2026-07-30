import { randomBytes, randomUUID } from "node:crypto";
import type { Db } from "../db";
import { decryptSecret, encryptSecret } from "../crypto";

export interface TenantInput {
  label: string; locationId: string; assistantId: string;
  provider: "gemini" | "openai"; v3Key: string; ghlPit: string; aiKey: string;
  /** Optional — only for workspace-wide v3 keys spanning multiple subaccounts. */
  subAccountId?: string;
}
export interface Tenant extends TenantInput {
  id: string; token: string; wakerEnabled: boolean; toolId: string | null;
  enabled: boolean; modalities: { audio: boolean; image: boolean };
}

type Row = {
  id: string; token: string; label: string; location_id: string;
  assistant_id: string; provider: string; v3_key_enc: string;
  ghl_pit_enc: string; ai_key_enc: string; waker_enabled: number;
  tool_id: string | null; enabled: number; audio_on: number; image_on: number;
  sub_account_id: string | null;
};

export function createTenantStore(db: Db, key: Buffer) {
  const toTenant = (r: Row): Tenant => ({
    id: r.id, token: r.token, label: r.label, locationId: r.location_id,
    assistantId: r.assistant_id, provider: r.provider as Tenant["provider"],
    v3Key: decryptSecret(r.v3_key_enc, key),
    ghlPit: decryptSecret(r.ghl_pit_enc, key),
    aiKey: decryptSecret(r.ai_key_enc, key),
    wakerEnabled: r.waker_enabled === 1, toolId: r.tool_id,
    enabled: r.enabled === 1,
    modalities: { audio: r.audio_on === 1, image: r.image_on === 1 },
    ...(r.sub_account_id ? { subAccountId: r.sub_account_id } : {}),
  });
  const get = (sql: string, ...args: (string | number | null)[]): Tenant | null => {
    const r = db.prepare(sql).get(...args) as Row | undefined;
    return r ? toTenant(r) : null;
  };
  const create = (input: TenantInput): Tenant => {
    const id = randomUUID();
    const token = randomBytes(24).toString("hex");
    db.prepare(`INSERT INTO tenants
      (id, token, label, location_id, assistant_id, provider,
       v3_key_enc, ghl_pit_enc, ai_key_enc, sub_account_id, created_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?)`)
      .run(id, token, input.label, input.locationId, input.assistantId,
        input.provider, encryptSecret(input.v3Key, key),
        encryptSecret(input.ghlPit, key), encryptSecret(input.aiKey, key),
        input.subAccountId ?? null, Date.now());
    const t = get("SELECT * FROM tenants WHERE id = ?", id);
    if (!t) throw new Error("tenant insert failed");
    return t;
  };

  // Rewrite an existing tenant's configuration in place. Deliberately keeps id,
  // token, kill switches and created_at: the token is baked into a LIVE
  // analyze_attachment tool URL in the customer's subaccount, and the id keys
  // the waker cursor, the processed-message dedupe and the event history. Minting
  // a new row instead would orphan the tool and re-wake everything already read.
  const update = (id: string, input: TenantInput): Tenant => {
    const prev = get("SELECT * FROM tenants WHERE id = ?", id);
    if (!prev) throw new Error("tenant not found");
    const subAccountId = input.subAccountId ?? null;
    // A tool lives inside ONE subaccount. If a reconnect moves the tenant, the
    // stored toolId points somewhere this key can no longer reach — drop it so
    // the waker stops trying to assign a foreign tool and ensureTool re-creates
    // it in the new subaccount.
    const movedSubAccount = subAccountId !== (prev.subAccountId ?? null);
    db.prepare(`UPDATE tenants SET
        label = ?, location_id = ?, assistant_id = ?, provider = ?,
        v3_key_enc = ?, ghl_pit_enc = ?, ai_key_enc = ?, sub_account_id = ?
        ${movedSubAccount ? ", tool_id = NULL" : ""}
      WHERE id = ?`)
      .run(input.label, input.locationId, input.assistantId, input.provider,
        encryptSecret(input.v3Key, key), encryptSecret(input.ghlPit, key),
        encryptSecret(input.aiKey, key), subAccountId, id);
    const t = get("SELECT * FROM tenants WHERE id = ?", id);
    if (!t) throw new Error("tenant update failed");
    return t;
  };

  return {
    create,
    update,
    /**
     * Onboarding is idempotent per GHL location: re-submitting the form for a
     * location that is already connected updates it instead of adding a second
     * row. Lookup and write are one SYNCHRONOUS step — node:sqlite is sync and
     * Node is single-threaded, so two concurrent submissions cannot interleave
     * between the read and the write and both insert.
     */
    createOrUpdateByLocation(input: TenantInput): { tenant: Tenant; reconnected: boolean } {
      const existing = get("SELECT * FROM tenants WHERE location_id = ?", input.locationId);
      return existing
        ? { tenant: update(existing.id, input), reconnected: true }
        : { tenant: create(input), reconnected: false };
    },
    getByToken: (token: string) => get("SELECT * FROM tenants WHERE token = ?", token),
    getByLocationId: (loc: string) => get("SELECT * FROM tenants WHERE location_id = ?", loc),
    list(): Tenant[] {
      return (db.prepare("SELECT * FROM tenants").all() as Row[]).map(toTenant);
    },
    setEnabled(id: string, on: boolean) {
      db.prepare("UPDATE tenants SET enabled = ? WHERE id = ?").run(on ? 1 : 0, id);
    },
    setToolId(id: string, toolId: string) {
      db.prepare("UPDATE tenants SET tool_id = ? WHERE id = ?").run(toolId, id);
    },
    setWaker(id: string, on: boolean) {
      db.prepare("UPDATE tenants SET waker_enabled = ? WHERE id = ?").run(on ? 1 : 0, id);
    },
    setModality(id: string, which: "audio" | "image", on: boolean) {
      const col = which === "audio" ? "audio_on" : "image_on";
      db.prepare(`UPDATE tenants SET ${col} = ? WHERE id = ?`).run(on ? 1 : 0, id);
    },
  };
}
export type TenantStore = ReturnType<typeof createTenantStore>;
