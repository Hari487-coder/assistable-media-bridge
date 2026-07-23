import type { Db } from "../db";

export function createProcessedStore(db: Db) {
  return {
    has(tenantId: string, messageId: string): boolean {
      return !!db.prepare(
        "SELECT 1 FROM processed WHERE tenant_id = ? AND message_id = ?"
      ).get(tenantId, messageId);
    },
    add(tenantId: string, messageId: string): void {
      db.prepare(
        "INSERT OR IGNORE INTO processed (tenant_id, message_id, at) VALUES (?,?,?)"
      ).run(tenantId, messageId, Date.now());
    },
    prune(maxAgeMs: number): number {
      const result = db.prepare("DELETE FROM processed WHERE at < ?")
        .run(Date.now() - maxAgeMs);
      return typeof result.changes === 'bigint' ? Number(result.changes) : result.changes;
    },
  };
}
export type ProcessedStore = ReturnType<typeof createProcessedStore>;
