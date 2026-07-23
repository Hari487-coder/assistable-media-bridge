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
  it("finds newest inbound media messages for a contact", async () => {
    const { impl, calls } = fakeFetch({
      "/conversations/search": { conversations: [{ id: "conv9" }] },
      "/conversations/conv9/messages": { messages: { messages: [
        { id: "g1", direction: "inbound", attachments: [], dateAdded: "2026-07-23T01:00:00Z" },
        { id: "g2", direction: "inbound", attachments: ["https://cdn/x.ogg"], dateAdded: "2026-07-23T02:00:00Z" },
        { id: "g3", direction: "outbound", attachments: ["https://cdn/y.png"], dateAdded: "2026-07-23T03:00:00Z" },
      ] } },
    });
    const ghl = createGhlClient({ baseUrl: "https://g", pit: "P", fetchImpl: impl });
    const rows = await ghl.latestMediaMessages({ locationId: "L", contactId: "C" });
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe("g2");
    const h = calls[0].init.headers as Record<string, string>;
    expect(h.Authorization).toBe("Bearer P");
    expect(h.Version).toBe("2021-04-15");
  });
  it("returns [] when contact has no conversations", async () => {
    const { impl } = fakeFetch({ "/conversations/search": { conversations: [] } });
    const ghl = createGhlClient({ baseUrl: "https://g", pit: "P", fetchImpl: impl });
    expect(await ghl.latestMediaMessages({ locationId: "L", contactId: "C" })).toEqual([]);
  });
});
