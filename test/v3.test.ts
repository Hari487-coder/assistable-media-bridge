import { describe, expect, it } from "vitest";
import { createV3Client } from "../src/clients/v3";

function fakeFetch(routes: Record<string, { status?: number; body: unknown }>) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const impl = async (url: string, init: RequestInit = {}) => {
    calls.push({ url, init });
    const hit = Object.entries(routes).find(([k]) => url.includes(k));
    const { status = 200, body } = hit ? hit[1] : { status: 404, body: { error: "nf" } };
    return new Response(JSON.stringify(body), { status });
  };
  return { impl: impl as typeof fetch, calls };
}

describe("v3 client", () => {
  it("lists conversations through the {ok,data,items} envelope", async () => {
    const { impl, calls } = fakeFetch({
      "api/v3/conversations?": { body: { ok: true, data: { items: [
        { id: "c1", contactId: "ct1", updatedAt: "2026-07-23T00:00:00Z", assistant: { id: "a1", name: "Bot" } },
      ] } } },
    });
    const v3 = createV3Client({ baseUrl: "https://x", apiKey: "K", fetchImpl: impl });
    const rows = await v3.listConversations(10);
    expect(rows[0].id).toBe("c1");
    expect(calls[0].url).toContain("sort=newest");
    expect((calls[0].init.headers as Record<string, string>).Authorization).toBe("Bearer K");
  });
  it("tolerates a bare-array body", async () => {
    const { impl } = fakeFetch({ "messages": { body: [
      { id: "m1", content: null, ai: false, source: "USER", channel: "whatsapp", createdAt: "t" },
    ] } });
    const v3 = createV3Client({ baseUrl: "https://x", apiKey: "K", fetchImpl: impl });
    const msgs = await v3.listMessages("c1");
    expect(msgs[0].source).toBe("USER");
  });
  it("posts chat completions with snake_case body", async () => {
    const { impl, calls } = fakeFetch({ "chat/completions": { body: { ok: true, data: {} } } });
    const v3 = createV3Client({ baseUrl: "https://x", apiKey: "K", fetchImpl: impl });
    const res = await v3.chatCompletion({
      assistantId: "a1", conversationId: "c1", additionalInstructions: "[media-mcp] hi",
    });
    expect(res.ok).toBe(true);
    const body = JSON.parse(String(calls[0].init.body));
    expect(body).toEqual({
      assistant_id: "a1", conversation_id: "c1", additional_instructions: "[media-mcp] hi",
    });
  });
  it("validateKey false on 401", async () => {
    const { impl } = fakeFetch({ "api/v3/conversations?": { status: 401, body: { error: "unauthorized" } } });
    const v3 = createV3Client({ baseUrl: "https://x", apiKey: "bad", fetchImpl: impl });
    expect(await v3.validateKey()).toBe(false);
  });
  it("lists assistants", async () => {
    const { impl, calls } = fakeFetch({ "api/v3/assistants": { body: { ok: true, data: { assistants: [{ id: "a1", name: "Bot" }] } } } });
    const v3 = createV3Client({ baseUrl: "https://x", apiKey: "K", fetchImpl: impl });
    const rows = await v3.listAssistants();
    expect(rows[0]).toEqual({ id: "a1", name: "Bot" });
    expect(calls[0].url).toContain("api/v3/assistants?limit=100");
  });
  it("creates a tool and returns its id", async () => {
    const { impl, calls } = fakeFetch({ "api/v3/tools": { body: { ok: true, data: { id: "tool_7" } } } });
    const v3 = createV3Client({ baseUrl: "https://x", apiKey: "K", fetchImpl: impl });
    const r = await v3.createTool({ name: "analyze_attachment", description: "d", url: "https://svc/tool/t", httpMethod: "POST" });
    expect(r.id).toBe("tool_7");
    const body = JSON.parse(String(calls[0].init.body));
    expect(body.name).toBe("analyze_attachment");
  });
  it("chatCompletion returns ok:false when API responds HTTP 200 with ok:false", async () => {
    const { impl } = fakeFetch({ "chat/completions": { body: { ok: false, error: "assistant not found" } } });
    const v3 = createV3Client({ baseUrl: "https://x", apiKey: "K", fetchImpl: impl });
    const res = await v3.chatCompletion({
      assistantId: "a1", conversationId: "c1", additionalInstructions: "test",
    });
    expect(res.ok).toBe(false);
    expect(res.error).toContain("200");
    expect(res.error).toContain("assistant not found");
  });
});
