import express from "express";
import request from "supertest";
import { describe, expect, it } from "vitest";
import { openDb } from "../src/db";
import { createEventStore } from "../src/store/events";
import { createProcessedStore } from "../src/store/processed";
import { createTenantStore } from "../src/store/tenants";
import { createToolRouter, type ToolRouterCtx } from "../src/http/tool";

process.env.MOCK_MODE = "1";

const oggBytes = new TextEncoder().encode("OggS....voicedata");

function makeApp(overrides?: Partial<ToolRouterCtx>) {
  const db = openDb(":memory:");
  const key = Buffer.alloc(32, 1);
  const tenants = createTenantStore(db, key);
  const t = tenants.create({
    label: "T", locationId: "L1", assistantId: "A1", provider: "gemini",
    v3Key: "v", ghlPit: "p", aiKey: "k",
  });
  const events = createEventStore(db);
  const processed = createProcessedStore(db);
  const app = express();
  app.use(express.json());
  app.use(createToolRouter({
    tenants,
    processed,
    events,
    ghlFactory: () => ({
      latestMediaMessages: async () => [
        { id: "g1", attachments: ["https://storage.msgsndr.com/a.ogg"], direction: "inbound", dateAdded: "t" },
      ],
      validatePit: async () => true,
    }) as never,
    providerFactory: () => ({
      describe: async () => "voice says hi",
      validateKey: async () => ({ ok: true as const }),
    }),
    mediaFetch: (async () => new Response(oggBytes)) as unknown as typeof fetch,
    ...overrides,
  }));
  return { app, token: t.token, tenants, events };
}

describe("POST /tool/:token", () => {
  it("processes the envelope and returns a result string", async () => {
    const { app, token } = makeApp();
    const res = await request(app).post(`/tool/${token}`).send({
      args: {}, meta_data: { contact_id: "C1", location_id: "L1" }, metadata: {}, call: null,
    });
    expect(res.status).toBe(200);
    expect(res.body.result).toContain("voice says hi");
  });
  it("tolerates camelCase metadata keys", async () => {
    const { app, token } = makeApp();
    const res = await request(app).post(`/tool/${token}`).send({
      args: {}, metadata: { contactId: "C1", locationId: "L1" },
    });
    expect(res.body.result).toContain("voice says hi");
  });
  it("unknown token → 404 with an LLM-safe result", async () => {
    const { app } = makeApp();
    const res = await request(app).post("/tool/nope").send({ args: {} });
    expect(res.status).toBe(404);
    expect(res.body.result).toContain("not configured");
  });
  it("missing contact context → LLM-safe result, no crash", async () => {
    const { app, token } = makeApp();
    const res = await request(app).post(`/tool/${token}`).send({ args: {} });
    expect(res.status).toBe(200);
    expect(res.body.result).toContain("no contact context");
  });
  it("disabled tenant → 200 with LLM-safe disabled result", async () => {
    const { app, token, tenants } = makeApp();
    const t = tenants.getByToken(token)!;
    tenants.setEnabled(t.id, false);
    const res = await request(app).post(`/tool/${token}`).send({
      args: {}, meta_data: { contact_id: "C1", location_id: "L1" },
    });
    expect(res.status).toBe(200);
    expect(res.body.result).toContain("disabled");
  });
  it("internal failure degrades to LLM-safe result and records an error event", async () => {
    const { app, token, events, tenants } = makeApp({
      ghlFactory: () => { throw new Error("boom"); },
    });
    const res = await request(app).post(`/tool/${token}`).send({
      args: {}, meta_data: { contact_id: "C1", location_id: "L1" },
    });
    expect(res.status).toBe(200);
    expect(res.body.result).toContain("could not be read right now");
    const t = tenants.getByToken(token)!;
    expect(events.latest(t.id, 5).some((e) => e.kind === "error")).toBe(true);
  });
  it("meta_data takes precedence over metadata even across casings", async () => {
    const { app, token } = makeApp();
    const res = await request(app).post(`/tool/${token}`).send({
      args: {},
      metadata: { contact_id: "STALE" },
      meta_data: { contactId: "C1" },
    });
    expect(res.status).toBe(200);
    expect(res.body.result).toContain("voice says hi");
  });
  it("array body is handled safely", async () => {
    const { app, token } = makeApp();
    const res = await request(app).post(`/tool/${token}`).send([1, 2, 3]);
    expect(res.status).toBe(200);
    expect(res.body.result).toContain("no contact context");
  });
});
