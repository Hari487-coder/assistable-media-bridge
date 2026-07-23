import { describe, expect, it } from "vitest";
import { openDb } from "../src/db";
import { createTenantStore } from "../src/store/tenants";
import { provisionTenant } from "../src/core/provision";

const input = {
  label: "Vol 1", locationId: "L1", assistantId: "A1",
  provider: "gemini" as const, v3Key: "v3", ghlPit: "pit", aiKey: "gk",
};

function deps(over: Partial<Record<string, unknown>> = {}) {
  const db = openDb(":memory:");
  return {
    tenants: createTenantStore(db, Buffer.alloc(32, 2)),
    publicBaseUrl: "https://media.example.com",
    v3Factory: () => ({
      validateKey: async () => true,
      listAssistants: async () => [{ id: "A1", name: "Bot" }],
      createTool: async () => ({ id: "tool_9", raw: {} }),
    }),
    ghlFactory: () => ({ validatePit: async () => true }),
    providerFactory: () => ({ validateKey: async () => true, describe: async () => "" }),
    ...over,
  };
}

describe("provisionTenant", () => {
  it("validates all creds, creates tenant + tool", async () => {
    const d = deps();
    const r = await provisionTenant(d as never, input);
    expect(r.tenant.token).toBeTruthy();
    expect(r.toolId).toBe("tool_9");
    expect(r.warnings).toEqual([]);
    expect(d.tenants.getByToken(r.tenant.token)?.toolId).toBe("tool_9");
  });
  it("throws naming the failing credential", async () => {
    const d = deps({ ghlFactory: () => ({ validatePit: async () => false }) });
    await expect(provisionTenant(d as never, input)).rejects.toThrow(/GHL/i);
  });
  it("tool-create failure is a warning, not a rollback", async () => {
    const d = deps({ v3Factory: () => ({
      validateKey: async () => true,
      listAssistants: async () => [{ id: "A1", name: "Bot" }],
      createTool: async () => { throw new Error("tools scope missing"); },
    }) });
    const r = await provisionTenant(d as never, input);
    expect(r.toolId).toBeNull();
    expect(r.warnings[0]).toContain("tool");
    expect(d.tenants.getByToken(r.tenant.token)).toBeTruthy();
  });
});
