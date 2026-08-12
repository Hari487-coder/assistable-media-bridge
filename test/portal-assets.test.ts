import express from "express";
import request from "supertest";
import { describe, expect, it } from "vitest";
import { openDb } from "../src/db";
import { createPortalRouter } from "../src/http/portal";
import { MAX_ASSETS, createAssetStore } from "../src/store/assets";
import { createEventStore } from "../src/store/events";
import { createTenantStore } from "../src/store/tenants";

function makeApp(opts: { headContentType?: string; headOk?: boolean } = {}) {
  const db = openDb(":memory:");
  const tenants = createTenantStore(db, Buffer.alloc(32, 3));
  const events = createEventStore(db);
  const assets = createAssetStore(db);
  const t = tenants.create({
    label: "T", locationId: "L1", assistantId: "A1", provider: "gemini",
    v3Key: "v", ghlPit: "p", aiKey: "k",
  });
  const toolPatches: unknown[] = [];
  const app = express();
  app.use(express.urlencoded({ extended: false }));
  app.use(createPortalRouter({
    tenants, events, assets, publicBaseUrl: "https://media.example.com",
    v3Factory: () => ({
      validateKey: async () => ({ ok: true }),
      listAssistants: async () => [{ id: "A1", name: "Bot" }],
      createTool: async () => ({ id: "tool_1", conflict: false, raw: {} }),
      findToolByName: async () => "tool_1",
      assignTool: async () => ({ ok: true }),
      updateToolUrl: async () => ({ ok: true }),
      updateTool: async (id: string, patch: unknown) => { toolPatches.push({ id, patch }); return { ok: true }; },
    }) as never,
    ghlFactory: () => ({ validatePit: async () => ({ ok: true as const }) }) as never,
    providerFactory: () => ({ validateKey: async () => ({ ok: true as const }), describe: async () => "" }),
    assetLookup: async () => [{ address: "93.184.216.34", family: 4 }],
    assetFetch: (async () => new Response(null, {
      status: opts.headOk === false ? 404 : 200,
      headers: { "content-type": opts.headContentType ?? "video/mp4" },
    })) as unknown as typeof fetch,
  } as never));
  return { app, token: t.token, tenantId: t.id, assets, events, toolPatches };
}

const add = (app: express.Express, token: string, form: Record<string, string>) =>
  request(app).post(`/dashboard/${token}/assets`).type("form").send(form);

/** Errors come back via a redirect, so follow it and assert on what the
 *  operator actually reads on the dashboard. */
const addFollow = (app: express.Express, token: string, form: Record<string, string>) =>
  add(app, token, form).redirects(1);

describe("portal assets", () => {
  it("adds an asset and shows it on the dashboard", async () => {
    const { app, token, assets, tenantId } = makeApp();
    const res = await add(app, token, {
      name: "Demo Video", description: "60s walkthrough",
      url: "https://cdn.example.com/demo.mp4",
    });
    expect(res.status).toBe(302);
    expect(assets.list(tenantId)).toHaveLength(1);
    expect(assets.get(tenantId, "demo-video")?.kind).toBe("video");

    const page = await request(app).get(`/dashboard/${token}`);
    expect(page.text).toContain("demo-video");
    expect(page.text).toContain("60s walkthrough");
  });
  it("re-pushes the tool description so the assistant learns the new asset", async () => {
    const { app, token, toolPatches } = makeApp();
    await add(app, token, {
      name: "demo-video", description: "60s walkthrough",
      url: "https://cdn.example.com/demo.mp4",
    });
    const patch = toolPatches.at(-1) as { patch: { description?: string } };
    expect(patch.patch.description).toContain("demo-video");
  });
  it("rejects a bad URL with a readable reason and stores nothing", async () => {
    const { app, token, assets, tenantId } = makeApp({ headOk: false });
    const res = await addFollow(app, token, {
      name: "gone", description: "missing file", url: "https://cdn.example.com/gone.mp4",
    });
    expect(assets.list(tenantId)).toHaveLength(0);
    expect(res.text).toMatch(/could not be reached/i);
  });
  it("refuses a private-address URL", async () => {
    const { app, token, assets, tenantId } = makeApp();
    const res = await addFollow(app, token, {
      name: "internal", description: "internal thing", url: "http://169.254.169.254/x.png",
    });
    expect(assets.list(tenantId)).toHaveLength(0);
    expect(res.text).toMatch(/private address/i);
  });
  it("requires a name and a description", async () => {
    const { app, token, assets, tenantId } = makeApp();
    const res = await addFollow(app, token, { name: "", description: "", url: "https://cdn.example.com/a.mp4" });
    expect(assets.list(tenantId)).toHaveLength(0);
    expect(res.text).toMatch(/name|description/i);
  });
  it("explains the cap instead of silently dropping the asset", async () => {
    const { app, token, assets, tenantId } = makeApp();
    for (let i = 0; i < MAX_ASSETS; i += 1) {
      assets.add(tenantId, {
        name: `a-${i}`, description: "x", kind: "image", url: `https://cdn.example.com/${i}.png`,
      });
    }
    const res = await addFollow(app, token, {
      name: "one-too-many", description: "x", url: "https://cdn.example.com/z.mp4",
    });
    expect(assets.list(tenantId)).toHaveLength(MAX_ASSETS);
    expect(res.text).toMatch(/maximum/i);
  });
  it("removes an asset and refreshes the tool description", async () => {
    const { app, token, assets, tenantId, toolPatches } = makeApp();
    assets.add(tenantId, {
      name: "demo-video", description: "x", kind: "video", url: "https://cdn.example.com/d.mp4",
    });
    const res = await request(app).post(`/dashboard/${token}/assets/remove`)
      .type("form").send({ name: "demo-video" });
    expect(res.status).toBe(302);
    expect(assets.list(tenantId)).toHaveLength(0);
    const patch = toolPatches.at(-1) as { patch: { description?: string } };
    expect(patch.patch.description).toMatch(/no assets/i);
  });
  it("records a config event for the activity feed", async () => {
    const { app, token, events, tenantId } = makeApp();
    await add(app, token, {
      name: "demo-video", description: "60s walkthrough", url: "https://cdn.example.com/d.mp4",
    });
    expect(events.latest(tenantId, 10).some((e) => e.detail.includes("demo-video"))).toBe(true);
  });
  it("404s an unknown token", async () => {
    const { app } = makeApp();
    const res = await add(app, "nope", { name: "x", description: "y", url: "https://a.test/b.mp4" });
    expect(res.status).toBe(404);
  });
});
