import express from "express";
import request from "supertest";
import { describe, expect, it } from "vitest";
import { SEND_TOOL_NAME, buildSendToolDescription } from "../src/core/provision";
import { openDb } from "../src/db";
import { createToolRouter } from "../src/http/tool";
import { createAssetStore } from "../src/store/assets";
import { createEventStore } from "../src/store/events";
import { createProcessedStore } from "../src/store/processed";
import { createSendLog } from "../src/store/send-log";
import { createTenantStore } from "../src/store/tenants";

function makeApp(over: Record<string, unknown> = {}) {
  const db = openDb(":memory:");
  const tenants = createTenantStore(db, Buffer.alloc(32, 7));
  const t = tenants.create({
    label: "T", locationId: "L1", assistantId: "A1", provider: "gemini",
    v3Key: "v", ghlPit: "p", aiKey: "k",
  });
  const assets = createAssetStore(db);
  assets.add(t.id, {
    name: "demo-video", description: "60s walkthrough", kind: "video",
    url: "https://cdn.example.com/demo.mp4",
  });
  const events = createEventStore(db);
  const sent: Array<Record<string, unknown>> = [];
  const app = express();
  app.use(express.json());
  app.use(createToolRouter({
    tenants, processed: createProcessedStore(db), events, assets,
    sendLog: createSendLog(db),
    ghlFactory: () => ({
      validatePit: async () => ({ ok: true as const }),
      latestMediaMessages: async () => [],
      latestConversationChannel: async () => "WhatsApp",
      sendMessage: async (m: Record<string, unknown>) => { sent.push(m); return { ok: true as const, id: "m1" }; },
    }),
    providerFactory: () => ({
      describe: async () => "x", validateKey: async () => ({ ok: true as const }),
    }),
    mediaLookup: async () => [{ address: "93.184.216.34", family: 4 }],
    ...over,
  } as never));
  return { app, token: t.token, sent, tenants, events, assets, tenantId: t.id };
}

const envelope = (args: Record<string, unknown>) => ({
  args, meta_data: { contact_id: "C1", location_id: "L1" }, metadata: {}, call: null,
});

describe("POST /send/:token", () => {
  it("sends the named asset and returns a result string", async () => {
    const { app, token, sent } = makeApp();
    const res = await request(app).post(`/send/${token}`)
      .send(envelope({ asset: "demo-video", caption: "Here you go 👇" }));
    expect(res.status).toBe(200);
    expect(res.body.result).toMatch(/sent/i);
    expect(sent).toEqual([{
      contactId: "C1", type: "WhatsApp", message: "Here you go 👇",
      attachments: ["https://cdn.example.com/demo.mp4"],
    }]);
  });
  it("reads the asset name from either envelope casing", async () => {
    const { app, token, sent } = makeApp();
    await request(app).post(`/send/${token}`)
      .send({ args: { asset_name: "demo-video" }, meta_data: { contact_id: "C1" } });
    expect(sent).toHaveLength(1);
  });
  it("returns a steering string, never a 500, when the contact is missing", async () => {
    const { app, token } = makeApp();
    const res = await request(app).post(`/send/${token}`).send({ args: { asset: "demo-video" } });
    expect(res.status).toBe(200);
    expect(res.body.result).toMatch(/contact/i);
  });
  it("404s an unknown token", async () => {
    const { app } = makeApp();
    const res = await request(app).post("/send/nope").send(envelope({ asset: "demo-video" }));
    expect(res.status).toBe(404);
  });
  it("refuses to send while the bridge is disabled", async () => {
    const { app, token, tenants, tenantId, sent } = makeApp();
    tenants.setEnabled(tenantId, false);
    const res = await request(app).post(`/send/${token}`).send(envelope({ asset: "demo-video" }));
    expect(res.body.result).toMatch(/disabled/i);
    expect(sent).toHaveLength(0);
  });
  it("asks for a name instead of guessing when none is supplied", async () => {
    const { app, token, sent } = makeApp();
    const res = await request(app).post(`/send/${token}`).send(envelope({}));
    expect(sent).toHaveLength(0);
    expect(res.body.result).toMatch(/demo-video/);
  });
});

describe("send tool description", () => {
  it("carries the catalogue so the model can pick without another call", () => {
    const { assets, tenantId } = makeApp();
    const d = buildSendToolDescription(assets.list(tenantId));
    expect(d).toContain("demo-video");
    expect(d).toContain("60s walkthrough");
    expect(d).toMatch(/caption/i);
  });
  it("still describes itself when the library is empty", () => {
    expect(buildSendToolDescription([])).toMatch(/no assets/i);
    expect(SEND_TOOL_NAME).toBe("send_media");
  });
});
