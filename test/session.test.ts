import express from "express";
import request from "supertest";
import { describe, expect, it } from "vitest";
import { openDb } from "../src/db";
import { createPortalRouter } from "../src/http/portal";
import { createAssetStore } from "../src/store/assets";
import { createEventStore } from "../src/store/events";
import { createTenantStore } from "../src/store/tenants";

function makeApp() {
  const db = openDb(":memory:");
  const tenants = createTenantStore(db, Buffer.alloc(32, 5));
  const app = express();
  app.use(express.urlencoded({ extended: false }));
  app.use(createPortalRouter({
    tenants, events: createEventStore(db), assets: createAssetStore(db),
    publicBaseUrl: "https://media.example.com",
    v3Factory: () => ({
      validateKey: async () => ({ ok: true }),
      listAssistants: async () => [{ id: "A1", name: "Bot" }],
      createTool: async () => ({ id: "tool_1", conflict: false, raw: {} }),
      findToolByName: async () => "tool_1",
      assignTool: async () => ({ ok: true }),
      updateToolUrl: async () => ({ ok: true }),
      updateTool: async () => ({ ok: true }),
    }) as never,
    ghlFactory: () => ({ validatePit: async () => ({ ok: true as const }) }) as never,
    providerFactory: () => ({ validateKey: async () => ({ ok: true as const }), describe: async () => "" }),
  } as never));
  return { app, tenants };
}

const connect = (app: express.Express, over: Record<string, string> = {}) =>
  request(app).post("/setup").type("form").send({
    label: "Main Street Dental", locationId: "loc-1", assistantId: "A1",
    provider: "gemini", v3Key: "v", ghlPit: "p", aiKey: "k", ...over,
  });

const cookieOf = (res: request.Response) =>
  ([] as string[]).concat(res.headers["set-cookie"] ?? []).join("; ");

describe("remembering the dashboard", () => {
  it("sets an httpOnly cookie when a subaccount connects", async () => {
    const { app } = makeApp();
    const res = await connect(app);
    const raw = ([] as string[]).concat(res.headers["set-cookie"] ?? []).find((c) => c.startsWith("mb_dash="));
    expect(raw).toBeTruthy();
    expect(raw).toMatch(/HttpOnly/i);
    expect(raw).toMatch(/SameSite=Lax/i);
    expect(raw).toMatch(/Path=\//i);
    // Token must be the real one, not something guessable.
    const token = /\/dashboard\/([a-f0-9]{48})/.exec(res.text)?.[1];
    expect(raw).toContain(token as string);
  });
  it("shows a way back to the dashboard on the landing page", async () => {
    // The whole point: close the tab, come back to /, and your subaccount is
    // waiting instead of an empty setup form.
    const { app } = makeApp();
    const setup = await connect(app);
    const token = /\/dashboard\/([a-f0-9]{48})/.exec(setup.text)?.[1] as string;

    const home = await request(app).get("/").set("Cookie", cookieOf(setup));
    expect(home.text).toContain(`/dashboard/${token}`);
    expect(home.text).toContain("Main Street Dental");
  });
  it("shows only the setup form to a browser that has never connected", async () => {
    const { app } = makeApp();
    const home = await request(app).get("/");
    expect(home.text).not.toMatch(/Your connected subaccounts/i);
    expect(home.text).toContain("/setup");
  });
  it("lists several subaccounts, most recent first", async () => {
    const { app } = makeApp();
    const first = await connect(app, { label: "Alpha Clinic", locationId: "loc-a" });
    const second = await request(app).post("/setup").type("form")
      .set("Cookie", cookieOf(first))
      .send({
        label: "Beta Dental", locationId: "loc-b", assistantId: "A1",
        provider: "gemini", v3Key: "v", ghlPit: "p", aiKey: "k",
      });
    const home = await request(app).get("/").set("Cookie", cookieOf(second));
    expect(home.text).toContain("Alpha Clinic");
    expect(home.text).toContain("Beta Dental");
    expect(home.text.indexOf("Beta Dental")).toBeLessThan(home.text.indexOf("Alpha Clinic"));
  });
  it("remembers a dashboard opened from a bookmark on a fresh browser", async () => {
    const { app } = makeApp();
    const setup = await connect(app);
    const token = /\/dashboard\/([a-f0-9]{48})/.exec(setup.text)?.[1] as string;

    const visit = await request(app).get(`/dashboard/${token}`); // no cookie sent
    const raw = ([] as string[]).concat(visit.headers["set-cookie"] ?? []).find((c) => c.startsWith("mb_dash="));
    expect(raw).toContain(token);
  });
  it("ignores tokens that no longer resolve to a subaccount", async () => {
    const { app } = makeApp();
    const home = await request(app).get("/").set("Cookie", `mb_dash=${"a".repeat(48)}`);
    expect(home.status).toBe(200);
    expect(home.text).not.toMatch(/Your connected subaccounts/i);
  });
  it("ignores a malformed cookie rather than breaking the page", async () => {
    const { app } = makeApp();
    const home = await request(app).get("/").set("Cookie", "mb_dash=not-a-token,../../etc/passwd");
    expect(home.status).toBe(200);
  });
  it("forgets this browser on request — for shared machines", async () => {
    const { app } = makeApp();
    const setup = await connect(app);
    const forget = await request(app).post("/forget").set("Cookie", cookieOf(setup));
    expect(forget.status).toBe(302);
    const cleared = ([] as string[]).concat(forget.headers["set-cookie"] ?? []).find((c) => c.startsWith("mb_dash="));
    expect(cleared).toMatch(/mb_dash=;/);
  });
});
