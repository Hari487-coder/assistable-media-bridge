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
  it("rejects a second row for the same GHL location at the DB level", () => {
    const { tenants, db } = mk();
    tenants.create(input);
    // The unique index is the backstop behind createOrUpdateByLocation: even a
    // direct insert must not produce two tenants for one location.
    expect(() => tenants.create({ ...input, label: "dupe" })).toThrow();
    expect((db.prepare("SELECT COUNT(*) AS n FROM tenants").get() as { n: number }).n).toBe(1);
  });
});

describe("tenant store — reconnect by location", () => {
  it("creates on first sight, then updates in place keeping id and token", () => {
    const { tenants, db } = mk();
    const first = tenants.createOrUpdateByLocation(input);
    expect(first.reconnected).toBe(false);

    tenants.setToolId(first.tenant.id, "tool_1");
    tenants.setWaker(first.tenant.id, false);

    const again = tenants.createOrUpdateByLocation({
      ...input, label: "Renamed", assistantId: "asst_2", aiKey: "gk2",
    });
    expect(again.reconnected).toBe(true);
    // Same identity — the live tool URL and the waker/dedupe history survive.
    expect(again.tenant.id).toBe(first.tenant.id);
    expect(again.tenant.token).toBe(first.tenant.token);
    expect(again.tenant.toolId).toBe("tool_1");
    expect(again.tenant.wakerEnabled).toBe(false);
    // ...but the configuration and secrets are the new ones.
    expect(again.tenant.label).toBe("Renamed");
    expect(again.tenant.assistantId).toBe("asst_2");
    expect(again.tenant.aiKey).toBe("gk2");
    expect((db.prepare("SELECT COUNT(*) AS n FROM tenants").get() as { n: number }).n).toBe(1);
  });
  it("drops the stored toolId when the reconnect moves the tenant to another subaccount", () => {
    const { tenants } = mk();
    const t = tenants.createOrUpdateByLocation({ ...input, subAccountId: "sub_a" }).tenant;
    tenants.setToolId(t.id, "tool_1");

    // Same subaccount → the tool is still reachable, keep it.
    expect(tenants.createOrUpdateByLocation({ ...input, subAccountId: "sub_a" }).tenant.toolId)
      .toBe("tool_1");
    // Moved → the old tool lives in a subaccount this key can no longer reach.
    expect(tenants.createOrUpdateByLocation({ ...input, subAccountId: "sub_b" }).tenant.toolId)
      .toBeNull();
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
