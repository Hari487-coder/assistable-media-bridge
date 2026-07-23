import express from "express";
import request from "supertest";
import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config";
import { openDb } from "../src/db";
import { createEventStore } from "../src/store/events";
import { createProcessedStore } from "../src/store/processed";
import { createTenantStore } from "../src/store/tenants";
import { createToolRouter } from "../src/http/tool";

process.env.MOCK_MODE = "1";

const oggBytes = new TextEncoder().encode("OggS....voicedata");

function makeApp() {
  const db = openDb(":memory:");
  const key = Buffer.alloc(32, 1);
  const tenants = createTenantStore(db, key);
  const t = tenants.create({
    label: "T", locationId: "L1", assistantId: "A1", provider: "gemini",
    v3Key: "v", ghlPit: "p", aiKey: "k",
  });
  const app = express();
  app.use(express.json());
  app.use(createToolRouter({
    tenants,
    processed: createProcessedStore(db),
    events: createEventStore(db),
    config: loadConfig(),
    ghlFactory: () => ({
      latestMediaMessages: async () => [
        { id: "g1", attachments: ["https://storage.msgsndr.com/a.ogg"], direction: "inbound", dateAdded: "t" },
      ],
      validatePit: async () => true,
    }) as never,
    providerFactory: () => ({
      describe: async () => "voice says hi",
      validateKey: async () => true,
    }),
    mediaFetch: (async () => new Response(oggBytes)) as unknown as typeof fetch,
  }));
  return { app, token: t.token };
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
});
