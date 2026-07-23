import request from "supertest";
import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config";
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
});
