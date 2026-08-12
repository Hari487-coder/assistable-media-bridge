import { randomUUID } from "node:crypto";
import { type AssetKind, normalizeAssetName } from "../core/asset-url";
import type { Db } from "../db";

/** Every asset's name and description ride in the tool description on every
 *  agent run, so the library is capped: an unbounded library is unbounded
 *  prompt on every conversation, and a model choosing from 200 options chooses
 *  worse than one choosing from 20. */
export const MAX_ASSETS = 20;

export interface AssetInput {
  name: string; description: string; kind: AssetKind; url: string;
}
export interface Asset extends AssetInput {
  id: string; tenantId: string; createdAt: number;
}

type Row = {
  id: string; tenant_id: string; name: string; description: string;
  kind: string; url: string; created_at: number;
};

const toAsset = (r: Row): Asset => ({
  id: r.id, tenantId: r.tenant_id, name: r.name, description: r.description,
  kind: r.kind as AssetKind, url: r.url, createdAt: r.created_at,
});

export function createAssetStore(db: Db) {
  const get = (tenantId: string, name: string): Asset | null => {
    const r = db.prepare(
      "SELECT * FROM assets WHERE tenant_id = ? AND name = ?"
    ).get(tenantId, normalizeAssetName(name)) as Row | undefined;
    return r ? toAsset(r) : null;
  };
  const count = (tenantId: string): number => {
    const r = db.prepare(
      "SELECT COUNT(*) AS n FROM assets WHERE tenant_id = ?"
    ).get(tenantId) as { n: number };
    return Number(r.n);
  };
  return {
    get,
    count,
    /** Insertion order, oldest first — the order a tenant built the library is
     *  the order they expect to see it, and the model reads the same list. */
    list(tenantId: string): Asset[] {
      return (db.prepare(
        "SELECT * FROM assets WHERE tenant_id = ? ORDER BY created_at ASC, rowid ASC"
      ).all(tenantId) as Row[]).map(toAsset);
    },
    /** Add or update in place. Re-adding a name edits that asset rather than
     *  creating a near-duplicate the model would then have to choose between. */
    add(tenantId: string, input: AssetInput): Asset {
      const name = normalizeAssetName(input.name);
      if (!name) throw new Error("give the asset a name using letters or numbers");
      const existing = get(tenantId, name);
      if (!existing && count(tenantId) >= MAX_ASSETS) {
        throw new Error(
          `this account already has the maximum of ${MAX_ASSETS} assets — remove one before adding another`
        );
      }
      db.prepare(
        `INSERT INTO assets (id, tenant_id, name, description, kind, url, created_at)
         VALUES (?,?,?,?,?,?,?)
         ON CONFLICT(tenant_id, name) DO UPDATE SET
           description = excluded.description, kind = excluded.kind, url = excluded.url`
      ).run(
        existing?.id ?? randomUUID(), tenantId, name, input.description,
        input.kind, input.url, existing?.createdAt ?? Date.now()
      );
      return get(tenantId, name) as Asset;
    },
    remove(tenantId: string, name: string): boolean {
      const r = db.prepare(
        "DELETE FROM assets WHERE tenant_id = ? AND name = ?"
      ).run(tenantId, normalizeAssetName(name));
      return (typeof r.changes === "bigint" ? Number(r.changes) : r.changes) > 0;
    },
  };
}
export type AssetStore = ReturnType<typeof createAssetStore>;
