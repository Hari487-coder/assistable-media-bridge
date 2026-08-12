import type { Db } from "../db";

/**
 * Record of media that actually reached a contact.
 *
 * Only successful sends are written here. A blocked or failed attempt must
 * never consume a contact's budget — otherwise a run of GHL errors would
 * quietly exhaust the daily allowance for a contact who received nothing.
 */
export function createSendLog(db: Db) {
  return {
    record(tenantId: string, contactId: string, assetName: string, channel: string, at = Date.now()): void {
      db.prepare(
        "INSERT INTO media_sends (tenant_id, contact_id, asset_name, channel, at) VALUES (?,?,?,?,?)"
      ).run(tenantId, contactId, assetName, channel, at);
    },
    hasSent(tenantId: string, contactId: string, assetName: string): boolean {
      return !!db.prepare(
        "SELECT 1 FROM media_sends WHERE tenant_id = ? AND contact_id = ? AND asset_name = ?"
      ).get(tenantId, contactId, assetName);
    },
    countSince(tenantId: string, contactId: string, since: number): number {
      const r = db.prepare(
        "SELECT COUNT(*) AS n FROM media_sends WHERE tenant_id = ? AND contact_id = ? AND at >= ?"
      ).get(tenantId, contactId, since) as { n: number };
      return Number(r.n);
    },
    lastSentAt(tenantId: string, contactId: string): number | null {
      const r = db.prepare(
        "SELECT MAX(at) AS at FROM media_sends WHERE tenant_id = ? AND contact_id = ?"
      ).get(tenantId, contactId) as { at: number | null };
      return r.at ?? null;
    },
  };
}
export type SendLog = ReturnType<typeof createSendLog>;
