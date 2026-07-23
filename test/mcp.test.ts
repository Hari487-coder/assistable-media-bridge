import express from "express";
import request from "supertest";
import { describe, expect, it } from "vitest";
import { openDb } from "../src/db";
import { createTenantStore } from "../src/store/tenants";
import { createMcpRouter } from "../src/http/mcp";

const oggBytes = new TextEncoder().encode("OggS....voicedata");

function makeApp() {
  const db = openDb(":memory:");
  const tenants = createTenantStore(db, Buffer.alloc(32, 1));
  const t = tenants.create({
    label: "T", locationId: "L1", assistantId: "A1", provider: "gemini",
    v3Key: "v", ghlPit: "p", aiKey: "k",
  });
  const app = express();
  app.use(express.json());
  app.use(createMcpRouter({
    tenants,
    providerFactory: () => ({ describe: async () => "transcript!", validateKey: async () => true }),
    mediaFetch: (async () => new Response(oggBytes)) as unknown as typeof fetch,
  }));
  return { app, token: t.token };
}

const rpc = (method: string, params: unknown, id = 1) => ({ jsonrpc: "2.0", id, method, params });

describe("mcp endpoint", () => {
  it("lists tools", async () => {
    const { app, token } = makeApp();
    const res = await request(app)
      .post(`/mcp/${token}`)
      .set("Accept", "application/json, text/event-stream")
      .send(rpc("tools/list", {}));
    expect(res.status).toBe(200);
    const names = res.body.result.tools.map((t: { name: string }) => t.name);
    expect(names).toContain("analyze_attachment");
    expect(names).toContain("transcribe_audio");
    expect(names).toContain("status");
  });
  it("calls analyze_attachment end to end", async () => {
    const { app, token } = makeApp();
    const res = await request(app)
      .post(`/mcp/${token}`)
      .set("Accept", "application/json, text/event-stream")
      .send(rpc("tools/call", {
        name: "analyze_attachment",
        arguments: { url: "https://storage.msgsndr.com/a.ogg" },
      }));
    expect(res.status).toBe(200);
    expect(res.body.result.content[0].text).toContain("transcript!");
  });
  it("rejects unknown token", async () => {
    const { app } = makeApp();
    const res = await request(app)
      .post("/mcp/badtoken")
      .set("Accept", "application/json, text/event-stream")
      .send(rpc("tools/list", {}));
    expect(res.status).toBe(401);
  });
});
