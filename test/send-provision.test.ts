import { describe, expect, it } from "vitest";
import { SEND_TOOL_NAME, ensureSendTool } from "../src/core/provision";
import type { Asset } from "../src/store/assets";
import type { Tenant } from "../src/store/tenants";

const tenant = (over: Partial<Tenant> = {}) => ({
  id: "T1", token: "tok123", assistantId: "A1", sendToolId: null, ...over,
} as Tenant);

const assets: Asset[] = [{
  id: "a1", tenantId: "T1", name: "demo-video", description: "60s walkthrough",
  kind: "video", url: "https://cdn.example.com/d.mp4", createdAt: 0,
}];

function v3(over: Record<string, unknown> = {}) {
  const calls: Record<string, unknown[]> = { create: [], update: [], assign: [], find: [] };
  return {
    calls,
    client: {
      createTool: async (i: unknown) => { calls.create.push(i); return { id: "tool-1", conflict: false as const, raw: {} }; },
      findToolByName: async (n: string) => { calls.find.push(n); return "found-1"; },
      assignTool: async (t: string, a: string) => { calls.assign.push({ t, a }); return { ok: true as const }; },
      updateTool: async (t: string, p: unknown) => { calls.update.push({ t, p }); return { ok: true as const }; },
      ...over,
    } as never,
  };
}
const store = () => {
  const saved: string[] = [];
  return { saved, store: { setSendToolId: (_id: string, tool: string) => { saved.push(tool); } } as never };
};

describe("ensureSendTool", () => {
  it("creates the tool with the asset catalogue and assigns it", async () => {
    const v = v3(); const s = store();
    const r = await ensureSendTool(v.client, s.store, "https://bridge.test", tenant(), assets);
    expect(r.toolId).toBe("tool-1");
    expect(r.warnings).toEqual([]);
    expect(v.calls.create[0]).toMatchObject({
      name: SEND_TOOL_NAME, url: "https://bridge.test/send/tok123",
    });
    expect(String((v.calls.create[0] as { description: string }).description)).toContain("demo-video");
    expect(s.saved).toEqual(["tool-1"]);
    expect(v.calls.assign[0]).toEqual({ t: "tool-1", a: "A1" });
  });
  it("refreshes the description on an existing tool instead of creating another", async () => {
    // The description is the only place the model learns which assets exist,
    // so an edit that does not reach it leaves the assistant guessing names.
    const v = v3(); const s = store();
    await ensureSendTool(v.client, s.store, "https://bridge.test", tenant({ sendToolId: "old-1" }), assets);
    expect(v.calls.create).toHaveLength(0);
    expect(v.calls.update[0]).toMatchObject({ t: "old-1" });
    const patch = (v.calls.update[0] as { p: { url: string; description: string } }).p;
    expect(patch.url).toBe("https://bridge.test/send/tok123");
    expect(patch.description).toContain("demo-video");
  });
  it("recovers by lookup when create fails, because a soft-deleted tool blocks create forever", async () => {
    const v = v3({ createTool: async () => { throw new Error("v3 createTool 500"); } });
    const s = store();
    const r = await ensureSendTool(v.client, s.store, "https://bridge.test", tenant(), assets);
    expect(r.toolId).toBe("found-1");
    expect(v.calls.find).toEqual([SEND_TOOL_NAME]);
  });
  it("warns instead of throwing when the tool cannot be created or found", async () => {
    const v = v3({
      createTool: async () => { throw new Error("boom"); },
      findToolByName: async () => null,
    });
    const r = await ensureSendTool(v.client, store().store, "https://bridge.test", tenant(), assets);
    expect(r.toolId).toBeNull();
    expect(r.warnings[0]).toMatch(/send_media/);
    expect(r.warnings[0]).toContain("https://bridge.test/send/tok123");
  });
  it("warns when assignment fails — an unassigned tool is invisible to the assistant", async () => {
    const v = v3({ assignTool: async () => ({ ok: false as const, error: "v3 assignTool 403" }) });
    const r = await ensureSendTool(v.client, store().store, "https://bridge.test", tenant(), assets);
    expect(r.toolId).toBe("tool-1");
    expect(r.warnings[0]).toMatch(/could NOT be attached/);
  });
});
