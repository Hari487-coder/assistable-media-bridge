import { describe, expect, it } from "vitest";
import { openDb } from "../src/db";
import { createTenantStore } from "../src/store/tenants";
import { createProcessedStore } from "../src/store/processed";
import { createEventStore } from "../src/store/events";

const key = Buffer.alloc(32, 9);
const mk = () => {
  const db = openDb(":memory:");
  return {
    tenants: createTenantStore(db, key),
    processed: createProcessedStore(db),
    events: createEventStore(db),
    db,
  };
};

const input = {
  label: "Volunteer 1", locationId: "loc_1", assistantId: "asst_1",
  provider: "gemini" as const, v3Key: "v3k", ghlPit: "pit", aiKey: "gk",
};

describe("tenant store", () => {
  it("creates and reads back with decrypted secrets", () => {
    const { tenants, db } = mk();
    const t = tenants.create(input);
    expect(t.token).toMatch(/^[a-f0-9]{48}$/);
    expect(tenants.getByToken(t.token)?.aiKey).toBe("gk");
    expect(tenants.getByLocationId("loc_1")?.v3Key).toBe("v3k");
    // Secrets are NOT plaintext at rest
    const raw = db.prepare("SELECT v3_key_enc FROM tenants").get() as { v3_key_enc: string };
    expect(raw.v3_key_enc).not.toContain("v3k");
  });
  it("toggles enabled", () => {
    const { tenants } = mk();
    const t = tenants.create(input);
    tenants.setEnabled(t.id, false);
    expect(tenants.getByToken(t.token)?.enabled).toBe(false);
  });
});

describe("processed store", () => {
  it("dedupes and prunes", () => {
    const { processed } = mk();
    expect(processed.has("t1", "m1")).toBe(false);
    processed.add("t1", "m1");
    expect(processed.has("t1", "m1")).toBe(true);
    expect(processed.has("t2", "m1")).toBe(false);
    expect(processed.prune(-1)).toBe(1); // everything is older than "now - (-1ms)"
    expect(processed.has("t1", "m1")).toBe(false);
  });
});

describe("event store", () => {
  it("records and lists newest first", () => {
    const { events } = mk();
    events.record("t1", "poll", "ok");
    events.record("t1", "detect", "msg m9");
    const rows = events.latest("t1", 10);
    expect(rows[0].kind).toBe("detect");
    expect(rows).toHaveLength(2);
  });
});
