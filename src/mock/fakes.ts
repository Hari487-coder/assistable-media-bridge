import type { Tenant } from "../store/tenants";

const OGG = new Uint8Array([...new TextEncoder().encode("OggS"), 0, 1, 2, 3]);

export function createMockState() {
  let convUpdatedAt = "2026-07-23T10:00:00Z";
  const wokenConversations = new Set<string>();
  /** Every outbound media send the mock accepted, so MOCK_MODE and the e2e can
   *  assert what would actually have reached the contact. */
  const sentMessages: Array<{ contactId: string; type: string; message?: string; attachments: string[] }> = [];
  const mediaMessages = [
    { id: "vmsg-1", content: null, ai: false, source: "USER", channel: "whatsapp", createdAt: "t1" },
  ];
  return {
    wokenConversations,
    sentMessages,
    bumpConversation() { convUpdatedAt = "2026-07-23T11:00:00Z"; },
    v3Factory: () => ({
      validateKey: async () => ({ ok: true as const }),
      listAssistants: async () => [{ id: "mock-asst-1", name: "Mock Bot" }],
      createTool: async () => ({ id: "mock-tool-1", conflict: false as const, raw: {} }),
      findToolByName: async () => "mock-tool-1",
      assignTool: async () => ({ ok: true as const }),
      updateToolUrl: async () => ({ ok: true as const }),
      listConversations: async () => [
        { id: "mock-conv-1", contactId: "mock-contact-1", updatedAt: convUpdatedAt,
          assistant: { id: "mock-asst-1" } },
      ],
      listMessages: async () => mediaMessages,
      chatCompletion: async (a: { conversationId: string }) => {
        wokenConversations.add(a.conversationId);
        return { ok: true as const };
      },
    }),
    ghlFactory: (_tenant?: Tenant) => ({
      validatePit: async () => ({ ok: true as const }),
      latestMediaMessages: async () => [
        { id: "gmsg-1", convId: "mock-conv-1",
          attachments: ["https://storage.msgsndr.com/mock.ogg"],
          direction: "inbound", dateAdded: "t1" },
      ],
      sendMessage: async (m: { contactId: string; type: string; message?: string; attachments: string[] }) => {
        sentMessages.push(m);
        return { ok: true as const, id: `mock-msg-${sentMessages.length}` };
      },
      latestConversationChannel: async () => "WhatsApp",
    }),
    providerFactory: () => ({
      describe: async (i: { kind: string }) =>
        i.kind === "audio" ? "hey, can I move my appointment to Friday?" : "a photo of a receipt",
      validateKey: async () => ({ ok: true as const }),
    }),
    mediaFetch: (async () => new Response(OGG)) as unknown as typeof fetch,
    // Public address: the mock exercises the happy path, not the SSRF backstop.
    mediaLookup: async () => [{ address: "93.184.216.34", family: 4 }],
  };
}
export type MockState = ReturnType<typeof createMockState>;
