import type { Db } from "../db";

export interface EventRow { kind: string; detail: string; at: number }

export function createEventStore(db: Db) {
  return {
    record(tenantId: string, kind: string, detail: string): void {
      db.prepare("INSERT INTO events (tenant_id, kind, detail, at) VALUES (?,?,?,?)")
        .run(tenantId, kind, detail, Date.now());
    },
    latest(tenantId: string, limit: number): EventRow[] {
      return db.prepare(
        "SELECT kind, detail, at FROM events WHERE tenant_id = ? ORDER BY id DESC LIMIT ?"
      ).all(tenantId, limit) as unknown as EventRow[];
    },
  };
}
export type EventStore = ReturnType<typeof createEventStore>;
