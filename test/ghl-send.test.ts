import { describe, expect, it } from "vitest";
import { createGhlClient } from "../src/clients/ghl";

const client = (impl: typeof fetch) =>
  createGhlClient({ baseUrl: "https://ghl.test", pit: "PIT", fetchImpl: impl });

const capture = (body: unknown, status = 200) => {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const impl = (async (url: string, init: RequestInit = {}) => {
    calls.push({ url, init });
    return new Response(JSON.stringify(body), { status });
  }) as unknown as typeof fetch;
  return { impl, calls };
};

describe("sendMessage", () => {
  it("posts type, contact, body and the attachments array", async () => {
    const { impl, calls } = capture({ messageId: "m1" });
    const r = await client(impl).sendMessage({
      contactId: "C1", type: "WhatsApp", message: "here you go",
      attachments: ["https://cdn.example.com/demo.mp4"],
    });
    expect(r).toEqual({ ok: true, id: "m1" });
    expect(calls[0].url).toBe("https://ghl.test/conversations/messages");
    expect(calls[0].init.method).toBe("POST");
    const sent = JSON.parse(String(calls[0].init.body));
    expect(sent).toEqual({
      type: "WhatsApp", contactId: "C1", message: "here you go",
      attachments: ["https://cdn.example.com/demo.mp4"],
    });
    expect((calls[0].init.headers as Record<string, string>).Authorization).toBe("Bearer PIT");
  });
  it("omits an empty message rather than sending a blank body", async () => {
    const { impl, calls } = capture({ messageId: "m1" });
    await client(impl).sendMessage({
      contactId: "C1", type: "SMS", attachments: ["https://cdn.example.com/a.png"],
    });
    expect(JSON.parse(String(calls[0].init.body))).not.toHaveProperty("message");
  });
  it("surfaces the status so the caller can explain the failure", async () => {
    const { impl } = capture({ message: "no channel" }, 422);
    const r = await client(impl).sendMessage({
      contactId: "C1", type: "WhatsApp", attachments: ["https://cdn.example.com/a.mp4"],
    });
    expect(r.ok).toBe(false);
    expect("error" in r && r.error).toMatch(/422/);
  });
  it("never throws on a network fault", async () => {
    const impl = (async () => { throw new Error("boom"); }) as unknown as typeof fetch;
    const r = await client(impl).sendMessage({
      contactId: "C1", type: "SMS", attachments: ["https://cdn.example.com/a.png"],
    });
    expect(r.ok).toBe(false);
  });
});

describe("latestConversationChannel", () => {
  const withConvs = (convs: unknown[]) =>
    capture({ conversations: convs }).impl;

  it("sends on the channel the conversation is actually using", async () => {
    // Hardcoding SMS would push an SMS into a WhatsApp thread: wrong channel,
    // real money, likely failure.
    const cases: Array<[string, string]> = [
      ["TYPE_WHATSAPP", "WhatsApp"], ["TYPE_SMS", "SMS"], ["TYPE_EMAIL", "Email"],
      ["TYPE_INSTAGRAM", "IG"], ["TYPE_FACEBOOK", "FB"], ["TYPE_LIVE_CHAT", "Live_Chat"],
      ["TYPE_CUSTOM", "Custom"],
    ];
    for (const [ghlType, expected] of cases) {
      const c = client(withConvs([{ id: "c1", lastMessageType: ghlType }]));
      expect(await c.latestConversationChannel("L1", "C1"), ghlType).toBe(expected);
    }
  });
  it("defaults to SMS when there is no conversation or no usable type", async () => {
    expect(await client(withConvs([])).latestConversationChannel("L1", "C1")).toBe("SMS");
    expect(await client(withConvs([{ id: "c1" }])).latestConversationChannel("L1", "C1")).toBe("SMS");
    expect(
      await client(withConvs([{ id: "c1", lastMessageType: "TYPE_ACTIVITY_CONTACT" }]))
        .latestConversationChannel("L1", "C1")
    ).toBe("SMS");
  });
  it("defaults to SMS rather than throwing when the lookup fails", async () => {
    const impl = (async () => { throw new Error("down"); }) as unknown as typeof fetch;
    expect(await client(impl).latestConversationChannel("L1", "C1")).toBe("SMS");
  });
});
