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
      validateKey: async () => true,
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
      validateKey: async () => true,
    } });
    const r = await analyzeForContact(d as never, tenant, "C1");
    expect(r.text).toContain("could not be read");
  });
  it("respects modality toggles", async () => {
    const t2 = { ...tenant, modalities: { audio: false, image: true } };
    const r = await analyzeForContact(deps() as never, t2 as Tenant, "C1");
    expect(r.text).toContain("audio processing is disabled");
  });
});
