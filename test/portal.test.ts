import express from "express";
import request from "supertest";
import { describe, expect, it } from "vitest";
import { openDb } from "../src/db";
import { createEventStore } from "../src/store/events";
import { createTenantStore } from "../src/store/tenants";
import { createPortalRouter } from "../src/http/portal";

function makeApp(opts: {
  assistants?: Array<{ id: string; name: string }>;
  assignFails?: string[];
  listAssistantsThrows?: boolean;
} = {}) {
  const db = openDb(":memory:");
  const tenants = createTenantStore(db, Buffer.alloc(32, 3));
  const events = createEventStore(db);
  const assigns: Array<{ toolId: string; assistantId: string }> = [];
  const app = express();
  app.use(express.urlencoded({ extended: false }));
  app.use(createPortalRouter({
    tenants, events, publicBaseUrl: "https://media.example.com",
    v3Factory: () => ({
      validateKey: async () => ({ ok: true }),
      listAssistants: async () => {
        if (opts.listAssistantsThrows) throw new Error("v3 listAssistants HTTP 500");
        return opts.assistants ?? [{ id: "A1", name: "Bot" }];
      },
      createTool: async () => ({ id: "tool_1", conflict: false, raw: {} }),
      findToolByName: async () => "tool_1",
      assignTool: async (toolId: string, assistantId: string) => {
        assigns.push({ toolId, assistantId });
        return (opts.assignFails ?? []).includes(assistantId)
          ? { ok: false, error: "v3 assignTool HTTP 403" }
          : { ok: true };
      },
      updateToolUrl: async () => ({ ok: true }),
    }) as never,
    ghlFactory: () => ({ validatePit: async () => ({ ok: true as const }) }) as never,
    providerFactory: () => ({ validateKey: async () => ({ ok: true as const }), describe: async () => "" }),
  }));
  return { app, tenants, events, assigns };
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
  it("POST /setup twice for one location reconnects instead of adding a second tenant", async () => {
    const { app, tenants } = makeApp();
    const form = {
      label: "Vol", locationId: "L1", assistantId: "A1",
      provider: "gemini", v3Key: "v", ghlPit: "p", aiKey: "k",
    };
    await request(app).post("/setup").type("form").send(form);
    const res = await request(app).post("/setup").type("form").send({ ...form, label: "Vol 2" });

    expect(res.status).toBe(200);
    expect(res.text).toContain("Reconnected");
    expect(res.text).toContain("already connected");
    expect(tenants.list()).toHaveLength(1);
    expect(tenants.getByLocationId("L1")?.label).toBe("Vol 2");
  });
  it("GET /setup/batch renders the bulk form", async () => {
    const { app } = makeApp();
    const res = await request(app).get("/setup/batch");
    expect(res.status).toBe(200);
    expect(res.text).toContain("Shared credentials");
    expect(res.text).toContain("subAccountId, locationId");
  });
  it("POST /setup/batch connects every listed subaccount and reports per row", async () => {
    const { app, tenants } = makeApp();
    const res = await request(app).post("/setup/batch").type("form").send({
      provider: "gemini", v3Key: "v", ghlPit: "p", aiKey: "k",
      rows: "sub_1, L1, A1, Clinic One\nsub_2, L2, A1, Clinic Two",
    });
    expect(res.status).toBe(200);
    expect(res.text).toContain("2 of 2 connected");
    expect(tenants.list()).toHaveLength(2);
    expect(tenants.getByLocationId("L2")?.subAccountId).toBe("sub_2");
  });
  it("POST /setup/batch with nothing parseable re-renders the form with the reason", async () => {
    const { app, tenants } = makeApp();
    const res = await request(app).post("/setup/batch").type("form").send({
      provider: "gemini", v3Key: "v", ghlPit: "p", aiKey: "k", rows: "garbage",
    });
    expect(res.status).toBe(400);
    expect(res.text).toContain("line 1");
    expect(tenants.list()).toHaveLength(0);
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
  it("dashboard offers Retry tool setup only while toolId is missing, and the retry heals it", async () => {
    const { app, tenants, events } = makeApp();
    const t = tenants.create({
      label: "V", locationId: "L1", assistantId: "A1",
      provider: "gemini", v3Key: "v", ghlPit: "p", aiKey: "k",
    });
    // toolId is null → the dashboard must offer the retry.
    const before = await request(app).get(`/dashboard/${t.token}`);
    expect(before.text).toContain("Retry tool setup");

    const retry = await request(app).post(`/dashboard/${t.token}/retry-tool`);
    expect(retry.status).toBe(302);
    expect(tenants.getByToken(t.token)?.toolId).toBe("tool_1");
    expect(events.latest(t.id, 5).some((e) => e.kind === "assign" && e.detail.includes("tool_1"))).toBe(true);

    const after = await request(app).get(`/dashboard/${t.token}`);
    expect(after.text).not.toContain("Retry tool setup");
    expect(after.text).toContain("tool_1");
  });
  it("dashboard saves, renders and clears the analysis guidance", async () => {
    const { app, tenants, events } = makeApp();
    const t = tenants.create({
      label: "V", locationId: "L1", assistantId: "A1",
      provider: "gemini", v3Key: "v", ghlPit: "p", aiKey: "k",
    });
    const save = await request(app).post(`/dashboard/${t.token}/instruction`)
      .type("form").send({ instruction: "Extract amount and reference number." });
    expect(save.status).toBe(302);
    expect(tenants.getByToken(t.token)?.analysisInstruction).toBe("Extract amount and reference number.");

    const page = await request(app).get(`/dashboard/${t.token}`);
    expect(page.text).toContain("Extract amount and reference number.");
    // The reader extracts; it does not verify. Say so where it is configured.
    expect(page.text).toContain("never let the assistant confirm a payment");
    expect(events.latest(t.id, 5).some((e) => e.kind === "config")).toBe(true);

    await request(app).post(`/dashboard/${t.token}/instruction`).type("form").send({ instruction: "" });
    expect(tenants.getByToken(t.token)?.analysisInstruction).toBeNull();
  });
  it("escapes the analysis guidance in the dashboard textarea (no XSS)", async () => {
    const { app, tenants } = makeApp();
    const t = tenants.create({
      label: "V", locationId: "L1", assistantId: "A1",
      provider: "gemini", v3Key: "v", ghlPit: "p", aiKey: "k",
    });
    await request(app).post(`/dashboard/${t.token}/instruction`)
      .type("form").send({ instruction: "</textarea><script>alert(1)</script>" });
    const page = await request(app).get(`/dashboard/${t.token}`);
    expect(page.text).not.toContain("<script>alert(1)</script>");
    expect(page.text).toContain("&lt;/textarea&gt;&lt;script&gt;");
  });
  it("saving guidance on an unknown token 404s", async () => {
    const { app } = makeApp();
    const res = await request(app).post("/dashboard/nope/instruction").type("form").send({ instruction: "x" });
    expect(res.status).toBe(404);
  });
  it("retry-tool on an unknown token 404s", async () => {
    const { app } = makeApp();
    const res = await request(app).post("/dashboard/nope/retry-tool");
    expect(res.status).toBe(404);
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

describe("attach tool to all assistants", () => {
  const connect = async (app: import("express").Express) =>
    request(app).post("/setup").type("form").send({
      label: "Multi", locationId: "L1", assistantId: "A1",
      provider: "gemini", v3Key: "v", ghlPit: "p", aiKey: "k",
    });

  it("attaches to every assistant in the subaccount", async () => {
    // A subaccount running several assistants: the waker only attaches the tool
    // to one as it wakes it, so an assistant that has never been sent an
    // attachment cannot read one on request until this runs.
    const { app, tenants, events, assigns } = makeApp({
      assistants: [{ id: "A1", name: "Support" }, { id: "A2", name: "Sales" }, { id: "A3", name: "Voice" }],
    });
    await connect(app);
    const t = tenants.getByLocationId("L1");
    assigns.length = 0; // ignore the one assignment onboarding already made

    const res = await request(app).post(`/dashboard/${t?.token}/assign-all`);
    expect(res.status).toBe(302);
    expect(assigns.map((a) => a.assistantId).sort()).toEqual(["A1", "A2", "A3"]);
    expect(assigns.every((a) => a.toolId === "tool_1")).toBe(true);
    expect(events.latest(t!.id, 5).some(
      (e) => e.kind === "assign" && e.detail.includes("3/3 assistants")
    )).toBe(true);
  });

  it("records which assistants failed without losing the ones that worked", async () => {
    const { app, tenants, events } = makeApp({
      assistants: [{ id: "A1", name: "Support" }, { id: "A2", name: "Sales" }],
      assignFails: ["A2"],
    });
    await connect(app);
    const t = tenants.getByLocationId("L1");

    await request(app).post(`/dashboard/${t?.token}/assign-all`);
    const latest = events.latest(t!.id, 5)[0];
    expect(latest.kind).toBe("error");
    expect(latest.detail).toContain("1/2 assistants");
    expect(latest.detail).toContain("A2");
  });

  it("survives the assistant lookup failing entirely", async () => {
    // Mutable so onboarding can succeed and only the later lookup breaks —
    // which is the real shape of a mid-session v3 outage.
    const control = { listAssistantsThrows: false };
    const { app, tenants, events } = makeApp(control);
    await connect(app);
    const t = tenants.getByLocationId("L1");

    control.listAssistantsThrows = true;
    const res = await request(app).post(`/dashboard/${t?.token}/assign-all`);
    expect(res.status).toBe(302); // never a 500 in the operator's face
    const latest = events.latest(t!.id, 5)[0];
    expect(latest.kind).toBe("error");
    expect(latest.detail).toContain("attach-to-all failed");
    expect(latest.detail).toContain("HTTP 500");
  });

  it("refuses when the tool does not exist yet and says what to do", async () => {
    const { app, tenants, events } = makeApp();
    const t = tenants.create({
      label: "V", locationId: "L2", assistantId: "A1",
      provider: "gemini", v3Key: "v", ghlPit: "p", aiKey: "k",
    }); // toolId is null
    const res = await request(app).post(`/dashboard/${t.token}/assign-all`);
    expect(res.status).toBe(302);
    expect(events.latest(t.id, 5)[0].detail).toMatch(/Retry tool setup/);
  });

  it("shows the button only once a tool exists", async () => {
    const { app, tenants } = makeApp();
    const noTool = tenants.create({
      label: "V", locationId: "L3", assistantId: "A1",
      provider: "gemini", v3Key: "v", ghlPit: "p", aiKey: "k",
    });
    const before = await request(app).get(`/dashboard/${noTool.token}`);
    expect(before.text).not.toContain("Attach tool to all assistants");
    expect(before.text).toContain("Retry tool setup");

    await connect(app);
    const withTool = tenants.getByLocationId("L1");
    const after = await request(app).get(`/dashboard/${withTool?.token}`);
    expect(after.text).toContain("Attach tool to all assistants");
  });

  it("assign-all on an unknown token 404s", async () => {
    const { app } = makeApp();
    expect((await request(app).post("/dashboard/nope/assign-all")).status).toBe(404);
  });
});
