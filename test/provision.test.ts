import { describe, expect, it } from "vitest";
import { openDb } from "../src/db";
import { createTenantStore } from "../src/store/tenants";
import { provisionTenant } from "../src/core/provision";

const input = {
  label: "Vol 1", locationId: "L1", assistantId: "A1",
  provider: "gemini" as const, v3Key: "v3", ghlPit: "pit", aiKey: "gk",
};

// A full fake v3 client. `assigned`/`created` capture what provision did.
function makeV3(over: Record<string, unknown> = {}) {
  const calls = { assigned: [] as Array<[string, string]>, createdName: "" };
  const base = {
    validateKey: async () => ({ ok: true as const }),
    listAssistants: async () => [{ id: "A1", name: "Bot" }],
    createTool: async (i: { name: string }) => { calls.createdName = i.name; return { id: "tool_9", conflict: false as const, raw: {} }; },
    findToolByName: async () => "tool_9",
    assignTool: async (toolId: string, assistantId: string) => { calls.assigned.push([toolId, assistantId]); return { ok: true as const }; },
    ...over,
  };
  return { client: base, calls };
}

function deps(v3?: ReturnType<typeof makeV3>, over: Partial<Record<string, unknown>> = {}) {
  const db = openDb(":memory:");
  const v = v3 ?? makeV3();
  return {
    v3,
    ctx: {
      tenants: createTenantStore(db, Buffer.alloc(32, 2)),
      publicBaseUrl: "https://media.example.com",
      v3Factory: () => v.client,
      ghlFactory: () => ({ validatePit: async () => true }),
      providerFactory: () => ({ validateKey: async () => ({ ok: true as const }), describe: async () => "" }),
      ...over,
    },
  };
}

describe("provisionTenant", () => {
  it("validates all creds, creates the tool AND assigns it to the assistant", async () => {
    const v3 = makeV3();
    const { ctx } = deps(v3);
    const r = await provisionTenant(ctx as never, input);
    expect(r.tenant.token).toBeTruthy();
    expect(r.toolId).toBe("tool_9");
    expect(r.warnings).toEqual([]);
    expect(ctx.tenants.getByToken(r.tenant.token)?.toolId).toBe("tool_9");
    // The critical fix: the tool is attached to the assistant, not just created.
    expect(v3.calls.assigned).toEqual([["tool_9", "A1"]]);
    expect(v3.calls.createdName).toBe("analyze_attachment");
  });
  it("surfaces the v3 diagnostic detail when the key fails validation", async () => {
    const v3 = makeV3({ validateKey: async () => ({ ok: false as const, detail: "HTTP 403 (subaccount_required: pick one)" }) });
    const { ctx } = deps(v3);
    await expect(provisionTenant(ctx as never, input)).rejects.toThrow(/subaccount_required/);
  });
  it("throws naming the failing credential", async () => {
    const { ctx } = deps(undefined, { ghlFactory: () => ({ validatePit: async () => false }) });
    await expect(provisionTenant(ctx as never, input)).rejects.toThrow(/GHL/i);
  });
  it("reuses an existing tool on 409 conflict, then assigns it", async () => {
    const v3 = makeV3({ createTool: async () => ({ id: null, conflict: true as const, raw: {} }) });
    const { ctx } = deps(v3);
    const r = await provisionTenant(ctx as never, input);
    expect(r.toolId).toBe("tool_9"); // resolved via findToolByName
    expect(v3.calls.assigned).toEqual([["tool_9", "A1"]]);
    expect(r.warnings).toEqual([]);
  });
  it("warns loudly when the tool is created but assignment fails", async () => {
    const v3 = makeV3({ assignTool: async () => ({ ok: false as const, error: "v3 assignTool HTTP 403" }) });
    const { ctx } = deps(v3);
    const r = await provisionTenant(ctx as never, input);
    expect(r.warnings[0]).toMatch(/could NOT be attached/i);
    expect(ctx.tenants.getByToken(r.tenant.token)).toBeTruthy(); // no rollback
  });
  it("tool-create failure is a warning, not a rollback", async () => {
    const v3 = makeV3({ createTool: async () => { throw new Error("tools scope missing"); } });
    const { ctx } = deps(v3);
    const r = await provisionTenant(ctx as never, input);
    expect(r.toolId).toBeNull();
    expect(r.warnings[0]).toContain("tool");
    expect(ctx.tenants.getByToken(r.tenant.token)).toBeTruthy();
  });
  it("persists an optional subAccountId", async () => {
    const v3 = makeV3();
    const { ctx } = deps(v3);
    const r = await provisionTenant(ctx as never, { ...input, subAccountId: "sub_42" });
    expect(ctx.tenants.getByToken(r.tenant.token)?.subAccountId).toBe("sub_42");
  });
});
