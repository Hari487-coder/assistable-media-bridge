import { describe, expect, it } from "vitest";
import { createGhlClient } from "../src/clients/ghl";

function fakeFetch(routes: Record<string, unknown>) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const impl = (async (url: string, init: RequestInit = {}) => {
    calls.push({ url, init });
    const hit = Object.entries(routes).find(([k]) => url.includes(k));
    return new Response(JSON.stringify(hit ? hit[1] : {}), { status: hit ? 200 : 404 });
  }) as typeof fetch;
  return { impl, calls };
}

describe("ghl client", () => {
  it("finds newest inbound media messages for a contact, ordered by date descending", async () => {
    const { impl, calls } = fakeFetch({
      "/conversations/search": { conversations: [{ id: "conv9" }] },
      "/conversations/conv9/messages": { messages: { messages: [
        { id: "g1", direction: "inbound", attachments: [], dateAdded: "2026-07-23T01:00:00Z" },
        { id: "g2", direction: "inbound", attachments: ["https://cdn/x.ogg"], dateAdded: "2026-07-23T02:00:00Z" },
        { id: "g0", direction: "inbound", attachments: ["https://cdn/z.jpg"], dateAdded: "2026-07-23T01:30:00Z" },
        { id: "g3", direction: "outbound", attachments: ["https://cdn/y.png"], dateAdded: "2026-07-23T03:00:00Z" },
      ] } },
    });
    const ghl = createGhlClient({ baseUrl: "https://g", pit: "P", fetchImpl: impl });
    const rows = await ghl.latestMediaMessages({ locationId: "L", contactId: "C", limit: 2 });
    expect(rows).toHaveLength(2);
    expect(rows[0].id).toBe("g2");
    expect(rows[1].id).toBe("g0");
    const h = calls[0].init.headers as Record<string, string>;
    expect(h.Authorization).toBe("Bearer P");
    expect(h.Version).toBe("2021-07-28");
    expect(calls[0].url).toContain("sortBy=last_message_date");
    expect(calls[0].url).toContain("sort=desc");
  });
  it("merges media across a contact's multiple conversation threads, deduped by id", async () => {
    // Observed live: consecutive tool calls saw disjoint message sets because
    // search flip-flopped which thread ranked first. The merged view must be
    // identical regardless of conversation order.
    const { impl } = fakeFetch({
      "/conversations/search": { conversations: [{ id: "convA" }, { id: "convB" }] },
      "/conversations/convA/messages": { messages: { messages: [
        { id: "a1", direction: "inbound", attachments: ["https://cdn/a1.jpg"], dateAdded: "2026-07-30T06:11:00Z" },
        { id: "shared", direction: "inbound", attachments: ["https://cdn/s.jpg"], dateAdded: "2026-07-30T06:01:00Z" },
      ] } },
      "/conversations/convB/messages": { messages: { messages: [
        { id: "b1", direction: "inbound", attachments: ["https://cdn/b1.jpg"], dateAdded: "2026-07-30T06:19:00Z" },
        { id: "shared", direction: "inbound", attachments: ["https://cdn/s.jpg"], dateAdded: "2026-07-30T06:01:00Z" },
      ] } },
    });
    const ghl = createGhlClient({ baseUrl: "https://g", pit: "P", fetchImpl: impl });
    const rows = await ghl.latestMediaMessages({ locationId: "L", contactId: "C" });
    expect(rows.map((r) => r.id)).toEqual(["b1", "a1", "shared"]);
    expect(rows[0].convId).toBe("convB");
  });
  it("tolerates one thread's messages fetch failing when another succeeds", async () => {
    const { impl } = fakeFetch({
      "/conversations/search": { conversations: [{ id: "convDead" }, { id: "convOk" }] },
      // convDead has no route → 404 from fakeFetch
      "/conversations/convOk/messages": { messages: { messages: [
        { id: "ok1", direction: "inbound", attachments: ["https://cdn/x.jpg"], dateAdded: "t1" },
      ] } },
    });
    const ghl = createGhlClient({ baseUrl: "https://g", pit: "P", fetchImpl: impl });
    const rows = await ghl.latestMediaMessages({ locationId: "L", contactId: "C" });
    expect(rows.map((r) => r.id)).toEqual(["ok1"]);
  });
  it("returns [] when contact has no conversations", async () => {
    const { impl } = fakeFetch({ "/conversations/search": { conversations: [] } });
    const ghl = createGhlClient({ baseUrl: "https://g", pit: "P", fetchImpl: impl });
    expect(await ghl.latestMediaMessages({ locationId: "L", contactId: "C" })).toEqual([]);
  });
  it("handles non-array conversations shape without crashing", async () => {
    const { impl } = fakeFetch({ "/conversations/search": { conversations: {} } });
    const ghl = createGhlClient({ baseUrl: "https://g", pit: "P", fetchImpl: impl });
    expect(await ghl.latestMediaMessages({ locationId: "L", contactId: "C" })).toEqual([]);
  });
  it("validatePit passes when search route responds 200", async () => {
    const { impl } = fakeFetch({ "/conversations/search": { conversations: [] } });
    const ghl = createGhlClient({ baseUrl: "https://g", pit: "L", fetchImpl: impl });
    expect(await ghl.validatePit("L")).toEqual({ ok: true });
  });
  it("validatePit reports the status and GHL's error body on a 401", async () => {
    const impl = (async () =>
      new Response(JSON.stringify({ message: "Invalid JWT", statusCode: 401 }), { status: 401 })
    ) as typeof fetch;
    const ghl = createGhlClient({ baseUrl: "https://g", pit: "bad", fetchImpl: impl });
    expect(await ghl.validatePit("L")).toEqual({ ok: false, status: 401, detail: "Invalid JWT" });
  });
  it("validatePit joins array-shaped GHL messages and omits detail when the body has none", async () => {
    const arr = (async () =>
      new Response(JSON.stringify({ message: ["locationId must be a string", "bad request"] }), { status: 400 })
    ) as typeof fetch;
    const ghl = createGhlClient({ baseUrl: "https://g", pit: "P", fetchImpl: arr });
    expect(await ghl.validatePit("L")).toEqual({
      ok: false, status: 400, detail: "locationId must be a string; bad request",
    });
    const empty = (async () => new Response("{}", { status: 403 })) as typeof fetch;
    const ghl2 = createGhlClient({ baseUrl: "https://g", pit: "P", fetchImpl: empty });
    expect(await ghl2.validatePit("L")).toEqual({ ok: false, status: 403 });
  });
  it("validatePit reports a network failure without a status", async () => {
    const impl = (async () => { throw new Error("net"); }) as typeof fetch;
    const ghl = createGhlClient({ baseUrl: "https://g", pit: "P", fetchImpl: impl });
    expect(await ghl.validatePit("L")).toEqual({ ok: false, detail: "network error" });
  });
});
