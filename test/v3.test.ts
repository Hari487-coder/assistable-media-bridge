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
      "v3/conversations?": { body: { ok: true, data: { items: [
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
  it("validateKey returns ok:false with a diagnostic detail on 401", async () => {
    const { impl } = fakeFetch({ "v3/conversations?": { status: 401, body: { error: { code: "unauthorized", message: "bad key" } } } });
    const v3 = createV3Client({ baseUrl: "https://x", apiKey: "bad", fetchImpl: impl });
    const r = await v3.validateKey();
    expect(r.ok).toBe(false);
    expect(r.detail).toContain("401");
    expect(r.detail).toContain("bad key");
  });
  it("lists assistants", async () => {
    const { impl, calls } = fakeFetch({ "v3/assistants": { body: { ok: true, data: { assistants: [{ id: "a1", name: "Bot" }] } } } });
    const v3 = createV3Client({ baseUrl: "https://x", apiKey: "K", fetchImpl: impl });
    const rows = await v3.listAssistants();
    expect(rows[0]).toEqual({ id: "a1", name: "Bot" });
    expect(calls[0].url).toContain("v3/assistants?limit=100");
  });
  it("creates a CUSTOM tool with a snake_case body and returns its id", async () => {
    const { impl, calls } = fakeFetch({ "v3/tools": { body: { ok: true, data: { id: "tool_7" } } } });
    const v3 = createV3Client({ baseUrl: "https://x", apiKey: "K", fetchImpl: impl });
    const r = await v3.createTool({ name: "analyze_attachment", description: "d", url: "https://svc/tool/t" });
    expect(r.id).toBe("tool_7");
    const body = JSON.parse(String(calls[0].init.body));
    expect(body).toMatchObject({
      name: "analyze_attachment", url: "https://svc/tool/t",
      http_method: "POST", tool_type: "CUSTOM",
    });
  });
  it("createTool flags a 409 conflict instead of throwing", async () => {
    const { impl } = fakeFetch({ "v3/tools": { status: 409, body: { error: { code: "conflict", message: "exists" } } } });
    const v3 = createV3Client({ baseUrl: "https://x", apiKey: "K", fetchImpl: impl });
    const r = await v3.createTool({ name: "analyze_attachment", description: "d", url: "https://svc/tool/t" });
    expect(r.conflict).toBe(true);
    expect(r.id).toBeNull();
  });
  it("assignTool posts assistant_id to the assign route", async () => {
    const { impl, calls } = fakeFetch({ "/assign": { body: { ok: true, data: { assigned: true } } } });
    const v3 = createV3Client({ baseUrl: "https://x", apiKey: "K", fetchImpl: impl });
    const r = await v3.assignTool("tool_7", "asst_1");
    expect(r.ok).toBe(true);
    expect(calls[0].url).toContain("v3/tools/tool_7/assign");
    expect(JSON.parse(String(calls[0].init.body))).toMatchObject({ assistant_id: "asst_1" });
  });
  it("findToolByName returns the id of an exact name match", async () => {
    const { impl } = fakeFetch({ "v3/tools?": { body: { ok: true, data: { tools: [
      { id: "t_other", name: "something_else" },
      { id: "t_match", name: "analyze_attachment" },
    ] } } } });
    const v3 = createV3Client({ baseUrl: "https://x", apiKey: "K", fetchImpl: impl });
    expect(await v3.findToolByName("analyze_attachment")).toBe("t_match");
  });
  it("stamps X-Subaccount-Id header and subaccount_id body when a subaccount is set", async () => {
    const { impl, calls } = fakeFetch({ "chat/completions": { body: { ok: true, data: {} } } });
    const v3 = createV3Client({ baseUrl: "https://x", apiKey: "K", subAccountId: "sub_9", fetchImpl: impl });
    await v3.chatCompletion({ assistantId: "a1", conversationId: "c1", additionalInstructions: "hi" });
    expect((calls[0].init.headers as Record<string, string>)["X-Subaccount-Id"]).toBe("sub_9");
    expect(JSON.parse(String(calls[0].init.body)).subaccount_id).toBe("sub_9");
  });
  it("omits the subaccount header when none is set (single-key default)", async () => {
    const { impl, calls } = fakeFetch({ "v3/conversations?": { body: { ok: true, data: { items: [] } } } });
    const v3 = createV3Client({ baseUrl: "https://x", apiKey: "K", fetchImpl: impl });
    await v3.listConversations(1);
    expect((calls[0].init.headers as Record<string, string>)["X-Subaccount-Id"]).toBeUndefined();
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

describe("v3 client — request timeout", () => {
  // A hung v3 call is worse than a failed one: it holds a waker concurrency
  // slot indefinitely and stalls every tenant queued behind it.
  const hangingFetch = (async (_url: string, init: RequestInit = {}) =>
    new Promise<Response>((_resolve, reject) => {
      init.signal?.addEventListener("abort", () => {
        reject(Object.assign(new Error("aborted"), { name: "TimeoutError" }));
      });
    })) as typeof fetch;

  it("aborts a request that never responds, surfaced as a normal call failure", async () => {
    const v3 = createV3Client({
      baseUrl: "https://x", apiKey: "K", fetchImpl: hangingFetch, timeoutMs: 20,
    });
    await expect(v3.listConversations(10)).rejects.toThrow(/timed out after 20ms/);
  });

  it("passes an abort signal on every request", async () => {
    const { impl, calls } = fakeFetch({ "v3/conversations?": { body: { ok: true, data: [] } } });
    const v3 = createV3Client({ baseUrl: "https://x", apiKey: "K", fetchImpl: impl });
    await v3.listConversations(1);
    expect(calls[0].init.signal).toBeDefined();
  });
});
