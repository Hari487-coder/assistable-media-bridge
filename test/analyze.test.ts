import { describe, expect, it } from "vitest";
import { openDb } from "../src/db";
import { createProcessedStore } from "../src/store/processed";
import { createEventStore } from "../src/store/events";
import { analyzeForContact } from "../src/core/analyze";
import type { Tenant } from "../src/store/tenants";

const tenant = {
  id: "t1", token: "tok", label: "T", locationId: "L", assistantId: "A",
  provider: "gemini", v3Key: "v", ghlPit: "p", aiKey: "k",
  wakerEnabled: true, toolId: null, enabled: true,
  modalities: { audio: true, image: true },
} as Tenant;

const oggBytes = new TextEncoder().encode("OggS....voicedata");

function deps(overrides: Partial<Record<string, unknown>> = {}) {
  const db = openDb(":memory:");
  return {
    ghl: {
      latestMediaMessages: async () => [
        { id: "g2", attachments: ["https://storage.msgsndr.com/a.ogg"], direction: "inbound", dateAdded: "t2" },
      ],
      validatePit: async () => true,
    },
    processed: createProcessedStore(db),
    events: createEventStore(db),
    provider: {
      describe: async () => "hello from the voice note",
      validateKey: async () => ({ ok: true as const }),
    },
    fetchImpl: (async () => new Response(oggBytes)) as unknown as typeof fetch,
    ...overrides,
  };
}

describe("analyzeForContact", () => {
  it("downloads, sniffs, describes, labels, and marks processed", async () => {
    const d = deps();
    const r = await analyzeForContact(d as never, tenant, "C1");
    expect(r.text).toContain("Voice note transcript");
    expect(r.text).toContain("hello from the voice note");
    expect(r.processedIds).toEqual(["g2"]);
    expect(d.processed.has("t1", "g2")).toBe(true);
  });
  it("skips already-processed messages", async () => {
    const d = deps();
    d.processed.add("t1", "g2");
    const r = await analyzeForContact(d as never, tenant, "C1");
    expect(r.text).toContain("no new attachments");
  });
  it("degrades per-attachment on provider failure without throwing", async () => {
    const d = deps({ provider: {
      describe: async () => { throw new Error("rate limited"); },
      validateKey: async () => ({ ok: true as const }),
    } });
    const r = await analyzeForContact(d as never, tenant, "C1");
    expect(r.text).toContain("could not be read");
  });
  it("respects modality toggles", async () => {
    const t2 = { ...tenant, modalities: { audio: false, image: true } };
    const r = await analyzeForContact(deps() as never, t2 as Tenant, "C1");
    expect(r.text).toContain("audio processing is disabled");
  });
  it("caps at 3 attempts across messages with exactly one honest skip note", async () => {
    const d = deps({ ghl: {
      latestMediaMessages: async () => [
        { id: "gA", attachments: ["https://storage.msgsndr.com/1.ogg", "https://storage.msgsndr.com/2.ogg", "https://storage.msgsndr.com/3.ogg", "https://storage.msgsndr.com/4.ogg"], direction: "inbound", dateAdded: "t2" },
        { id: "gB", attachments: ["https://storage.msgsndr.com/5.ogg", "https://storage.msgsndr.com/6.ogg"], direction: "inbound", dateAdded: "t1" },
      ],
      validatePit: async () => true,
    } });
    const r = await analyzeForContact(d as never, tenant, "C1");
    const noteMatches = r.text.match(/additional attachment\(s\) were not processed/g) ?? [];
    expect(noteMatches).toHaveLength(1);
    expect(r.text).toContain("[3 additional attachment(s) were not processed]");
    expect((r.text.match(/Voice note transcript/g) ?? [])).toHaveLength(3);
    expect(r.processedIds).toEqual(["gA", "gB"]);
    expect(d.processed.has("t1", "gB")).toBe(true);
  });
  it("message with zero attachments yields no-new-attachments and marks nothing", async () => {
    const d = deps({ ghl: {
      latestMediaMessages: async () => [
        { id: "gEmpty", attachments: [], direction: "inbound", dateAdded: "t1" },
      ],
      validatePit: async () => true,
    } });
    const r = await analyzeForContact(d as never, tenant, "C1");
    expect(r.text).toContain("no new attachments");
    expect(r.processedIds).toEqual([]);
    expect(d.processed.has("t1", "gEmpty")).toBe(false);
  });
});
