import request from "supertest";
import { describe, expect, it } from "vitest";
import { loadConfig, type AppConfig } from "../src/config";
import { buildApp } from "../src/http/app";
import { runWakerCycle } from "../src/core/waker";

process.env.MOCK_MODE = "1";
process.env.DB_PATH = ":memory:";

describe("mock-mode e2e", () => {
  it("onboards, wakes on media-only, and serves the tool call", async () => {
    const { app, wireDeps } = buildApp(loadConfig());

    // 1. Onboard
    const setup = await request(app).post("/setup").type("form").send({
      label: "MockVol", locationId: "mock-loc-1", assistantId: "mock-asst-1",
      provider: "gemini", v3Key: "any", ghlPit: "any", aiKey: "any",
    });
    expect(setup.status).toBe(200);
    const token = /\/mcp\/([a-f0-9]{48})/.exec(setup.text)?.[1];
    expect(token).toBeTruthy();
    const tenant = wireDeps.tenants.getByToken(token as string);
    expect(tenant).toBeTruthy();

    // 2. Waker: prime, bump, detect, wake
    const wakerDeps = wireDeps.wakerDepsFor(tenant!);
    await runWakerCycle(wakerDeps, tenant!);          // prime
    wireDeps.mockV3State.bumpConversation();          // media-only message arrives
    const r = await runWakerCycle(wakerDeps, tenant!);
    expect(r.woken).toBe(1);
    expect(wireDeps.mockV3State.wokenConversations.has("mock-conv-1")).toBe(true);

    // 3. Tool call (what the woken assistant does next)
    const tool = await request(app).post(`/tool/${token}`).send({
      args: {}, meta_data: { contact_id: "mock-contact-1", location_id: "mock-loc-1" },
    });
    expect(tool.status).toBe(200);
    expect(tool.body.result).toContain("Voice note transcript");
  });

  it("registers an asset and sends it, attachments and all, end to end", async () => {
    const { app, wireDeps } = buildApp(loadConfig());
    const setup = await request(app).post("/setup").type("form").send({
      label: "MockSend", locationId: "mock-loc-2", assistantId: "mock-asst-1",
      provider: "gemini", v3Key: "any", ghlPit: "any", aiKey: "any",
    });
    const token = /\/mcp\/([a-f0-9]{48})/.exec(setup.text)?.[1] as string;
    expect(token).toBeTruthy();

    // 1. The operator registers an asset in the portal.
    const added = await request(app).post(`/dashboard/${token}/assets`).type("form").send({
      name: "Demo Video", description: "60s walkthrough of the product",
      url: "https://cdn.example.com/demo.mp4",
    });
    expect(added.status).toBe(302);
    // MOCK_MODE must rehearse the REAL path end to end. A v3 method missing
    // from the mock surfaces here as a tool-update warning while every unit
    // test still passes — which is exactly how `updateTool` slipped through.
    expect(added.headers.location).not.toContain("assetError");

    // 2. It shows up in the tool description the assistant reads.
    // Assert on the description, not the name: the add form uses "demo-video"
    // as its placeholder, so matching the name alone passes even on a failed add.
    const page = await request(app).get(`/dashboard/${token}`);
    expect(page.text).toContain("60s walkthrough of the product");

    // 3. The assistant calls send_media, and the media actually reaches GHL
    //    with the attachment URL on the conversation's own channel.
    const sendRes = await request(app).post(`/send/${token}`).send({
      args: { asset: "demo-video", caption: "Here's a quick video 👇" },
      meta_data: { contact_id: "mock-contact-1", location_id: "mock-loc-2" },
    });
    expect(sendRes.status).toBe(200);
    expect(sendRes.body.result).toMatch(/sent/i);
    expect(wireDeps.mockV3State.sentMessages).toEqual([{
      contactId: "mock-contact-1", type: "WhatsApp", message: "Here's a quick video 👇",
      attachments: ["https://cdn.example.com/demo.mp4"],
    }]);

    // 4. The same asset does not go out twice.
    const again = await request(app).post(`/send/${token}`).send({
      args: { asset: "demo-video" },
      meta_data: { contact_id: "mock-contact-1", location_id: "mock-loc-2" },
    });
    expect(again.body.result).toMatch(/already sent/i);
    expect(wireDeps.mockV3State.sentMessages).toHaveLength(1);
  });

  it("buildApp constructs in non-mock mode and mounts routes without throwing", async () => {
    const cfg: AppConfig = {
      port: 0,
      mock: false,
      dbPath: ":memory:",
      encryptionKey: Buffer.alloc(32, 1),
      v3BaseUrl: "https://app.assistable.ai",
      ghlBaseUrl: "https://services.leadconnectorhq.com",
      publicBaseUrl: "https://x",
      wakerIntervalMs: 25_000,
      wakerConcurrency: 4,
      wakerBudgetMs: 20_000,
    };
    const { app } = buildApp(cfg);

    // health route is mounted and reports mock=false
    const health = await request(app).get("/health");
    expect(health.status).toBe(200);
    expect(health.body.mock).toBe(false);

    // tool route is mounted in real mode; unknown token short-circuits to 404
    // BEFORE any real client call, so this exercises real-mode wiring w/o network
    const tool = await request(app).post("/tool/unknown-token").send({ args: {} });
    expect(tool.status).toBe(404);
    expect(tool.body.result).toBeDefined();
  });
});
