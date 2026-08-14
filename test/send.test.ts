import { describe, expect, it } from "vitest";
import { MAX_PER_CONTACT_24H, buildAssetCatalogue, sendAssetForContact } from "../src/core/send";
import { openDb } from "../src/db";
import { createAssetStore } from "../src/store/assets";
import { createEventStore } from "../src/store/events";
import { createSendLog } from "../src/store/send-log";
import type { Tenant } from "../src/store/tenants";

const tenant = { id: "T1", locationId: "L1" } as Tenant;

function harness(over: { send?: unknown; channel?: string | null } = {}) {
  const db = openDb(":memory:");
  const assets = createAssetStore(db);
  const events = createEventStore(db);
  const sendLog = createSendLog(db);
  const sent: unknown[] = [];
  assets.add("T1", {
    name: "demo-video", description: "60s product walkthrough",
    kind: "video", url: "https://cdn.example.com/demo.mp4",
  });
  assets.add("T1", {
    name: "price-sheet", description: "current pricing PDF",
    kind: "document", url: "https://cdn.example.com/p.pdf",
  });
  const ghl = {
    sendMessage: over.send ?? (async (m: unknown) => { sent.push(m); return { ok: true as const, id: "m1" }; }),
    // "channel" in over, not ?? — an explicit null means "no channel at all"
    // (the widget case) and must not collapse into the default.
    latestConversationChannel: async () => ("channel" in over ? over.channel : "WhatsApp"),
  };
  return {
    sent, events, assets, sendLog,
    deps: { ghl, assets, events, sendLog } as never,
  };
}

const call = (h: ReturnType<typeof harness>, asset: string, caption?: string) =>
  sendAssetForContact(h.deps, tenant, { contactId: "C1", asset, ...(caption ? { caption } : {}) });

describe("sending an asset", () => {
  it("sends on the conversation's channel with the caption on the media message", async () => {
    const h = harness();
    const r = await call(h, "demo-video", "Here's a quick video 👇");
    expect(h.sent).toEqual([{
      contactId: "C1", type: "WhatsApp", message: "Here's a quick video 👇",
      attachments: ["https://cdn.example.com/demo.mp4"],
    }]);
    expect(r.text).toMatch(/sent/i);
  });
  it("tells the model which caption already went out so it does not repeat it", async () => {
    // The media message lands BEFORE the assistant's own reply, so a model that
    // repeats its caption produces a stuttering two-message sequence.
    const h = harness();
    const r = await call(h, "demo-video", "Here's a quick video 👇");
    expect(r.text).toContain("Here's a quick video 👇");
    expect(r.text).toMatch(/do not repeat|already/i);
  });
  it("records a media_send event naming the asset and channel", async () => {
    const h = harness();
    await call(h, "demo-video");
    const feed = h.events.latest("T1", 10).map((e) => `${e.kind}:${e.detail}`).join(" ");
    expect(feed).toMatch(/media_send/);
    expect(feed).toMatch(/demo-video/);
    expect(feed).toMatch(/WhatsApp/);
  });
});

describe("unknown assets", () => {
  it("names the valid assets back so the model can retry correctly", async () => {
    // v3 tools carry no parameter schema, so the name cannot be constrained to
    // an enum — the recovery path is the error text.
    const h = harness();
    const r = await call(h, "explainer-vid");
    expect(h.sent).toHaveLength(0);
    expect(r.text).toContain("demo-video");
    expect(r.text).toContain("price-sheet");
    expect(r.text).toMatch(/do not have|no asset/i);
  });
  it("is explicit when the library is empty rather than looking broken", async () => {
    const db = openDb(":memory:");
    const h = {
      deps: {
        ghl: { sendMessage: async () => ({ ok: true as const }), latestConversationChannel: async () => "SMS" },
        assets: createAssetStore(db), events: createEventStore(db), sendLog: createSendLog(db),
      } as never,
    } as ReturnType<typeof harness>;
    const r = await call(h, "anything");
    expect(r.text).toMatch(/no assets|nothing to send/i);
  });
});

describe("guardrails", () => {
  it("refuses to send the same asset to a contact twice", async () => {
    const h = harness();
    await call(h, "demo-video");
    const again = await call(h, "demo-video");
    expect(h.sent).toHaveLength(1);
    expect(again.text).toMatch(/already sent/i);
    expect(again.text).toMatch(/refer/i);
  });
  it("caps sends per contact per 24 hours", async () => {
    const h = harness();
    for (let i = 0; i < MAX_PER_CONTACT_24H; i += 1) {
      h.assets.add("T1", {
        name: `a-${i}`, description: `asset ${i}`, kind: "image",
        url: `https://cdn.example.com/${i}.png`,
      });
      // Step past the cooldown so the cap, not the cooldown, is what blocks.
      h.sendLog.record("T1", "C1", `a-${i}`, "SMS", Date.now() - (i + 1) * 120_000);
    }
    const r = await call(h, "demo-video");
    expect(h.sent).toHaveLength(0);
    expect(r.text).toMatch(/enough|already sent .* media|limit/i);
  });
  it("does not let a blocked attempt consume the budget", async () => {
    const h = harness();
    await call(h, "demo-video");            // 1 real send
    await call(h, "demo-video");            // blocked, must not count
    await call(h, "nope-not-here");         // blocked, must not count
    expect(h.sendLog.countSince("T1", "C1", Date.now() - 86_400_000)).toBe(1);
  });
  it("blocks a second send inside the cooldown so one turn cannot fire twice", async () => {
    const h = harness();
    await call(h, "demo-video");
    const r = await call(h, "price-sheet");
    expect(h.sent).toHaveLength(1);
    expect(r.text).toMatch(/just sent|moment|wait/i);
  });
  it("allows a different asset once the cooldown has passed", async () => {
    const h = harness();
    h.sendLog.record("T1", "C1", "something-else", "SMS", Date.now() - 120_000);
    const r = await call(h, "demo-video");
    expect(h.sent).toHaveLength(1);
    expect(r.text).toMatch(/sent/i);
  });
  it("scopes guardrails to the contact, not the whole tenant", async () => {
    const h = harness();
    await call(h, "demo-video");
    const other = await sendAssetForContact(h.deps, tenant, { contactId: "C2", asset: "demo-video" });
    expect(h.sent).toHaveLength(2);
    expect(other.text).toMatch(/sent/i);
  });
});

describe("no messaging channel (the chat widget)", () => {
  // The widget loads custom tools and creates a bare CRM contact, so send_media
  // fires there — but the widget keeps its conversation on Assistable's side
  // and renders media only from its own built-in artifact search. Guessing SMS
  // here texted a website visitor.
  const widget = () => harness({ channel: null });

  it("does not attach anything, and hands the model the link instead", async () => {
    const h = widget();
    const r = await call(h, "demo-video", "Here's the walkthrough");
    expect(h.sent).toHaveLength(0);
    expect(r.text).toContain("https://cdn.example.com/demo.mp4");
    expect(r.text).toMatch(/include this link in your reply/i);
    expect(r.text).toMatch(/NOT sent as an attachment/i);
  });
  it("passes the caption through so the model can introduce it", async () => {
    const r = await call(widget(), "demo-video", "Here's the walkthrough");
    expect(r.text).toContain("Here's the walkthrough");
  });
  it("counts as a delivery, so the same link is not pasted twice", async () => {
    const h = widget();
    await call(h, "demo-video");
    const again = await call(h, "demo-video");
    expect(again.text).toMatch(/already sent/i);
    expect(h.sendLog.countSince("T1", "C1", 0)).toBe(1);
  });
  it("records it in the activity feed as a link", async () => {
    const h = widget();
    await call(h, "demo-video");
    const feed = h.events.latest("T1", 10).map((e) => `${e.kind}:${e.detail}`).join(" ");
    expect(feed).toMatch(/media_send/);
    expect(feed).toMatch(/as a link/);
  });
});

describe("failures", () => {
  it("returns steering text and records an error when GHL rejects the send", async () => {
    const h = harness({ send: async () => ({ ok: false as const, error: "ghl send 422: no channel" }) });
    const r = await call(h, "demo-video");
    expect(r.text).toMatch(/could not send/i);
    expect(r.text).toMatch(/do not claim|never claim/i);
    expect(h.events.latest("T1", 10).some((e) => e.kind === "error")).toBe(true);
    // A failed send must not burn the asset — the contact never received it.
    expect(h.sendLog.countSince("T1", "C1", 0)).toBe(0);
  });
});

describe("catalogue for the tool description", () => {
  it("lists every asset with its name, kind and description", () => {
    const h = harness();
    const text = buildAssetCatalogue(h.assets.list("T1"));
    expect(text).toContain("demo-video");
    expect(text).toContain("60s product walkthrough");
    expect(text).toContain("price-sheet");
    expect(text).toMatch(/video/);
  });
  it("says so plainly when there is nothing to send", () => {
    expect(buildAssetCatalogue([])).toMatch(/no assets/i);
  });
});
