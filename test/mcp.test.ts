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
    providerFactory: () => ({ describe: async () => "transcript!", validateKey: async () => ({ ok: true as const }) }),
    mediaFetch: (async () => new Response(oggBytes)) as unknown as typeof fetch,
  }));
  return { app, token: t.token, tenants };
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
  it("a wrong-media-kind tool call returns a valid JSON-RPC result with isError, not a crash", async () => {
    // oggBytes sniffs as audio; calling analyze_image on it must error gracefully.
    const { app, token } = makeApp();
    const res = await request(app)
      .post(`/mcp/${token}`)
      .set("Accept", "application/json, text/event-stream")
      .send(rpc("tools/call", { name: "analyze_image", arguments: { url: "https://storage.msgsndr.com/a.ogg" } }));
    expect(res.status).toBe(200);
    expect(res.body.result.isError).toBe(true);
    expect(res.body.result.content[0].text).toMatch(/expected image/i);
  });
  it("a download failure returns isError, transport stays alive", async () => {
    const { app, token } = makeApp();
    const res = await request(app)
      .post(`/mcp/${token}`)
      .set("Accept", "application/json, text/event-stream")
      .send(rpc("tools/call", { name: "analyze_attachment", arguments: { url: "https://evil.example.com/x.ogg" } }));
    expect(res.status).toBe(200);
    expect(res.body.result.isError).toBe(true);
    expect(res.body.result.content[0].text).toMatch(/download failed|disallowed/i);
  });
  it("disabled tenant token → 401", async () => {
    const { app, token, tenants } = makeApp();
    const t = tenants.getByToken(token)!;
    tenants.setEnabled(t.id, false);
    const res = await request(app)
      .post(`/mcp/${token}`)
      .set("Accept", "application/json, text/event-stream")
      .send(rpc("tools/list", {}));
    expect(res.status).toBe(401);
  });
  it("honors the audio modality kill switch on the MCP door", async () => {
    // Same disabled-modality gate the tool/waker path enforces — a disabled
    // modality must not process on any door. oggBytes sniffs as audio.
    const { app, token, tenants } = makeApp();
    const t = tenants.getByToken(token)!;
    tenants.setModality(t.id, "audio", false);
    const res = await request(app)
      .post(`/mcp/${token}`)
      .set("Accept", "application/json, text/event-stream")
      .send(rpc("tools/call", { name: "transcribe_audio", arguments: { url: "https://storage.msgsndr.com/a.ogg" } }));
    expect(res.status).toBe(200);
    expect(res.body.result.isError).toBe(true);
    expect(res.body.result.content[0].text).toMatch(/audio processing is disabled/i);
  });
  it("status tool returns the account config", async () => {
    const { app, token } = makeApp();
    const res = await request(app)
      .post(`/mcp/${token}`)
      .set("Accept", "application/json, text/event-stream")
      .send(rpc("tools/call", { name: "status", arguments: {} }));
    expect(res.status).toBe(200);
    const parsed = JSON.parse(res.body.result.content[0].text);
    expect(parsed.provider).toBeDefined();
    expect(parsed.modalities).toBeDefined();
  });
});
