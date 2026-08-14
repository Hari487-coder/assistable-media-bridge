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

describe("latestConversationChannel — resolved from the contact's own messages", () => {
  /** search returns conversations; each conversation returns its messages. */
  const withThreads = (
    convs: Array<{ id: string; lastMessageType?: string }>,
    messagesByConv: Record<string, Array<{ id: string; direction?: string; messageType?: string; dateAdded?: string }>>
  ) => (async (url: string) => {
    const u = String(url);
    if (u.includes("/conversations/search")) {
      return new Response(JSON.stringify({ conversations: convs }), { status: 200 });
    }
    const id = /\/conversations\/([^/]+)\/messages/.exec(u)?.[1] ?? "";
    return new Response(JSON.stringify({ messages: { messages: messagesByConv[id] ?? [] } }), { status: 200 });
  }) as unknown as typeof fetch;

  it("follows the contact's newest INBOUND message, not the newest thread", async () => {
    // The live failure: a contact talking on SMS also had an email thread that
    // an outbound marketing blast had bumped to the top. We sent as Email and
    // GHL refused with "Cannot send email as ... has unsubscribed", so the
    // lead got nothing. Outbound traffic must never decide the channel.
    const impl = withThreads(
      [
        { id: "email-thread", lastMessageType: "TYPE_EMAIL" },
        { id: "sms-thread", lastMessageType: "TYPE_SMS" },
      ],
      {
        "email-thread": [
          { id: "e1", direction: "outbound", messageType: "TYPE_EMAIL", dateAdded: "2026-08-12T20:00:00Z" },
        ],
        "sms-thread": [
          { id: "s1", direction: "inbound", messageType: "TYPE_SMS", dateAdded: "2026-08-12T14:00:00Z" },
        ],
      }
    );
    expect(await client(impl).latestConversationChannel("L1", "C1")).toBe("SMS");
  });
  it("picks the most recent inbound when the contact uses several channels", async () => {
    const impl = withThreads(
      [{ id: "a" }, { id: "b" }],
      {
        a: [{ id: "m1", direction: "inbound", messageType: "TYPE_SMS", dateAdded: "2026-08-01T10:00:00Z" }],
        b: [{ id: "m2", direction: "inbound", messageType: "TYPE_WHATSAPP", dateAdded: "2026-08-12T10:00:00Z" }],
      }
    );
    expect(await client(impl).latestConversationChannel("L1", "C1")).toBe("WhatsApp");
  });
  it("falls back to outbound traffic when the contact has never written", async () => {
    const impl = withThreads(
      [{ id: "a" }],
      { a: [{ id: "m1", direction: "outbound", messageType: "TYPE_WHATSAPP", dateAdded: "2026-08-12T10:00:00Z" }] }
    );
    expect(await client(impl).latestConversationChannel("L1", "C1")).toBe("WhatsApp");
  });
  it("ignores calls and system rows that cannot carry an attachment", async () => {
    const impl = withThreads(
      [{ id: "a" }],
      { a: [
        { id: "m1", direction: "inbound", messageType: "TYPE_CALL", dateAdded: "2026-08-12T12:00:00Z" },
        { id: "m2", direction: "inbound", messageType: "TYPE_ACTIVITY_CONTACT", dateAdded: "2026-08-12T11:00:00Z" },
        { id: "m3", direction: "inbound", messageType: "TYPE_SMS", dateAdded: "2026-08-10T09:00:00Z" },
      ] }
    );
    expect(await client(impl).latestConversationChannel("L1", "C1")).toBe("SMS");
  });
  it("falls back to the thread's lastMessageType when messages cannot be read", async () => {
    const impl = (async (url: string) => {
      const u = String(url);
      if (u.includes("/conversations/search")) {
        return new Response(JSON.stringify({ conversations: [{ id: "a", lastMessageType: "TYPE_WHATSAPP" }] }), { status: 200 });
      }
      return new Response("{}", { status: 500 });
    }) as unknown as typeof fetch;
    expect(await client(impl).latestConversationChannel("L1", "C1")).toBe("WhatsApp");
  });
});

describe("latestConversationChannel — fallbacks", () => {
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
    // No conversation at all = a widget visitor, not an SMS lead. Guessing
    // SMS here texts someone sitting on a web page.
    expect(await client(withConvs([])).latestConversationChannel("L1", "C1")).toBeNull();
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
