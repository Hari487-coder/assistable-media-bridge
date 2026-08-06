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
  modalities: { audio: true, image: true, reactions: true }, analysisInstruction: null,
} as Tenant;

const oggBytes = new TextEncoder().encode("OggS....voicedata");

function deps(overrides: Partial<Record<string, unknown>> = {}) {
  const db = openDb(":memory:");
  return {
    ghl: {
      latestMediaMessages: async () => [
        { id: "g2", attachments: ["https://storage.msgsndr.com/a.ogg"], direction: "inbound", dateAdded: "t2" },
      ],
      validatePit: async () => ({ ok: true as const }),
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
      validatePit: async () => ({ ok: true as const }),
    } });
    const r = await analyzeForContact(d as never, tenant, "C1");
    const noteMatches = r.text.match(/additional attachment\(s\) were not processed/g) ?? [];
    expect(noteMatches).toHaveLength(1);
    expect(r.text).toContain("[3 additional attachment(s) were not processed]");
    expect((r.text.match(/Voice note transcript/g) ?? [])).toHaveLength(3);
    // Chronological processing: the older gB (t1) is read before gA (t2).
    expect(r.processedIds).toEqual(["gB", "gA"]);
    expect(d.processed.has("t1", "gB")).toBe(true);
  });
  it("handles a mixed voice-note + image burst in the order the contact sent it", async () => {
    const pngBytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const described: string[] = [];
    const d = deps({
      ghl: {
        // GHL order: newest first (image last-sent → first in the list).
        latestMediaMessages: async () => [
          { id: "gImg", attachments: ["https://storage.msgsndr.com/photo.png"], direction: "inbound", dateAdded: "t3" },
          { id: "gVoice", attachments: ["https://storage.msgsndr.com/note.ogg"], direction: "inbound", dateAdded: "t2" },
        ],
        validatePit: async () => ({ ok: true as const }),
      },
      provider: {
        describe: async (i: { kind: string; mime: string }) => {
          described.push(`${i.kind}:${i.mime}`);
          return i.kind === "image" ? "a photo of a red card" : "see you friday";
        },
        validateKey: async () => ({ ok: true as const }),
      },
      fetchImpl: (async (url: string) =>
        new Response(String(url).endsWith(".png") ? pngBytes : oggBytes)) as unknown as typeof fetch,
    });
    const r = await analyzeForContact(d as never, tenant, "C1");
    expect(r.text).toContain("🎤 Voice note transcript: see you friday");
    expect(r.text).toContain("📷 Image: a photo of a red card");
    // Voice note (t2) must be read before the image (t3).
    expect(r.text.indexOf("Voice note transcript")).toBeLessThan(r.text.indexOf("📷 Image"));
    expect(described).toEqual(["audio:audio/ogg", "image:image/png"]);
    expect(r.processedIds).toEqual(["gVoice", "gImg"]);
  });
  it("a camera video is watched and labeled as a video, not a voice note", async () => {
    // The live failure: MP4 videos were sniffed as audio, so the model only
    // heard the soundtrack and the assistant asked the contact what was in
    // their own video.
    const mp4 = new Uint8Array(16);
    mp4.set(new TextEncoder().encode("ftyp"), 4);
    mp4.set(new TextEncoder().encode("isom"), 8);
    const seen: string[] = [];
    const d = deps({
      ghl: {
        latestMediaMessages: async () => [
          { id: "gVid", attachments: ["https://storage.msgsndr.com/clip.mp4"], direction: "inbound", dateAdded: "t1" },
        ],
        validatePit: async () => ({ ok: true as const }),
      },
      provider: {
        describe: async (i: { kind: string; mime: string }) => {
          seen.push(`${i.kind}:${i.mime}`);
          return "a person waves at the camera and says: bis Freitag";
        },
        validateKey: async () => ({ ok: true as const }),
      },
      fetchImpl: (async () => new Response(mp4)) as unknown as typeof fetch,
    });
    const r = await analyzeForContact(d as never, tenant, "C1");
    expect(seen).toEqual(["video:video/mp4"]);
    expect(r.text).toContain("🎬 Video: a person waves at the camera");
    expect(r.text).not.toContain("Voice note transcript");
  });
  it("video rides the image modality toggle", async () => {
    const mp4 = new Uint8Array(16);
    mp4.set(new TextEncoder().encode("ftyp"), 4);
    mp4.set(new TextEncoder().encode("isom"), 8);
    const d = deps({ fetchImpl: (async () => new Response(mp4)) as unknown as typeof fetch });
    const t2 = { ...tenant, modalities: { audio: true, image: false } };
    const r = await analyzeForContact(d as never, t2 as Tenant, "C1");
    expect(r.text).toContain("video processing is disabled");
  });
  it("a disallowed attachment host records the blocked hostname, never the full URL", async () => {
    const d = deps({ ghl: {
      latestMediaMessages: async () => [
        { id: "gX", attachments: ["https://mms.example-cdn.com/media/abc?sig=SECRET"], direction: "inbound", dateAdded: "t1" },
      ],
      validatePit: async () => ({ ok: true as const }),
    } });
    const r = await analyzeForContact(d as never, tenant, "C1");
    expect(r.text).toContain("disallowed_host");
    const ev = d.events.latest("t1", 5).find((e) => e.detail.includes("blocked attachment host"));
    expect(ev?.detail).toBe("blocked attachment host: mms.example-cdn.com");
    expect(ev?.detail).not.toContain("SECRET");
  });
  it("message with zero attachments yields no-new-attachments and marks nothing", async () => {
    const d = deps({ ghl: {
      latestMediaMessages: async () => [
        { id: "gEmpty", attachments: [], direction: "inbound", dateAdded: "t1" },
      ],
      validatePit: async () => ({ ok: true as const }),
    } });
    const r = await analyzeForContact(d as never, tenant, "C1");
    expect(r.text).toContain("no new attachments");
    expect(r.processedIds).toEqual([]);
    expect(d.processed.has("t1", "gEmpty")).toBe(false);
  });
});

describe("analyzeForContact — per-tenant analysis instruction", () => {
  it("forwards the tenant's guidance to the provider", async () => {
    const seen: Array<string | null | undefined> = [];
    const d = deps({
      provider: {
        describe: async (i: { instruction?: string | null }) => {
          seen.push(i.instruction);
          return "receipt: $250 ref 88231";
        },
        validateKey: async () => ({ ok: true as const }),
      },
    });
    const withGuidance = {
      ...tenant, analysisInstruction: "Extract amount and reference number.",
    } as Tenant;
    const r = await analyzeForContact(d as never, withGuidance, "C1");
    expect(seen).toEqual(["Extract amount and reference number."]);
    expect(r.text).toContain("receipt: $250 ref 88231");
  });
  it("sends nothing extra when no guidance is set", async () => {
    const seen: Array<string | null | undefined> = [];
    const d = deps({
      provider: {
        describe: async (i: { instruction?: string | null }) => { seen.push(i.instruction); return "x"; },
        validateKey: async () => ({ ok: true as const }),
      },
    });
    await analyzeForContact(d as never, tenant, "C1");
    expect(seen).toEqual([null]);
  });
});
