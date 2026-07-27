import express from "express";
import request from "supertest";
import { describe, expect, it } from "vitest";
import { openDb } from "../src/db";
import { createEventStore } from "../src/store/events";
import { createTenantStore } from "../src/store/tenants";
import { createPortalRouter } from "../src/http/portal";

function makeApp() {
  const db = openDb(":memory:");
  const tenants = createTenantStore(db, Buffer.alloc(32, 3));
  const events = createEventStore(db);
  const app = express();
  app.use(express.urlencoded({ extended: false }));
  app.use(createPortalRouter({
    tenants, events, publicBaseUrl: "https://media.example.com",
    v3Factory: () => ({
      validateKey: async () => ({ ok: true }),
      listAssistants: async () => [{ id: "A1", name: "Bot" }],
      createTool: async () => ({ id: "tool_1", conflict: false, raw: {} }),
      findToolByName: async () => "tool_1",
      assignTool: async () => ({ ok: true }),
    }) as never,
    ghlFactory: () => ({ validatePit: async () => true }) as never,
    providerFactory: () => ({ validateKey: async () => ({ ok: true as const }), describe: async () => "" }),
  }));
  return { app, tenants, events };
}

describe("portal", () => {
  it("GET / renders the setup form", async () => {
    const { app } = makeApp();
    const res = await request(app).get("/");
    expect(res.status).toBe(200);
    expect(res.text).toContain("Assistable v3 API key");
  });
  it("POST /setup provisions and shows the MCP URL + prompt snippet", async () => {
    const { app } = makeApp();
    const res = await request(app).post("/setup").type("form").send({
      label: "Vol", locationId: "L1", assistantId: "A1",
      provider: "gemini", v3Key: "v", ghlPit: "p", aiKey: "k",
    });
    expect(res.status).toBe(200);
    expect(res.text).toContain("/mcp/");
    expect(res.text).toContain("analyze_attachment");
  });
  it("dashboard shows health events", async () => {
    const { app, tenants, events } = makeApp();
    const t = tenants.create({
      label: "V", locationId: "L1", assistantId: "A1",
      provider: "gemini", v3Key: "v", ghlPit: "p", aiKey: "k",
    });
    events.record(t.id, "wake", "conv=c1");
    const res = await request(app).get(`/dashboard/${t.token}`);
    expect(res.status).toBe(200);
    expect(res.text).toContain("wake");
  });
  it("escapes a malicious tenant label in the dashboard title (no XSS)", async () => {
    const { app, tenants } = makeApp();
    const t = tenants.create({
      label: "</title><script>alert(1)</script>", locationId: "L1", assistantId: "A1",
      provider: "gemini", v3Key: "v", ghlPit: "p", aiKey: "k",
    });
    const res = await request(app).get(`/dashboard/${t.token}`);
    expect(res.status).toBe(200);
    expect(res.text).not.toContain("<script>alert(1)</script>");
    expect(res.text).toContain("&lt;/title&gt;&lt;script&gt;alert(1)&lt;/script&gt;");
  });
});
