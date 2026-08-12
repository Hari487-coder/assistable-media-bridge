export interface GhlClientOptions {
  baseUrl: string; pit: string; fetchImpl?: typeof fetch;
  /** Per-request ceiling — see the note on V3ClientOptions.timeoutMs. Here it
   *  keeps a hung GHL read from parking a contact's tool-call queue forever. */
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 15_000;

interface GhlMessage {
  id: string; direction?: string; attachments?: unknown; dateAdded?: string;
  messageType?: string;
}

export function createGhlClient(opts: GhlClientOptions) {
  const f = opts.fetchImpl ?? fetch;
  const get = async (path: string) => {
    let res: Response;
    try {
      res = await f(`${opts.baseUrl}${path}`, {
        signal: AbortSignal.timeout(opts.timeoutMs ?? DEFAULT_TIMEOUT_MS),
        headers: {
          Authorization: `Bearer ${opts.pit}`,
          Version: "2021-07-28",
          Accept: "application/json",
        },
      });
    } catch (err) {
      const timedOut = err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError");
      throw new Error(timedOut ? `timed out after ${opts.timeoutMs ?? DEFAULT_TIMEOUT_MS}ms` : "network error");
    }
    let json: unknown = null;
    try { json = await res.json(); } catch { /* tolerate empty */ }
    return { ok: res.ok, status: res.status, json: json as Record<string, unknown> | null };
  };

  const post = async (path: string, body: unknown) => {
    let res: Response;
    try {
      res = await f(`${opts.baseUrl}${path}`, {
        method: "POST",
        signal: AbortSignal.timeout(opts.timeoutMs ?? DEFAULT_TIMEOUT_MS),
        headers: {
          Authorization: `Bearer ${opts.pit}`,
          Version: "2021-07-28",
          Accept: "application/json",
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
      });
    } catch (err) {
      const timedOut = err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError");
      throw new Error(timedOut ? `timed out after ${opts.timeoutMs ?? DEFAULT_TIMEOUT_MS}ms` : "network error");
    }
    let json: unknown = null;
    try { json = await res.json(); } catch { /* tolerate empty */ }
    return { ok: res.ok, status: res.status, json: json as Record<string, unknown> | null };
  };

  // GHL reports a conversation's channel as TYPE_<CHANNEL>; the send endpoint
  // wants the short form. Anything not in this map (TYPE_CALL, the TYPE_ACTIVITY_*
  // system rows) is not a channel we can send media on, so it falls through to SMS.
  const CHANNEL_BY_GHL_TYPE: Record<string, string> = {
    TYPE_SMS: "SMS", TYPE_EMAIL: "Email", TYPE_WHATSAPP: "WhatsApp",
    TYPE_INSTAGRAM: "IG", TYPE_FACEBOOK: "FB", TYPE_LIVE_CHAT: "Live_Chat",
    TYPE_CUSTOM: "Custom",
  };

  const asAttachments = (a: unknown): string[] =>
    Array.isArray(a) ? a.filter((u): u is string => typeof u === "string" && u.length > 0) : [];

  return {
    async latestMediaMessages(q: { locationId: string; contactId: string; limit?: number }) {
      const search = await get(
        `/conversations/search?locationId=${encodeURIComponent(q.locationId)}&contactId=${encodeURIComponent(q.contactId)}&sortBy=last_message_date&sort=desc`
      );
      if (!search.ok) throw new Error(`ghl conversations/search ${search.status}`);
      // Explicit ordering — do not trust GHL's default sort; spike verifies param names against the live API.
      const rawConvs = search.json?.conversations;
      const convs = (Array.isArray(rawConvs) ? rawConvs : []) as Array<{ id: string }>;
      if (convs.length === 0) return [];
      // A contact frequently owns SEVERAL conversation threads (per channel /
      // per number, plus GHL's duplicate-thread quirks), and which one search
      // ranks first can flip between calls. Reading only convs[0] made
      // consecutive tool calls see disjoint message sets (observed live:
      // "0 fresh" then "2 fresh" half a second apart). Merge the top threads
      // into one deduped view so every call sees the same reality.
      const errors: string[] = [];
      const merged = new Map<string, { id: string; convId: string; attachments: string[]; direction: string; dateAdded: string }>();
      for (const conv of convs.slice(0, 3)) {
        const msgsRes = await get(`/conversations/${conv.id}/messages`);
        if (!msgsRes.ok) {
          errors.push(`ghl messages ${msgsRes.status} (conv ${conv.id})`);
          continue;
        }
        // GHL nests: { messages: { messages: [...] } } — tolerate both nestings.
        const outer = msgsRes.json?.messages as unknown;
        const list = (Array.isArray(outer)
          ? outer
          : ((outer as { messages?: unknown[] } | null)?.messages ?? [])) as GhlMessage[];
        for (const m of list) {
          if ((m.direction ?? "").toLowerCase() !== "inbound") continue;
          const attachments = asAttachments(m.attachments);
          if (attachments.length === 0) continue;
          if (!merged.has(m.id)) {
            merged.set(m.id, {
              id: m.id, convId: conv.id, attachments,
              direction: m.direction ?? "", dateAdded: m.dateAdded ?? "",
            });
          }
        }
      }
      if (merged.size === 0 && errors.length > 0) throw new Error(errors[0]);
      return [...merged.values()]
        .sort((a, b) => (a.dateAdded < b.dateAdded ? 1 : -1))
        .slice(0, q.limit ?? 3);
    },
    /**
     * Send a message with attachments on the contact's behalf.
     *
     * This is the whole reason the outbound half exists: Assistable's own send
     * path posts { type, contactId, message, html } with no attachments field,
     * so media can only leave through a separate call like this one. Never
     * throws — a failed send must come back as text the assistant can act on,
     * not an exception that kills the tool call.
     */
    async sendMessage(m: {
      contactId: string; type: string; message?: string; attachments: string[];
    }): Promise<{ ok: true; id?: string } | { ok: false; error: string }> {
      const body: Record<string, unknown> = {
        type: m.type, contactId: m.contactId, attachments: m.attachments,
      };
      if (m.message) body.message = m.message;
      try {
        const r = await post("/conversations/messages", body);
        if (!r.ok) {
          const detail = typeof r.json?.message === "string" ? `: ${r.json.message.slice(0, 200)}` : "";
          return { ok: false, error: `ghl send ${r.status}${detail}` };
        }
        const id = r.json?.messageId ?? r.json?.id;
        return { ok: true, ...(typeof id === "string" ? { id } : {}) };
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : "send failed" };
      }
    },
    /**
     * Which channel this contact is actually talking on.
     *
     * Driven by the contact's own newest INBOUND message, across their top
     * threads — NOT by the newest thread. Live failure that forced this: a
     * contact conversing on SMS also had an email thread that an outbound
     * marketing send had bumped to the top, so ranking by thread picked Email
     * and GHL refused with "Cannot send email as ... has unsubscribed". The
     * lead got nothing. Outbound traffic reflects what the business did; only
     * inbound reflects where the contact actually is.
     *
     * Falls back, in order, to the newest outbound message on a sendable
     * channel (a contact who has never written), then the thread's declared
     * type, then SMS. A wrong-but-plausible channel is worse than the
     * fallback, and every account has SMS.
     */
    async latestConversationChannel(locationId: string, contactId: string): Promise<string> {
      try {
        const r = await get(
          `/conversations/search?locationId=${encodeURIComponent(locationId)}&contactId=${encodeURIComponent(contactId)}&sortBy=last_message_date&sort=desc`
        );
        if (!r.ok) return "SMS";
        const convs = (Array.isArray(r.json?.conversations) ? r.json.conversations : []) as
          Array<{ id: string; lastMessageType?: string; type?: string }>;
        if (convs.length === 0) return "SMS";

        let bestInbound: { at: string; channel: string } | null = null;
        let bestAny: { at: string; channel: string } | null = null;
        for (const conv of convs.slice(0, 3)) {
          const msgsRes = await get(`/conversations/${conv.id}/messages`);
          if (!msgsRes.ok) continue;
          // GHL nests: { messages: { messages: [...] } } — tolerate both.
          const outer = msgsRes.json?.messages as unknown;
          const list = (Array.isArray(outer)
            ? outer
            : ((outer as { messages?: unknown[] } | null)?.messages ?? [])) as GhlMessage[];
          for (const m of list) {
            // Calls and TYPE_ACTIVITY_* rows cannot carry an attachment, so
            // they must not decide the channel even when they are newest.
            const channel = CHANNEL_BY_GHL_TYPE[(m.messageType ?? "").toUpperCase()];
            if (!channel) continue;
            const at = m.dateAdded ?? "";
            if (!bestAny || at > bestAny.at) bestAny = { at, channel };
            if ((m.direction ?? "").toLowerCase() === "inbound"
              && (!bestInbound || at > bestInbound.at)) {
              bestInbound = { at, channel };
            }
          }
        }
        if (bestInbound) return bestInbound.channel;
        if (bestAny) return bestAny.channel;
        const declared = convs[0]?.lastMessageType ?? convs[0]?.type ?? "";
        return CHANNEL_BY_GHL_TYPE[declared.toUpperCase()] ?? "SMS";
      } catch {
        return "SMS";
      }
    },
    // A bare pass/fail here forced every failure — bad token, wrong-subaccount
    // token, bogus location id, GHL outage — into one identical error, which
    // sent a live tester re-minting tokens when the actual problem was the
    // location id. The status + GHL's own error body let the caller say which.
    async validatePit(
      locationId: string
    ): Promise<{ ok: true } | { ok: false; status?: number; detail?: string }> {
      let r: Awaited<ReturnType<typeof get>>;
      try {
        r = await get(`/conversations/search?locationId=${encodeURIComponent(locationId)}&limit=1`);
      } catch (err) {
        return { ok: false, detail: err instanceof Error ? err.message : "network error" };
      }
      if (r.ok) return { ok: true };
      // GHL error bodies carry `message` (string or string[]) and/or `error`.
      const raw = r.json?.message ?? r.json?.error;
      const body = (Array.isArray(raw) ? raw.join("; ") : typeof raw === "string" ? raw : "")
        .slice(0, 200);
      return { ok: false, status: r.status, ...(body ? { detail: body } : {}) };
    },
  };
}
export type GhlClient = ReturnType<typeof createGhlClient>;
